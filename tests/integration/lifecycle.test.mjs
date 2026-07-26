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
      runtime: { sha256: 'a'.repeat(64), sourceCommit: 'abc' },
      extension: { id: 'extension-id', version: '1.0.0' },
    }),
    installRuntime: record('install-runtime', { version: '0.1.0-alpha.1' }),
    installExtension: record('install-extension-artifact', { unpacked: '/tmp/extension' }),
    installClaude: record('install-claude', { changed: true }),
    installCodex: record('install-codex', { changed: true }),
    installBuiltinMacros: record('install-builtins'),
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
      runtime: { sha256: 'a'.repeat(64), sourceCommit: 'abc' },
      extension: { id: 'extension-id', version: '1.0.0' },
    }),
    installRuntime: async () => ({ version: '0.1.0-alpha.1' }),
    installExtension: async () => ({ unpacked: '/tmp/extension' }),
    installCodex: async () => ({ changed: true, changes: ['plugin-installed'] }),
    installBuiltinMacros: async () => {},
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
      runtime: { sha256: 'a'.repeat(64), sourceCommit: 'abc' },
      extension: { id: 'extension-id', version: '1.0.0' },
    }),
    installRuntime: async () => ({ version: '0.1.0-alpha.1' }),
    installExtension: async () => ({ unpacked: '/tmp/extension' }),
    installClaude: async () => ({ changed: false, changes: [] }),
    installBuiltinMacros: async () => {},
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
        runtime: { sha256: 'a'.repeat(64), sourceCommit: 'abc' },
        extension: { id: 'extension-id', version: '1.0.0' },
      }),
      installRuntime: async () => ({ version: '0.1.0-alpha.1' }),
      installExtension: async () => ({ unpacked: '/tmp/extension' }),
      installClaude: async () => ({ host: 'claude', changed: true }),
      installBuiltinMacros: async () => {},
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

test('setup maps a routing recovery-required apply failure to its fixed recovery result', async () => {
  let saves = 0;

  await assert.rejects(
    setup(request({ hosts: ['claude'], profile: 'full' }), {
      checkPlatform: async () => {},
      detectHosts: async () => ['claude'],
      ensureDataDirs: async () => {},
      loadRuntimeLock: async () => ({
        productVersion: '0.1.0-alpha.1',
        runtime: { sha256: 'a'.repeat(64), sourceCommit: 'abc' },
        extension: { id: 'extension-id', version: '1.0.0' },
      }),
      installRuntime: async () => ({ version: '0.1.0-alpha.1' }),
      installExtension: async () => ({ unpacked: '/tmp/extension' }),
      installClaude: async () => ({ host: 'claude', changed: false, changes: [] }),
      installBuiltinMacros: async () => {},
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
        runtime: { sha256: 'a'.repeat(64), sourceCommit: 'abc' },
        extension: { id: 'extension-id', version: '1.0.0' },
      }),
      installRuntime: async () => ({ version: '0.1.0-alpha.1' }),
      installExtension: async () => ({ unpacked: '/tmp/extension' }),
      installClaude: async () => ({ host: 'claude', changed: false, changes: [] }),
      installBuiltinMacros: async () => {},
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
      runtime: { sha256: 'a'.repeat(64), sourceCommit: 'abc' },
      extension: { id: 'extension-id', version: '1.0.0' },
    }),
    installRuntime: async () => ({ version: '0.1.0-alpha.1' }),
    installExtension: async () => ({ unpacked: '/tmp/extension' }),
    installCodex: async () => ({ host: 'codex', changed: false, changes: [] }),
    installBuiltinMacros: async () => {},
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
        runtime: { sha256: 'a'.repeat(64), sourceCommit: 'abc' },
        extension: { id: 'extension-id', version: '1.0.0' },
      }),
      installRuntime: async () => ({ version: '0.1.0-alpha.1' }),
      installExtension: async () => ({ unpacked: '/tmp/extension' }),
      installClaude: async () => ({ host: 'claude', changed: false, changes: [] }),
      installCodex: async () => ({ host: 'codex', changed: false, changes: [] }),
      installBuiltinMacros: async () => {},
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
        runtime: { sha256: 'a'.repeat(64), sourceCommit: 'abc' },
        extension: { id: 'extension-id', version: '1.0.0' },
      }),
      installRuntime: async () => ({ version: '0.1.0-alpha.1' }),
      installExtension: async () => ({ unpacked: '/tmp/extension' }),
      installClaude: async () => ({ host: 'claude', changed: false, changes: [] }),
      installBuiltinMacros: async () => {},
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
        runtime: { sha256: 'a'.repeat(64), sourceCommit: 'abc' },
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
        runtime: { sha256: 'a'.repeat(64), sourceCommit: 'abc' },
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
