import assert from 'node:assert/strict';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { migrate } from '../../lib/commands/migrate.mjs';
import { setup } from '../../lib/commands/setup.mjs';
import { resolvePaths } from '../../lib/core/paths.mjs';
import {
  nodeFileTransactionIo,
  ROUTING_TRANSACTION_RECOVERY_REQUIRED,
  RoutingTransactionError,
} from '../../lib/hosts/file-transaction.mjs';
import {
  installRouting,
  prepareRoutingTransition,
  preflightRoutingRemoval,
} from '../../lib/hosts/routing.mjs';
import { parseRuntimeLock } from '../../lib/runtime/lock.mjs';
import { defaultConfig } from '../../lib/core/config.mjs';

function request(overrides = {}) {
  return {
    hosts: ['claude', 'codex'],
    profile: 'full',
    source: '/repo/mattstack',
    runtimeLock: null,
    ...overrides,
  };
}

function migrationConfig() {
  return {
    schemaVersion: 1,
    productVersion: '0.1.0-alpha.1',
    profile: 'safe',
    hosts: { claude: false, codex: false },
    connection: { mode: 'manual' },
    sessions: { enabled: false, retentionDays: 30 },
    runtime: { version: null, sha256: null, sourceCommit: null },
    managed: { files: [], blocks: [] },
    annotation: { palette: null },
    video: null,
    trace: true,
    encoder: 'lexical',
    registry: { url: null, publicKey: null, assumeYes: false },
  };
}

test('setup orchestrates lifecycle work in the exact deterministic order', async () => {
  const events = [];
  const record = (name, value) => async () => {
    events.push(name);
    return value;
  };
  const managedState = { profile: 'full', files: [], blocks: [] };
  const report = await setup(request(), {
    checkPlatform: record('check-platform'),
    detectHosts: record('detect-hosts', ['claude', 'codex']),
    ensureDataDirs: record('ensure-data-dirs'),
    loadRuntimeLock: async () => ({
      productVersion: '0.1.0-alpha.1',
      sourceCommit: 'abc',
      runtime: { sha256: 'a'.repeat(64) },
      extension: { id: 'extension-id', version: '1.0.0' },
    }),
    installRuntime: record('install-runtime', { version: '0.1.0-alpha.1' }),
    installExtension: record('install-extension-artifact', { unpacked: '/tmp/extension' }),
    installClaude: record('install-claude', { changed: true }),
    installCodex: record('install-codex', { changed: true }),
    installBuiltinMacros: record('install-builtins'),
    installLauncher: record('install-launcher', {
      action: 'installed',
      path: '/home/test/.local/bin/fast-browser',
    }),
    pruneSessions: record('prune-sessions', { removedPaths: [], removedBytes: 0 }),
    prepareRoutingTransition: async () => {
      events.push('prepare-routing');
      return {
        nextState: managedState,
        apply: record('apply-routing', { rollback: async () => {} }),
      };
    },
    saveConfig: record('save-config'),
    doctor: record('doctor', { schemaVersion: 1, ok: true, checks: [] }),
    loadConfig: async () => null,
    paths: {
      dataDir: '/home/test/.fast-browser',
      configFile: '/home/test/.fast-browser/config.json',
    },
    interactive: true,
  });

  assert.deepEqual(events, [
    'check-platform',
    'detect-hosts',
    'ensure-data-dirs',
    'install-runtime',
    'install-extension-artifact',
    'install-claude',
    'install-codex',
    'install-builtins',
    'install-launcher',
    'prepare-routing',
    'apply-routing',
    'save-config',
    'prune-sessions',
    'doctor',
  ]);
  assert.equal(report.profile, 'full');
  assert.deepEqual(report.hosts, ['claude', 'codex']);
  assert.equal(report.extensionPath, '/tmp/extension');
  assert.equal(report.doctor.ok, true);
});

test('setup persists the accepted lock top-level source commit', async () => {
  const sourceCommit = 'abc123';
  const lock = parseRuntimeLock({
    schemaVersion: 1,
    productVersion: '0.1.0-alpha.1',
    sourceCommit,
    protocolVersion: 2,
    runtime: {
      url: 'https://github.com/a/b/releases/download/v1/fast-browser-mcp-0.1.0-alpha.1.tar.gz',
      file: 'fast-browser-mcp-0.1.0-alpha.1.tar.gz',
      sha256: 'a'.repeat(64),
      node: '>=20',
    },
    extension: {
      url: 'https://github.com/a/b/releases/download/v1/fast-browser-extension-0.1.0-alpha.1.zip',
      file: 'fast-browser-extension-0.1.0-alpha.1.zip',
      sha256: 'b'.repeat(64),
      id: 'a'.repeat(32),
      version: '0.2.1',
    },
  });
  let savedConfig;

  const report = await setup(request(), {
    checkPlatform: async () => {},
    detectHosts: async () => ['claude', 'codex'],
    getCodexVersion: async () => 'codex-cli 0.145.0',
    ensureDataDirs: async () => {},
    loadRuntimeLock: async () => lock,
    installRuntime: async () => ({ version: '0.1.0-alpha.1' }),
    installExtension: async () => ({ unpacked: '/tmp/extension' }),
    installClaude: async () => ({ host: 'claude', changed: false, changes: [] }),
    installCodex: async () => ({ host: 'codex', changed: false, changes: [] }),
    installBuiltinMacros: async () => {},
    installLauncher: async () => ({
      action: 'installed',
      path: '/home/test/.local/bin/fast-browser',
    }),
    prepareRoutingTransition: async () => ({
      nextState: { profile: 'full', files: [], blocks: [] },
      apply: async () => ({ rollback: async () => {} }),
    }),
    saveConfig: async (_paths, config) => {
      savedConfig = config;
    },
    pruneSessions: async () => ({ removedPaths: [], removedBytes: 0 }),
    doctor: async () => ({ schemaVersion: 1, ok: true, checks: [] }),
    loadConfig: async () => null,
    paths: {
      homeDir: '/home/test',
      dataDir: '/home/test/.fast-browser',
      configFile: '/home/test/.fast-browser/config.json',
    },
    interactive: true,
  });

  assert.equal(savedConfig.runtime.sourceCommit, sourceCommit);
  assert.equal(report.config.runtime.sourceCommit, sourceCommit);
});

test('setup carries selected hosts and the detected Codex version into routing', async () => {
  let routingInput;
  await setup(request({ hosts: ['codex'], profile: 'safe' }), {
    checkPlatform: async () => {},
    detectHosts: async () => ['codex'],
    getCodexVersion: async () => 'codex-cli 0.145.0',
    ensureDataDirs: async () => {},
    loadRuntimeLock: async () => ({
      productVersion: '0.1.0-alpha.1',
      sourceCommit: 'abc',
      runtime: { sha256: 'a'.repeat(64) },
      extension: { id: 'extension-id', version: '1.0.0' },
    }),
    installRuntime: async () => ({ version: '0.1.0-alpha.1' }),
    installExtension: async () => ({ unpacked: '/tmp/extension' }),
    installCodex: async () => ({ changed: true, changes: ['plugin-installed'] }),
    installBuiltinMacros: async () => {},
    installLauncher: async () => ({
      action: 'installed',
      path: '/home/test/.local/bin/fast-browser',
    }),
    prepareRoutingTransition: async (input) => {
      routingInput = input;
      return {
        nextState: { profile: 'safe', files: [], blocks: [] },
        apply: async () => ({ rollback: async () => {} }),
      };
    },
    saveConfig: async () => {},
    doctor: async () => ({ schemaVersion: 1, ok: true, checks: [] }),
    loadConfig: async () => null,
    paths: {
      homeDir: '/home/test',
      dataDir: '/home/test/.fast-browser',
      configFile: '/home/test/.fast-browser/config.json',
    },
    interactive: true,
  });

  assert.deepEqual(routingInput.hosts, ['codex']);
  assert.equal(routingInput.codexVersion, 'codex-cli 0.145.0');
});

test('setup removes a prior Codex host without probing its unavailable version', async () => {
  let routingInput;
  const current = {
    ...migrationConfig(),
    profile: 'full',
    hosts: { claude: false, codex: true },
    sessions: { enabled: true, retentionDays: 30 },
  };
  const report = await setup(request({ hosts: ['claude'], profile: 'full' }), {
    checkPlatform: async () => {},
    detectHosts: async () => ['claude'],
    getCodexVersion: async () => {
      throw new Error('stale prior-host Codex probe');
    },
    ensureDataDirs: async () => {},
    loadRuntimeLock: async () => ({
      productVersion: '0.1.0-alpha.1',
      sourceCommit: 'abc',
      runtime: { sha256: 'a'.repeat(64) },
      extension: { id: 'extension-id', version: '1.0.0' },
    }),
    installRuntime: async () => ({ version: '0.1.0-alpha.1' }),
    installExtension: async () => ({ unpacked: '/tmp/extension' }),
    installClaude: async () => ({ changed: false, changes: [] }),
    installBuiltinMacros: async () => {},
    installLauncher: async () => ({
      action: 'installed',
      path: '/home/test/.local/bin/fast-browser',
    }),
    prepareRoutingTransition: async (input) => {
      routingInput = input;
      return {
        nextState: { profile: 'full', files: [], blocks: [] },
        apply: async () => ({ rollback: async () => {} }),
      };
    },
    saveConfig: async () => {},
    pruneSessions: async () => ({ removedPaths: [], removedBytes: 0 }),
    doctor: async () => ({ schemaVersion: 1, ok: true, checks: [] }),
    loadConfig: async () => current,
    paths: {
      homeDir: '/home/test',
      dataDir: '/home/test/.fast-browser',
      configFile: '/home/test/.fast-browser/config.json',
    },
    interactive: true,
  });

  assert.deepEqual(report.hosts, ['claude']);
  assert.equal(routingInput.codexVersion, '');
});

// The same defect class `configure` was fixed for: a command that does not
// ask about a setting must not reset it. The reinstall branch rebuilds config
// from defaultConfig(), so before this it dropped a chosen palette on any
// rerun that changed the profile or the host set, and the next `annotate`
// refused with "no annotation palette is configured". performLockUpgrade
// spreads `...current` and does preserve it, so which repair branch a rerun
// happened to take decided whether the user kept their choice.
test('a reinstalling setup preserves the configured annotation palette', async () => {
  const current = {
    ...migrationConfig(),
    hosts: { claude: true, codex: false },
    annotation: { palette: 'violet' },
  };
  let savedConfig;
  const report = await setup(request({ hosts: ['claude'], profile: 'full' }), {
    checkPlatform: async () => {},
    detectHosts: async () => ['claude'],
    ensureDataDirs: async () => {},
    loadRuntimeLock: async () => ({
      productVersion: '0.1.0-alpha.1',
      sourceCommit: 'abc',
      runtime: { sha256: 'a'.repeat(64) },
      extension: { id: 'extension-id', version: '1.0.0' },
    }),
    installRuntime: async () => ({ version: '0.1.0-alpha.1' }),
    installExtension: async () => ({ unpacked: '/tmp/extension' }),
    installClaude: async () => ({ changed: false, changes: [] }),
    installBuiltinMacros: async () => {},
    installLauncher: async () => ({
      action: 'installed',
      path: '/home/test/.local/bin/fast-browser',
    }),
    prepareRoutingTransition: async () => ({
      nextState: { profile: 'full', files: [], blocks: [] },
      apply: async () => ({ rollback: async () => {} }),
    }),
    saveConfig: async (_paths, config) => {
      savedConfig = config;
    },
    pruneSessions: async () => ({ removedPaths: [], removedBytes: 0 }),
    doctor: async () => ({ schemaVersion: 1, ok: true, checks: [] }),
    loadConfig: async () => current,
    paths: {
      homeDir: '/home/test',
      dataDir: '/home/test/.fast-browser',
      configFile: '/home/test/.fast-browser/config.json',
    },
    interactive: true,
  });

  assert.equal(report.changed, true, 'the profile changed, so this is the reinstall branch');
  assert.equal(savedConfig.annotation.palette, 'violet');
  assert.equal(report.config.annotation.palette, 'violet');
});

// Shared fixture for the rewrite-contract tests below: everything stubbed the
// way the palette test above stubs it, with only the current config and the
// request varying per test.
function reinstallDeps({ current, onSave }) {
  return {
    checkPlatform: async () => {},
    detectHosts: async () => ['claude', 'codex'],
    ensureDataDirs: async () => {},
    loadRuntimeLock: async () => ({
      productVersion: '0.1.0-alpha.1',
      sourceCommit: 'abc',
      runtime: { sha256: 'a'.repeat(64) },
      extension: { id: 'extension-id', version: '1.0.0' },
    }),
    installRuntime: async () => ({ version: '0.1.0-alpha.1' }),
    installExtension: async () => ({ unpacked: '/tmp/extension' }),
    installClaude: async () => ({ changed: false, changes: [] }),
    installCodex: async () => ({ changed: false, changes: [] }),
    getCodexVersion: async () => '0.99.0',
    installBuiltinMacros: async () => {},
    installLauncher: async () => ({
      action: 'installed',
      path: '/home/test/.local/bin/fast-browser',
    }),
    prepareRoutingTransition: async () => ({
      nextState: { profile: 'full', files: [], blocks: [] },
      apply: async () => ({ rollback: async () => {} }),
    }),
    saveConfig: async (_paths, config) => onSave(config),
    pruneSessions: async () => ({ removedPaths: [], removedBytes: 0 }),
    doctor: async () => ({ schemaVersion: 1, ok: true, checks: [] }),
    loadConfig: async () => current,
    paths: {
      homeDir: '/home/test',
      dataDir: '/home/test/.fast-browser',
      configFile: '/home/test/.fast-browser/config.json',
    },
    interactive: true,
  };
}

// The rewrite contract, pinned as a set: setup's reinstall branch may rewrite
// exactly these config fields and must carry every other one by construction.
// The key-set assertion is the structural half: a field added to
// defaultConfig() tomorrow fails HERE first, forcing its author to classify
// it as carried or rewritten instead of finding out one shipped release
// later, which is how sessions, the palette, the connection mode, and the
// profile itself were each lost in turn.
test('the reinstall branch rewrites its declared fields and carries everything else', async () => {
  // `registry` is REWRITTEN, not CARRIED wholesale -- see the dedicated
  // assertion below this loop: `url`/`publicKey` carry through exactly
  // like every other CARRIED field, but `assumeYes` is forced back to
  // `false` every reinstall (WS4b Task 7 review fix round 1 ruling: a
  // reinstall is a re-consent point for the standing `--yes` bypass bit).
  const REWRITTEN = ['schemaVersion', 'productVersion', 'profile', 'hosts', 'sessions', 'runtime', 'managed', 'registry'];
  const CARRIED = {
    connection: { mode: 'auto' },
    annotation: { palette: 'crimson' },
    video: { width: 1024, height: 768 },
    trace: false,
    // WS3b Task 7: config.encoder is a `configure` choice, same as trace/
    // annotation/video/connection above -- setup's reinstall branch has no
    // flag for it and no claim on it, so a reinstall must carry it through
    // unchanged. A non-default value ('voyage', not 'lexical') proves it
    // was actually carried, not just coincidentally still the default.
    encoder: 'voyage',
  };
  assert.deepEqual(
    Object.keys(defaultConfig()).sort(),
    [...REWRITTEN, ...Object.keys(CARRIED)].sort(),
    'a new config field must be classified as rewritten or carried in this test',
  );

  const current = {
    ...migrationConfig(),
    profile: 'full',
    hosts: { claude: true, codex: false },
    sessions: { enabled: false, retentionDays: 90 },
    ...CARRIED,
    // A pinned registry with assumeYes ALREADY true -- proves both halves
    // of the split behavior below: url/publicKey survive, assumeYes does
    // not, regardless of what it held going in.
    registry: { url: 'https://registry.example.com', publicKey: 'a-pinned-key', assumeYes: true },
  };
  let savedConfig;
  await setup(
    request({ hosts: ['claude', 'codex'], profile: 'full' }),
    reinstallDeps({ current, onSave: (config) => { savedConfig = config; } }),
  );

  for (const [key, value] of Object.entries(CARRIED)) {
    assert.deepEqual(savedConfig[key], value, `${key} is a configure choice setup has no claim on`);
  }
  assert.deepEqual(
    savedConfig.registry,
    { url: 'https://registry.example.com', publicKey: 'a-pinned-key', assumeYes: false },
    'registry.url/registry.publicKey carry through a reinstall, but registry.assumeYes always resets '
      + '(a reinstall is a re-consent point for the standing --yes bypass bit)',
  );
  assert.deepEqual(
    savedConfig.sessions,
    { enabled: false, retentionDays: 90 },
    'an unchanged profile carries the user session settings too',
  );
});

// The fourth instance of the class, live on 2026-07-30: a routine
// `setup --host both` with no --profile downgraded a full-profile machine to
// safe, and with it reset the session settings keyed on the profile. Omitted
// means keep, on any machine that has a profile to keep.
test('setup without --profile keeps the configured profile on a reinstall', async () => {
  const current = {
    ...migrationConfig(),
    profile: 'full',
    hosts: { claude: true, codex: false },
    sessions: { enabled: true, retentionDays: 90 },
  };
  let savedConfig;
  const report = await setup(
    request({ hosts: ['claude', 'codex'], profile: undefined }),
    reinstallDeps({ current, onSave: (config) => { savedConfig = config; } }),
  );

  assert.equal(savedConfig.profile, 'full');
  assert.deepEqual(savedConfig.sessions, { enabled: true, retentionDays: 90 });
  assert.equal(report.previousProfile, undefined, 'nothing changed, nothing to announce');
});

// Resetting sessions on a GENUINE profile change is correct and must
// survive any structural carry; what was missing is the announcement.
test('a genuine profile change resets sessions to the new defaults and says so', async () => {
  const current = {
    ...migrationConfig(),
    profile: 'full',
    hosts: { claude: true, codex: true },
    sessions: { enabled: true, retentionDays: 90 },
  };
  let savedConfig;
  const report = await setup(
    request({ hosts: ['claude', 'codex'], profile: 'safe' }),
    reinstallDeps({ current, onSave: (config) => { savedConfig = config; } }),
  );

  assert.equal(savedConfig.profile, 'safe');
  assert.deepEqual(
    savedConfig.sessions,
    { enabled: false, retentionDays: 30 },
    'the new profile defines the session defaults',
  );
  assert.equal(report.previousProfile, 'full');
});

test('a first-ever setup leaves the annotation palette unchosen', async () => {
  let savedConfig;
  await setup(request({ hosts: ['claude'], profile: 'safe' }), {
    checkPlatform: async () => {},
    detectHosts: async () => ['claude'],
    ensureDataDirs: async () => {},
    loadRuntimeLock: async () => ({
      productVersion: '0.1.0-alpha.1',
      sourceCommit: 'abc',
      runtime: { sha256: 'a'.repeat(64) },
      extension: { id: 'extension-id', version: '1.0.0' },
    }),
    installRuntime: async () => ({ version: '0.1.0-alpha.1' }),
    installExtension: async () => ({ unpacked: '/tmp/extension' }),
    installClaude: async () => ({ changed: false, changes: [] }),
    installBuiltinMacros: async () => {},
    installLauncher: async () => ({
      action: 'installed',
      path: '/home/test/.local/bin/fast-browser',
    }),
    prepareRoutingTransition: async () => ({
      nextState: { profile: 'safe', files: [], blocks: [] },
      apply: async () => ({ rollback: async () => {} }),
    }),
    saveConfig: async (_paths, config) => {
      savedConfig = config;
    },
    doctor: async () => ({ schemaVersion: 1, ok: true, checks: [] }),
    loadConfig: async () => null,
    paths: {
      homeDir: '/home/test',
      dataDir: '/home/test/.fast-browser',
      configFile: '/home/test/.fast-browser/config.json',
    },
    interactive: true,
  });

  // Preserving a prior choice must not become inventing one: with no config
  // to carry forward, the palette stays null so `annotate` still asks.
  assert.equal(savedConfig.annotation.palette, null);
});

// The palette tests above spell out every dependency; the carry-forward tests
// below vary only in the stored config, the requested hosts, and the requested
// profile, so they share one stub set. Both hosts are always detected so a
// host-set change can drive the reinstall branch without a profile change.
function reinstallingSetup({ current, hosts, profile, saveConfig, pruneSessions }) {
  return setup(request({ hosts, profile }), {
    checkPlatform: async () => {},
    detectHosts: async () => ['claude', 'codex'],
    ensureDataDirs: async () => {},
    loadRuntimeLock: async () => ({
      productVersion: '0.1.0-alpha.1',
      sourceCommit: 'abc',
      runtime: { sha256: 'a'.repeat(64) },
      extension: { id: 'extension-id', version: '1.0.0' },
    }),
    installRuntime: async () => ({ version: '0.1.0-alpha.1' }),
    installExtension: async () => ({ unpacked: '/tmp/extension' }),
    installClaude: async () => ({ changed: false, changes: [] }),
    installCodex: async () => ({ changed: false, changes: [] }),
    installBuiltinMacros: async () => {},
    installLauncher: async () => ({
      action: 'installed',
      path: '/home/test/.local/bin/fast-browser',
    }),
    prepareRoutingTransition: async () => ({
      nextState: { profile, files: [], blocks: [] },
      apply: async () => ({ rollback: async () => {} }),
    }),
    saveConfig: async (_paths, config) => {
      if (saveConfig) saveConfig(config);
    },
    pruneSessions: pruneSessions ?? (async () => ({ removedPaths: [], removedBytes: 0 })),
    doctor: async () => ({ schemaVersion: 1, ok: true, checks: [] }),
    loadConfig: async () => current,
    paths: {
      homeDir: '/home/test',
      dataDir: '/home/test/.fast-browser',
      configFile: '/home/test/.fast-browser/config.json',
    },
    interactive: true,
  });
}

// Same defect class as the palette above, but this one is a privacy setting:
// adding a host re-enters the reinstall branch with the profile unchanged, so
// rebuilding sessions from profileDefaults would silently switch recording
// back on for a user who ran `configure --no-record-sessions` and shorten the
// retention window they chose.
test('a reinstalling setup preserves session settings when the profile is unchanged', async () => {
  const current = {
    ...migrationConfig(),
    profile: 'full',
    hosts: { claude: true, codex: false },
    sessions: { enabled: false, retentionDays: 90 },
  };
  let savedConfig;
  let pruned = false;
  const report = await reinstallingSetup({
    current,
    hosts: ['claude', 'codex'],
    profile: 'full',
    saveConfig: (config) => { savedConfig = config; },
    pruneSessions: async () => {
      pruned = true;
      return { removedPaths: [], removedBytes: 0 };
    },
  });

  assert.equal(report.changed, true, 'the host set changed, so this is the reinstall branch');
  assert.deepEqual(savedConfig.sessions, { enabled: false, retentionDays: 90 });
  assert.deepEqual(report.config.sessions, { enabled: false, retentionDays: 90 });
  assert.equal(pruned, false, 'recording is off, so nothing may be pruned');
});

// Retention reads the same carried value the config write does. Pruning with
// the profile default instead would delete the sessions between day 30 and
// day 90 that the user widened the window to keep.
test('a reinstalling setup prunes with the preserved retention window', async () => {
  const current = {
    ...migrationConfig(),
    profile: 'full',
    hosts: { claude: true, codex: false },
    sessions: { enabled: true, retentionDays: 120 },
  };
  const pruneWindows = [];
  const report = await reinstallingSetup({
    current,
    hosts: ['claude', 'codex'],
    profile: 'full',
    pruneSessions: async ({ retentionDays }) => {
      pruneWindows.push(retentionDays);
      return { removedPaths: [], removedBytes: 0 };
    },
  });

  assert.equal(report.changed, true, 'the host set changed, so this is the reinstall branch');
  assert.deepEqual(pruneWindows, [120]);
});

// The nuance the carry must keep: the profile is what defines these defaults,
// so a genuine profile change is the one case where resetting them is right.
test('a setup that changes the profile adopts the new profile session defaults', async () => {
  const current = {
    ...migrationConfig(),
    profile: 'safe',
    hosts: { claude: true, codex: false },
    sessions: { enabled: false, retentionDays: 90 },
  };
  let savedConfig;
  const report = await reinstallingSetup({
    current,
    hosts: ['claude'],
    profile: 'full',
    saveConfig: (config) => { savedConfig = config; },
  });

  assert.equal(report.changed, true, 'the profile changed, so this is the reinstall branch');
  assert.deepEqual(savedConfig.sessions, { enabled: true, retentionDays: 30 });
});

test('a first-ever setup writes the profile session defaults', async () => {
  let savedConfig;
  await reinstallingSetup({
    current: null,
    hosts: ['claude'],
    profile: 'full',
    saveConfig: (config) => { savedConfig = config; },
  });

  assert.deepEqual(savedConfig.sessions, { enabled: true, retentionDays: 30 });
});

// Automatic connection is a pairing choice `setup` has no flag for and the
// Keychain token outlives it, so resetting the mode to manual would leave the
// token in place while auto-connect silently stopped. doctor's pairing check
// passes for any non-auto mode, so nothing would report it.
test('a reinstalling setup preserves automatic connection', async () => {
  const current = {
    ...migrationConfig(),
    profile: 'full',
    hosts: { claude: true, codex: false },
    connection: { mode: 'auto' },
  };
  let savedConfig;
  const report = await reinstallingSetup({
    current,
    hosts: ['claude', 'codex'],
    profile: 'full',
    saveConfig: (config) => { savedConfig = config; },
  });

  assert.equal(report.changed, true, 'the host set changed, so this is the reinstall branch');
  assert.equal(savedConfig.connection.mode, 'auto');
  assert.equal(report.config.connection.mode, 'auto');
});

// Unlike sessions, the connection mode is not derived from the profile, so
// even a genuine profile change has no claim on it.
test('a setup that changes the profile still preserves automatic connection', async () => {
  const current = {
    ...migrationConfig(),
    profile: 'safe',
    hosts: { claude: true, codex: false },
    connection: { mode: 'auto' },
  };
  let savedConfig;
  const report = await reinstallingSetup({
    current,
    hosts: ['claude'],
    profile: 'full',
    saveConfig: (config) => { savedConfig = config; },
  });

  assert.equal(report.changed, true, 'the profile changed, so this is the reinstall branch');
  assert.equal(savedConfig.connection.mode, 'auto');
});

test('a first-ever setup defaults the connection to manual', async () => {
  let savedConfig;
  await reinstallingSetup({
    current: null,
    hosts: ['claude'],
    profile: 'safe',
    saveConfig: (config) => { savedConfig = config; },
  });

  // Carrying a prior pairing must not become inventing one: with no config to
  // carry forward there is no Keychain token either.
  assert.equal(savedConfig.connection.mode, 'manual');
});

// Same defect class as the palette and connection carries above: the video
// capture size is chosen through `configure --video`, setup has no flag for
// it, and the reinstall branch rebuilds the config from defaultConfig(), so
// an explicit carry is the only thing keeping recording enabled across a
// rerun that adds a host or repairs drift.
test('a reinstalling setup preserves the configured video size', async () => {
  const current = {
    ...migrationConfig(),
    profile: 'full',
    hosts: { claude: true, codex: false },
    video: { width: 1280, height: 720 },
  };
  let savedConfig;
  const report = await reinstallingSetup({
    current,
    hosts: ['claude', 'codex'],
    profile: 'full',
    saveConfig: (config) => { savedConfig = config; },
  });

  assert.equal(report.changed, true, 'the host set changed, so this is the reinstall branch');
  assert.deepEqual(savedConfig.video, { width: 1280, height: 720 });
  assert.deepEqual(report.config.video, { width: 1280, height: 720 });
});

// Unlike sessions, the video size is not derived from the profile, so even a
// genuine profile change has no claim on it.
test('a setup that changes the profile still preserves the video size', async () => {
  const current = {
    ...migrationConfig(),
    profile: 'safe',
    hosts: { claude: true, codex: false },
    video: { width: 800, height: 600 },
  };
  let savedConfig;
  const report = await reinstallingSetup({
    current,
    hosts: ['claude'],
    profile: 'full',
    saveConfig: (config) => { savedConfig = config; },
  });

  assert.equal(report.changed, true, 'the profile changed, so this is the reinstall branch');
  assert.deepEqual(savedConfig.video, { width: 800, height: 600 });
});

test('a first-ever setup leaves video recording off', async () => {
  let savedConfig;
  await reinstallingSetup({
    current: null,
    hosts: ['claude'],
    profile: 'full',
    saveConfig: (config) => { savedConfig = config; },
  });

  assert.equal(savedConfig.video, null);
});

test('second matching setup is a true mutation no-op', async () => {
  const events = [];
  const current = {
    schemaVersion: 1,
    productVersion: '0.1.0-alpha.1',
    profile: 'safe',
    hosts: { claude: true, codex: false },
    connection: { mode: 'manual' },
    sessions: { enabled: false, retentionDays: 30 },
    runtime: { version: null, sha256: null, sourceCommit: null },
    managed: { files: [], blocks: [] },
  };
  const report = await setup(request({ hosts: ['claude'], profile: 'safe' }), {
    checkPlatform: async () => events.push('check-platform'),
    detectHosts: async () => {
      events.push('detect-hosts');
      return ['claude'];
    },
    loadConfig: async () => current,
    isSetupCurrent: async () => true,
    doctor: async () => {
      events.push('doctor');
      return { schemaVersion: 1, ok: true, checks: [] };
    },
    ensureDataDirs: async () => events.push('mutation'),
    // Setup consults the built-ins on this path now, so `paths: {}` alone no
    // longer reaches the return. The real installer is exercised against real
    // fixtures in setup-macro-refresh.test.mjs; here it is stubbed inert
    // because this test is about setup performing no mutation of its own, and
    // an installer reporting nothing installed and nothing refreshed is
    // exactly the "no writes" input that keeps `changed` false.
    installBuiltinMacros: async () => ({ installed: [], refreshed: [], preserved: [] }),
    // Current for the same reason: an up-to-date shim is not rewritten, which
    // is what keeps this rerun a genuine no-op with `changed: false`.
    installLauncher: async () => ({ action: 'current', path: '/home/test/.local/bin/fast-browser' }),
    paths: {},
  });
  assert.deepEqual(events, ['check-platform', 'detect-hosts', 'doctor']);
  assert.equal(report.changed, false);
});

test('matching setup is a no-op without a test-only current-state hook', async () => {
  const events = [];
  const current = {
    schemaVersion: 1,
    productVersion: '0.1.0-alpha.1',
    profile: 'safe',
    hosts: { claude: true, codex: false },
    connection: { mode: 'manual' },
    sessions: { enabled: false, retentionDays: 30 },
    runtime: { version: null, sha256: null, sourceCommit: null },
    managed: { files: [], blocks: [] },
  };
  const report = await setup(request({ hosts: ['claude'], profile: 'safe' }), {
    checkPlatform: async () => {},
    detectHosts: async () => ['claude'],
    loadConfig: async () => current,
    doctor: async () => ({ schemaVersion: 1, ok: true, checks: [] }),
    ensureDataDirs: async () => events.push('mutation'),
    // Inert for the same reason as the test above: nothing installed and
    // nothing refreshed is the input under which this path must still report
    // no mutation and `changed: false`.
    installBuiltinMacros: async () => ({ installed: [], refreshed: [], preserved: [] }),
    // Current for the same reason: an up-to-date shim is not rewritten, which
    // is what keeps this rerun a genuine no-op with `changed: false`.
    installLauncher: async () => ({ action: 'current', path: '/home/test/.local/bin/fast-browser' }),
    paths: {},
  });
  assert.deepEqual(events, []);
  assert.equal(report.changed, false);
});

test('matching setup reports doctor or current-state drift instead of claiming configured', async () => {
  const current = {
    schemaVersion: 1,
    productVersion: '0.1.0-alpha.1',
    profile: 'safe',
    hosts: { claude: true, codex: false },
    connection: { mode: 'manual' },
    sessions: { enabled: false, retentionDays: 30 },
    runtime: { version: null, sha256: null, sourceCommit: null },
    managed: { files: [], blocks: [] },
  };
  for (const fixture of [
    {
      doctor: { schemaVersion: 1, ok: false, checks: [{ id: 'runtime-checksum', status: 'fail' }] },
      isSetupCurrent: async () => true,
    },
    {
      doctor: { schemaVersion: 1, ok: true, checks: [] },
      isSetupCurrent: async () => false,
    },
  ]) {
    const events = [];
    await assert.rejects(
      setup(request({ hosts: ['claude'], profile: 'safe' }), {
        checkPlatform: async () => {},
        detectHosts: async () => ['claude'],
        loadConfig: async () => current,
        doctor: async () => fixture.doctor,
        isSetupCurrent: fixture.isSetupCurrent,
        ensureDataDirs: async () => events.push('repair'),
        paths: {},
      }),
      (error) => {
        assert.equal(error.stage, 'setup-drift');
        assert.doesNotMatch(error.message, /already configured|extension configured/i);
        return true;
      },
    );
    assert.deepEqual(events, []);
  }
});

test('setup uses the exact routing receipt when config persistence fails', async () => {
  const events = [];
  const routing = { profile: 'full', files: [], blocks: [] };
  await assert.rejects(
    setup(request({ hosts: ['claude'] }), {
      checkPlatform: async () => {},
      detectHosts: async () => ['claude'],
      ensureDataDirs: async () => {},
      loadRuntimeLock: async () => ({
        productVersion: '0.1.0-alpha.1',
        sourceCommit: 'abc',
        runtime: { sha256: 'a'.repeat(64) },
        extension: { id: 'extension-id', version: '1.0.0' },
      }),
      installRuntime: async () => ({ version: '0.1.0-alpha.1' }),
      installExtension: async () => ({ unpacked: '/tmp/extension' }),
      installClaude: async () => ({ host: 'claude', changed: true }),
      installBuiltinMacros: async () => {},
      installLauncher: async () => ({
        action: 'installed',
        path: '/home/test/.local/bin/fast-browser',
      }),
      prepareRoutingTransition: async () => {
        events.push('routing:prepare');
        return {
          nextState: routing,
          apply: async () => {
            events.push('routing:apply');
            return { rollback: async () => events.push('routing:rollback') };
          },
        };
      },
      installRouting: async () => {
        events.push('routing:obsolete-render');
        return routing;
      },
      saveConfig: async () => {
        events.push('save');
        throw new Error('disk failure');
      },
      pruneSessions: async () => events.push('prune'),
      removeRouting: async () => events.push('routing:obsolete-remove'),
      loadConfig: async () => null,
      paths: {},
      interactive: true,
    }),
    /save config/i,
  );
  assert.deepEqual(events, [
    'routing:prepare',
    'routing:apply',
    'save',
    'routing:rollback',
  ]);
});

test('post-routing config validation restores exact routing before host cleanup', async (t) => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'fast-browser-setup-config-validation-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const paths = resolvePaths({
    homeDir,
    pluginRoot: path.resolve(import.meta.dirname, '../..'),
  });
  const codexDir = path.join(homeDir, '.codex');
  const codexConfig = path.join(codexDir, 'config.toml');
  const codexAgents = path.join(codexDir, 'AGENTS.md');
  const priorConfig = 'model = "gpt-5.4"\n';
  const priorAgents = '# User instructions\n';
  await mkdir(codexDir, { recursive: true });
  await Promise.all([
    writeFile(codexConfig, priorConfig, { mode: 0o600 }),
    writeFile(codexAgents, priorAgents, { mode: 0o600 }),
  ]);

  const events = [];
  const error = await setup(request(), {
    checkPlatform: async () => {},
    detectHosts: async () => ['claude', 'codex'],
    getCodexVersion: async () => 'codex-cli 0.145.0',
    loadRuntimeLock: async () => ({
      productVersion: '0.1.0-alpha.1',
      sourceCommit: undefined,
      runtime: { sha256: 'a'.repeat(64) },
      extension: { id: 'extension-id', version: '1.0.0' },
    }),
    installRuntime: async () => ({ version: '0.1.0-alpha.1' }),
    installExtension: async () => ({ unpacked: '/tmp/extension' }),
    installClaude: async () => ({
      host: 'claude',
      changed: true,
      changes: ['plugin-installed'],
    }),
    installCodex: async () => ({
      host: 'codex',
      changed: true,
      changes: ['plugin-installed'],
    }),
    uninstallCodex: async () => events.push('cleanup-codex'),
    uninstallClaude: async () => events.push('cleanup-claude'),
    installBuiltinMacros: async () => {},
    installLauncher: async () => ({
      action: 'installed',
      path: '/home/test/.local/bin/fast-browser',
    }),
    prepareRoutingTransition: async (input) => {
      const prepared = await prepareRoutingTransition(input);
      return {
        nextState: prepared.nextState,
        apply: async () => {
          events.push('routing:apply');
          const receipt = await prepared.apply();
          return {
            rollback: async () => {
              events.push('routing:rollback');
              await receipt.rollback();
            },
          };
        },
      };
    },
    saveConfig: async () => events.push('save-config'),
    loadConfig: async () => null,
    paths,
    interactive: true,
  }).then(
    () => null,
    (setupError) => setupError,
  );

  assert.equal(error.name, 'LifecycleError');
  assert.equal(error.stage, 'save-config');
  assert.equal(error.message, 'Setup could not save config; routing was rolled back.');
  assert.deepEqual(events, [
    'routing:apply',
    'routing:rollback',
    'cleanup-codex',
    'cleanup-claude',
  ]);
  assert.equal(await readFile(codexConfig, 'utf8'), priorConfig);
  assert.equal(await readFile(codexAgents, 'utf8'), priorAgents);
  await Promise.all([
    access(path.join(homeDir, '.claude', 'rules', 'fast-browser-routing.md')),
    access(path.join(homeDir, '.claude', 'rules', 'fast-browser-verification-consent.md')),
    access(path.join(homeDir, '.codex', 'agents', 'browser_driver.toml')),
  ].map((operation) => assert.rejects(operation, { code: 'ENOENT' })));
});

test('setup maps a routing recovery-required apply failure to its fixed recovery result', async () => {
  let saves = 0;

  await assert.rejects(
    setup(request({ hosts: ['claude'], profile: 'full' }), {
      checkPlatform: async () => {},
      detectHosts: async () => ['claude'],
      ensureDataDirs: async () => {},
      loadRuntimeLock: async () => ({
        productVersion: '0.1.0-alpha.1',
        sourceCommit: 'abc',
        runtime: { sha256: 'a'.repeat(64) },
        extension: { id: 'extension-id', version: '1.0.0' },
      }),
      installRuntime: async () => ({ version: '0.1.0-alpha.1' }),
      installExtension: async () => ({ unpacked: '/tmp/extension' }),
      installClaude: async () => ({ host: 'claude', changed: false, changes: [] }),
      installBuiltinMacros: async () => {},
      installLauncher: async () => ({
        action: 'installed',
        path: '/home/test/.local/bin/fast-browser',
      }),
      prepareRoutingTransition: async () => ({
        nextState: { profile: 'full', files: [], blocks: [] },
        apply: async () => {
          throw new RoutingTransactionError(
            'routing transaction recovery required',
            ROUTING_TRANSACTION_RECOVERY_REQUIRED,
          );
        },
      }),
      saveConfig: async () => {
        saves += 1;
      },
      loadConfig: async () => null,
      paths: {},
      interactive: true,
    }),
    (error) => {
      assert.equal(error.name, 'LifecycleError');
      assert.equal(error.stage, 'save-config');
      assert.equal(
        error.message,
        'Setup could not save config; installed routing requires recovery.',
      );
      assert.equal(error.code, 'ROUTING_TRANSACTION_RECOVERY_REQUIRED');
      assert.equal(error.partialState, null);
      return true;
    },
  );

  assert.equal(saves, 0);
});

test('setup preserves external routing drift and redacts exact prior receipt state', async (t) => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'fast-browser-setup-receipt-drift-'));
  const paths = resolvePaths({ homeDir, pluginRoot: path.resolve(import.meta.dirname, '../..') });
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  await mkdir(paths.dataDir, { recursive: true, mode: 0o700 });
  const routingPath = path.join(paths.homeDir, '.claude', 'rules', 'fast-browser-routing.md');
  let preparations = 0;

  await assert.rejects(
    setup(request({ hosts: ['claude'] }), {
      paths,
      interactive: true,
      checkPlatform: async () => {},
      detectHosts: async () => ['claude'],
      ensureDataDirs: async () => {},
      loadRuntimeLock: async () => ({
        productVersion: '0.1.0-alpha.1',
        sourceCommit: 'abc',
        runtime: { sha256: 'a'.repeat(64) },
        extension: { id: 'extension-id', version: '1.0.0' },
      }),
      installRuntime: async () => ({ version: '0.1.0-alpha.1' }),
      installExtension: async () => ({ unpacked: '/tmp/extension' }),
      installClaude: async () => ({ host: 'claude', changed: false, changes: [] }),
      installBuiltinMacros: async () => {},
      installLauncher: async () => ({
        action: 'installed',
        path: '/home/test/.local/bin/fast-browser',
      }),
      prepareRoutingTransition: async (options) => {
        preparations += 1;
        return prepareRoutingTransition(options);
      },
      saveConfig: async () => {
        await writeFile(routingPath, 'external routing drift\n', { mode: 0o600 });
        throw new Error('injected config persistence failure');
      },
      loadConfig: async () => null,
    }),
    (error) => {
      assert.equal(error.stage, 'save-config');
      assert.equal(error.partialState, null);
      assert.doesNotMatch(JSON.stringify(error), /fast-browser-routing|external routing drift/);
      return true;
    },
  );

  assert.equal(preparations, 1);
  assert.equal(await readFile(routingPath, 'utf8'), 'external routing drift\n');
});

test('setup restores prior routing after config persistence failure', async (t) => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'fast-browser-setup-rollback-'));
  const paths = resolvePaths({ homeDir, pluginRoot: path.resolve(import.meta.dirname, '../..') });
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  await mkdir(paths.dataDir, { recursive: true, mode: 0o700 });

  const priorRouting = await installRouting({
    profile: 'full',
    hosts: ['claude'],
    paths,
  });
  const previousConfig = {
    ...migrationConfig(),
    profile: 'full',
    hosts: { claude: true, codex: false },
    sessions: { enabled: true, retentionDays: 30 },
    managed: { files: priorRouting.files, blocks: priorRouting.blocks },
  };
  await writeFile(paths.configFile, `${JSON.stringify(previousConfig)}\n`, { mode: 0o600 });

  const priorClaudeRule = path.join(paths.homeDir, '.claude', 'rules', 'fast-browser-routing.md');
  const priorClaudeConsent = path.join(
    paths.homeDir,
    '.claude',
    'rules',
    'fast-browser-verification-consent.md',
  );
  const codexAgent = path.join(paths.homeDir, '.codex', 'agents', 'browser_driver.toml');
  const priorRuleBytes = await readFile(priorClaudeRule, 'utf8');
  const priorConsentBytes = await readFile(priorClaudeConsent, 'utf8');
  const priorOwnershipSummary = await preflightRoutingRemoval({
    paths,
    managedState: { profile: previousConfig.profile, ...previousConfig.managed },
  });

  const operation = setup(request({ hosts: ['codex'], profile: 'full' }), {
    paths,
    interactive: true,
    checkPlatform: async () => {},
    detectHosts: async () => ['codex'],
    ensureDataDirs: async () => {},
    loadRuntimeLock: async () => ({
      productVersion: '0.1.0-alpha.1',
      sourceCommit: 'abc',
      runtime: { sha256: 'a'.repeat(64) },
      extension: { id: 'extension-id', version: '1.0.0' },
    }),
    installRuntime: async () => ({ version: '0.1.0-alpha.1' }),
    installExtension: async () => ({ unpacked: '/tmp/extension' }),
    installCodex: async () => ({ host: 'codex', changed: false, changes: [] }),
    installBuiltinMacros: async () => {},
    installLauncher: async () => ({
      action: 'installed',
      path: '/home/test/.local/bin/fast-browser',
    }),
    getCodexVersion: async () => 'codex-cli 0.145.0',
    saveConfig: async () => {
      throw new Error('injected config persistence failure');
    },
  });

  await assert.rejects(operation, ({ stage }) => stage === 'save-config');
  assert.equal(await readFile(priorClaudeRule, 'utf8'), priorRuleBytes);
  assert.equal(await readFile(priorClaudeConsent, 'utf8'), priorConsentBytes);
  assert.deepEqual(await preflightRoutingRemoval({
    paths,
    managedState: { profile: previousConfig.profile, ...previousConfig.managed },
  }), priorOwnershipSummary);
  await assert.rejects(access(codexAgent), { code: 'ENOENT' });
});

test('setup restores the exact prior Codex routing container when an override appears', async (t) => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'fast-browser-setup-layout-'));
  const paths = resolvePaths({ homeDir, pluginRoot: path.resolve(import.meta.dirname, '../..') });
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  await mkdir(paths.dataDir, { recursive: true, mode: 0o700 });

  const codexDir = path.join(paths.homeDir, '.codex');
  const codexAgents = path.join(codexDir, 'AGENTS.md');
  const codexOverride = path.join(codexDir, 'AGENTS.override.md');
  await mkdir(codexDir, { recursive: true, mode: 0o700 });
  await writeFile(codexAgents, 'unrelated original agent instructions\n');
  const priorRouting = await installRouting({
    profile: 'full',
    hosts: ['codex'],
    paths,
    codexVersion: 'codex-cli 0.145.0',
  });
  const previousConfig = {
    ...migrationConfig(),
    profile: 'full',
    hosts: { claude: false, codex: true },
    sessions: { enabled: true, retentionDays: 30 },
    managed: { files: priorRouting.files, blocks: priorRouting.blocks },
  };
  const previousConfigBytes = `${JSON.stringify(previousConfig, null, 2)}\n`;
  await writeFile(paths.configFile, previousConfigBytes, { mode: 0o600 });
  const priorAgentsBytes = await readFile(codexAgents, 'utf8');
  const priorOwnershipSummary = await preflightRoutingRemoval({
    paths,
    managedState: { profile: previousConfig.profile, ...previousConfig.managed },
  });

  const unrelatedOverrideBytes = 'unrelated higher-precedence instructions\n';
  await writeFile(codexOverride, unrelatedOverrideBytes, { mode: 0o600 });

  await assert.rejects(
    setup(request({ hosts: ['claude', 'codex'], profile: 'full' }), {
      paths,
      interactive: true,
      checkPlatform: async () => {},
      detectHosts: async () => ['claude', 'codex'],
      ensureDataDirs: async () => {},
      loadRuntimeLock: async () => ({
        productVersion: '0.1.0-alpha.1',
        sourceCommit: 'abc',
        runtime: { sha256: 'a'.repeat(64) },
        extension: { id: 'extension-id', version: '1.0.0' },
      }),
      installRuntime: async () => ({ version: '0.1.0-alpha.1' }),
      installExtension: async () => ({ unpacked: '/tmp/extension' }),
      installClaude: async () => ({ host: 'claude', changed: false, changes: [] }),
      installCodex: async () => ({ host: 'codex', changed: false, changes: [] }),
      installBuiltinMacros: async () => {},
      installLauncher: async () => ({
        action: 'installed',
        path: '/home/test/.local/bin/fast-browser',
      }),
      getCodexVersion: async () => 'codex-cli 0.145.0',
      saveConfig: async () => {
        throw new Error('injected config persistence failure');
      },
    }),
    ({ stage }) => stage === 'save-config',
  );

  assert.equal(await readFile(codexAgents, 'utf8'), priorAgentsBytes);
  assert.equal(await readFile(codexOverride, 'utf8'), unrelatedOverrideBytes);
  assert.equal(await readFile(paths.configFile, 'utf8'), previousConfigBytes);
  assert.deepEqual(await preflightRoutingRemoval({
    paths,
    managedState: { profile: previousConfig.profile, ...previousConfig.managed },
  }), priorOwnershipSummary);
});

test('setup rollback preserves prior Codex agent ownership across version drift', async (t) => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'fast-browser-setup-version-drift-'));
  const paths = resolvePaths({ homeDir, pluginRoot: path.resolve(import.meta.dirname, '../..') });
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  await mkdir(paths.dataDir, { recursive: true, mode: 0o700 });

  const priorRouting = await installRouting({
    profile: 'full',
    hosts: ['codex'],
    paths,
    codexVersion: 'codex-cli 0.144.0',
  });
  const previousConfig = {
    ...migrationConfig(),
    profile: 'full',
    hosts: { claude: false, codex: true },
    sessions: { enabled: true, retentionDays: 30 },
    managed: { files: priorRouting.files, blocks: priorRouting.blocks },
  };
  await writeFile(paths.configFile, `${JSON.stringify(previousConfig)}\n`, { mode: 0o600 });
  const codexAgent = path.join(paths.homeDir, '.codex', 'agents', 'browser_driver.toml');
  const priorAgentBytes = await readFile(codexAgent, 'utf8');

  await assert.rejects(
    setup(request({ hosts: ['claude'], profile: 'full' }), {
      paths,
      interactive: true,
      checkPlatform: async () => {},
      detectHosts: async () => ['claude'],
      ensureDataDirs: async () => {},
      loadRuntimeLock: async () => ({
        productVersion: '0.1.0-alpha.1',
        sourceCommit: 'abc',
        runtime: { sha256: 'a'.repeat(64) },
        extension: { id: 'extension-id', version: '1.0.0' },
      }),
      installRuntime: async () => ({ version: '0.1.0-alpha.1' }),
      installExtension: async () => ({ unpacked: '/tmp/extension' }),
      installClaude: async () => ({ host: 'claude', changed: false, changes: [] }),
      installBuiltinMacros: async () => {},
      installLauncher: async () => ({
        action: 'installed',
        path: '/home/test/.local/bin/fast-browser',
      }),
      getCodexVersion: async () => 'codex-cli 0.145.0',
      saveConfig: async () => {
        throw new Error('injected config persistence failure');
      },
    }),
    ({ stage }) => stage === 'save-config',
  );

  assert.equal(await readFile(codexAgent, 'utf8'), priorAgentBytes);
  await preflightRoutingRemoval({
    paths,
    managedState: { profile: previousConfig.profile, ...previousConfig.managed },
  });
});

test('partial host installation uses reviewed cleanup and exposes only redacted state', async () => {
  const events = [];
  await assert.rejects(
    setup(request(), {
      checkPlatform: async () => {},
      detectHosts: async () => ['claude', 'codex'],
      ensureDataDirs: async () => {},
      loadRuntimeLock: async () => ({
        productVersion: '0.1.0-alpha.1',
        sourceCommit: 'abc',
        runtime: { sha256: 'a'.repeat(64) },
        extension: { id: 'extension-id', version: '1.0.0' },
      }),
      installRuntime: async () => ({ version: '0.1.0-alpha.1' }),
      installExtension: async () => ({ unpacked: '/tmp/extension' }),
      installClaude: async () => ({ host: 'claude', changed: true, changes: ['plugin-installed'] }),
      installCodex: async () => {
        const error = new Error('/Users/secret leaked');
        error.result = {
          host: 'codex',
          changed: true,
          changes: ['marketplace-added'],
          next: 'safe remediation',
        };
        throw error;
      },
      uninstallClaude: async () => events.push('cleanup-claude'),
      loadConfig: async () => null,
      paths: {},
      interactive: true,
    }),
    (error) => {
      assert.equal(error.name, 'LifecycleError');
      assert.doesNotMatch(JSON.stringify(error), /Users|secret|leaked/);
      assert.deepEqual(error.partialState.hosts, [
        { host: 'claude', changed: true, changes: ['plugin-installed'] },
        {
          host: 'codex',
          changed: true,
          changes: ['marketplace-added'],
          next: 'safe remediation',
        },
      ]);
      return true;
    },
  );
  assert.deepEqual(events, ['cleanup-claude']);
});

test('post-save retention failure preserves the tracked installation', async () => {
  const events = [];
  await assert.rejects(
    setup(request({ hosts: ['claude'] }), {
      checkPlatform: async () => {},
      detectHosts: async () => ['claude'],
      ensureDataDirs: async () => {},
      loadRuntimeLock: async () => ({
        productVersion: '0.1.0-alpha.1',
        sourceCommit: 'abc',
        runtime: { sha256: 'a'.repeat(64) },
        extension: { id: 'extension-id', version: '1.0.0' },
      }),
      installRuntime: async () => ({ version: '0.1.0-alpha.1' }),
      installExtension: async () => ({ unpacked: '/tmp/extension' }),
      installClaude: async () => ({
        host: 'claude',
        changed: true,
        changes: ['plugin-installed'],
      }),
      installBuiltinMacros: async () => {},
      installLauncher: async () => ({
        action: 'installed',
        path: '/home/test/.local/bin/fast-browser',
      }),
      prepareRoutingTransition: async () => ({
        nextState: { profile: 'full', files: [], blocks: [] },
        apply: async () => ({ rollback: async () => {} }),
      }),
      saveConfig: async () => events.push('save'),
      pruneSessions: async () => {
        events.push('prune');
        throw new Error('/Users/secret');
      },
      uninstallClaude: async () => events.push('remove-claude'),
      loadConfig: async () => null,
      paths: {},
      interactive: true,
    }),
    (error) => {
      assert.equal(error.stage, 'retention-prune');
      assert.equal(error.partialState.configPersisted, true);
      assert.doesNotMatch(error.message, /Users|secret/);
      return true;
    },
  );
  assert.deepEqual(events, ['save', 'prune']);
});

test('noninteractive setup without an explicit host reports detected hosts and correction', async () => {
  await assert.rejects(
    setup(request({ hosts: [] }), {
      checkPlatform: async () => {},
      detectHosts: async () => ['claude', 'codex'],
      interactive: false,
      paths: {},
    }),
    (error) => {
      assert.match(error.message, /Detected hosts: Claude Code, Codex/);
      assert.match(error.message, /fast-browser setup --host both/);
      return true;
    },
  );
});

test('setup refuses malformed or unreadable existing config before any mutation', async () => {
  const events = [];
  await assert.rejects(
    setup(request({ hosts: ['claude'], profile: 'safe' }), {
      checkPlatform: async () => {},
      detectHosts: async () => ['claude'],
      loadConfig: async () => {
        throw new Error('malformed existing config at /Users/secret');
      },
      ensureDataDirs: async () => events.push('mutation'),
      paths: {},
    }),
    (error) => {
      assert.equal(error.name, 'LifecycleError');
      assert.equal(error.stage, 'config-preflight');
      assert.doesNotMatch(error.message, /Users|secret/);
      return true;
    },
  );
  assert.deepEqual(events, []);
});

// Companion to the doctor wrapper fix: when a host install/preflight throws,
// `Setup failed; inspect the reported managed state and retry.` with an empty
// `hosts` array told the user to inspect state that was never populated, and
// the one sentence that named the real failure was dropped on the floor.
function throwingHostSetup(installCodex) {
  return {
    checkPlatform: async () => {},
    detectHosts: async () => ['codex'],
    ensureDataDirs: async () => {},
    loadRuntimeLock: async () => ({
      productVersion: '0.1.0-alpha.1',
      sourceCommit: 'abc',
      runtime: { sha256: 'a'.repeat(64) },
      extension: { id: 'extension-id', version: '1.0.0' },
    }),
    installRuntime: async () => ({ version: '0.1.0-alpha.1' }),
    installExtension: async () => ({ unpacked: '/tmp/extension' }),
    installCodex,
    loadConfig: async () => null,
    paths: {
      dataDir: '/home/test/.fast-browser',
      configFile: '/home/test/.fast-browser/config.json',
    },
    interactive: false,
  };
}

test('setup names the host failure that stopped it', async () => {
  await assert.rejects(
    setup(request({ hosts: ['codex'], profile: 'safe' }), throwingHostSetup(async () => {
      const error = new Error('codex plugin list exited with code 1');
      error.name = 'HostInstallError';
      throw error;
    })),
    (error) => {
      assert.equal(error.name, 'LifecycleError');
      assert.equal(error.stage, 'setup');
      assert.match(error.message, /codex plugin list exited with code 1/);
      assert.equal(error.partialState.cause, 'codex plugin list exited with code 1');
      return true;
    },
  );
});

test('setup still withholds a host failure it cannot vouch for', async () => {
  await assert.rejects(
    setup(request({ hosts: ['codex'], profile: 'safe' }), throwingHostSetup(async () => {
      throw new Error('ENOENT: no such file or directory, open /Users/secret/token');
    })),
    (error) => {
      assert.equal(error.name, 'LifecycleError');
      assert.doesNotMatch(error.message, /Users|secret/);
      assert.doesNotMatch(JSON.stringify(error.partialState), /Users|secret/);
      return true;
    },
  );
});

test('migration production config preflight rejects unsafe config before every mutation', async (t) => {
  const canonicalTemp = await realpath(tmpdir());
  const cases = [
    {
      name: 'malformed JSON',
      prepare: async ({ configFile }) => writeFile(configFile, '{"schemaVersion":'),
    },
    {
      name: 'unreadable regular config',
      prepare: async ({ configFile }) => {
        await writeFile(configFile, `${JSON.stringify(migrationConfig())}\n`);
        await chmod(configFile, 0o000);
      },
    },
    {
      name: 'config symlink to a valid external file',
      prepare: async ({ configFile, externalDir }) => {
        const externalConfig = path.join(externalDir, 'valid-config.json');
        await writeFile(externalConfig, `${JSON.stringify(migrationConfig())}\n`);
        await symlink(externalConfig, configFile);
      },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async (caseTest) => {
      const homeDir = await mkdtemp(path.join(canonicalTemp, 'fast-browser-migrate-home-'));
      const externalDir = await mkdtemp(path.join(canonicalTemp, 'fast-browser-migrate-external-'));
      const paths = resolvePaths({ homeDir, pluginRoot: '/plugin' });
      await mkdir(paths.dataDir, { mode: 0o700 });
      await entry.prepare({ configFile: paths.configFile, externalDir });
      caseTest.after(() => Promise.all([
        rm(homeDir, { recursive: true, force: true }),
        rm(externalDir, { recursive: true, force: true }),
      ]));

      const events = [];
      await assert.rejects(
        migrate(
          {
            dryRun: false,
            rollback: null,
            hosts: ['claude'],
            source: '/repo/mattstack',
          },
          {
            paths,
            applyMigration: async (options) => {
              events.push('inventory');
              events.push('backup');
              events.push('import');
              await options.writeMigratedToken('fixture-token');
              return options.installAdaptersAndRouting();
            },
            writeMigratedToken: async () => events.push('keychain'),
            installClaude: async () => events.push('host'),
            installRouting: async () => events.push('routing'),
            saveConfig: async () => events.push('save'),
          },
        ),
        (error) => {
          assert.equal(error.name, 'LifecycleError');
          assert.equal(error.stage, 'config-preflight');
          return true;
        },
      );
      assert.deepEqual(events, []);
    });
  }
});

test('migration production config preflight treats the exact missing config leaf as absence', async (t) => {
  const canonicalTemp = await realpath(tmpdir());
  const homeDir = await mkdtemp(path.join(canonicalTemp, 'fast-browser-migrate-absent-'));
  const paths = resolvePaths({ homeDir, pluginRoot: '/plugin' });
  await mkdir(paths.dataDir, { mode: 0o700 });
  t.after(() => rm(homeDir, { recursive: true, force: true }));

  const events = [];
  const report = await migrate(
    {
      dryRun: false,
      rollback: null,
      hosts: ['claude'],
      source: '/repo/mattstack',
    },
    {
      paths,
      applyMigration: async (options) => {
        events.push('apply');
        return options.installAdaptersAndRouting();
      },
      installClaude: async () => {
        events.push('host');
        return { host: 'claude', changed: false, changes: [] };
      },
      prepareRoutingTransition: async ({ profile }) => {
        events.push(`routing:prepare:${profile}`);
        return {
          nextState: { profile, files: [], blocks: [] },
          apply: async () => {
            events.push('routing:apply');
            return { rollback: async () => {} };
          },
        };
      },
      saveConfig: async () => events.push('save'),
    },
  );

  assert.deepEqual(events, [
    'apply',
    'host',
    'routing:prepare:safe',
    'routing:apply',
    'save',
  ]);
  assert.deepEqual(report.previousConfig, migrationConfig());
});

test('migration receipt preserves external routing drift and reports recovery required', async (t) => {
  const homeDir = await mkdtemp(path.join(await realpath(tmpdir()), 'fast-browser-migration-drift-'));
  const paths = resolvePaths({ homeDir, pluginRoot: path.resolve(import.meta.dirname, '../..') });
  await mkdir(paths.dataDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const routingPath = path.join(homeDir, '.claude', 'rules', 'fast-browser-routing.md');
  let preparations = 0;

  await assert.rejects(
    migrate(
      {
        dryRun: false,
        rollback: null,
        hosts: ['claude'],
        source: '/repo/mattstack',
      },
      {
        paths,
        loadConfig: async () => ({
          ...migrationConfig(),
          profile: 'full',
        }),
        installClaude: async () => ({ host: 'claude', changed: false, changes: [] }),
        prepareRoutingTransition: async (options) => {
          preparations += 1;
          return prepareRoutingTransition(options);
        },
        saveConfig: async () => {},
        verify: async () => {
          await writeFile(routingPath, 'external routing drift\n', { mode: 0o600 });
          throw new Error('injected verification failure');
        },
      },
    ),
    (error) => {
      assert.equal(error.stage, 'recovery');
      assert.match(error.message, /recovery required/i);
      assert.equal(error.partialState, null);
      assert.doesNotMatch(
        JSON.stringify(error),
        /fast-browser-routing|external routing drift/,
      );
      return true;
    },
  );

  assert.equal(preparations, 1);
  assert.equal(await readFile(routingPath, 'utf8'), 'external routing drift\n');
});

test('migration reports recovery when real routing apply and automatic reversal both fail', async (t) => {
  const homeDir = await mkdtemp(path.join(
    await realpath(tmpdir()),
    'fast-browser-migration-apply-recovery-',
  ));
  const paths = resolvePaths({
    homeDir,
    pluginRoot: path.resolve(import.meta.dirname, '../..'),
  });
  await mkdir(paths.dataDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const routingPath = path.join(
    homeDir,
    '.claude',
    'rules',
    'fast-browser-routing.md',
  );
  const consentPath = path.join(
    homeDir,
    '.claude',
    'rules',
    'fast-browser-verification-consent.md',
  );
  let mutationCalls = 0;
  let saves = 0;
  let verifications = 0;
  const transactionIo = {
    ...nodeFileTransactionIo,
    async mutate(change) {
      const call = mutationCalls;
      mutationCalls += 1;
      if (call === 1 || call === 2) {
        throw new Error('/Users/maintainer/secret-routing-mutation');
      }
      return nodeFileTransactionIo.mutate(change);
    },
  };

  await assert.rejects(
    migrate(
      {
        dryRun: false,
        rollback: null,
        hosts: ['claude'],
        source: '/repo/mattstack',
      },
      {
        paths,
        loadConfig: async () => ({
          ...migrationConfig(),
          profile: 'full',
        }),
        installClaude: async () => ({ host: 'claude', changed: false, changes: [] }),
        prepareRoutingTransition: async (options) => prepareRoutingTransition({
          ...options,
          transactionIo,
        }),
        saveConfig: async () => {
          saves += 1;
        },
        verify: async () => {
          verifications += 1;
        },
      },
    ),
    (error) => {
      assert.equal(error.name, 'MigrationError');
      assert.equal(error.stage, 'recovery');
      assert.equal(
        error.message,
        'migration recovery required after installed-state cleanup failed',
      );
      assert.equal(error.partialState, null);
      assert.doesNotMatch(
        JSON.stringify(error),
        /Users|maintainer|secret-routing-mutation|fast-browser-routing/,
      );
      return true;
    },
  );

  assert.equal(mutationCalls, 3);
  assert.equal(saves, 0);
  assert.equal(verifications, 0);
  await access(routingPath);
  await assert.rejects(access(consentPath), { code: 'ENOENT' });
});

test('default setup directory preflight refuses a symlinked data root without outside writes', async (t) => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'fast-browser-lifecycle-home-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'fast-browser-lifecycle-outside-'));
  t.after(() => Promise.all([
    rm(homeDir, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  await symlink(outside, path.join(homeDir, '.fast-browser'));
  const paths = resolvePaths({ homeDir, pluginRoot: '/plugin' });

  await assert.rejects(
    setup(request({ hosts: ['claude'], profile: 'safe' }), {
      checkPlatform: async () => {},
      detectHosts: async () => ['claude'],
      loadConfig: async () => null,
      loadRuntimeLock: async () => assert.fail('runtime load must follow directory preflight'),
      paths,
    }),
    (error) => error.name === 'LifecycleError' && error.stage === 'setup',
  );
  assert.deepEqual(await readdir(outside), []);
});
