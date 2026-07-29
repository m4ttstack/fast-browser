import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { setup } from '../../lib/commands/setup.mjs';
import { loadConfig } from '../../lib/core/config.mjs';
import { buildContentManifestDigest } from '../../lib/core/content-manifest.mjs';
import { saveConfig } from '../../lib/core/files.mjs';
import { resolvePaths } from '../../lib/core/paths.mjs';
import { DOCTOR_CHECK_IDS } from '../../lib/doctor/checks.mjs';
import { extensionInstallLocation } from '../../lib/extension/install.mjs';
import { installBuiltinMacros } from '../../lib/macros/install.mjs';
import { runtimeLockIdentity } from '../../lib/runtime/lock.mjs';

// A macro-only fix is the case this whole refresh exists for, and it is the one
// case that never changes runtime-lock.json: no doctor check fails, so setup
// takes the "already current" branch and returns without doing anything. These
// tests drive the REAL installBuiltinMacros through setup() so that branch is
// exercised end to end rather than through a spy that would pass either way.

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

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
}

async function writeExtensionInstall(paths, lock) {
  const { directory } = extensionInstallLocation(paths);
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
}

function configFor(lock) {
  return {
    schemaVersion: 1,
    productVersion: '0.1.0-alpha.1',
    profile: 'full',
    hosts: { claude: true, codex: false },
    connection: { mode: 'manual' },
    sessions: { enabled: true, retentionDays: 45 },
    runtime: {
      version: lock.productVersion,
      sha256: lock.runtime.sha256,
      sourceCommit: lock.sourceCommit,
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

// The real manifest records exactly the bytes this working tree packages, so
// the refresh branch is unreachable through the real plugin root. A throwaway
// root whose packaged macro has moved on from a recorded shipped release is
// what makes "a macro-only fix shipped" reproducible.
function syntheticSection(name, body) {
  return `## ${name}\n\n- Params: \`{ ${body} }\`\n- Status: built-in`;
}

const SHIPPED_RECON = '// shipped recon\n';
const CURRENT_RECON = '// current recon\n';
const CURRENT_CAPTURE = '// current capture\n';
const SHIPPED_RECON_SECTION = syntheticSection('page-recon', 'maxLinks?: number');
const CURRENT_RECON_SECTION = syntheticSection('page-recon', 'maxLinks?: number, home: string');
const CURRENT_CAPTURE_SECTION = syntheticSection('capture-annotated', 'targets: object');

async function movedOnPluginRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-setup-macro-plugin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'builtins', 'macros'), { recursive: true });
  await mkdir(path.join(root, 'skills', 'browser-macros'), { recursive: true });
  await writeFile(path.join(root, 'builtins', 'macros', 'page-recon.js'), CURRENT_RECON, 'utf8');
  await writeFile(
    path.join(root, 'builtins', 'macros', 'capture-annotated.js'),
    CURRENT_CAPTURE,
    'utf8',
  );
  await writeFile(
    path.join(root, 'skills', 'browser-macros', 'MACROS.md'),
    ['# Macro Index', '', CURRENT_RECON_SECTION, '', CURRENT_CAPTURE_SECTION, ''].join('\n'),
    'utf8',
  );
  await writeFile(
    path.join(root, 'builtins', 'macro-hashes.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      macros: {
        'page-recon.js': [sha256(SHIPPED_RECON), sha256(CURRENT_RECON)],
        'capture-annotated.js': [sha256(CURRENT_CAPTURE)],
      },
      indexSections: {
        'page-recon': [sha256(SHIPPED_RECON_SECTION), sha256(CURRENT_RECON_SECTION)],
        'capture-annotated': [sha256(CURRENT_CAPTURE_SECTION)],
      },
    }, null, 2)}\n`,
    'utf8',
  );
  return root;
}

async function fixtureHome(t, prefix, pluginRoot) {
  const home = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { ...resolvePaths({ homeDir: home }), pluginRoot };
}

const baseRequest = {
  hosts: ['claude'], profile: 'full', source: '/repo/mattstack', runtimeLock: null,
};

// Dependencies setup must not need on any path these tests exercise. Supplying
// them keeps a stray call loud rather than letting it reach the real thing.
function inertDeps() {
  return {
    checkPlatform: async () => {},
    detectHosts: async () => ['claude'],
    loadConfig,
    saveConfig,
    installClaude: async () => ({ host: 'claude', changed: false, changes: [] }),
    installCodex: async () => ({ host: 'codex', changed: false, changes: [] }),
    prepareRoutingTransition: async () => ({
      nextState: {}, apply: async () => ({ rollback: async () => {} }),
    }),
    pruneSessions: async () => ({ removedPaths: [], removedBytes: 0 }),
  };
}

async function currentInstall(t, prefix) {
  const pluginRoot = await movedOnPluginRoot(t);
  const paths = await fixtureHome(t, prefix, pluginRoot);
  const lock = lockFor('0.1.0-alpha.5', '0.2.2');
  await writeRuntimeInstall(paths, lock);
  await writeExtensionInstall(paths, lock);
  await saveConfig(paths, configFor(lock));
  await mkdir(paths.macrosDir, { recursive: true, mode: 0o700 });
  return { paths, lock };
}

async function upgradeInstall(t, prefix) {
  const pluginRoot = await movedOnPluginRoot(t);
  const paths = await fixtureHome(t, prefix, pluginRoot);
  const oldLock = lockFor('0.1.0-alpha.1', '0.2.1');
  const newLock = lockFor('0.1.0-alpha.5', '0.2.2');
  await writeRuntimeInstall(paths, oldLock);
  await writeExtensionInstall(paths, oldLock);
  await saveConfig(paths, configFor(oldLock));
  await mkdir(paths.macrosDir, { recursive: true, mode: 0o700 });
  return { paths, newLock };
}

function upgradeDeps(paths, newLock) {
  return {
    ...inertDeps(),
    paths,
    loadRuntimeLock: async () => newLock,
    installRuntime: async ({ lock }) => ({ version: lock.productVersion }),
    installExtension: async () => ({ unpacked: extensionInstallLocation(paths).unpacked }),
    doctor: doctorSequence(
      ['runtime-checksum', 'extension-artifact', 'mcp-handshake', 'tool-contract', 'extension-installed'],
      ['extension-installed'],
    ),
  };
}

// The motivating case, exactly: nothing about the pinned artifacts moved, so
// the only branch setup can take is the one that used to return immediately.
test('an already-current setup refreshes a stale built-in macro and says so', async (t) => {
  const { paths, lock } = await currentInstall(t, 'fast-browser-setup-macro-current-');
  const installed = path.join(paths.macrosDir, 'page-recon.js');
  await writeFile(installed, SHIPPED_RECON, 'utf8');

  const report = await setup(baseRequest, {
    ...inertDeps(),
    paths,
    loadRuntimeLock: async () => lock,
    doctor: async () => doctorReportWithFailures([]),
  });

  assert.equal(await readFile(installed, 'utf8'), CURRENT_RECON);
  assert.ok(
    report.macros.refreshed.includes('page-recon.js'),
    'a refreshed macro has to reach the report, or the user never learns their macro moved',
  );
  // A refresh wrote bytes. Reporting `changed: false` here would be a lie.
  assert.equal(report.changed, true);
});

test('an already-current setup refreshes a stale index section and says so', async (t) => {
  const { paths, lock } = await currentInstall(t, 'fast-browser-setup-macro-index-');
  await writeFile(
    paths.macroIndexFile,
    ['# Macro Index', '', SHIPPED_RECON_SECTION, '', CURRENT_CAPTURE_SECTION, ''].join('\n'),
    'utf8',
  );
  await writeFile(path.join(paths.macrosDir, 'page-recon.js'), CURRENT_RECON, 'utf8');
  await writeFile(path.join(paths.macrosDir, 'capture-annotated.js'), CURRENT_CAPTURE, 'utf8');

  const report = await setup(baseRequest, {
    ...inertDeps(),
    paths,
    loadRuntimeLock: async () => lock,
    doctor: async () => doctorReportWithFailures([]),
  });

  const merged = await readFile(paths.macroIndexFile, 'utf8');
  assert.ok(merged.includes(CURRENT_RECON_SECTION), 'the stale section is replaced');
  assert.ok(!merged.includes(SHIPPED_RECON_SECTION));
  assert.ok(report.macros.refreshed.includes('MACROS.md#page-recon'));
  assert.equal(report.changed, true);
});

// The other half of the contract: running the refresh unconditionally is only
// safe because it writes nothing when there is nothing to write, and `changed`
// has to stay false for the overwhelmingly common rerun.
test('an already-current setup with everything current writes nothing and still reports changed: false', async (t) => {
  const { paths, lock } = await currentInstall(t, 'fast-browser-setup-macro-noop-');
  await installBuiltinMacros(paths);
  const before = await Promise.all([
    lstat(path.join(paths.macrosDir, 'page-recon.js')),
    lstat(path.join(paths.macrosDir, 'capture-annotated.js')),
    lstat(paths.macroIndexFile),
  ]);

  const report = await setup(baseRequest, {
    ...inertDeps(),
    paths,
    loadRuntimeLock: async () => lock,
    doctor: async () => doctorReportWithFailures([]),
  });

  const after = await Promise.all([
    lstat(path.join(paths.macrosDir, 'page-recon.js')),
    lstat(path.join(paths.macrosDir, 'capture-annotated.js')),
    lstat(paths.macroIndexFile),
  ]);
  // Every write path lands a fresh inode over the destination, so an unchanged
  // inode is direct evidence nothing was rewritten.
  for (const [index, state] of after.entries()) {
    assert.equal(state.ino, before[index].ino, 'an up-to-date destination is not rewritten');
    assert.equal(state.mtimeMs, before[index].mtimeMs);
  }
  assert.equal(report.changed, false);
  assert.deepEqual(report.macros.refreshed, []);
});

test('a lock upgrade refreshes a stale built-in macro', async (t) => {
  const { paths, newLock } = await upgradeInstall(t, 'fast-browser-setup-macro-upgrade-');
  const installed = path.join(paths.macrosDir, 'page-recon.js');
  await writeFile(installed, SHIPPED_RECON, 'utf8');

  const report = await setup(baseRequest, upgradeDeps(paths, newLock));

  assert.equal(await readFile(installed, 'utf8'), CURRENT_RECON);
  assert.ok(report.macros.refreshed.includes('page-recon.js'));
  assert.equal(report.changed, true);
});

// The never-clobber guarantee has to survive on every path the refresh now
// runs on, not only on the reinstall branch it was first written against.
for (const scenario of ['already-current', 'lock-upgrade']) {
  test(`a user-edited built-in macro is preserved on the ${scenario} path`, async (t) => {
    const mine = '// mine, do not touch\n';
    const prefix = `fast-browser-setup-macro-mine-${scenario}-`;
    const fixture = scenario === 'already-current'
      ? await currentInstall(t, prefix)
      : await upgradeInstall(t, prefix);
    const { paths } = fixture;
    const installed = path.join(paths.macrosDir, 'page-recon.js');
    await writeFile(installed, mine, 'utf8');

    const report = scenario === 'already-current'
      ? await setup(baseRequest, {
        ...inertDeps(),
        paths,
        loadRuntimeLock: async () => fixture.lock,
        doctor: async () => doctorReportWithFailures([]),
      })
      : await setup(baseRequest, upgradeDeps(paths, fixture.newLock));

    assert.equal(await readFile(installed, 'utf8'), mine, 'a user-edited macro is never clobbered');
    assert.ok(report.macros.preserved.includes('page-recon.js'));
    assert.ok(!report.macros.refreshed.includes('page-recon.js'));
  });
}
