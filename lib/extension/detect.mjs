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
    try {
      const manifest = JSON.parse(await readFile(
        path.join(extensionDirectory, version, 'manifest.json'),
        'utf8',
      ));
      if (typeof manifest.version === 'string') return manifest.version;
    } catch {
      // Ignore broken version directories and continue to the next one.
    }
  }
  return null;
}

async function manifestVersionFromPreferences(profileDirectory, extensionId) {
  try {
    const preferences = JSON.parse(await readFile(
      path.join(profileDirectory, 'Preferences'),
      'utf8',
    ));
    const setting = preferences?.extensions?.settings?.[extensionId];
    if (!setting || setting.state === 0) return null;
    return typeof setting.manifest?.version === 'string'
      ? setting.manifest.version
      : null;
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
    const manifestVersion = await manifestVersionFromDirectory(profileDirectory, extensionId)
      ?? await manifestVersionFromPreferences(profileDirectory, extensionId);
    return {
      profile,
      installed: manifestVersion !== null,
      manifestVersion,
    };
  }));
}
