import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

// Extension ids this project has shipped and can no longer sign for. The
// private key behind bjlfojdaaanoliidngocnbcalhpfmlie was lost, so Chrome can
// never be handed an update under it and any install carrying it is stranded
// on whatever bytes it already has. Nothing here can remove one (Chrome owns
// that list), so the only honest handling is to name it.
export const RETIRED_EXTENSION_IDS = Object.freeze(['bjlfojdaaanoliidngocnbcalhpfmlie']);

// Chrome's id for a keyed extension: the first 128 bits of the key's SHA-256,
// each hex digit mapped onto a-p.
export function extensionIdFromKey(key) {
  return createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)));
}

// macOS app-data protection answers a process without Full Disk Access with
// EPERM, which must never read as "not installed": the extension may well be
// there, this process just cannot look.
function isPermissionDenied(error) {
  return error?.code === 'EPERM' || error?.code === 'EACCES';
}

function supportedProfile(name) {
  return name === 'Default' || /^Profile [0-9]+$/.test(name);
}

async function manifestVersionFromDirectory(profileDirectory, extensionId, access) {
  const extensionDirectory = path.join(profileDirectory, 'Extensions', extensionId);
  let versions;
  try {
    versions = (await readdir(extensionDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch (error) {
    if (isPermissionDenied(error)) access.denied = true;
    return null;
  }
  for (const version of versions) {
    const versionDirectory = path.join(extensionDirectory, version);
    try {
      const manifest = JSON.parse(await readFile(
        path.join(versionDirectory, 'manifest.json'),
        'utf8',
      ));
      if (typeof manifest.version === 'string') {
        // Chrome owns this copy, so the version is a record of what it
        // installed rather than of whatever setup last wrote.
        return {
          manifestVersion: manifest.version,
          versionSource: 'chrome',
          path: versionDirectory,
          loadedAt: null,
        };
      }
    } catch {
      // Ignore broken version directories and continue to the next one.
    }
  }
  return null;
}

// Chrome stores timestamps as microseconds since 1601-01-01 (FILETIME).
const FILETIME_EPOCH_OFFSET_MS = 11_644_473_600_000;

function loadedAtFrom(setting) {
  const raw = Number(setting.last_update_time ?? setting.first_install_time);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const unixMs = raw / 1000 - FILETIME_EPOCH_OFFSET_MS;
  return Number.isFinite(unixMs) && unixMs > 0 ? unixMs : null;
}

async function manifestVersionFromSetting(setting, extensionId) {
  if (!setting || setting.state === 0) return null;
  const loadedAt = loadedAtFrom(setting);
  if (typeof setting.manifest?.version === 'string') {
    // Chrome cached this manifest directly; there is no separate on-disk
    // install path to report (this is not an unpacked load).
    return {
      manifestVersion: setting.manifest.version,
      versionSource: 'chrome',
      path: null,
      loadedAt,
    };
  }
  // Unpacked loads recorded via Secure Preferences carry no manifest field,
  // only an absolute install path; read manifest.json from there instead.
  //
  // This version is therefore DISK-derived, not a record of what Chrome
  // parsed at load time. That distinction was invisible while installs were
  // version-scoped -- the path itself encoded the identity -- but the install
  // directory is stable now, so swapping content underneath a live load
  // changes this value with no reload having happened. Callers must treat
  // 'disk' as "what setup put there", never as "what Chrome is running", and
  // use loadedAt to tell the two apart.
  if (typeof setting.path !== 'string' || !path.isAbsolute(setting.path)) return null;
  try {
    const manifest = JSON.parse(await readFile(
      path.join(setting.path, 'manifest.json'),
      'utf8',
    ));
    // A leftover record: the directory now carries the key for another id,
    // so Chrome cannot load it under this one. A session started before the
    // key changed keeps running it until Chrome restarts.
    if (typeof manifest.key === 'string' && extensionIdFromKey(manifest.key) !== extensionId) return null;
    return typeof manifest.version === 'string'
      ? {
        manifestVersion: manifest.version,
        versionSource: 'disk',
        path: setting.path,
        loadedAt,
      }
      : null;
  } catch {
    return null;
  }
}

async function settingFromPreferencesFile(profileDirectory, extensionId, filename, access) {
  try {
    const preferences = JSON.parse(await readFile(
      path.join(profileDirectory, filename),
      'utf8',
    ));
    return preferences?.extensions?.settings?.[extensionId] ?? null;
  } catch (error) {
    if (access && isPermissionDenied(error)) access.denied = true;
    return null;
  }
}

async function manifestVersionFromPreferencesFile(profileDirectory, extensionId, filename, access) {
  return manifestVersionFromSetting(
    await settingFromPreferencesFile(profileDirectory, extensionId, filename, access),
    extensionId,
  );
}

const UNPACKED_LOCATION = 4;

function hasDisableReasons(reasons) {
  return Array.isArray(reasons) ? reasons.length > 0 : Boolean(reasons);
}

// Chrome disables a store copy that fails its own content verification, and
// that verification is what a store pass stands on.
function enabledStoreRecord(setting) {
  return setting?.from_webstore === true
    && setting.location !== UNPACKED_LOCATION
    && setting.state !== 0
    && !hasDisableReasons(setting.disable_reasons);
}

async function recordedFromWebStore(profileDirectory, extensionId) {
  for (const filename of ['Preferences', 'Secure Preferences']) {
    if (enabledStoreRecord(await settingFromPreferencesFile(profileDirectory, extensionId, filename))) return true;
  }
  return false;
}

const UNRESOLVED = Object.freeze({
  installed: false,
  fromWebStore: false,
  manifestVersion: null,
  versionSource: null,
  path: null,
  loadedAt: null,
});

// `unreadable` marks a profile this process was refused permission to read
// and found nothing in. A refused user data directory yields one entry with
// profile null, since not even the profile names can be listed.
export async function detectChromeExtension({ extensionId, chromeUserDataDir }) {
  let profiles;
  try {
    profiles = (await readdir(chromeUserDataDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && supportedProfile(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => {
        if (a === 'Default') return -1;
        if (b === 'Default') return 1;
        return a.localeCompare(b, undefined, { numeric: true });
      });
  } catch (error) {
    return isPermissionDenied(error) ? [{ profile: null, ...UNRESOLVED, unreadable: true }] : [];
  }

  return Promise.all(profiles.map(async (profile) => {
    const profileDirectory = path.join(chromeUserDataDir, profile);
    const access = { denied: false };
    const resolved = await manifestVersionFromDirectory(profileDirectory, extensionId, access)
      ?? await manifestVersionFromPreferencesFile(profileDirectory, extensionId, 'Preferences', access)
      ?? await manifestVersionFromPreferencesFile(profileDirectory, extensionId, 'Secure Preferences', access);
    return {
      profile,
      installed: resolved !== null,
      fromWebStore: resolved !== null && await recordedFromWebStore(profileDirectory, extensionId),
      manifestVersion: resolved?.manifestVersion ?? null,
      versionSource: resolved?.versionSource ?? null,
      path: resolved?.path ?? null,
      loadedAt: resolved?.loadedAt ?? null,
      unreadable: resolved === null && access.denied,
    };
  }));
}
