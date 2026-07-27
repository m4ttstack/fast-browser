import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolvePaths } from '../../lib/core/paths.mjs';
import { buildContentManifestDigest } from '../../lib/extension/content-manifest.mjs';
import { runtimeLockIdentity } from '../../lib/runtime/lock.mjs';
import { isExplainedByLockUpgrade } from '../../lib/commands/upgrade.mjs';

function lockFor(productVersion, extensionVersion) {
  return {
    schemaVersion: 1,
    productVersion,
    sourceCommit: `commit-${productVersion}`,
    protocolVersion: 2,
    runtime: {
      file: `fast-browser-mcp-${productVersion}.tar.gz`,
      sha256: 'a'.repeat(64),
      node: '>=20',
    },
    extension: {
      file: `fast-browser-extension-${productVersion}.zip`,
      sha256: 'b'.repeat(64),
      id: 'a'.repeat(32),
      version: extensionVersion,
    },
  };
}

function doctorReport(failingIds) {
  const failing = new Set(failingIds);
  const allIds = new Set([
    'platform', 'node', 'chrome', 'runtime-checksum', 'extension-artifact',
    'extension-installed', 'mcp-handshake', 'tool-contract', 'pairing',
    'data-permissions', ...failingIds,
  ]);
  return {
    schemaVersion: 1,
    ok: failing.size === 0,
    checks: [...allIds].map((id) => ({
      id,
      status: failing.has(id) ? 'fail' : 'pass',
      message: `${id} ${failing.has(id) ? 'failed' : 'passed'}.`,
      remediation: failing.has(id) ? `fix ${id}` : null,
    })),
  };
}

async function writeRuntimeInstall(paths, lock) {
  const directory = path.join(paths.runtimeDir, lock.productVersion);
  await mkdir(path.join(directory, 'fast-browser-mcp'), { recursive: true });
  await writeFile(path.join(directory, 'fast-browser-mcp', 'cli.cjs'), '// stub\n');
  const markerPath = path.join(directory, 'installed.json');
  await writeFile(
    markerPath,
    `${JSON.stringify({ schemaVersion: 1, lock: runtimeLockIdentity(lock) }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await chmod(markerPath, 0o600);
  return directory;
}

async function writeExtensionInstall(paths, lock) {
  const directory = path.join(paths.extensionDir, lock.extension.version);
  const unpacked = path.join(directory, 'unpacked');
  await mkdir(unpacked, { recursive: true });
  await writeFile(
    path.join(unpacked, 'manifest.json'),
    JSON.stringify({ manifest_version: 3, name: 'Fast Browser', version: lock.extension.version }),
  );
  const contentDigest = await buildContentManifestDigest(unpacked);
  const markerPath = path.join(directory, 'installed.json');
  await writeFile(
    markerPath,
    `${JSON.stringify({ schemaVersion: 1, lock: runtimeLockIdentity(lock), contentDigest }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await chmod(markerPath, 0o600);
  return { directory, unpacked };
}

async function tempPaths(prefix) {
  const home = await mkdtemp(path.join(tmpdir(), prefix));
  return resolvePaths({ homeDir: home });
}

test('isExplainedByLockUpgrade is false with no failing checks', async () => {
  const paths = await tempPaths('fast-browser-upgrade-unit-none-');
  const lock = lockFor('0.1.0-alpha.5', '0.2.2');
  assert.equal(
    await isExplainedByLockUpgrade({ paths, lock, doctorReport: doctorReport([]) }),
    false,
  );
});

test('isExplainedByLockUpgrade is false when any failing check is outside the lock-explainable set', async () => {
  const paths = await tempPaths('fast-browser-upgrade-unit-unrelated-');
  const oldLock = lockFor('0.1.0-alpha.1', '0.2.1');
  const newLock = lockFor('0.1.0-alpha.5', '0.2.2');
  await writeRuntimeInstall(paths, oldLock);
  await writeExtensionInstall(paths, oldLock);
  const report = doctorReport(['runtime-checksum', 'claude-plugin']);
  assert.equal(
    await isExplainedByLockUpgrade({ paths, lock: newLock, doctorReport: report }),
    false,
  );
});

test('isExplainedByLockUpgrade is true for a self-consistent, older runtime and extension install', async () => {
  const paths = await tempPaths('fast-browser-upgrade-unit-true-');
  const oldLock = lockFor('0.1.0-alpha.1', '0.2.1');
  const newLock = lockFor('0.1.0-alpha.5', '0.2.2');
  await writeRuntimeInstall(paths, oldLock);
  await writeExtensionInstall(paths, oldLock);
  const report = doctorReport([
    'runtime-checksum', 'extension-artifact', 'mcp-handshake', 'tool-contract', 'extension-installed',
  ]);
  assert.equal(
    await isExplainedByLockUpgrade({ paths, lock: newLock, doctorReport: report }),
    true,
  );
});

test('isExplainedByLockUpgrade is false when the extension bytes no longer match their own marker', async () => {
  const paths = await tempPaths('fast-browser-upgrade-unit-tamper-');
  const oldLock = lockFor('0.1.0-alpha.1', '0.2.1');
  const newLock = lockFor('0.1.0-alpha.5', '0.2.2');
  await writeRuntimeInstall(paths, oldLock);
  const { unpacked } = await writeExtensionInstall(paths, oldLock);
  await writeFile(path.join(unpacked, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Fast Browser Tampered', version: oldLock.extension.version,
  }));
  const report = doctorReport(['extension-artifact', 'extension-installed']);
  assert.equal(
    await isExplainedByLockUpgrade({ paths, lock: newLock, doctorReport: report }),
    false,
  );
});

test('isExplainedByLockUpgrade is false when the runtime marker is missing', async () => {
  const paths = await tempPaths('fast-browser-upgrade-unit-missing-');
  const oldLock = lockFor('0.1.0-alpha.1', '0.2.1');
  const newLock = lockFor('0.1.0-alpha.5', '0.2.2');
  // Runtime CLI exists, but there is no installed.json at all for it.
  await mkdir(path.join(paths.runtimeDir, oldLock.productVersion, 'fast-browser-mcp'), { recursive: true });
  await writeFile(
    path.join(paths.runtimeDir, oldLock.productVersion, 'fast-browser-mcp', 'cli.cjs'),
    '// stub\n',
  );
  const report = doctorReport(['runtime-checksum', 'mcp-handshake', 'tool-contract']);
  assert.equal(
    await isExplainedByLockUpgrade({ paths, lock: newLock, doctorReport: report }),
    false,
  );
});

test('isExplainedByLockUpgrade is false when the recorded marker is malformed JSON', async () => {
  const paths = await tempPaths('fast-browser-upgrade-unit-malformed-');
  const oldLock = lockFor('0.1.0-alpha.1', '0.2.1');
  const newLock = lockFor('0.1.0-alpha.5', '0.2.2');
  const directory = await writeRuntimeInstall(paths, oldLock);
  await writeFile(path.join(directory, 'installed.json'), 'not json{{{', { mode: 0o600 });
  await chmod(path.join(directory, 'installed.json'), 0o600);
  const report = doctorReport(['runtime-checksum', 'mcp-handshake', 'tool-contract']);
  assert.equal(
    await isExplainedByLockUpgrade({ paths, lock: newLock, doctorReport: report }),
    false,
  );
});

test('isExplainedByLockUpgrade is false when the marker has unsafe permissions', async () => {
  const paths = await tempPaths('fast-browser-upgrade-unit-perms-');
  const oldLock = lockFor('0.1.0-alpha.1', '0.2.1');
  const newLock = lockFor('0.1.0-alpha.5', '0.2.2');
  const directory = await writeRuntimeInstall(paths, oldLock);
  await chmod(path.join(directory, 'installed.json'), 0o644);
  const report = doctorReport(['runtime-checksum', 'mcp-handshake', 'tool-contract']);
  assert.equal(
    await isExplainedByLockUpgrade({ paths, lock: newLock, doctorReport: report }),
    false,
  );
});

test('isExplainedByLockUpgrade is false when the only installed version already matches the current lock', async () => {
  // extension-installed can fail purely because Chrome has not reloaded yet
  // (no version change at all). That must not be treated as an upgrade.
  const paths = await tempPaths('fast-browser-upgrade-unit-nobump-');
  const lock = lockFor('0.1.0-alpha.5', '0.2.2');
  await writeExtensionInstall(paths, lock);
  const report = doctorReport(['extension-installed']);
  assert.equal(
    await isExplainedByLockUpgrade({ paths, lock, doctorReport: report }),
    false,
  );
});
