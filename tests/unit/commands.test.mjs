import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { configure } from '../../lib/commands/configure.mjs';
import { doctor } from '../../lib/commands/doctor.mjs';
import { migrate } from '../../lib/commands/migrate.mjs';
import { setup } from '../../lib/commands/setup.mjs';
import { uninstall } from '../../lib/commands/uninstall.mjs';
import {
  DOCTOR_CHECK_IDS,
  checkToolContract,
  performMcpHandshake,
} from '../../lib/doctor/checks.mjs';
import { main } from '../../lib/cli/main.mjs';
import { openNdjsonProcess } from '../../lib/core/process.mjs';
import { runtimeLockIdentity } from '../../lib/runtime/lock.mjs';

test('exports dependency-injected lifecycle command functions', () => {
  assert.equal(typeof setup, 'function');
  assert.equal(typeof doctor, 'function');
  assert.equal(typeof configure, 'function');
  assert.equal(typeof migrate, 'function');
  assert.equal(typeof uninstall, 'function');
});

function validConfig(overrides = {}) {
  return {
    schemaVersion: 1,
    productVersion: '0.1.0-alpha.1',
    profile: 'safe',
    hosts: { claude: true, codex: true },
    connection: { mode: 'manual' },
    sessions: { enabled: false, retentionDays: 30 },
    runtime: { version: '0.1.0-alpha.1', sha256: 'a'.repeat(64), sourceCommit: 'abc' },
    managed: { files: [], blocks: [] },
    ...overrides,
  };
}

test('doctor returns every stable check in order and catches individual failures', async () => {
  const checks = Object.fromEntries(DOCTOR_CHECK_IDS.map((id) => [
    id,
    async () => ({
      status: 'pass',
      message: id === 'runtime-checksum'
        ? 'Runtime 0.1.0-alpha.1 matches its lock.'
        : `${id} passed.`,
      remediation: null,
    }),
  ]));
  checks.chrome = async () => {
    throw new Error('do not leak /Users/secret');
  };

  const report = await doctor(
    { profile: 'full' },
    { checks },
  );

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.ok, false);
  assert.equal(report.profile, 'full');
  assert.deepEqual(report.checks.map(({ id }) => id), DOCTOR_CHECK_IDS);
  assert.deepEqual(report.checks.find(({ id }) => id === 'runtime-checksum'), {
    id: 'runtime-checksum',
    status: 'pass',
    message: 'Runtime 0.1.0-alpha.1 matches its lock.',
    remediation: null,
  });
  assert.deepEqual(report.checks.find(({ id }) => id === 'chrome'), {
    id: 'chrome',
    status: 'fail',
    message: 'Chrome check failed.',
    remediation: 'Run `fast-browser doctor` after fixing Chrome.',
  });
  assert.doesNotMatch(JSON.stringify(report), /Users|secret/);
});

test('doctor real composition accepts complete injected platform adapters with no stubs', async () => {
  const config = validConfig({
    profile: 'safe',
    managed: {
      files: [{
        path: '/home/test/.codex/agents/browser_driver.toml',
        sha256: 'a'.repeat(64),
      }],
      blocks: [{
        path: '/home/test/.codex/config.toml',
        id: 'mcp-policy-v1',
        kind: 'toml',
        sha256: 'b'.repeat(64),
        containerCreated: true,
      }],
    },
  });
  const tools = [
    { name: 'browser_navigate' },
    { name: 'browser_snapshot' },
    { name: 'browser_click' },
    {
      name: 'browser_run_code_unsafe',
      annotations: { destructiveHint: true, openWorldHint: true },
    },
  ];
  const report = await doctor(
    { profile: 'safe' },
    {
      paths: {
        homeDir: '/home/test',
        dataDir: '/home/test/.fast-browser',
        configFile: '/home/test/.fast-browser/config.json',
        runtimeDir: '/home/test/.fast-browser/runtime',
        extensionDir: '/home/test/.fast-browser/extension',
        pluginRoot: '/plugin',
      },
      config,
      lock: {
        productVersion: '0.1.0-alpha.1',
        runtime: { node: '>=20' },
        extension: { id: 'extension-id', version: '1.0.0' },
      },
      platform: 'darwin',
      nodeVersion: '22.0.0',
      checkChrome: async () => {},
      detectHosts: async () => ['claude', 'codex'],
      preflightClaude: async () => ({ installed: true }),
      preflightCodex: async () => ({ installed: true }),
      preflightRouting: async () => ({ files: [], blocks: [] }),
      checkRuntime: async () => {},
      checkExtensionArtifact: async () => {},
      detectChromeExtension: async () => [{
        profile: 'Default',
        installed: true,
        manifestVersion: '1.0.0',
      }],
      hasToken: async () => true,
      checkDataPermissions: async () => {},
      openMcpTransport: async () => ({
        request: async (message) => (
          message.method === 'initialize'
            ? {
              jsonrpc: '2.0',
              id: message.id,
              result: { protocolVersion: '2025-03-26' },
            }
            : { jsonrpc: '2.0', id: message.id, result: { tools } }
        ),
        notify: async () => {},
        close: async () => {},
      }),
    },
  );
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.map(({ status }) => status), Array(17).fill('pass'));
});

test('tool contract requires browser tools and unsafe annotations', () => {
  const tools = [
    { name: 'browser_navigate' },
    { name: 'browser_snapshot' },
    { name: 'browser_click' },
    {
      name: 'browser_run_code_unsafe',
      annotations: {
        destructiveHint: true,
        openWorldHint: true,
      },
    },
  ];
  assert.equal(checkToolContract(tools).status, 'pass');
  assert.equal(
    checkToolContract(tools.map((tool) => (
      tool.name === 'browser_run_code_unsafe' ? { name: tool.name } : tool
    ))).status,
    'fail',
  );
  assert.equal(checkToolContract(tools.slice(1)).status, 'fail');
});

test('MCP handshake validates initialize before initialized notification and tools/list', async () => {
  const events = [];
  const transport = {
    async request(message) {
      events.push(message.method);
      if (message.method === 'initialize') {
        return { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26' } };
      }
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: { tools: [{ name: 'browser_navigate' }] },
      };
    },
    async notify(message) {
      events.push(message.method);
    },
    async close(options) {
      events.push(`close:${options.descendants}`);
    },
  };

  const result = await performMcpHandshake({ openTransport: async () => transport });
  assert.deepEqual(events, [
    'initialize',
    'notifications/initialized',
    'tools/list',
    'close:true',
  ]);
  assert.deepEqual(result.tools, [{ name: 'browser_navigate' }]);
});

test('MCP handshake rejects wrong JSON-RPC versions, ids, and error responses', async () => {
  const invalid = (id) => [
    {
      name: 'wrong jsonrpc',
      response: { jsonrpc: '1.0', id, result: {} },
    },
    {
      name: 'wrong id',
      response: { jsonrpc: '2.0', id: 99, result: {} },
    },
    {
      name: 'error response',
      response: { jsonrpc: '2.0', id, error: { code: -32603, message: 'failed' } },
    },
  ];
  for (const stage of ['initialize', 'tools/list']) {
    for (const fixture of invalid(stage === 'initialize' ? 1 : 2)) {
    let closed = false;
    let requests = 0;
    await assert.rejects(
      performMcpHandshake({
        openTransport: async () => ({
          request: async (message) => {
            requests += 1;
            if (message.method === stage) return fixture.response;
            return {
              jsonrpc: '2.0',
              id: message.id,
              result: { protocolVersion: '2025-03-26' },
            };
          },
          notify: async () => {},
          close: async () => {
            closed = true;
          },
        }),
      }),
      /malformed|error/i,
      `${stage}: ${fixture.name}`,
    );
    assert.equal(requests, stage === 'initialize' ? 1 : 2, `${stage}: ${fixture.name}`);
    assert.equal(closed, true, `${stage}: ${fixture.name}`);
    }
  }
});

test('MCP handshake bounds each exact NDJSON response and closes on timeout', async () => {
  await assert.rejects(
    performMcpHandshake({
      outputCapBytes: 8,
      openTransport: async () => ({
        request: async (message) => ({
          jsonrpc: '2.0',
          id: message.id,
          result: { protocolVersion: '2025-03-26', tools: [{ name: 'too-large' }] },
        }),
        notify: async () => {},
        close: async () => {},
      }),
    }),
    /output limit/,
  );
});

test('MCP handshake times out and still closes descendants', async () => {
  const events = [];
  await assert.rejects(
    performMcpHandshake({
      timeoutMs: 5,
      openTransport: async () => ({
        request: async () => new Promise(() => {}),
        notify: async () => {},
        close: async ({ descendants }) => events.push(descendants),
      }),
    }),
    /timed out/,
  );
  assert.deepEqual(events, [true]);
});

test('MCP handshake applies one total timeout across open, initialize, notification, and tools phases', async () => {
  for (const phase of ['open', 'initialize', 'notify', 'tools/list']) {
    const events = [];
    await assert.rejects(
      performMcpHandshake({
        timeoutMs: 5,
        openTransport: async () => {
          if (phase === 'open') return new Promise(() => {});
          return {
            request: async (message) => {
              events.push(message.method);
              if (message.method === phase) return new Promise(() => {});
              return message.method === 'initialize'
                ? {
                  jsonrpc: '2.0',
                  id: message.id,
                  result: { protocolVersion: '2025-03-26' },
                }
                : { jsonrpc: '2.0', id: message.id, result: { tools: [] } };
            },
            notify: async () => {
              events.push('notify');
              if (phase === 'notify') return new Promise(() => {});
            },
            close: async () => events.push('close'),
          };
        },
      }),
      /timed out/i,
      phase,
    );
    if (phase !== 'open') assert.equal(events.at(-1), 'close', phase);
  }
});

test('production NDJSON transport rejects early exit and oversized raw output', async () => {
  for (const fixture of [
    {
      name: 'early exit',
      script: "process.stdin.once('data', () => process.exit(7));",
      match: /exited before/i,
    },
    {
      name: 'oversize',
      script: "process.stdin.once('data', () => process.stdout.write('x'.repeat(1025)));",
      match: /exceeds 1024 bytes/i,
    },
  ]) {
    await assert.rejects(
      performMcpHandshake({
        outputCapBytes: 1024,
        openTransport: (options) => openNdjsonProcess(
          process.execPath,
          ['-e', fixture.script],
          options,
        ),
      }),
      fixture.match,
      fixture.name,
    );
  }
});

test('production MCP composition uses one persistent pinned-runtime duplex session', async (t) => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'fast-browser-mcp-home-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const dataDir = path.join(homeDir, '.fast-browser');
  const runtimeDir = path.join(dataDir, 'runtime');
  const lock = {
    schemaVersion: 1,
    productVersion: '0.1.0-alpha.1',
    sourceCommit: 'abc',
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
  const installDir = path.join(runtimeDir, lock.productVersion);
  const cliDir = path.join(installDir, 'fast-browser-mcp');
  await mkdir(cliDir, { recursive: true });
  await writeFile(
    path.join(installDir, 'installed.json'),
    JSON.stringify({ lock: runtimeLockIdentity(lock) }),
  );
  await writeFile(
    path.join(cliDir, 'cli.cjs'),
    [
      "let buffered = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => {",
      '  buffered += chunk;',
      '  while (true) {',
      "    const newline = buffered.indexOf('\\n');",
      '    if (newline < 0) return;',
      '    const message = JSON.parse(buffered.slice(0, newline));',
      '    buffered = buffered.slice(newline + 1);',
      "    if (message.method === 'initialize') {",
      "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26' } }) + '\\n');",
      "    } else if (message.method === 'tools/list') {",
      "      const tools = ['browser_navigate', 'browser_snapshot', 'browser_click'].map((name) => ({ name }));",
      "      tools.push({ name: 'browser_run_code_unsafe', annotations: { destructiveHint: true, openWorldHint: true } });",
      "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools } }) + '\\n');",
      "    }",
      "  }",
      '});',
    ].join('\n'),
  );
  const config = validConfig({
    hosts: { claude: false, codex: false },
    runtime: {
      version: lock.productVersion,
      sha256: lock.runtime.sha256,
      sourceCommit: lock.sourceCommit,
    },
  });
  const checks = Object.fromEntries(DOCTOR_CHECK_IDS
    .filter((id) => id !== 'mcp-handshake' && id !== 'tool-contract')
    .map((id) => [id, async () => ({ status: 'pass', message: `${id} passed.`, remediation: null })]));
  const report = await doctor(
    { profile: 'safe' },
    {
      paths: {
        homeDir,
        dataDir,
        configFile: path.join(dataDir, 'config.json'),
        runtimeDir,
        extensionDir: path.join(dataDir, 'extension'),
        pluginRoot: '/plugin',
      },
      config,
      lock,
      checks,
    },
  );
  assert.equal(report.checks.find(({ id }) => id === 'mcp-handshake').status, 'pass');
  assert.equal(report.checks.find(({ id }) => id === 'tool-contract').status, 'pass');
});

test('configure composes full defaults, applies explicit overrides, saves before pruning', async () => {
  const events = [];
  const current = validConfig();
  const managed = {
    profile: 'full',
    files: [{ path: '/owned', sha256: 'a'.repeat(64) }],
    blocks: [],
  };
  const report = await configure(
    {
      profile: 'full',
      connection: null,
      recordSessions: false,
      retentionDays: 17,
    },
    {
      loadConfig: async () => current,
      installRouting: async ({ profile, managedState }) => {
        events.push(`routing:${profile}:${managedState.profile ?? 'none'}`);
        return managed;
      },
      saveConfig: async (_paths, config) => events.push(`save:${config.sessions.retentionDays}`),
      pruneSessions: async () => events.push('prune'),
      paths: { dataDir: '/home/test/.fast-browser' },
    },
  );

  assert.equal(report.config.profile, 'full');
  assert.deepEqual(report.config.sessions, { enabled: false, retentionDays: 17 });
  assert.equal(report.config.connection.mode, 'manual');
  assert.deepEqual(report.config.managed, {
    files: [{ path: '/owned', sha256: 'a'.repeat(64) }],
    blocks: [],
  });
  assert.deepEqual(events, ['routing:full:safe', 'save:17']);
});

test('configure auto connection invokes secure pairing and full recording defaults', async () => {
  const events = [];
  const report = await configure(
    {
      profile: 'full',
      connection: 'auto',
      recordSessions: null,
      retentionDays: null,
    },
    {
      loadConfig: async () => validConfig(),
      installRouting: async () => ({ profile: 'full', files: [], blocks: [] }),
      pairAutoConnect: async (config, { updateConfig }) => {
        events.push('pair');
        const paired = { ...config, connection: { mode: 'auto' } };
        await updateConfig(paired);
        return paired;
      },
      hasToken: async () => false,
      saveConfig: async (_paths, config) => events.push(`save:${config.connection.mode}`),
      pruneSessions: async () => events.push('prune'),
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      paths: { dataDir: '/home/test/.fast-browser' },
    },
  );

  assert.deepEqual(events, ['pair', 'save:auto', 'prune']);
  assert.equal(report.config.sessions.enabled, true);
  assert.equal(report.config.connection.mode, 'auto');
});

test('configure validates retention and never records in safe profile', async () => {
  await assert.rejects(
    configure(
      { profile: 'safe', recordSessions: true, retentionDays: 0 },
      { loadConfig: async () => validConfig(), paths: {} },
    ),
    /retention.*1.*365/i,
  );
  await assert.rejects(
    configure(
      { profile: 'safe', recordSessions: true, retentionDays: 30 },
      { loadConfig: async () => validConfig(), paths: {} },
    ),
    /safe profile.*record/i,
  );
});

test('configure rolls routing back when config persistence fails', async () => {
  const events = [];
  await assert.rejects(
    configure(
      { profile: 'full', connection: null, recordSessions: null, retentionDays: null },
      {
        loadConfig: async () => validConfig(),
        installRouting: async ({ profile, managedState }) => {
          events.push(`routing:${profile}:${managedState?.profile ?? 'none'}`);
          return { profile, files: [], blocks: [] };
        },
        saveConfig: async () => {
          events.push('save');
          throw new Error('/Users/secret');
        },
        paths: {},
      },
    ),
    (error) => {
      assert.equal(error.name, 'LifecycleError');
      assert.equal(error.stage, 'save-config');
      assert.doesNotMatch(error.message, /Users|secret/);
      return true;
    },
  );
  assert.deepEqual(events, ['routing:full:safe', 'save', 'routing:safe:full']);
});

test('configure retention failure keeps the durably tracked configuration', async () => {
  const events = [];
  await assert.rejects(
    configure(
      { profile: 'full', connection: null, recordSessions: null, retentionDays: null },
      {
        loadConfig: async () => validConfig(),
        installRouting: async () => ({ profile: 'full', files: [], blocks: [] }),
        saveConfig: async () => events.push('save'),
        pruneSessions: async () => {
          events.push('prune');
          throw new Error('/Users/secret');
        },
        paths: {},
      },
    ),
    (error) => {
      assert.equal(error.name, 'LifecycleError');
      assert.equal(error.stage, 'retention-prune');
      assert.equal(error.partialState.configPersisted, true);
      assert.doesNotMatch(error.message, /Users|secret/);
      return true;
    },
  );
  assert.deepEqual(events, ['save', 'prune']);
});

test('migrate dry-run inventories and proposes without any writer', async () => {
  const events = [];
  const inventory = { schemaVersion: 1, files: [] };
  const report = await migrate(
    { dryRun: true, rollback: null },
    {
      paths: { homeDir: '/home/test', backupsDir: '/home/test/.fast-browser/backups' },
      inventoryLegacy: async () => {
        events.push('inventory');
        return inventory;
      },
      proposeMigration: async (value) => {
        assert.equal(value, inventory);
        events.push('proposal');
        return { mutations: [] };
      },
      loadConfig: async () => events.push('config-preflight'),
      applyMigration: async () => events.push('apply'),
      rollbackMigration: async () => events.push('rollback'),
      writeMigratedToken: async () => events.push('keychain-write'),
    },
  );
  assert.deepEqual(events, ['inventory', 'proposal']);
  assert.deepEqual(report, { dryRun: true, inventory, proposal: { mutations: [] } });
});

test('migrate rollback resolves one exact confined manifest and only rolls back', async () => {
  const events = [];
  const report = await migrate(
    { dryRun: false, rollback: 'migration-1/rollback.json' },
    {
      paths: {
        homeDir: '/home/test',
        backupsDir: '/home/test/.fast-browser/backups',
      },
      rollbackMigration: async (manifest, options) => {
        events.push(`rollback:${manifest}:${options.homeDir}`);
        return { changed: true };
      },
      loadConfig: async () => events.push('config-preflight'),
      inventoryLegacy: async () => events.push('inventory'),
      applyMigration: async () => events.push('apply'),
    },
  );
  assert.deepEqual(events, [
    'rollback:/home/test/.fast-browser/backups/migration-1/rollback.json:/home/test',
  ]);
  assert.equal(report.changed, true);
});

test('production rollback composition supplies one Keychain reader', async () => {
  const events = [];
  await migrate(
    { dryRun: false, rollback: 'migration-1/rollback.json' },
    {
      paths: {
        homeDir: '/home/test',
        backupsDir: '/home/test/.fast-browser/backups',
      },
      readToken: async () => {
        events.push('read-keychain');
        return 'secret-not-rendered';
      },
      rollbackMigration: async (_manifest, options) => {
        assert.equal(typeof options.readMigratedToken, 'function');
        await options.readMigratedToken();
        return { changed: true };
      },
    },
  );
  assert.deepEqual(events, ['read-keychain']);
});

test('migrate apply wires secure token handling, install cleanup, and verification', async () => {
  const supplied = {
    paths: { homeDir: '/home/test', backupsDir: '/home/test/.fast-browser/backups' },
    writeMigratedToken: async () => {},
    readMigratedToken: async () => null,
    installAdaptersAndRouting: async () => ({ hosts: ['claude'] }),
    cleanupInstalled: async () => {},
    verify: async () => {},
  };
  const report = await migrate(
    { dryRun: false, rollback: null },
    {
      ...supplied,
      loadConfig: async () => null,
      applyMigration: async (options) => {
        assert.equal(options.paths, supplied.paths);
        assert.equal(options.writeMigratedToken, supplied.writeMigratedToken);
        assert.equal(options.installAdaptersAndRouting, supplied.installAdaptersAndRouting);
        assert.equal(options.cleanupInstalled, supplied.cleanupInstalled);
        assert.equal(options.verify, supplied.verify);
        assert.equal(Object.hasOwn(options, 'readMigratedToken'), false);
        return { changed: true };
      },
    },
  );
  assert.deepEqual(report, { changed: true });
});

test('migrate composes deterministic host, routing, verification, and cleanup adapters', async () => {
  const events = [];
  const report = await migrate(
    {
      dryRun: false,
      rollback: null,
      hosts: ['claude', 'codex'],
      source: '/repo/mattstack',
    },
    {
      paths: { homeDir: '/home/test', backupsDir: '/home/test/.fast-browser/backups' },
      loadConfig: async () => {
        events.push('load-config');
        return validConfig();
      },
      installClaude: async () => {
        events.push('install-claude');
        return { host: 'claude', changed: true, changes: ['plugin-installed'] };
      },
      installCodex: async () => {
        events.push('install-codex');
        return { host: 'codex', changed: false, changes: [] };
      },
      installRouting: async () => {
        events.push('install-routing');
        return { profile: 'safe', files: [], blocks: [] };
      },
      saveConfig: async () => events.push('save-config'),
      doctor: async () => {
        events.push('doctor');
        return { schemaVersion: 1, ok: true, profile: 'safe', checks: [] };
      },
      removeRouting: async () => events.push('remove-routing'),
      uninstallClaude: async () => events.push('remove-claude'),
      uninstallCodex: async () => events.push('remove-codex'),
      applyMigration: async (options) => {
        events.push('apply');
        const installed = await options.installAdaptersAndRouting();
        await options.verify();
        await options.cleanupInstalled(installed);
        return { changed: true };
      },
    },
  );
  assert.deepEqual(events, [
    'load-config',
    'apply',
    'install-claude',
    'install-codex',
    'install-routing',
    'save-config',
    'doctor',
    'remove-routing',
    'remove-claude',
    'save-config',
  ]);
  assert.deepEqual(report, { changed: true });
});

test('migration config preflight fails closed on every injected loader error before apply', async () => {
  const failures = [
    Object.assign(new Error('malformed config'), { name: 'ConfigError' }),
    Object.assign(new Error('unreadable config'), { code: 'EACCES' }),
    Object.assign(new Error('symlink config'), { code: 'ELOOP' }),
    Object.assign(new Error('nested missing dependency'), { code: 'ENOENT' }),
  ];
  for (const failure of failures) {
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
          paths: { homeDir: '/home/test', backupsDir: '/home/test/.fast-browser/backups' },
          loadConfig: async () => {
            events.push('load-config');
            throw failure;
          },
          installClaude: async () => events.push('install-host'),
          installRouting: async () => events.push('install-routing'),
          saveConfig: async () => events.push('save-config'),
          applyMigration: async (options) => {
            events.push('backup-import');
            return options.installAdaptersAndRouting();
          },
        },
      ),
      (error) => {
        assert.equal(error.name, 'LifecycleError');
        assert.equal(error.stage, 'config-preflight');
        return true;
      },
    );
    assert.deepEqual(events, ['load-config']);
  }
});

test('ordinary uninstall preflights all targets and retains data and Keychain', async () => {
  const events = [];
  const config = validConfig({
    managed: { files: [], blocks: [] },
  });
  const report = await uninstall(
    { hosts: [], purgeData: false },
    {
      paths: { dataDir: '/home/test/.fast-browser', homeDir: '/home/test' },
      loadConfig: async () => config,
      preflightRouting: async () => events.push('preflight-routing'),
      preflightHostRemoval: async ({ host }) => events.push(`preflight-${host}`),
      removeRouting: async () => events.push('remove-routing'),
      uninstallClaude: async () => events.push('remove-claude'),
      uninstallCodex: async () => events.push('remove-codex'),
      saveConfig: async () => events.push('save'),
      deleteToken: async () => events.push('delete-token'),
      removeDataDir: async () => events.push('remove-data'),
    },
  );

  assert.deepEqual(events, [
    'preflight-routing',
    'preflight-claude',
    'preflight-codex',
    'remove-routing',
    'remove-claude',
    'remove-codex',
    'save',
  ]);
  assert.equal(report.dataRetained, true);
  assert.equal(report.keychainRetained, true);
});

test('host-selective uninstall removes only exact selected ownership and retains the other host', async () => {
  const events = [];
  const sha = 'a'.repeat(64);
  const config = validConfig({
    profile: 'full',
    managed: {
      files: [
        { path: '/home/test/.claude/rules/fast-browser-routing.md', sha256: sha },
        { path: '/home/test/.claude/rules/fast-browser-verification-consent.md', sha256: sha },
        { path: '/home/test/.codex/agents/browser_driver.toml', sha256: sha },
      ],
      blocks: [
        {
          path: '/home/test/.codex/AGENTS.md',
          id: 'routing-v1',
          kind: 'markdown',
          sha256: sha,
        },
        {
          path: '/home/test/.codex/config.toml',
          id: 'mcp-policy-v1',
          kind: 'toml',
          sha256: sha,
        },
      ],
    },
  });
  let retained;
  const report = await uninstall(
    { hosts: ['claude'], purgeData: false },
    {
      paths: { dataDir: '/home/test/.fast-browser', homeDir: '/home/test' },
      loadConfig: async () => config,
      preflightRouting: async ({ managedState }) => {
        events.push(`preflight:${managedState.files.length}:${managedState.blocks.length}`);
        assert.deepEqual(
          managedState.files.map(({ path: target }) => target),
          [
            '/home/test/.claude/rules/fast-browser-routing.md',
            '/home/test/.claude/rules/fast-browser-verification-consent.md',
          ],
        );
      },
      preflightHostRemoval: async ({ host }) => events.push(`preflight-host:${host}`),
      removeRouting: async ({ managedState }) => {
        events.push(`remove-routing:${managedState.files.length}:${managedState.blocks.length}`);
      },
      uninstallClaude: async () => events.push('remove-claude'),
      uninstallCodex: async () => assert.fail('Codex registration must remain'),
      saveConfig: async (_paths, value) => {
        retained = value;
        events.push('save');
      },
    },
  );
  assert.deepEqual(events, [
    'preflight:2:0',
    'preflight-host:claude',
    'remove-routing:2:0',
    'remove-claude',
    'save',
  ]);
  assert.deepEqual(report.hosts, ['claude']);
  assert.deepEqual(retained.hosts, { claude: false, codex: true });
  assert.deepEqual(retained.managed, {
    files: [{ path: '/home/test/.codex/agents/browser_driver.toml', sha256: sha }],
    blocks: config.managed.blocks,
  });

  const secondEvents = [];
  let finalConfig;
  await uninstall(
    { hosts: ['codex'], purgeData: false },
    {
      paths: { dataDir: '/home/test/.fast-browser', homeDir: '/home/test' },
      loadConfig: async () => retained,
      preflightRouting: async ({ managedState }) => {
        secondEvents.push(`preflight:${managedState.files.length}:${managedState.blocks.length}`);
      },
      preflightHostRemoval: async ({ host }) => secondEvents.push(`preflight-host:${host}`),
      removeRouting: async ({ managedState }) => {
        secondEvents.push(`remove-routing:${managedState.files.length}:${managedState.blocks.length}`);
      },
      uninstallCodex: async () => secondEvents.push('remove-codex'),
      saveConfig: async (_paths, value) => {
        finalConfig = value;
        secondEvents.push('save');
      },
    },
  );
  assert.deepEqual(secondEvents, [
    'preflight:1:2',
    'preflight-host:codex',
    'remove-routing:1:2',
    'remove-codex',
    'save',
  ]);
  assert.deepEqual(finalConfig.hosts, { claude: false, codex: false });
  assert.deepEqual(finalConfig.managed, { files: [], blocks: [] });
});

test('host-selective uninstall fails closed on unclassifiable managed records', async () => {
  const events = [];
  await assert.rejects(
    uninstall(
      { hosts: ['claude'], purgeData: false },
      {
        paths: { dataDir: '/home/test/.fast-browser', homeDir: '/home/test' },
        loadConfig: async () => validConfig({
          managed: {
            files: [{ path: '/home/test/.config/unknown', sha256: 'a'.repeat(64) }],
            blocks: [],
          },
        }),
        preflightRouting: async () => events.push('preflight'),
        removeRouting: async () => events.push('remove'),
        uninstallClaude: async () => events.push('host'),
        saveConfig: async () => events.push('save'),
      },
    ),
    /unclassifiable|managed ownership/i,
  );
  assert.deepEqual(events, []);
});

test('host-selective uninstall refuses purge while another configured host would remain', async () => {
  const events = [];
  const config = validConfig({ managed: { files: [], blocks: [] } });
  await assert.rejects(
    uninstall(
      {
        hosts: ['claude'],
        purgeData: true,
        dataDir: '/home/test/.fast-browser',
      },
      {
        paths: { dataDir: '/home/test/.fast-browser', homeDir: '/home/test' },
        loadConfig: async () => config,
        preflightRouting: async () => events.push('preflight-routing'),
        preflightHostRemoval: async () => events.push('preflight-host'),
        inspectDataDir: async () => events.push('inspect-data'),
        confirmPurge: async () => events.push('confirm-purge'),
        removeRouting: async () => events.push('remove-routing'),
        uninstallClaude: async () => events.push('remove-claude'),
        removeDataDir: async () => events.push('remove-data'),
        saveConfig: async () => events.push('save'),
      },
    ),
    /purge.*all configured hosts|configured host.*remain/i,
  );
  assert.deepEqual(config.hosts, { claude: true, codex: true });
  assert.deepEqual(events, []);
});

test('purge refuses aliases and requires explicit confirmation', async () => {
  const base = {
    hosts: [],
    purgeData: true,
    dataDir: '/home/test/.fast-browser/../.fast-browser',
  };
  const deps = {
    paths: { dataDir: '/home/test/.fast-browser', homeDir: '/home/test' },
    loadConfig: async () => validConfig({ hosts: { claude: false, codex: false } }),
    preflightRouting: async () => {},
    removeRouting: async () => {},
    saveConfig: async () => {},
    confirmPurge: async () => true,
    inspectDataDir: async () => ({ isDirectory: true, isSymbolicLink: false, realpath: '/home/test/.fast-browser' }),
    removeDataDir: async () => assert.fail('must not remove an aliased request path'),
  };
  await assert.rejects(uninstall(base, deps), /exact data directory/i);

  let removed = false;
  const report = await uninstall(
    { ...base, dataDir: '/home/test/.fast-browser' },
    {
      ...deps,
      confirmPurge: async () => true,
      removeDataDir: async (target) => {
        assert.equal(target, '/home/test/.fast-browser');
        removed = true;
      },
    },
  );
  assert.equal(removed, true);
  assert.equal(report.dataRetained, false);
});

test('purge revalidates the exact root immediately before deletion', async () => {
  let inspections = 0;
  await assert.rejects(
    uninstall(
      {
        hosts: [],
        purgeData: true,
        dataDir: '/home/test/.fast-browser',
      },
      {
        paths: { dataDir: '/home/test/.fast-browser', homeDir: '/home/test' },
        loadConfig: async () => validConfig({ hosts: { claude: false, codex: false } }),
        preflightRouting: async () => {},
        removeRouting: async () => {},
        confirmPurge: async () => true,
        inspectDataDir: async () => {
          inspections += 1;
          return inspections === 1
            ? {
              isDirectory: true,
              isSymbolicLink: false,
              realpath: '/home/test/.fast-browser',
              dev: 1,
              ino: 2,
            }
            : {
              isDirectory: false,
              isSymbolicLink: true,
              realpath: '/outside',
              dev: 3,
              ino: 4,
            };
        },
        removeDataDir: async () => assert.fail('changed root must not be removed'),
      },
    ),
    /changed|replaced/i,
  );
  assert.equal(inspections, 2);
});

test('production purge confirmation requires a real TTY and exact affirmative answer', async () => {
  const base = {
    hosts: [],
    purgeData: true,
    dataDir: '/home/test/.fast-browser',
    json: false,
  };
  const paths = { dataDir: '/home/test/.fast-browser', homeDir: '/home/test' };
  const inspected = {
    isDirectory: true,
    isSymbolicLink: false,
    realpath: '/home/test/.fast-browser',
    dev: 1,
    ino: 2,
  };
  const common = {
    paths,
    loadConfig: async () => validConfig({ hosts: { claude: false, codex: false } }),
    preflightRouting: async () => {},
    removeRouting: async () => {},
    inspectDataDir: async () => inspected,
    saveConfig: async () => {},
  };
  for (const fixture of [
    { interactive: false, json: false, answer: 'PURGE' },
    { interactive: true, json: true, answer: 'PURGE' },
    { interactive: true, json: false, answer: 'no' },
  ]) {
    const events = [];
    await assert.rejects(
      uninstall(
        { ...base, json: fixture.json },
        {
          ...common,
          interactive: fixture.interactive,
          input: { isTTY: fixture.interactive },
          output: { isTTY: fixture.interactive },
          createInterface: () => ({
            question: async () => {
              events.push('prompt');
              return fixture.answer;
            },
            close: () => events.push('close'),
          }),
          removeDataDir: async () => events.push('remove'),
        },
      ),
      /confirmation/i,
    );
    assert.equal(events.includes('remove'), false);
  }

  const events = [];
  const report = await uninstall(
    base,
    {
      ...common,
      interactive: true,
      input: { isTTY: true },
      output: { isTTY: true },
      createInterface: () => ({
        question: async () => {
          events.push('prompt');
          return 'PURGE';
        },
        close: () => events.push('close'),
      }),
      removeDataDir: async () => events.push('remove'),
    },
  );
  assert.equal(report.dataRetained, false);
  assert.deepEqual(events, ['prompt', 'close', 'remove']);
});

test('ordinary uninstall reports recoverable state when retained config cannot be saved', async () => {
  await assert.rejects(
    uninstall(
      { hosts: ['claude'], purgeData: false },
      {
        paths: { dataDir: '/home/test/.fast-browser', homeDir: '/home/test' },
        loadConfig: async () => validConfig({ hosts: { claude: true, codex: false } }),
        preflightRouting: async () => {},
        preflightHostRemoval: async () => {},
        removeRouting: async () => {},
        uninstallClaude: async () => {},
        saveConfig: async () => {
          throw new Error('/Users/secret');
        },
      },
    ),
    (error) => {
      assert.equal(error.name, 'LifecycleError');
      assert.equal(error.stage, 'save-retained-config');
      assert.deepEqual(error.partialState.removedHosts, ['claude']);
      assert.equal(error.partialState.dataRetained, true);
      assert.doesNotMatch(error.message, /Users|secret/);
      return true;
    },
  );
});

test('CLI main renders exact setup human ending and JSON without invoking other commands', async () => {
  const writes = [];
  const report = {
    command: 'setup',
    hosts: ['claude', 'codex'],
    profile: 'full',
    extensionPath: '/tmp/extension',
    extensionManual: true,
    changed: true,
  };
  const exitCode = await main(
    { command: 'setup', json: false },
    {
      commands: {
        setup: async () => report,
        doctor: async () => assert.fail('wrong command'),
      },
      write: (text) => writes.push(text),
    },
  );
  assert.equal(exitCode, 0);
  assert.equal(writes.join(''), [
    'Fast Browser is configured for: Claude Code, Codex',
    'Profile: full',
    'Chrome extension: manual installation required at /tmp/extension',
    'Next: load the extension, then run `fast-browser doctor`',
    '',
  ].join('\n'));

  writes.length = 0;
  await main(
    { command: 'setup', json: true },
    { commands: { setup: async () => report }, write: (text) => writes.push(text) },
  );
  assert.deepEqual(JSON.parse(writes.join('')), report);
});

test('CLI help and version are side-effect free', async () => {
  const writes = [];
  const commands = new Proxy({}, { get: () => () => assert.fail('command invoked') });
  assert.equal(await main({ help: true }, { commands, write: (text) => writes.push(text) }), 0);
  assert.equal(await main({ version: true }, { commands, write: (text) => writes.push(text) }), 0);
  assert.equal(writes.length, 2);
});

test('CLI production dispatch composes setup entirely from injected adapters', async () => {
  const writes = [];
  const events = [];
  const exitCode = await main(
    {
      command: 'setup',
      hosts: ['claude'],
      profile: 'safe',
      source: '/repo/mattstack',
      runtimeLock: null,
      json: true,
    },
    {
      write: (text) => writes.push(text),
      checkPlatform: async () => events.push('platform'),
      detectHosts: async () => ['claude'],
      ensureDataDirs: async () => events.push('dirs'),
      loadRuntimeLock: async () => ({
        productVersion: '0.1.0-alpha.1',
        runtime: { sha256: 'a'.repeat(64), sourceCommit: 'abc' },
        extension: { id: 'extension-id', version: '1.0.0' },
      }),
      installRuntime: async () => ({ version: '0.1.0-alpha.1' }),
      installExtension: async () => ({ unpacked: '/tmp/extension' }),
      installClaude: async () => ({ host: 'claude', changed: false, changes: [] }),
      installBuiltinMacros: async () => {},
      installRouting: async () => ({ profile: 'safe', files: [], blocks: [] }),
      saveConfig: async () => events.push('save'),
      doctor: async () => ({ schemaVersion: 1, ok: true, profile: 'safe', checks: [] }),
      loadConfig: async () => null,
      isSetupCurrent: async () => false,
      paths: {},
      interactive: false,
    },
  );
  assert.equal(exitCode, 0);
  assert.deepEqual(events, ['platform', 'dirs', 'save']);
  assert.equal(JSON.parse(writes.join('')).command, 'setup');
});
