import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  chmod, mkdir, mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { main } from '../../lib/cli/main.mjs';
import { setup } from '../../lib/commands/setup.mjs';
import { loadConfig } from '../../lib/core/config.mjs';
import { saveConfig } from '../../lib/core/files.mjs';
import { resolvePaths } from '../../lib/core/paths.mjs';
import { DOCTOR_CHECK_IDS } from '../../lib/doctor/checks.mjs';
import { buildContentManifestDigest } from '../../lib/extension/content-manifest.mjs';
import { runtimeLockIdentity } from '../../lib/runtime/lock.mjs';

// Reproduces the brief's exact scenario: a pinned install (runtime
// 0.1.0-alpha.1 / extension 0.2.1) with the lock re-pinned forward (runtime
// 0.1.0-alpha.5 / extension 0.2.2), the way it was on the real machine.
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

// Builds a real, on-disk "already installed" runtime directory the way
// runtime/install.mjs leaves it after a verified install: a CLI file plus
// the installed.json marker recording the lock identity it was installed
// from.
async function writeRuntimeInstall(paths, lock) {
  const directory = path.join(paths.runtimeDir, lock.productVersion);
  await mkdir(path.join(directory, 'fast-browser-mcp'), { recursive: true });
  await writeFile(path.join(directory, 'fast-browser-mcp', 'cli.cjs'), '// stub runtime cli\n');
  const markerPath = path.join(directory, 'installed.json');
  await writeFile(
    markerPath,
    `${JSON.stringify({ schemaVersion: 1, lock: runtimeLockIdentity(lock) }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await chmod(markerPath, 0o600);
  return directory;
}

// Same, but for extension/install.mjs's on-disk shape: an unpacked
// directory plus the installed.json marker with its install-time content
// digest.
async function writeExtensionInstall(paths, lock) {
  const directory = path.join(paths.extensionDir, lock.extension.version);
  const unpacked = path.join(directory, 'unpacked');
  await mkdir(unpacked, { recursive: true });
  await writeFile(
    path.join(unpacked, 'manifest.json'),
    JSON.stringify({ manifest_version: 3, name: 'Fast Browser', version: lock.extension.version }),
  );
  await writeFile(path.join(unpacked, 'worker.js'), 'void 0;\n');
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

function configFor(oldLock, overrides = {}) {
  return {
    schemaVersion: 1,
    productVersion: '0.1.0-alpha.1',
    profile: 'full',
    hosts: { claude: true, codex: false },
    connection: { mode: 'manual' },
    sessions: { enabled: true, retentionDays: 45 },
    runtime: {
      version: oldLock.productVersion,
      sha256: oldLock.runtime.sha256,
      sourceCommit: oldLock.sourceCommit,
    },
    managed: {
      files: [{ path: '/home/test/.claude/rules/fast-browser-routing.md', sha256: 'c'.repeat(64) }],
      blocks: [],
    },
    ...overrides,
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

// Doctor reports twice in the upgrade path: once to decide, once after
// installing (when only extension-installed is still expected to fail,
// since Chrome has not reloaded).
function doctorSequence(firstFailing, secondFailing) {
  let call = 0;
  return async () => {
    call += 1;
    return doctorReportWithFailures(call === 1 ? firstFailing : secondFailing);
  };
}

// Functions setup must never call during an upgrade: host plugin
// registration, routing, session pruning, and built-in macro installs are
// all unrelated to "the pinned artifacts changed." Each records its name if
// invoked so tests can assert none of them ever ran.
function untouchedDuringUpgrade(calls) {
  return {
    installClaude: async () => {
      calls.push('installClaude');
      return { changed: false, changes: [] };
    },
    installCodex: async () => {
      calls.push('installCodex');
      return { changed: false, changes: [] };
    },
    prepareRoutingTransition: async () => {
      calls.push('prepareRoutingTransition');
      return { nextState: {}, apply: async () => ({ rollback: async () => {} }) };
    },
    pruneSessions: async () => {
      calls.push('pruneSessions');
      return { removedPaths: [], removedBytes: 0 };
    },
    installBuiltinMacros: async () => {
      calls.push('installBuiltinMacros');
    },
  };
}

async function fixtureHome(prefix) {
  const home = await mkdtemp(path.join(tmpdir(), prefix));
  return resolvePaths({ homeDir: home });
}

const baseRequest = { hosts: ['claude'], profile: 'full', source: '/repo/mattstack', runtimeLock: null };

test('setup upgrades a self-consistent installation whose marker predates the current lock', async () => {
  const oldLock = lockFor('0.1.0-alpha.1', '0.2.1');
  const newLock = lockFor('0.1.0-alpha.5', '0.2.2');
  const paths = await fixtureHome('fast-browser-upgrade-');
  await writeRuntimeInstall(paths, oldLock);
  await writeExtensionInstall(paths, oldLock);
  const current = configFor(oldLock);
  await saveConfig(paths, current);

  const installCalls = [];
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
    installRuntime: async ({ lock }) => {
      installCalls.push(['runtime', lock.productVersion]);
      return { version: lock.productVersion };
    },
    installExtension: async ({ lock }) => {
      installCalls.push(['extension', lock.extension.version]);
      return { unpacked: path.join(paths.extensionDir, lock.extension.version, 'unpacked') };
    },
    ...untouchedDuringUpgrade(untouchedCalls),
    saveConfig,
    doctor,
  });

  assert.deepEqual(untouchedCalls, []);
  assert.deepEqual(installCalls, [
    ['runtime', '0.1.0-alpha.5'],
    ['extension', '0.2.2'],
  ]);
  assert.equal(report.changed, true);
  assert.equal(report.extensionManual, true);
  assert.equal(report.extensionPath, path.join(paths.extensionDir, '0.2.2', 'unpacked'));
  // extension-installed failing alone must not fail the command (item 5).
  assert.equal(report.doctor.ok, false);
  assert.deepEqual(
    report.doctor.checks.filter((check) => check.status === 'fail').map((check) => check.id),
    ['extension-installed'],
  );

  const persisted = await loadConfig(paths);
  assert.equal(persisted.runtime.version, '0.1.0-alpha.5');
  assert.equal(persisted.runtime.sha256, newLock.runtime.sha256);
  assert.equal(persisted.runtime.sourceCommit, newLock.sourceCommit);
  assert.deepEqual(persisted.profile, current.profile);
  assert.deepEqual(persisted.hosts, current.hosts);
  assert.deepEqual(persisted.connection, current.connection);
  assert.deepEqual(persisted.sessions, current.sessions);
  assert.deepEqual(persisted.managed, current.managed);
});

test('setup makes no changes when the installed artifacts already match the current lock', async () => {
  const lock = lockFor('0.1.0-alpha.5', '0.2.2');
  const paths = await fixtureHome('fast-browser-upgrade-nochange-');
  await writeRuntimeInstall(paths, lock);
  await writeExtensionInstall(paths, lock);
  const current = configFor(lock, {
    runtime: { version: lock.productVersion, sha256: lock.runtime.sha256, sourceCommit: lock.sourceCommit },
  });
  await saveConfig(paths, current);

  const installCalls = [];
  const untouchedCalls = [];
  const report = await setup(baseRequest, {
    paths,
    checkPlatform: async () => {},
    detectHosts: async () => ['claude'],
    loadConfig,
    loadRuntimeLock: async () => lock,
    installRuntime: async ({ lock: usedLock }) => {
      installCalls.push(['runtime', usedLock.productVersion]);
      return { version: usedLock.productVersion };
    },
    installExtension: async ({ lock: usedLock }) => {
      installCalls.push(['extension', usedLock.extension.version]);
      return { unpacked: '/unused' };
    },
    ...untouchedDuringUpgrade(untouchedCalls),
    saveConfig,
    doctor: async () => doctorReportWithFailures([]),
  });

  assert.equal(report.changed, false);
  assert.deepEqual(installCalls, []);
  assert.deepEqual(untouchedCalls, []);
});

test('setup refuses to upgrade when the installed extension bytes no longer match their own marker', async () => {
  const oldLock = lockFor('0.1.0-alpha.1', '0.2.1');
  const newLock = lockFor('0.1.0-alpha.5', '0.2.2');
  const paths = await fixtureHome('fast-browser-upgrade-tamper-ext-');
  await writeRuntimeInstall(paths, oldLock);
  const { unpacked } = await writeExtensionInstall(paths, oldLock);
  // Tamper: the on-disk bytes now differ from what the marker verified and
  // recorded at install time (the exact shape of the focus-fix incident).
  await writeFile(path.join(unpacked, 'worker.js'), 'void 1; // tampered\n');
  const current = configFor(oldLock);
  await saveConfig(paths, current);

  const installCalls = [];
  const untouchedCalls = [];
  await assert.rejects(
    setup(baseRequest, {
      paths,
      checkPlatform: async () => {},
      detectHosts: async () => ['claude'],
      loadConfig,
      loadRuntimeLock: async () => newLock,
      installRuntime: async ({ lock }) => {
        installCalls.push(['runtime', lock.productVersion]);
        return { version: lock.productVersion };
      },
      installExtension: async ({ lock }) => {
        installCalls.push(['extension', lock.extension.version]);
        return { unpacked: '/unused' };
      },
      ...untouchedDuringUpgrade(untouchedCalls),
      saveConfig,
      doctor: async () => doctorReportWithFailures([
        'runtime-checksum', 'extension-artifact', 'mcp-handshake', 'tool-contract', 'extension-installed',
      ]),
    }),
    (error) => {
      assert.equal(error.stage, 'setup-drift');
      assert.equal(
        error.message,
        'Existing Fast Browser configuration has external drift; repair the reported checks and rerun setup.',
      );
      return true;
    },
  );

  assert.deepEqual(installCalls, []);
  assert.deepEqual(untouchedCalls, []);
  const persisted = await loadConfig(paths);
  assert.deepEqual(persisted.runtime, current.runtime);
});

test('setup refuses to upgrade when the installed runtime marker is missing', async () => {
  const oldLock = lockFor('0.1.0-alpha.1', '0.2.1');
  const newLock = lockFor('0.1.0-alpha.5', '0.2.2');
  const paths = await fixtureHome('fast-browser-upgrade-missing-marker-');
  const directory = await writeRuntimeInstall(paths, oldLock);
  await writeExtensionInstall(paths, oldLock);
  await rm(path.join(directory, 'installed.json'));
  const current = configFor(oldLock);
  await saveConfig(paths, current);

  const installCalls = [];
  const untouchedCalls = [];
  await assert.rejects(
    setup(baseRequest, {
      paths,
      checkPlatform: async () => {},
      detectHosts: async () => ['claude'],
      loadConfig,
      loadRuntimeLock: async () => newLock,
      installRuntime: async ({ lock }) => {
        installCalls.push(['runtime', lock.productVersion]);
        return { version: lock.productVersion };
      },
      installExtension: async ({ lock }) => {
        installCalls.push(['extension', lock.extension.version]);
        return { unpacked: '/unused' };
      },
      ...untouchedDuringUpgrade(untouchedCalls),
      saveConfig,
      doctor: async () => doctorReportWithFailures(['runtime-checksum', 'mcp-handshake', 'tool-contract']),
    }),
    (error) => {
      assert.equal(error.stage, 'setup-drift');
      assert.equal(
        error.message,
        'Existing Fast Browser configuration has external drift; repair the reported checks and rerun setup.',
      );
      return true;
    },
  );

  assert.deepEqual(installCalls, []);
  assert.deepEqual(untouchedCalls, []);
});

test('setup refuses to upgrade when the installed extension marker is malformed JSON', async () => {
  const oldLock = lockFor('0.1.0-alpha.1', '0.2.1');
  const newLock = lockFor('0.1.0-alpha.5', '0.2.2');
  const paths = await fixtureHome('fast-browser-upgrade-malformed-marker-');
  await writeRuntimeInstall(paths, oldLock);
  const { directory } = await writeExtensionInstall(paths, oldLock);
  const markerPath = path.join(directory, 'installed.json');
  await writeFile(markerPath, 'not json{{{', { mode: 0o600 });
  await chmod(markerPath, 0o600);
  const current = configFor(oldLock);
  await saveConfig(paths, current);

  const installCalls = [];
  const untouchedCalls = [];
  await assert.rejects(
    setup(baseRequest, {
      paths,
      checkPlatform: async () => {},
      detectHosts: async () => ['claude'],
      loadConfig,
      loadRuntimeLock: async () => newLock,
      installRuntime: async ({ lock }) => {
        installCalls.push(['runtime', lock.productVersion]);
        return { version: lock.productVersion };
      },
      installExtension: async ({ lock }) => {
        installCalls.push(['extension', lock.extension.version]);
        return { unpacked: '/unused' };
      },
      ...untouchedDuringUpgrade(untouchedCalls),
      saveConfig,
      doctor: async () => doctorReportWithFailures(['extension-artifact', 'extension-installed']),
    }),
    (error) => {
      assert.equal(error.stage, 'setup-drift');
      return true;
    },
  );

  assert.deepEqual(installCalls, []);
  assert.deepEqual(untouchedCalls, []);
});

test('setup refuses to upgrade when the installed runtime marker has unsafe permissions', async () => {
  const oldLock = lockFor('0.1.0-alpha.1', '0.2.1');
  const newLock = lockFor('0.1.0-alpha.5', '0.2.2');
  const paths = await fixtureHome('fast-browser-upgrade-perms-');
  const directory = await writeRuntimeInstall(paths, oldLock);
  await writeExtensionInstall(paths, oldLock);
  await chmod(path.join(directory, 'installed.json'), 0o644);
  const current = configFor(oldLock);
  await saveConfig(paths, current);

  const installCalls = [];
  const untouchedCalls = [];
  await assert.rejects(
    setup(baseRequest, {
      paths,
      checkPlatform: async () => {},
      detectHosts: async () => ['claude'],
      loadConfig,
      loadRuntimeLock: async () => newLock,
      installRuntime: async ({ lock }) => {
        installCalls.push(['runtime', lock.productVersion]);
        return { version: lock.productVersion };
      },
      installExtension: async ({ lock }) => {
        installCalls.push(['extension', lock.extension.version]);
        return { unpacked: '/unused' };
      },
      ...untouchedDuringUpgrade(untouchedCalls),
      saveConfig,
      doctor: async () => doctorReportWithFailures(['runtime-checksum', 'mcp-handshake', 'tool-contract']),
    }),
    (error) => {
      assert.equal(error.stage, 'setup-drift');
      return true;
    },
  );

  assert.deepEqual(installCalls, []);
  assert.deepEqual(untouchedCalls, []);
});

test('setup refuses to upgrade when an unrelated check fails alongside a legitimate version bump', async () => {
  const oldLock = lockFor('0.1.0-alpha.1', '0.2.1');
  const newLock = lockFor('0.1.0-alpha.5', '0.2.2');
  const paths = await fixtureHome('fast-browser-upgrade-unrelated-');
  await writeRuntimeInstall(paths, oldLock);
  await writeExtensionInstall(paths, oldLock);
  const current = configFor(oldLock);
  await saveConfig(paths, current);

  const installCalls = [];
  const untouchedCalls = [];
  await assert.rejects(
    setup(baseRequest, {
      paths,
      checkPlatform: async () => {},
      detectHosts: async () => ['claude'],
      loadConfig,
      loadRuntimeLock: async () => newLock,
      installRuntime: async ({ lock }) => {
        installCalls.push(['runtime', lock.productVersion]);
        return { version: lock.productVersion };
      },
      installExtension: async ({ lock }) => {
        installCalls.push(['extension', lock.extension.version]);
        return { unpacked: '/unused' };
      },
      ...untouchedDuringUpgrade(untouchedCalls),
      saveConfig,
      doctor: async () => doctorReportWithFailures([
        'runtime-checksum', 'extension-artifact', 'mcp-handshake', 'tool-contract', 'extension-installed',
        'claude-plugin',
      ]),
    }),
    (error) => {
      assert.equal(error.stage, 'setup-drift');
      return true;
    },
  );

  assert.deepEqual(installCalls, []);
  assert.deepEqual(untouchedCalls, []);
});

test('an upgrade leaves pairing mode, session settings, routing files, and host registrations byte-identical', async () => {
  const oldLock = lockFor('0.1.0-alpha.1', '0.2.1');
  const newLock = lockFor('0.1.0-alpha.5', '0.2.2');
  const paths = await fixtureHome('fast-browser-upgrade-preserve-');
  await writeRuntimeInstall(paths, oldLock);
  await writeExtensionInstall(paths, oldLock);

  const routingPath = path.join(paths.homeDir, '.claude', 'rules', 'fast-browser-routing.md');
  const routingContent = '# Fast Browser routing\nmanaged content\n';
  await mkdir(path.dirname(routingPath), { recursive: true });
  await writeFile(routingPath, routingContent);
  const routingSha256 = crypto.createHash('sha256').update(routingContent).digest('hex');

  const macroPath = path.join(paths.macrosDir, 'custom-macro.md');
  await mkdir(paths.macrosDir, { recursive: true });
  await writeFile(macroPath, '# my macro\n');

  const sessionPath = path.join(paths.sessionsDir, 'session-2026-07-20', 'log.ndjson');
  await mkdir(path.dirname(sessionPath), { recursive: true });
  await writeFile(sessionPath, '{"event":"nav"}\n');

  const current = configFor(oldLock, {
    connection: { mode: 'auto' },
    sessions: { enabled: true, retentionDays: 90 },
    managed: {
      files: [{ path: routingPath, sha256: routingSha256 }],
      blocks: [],
    },
  });
  await saveConfig(paths, current);

  const beforeRouting = await readFile(routingPath, 'utf8');
  const beforeMacro = await readFile(macroPath, 'utf8');
  const beforeSession = await readFile(sessionPath, 'utf8');

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
    installRuntime: async ({ lock }) => ({ version: lock.productVersion }),
    installExtension: async ({ lock }) => (
      { unpacked: path.join(paths.extensionDir, lock.extension.version, 'unpacked') }
    ),
    ...untouchedDuringUpgrade(untouchedCalls),
    saveConfig,
    doctor,
  });

  assert.equal(report.changed, true);
  // No host, routing, session, or macro dependency setup uses for a fresh
  // install was ever invoked: pairing/Keychain, routing files, and host
  // registrations are therefore provably untouched, not merely unaffected.
  assert.deepEqual(untouchedCalls, []);

  assert.equal(await readFile(routingPath, 'utf8'), beforeRouting);
  assert.equal(await readFile(macroPath, 'utf8'), beforeMacro);
  assert.equal(await readFile(sessionPath, 'utf8'), beforeSession);

  const persisted = await loadConfig(paths);
  assert.deepEqual(persisted.connection, { mode: 'auto' });
  assert.deepEqual(persisted.sessions, { enabled: true, retentionDays: 90 });
  assert.deepEqual(persisted.managed, current.managed);
  assert.equal(persisted.profile, 'full');
});

test('CLI setup output prints the unpacked extension path and manual reload step for an upgrade', async () => {
  const oldLock = lockFor('0.1.0-alpha.1', '0.2.1');
  const newLock = lockFor('0.1.0-alpha.5', '0.2.2');
  const paths = await fixtureHome('fast-browser-upgrade-cli-');
  await writeRuntimeInstall(paths, oldLock);
  await writeExtensionInstall(paths, oldLock);
  const current = configFor(oldLock);
  await saveConfig(paths, current);

  const untouchedCalls = [];
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
      installRuntime: async ({ lock }) => ({ version: lock.productVersion }),
      installExtension: async ({ lock }) => (
        { unpacked: path.join(paths.extensionDir, lock.extension.version, 'unpacked') }
      ),
      ...untouchedDuringUpgrade(untouchedCalls),
      saveConfig,
      doctor,
    },
  );

  assert.equal(exitCode, 0);
  const output = lines.join('');
  assert.match(output, /Chrome extension: manual installation required at/);
  assert.ok(output.includes(path.join(paths.extensionDir, '0.2.2', 'unpacked')));
  assert.match(output, /Next: load the extension, then run `fast-browser doctor`/);
});
