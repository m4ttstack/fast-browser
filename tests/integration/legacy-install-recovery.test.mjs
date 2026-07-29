import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  chmod, mkdir, mkdtemp, readFile, writeFile,
} from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { main } from '../../lib/cli/main.mjs';
import { launchRuntime } from '../../lib/runtime/launch.mjs';
import { setup } from '../../lib/commands/setup.mjs';
import { loadConfig } from '../../lib/core/config.mjs';
import { saveConfig } from '../../lib/core/files.mjs';
import { resolvePaths } from '../../lib/core/paths.mjs';
import { extensionInstallLocation } from '../../lib/extension/install.mjs';
import { buildContentManifestDigest } from '../../lib/core/content-manifest.mjs';
import { DOCTOR_CHECK_IDS } from '../../lib/doctor/checks.mjs';
import { installBuiltinMacros } from '../../lib/macros/install.mjs';
import { runtimeLockIdentity } from '../../lib/runtime/lock.mjs';

const execFile = promisify(execFileCallback);
const PLUGIN_ROOT = fileURLToPath(new URL('../..', import.meta.url));

// Reproduces the coordinator's real-machine deadlock: an install made
// before content-digest verification existed (runtime and extension
// markers containing only { schemaVersion, lock }) must be a REINSTALL
// TRIGGER, not a permanent refusal. setup must actually replace it through
// the real, checksum-verified install path -- not merely decide to -- so
// these tests exercise the real installRuntime/installExtension, not
// mocks, and inspect what actually lands on disk afterward.

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function extensionId(publicKeyDer) {
  return [...crypto.createHash('sha256').update(publicKeyDer).digest().subarray(0, 16)]
    .flatMap((byte) => [byte >> 4, byte & 15])
    .map((nibble) => String.fromCharCode(97 + nibble))
    .join('');
}

async function validTar(cliContents) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-tar-'));
  const payload = path.join(directory, 'payload');
  await mkdir(path.join(payload, 'fast-browser-mcp'), { recursive: true });
  await writeFile(path.join(payload, 'fast-browser-mcp', 'cli.cjs'), cliContents, { mode: 0o755 });
  const archive = path.join(directory, 'runtime.tar.gz');
  await execFile(
    '/usr/bin/tar',
    ['--format', 'ustar', '-czf', archive, '-C', payload, 'fast-browser-mcp'],
  );
  return readFile(archive);
}

async function extensionZip(manifestOverrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-zip-'));
  const payload = path.join(directory, 'payload');
  await mkdir(payload);
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
  const manifest = {
    manifest_version: 3,
    name: 'Fast Browser',
    key: publicKeyDer.toString('base64'),
    ...manifestOverrides,
  };
  await writeFile(path.join(payload, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(payload, 'worker.js'), 'void 0;\n');
  const archivePath = path.join(directory, 'extension.zip');
  await execFile('/usr/bin/zip', ['-q', '-X', '-r', archivePath, '.'], { cwd: payload });
  return { archive: await readFile(archivePath), id: extensionId(publicKeyDer), manifest };
}

async function loopbackServer(body, contentType) {
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { 'content-type': contentType });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    requests: () => requests,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => (error ? rejectClose(error) : resolveClose()));
    }),
  };
}

// A real, self-consistent, but UNVERIFIABLE (no contentDigest) prior
// install, exactly as any install made before this security patch shipped
// would look on disk: a real CLI file and a marker recording only
// { schemaVersion, lock }.
async function writeLegacyRuntimeInstall(paths, lock) {
  const directory = path.join(paths.runtimeDir, lock.productVersion);
  const cliDirectory = path.join(directory, 'fast-browser-mcp');
  await mkdir(cliDirectory, { recursive: true });
  await writeFile(path.join(cliDirectory, 'cli.cjs'), '#!/usr/bin/env node\n// legacy install\n');
  const markerPath = path.join(directory, 'installed.json');
  await writeFile(
    markerPath,
    `${JSON.stringify({ schemaVersion: 1, lock: runtimeLockIdentity(lock) }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await chmod(markerPath, 0o600);
  return directory;
}

async function writeLegacyExtensionInstall(paths, lock, manifest) {
  const directory = extensionInstallLocation(paths).directory;
  const unpacked = path.join(directory, 'unpacked');
  await mkdir(unpacked, { recursive: true });
  await writeFile(path.join(unpacked, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(unpacked, 'worker.js'), 'void 0;\n');
  const markerPath = path.join(directory, 'installed.json');
  await writeFile(
    markerPath,
    `${JSON.stringify({ schemaVersion: 1, lock: runtimeLockIdentity(lock) }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await chmod(markerPath, 0o600);
  return { directory, unpacked };
}

function configFor(oldLock) {
  return {
    schemaVersion: 1,
    productVersion: oldLock.productVersion,
    profile: 'full',
    hosts: { claude: true, codex: false },
    connection: { mode: 'manual' },
    sessions: { enabled: true, retentionDays: 45 },
    runtime: {
      version: oldLock.productVersion,
      sha256: oldLock.runtime.sha256,
      sourceCommit: oldLock.sourceCommit,
    },
    managed: { files: [], blocks: [] },
  };
}

function doctorReportWithFailures(failingIds) {
  const failing = new Set(failingIds);
  return {
    schemaVersion: 1,
    ok: failing.size === 0,
    profile: 'full',
    checks: DOCTOR_CHECK_IDS.map((id) => ({
      id,
      status: failing.has(id) ? 'fail' : 'pass',
      message: failing.has(id) ? `${id} failed.` : `${id} passed.`,
      remediation: failing.has(id) ? `fix ${id}` : null,
    })),
  };
}

function doctorSequence(firstFailing, secondFailing) {
  let call = 0;
  return async () => {
    call += 1;
    return doctorReportWithFailures(call === 1 ? firstFailing : secondFailing);
  };
}

// installBuiltinMacros was spied here too and was deliberately removed, not
// allowed to lapse. The spy dated from when the macro installer was an
// unconditional copy, where calling it meant writing, so "never called" was
// the only way to guarantee an upgrade left the user's macros alone. Since the
// checksum work it classifies each destination by its bytes: it writes nothing
// when the installed bytes already match the packaged ones and preserves
// anything the user edited, so a call no longer implies a write and the spy no
// longer evidences the guarantee. The guarantee stands and is asserted on the
// bytes instead (see the user-macro assertions in setup-upgrade.test.mjs and
// the never-clobber tests in tests/unit/macros.test.mjs). Keeping the spy
// would re-break the macro-only fix MAT-87 delivers, since such a fix never
// moves runtime-lock.json and reaches a machine only through this path.
function untouchedDuringUpgrade(calls) {
  return {
    installClaude: async () => { calls.push('installClaude'); return { changed: false, changes: [] }; },
    installCodex: async () => { calls.push('installCodex'); return { changed: false, changes: [] }; },
    prepareRoutingTransition: async () => {
      calls.push('prepareRoutingTransition');
      return { nextState: {}, apply: async () => ({ rollback: async () => {} }) };
    },
    pruneSessions: async () => { calls.push('pruneSessions'); return { removedPaths: [], removedBytes: 0 }; },
  };
}

// A real plugin root with its built-ins already installed, matching what these
// scenarios describe: a machine that has run setup before. Setup refreshes the
// built-ins on every outcome now, so an empty macros directory would model a
// half-installed machine and make the refresh report an install that has
// nothing to do with the legacy markers under test.
async function fixtureHome(prefix) {
  const home = await mkdtemp(path.join(os.tmpdir(), prefix));
  const paths = { ...resolvePaths({ homeDir: home }), pluginRoot: PLUGIN_ROOT };
  await installBuiltinMacros(paths);
  return paths;
}

function exitingSpawn(exitCode, captured) {
  return (command, args, options) => {
    captured.push({ command, args, options });
    const child = new EventEmitter();
    process.nextTick(() => child.emit('exit', exitCode, null));
    return child;
  };
}

// Builds a complete real-fixture scenario: a legacy (unverifiable) prior
// install of oldVersion, a real loopback-served tar/zip for newVersion, and
// the lock/config wiring setup() needs. Returns everything a test needs to
// drive setup() with the REAL installRuntime/installExtension and then
// launchRuntime.
async function scenario() {
  const oldLock = {
    schemaVersion: 1,
    productVersion: '0.1.0-alpha.1',
    sourceCommit: 'a'.repeat(16),
    protocolVersion: 2,
    runtime: {
      file: 'fast-browser-mcp-0.1.0-alpha.1.tar.gz',
      sha256: 'a'.repeat(64),
      node: '>=20',
    },
    extension: {
      file: 'fast-browser-extension-0.1.0-alpha.1.zip',
      sha256: 'b'.repeat(64),
      id: 'a'.repeat(32),
      version: '0.2.1',
    },
  };

  const runtimeArchive = await validTar('#!/usr/bin/env node\nprocess.stdout.write("new-fixture");\n');
  const runtimeServer = await loopbackServer(runtimeArchive, 'application/gzip');
  const extensionFixture = await extensionZip({ version: '0.2.2' });
  const extensionServer = await loopbackServer(extensionFixture.archive, 'application/zip');

  const newLock = {
    schemaVersion: 1,
    productVersion: '0.1.0-alpha.5',
    sourceCommit: 'b'.repeat(16),
    protocolVersion: 2,
    runtime: {
      url: `http://127.0.0.1:${runtimeServer.port}/runtime.tar.gz`,
      file: 'fast-browser-mcp-0.1.0-alpha.5.tar.gz',
      sha256: sha256(runtimeArchive),
      node: '>=20',
    },
    extension: {
      url: `http://127.0.0.1:${extensionServer.port}/extension.zip`,
      file: 'fast-browser-extension-0.1.0-alpha.5.zip',
      sha256: sha256(extensionFixture.archive),
      id: extensionFixture.id,
      version: '0.2.2',
    },
  };

  const paths = await fixtureHome('fast-browser-legacy-recovery-');
  await writeLegacyRuntimeInstall(paths, oldLock);
  await writeLegacyExtensionInstall(paths, oldLock, {
    manifest_version: 3,
    name: 'Fast Browser',
    version: oldLock.extension.version,
  });
  await saveConfig(paths, configFor(oldLock));

  return {
    oldLock,
    newLock,
    paths,
    close: async () => {
      await runtimeServer.close();
      await extensionServer.close();
    },
  };
}

const baseRequest = { hosts: ['claude'], profile: 'full', source: '/repo/mattstack', runtimeLock: null };

test('a legacy runtime marker triggers a real reinstall and setup succeeds', async (t) => {
  const { newLock, paths, close } = await scenario();
  t.after(close);
  const untouchedCalls = [];
  const doctor = doctorSequence(
    ['runtime-checksum', 'extension-artifact', 'mcp-handshake', 'tool-contract', 'extension-installed'],
    ['extension-installed'],
  );

  const report = await setup(baseRequest, {
    paths,
    checkPlatform: async () => {},
    detectHosts: async () => ['claude'],
    loadConfig,
    loadRuntimeLock: async () => newLock,
    ...untouchedDuringUpgrade(untouchedCalls),
    saveConfig,
    doctor,
  });

  assert.equal(report.changed, true);
  assert.deepEqual(untouchedCalls, []);
  const marker = JSON.parse(
    await readFile(path.join(paths.runtimeDir, newLock.productVersion, 'installed.json'), 'utf8'),
  );
  assert.equal(typeof marker.contentDigest, 'string');
  assert.match(marker.contentDigest, /^[0-9a-f]{64}$/);
  assert.equal(
    marker.contentDigest,
    await buildContentManifestDigest(path.join(paths.runtimeDir, newLock.productVersion, 'fast-browser-mcp')),
  );
});

test('a legacy extension marker likewise triggers a real reinstall and setup succeeds', async (t) => {
  const { newLock, paths, close } = await scenario();
  t.after(close);
  const untouchedCalls = [];
  const doctor = doctorSequence(
    ['runtime-checksum', 'extension-artifact', 'mcp-handshake', 'tool-contract', 'extension-installed'],
    ['extension-installed'],
  );

  const report = await setup(baseRequest, {
    paths,
    checkPlatform: async () => {},
    detectHosts: async () => ['claude'],
    loadConfig,
    loadRuntimeLock: async () => newLock,
    ...untouchedDuringUpgrade(untouchedCalls),
    saveConfig,
    doctor,
  });

  assert.equal(report.changed, true);
  const marker = JSON.parse(
    await readFile(extensionInstallLocation(paths).marker, 'utf8'),
  );
  assert.equal(typeof marker.contentDigest, 'string');
  assert.match(marker.contentDigest, /^[0-9a-f]{64}$/);
  assert.equal(
    marker.contentDigest,
    await buildContentManifestDigest(extensionInstallLocation(paths).unpacked),
  );
});

test('setup reports the unverifiable-artifacts-replaced notice exactly when a legacy install was actually replaced', async (t) => {
  const { newLock, paths, close } = await scenario();
  t.after(close);
  const doctor = doctorSequence(
    ['runtime-checksum', 'extension-artifact', 'mcp-handshake', 'tool-contract', 'extension-installed'],
    ['extension-installed'],
  );

  const report = await setup(baseRequest, {
    paths,
    checkPlatform: async () => {},
    detectHosts: async () => ['claude'],
    loadConfig,
    loadRuntimeLock: async () => newLock,
    ...untouchedDuringUpgrade([]),
    saveConfig,
    doctor,
  });

  assert.equal(report.unverifiedArtifactsReplaced, true);
});

test('setup does not report the unverifiable-artifacts-replaced notice for an already-verified installation', async (t) => {
  // A genuinely current, fully verified install (real digest, matches the
  // current lock exactly): setup makes no changes at all, so the notice
  // must never fire.
  const paths = await fixtureHome('fast-browser-legacy-recovery-verified-');
  const lock = {
    schemaVersion: 1,
    productVersion: '0.1.0-alpha.5',
    sourceCommit: 'b'.repeat(16),
    protocolVersion: 2,
    runtime: {
      file: 'fast-browser-mcp-0.1.0-alpha.5.tar.gz',
      sha256: 'a'.repeat(64),
      node: '>=20',
    },
    extension: {
      file: 'fast-browser-extension-0.1.0-alpha.5.zip',
      sha256: 'b'.repeat(64),
      id: 'a'.repeat(32),
      version: '0.2.2',
    },
  };
  const cliDirectory = path.join(paths.runtimeDir, lock.productVersion, 'fast-browser-mcp');
  await mkdir(cliDirectory, { recursive: true });
  await writeFile(path.join(cliDirectory, 'cli.cjs'), '#!/usr/bin/env node\n');
  const runtimeDigest = await buildContentManifestDigest(cliDirectory);
  await writeFile(
    path.join(paths.runtimeDir, lock.productVersion, 'installed.json'),
    JSON.stringify({ schemaVersion: 1, lock: runtimeLockIdentity(lock), contentDigest: runtimeDigest }),
  );
  const unpacked = extensionInstallLocation(paths).unpacked;
  await mkdir(unpacked, { recursive: true });
  await writeFile(path.join(unpacked, 'manifest.json'), JSON.stringify({ manifest_version: 3, version: '0.2.2' }));
  const extensionDigest = await buildContentManifestDigest(unpacked);
  await writeFile(
    extensionInstallLocation(paths).marker,
    JSON.stringify({ schemaVersion: 1, lock: runtimeLockIdentity(lock), contentDigest: extensionDigest }),
  );
  await saveConfig(paths, configFor(lock));

  const report = await setup(baseRequest, {
    paths,
    checkPlatform: async () => {},
    detectHosts: async () => ['claude'],
    loadConfig,
    loadRuntimeLock: async () => lock,
    saveConfig,
    doctor: async () => doctorReportWithFailures([]),
  });

  assert.equal(report.changed, false);
  assert.equal(report.unverifiedArtifactsReplaced, false);
});

test('end to end: a legacy install is refused at launch, setup replaces it, and launch then succeeds', async (t) => {
  const { newLock, paths, close } = await scenario();
  t.after(close);
  const config = { profile: 'full', connection: { mode: 'manual' }, sessions: { enabled: true } };

  // Before setup: nothing exists yet under the newly pinned name at all
  // (the classic pending-upgrade shape), so launch refuses with its
  // existing "not installed" message -- this is not yet exercising the
  // content-digest path, just confirming the starting state is refused.
  let spawnCalls = 0;
  await assert.rejects(
    launchRuntime({
      config, paths, lock: newLock, readToken: async () => null, spawn: () => { spawnCalls += 1; },
    }),
    (error) => error.message.includes('fast-browser doctor'),
  );
  assert.equal(spawnCalls, 0);

  const doctor = doctorSequence(
    ['runtime-checksum', 'extension-artifact', 'mcp-handshake', 'tool-contract', 'extension-installed'],
    ['extension-installed'],
  );
  const setupReport = await setup(baseRequest, {
    paths,
    checkPlatform: async () => {},
    detectHosts: async () => ['claude'],
    loadConfig,
    loadRuntimeLock: async () => newLock,
    ...untouchedDuringUpgrade([]),
    saveConfig,
    doctor,
  });
  assert.equal(setupReport.changed, true);

  // After setup: the freshly reinstalled runtime carries a real digest,
  // so the exact same launchRuntime call that refused a moment ago now
  // succeeds, closing the loop the coordinator asked to verify end to end.
  const captured = [];
  const result = await launchRuntime({
    config,
    paths,
    lock: newLock,
    readToken: async () => null,
    spawn: exitingSpawn(0, captured),
  });
  assert.equal(result, 0);
  assert.equal(captured.length, 1);
  assert.equal(
    captured[0].args[0],
    path.join(paths.runtimeDir, newLock.productVersion, 'fast-browser-mcp', 'cli.cjs'),
  );
});

test('CLI setup output prints the fixed unverifiable-artifacts-replaced notice for a legacy install', async (t) => {
  const { newLock, paths, close } = await scenario();
  t.after(close);
  const lines = [];
  const doctor = doctorSequence(
    ['runtime-checksum', 'extension-artifact', 'mcp-handshake', 'tool-contract', 'extension-installed'],
    ['extension-installed'],
  );

  const exitCode = await main(
    { command: 'setup', ...baseRequest },
    {
      write: (text) => lines.push(text),
      paths,
      checkPlatform: async () => {},
      detectHosts: async () => ['claude'],
      loadConfig,
      loadRuntimeLock: async () => newLock,
      ...untouchedDuringUpgrade([]),
      saveConfig,
      doctor,
    },
  );

  assert.equal(exitCode, 0);
  const output = lines.join('');
  assert.match(
    output,
    /^Note: a previously unverifiable install was replaced with a freshly verified one\.$/m,
  );
  // Fixed and non-echoing: no path, no digest, no user data anywhere in it.
  assert.doesNotMatch(output.split('\n').find((line) => line.startsWith('Note:')) ?? '', /[0-9a-f]{16,}|\//);
});
