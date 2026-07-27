import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

function supportedProfile(name) {
  return name === 'Default' || /^Profile [0-9]+$/.test(name);
}

async function manifestVersionFromDirectory(profileDirectory, extensionId) {
  const extensionDirectory = path.join(profileDirectory, 'Extensions', extensionId);
  let versions;
  try {
    versions = (await readdir(extensionDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch {
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

async function manifestVersionFromSetting(setting) {
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

async function manifestVersionFromPreferencesFile(profileDirectory, extensionId, filename) {
  try {
    const preferences = JSON.parse(await readFile(
      path.join(profileDirectory, filename),
      'utf8',
    ));
    return await manifestVersionFromSetting(preferences?.extensions?.settings?.[extensionId]);
  } catch {
    return null;
  }
}

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
  } catch {
    return [];
  }

  return Promise.all(profiles.map(async (profile) => {
    const profileDirectory = path.join(chromeUserDataDir, profile);
    const resolved = await manifestVersionFromDirectory(profileDirectory, extensionId)
      ?? await manifestVersionFromPreferencesFile(profileDirectory, extensionId, 'Preferences')
      ?? await manifestVersionFromPreferencesFile(profileDirectory, extensionId, 'Secure Preferences');
    return {
      profile,
      installed: resolved !== null,
      manifestVersion: resolved?.manifestVersion ?? null,
      versionSource: resolved?.versionSource ?? null,
      path: resolved?.path ?? null,
      loadedAt: resolved?.loadedAt ?? null,
    };
  }));
}
