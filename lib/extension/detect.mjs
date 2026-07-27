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
        return { manifestVersion: manifest.version, path: versionDirectory };
      }
    } catch {
      // Ignore broken version directories and continue to the next one.
    }
  }
  return null;
}

async function manifestVersionFromSetting(setting) {
  if (!setting || setting.state === 0) return null;
  if (typeof setting.manifest?.version === 'string') {
    // Chrome cached this manifest directly; there is no separate on-disk
    // install path to report (this is not an unpacked load).
    return { manifestVersion: setting.manifest.version, path: null };
  }
  // Unpacked loads recorded via Secure Preferences carry no manifest field,
  // only an absolute install path; read manifest.json from there instead.
  if (typeof setting.path !== 'string' || !path.isAbsolute(setting.path)) return null;
  try {
    const manifest = JSON.parse(await readFile(
      path.join(setting.path, 'manifest.json'),
      'utf8',
    ));
    return typeof manifest.version === 'string'
      ? { manifestVersion: manifest.version, path: setting.path }
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
      path: resolved?.path ?? null,
    };
  }));
}
