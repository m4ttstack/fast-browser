import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
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
    installRouting: record('install-routing', managedState),
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
    'install-routing',
    'save-config',
    'prune-sessions',
    'doctor',
  ]);
  assert.equal(report.profile, 'full');
  assert.deepEqual(report.hosts, ['claude', 'codex']);
  assert.equal(report.extensionPath, '/tmp/extension');
  assert.equal(report.doctor.ok, true);
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

test('setup never prunes before config persistence and rolls routing back on save failure', async () => {
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
      installClaude: async () => ({ host: 'claude', changed: true }),
      installBuiltinMacros: async () => {},
      installRouting: async () => ({ profile: 'full', files: [], blocks: [] }),
      saveConfig: async () => {
        events.push('save');
        throw new Error('disk failure');
      },
      pruneSessions: async () => events.push('prune'),
      removeRouting: async () => events.push('rollback-routing'),
      loadConfig: async () => null,
      paths: {},
      interactive: true,
    }),
    /save config/i,
  );
  assert.deepEqual(events, ['save', 'rollback-routing']);
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
      installRouting: async () => ({ profile: 'full', files: [], blocks: [] }),
      saveConfig: async () => events.push('save'),
      pruneSessions: async () => {
        events.push('prune');
        throw new Error('/Users/secret');
      },
      removeRouting: async () => events.push('remove-routing'),
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
      installRouting: async ({ profile }) => {
        events.push(`routing:${profile}`);
        return { profile, files: [], blocks: [] };
      },
      saveConfig: async () => events.push('save'),
    },
  );

  assert.deepEqual(events, ['apply', 'host', 'routing:safe', 'save']);
  assert.deepEqual(report.previousConfig, migrationConfig());
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
