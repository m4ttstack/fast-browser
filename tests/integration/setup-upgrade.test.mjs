import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  chmod, mkdir, mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { main } from '../../lib/cli/main.mjs';
import { setup } from '../../lib/commands/setup.mjs';
import { loadConfig } from '../../lib/core/config.mjs';
import { saveConfig } from '../../lib/core/files.mjs';
import { resolvePaths } from '../../lib/core/paths.mjs';
import { DOCTOR_CHECK_IDS } from '../../lib/doctor/checks.mjs';
import { extensionInstallLocation } from '../../lib/extension/install.mjs';
import { buildContentManifestDigest } from '../../lib/core/content-manifest.mjs';
import { installLauncher } from '../../lib/core/launcher.mjs';
import { installBuiltinMacros } from '../../lib/macros/install.mjs';
import { runtimeLockIdentity } from '../../lib/runtime/lock.mjs';

const PLUGIN_ROOT = fileURLToPath(new URL('../..', import.meta.url));

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
  const cliDirectory = path.join(directory, 'fast-browser-mcp');
  await mkdir(cliDirectory, { recursive: true });
  await writeFile(path.join(cliDirectory, 'cli.cjs'), '// stub runtime cli\n');
  const contentDigest = await buildContentManifestDigest(cliDirectory);
  const markerPath = path.join(directory, 'installed.json');
  await writeFile(
    markerPath,
    `${JSON.stringify({ schemaVersion: 1, lock: runtimeLockIdentity(lock), contentDigest }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await chmod(markerPath, 0o600);
  return directory;
}

// Same, but for extension/install.mjs's on-disk shape: an unpacked
// directory plus the installed.json marker with its install-time content
// digest.
async function writeExtensionInstall(paths, lock) {
  const directory = extensionInstallLocation(paths).directory;
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
// registration, routing, and session pruning are all unrelated to "the pinned
// artifacts changed." Each records its name if invoked so tests can assert
// none of them ever ran.
//
// installBuiltinMacros used to be spied here too, and was deliberately taken
// out rather than allowed to fail. When this list was written the macro
// installer was an unconditional copy, which put it squarely in the same class
// as the other three: calling it meant writing, so the only way to guarantee
// an upgrade left the user's macros alone was to guarantee it was never
// called. The checksum work made it categorically different. It classifies
// every destination by what its bytes are, so it provably writes nothing when
// the installed bytes already match the packaged ones, and provably preserves
// anything the user has edited (the never-clobber tests in
// tests/unit/macros.test.mjs are the standing proof of both).
//
// The guarantee itself is unchanged and still worth having: an upgrade must
// not write to the user's macros directory. What stopped being true is that
// calling the installer implies writing, so a call spy is no longer evidence
// of anything. The property is now asserted where it actually lives, on the
// bytes: this file still reads a real user macro before and after an upgrade
// and asserts it is unchanged. Reinstating the spy here would only re-break
// the macro-only fix that MAT-87 exists to deliver, since a macro fix never
// moves runtime-lock.json and so can only ever reach a machine through this
// path.
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
  };
}

// A real plugin root plus the built-ins already installed from it, because
// that is what every scenario in this file is about: a machine that has run
// setup before. Setup now refreshes the built-ins on the already-current and
// upgrade paths, so a fixture whose macros directory is empty would model a
// half-installed machine and report `changed: true` for having finally
// installed them, which is true but has nothing to do with the pinned
// artifacts these tests are asserting about.
async function fixtureHome(prefix) {
  const home = await mkdtemp(path.join(tmpdir(), prefix));
  const paths = { ...resolvePaths({ homeDir: home }), pluginRoot: PLUGIN_ROOT };
  await installBuiltinMacros(paths);
  // The launcher shim is refreshed on every outcome exactly like the
  // built-ins, so a machine that has run setup before already has it; without
  // this the no-change scenarios would report `changed: true` for finally
  // installing a shim, which is true but unrelated to the pinned artifacts.
  await installLauncher(paths);
  return paths;
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
      return { unpacked: extensionInstallLocation(paths).unpacked };
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
  assert.equal(report.extensionPath, extensionInstallLocation(paths).unpacked);
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

// The reviewer's exact reproduction. A CURRENT-version runtime directory
// exists whose installed.json was rewritten to record the (public) current
// lock identity, with a contentDigest recomputed to match its own tampered
// bytes (self-consistent on its own terms). A second, genuinely-old runtime
// directory also exists, exactly the normal leftover state after any prior
// upgrade since nothing prunes old directories. Before this fix,
// explainedByUpgrade asked only "does some runtime directory differ from
// the current lock", and the genuinely-old directory answered yes, wrongly
// excusing the tampered CURRENT one: setup would have proceeded to
// "upgrade" (changed: true) while installRuntime's own existingInstall
// shortcut (marker.lock equality only, no digest recompute) accepted the
// tampered directory outright, so the malicious CLI was never downloaded,
// verified, or even read. It must now refuse instead.
test('setup refuses to upgrade when the currently-pinned runtime directory is tampered even though a genuinely older one also exists', async () => {
  const oldLock = lockFor('0.1.0-alpha.1', '0.2.1');
  const newLock = lockFor('0.1.0-alpha.5', '0.2.2');
  const paths = await fixtureHome('fast-browser-upgrade-runtime-tamper-');
  await writeRuntimeInstall(paths, oldLock);
  await writeExtensionInstall(paths, oldLock);

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
      doctor: async () => doctorReportWithFailures(['mcp-handshake', 'tool-contract']),
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

  // Never even attempted an install: the tampered directory was neither
  // downloaded over, nor silently accepted, nor read for verification --
  // setup refused before installRuntime/installExtension were ever called.
  assert.deepEqual(installCalls, []);
  assert.deepEqual(untouchedCalls, []);
  const persisted = await loadConfig(paths);
  assert.deepEqual(persisted.runtime, current.runtime);
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
      { unpacked: extensionInstallLocation(paths).unpacked }
    ),
    ...untouchedDuringUpgrade(untouchedCalls),
    saveConfig,
    doctor,
  });

  assert.equal(report.changed, true);
  // No host, routing, or session dependency setup uses for a fresh install was
  // ever invoked: pairing/Keychain, routing files, and host registrations are
  // therefore provably untouched, not merely unaffected. Macros are asserted
  // differently and deliberately so: the installer does run here, because a
  // macro-only fix can reach a machine no other way, and it is the byte
  // comparison below that proves it left the user's macro alone.
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

test('CLI setup output asks for a reload, not a reinstall, after an upgrade', async () => {
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
        { unpacked: extensionInstallLocation(paths).unpacked }
      ),
      ...untouchedDuringUpgrade(untouchedCalls),
      saveConfig,
      doctor,
    },
  );

  assert.equal(exitCode, 0);
  const output = lines.join('');
  // An upgrade must ask for a RELOAD, never another "Load unpacked": the
  // install directory is stable, so removing and re-adding the extension is
  // both unnecessary and destructive -- it is exactly what discards the
  // extension's stored reconnect token and forces the user to re-pair.
  assert.match(output, /Chrome extension: reload required in chrome:\/\/extensions/);
  assert.match(
    output,
    /Next: click the reload arrow on Fast Browser, then run `fast-browser doctor`/,
  );
  assert.doesNotMatch(output, /manual installation required/);
  assert.doesNotMatch(output, /Load unpacked/);
  // Every prior fixture here already carries a valid contentDigest: this
  // is a genuine version-bump upgrade, not a legacy/unverifiable install,
  // so the unverifiable-artifacts-replaced notice must never appear.
  assert.doesNotMatch(output, /previously unverifiable install/);
});

// The state every install and upgrade now ends in: the pinned bytes are on
// disk and verified, and Chrome has not been reloaded yet. Nothing setup can
// do resolves it -- only a click in chrome://extensions does -- so rerunning
// setup while it is pending must report "nothing to do" rather than accusing
// the installation of external drift. Before extension-loaded was split out
// of extension-installed, a user who ran setup twice in that window got a
// hard drift failure for a completely healthy install.
test('a pending extension reload alone is not drift and does not re-run setup', async () => {
  const lock = lockFor('0.1.0-alpha.5', '0.2.2');
  const paths = await fixtureHome('fast-browser-pending-reload-');
  await writeRuntimeInstall(paths, lock);
  await writeExtensionInstall(paths, lock);
  await saveConfig(paths, configFor(lock));

  const installCalls = [];
  const untouchedCalls = [];

  const report = await setup(baseRequest, {
    paths,
    checkPlatform: async () => {},
    detectHosts: async () => ['claude'],
    loadConfig,
    loadRuntimeLock: async () => lock,
    installRuntime: async () => {
      installCalls.push('runtime');
      return { version: lock.productVersion };
    },
    installExtension: async () => {
      installCalls.push('extension');
      return { unpacked: extensionInstallLocation(paths).unpacked };
    },
    ...untouchedDuringUpgrade(untouchedCalls),
    saveConfig,
    doctor: async () => doctorReportWithFailures(['extension-loaded']),
  });

  assert.equal(report.changed, false);
  assert.deepEqual(installCalls, []);
  assert.deepEqual(untouchedCalls, []);
  // The failing check still rides along so the CLI can say "reload it".
  assert.deepEqual(
    report.doctor.checks.filter((check) => check.status === 'fail').map((check) => check.id),
    ['extension-loaded'],
  );
});

// The exclusion must be narrow: a pending reload alongside a real failure is
// still drift, or the allowance would become a way to smuggle any failure
// past the guard.
test('a pending extension reload does not excuse a genuinely failing check', async () => {
  const lock = lockFor('0.1.0-alpha.5', '0.2.2');
  const paths = await fixtureHome('fast-browser-pending-reload-drift-');
  await writeRuntimeInstall(paths, lock);
  await writeExtensionInstall(paths, lock);
  await saveConfig(paths, configFor(lock));

  await assert.rejects(
    setup(baseRequest, {
      paths,
      checkPlatform: async () => {},
      detectHosts: async () => ['claude'],
      loadConfig,
      loadRuntimeLock: async () => lock,
      installRuntime: async () => ({ version: lock.productVersion }),
      installExtension: async () => ({ unpacked: extensionInstallLocation(paths).unpacked }),
      ...untouchedDuringUpgrade([]),
      saveConfig,
      doctor: async () => doctorReportWithFailures(['extension-loaded', 'claude-routing']),
    }),
    /drift/i,
  );
});

// Task 10 fix-round regression for the reviewer's CRITICAL finding: adding
// `annotate-renderer` to DOCTOR_CHECK_IDS broke this exact rerun path for
// anyone without librsvg installed, because MANUAL_STEP_CHECK_IDS did not
// know about it. Every other prior test in this file that exercises the
// "profile and hosts unchanged" branch injects `deps.doctor` with a
// synthetic doctorReportWithFailures(...), so none of them ever ran the
// real, composed doctor() and its real annotate-renderer check -- which is
// exactly why the bug shipped unnoticed. This test never overrides
// `deps.doctor`, letting setup() fall through to the real doctor() from
// lib/commands/doctor.mjs, with every underlying adapter it needs supplied
// so every check genuinely runs and genuinely passes except
// annotate-renderer, which genuinely fails because `rendererVersion` (the
// one adapter this test deliberately makes report absent) mirrors a real
// machine that has never run `brew install librsvg`. Annotation is
// optional and not installed by setup, so this must never look like drift.
test('setup treats a real, fully composed doctor report as unchanged when only the optional capability renderers are missing', async () => {
  const lock = lockFor('0.1.0-alpha.5', '0.2.2');
  const paths = await fixtureHome('fast-browser-annotate-renderer-optional-');
  await writeRuntimeInstall(paths, lock);
  const { unpacked } = await writeExtensionInstall(paths, lock);
  const current = configFor(lock, {
    profile: 'safe',
    hosts: { claude: true, codex: false },
    connection: { mode: 'manual' },
    runtime: {
      version: lock.productVersion,
      sha256: lock.runtime.sha256,
      sourceCommit: lock.sourceCommit,
    },
  });
  await saveConfig(paths, current);

  const requiredTools = [
    { name: 'browser_navigate' },
    { name: 'browser_snapshot' },
    { name: 'browser_click' },
    {
      name: 'browser_run_code_unsafe',
      annotations: { destructiveHint: true, openWorldHint: true },
    },
  ];

  const report = await setup(
    { hosts: ['claude'], profile: 'safe', source: '/repo/mattstack', runtimeLock: null },
    {
      paths,
      checkPlatform: async () => {},
      detectHosts: async () => ['claude'],
      loadConfig,
      loadRuntimeLock: async () => lock,
      platform: 'darwin',
      nodeVersion: '22.0.0',
      checkChrome: async () => {},
      preflightClaude: async () => ({ installed: true }),
      preflightRouting: async () => ({ files: [], blocks: [] }),
      detectChromeExtension: async () => [{
        profile: 'Default',
        installed: true,
        manifestVersion: lock.extension.version,
        versionSource: 'disk',
        path: unpacked,
        loadedAt: 1_700_000_000_000,
      }],
      verifyExtensionIsLoadedContent: async () => true,
      // The adapters this test deliberately fails: no librsvg and no ffmpeg
      // installed, the resting state for the optional capabilities.
      rendererVersion: async () => null,
      gifRendererVersion: async () => null,
      openMcpTransport: async () => ({
        request: async (message) => (
          message.method === 'initialize'
            ? { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26' } }
            : { jsonrpc: '2.0', id: message.id, result: { tools: requiredTools } }
        ),
        notify: async () => {},
        close: async () => {},
      }),
    },
  );

  assert.equal(report.changed, false);
  const failing = report.doctor.checks.filter((check) => check.status === 'fail');
  assert.deepEqual(failing.map((check) => check.id), ['annotate-renderer', 'gif-renderer']);
  assert.match(failing[0].remediation, /brew install librsvg/);
  assert.match(failing[1].remediation, /brew install ffmpeg/);
});

// A successful rollback returned undefined, so the CLI threw while rendering
// its report -- after every file had already been restored. The user saw a
// crash for a rollback that had fully succeeded, which invites them to
// "repair" a state that was already correct. Exercise the real CLI rendering
// path, not just the migration function, because the crash lived there.
test('CLI migrate --rollback reports success rather than crashing on the report', async () => {
  const lines = [];
  const exitCode = await main(
    {
      command: 'migrate',
      rollback: '/home/test/.fast-browser/backups/migration-1/rollback.json',
      hosts: [],
    },
    {
      write: (text) => lines.push(text),
      paths: resolvePaths({ homeDir: '/home/test' }),
      checkPlatform: async () => {},
      rollbackMigration: async () => ({
        rollback: true,
        manifestPath: '/home/test/.fast-browser/backups/migration-1/rollback.json',
        restoredPaths: ['/home/test/.claude/agents/browser-driver.md'],
      }),
    },
  );

  assert.equal(exitCode, 0);
  assert.match(lines.join(''), /Migration rolled back; 1 legacy path restored\./);
});
