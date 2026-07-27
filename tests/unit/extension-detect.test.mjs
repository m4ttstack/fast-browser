import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { detectChromeExtension } from '../../lib/extension/detect.mjs';

const extensionId = 'abcdefghijklmnopabcdefghijklmnop';

async function tempChromeRoot() {
  return mkdtemp(path.join(os.tmpdir(), 'fast-browser-chrome-detect-'));
}

async function writeUnpackedManifest(directory, version) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ version }));
}

async function writeProfileJson(profileDirectory, filename, contents) {
  await mkdir(profileDirectory, { recursive: true });
  await writeFile(path.join(profileDirectory, filename), typeof contents === 'string'
    ? contents
    : JSON.stringify(contents));
}

test('detects an unpacked extension listed only in Secure Preferences by reading its manifest path', async () => {
  const root = await tempChromeRoot();
  const unpackedDirectory = path.join(root, 'unpacked-extension');
  await writeUnpackedManifest(unpackedDirectory, '0.2.1');
  await writeProfileJson(path.join(root, 'Default'), 'Secure Preferences', {
    extensions: {
      settings: {
        [extensionId]: { location: 4, path: unpackedDirectory },
      },
    },
  });

  assert.deepEqual(await detectChromeExtension({
    extensionId,
    chromeUserDataDir: root,
  }), [
    { profile: 'Default', installed: true, manifestVersion: '0.2.1' },
  ]);
});

test('treats a Secure Preferences entry with state 0 as not installed even with a valid path', async () => {
  const root = await tempChromeRoot();
  const unpackedDirectory = path.join(root, 'unpacked-extension');
  await writeUnpackedManifest(unpackedDirectory, '0.2.1');
  await writeProfileJson(path.join(root, 'Default'), 'Secure Preferences', {
    extensions: {
      settings: {
        [extensionId]: { state: 0, path: unpackedDirectory },
      },
    },
  });

  assert.deepEqual(await detectChromeExtension({
    extensionId,
    chromeUserDataDir: root,
  }), [
    { profile: 'Default', installed: false, manifestVersion: null },
  ]);
});

test('reports not installed when the extension is absent from both Preferences and Secure Preferences', async () => {
  const root = await tempChromeRoot();
  await writeProfileJson(path.join(root, 'Default'), 'Preferences', { extensions: { settings: {} } });
  await writeProfileJson(path.join(root, 'Default'), 'Secure Preferences', { extensions: { settings: {} } });

  assert.deepEqual(await detectChromeExtension({
    extensionId,
    chromeUserDataDir: root,
  }), [
    { profile: 'Default', installed: false, manifestVersion: null },
  ]);
});

test('resolves an unreadable or malformed Secure Preferences file to not installed without throwing', async () => {
  const root = await tempChromeRoot();
  await writeProfileJson(path.join(root, 'Default'), 'Secure Preferences', '{ this is not json');

  const result = await detectChromeExtension({
    extensionId,
    chromeUserDataDir: root,
  });

  assert.deepEqual(result, [
    { profile: 'Default', installed: false, manifestVersion: null },
  ]);
});

test('still detects an extension recorded only in Preferences exactly as before', async () => {
  const root = await tempChromeRoot();
  await writeProfileJson(path.join(root, 'Default'), 'Preferences', {
    extensions: {
      settings: {
        [extensionId]: { state: 1, manifest: { version: '0.2.2' } },
      },
    },
  });

  assert.deepEqual(await detectChromeExtension({
    extensionId,
    chromeUserDataDir: root,
  }), [
    { profile: 'Default', installed: true, manifestVersion: '0.2.2' },
  ]);
});

test('prefers a Preferences version over a differing Secure Preferences version for the same extension', async () => {
  const root = await tempChromeRoot();
  const unpackedDirectory = path.join(root, 'unpacked-extension');
  await writeUnpackedManifest(unpackedDirectory, '0.2.9');
  await writeProfileJson(path.join(root, 'Default'), 'Preferences', {
    extensions: {
      settings: {
        [extensionId]: { state: 1, manifest: { version: '0.2.2' } },
      },
    },
  });
  await writeProfileJson(path.join(root, 'Default'), 'Secure Preferences', {
    extensions: {
      settings: {
        [extensionId]: { location: 4, path: unpackedDirectory },
      },
    },
  });

  assert.deepEqual(await detectChromeExtension({
    extensionId,
    chromeUserDataDir: root,
  }), [
    { profile: 'Default', installed: true, manifestVersion: '0.2.2' },
  ]);
});

test('resolves a Secure Preferences entry whose path has no readable manifest.json to not installed', async () => {
  const root = await tempChromeRoot();
  const missingDirectory = path.join(root, 'never-written');
  await writeProfileJson(path.join(root, 'Default'), 'Secure Preferences', {
    extensions: {
      settings: {
        [extensionId]: { location: 4, path: missingDirectory },
      },
    },
  });

  assert.deepEqual(await detectChromeExtension({
    extensionId,
    chromeUserDataDir: root,
  }), [
    { profile: 'Default', installed: false, manifestVersion: null },
  ]);
});
