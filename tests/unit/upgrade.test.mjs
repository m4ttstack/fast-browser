import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolvePaths } from '../../lib/core/paths.mjs';
import { buildContentManifestDigest } from '../../lib/core/content-manifest.mjs';
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

async function writeRuntimeInstall(paths, lock, { contentDigest = true } = {}) {
  const directory = path.join(paths.runtimeDir, lock.productVersion);
  const cliDirectory = path.join(directory, 'fast-browser-mcp');
  await mkdir(cliDirectory, { recursive: true });
  await writeFile(path.join(cliDirectory, 'cli.cjs'), '// stub\n');
  const markerPath = path.join(directory, 'installed.json');
  const marker = { schemaVersion: 1, lock: runtimeLockIdentity(lock) };
  if (contentDigest) marker.contentDigest = await buildContentManifestDigest(cliDirectory);
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
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

// The reviewer's exact reproduction: a tampered CURRENT-version runtime
// whose installed.json was rewritten to record the (public) current lock
// identity, plus a second, genuinely-old runtime directory (the normal
// leftover state after any prior upgrade, since nothing prunes old
// directories). The tampered directory's contentDigest is recomputed to
// match its own (tampered) bytes, so mere self-consistency of that one
// directory cannot be what blocks it -- only tying the evidence to the
// SPECIFIC directory responsible for the failing check can. Before the fix,
// explainedByUpgrade asked only "does some directory differ from current",
// and the genuinely-old directory answered yes, wrongly excusing the
// tampered current one.
test('isExplainedByLockUpgrade is false when a tampered current-version runtime coexists with a genuinely older one', async () => {
  const paths = await tempPaths('fast-browser-upgrade-unit-tamper-current-');
  const oldLock = lockFor('0.1.0-alpha.1', '0.2.1');
  const newLock = lockFor('0.1.0-alpha.5', '0.2.2');
  await writeRuntimeInstall(paths, oldLock);

  const tamperedDirectory = path.join(paths.runtimeDir, newLock.productVersion);
  const tamperedCliDirectory = path.join(tamperedDirectory, 'fast-browser-mcp');
  await mkdir(tamperedCliDirectory, { recursive: true });
  await writeFile(path.join(tamperedCliDirectory, 'cli.cjs'), '// malicious payload\n');
  const tamperedDigest = await buildContentManifestDigest(tamperedCliDirectory);
  const tamperedMarkerPath = path.join(tamperedDirectory, 'installed.json');
  await writeFile(
    tamperedMarkerPath,
    `${JSON.stringify({
      schemaVersion: 1,
      lock: runtimeLockIdentity(newLock),
      contentDigest: tamperedDigest,
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await chmod(tamperedMarkerPath, 0o600);

  const report = doctorReport(['runtime-checksum', 'mcp-handshake', 'tool-contract']);
  assert.equal(
    await isExplainedByLockUpgrade({ paths, lock: newLock, doctorReport: report }),
    false,
  );
});

// Requirement 5 (backward compatibility): a marker written before this
// change carries no contentDigest at all. Even when the bytes it describes
// have been tampered with, a missing digest must be treated as NOT
// self-consistent (fail closed), never as "nothing to check here".
test('isExplainedByLockUpgrade is false when a legacy runtime marker (no content digest) describes tampered bytes', async () => {
  const paths = await tempPaths('fast-browser-upgrade-unit-legacy-tamper-');
  const oldLock = lockFor('0.1.0-alpha.1', '0.2.1');
  const newLock = lockFor('0.1.0-alpha.5', '0.2.2');
  const directory = await writeRuntimeInstall(paths, oldLock, { contentDigest: false });
  await writeFile(path.join(directory, 'fast-browser-mcp', 'cli.cjs'), '// tampered after install\n');

  const report = doctorReport(['runtime-checksum', 'mcp-handshake', 'tool-contract']);
  assert.equal(
    await isExplainedByLockUpgrade({ paths, lock: newLock, doctorReport: report }),
    false,
  );
});

// A legitimate upgrade must still work when history has left more than one
// old, self-consistent directory behind (the ordinary state of a machine
// that has upgraded more than once). Tying evidence to the current-named
// directory must not mean "only exactly one old directory is ever allowed".
test('isExplainedByLockUpgrade is true when two genuinely old, self-consistent runtime directories exist', async () => {
  const paths = await tempPaths('fast-browser-upgrade-unit-two-old-');
  const oldestLock = lockFor('0.1.0-alpha.1', '0.2.1');
  const middleLock = lockFor('0.1.0-alpha.3', '0.2.1');
  const newLock = lockFor('0.1.0-alpha.5', '0.2.2');
  await writeRuntimeInstall(paths, oldestLock);
  await writeRuntimeInstall(paths, middleLock);
  await writeExtensionInstall(paths, oldestLock);

  const report = doctorReport(['runtime-checksum', 'mcp-handshake', 'tool-contract']);
  assert.equal(
    await isExplainedByLockUpgrade({ paths, lock: newLock, doctorReport: report }),
    true,
  );
});
