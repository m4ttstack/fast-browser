import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { configure } from '../../lib/commands/configure.mjs';
import {
  doctor,
  isPreferredCodexModelRejection,
  runCodexBrowserDriverSmoke,
} from '../../lib/commands/doctor.mjs';
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
import { resolvePaths } from '../../lib/core/paths.mjs';
import {
  installRouting,
  preflightRoutingRemoval,
} from '../../lib/hosts/routing.mjs';
import {
  ROUTING_TRANSACTION_RECOVERY_REQUIRED,
  RoutingTransactionError,
} from '../../lib/hosts/file-transaction.mjs';
import { PairingError } from '../../lib/keychain/pair.mjs';
import { buildContentManifestDigest } from '../../lib/extension/content-manifest.mjs';

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

test('doctor keeps the 17-check schema healthy for an unselected host', async () => {
  const passing = Object.fromEntries(DOCTOR_CHECK_IDS
    .filter((id) => ![
      'claude-cli',
      'claude-plugin',
      'claude-routing',
      'codex-cli',
      'codex-plugin',
      'codex-routing',
      'browser-driver',
    ].includes(id))
    .map((id) => [id, async () => ({
      status: 'pass',
      message: `${id} passed.`,
      remediation: null,
    })]));
  const report = await doctor(
    { profile: 'safe' },
    {
      config: validConfig({
        hosts: { claude: true, codex: false },
        managed: { files: [], blocks: [] },
      }),
      detectHosts: async () => ['claude'],
      preflightClaude: async () => ({ installed: true }),
      preflightRouting: async () => {},
      checks: passing,
      paths: {
        homeDir: '/home/test',
        dataDir: '/home/test/.fast-browser',
        configFile: '/home/test/.fast-browser/config.json',
        runtimeDir: '/home/test/.fast-browser/runtime',
        extensionDir: '/home/test/.fast-browser/extension',
        pluginRoot: '/plugin',
      },
    },
  );

  assert.equal(report.checks.length, 17);
  assert.equal(report.ok, true);
  for (const id of ['codex-cli', 'codex-plugin', 'codex-routing', 'browser-driver']) {
    assert.equal(report.checks.find((check) => check.id === id).status, 'pass');
  }
});

test('Codex browser-driver smoke uses one bounded ephemeral read-only execution', async () => {
  const calls = [];
  await runCodexBrowserDriverSmoke({
    cwd: '/repo',
    run: async (command, args, options) => {
      calls.push([command, args, options]);
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'FAST_BROWSER_DRIVER_OK' },
        })}\n`,
        stderr: '',
      };
    },
  });

  assert.deepEqual(calls, [[
    'codex',
    [
      'exec',
      '--ephemeral',
      '--sandbox',
      'read-only',
      '--json',
      '--skip-git-repo-check',
      '-C',
      '/repo',
      'Delegate to browser_driver. Return exactly FAST_BROWSER_DRIVER_OK without using browser tools.',
    ],
    { timeoutMs: 60_000 },
  ]]);
});

test('Codex browser-driver smoke omits --ask-for-approval, which exec rejects as an unknown flag', async () => {
  const calls = [];
  await runCodexBrowserDriverSmoke({
    cwd: '/repo',
    run: async (command, args, options) => {
      calls.push([command, args, options]);
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'FAST_BROWSER_DRIVER_OK' },
        })}\n`,
        stderr: '',
      };
    },
  });

  const [, args] = calls[0];
  assert.equal(args.includes('--ask-for-approval'), false);
  assert.equal(args.includes('never'), false);
});

test('Codex browser-driver smoke allows 60 seconds for a real agent run', async () => {
  const calls = [];
  await runCodexBrowserDriverSmoke({
    cwd: '/repo',
    run: async (command, args, options) => {
      calls.push([command, args, options]);
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'FAST_BROWSER_DRIVER_OK' },
        })}\n`,
        stderr: '',
      };
    },
  });

  const [, , options] = calls[0];
  assert.equal(options.timeoutMs, 60_000);
});

test('Codex smoke recognizes only structured rejection of the preferred model', async () => {
  let preferred;
  try {
    await runCodexBrowserDriverSmoke({
      cwd: '/repo',
      run: async () => ({
        exitCode: 1,
        stdout: `${JSON.stringify({
          type: 'error',
          error: {
            code: 'model_not_found',
            model: 'gpt-5.6-terra',
            message: 'preferred model unavailable',
          },
        })}\n`,
        stderr: '',
      }),
    });
  } catch (error) {
    preferred = error;
  }
  assert.equal(isPreferredCodexModelRejection(preferred), true);

  let unrelated;
  try {
    await runCodexBrowserDriverSmoke({
      cwd: '/repo',
      run: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'model_not_found gpt-5.6-terra',
      }),
    });
  } catch (error) {
    unrelated = error;
  }
  assert.equal(isPreferredCodexModelRejection(unrelated), false);
});

test('doctor rewrites one still-owned preferred Codex agent, persists its hash, and retries once', async () => {
  const events = [];
  const original = validConfig({
    hosts: { claude: false, codex: true },
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
  const updatedState = {
    profile: 'safe',
    files: [{
      path: '/home/test/.codex/agents/browser_driver.toml',
      sha256: 'c'.repeat(64),
    }],
    blocks: original.managed.blocks,
  };
  let attempts = 0;
  let saved;
  const checks = Object.fromEntries(DOCTOR_CHECK_IDS
    .filter((id) => id !== 'browser-driver')
    .map((id) => [id, async () => ({
      status: 'pass',
      message: `${id} passed.`,
      remediation: null,
    })]));

  const report = await doctor(
    { profile: 'safe' },
    {
      config: original,
      checks,
      preflightRouting: async () => events.push('preflight-routing'),
      runCodexAgentSmoke: async () => {
        attempts += 1;
        events.push(`smoke:${attempts}`);
        if (attempts === 1) {
          const error = new Error('preferred model unavailable');
          error.name = 'CodexBrowserDriverSmokeError';
          error.code = 'MODEL_NOT_FOUND';
          error.model = 'gpt-5.6-terra';
          throw error;
        }
      },
      beginOwnedCodexAgentFallback: async ({ managedState }) => {
        events.push(`rewrite:${managedState.files[0].sha256}`);
        return { managedState: updatedState, rollback: async () => assert.fail('must not roll back') };
      },
      saveConfig: async (_paths, config) => {
        events.push('save-config');
        saved = config;
      },
      paths: {
        homeDir: '/home/test',
        dataDir: '/home/test/.fast-browser',
        configFile: '/home/test/.fast-browser/config.json',
        runtimeDir: '/home/test/.fast-browser/runtime',
        extensionDir: '/home/test/.fast-browser/extension',
        pluginRoot: '/plugin',
      },
    },
  );

  assert.equal(report.ok, true);
  assert.deepEqual(events, [
    'preflight-routing',
    'smoke:1',
    `rewrite:${'a'.repeat(64)}`,
    'save-config',
    'smoke:2',
  ]);
  assert.equal(saved.managed.files[0].sha256, 'c'.repeat(64));
  assert.equal(attempts, 2);
});

test('doctor restores the Codex agent when fallback config persistence fails', async (t) => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'fast-browser-doctor-fallback-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const paths = resolvePaths({
    homeDir,
    pluginRoot: path.resolve(import.meta.dirname, '../..'),
  });
  const managedState = await installRouting({
    profile: 'safe',
    paths,
    codexVersion: '0.145.0',
  });
  const agentPath = managedState.files[0].path;
  const originalBytes = await readFile(agentPath, 'utf8');
  const config = validConfig({
    hosts: { claude: false, codex: true },
    managed: { files: managedState.files, blocks: managedState.blocks },
  });
  await mkdir(paths.dataDir, { recursive: true, mode: 0o700 });
  const originalConfigBytes = `${JSON.stringify(config, null, 2)}\n`;
  await writeFile(paths.configFile, originalConfigBytes, { mode: 0o600 });
  let smokeAttempts = 0;
  const attemptedConfigs = [];
  let attemptedAgentHash = null;
  const checks = Object.fromEntries(DOCTOR_CHECK_IDS
    .filter((id) => id !== 'browser-driver')
    .map((id) => [id, async () => ({
      status: 'pass',
      message: `${id} passed.`,
      remediation: null,
    })]));

  const report = await doctor(
    { profile: 'safe' },
    {
      paths,
      config,
      checks,
      runCodexAgentSmoke: async () => {
        smokeAttempts += 1;
        const error = new Error('preferred model unavailable');
        error.name = 'CodexBrowserDriverSmokeError';
        error.code = 'MODEL_NOT_FOUND';
        error.model = 'gpt-5.6-terra';
        throw error;
      },
      saveConfig: async (_paths, nextConfig) => {
        attemptedConfigs.push(structuredClone(nextConfig));
        attemptedAgentHash = crypto.createHash('sha256')
          .update(await readFile(agentPath))
          .digest('hex');
        throw new Error('/Users/maintainer/private-config.json');
      },
    },
  );

  assert.equal(smokeAttempts, 1);
  assert.equal(await readFile(agentPath, 'utf8'), originalBytes);
  assert.equal(attemptedConfigs.length, 1);
  assert.equal(attemptedConfigs[0].managed.files[0].sha256, attemptedAgentHash);
  assert.notEqual(attemptedAgentHash, managedState.files[0].sha256);
  assert.equal(await readFile(paths.configFile, 'utf8'), originalConfigBytes);
  const browserDriverCheck = report.checks.find(({ id }) => id === 'browser-driver');
  assert.equal(browserDriverCheck.status, 'fail');
  assert.deepEqual(await preflightRoutingRemoval({ paths, managedState }), {
    files: [{ path: agentPath, exists: true }],
    blocks: managedState.blocks.map(({ path: target, id, kind }) => ({
      path: target,
      id,
      kind,
      exists: true,
    })),
  });
  assert.doesNotMatch(browserDriverCheck.message, /model =|maintainer|private-config/i);
  assert.doesNotMatch(JSON.stringify(report), /model =|maintainer|private-config/i);
});

test('doctor reports recovery required without exposing fallback bytes when rollback fails', async () => {
  const config = validConfig({
    hosts: { claude: false, codex: true },
    managed: {
      files: [{
        path: '/home/test/.codex/agents/browser_driver.toml',
        sha256: 'a'.repeat(64),
      }],
      blocks: [],
    },
  });
  const checks = Object.fromEntries(DOCTOR_CHECK_IDS
    .filter((id) => id !== 'browser-driver')
    .map((id) => [id, async () => ({
      status: 'pass',
      message: `${id} passed.`,
      remediation: null,
    })]));
  let smokeAttempts = 0;

  const report = await doctor(
    { profile: 'safe' },
    {
      config,
      checks,
      preflightRouting: async () => {},
      runCodexAgentSmoke: async () => {
        smokeAttempts += 1;
        const error = new Error('preferred model unavailable');
        error.name = 'CodexBrowserDriverSmokeError';
        error.code = 'MODEL_NOT_FOUND';
        error.model = 'gpt-5.6-terra';
        throw error;
      },
      beginOwnedCodexAgentFallback: async () => ({
        managedState: {
          profile: 'safe',
          files: [{
            path: '/home/test/.codex/agents/browser_driver.toml',
            sha256: 'c'.repeat(64),
          }],
          blocks: [],
        },
        rollback: async () => {
          throw new Error('/Users/maintainer/original-bytes');
        },
      }),
      saveConfig: async () => {
        throw new Error('/Users/maintainer/private-config.json');
      },
      paths: {
        homeDir: '/home/test',
        dataDir: '/home/test/.fast-browser',
        configFile: '/home/test/.fast-browser/config.json',
        runtimeDir: '/home/test/.fast-browser/runtime',
        extensionDir: '/home/test/.fast-browser/extension',
        pluginRoot: '/plugin',
      },
    },
  );

  const browserDriverCheck = report.checks.find(({ id }) => id === 'browser-driver');
  assert.equal(smokeAttempts, 1);
  assert.equal(browserDriverCheck.status, 'fail');
  assert.match(browserDriverCheck.message, /requires recovery/i);
  assert.doesNotMatch(JSON.stringify(report), /Users|maintainer|original-bytes|private-config/i);
});

test('doctor never rewrites or retries an unrelated Codex smoke failure', async () => {
  let rewrites = 0;
  let attempts = 0;
  const config = validConfig({
    hosts: { claude: false, codex: true },
    managed: {
      files: [{
        path: '/home/test/.codex/agents/browser_driver.toml',
        sha256: 'a'.repeat(64),
      }],
      blocks: [],
    },
  });
  const checks = Object.fromEntries(DOCTOR_CHECK_IDS
    .filter((id) => id !== 'browser-driver')
    .map((id) => [id, async () => ({
      status: 'pass',
      message: `${id} passed.`,
      remediation: null,
    })]));

  const report = await doctor(
    { profile: 'safe' },
    {
      config,
      checks,
      preflightRouting: async () => {},
      runCodexAgentSmoke: async () => {
        attempts += 1;
        throw new Error('network unavailable for gpt-5.6-terra');
      },
      beginOwnedCodexAgentFallback: async () => {
        rewrites += 1;
      },
      paths: {
        homeDir: '/home/test',
        dataDir: '/home/test/.fast-browser',
        configFile: '/home/test/.fast-browser/config.json',
        runtimeDir: '/home/test/.fast-browser/runtime',
        extensionDir: '/home/test/.fast-browser/extension',
        pluginRoot: '/plugin',
      },
    },
  );

  assert.equal(report.ok, false);
  assert.equal(report.checks.find(({ id }) => id === 'browser-driver').status, 'fail');
  assert.equal(attempts, 1);
  assert.equal(rewrites, 0);
});

test('doctor stops after an ownership mismatch instead of retrying a rewritten Codex agent', async () => {
  let attempts = 0;
  let saves = 0;
  const config = validConfig({
    hosts: { claude: false, codex: true },
    managed: {
      files: [{
        path: '/home/test/.codex/agents/browser_driver.toml',
        sha256: 'a'.repeat(64),
      }],
      blocks: [],
    },
  });
  const checks = Object.fromEntries(DOCTOR_CHECK_IDS
    .filter((id) => id !== 'browser-driver')
    .map((id) => [id, async () => ({
      status: 'pass',
      message: `${id} passed.`,
      remediation: null,
    })]));

  const report = await doctor(
    { profile: 'safe' },
    {
      config,
      checks,
      preflightRouting: async () => {},
      runCodexAgentSmoke: async () => {
        attempts += 1;
        const error = new Error('preferred model unavailable');
        error.name = 'CodexBrowserDriverSmokeError';
        error.code = 'MODEL_NOT_FOUND';
        error.model = 'gpt-5.6-terra';
        throw error;
      },
      beginOwnedCodexAgentFallback: async () => {
        throw new Error('Codex agent ownership hash changed');
      },
      saveConfig: async () => {
        saves += 1;
      },
      paths: {
        homeDir: '/home/test',
        dataDir: '/home/test/.fast-browser',
        configFile: '/home/test/.fast-browser/config.json',
        runtimeDir: '/home/test/.fast-browser/runtime',
        extensionDir: '/home/test/.fast-browser/extension',
        pluginRoot: '/plugin',
      },
    },
  );

  assert.equal(report.ok, false);
  assert.equal(report.checks.find(({ id }) => id === 'browser-driver').status, 'fail');
  assert.equal(attempts, 1);
  assert.equal(saves, 0);
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
      runCodexAgentSmoke: async () => {},
      checkRuntime: async () => {},
      checkExtensionArtifact: async () => {},
      detectChromeExtension: async () => [{
        profile: 'Default',
        installed: true,
        manifestVersion: '1.0.0',
        path: '/home/test/.fast-browser/extension/1.0.0/unpacked',
      }],
      verifyExtensionContent: async () => true,
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

function extensionLock(version) {
  return {
    productVersion: '0.1.0-alpha.1',
    runtime: { node: '>=20' },
    extension: { id: 'extension-id', version },
  };
}

// Builds a real, on-disk "already installed" extension: an unpacked
// directory plus the installed.json marker install-time content digest, the
// way extension/install.mjs leaves it after a verified install.
async function setupManagedExtension(version, files) {
  const home = await mkdtemp(path.join(tmpdir(), 'fast-browser-ext-content-'));
  const extensionDir = path.join(home, 'extension');
  const versionDir = path.join(extensionDir, version);
  const unpacked = path.join(versionDir, 'unpacked');
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(unpacked, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  const lock = extensionLock(version);
  const contentDigest = await buildContentManifestDigest(unpacked);
  await writeFile(
    path.join(versionDir, 'installed.json'),
    `${JSON.stringify({ schemaVersion: 1, lock: runtimeLockIdentity(lock), contentDigest }, null, 2)}\n`,
  );
  return { extensionDir, unpacked, lock };
}

async function extensionInstalledStatus({ extensionDir, lock, profiles }) {
  const stubbed = Object.fromEntries(DOCTOR_CHECK_IDS
    .filter((id) => id !== 'extension-installed')
    .map((id) => [id, async () => ({ status: 'pass', message: `${id} passed.`, remediation: null })]));
  const report = await doctor(
    { profile: 'safe' },
    {
      checks: stubbed,
      paths: {
        homeDir: '/unused',
        dataDir: '/unused',
        configFile: '/unused',
        runtimeDir: '/unused',
        extensionDir,
        pluginRoot: '/unused',
      },
      lock,
      detectChromeExtension: async () => profiles,
    },
  );
  return report.checks.find(({ id }) => id === 'extension-installed');
}

test('extension-installed passes when the loaded path is the managed directory and content matches', async () => {
  const { extensionDir, unpacked, lock } = await setupManagedExtension('1.0.0', {
    'manifest.json': '{"version":"1.0.0"}',
    'lib/background.mjs': 'export const x = 1;\n',
  });

  const status = await extensionInstalledStatus({
    extensionDir,
    lock,
    profiles: [{ profile: 'Default', installed: true, manifestVersion: '1.0.0', path: unpacked }],
  });

  assert.deepEqual(status, {
    id: 'extension-installed',
    status: 'pass',
    message: 'The pinned Chrome extension is installed.',
    remediation: null,
  });
});

test('extension-installed fails when the loaded path matches but one file\'s bytes differ (the exact incident)', async () => {
  const { extensionDir, unpacked, lock } = await setupManagedExtension('1.0.0', {
    'manifest.json': '{"version":"1.0.0"}',
    'lib/background.mjs': 'export const x = 1;\n',
  });
  // Simulate drift after install: the same on-disk directory now has
  // different bytes than what was verified and recorded at install time.
  await writeFile(path.join(unpacked, 'lib', 'background.mjs'), 'export const x = 2;\n');

  const status = await extensionInstalledStatus({
    extensionDir,
    lock,
    profiles: [{ profile: 'Default', installed: true, manifestVersion: '1.0.0', path: unpacked }],
  });

  assert.deepEqual(status, {
    id: 'extension-installed',
    status: 'fail',
    message: 'The installed Chrome extension does not match the verified artifact content.',
    remediation: 'Run `fast-browser setup` to reinstall the pinned extension.',
  });
});

test('extension-installed fails when Chrome reports a loaded path outside the managed directory', async () => {
  const { extensionDir, lock } = await setupManagedExtension('1.0.0', {
    'manifest.json': '{"version":"1.0.0"}',
    'lib/background.mjs': 'export const x = 1;\n',
  });
  const elsewhere = await mkdtemp(path.join(tmpdir(), 'fast-browser-ext-elsewhere-'));
  await mkdir(path.join(elsewhere, 'lib'), { recursive: true });
  await writeFile(path.join(elsewhere, 'manifest.json'), '{"version":"1.0.0"}');
  await writeFile(path.join(elsewhere, 'lib', 'background.mjs'), 'export const x = 1;\n');

  const status = await extensionInstalledStatus({
    extensionDir,
    lock,
    profiles: [{ profile: 'Default', installed: true, manifestVersion: '1.0.0', path: elsewhere }],
  });

  assert.deepEqual(status, {
    id: 'extension-installed',
    status: 'fail',
    message: 'The installed Chrome extension does not match the verified artifact content.',
    remediation: 'Run `fast-browser setup` to reinstall the pinned extension.',
  });
});

test('extension-installed fails, unchanged, when the extension is absent entirely', async () => {
  const { extensionDir, lock } = await setupManagedExtension('1.0.0', {
    'manifest.json': '{"version":"1.0.0"}',
  });

  const status = await extensionInstalledStatus({
    extensionDir,
    lock,
    profiles: [{ profile: 'Default', installed: false, manifestVersion: null, path: null }],
  });

  assert.deepEqual(status, {
    id: 'extension-installed',
    status: 'fail',
    message: 'The pinned Chrome extension is not installed.',
    remediation: 'Load the unpacked extension artifact in Google Chrome.',
  });
});

test('extension-installed fails on content drift even though the version string still matches the lock', async () => {
  const { extensionDir, unpacked, lock } = await setupManagedExtension('1.0.0', {
    'manifest.json': '{"version":"1.0.0"}',
    'lib/background.mjs': 'export const x = 1;\n',
  });
  // The manifest version is untouched: a version-string-only check would
  // still say PASS here. An extra file proves content, not just the
  // version, is what the check now verifies.
  await writeFile(path.join(unpacked, 'lib', 'extra.mjs'), 'export const y = 1;\n');

  const profiles = [{ profile: 'Default', installed: true, manifestVersion: '1.0.0', path: unpacked }];
  const status = await extensionInstalledStatus({ extensionDir, lock, profiles });

  assert.equal(status.status, 'fail');
  assert.equal(
    JSON.parse(await readFile(path.join(unpacked, 'manifest.json'), 'utf8')).version,
    lock.extension.version,
  );
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
  let rollbacks = 0;
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
      prepareRoutingTransition: async ({ profile, hosts, managedState }) => {
        events.push(`routing:${profile}:${hosts.join('+')}:${managedState.profile ?? 'none'}`);
        return {
          nextState: managed,
          apply: async () => ({ rollback: async () => { rollbacks += 1; } }),
        };
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
  assert.deepEqual(events, ['routing:full:claude+codex:safe', 'save:17']);
  assert.equal(rollbacks, 0);
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
      prepareRoutingTransition: async () => ({
        nextState: { profile: 'full', files: [], blocks: [] },
        apply: async () => ({ rollback: async () => {} }),
      }),
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

test('configure uses the exact routing receipt when config persistence fails', async () => {
  const events = [];
  const routing = { profile: 'full', files: [], blocks: [] };
  await assert.rejects(
    configure(
      { profile: 'full', connection: null, recordSessions: null, retentionDays: null },
      {
        loadConfig: async () => validConfig(),
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
        installRouting: async ({ profile, managedState }) => {
          events.push(`routing:obsolete-render:${profile}:${managedState?.profile ?? 'none'}`);
          return routing;
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
  assert.deepEqual(events, [
    'routing:prepare',
    'routing:apply',
    'save',
    'routing:rollback',
  ]);
});

test('configure rolls back the routing receipt for plain, automatic, and manual persistence failures', async () => {
  const cases = [
    {
      name: 'plain',
      request: { profile: 'full', connection: null, recordSessions: null, retentionDays: null },
      dependencies: {},
      pairingError: false,
    },
    {
      name: 'automatic',
      request: { profile: 'full', connection: 'auto', recordSessions: null, retentionDays: null },
      dependencies: {
        hasToken: async () => false,
        pairAutoConnect: async (config, { updateConfig }) => {
          try {
            await updateConfig(config);
          } catch {
            throw new PairingError('automatic pairing save failed');
          }
        },
      },
      pairingError: true,
    },
    {
      name: 'manual',
      request: { profile: 'full', connection: 'manual', recordSessions: null, retentionDays: null },
      dependencies: {
        setManualConnection: async (config, { updateConfig }) => {
          try {
            await updateConfig(config);
          } catch {
            throw new PairingError('manual pairing save failed');
          }
        },
      },
      pairingError: true,
    },
  ];

  for (const entry of cases) {
    const events = [];
    await assert.rejects(
      configure(entry.request, {
        loadConfig: async () => validConfig(),
        prepareRoutingTransition: async () => {
          events.push('routing:prepare');
          return {
            nextState: { profile: 'full', files: [], blocks: [] },
            apply: async () => {
              events.push('routing:apply');
              return { rollback: async () => events.push('routing:rollback') };
            },
          };
        },
        saveConfig: async () => {
          events.push('config:save');
          throw new Error('injected save failure');
        },
        paths: {},
        ...entry.dependencies,
      }),
      (error) => {
        if (entry.pairingError) {
          assert.equal(error.name, 'PairingError');
        } else {
          assert.equal(error.stage, 'save-config');
        }
        return true;
      },
      entry.name,
    );
    assert.deepEqual(events, [
      'routing:prepare',
      'routing:apply',
      'config:save',
      'routing:rollback',
    ]);
  }
});

test('configure keeps next routing when real manual connection saves before token deletion fails', async () => {
  const events = [];
  const current = validConfig({ connection: { mode: 'auto' } });
  const nextRouting = {
    profile: 'full',
    files: [{ path: '/next-owned', sha256: 'b'.repeat(64) }],
    blocks: [],
  };
  let routingSide = 'prior';
  let persisted = null;

  await assert.rejects(
    configure(
      {
        profile: 'full',
        connection: 'manual',
        recordSessions: false,
        retentionDays: 30,
      },
      {
        loadConfig: async () => current,
        prepareRoutingTransition: async () => ({
          nextState: nextRouting,
          apply: async () => {
            events.push('routing:apply-next');
            routingSide = 'next';
            return {
              rollback: async () => {
                events.push('routing:rollback-prior');
                routingSide = 'prior';
              },
            };
          },
        }),
        saveConfig: async (_paths, config) => {
          events.push('config:save-manual');
          persisted = structuredClone(config);
        },
        confirmDeleteToken: async () => true,
        deleteToken: async () => {
          events.push('keychain:delete-fail');
          throw new Error('/Users/maintainer/secret-token');
        },
        paths: {},
      },
    ),
    (error) => {
      assert.equal(error.name, 'PairingError');
      assert.match(error.message, /manual connection was saved/i);
      assert.doesNotMatch(error.message, /Users|maintainer|secret-token/);
      return true;
    },
  );

  assert.equal(routingSide, 'next');
  assert.deepEqual(persisted.connection, { mode: 'manual' });
  assert.deepEqual(persisted.managed, {
    files: nextRouting.files,
    blocks: [],
  });
  assert.deepEqual(events, [
    'routing:apply-next',
    'config:save-manual',
    'keychain:delete-fail',
  ]);
});

test('configure restores exact prior routing bytes from one real receipt', async (t) => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'fast-browser-configure-receipt-'));
  const paths = resolvePaths({ homeDir, pluginRoot: path.resolve(import.meta.dirname, '../..') });
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  await mkdir(paths.dataDir, { recursive: true, mode: 0o700 });
  const codexDir = path.join(homeDir, '.codex');
  const codexConfig = path.join(codexDir, 'config.toml');
  await mkdir(codexDir, { recursive: true, mode: 0o700 });
  await writeFile(codexConfig, 'unrelated_setting = true\n');
  const priorRouting = await installRouting({
    profile: 'full',
    hosts: ['codex'],
    paths,
    codexVersion: 'codex-cli 0.145.0',
  });
  const previousBytes = await readFile(codexConfig, 'utf8');
  const current = validConfig({
    profile: 'full',
    hosts: { claude: false, codex: true },
    sessions: { enabled: true, retentionDays: 30 },
    managed: { files: priorRouting.files, blocks: priorRouting.blocks },
  });

  await assert.rejects(
    configure(
      { profile: 'safe', connection: null, recordSessions: null, retentionDays: null },
      {
        paths,
        loadConfig: async () => current,
        getCodexVersion: async () => 'codex-cli 0.145.0',
        saveConfig: async () => { throw new Error('injected save failure'); },
      },
    ),
    ({ stage }) => stage === 'save-config',
  );

  assert.equal(await readFile(codexConfig, 'utf8'), previousBytes);
  await preflightRoutingRemoval({
    paths,
    managedState: { profile: current.profile, ...current.managed },
  });
});

test('configure preserves external drift and redacts receipt-managed state on rollback failure', async (t) => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'fast-browser-configure-drift-'));
  const paths = resolvePaths({ homeDir, pluginRoot: path.resolve(import.meta.dirname, '../..') });
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  await mkdir(paths.dataDir, { recursive: true, mode: 0o700 });
  const routingPath = path.join(homeDir, '.claude', 'rules', 'fast-browser-routing.md');

  await assert.rejects(
    configure(
      { profile: 'full', connection: null, recordSessions: null, retentionDays: null },
      {
        paths,
        loadConfig: async () => validConfig({ hosts: { claude: true, codex: false } }),
        saveConfig: async () => {
          await writeFile(routingPath, 'external routing drift\n', { mode: 0o600 });
          throw new Error('injected save failure');
        },
      },
    ),
    (error) => {
      assert.equal(error.stage, 'save-config');
      assert.equal(error.partialState, null);
      assert.doesNotMatch(JSON.stringify(error), /fast-browser-routing|external routing drift/);
      return true;
    },
  );

  assert.equal(await readFile(routingPath, 'utf8'), 'external routing drift\n');
});

test('configure maps a routing recovery-required apply failure to its fixed recovery result', async () => {
  let saves = 0;

  await assert.rejects(
    configure(
      { profile: 'full', connection: null, recordSessions: false, retentionDays: 30 },
      {
        loadConfig: async () => validConfig({
          hosts: { claude: true, codex: false },
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
        paths: {},
      },
    ),
    (error) => {
      assert.equal(error.name, 'LifecycleError');
      assert.equal(error.stage, 'save-config');
      assert.equal(
        error.message,
        'Configure could not save config and routing requires recovery.',
      );
      assert.equal(error.code, 'ROUTING_TRANSACTION_RECOVERY_REQUIRED');
      assert.equal(error.partialState, null);
      return true;
    },
  );

  assert.equal(saves, 0);
});

test('configure retention failure keeps the durably tracked configuration', async () => {
  const events = [];
  await assert.rejects(
    configure(
      { profile: 'full', connection: null, recordSessions: null, retentionDays: null },
      {
        loadConfig: async () => validConfig(),
        prepareRoutingTransition: async () => ({
          nextState: { profile: 'full', files: [], blocks: [] },
          apply: async () => ({ rollback: async () => {} }),
        }),
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
      getCodexVersion: async () => {
        events.push('codex-version');
        return 'codex-cli 0.145.0';
      },
      prepareRoutingTransition: async ({ hosts, codexVersion }) => {
        events.push(`prepare-routing:${hosts.join('+')}:${codexVersion}`);
        return {
          nextState: { profile: 'safe', files: [], blocks: [] },
          apply: async () => {
            events.push('apply-routing');
            return {
              rollback: async () => {
                events.push('rollback-routing');
                return { rollback: async () => {} };
              },
            };
          },
        };
      },
      saveConfig: async () => events.push('save-config'),
      doctor: async () => {
        events.push('doctor');
        return { schemaVersion: 1, ok: true, profile: 'safe', checks: [] };
      },
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
    'codex-version',
    'prepare-routing:claude+codex:codex-cli 0.145.0',
    'apply-routing',
    'save-config',
    'doctor',
    'rollback-routing',
    'save-config',
    'remove-claude',
  ]);
  assert.deepEqual(report, { changed: true });
});

test('migration receipt restores prior routing and config after verification failure', async () => {
  const events = [];
  const previousConfig = validConfig({
    hosts: { claude: false, codex: true },
  });
  const nextState = { profile: 'safe', files: [], blocks: [] };

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
        loadConfig: async () => previousConfig,
        installClaude: async () => ({ host: 'claude', changed: false, changes: [] }),
        getCodexVersion: async () => '',
        prepareRoutingTransition: async () => {
          events.push('routing:prepare-next');
          return {
            nextState,
            apply: async () => {
              events.push('routing:apply-next');
              return {
                rollback: async () => {
                  events.push('routing:rollback-to-prior');
                  return { rollback: async () => {} };
                },
              };
            },
          };
        },
        installRouting: async ({ desiredState }) => {
          events.push(desiredState ? 'routing:reconstruct-prior' : 'routing:install-next');
          return desiredState ?? nextState;
        },
        saveConfig: async (_paths, config) => {
          events.push(config.hosts.codex ? 'config:save-prior' : 'config:save-next');
        },
        verify: async () => {
          events.push('verify:fail');
          throw new Error('injected verification failure');
        },
        applyMigration: async (options) => {
          let installedState = null;
          try {
            installedState = await options.installAdaptersAndRouting();
            await options.verify();
          } catch (cause) {
            await options.cleanupInstalled(installedState ?? cause.partialState);
            throw cause;
          }
        },
      },
    ),
    /verification failure/,
  );

  assert.deepEqual(events, [
    'routing:prepare-next',
    'routing:apply-next',
    'config:save-next',
    'verify:fail',
    'routing:rollback-to-prior',
    'config:save-prior',
  ]);
});

test('migration receipt restores prior routing without resaving config after next save failure', async () => {
  const events = [];
  const previousConfig = validConfig({
    hosts: { claude: false, codex: true },
  });

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
        loadConfig: async () => previousConfig,
        installClaude: async () => ({ host: 'claude', changed: false, changes: [] }),
        getCodexVersion: async () => '',
        prepareRoutingTransition: async () => {
          events.push('routing:prepare-next');
          return {
            nextState: { profile: 'safe', files: [], blocks: [] },
            apply: async () => {
              events.push('routing:apply-next');
              return {
                rollback: async () => {
                  events.push('routing:rollback-to-prior');
                  return { rollback: async () => {} };
                },
              };
            },
          };
        },
        installRouting: async () => {
          events.push('routing:install-next');
          return { profile: 'safe', files: [], blocks: [] };
        },
        saveConfig: async () => {
          events.push('config:save-next');
          throw new Error('injected next config save failure');
        },
        applyMigration: async (options) => {
          try {
            await options.installAdaptersAndRouting();
          } catch (cause) {
            await options.cleanupInstalled(cause.partialState);
            throw cause;
          }
        },
      },
    ),
    /Migration install failed/,
  );

  assert.deepEqual(events, [
    'routing:prepare-next',
    'routing:apply-next',
    'config:save-next',
    'routing:rollback-to-prior',
  ]);
});

test('migration reciprocal receipt reapplies next routing when prior config restore fails', async () => {
  const events = [];
  const previousConfig = validConfig({
    hosts: { claude: false, codex: true },
  });

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
        loadConfig: async () => previousConfig,
        installClaude: async () => ({ host: 'claude', changed: false, changes: [] }),
        getCodexVersion: async () => '',
        prepareRoutingTransition: async () => {
          events.push('routing:prepare-next');
          return {
            nextState: { profile: 'safe', files: [], blocks: [] },
            apply: async () => {
              events.push('routing:apply-next');
              return {
                rollback: async () => {
                  events.push('routing:rollback-to-prior');
                  return {
                    rollback: async () => {
                      events.push('routing:rollback-to-next');
                    },
                  };
                },
              };
            },
          };
        },
        installRouting: async ({ desiredState }) => {
          events.push(desiredState ? 'routing:reconstruct-prior' : 'routing:install-next');
          return desiredState ?? { profile: 'safe', files: [], blocks: [] };
        },
        saveConfig: async (_paths, config) => {
          if (config.hosts.codex) {
            events.push('config:save-prior:fail');
            throw new Error('/Users/maintainer/prior-config.json');
          }
          events.push('config:save-next');
        },
        verify: async () => {
          events.push('verify:fail');
          throw new Error('injected verification failure');
        },
        applyMigration: async (options) => {
          const installedState = await options.installAdaptersAndRouting();
          try {
            await options.verify();
          } catch (cause) {
            await options.cleanupInstalled(installedState);
            throw cause;
          }
        },
      },
    ),
    /verification failure/,
  );

  assert.deepEqual(events, [
    'routing:prepare-next',
    'routing:apply-next',
    'config:save-next',
    'verify:fail',
    'routing:rollback-to-prior',
    'config:save-prior:fail',
    'routing:rollback-to-next',
  ]);
});

test('migration private receipt state stays out of install metadata, partial state, and JSON output', async () => {
  const capturedPath = '/Users/maintainer/private-routing-target.md';
  const capturedTemplate = 'PRIVATE TEMPLATE CONTENT';
  const nextState = { profile: 'safe', files: [], blocks: [] };
  let rollbackCount = 0;
  let thrownPartialState = null;

  function containsFunction(value, seen = new Set()) {
    if (typeof value === 'function') return true;
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    return Object.values(value).some((entry) => containsFunction(entry, seen));
  }

  const dependencies = {
    paths: { homeDir: '/home/test', backupsDir: '/home/test/.fast-browser/backups' },
    loadConfig: async () => null,
    installClaude: async () => ({ host: 'claude', changed: false, changes: [] }),
    prepareRoutingTransition: async () => ({
      nextState,
      apply: async () => {
        const exactPriorBytes = Buffer.from(capturedTemplate);
        return {
          rollback: async () => {
            assert.equal(capturedPath.endsWith('private-routing-target.md'), true);
            assert.equal(exactPriorBytes.toString(), capturedTemplate);
            rollbackCount += 1;
            return { rollback: async () => {} };
          },
        };
      },
    }),
    installRouting: async () => ({
      ...nextState,
      receipt: {
        capturedPath,
        capturedTemplate,
        rollback: async () => {},
      },
    }),
  };

  const report = await migrate(
    {
      dryRun: false,
      rollback: null,
      hosts: ['claude'],
      source: '/repo/mattstack',
    },
    {
      ...dependencies,
      saveConfig: async () => {},
      applyMigration: async (options) => options.installAdaptersAndRouting(),
    },
  );
  assert.equal(containsFunction(report), false);
  assert.doesNotMatch(
    JSON.stringify(report),
    /receipt|private-routing-target|PRIVATE TEMPLATE CONTENT/,
  );

  await assert.rejects(
    migrate(
      {
        dryRun: false,
        rollback: null,
        hosts: ['claude'],
        source: '/repo/mattstack',
      },
      {
        ...dependencies,
        saveConfig: async () => {
          throw new Error('injected persistence failure');
        },
        applyMigration: async (options) => {
          try {
            await options.installAdaptersAndRouting();
          } catch (cause) {
            thrownPartialState = cause.partialState;
            await options.cleanupInstalled(cause.partialState);
            throw cause;
          }
        },
      },
    ),
    /Migration install failed/,
  );

  assert.equal(containsFunction(thrownPartialState), false);
  assert.doesNotMatch(
    JSON.stringify(thrownPartialState),
    /receipt|private-routing-target|PRIVATE TEMPLATE CONTENT/,
  );
  assert.equal(rollbackCount, 1);
});

test('migration cleanup restores prior routing after verification failure', async (t) => {
  const canonicalTemp = await realpath(tmpdir());
  const homeDir = await mkdtemp(path.join(canonicalTemp, 'fast-browser-migration-rollback-'));
  const paths = resolvePaths({ homeDir, pluginRoot: path.resolve(import.meta.dirname, '../..') });
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  await mkdir(paths.dataDir, { recursive: true, mode: 0o700 });

  const codexDir = path.join(paths.homeDir, '.codex');
  const codexAgents = path.join(codexDir, 'AGENTS.md');
  const codexOverride = path.join(codexDir, 'AGENTS.override.md');
  const codexConfig = path.join(codexDir, 'config.toml');
  await mkdir(codexDir, { recursive: true, mode: 0o700 });
  await writeFile(codexAgents, 'unrelated agent instructions\n');
  await writeFile(codexConfig, 'unrelated_setting = true\n');
  const priorRouting = await installRouting({
    profile: 'full',
    hosts: ['codex'],
    paths,
    codexVersion: 'codex-cli 0.145.0',
  });
  const previousConfig = validConfig({
    profile: 'full',
    hosts: { claude: false, codex: true },
    sessions: { enabled: true, retentionDays: 30 },
    managed: { files: priorRouting.files, blocks: priorRouting.blocks },
  });
  const previousConfigBytes = `${JSON.stringify(previousConfig, null, 2)}\n`;
  await writeFile(paths.configFile, previousConfigBytes, { mode: 0o600 });

  const codexAgent = path.join(codexDir, 'agents', 'browser_driver.toml');
  const priorAgentBytes = await readFile(codexAgent, 'utf8');
  const priorAgentsBytes = await readFile(codexAgents, 'utf8');
  const priorPolicyBytes = await readFile(codexConfig, 'utf8');
  const priorOwnershipSummary = await preflightRoutingRemoval({
    paths,
    managedState: { profile: previousConfig.profile, ...previousConfig.managed },
  });
  const unrelatedOverrideBytes = 'unrelated higher-precedence instructions\n';
  await writeFile(codexOverride, unrelatedOverrideBytes, { mode: 0o600 });
  const claudeRule = path.join(paths.homeDir, '.claude', 'rules', 'fast-browser-routing.md');

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
        installClaude: async () => ({ host: 'claude', changed: false, changes: [] }),
        getCodexVersion: async () => 'codex-cli 0.144.0',
        verify: async () => {
          throw new Error('injected verification failure');
        },
      },
    ),
    ({ stage }) => stage === 'verify',
  );

  assert.equal(await readFile(codexAgent, 'utf8'), priorAgentBytes);
  assert.equal(await readFile(codexAgents, 'utf8'), priorAgentsBytes);
  assert.equal(await readFile(codexOverride, 'utf8'), unrelatedOverrideBytes);
  assert.equal(await readFile(codexConfig, 'utf8'), priorPolicyBytes);
  assert.equal(await readFile(paths.configFile, 'utf8'), previousConfigBytes);
  assert.deepEqual(await preflightRoutingRemoval({
    paths,
    managedState: { profile: previousConfig.profile, ...previousConfig.managed },
  }), priorOwnershipSummary);
  await assert.rejects(access(claudeRule), { code: 'ENOENT' });
});

test('migration cleanup does not resave a prior config when the next config never persisted', async (t) => {
  const homeDir = await mkdtemp(path.join(await realpath(tmpdir()), 'fast-browser-migration-unsaved-'));
  const paths = resolvePaths({ homeDir, pluginRoot: path.resolve(import.meta.dirname, '../..') });
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  await mkdir(paths.dataDir, { recursive: true, mode: 0o700 });

  const priorRouting = await installRouting({
    profile: 'full',
    hosts: ['codex'],
    paths,
    codexVersion: 'codex-cli 0.145.0',
  });
  const previousConfig = validConfig({
    profile: 'full',
    hosts: { claude: false, codex: true },
    sessions: { enabled: true, retentionDays: 30 },
    managed: { files: priorRouting.files, blocks: priorRouting.blocks },
  });
  const previousConfigBytes = `${JSON.stringify(previousConfig, null, 2)}\n`;
  await writeFile(paths.configFile, previousConfigBytes, { mode: 0o600 });
  let saveAttempts = 0;

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
        installClaude: async () => ({ host: 'claude', changed: false, changes: [] }),
        getCodexVersion: async () => 'codex-cli 0.145.0',
        saveConfig: async () => {
          saveAttempts += 1;
          throw new Error('injected next config save failure');
        },
      },
    ),
    ({ stage }) => stage === 'install',
  );

  assert.equal(saveAttempts, 1);
  assert.equal(await readFile(paths.configFile, 'utf8'), previousConfigBytes);
  await preflightRoutingRemoval({
    paths,
    managedState: { profile: previousConfig.profile, ...previousConfig.managed },
  });
});

test('migration cleanup reconciles routing back to the persisted next config when prior save fails', async (t) => {
  const homeDir = await mkdtemp(path.join(await realpath(tmpdir()), 'fast-browser-migration-next-'));
  const paths = resolvePaths({ homeDir, pluginRoot: path.resolve(import.meta.dirname, '../..') });
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  await mkdir(paths.dataDir, { recursive: true, mode: 0o700 });

  const codexDir = path.join(paths.homeDir, '.codex');
  const codexAgents = path.join(codexDir, 'AGENTS.md');
  await mkdir(codexDir, { recursive: true, mode: 0o700 });
  await writeFile(codexAgents, 'unrelated prior instructions\n');
  const priorRouting = await installRouting({
    profile: 'full',
    hosts: ['codex'],
    paths,
    codexVersion: 'codex-cli 0.145.0',
  });
  const previousConfig = validConfig({
    profile: 'full',
    hosts: { claude: false, codex: true },
    sessions: { enabled: true, retentionDays: 30 },
    managed: { files: priorRouting.files, blocks: priorRouting.blocks },
  });
  await writeFile(paths.configFile, `${JSON.stringify(previousConfig, null, 2)}\n`, { mode: 0o600 });
  const saves = [];

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
        installClaude: async () => ({ host: 'claude', changed: false, changes: [] }),
        getCodexVersion: async () => 'codex-cli 0.145.0',
        saveConfig: async (_paths, config) => {
          saves.push(structuredClone(config));
          if (saves.length > 1) throw new Error('/Users/maintainer/prior-save.json');
          await writeFile(paths.configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
        },
        verify: async () => {
          throw new Error('injected verification failure');
        },
      },
    ),
    (error) => {
      assert.equal(error.stage, 'verify');
      assert.doesNotMatch(JSON.stringify(error), /maintainer|prior-save/);
      return true;
    },
  );

  assert.equal(saves.length, 2);
  const nextConfig = saves[0];
  const nextConfigBytes = `${JSON.stringify(nextConfig, null, 2)}\n`;
  assert.equal(await readFile(paths.configFile, 'utf8'), nextConfigBytes);
  await preflightRoutingRemoval({
    paths,
    managedState: { profile: nextConfig.profile, ...nextConfig.managed },
  });
  await assert.rejects(
    access(path.join(paths.homeDir, '.codex', 'agents', 'browser_driver.toml')),
    { code: 'ENOENT' },
  );
});

test('migration persists prior config before adapter cleanup and propagates cleanup failure redacted', async (t) => {
  const homeDir = await mkdtemp(path.join(await realpath(tmpdir()), 'fast-browser-migration-order-'));
  const paths = resolvePaths({ homeDir, pluginRoot: path.resolve(import.meta.dirname, '../..') });
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  await mkdir(paths.dataDir, { recursive: true, mode: 0o700 });

  const priorRouting = await installRouting({
    profile: 'full',
    hosts: ['codex'],
    paths,
    codexVersion: 'codex-cli 0.145.0',
  });
  const previousConfig = validConfig({
    profile: 'full',
    hosts: { claude: false, codex: true },
    sessions: { enabled: true, retentionDays: 30 },
    managed: { files: priorRouting.files, blocks: priorRouting.blocks },
  });
  const previousConfigBytes = `${JSON.stringify(previousConfig, null, 2)}\n`;
  await writeFile(paths.configFile, previousConfigBytes, { mode: 0o600 });
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
        installClaude: async () => ({
          host: 'claude',
          changed: true,
          changes: ['plugin-installed'],
        }),
        getCodexVersion: async () => 'codex-cli 0.145.0',
        saveConfig: async (_paths, config) => {
          events.push(config.hosts.codex ? 'save-prior' : 'save-next');
          await writeFile(paths.configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
        },
        uninstallClaude: async () => {
          events.push('uninstall-claude');
          throw new Error('/Users/maintainer/adapter-cleanup');
        },
        verify: async () => {
          throw new Error('injected verification failure');
        },
      },
    ),
    (error) => {
      assert.equal(error.stage, 'recovery');
      assert.match(error.message, /recovery required/i);
      assert.doesNotMatch(JSON.stringify(error), /maintainer|adapter-cleanup|Users/);
      return true;
    },
  );

  assert.deepEqual(events, ['save-next', 'save-prior', 'uninstall-claude']);
  assert.equal(await readFile(paths.configFile, 'utf8'), previousConfigBytes);
  await preflightRoutingRemoval({
    paths,
    managedState: { profile: previousConfig.profile, ...previousConfig.managed },
  });
  await assert.rejects(
    access(path.join(paths.homeDir, '.claude', 'rules', 'fast-browser-routing.md')),
    { code: 'ENOENT' },
  );
});

test('migration removes a prior Codex host without probing its unavailable version', async (t) => {
  const canonicalTemp = await realpath(tmpdir());
  const homeDir = await mkdtemp(path.join(canonicalTemp, 'fast-browser-migration-preinstall-'));
  const paths = resolvePaths({ homeDir, pluginRoot: path.resolve(import.meta.dirname, '../..') });
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  await mkdir(paths.dataDir, { recursive: true, mode: 0o700 });

  const priorRouting = await installRouting({
    profile: 'full',
    hosts: ['codex'],
    paths,
    codexVersion: 'codex-cli 0.145.0',
  });
  const previousConfig = validConfig({
    profile: 'full',
    hosts: { claude: false, codex: true },
    sessions: { enabled: true, retentionDays: 30 },
    managed: { files: priorRouting.files, blocks: priorRouting.blocks },
  });
  await writeFile(paths.configFile, `${JSON.stringify(previousConfig, null, 2)}\n`, { mode: 0o600 });
  const codexAgent = path.join(paths.homeDir, '.codex', 'agents', 'browser_driver.toml');

  const report = await migrate(
    {
      dryRun: false,
      rollback: null,
      hosts: ['claude'],
      source: '/repo/mattstack',
    },
    {
      paths,
      installClaude: async () => ({ host: 'claude', changed: false, changes: [] }),
      getCodexVersion: async () => {
        assert.fail('Codex version must not be probed for a removed prior host');
      },
      verify: async () => {},
    },
  );

  assert.equal(report.changed, false);
  await assert.rejects(access(codexAgent), { code: 'ENOENT' });
  const persisted = JSON.parse(await readFile(paths.configFile, 'utf8'));
  assert.deepEqual(persisted.hosts, { claude: true, codex: false });
  await preflightRoutingRemoval({
    paths,
    managedState: { profile: persisted.profile, ...persisted.managed },
  });
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

test('CLI migrate apply human mode adds a count-only warning exactly when unmanaged candidates exist', async () => {
  const writes = [];
  const cleanReport = {
    changed: true,
    imported: null,
    backupManifestPath: '/home/test/.fast-browser/backups/migration-1/manifest.json',
    rollbackManifestPath: '/home/test/.fast-browser/backups/migration-1/rollback.json',
    rollbackCommand: 'fast-browser migrate --rollback migration-1/rollback.json',
    unmanagedCandidates: [],
  };
  await main(
    { command: 'migrate', json: false },
    { commands: { migrate: async () => cleanReport }, write: (text) => writes.push(text) },
  );
  assert.equal(writes.join(''), 'Migration complete.\n');

  writes.length = 0;
  const withCandidates = {
    ...cleanReport,
    unmanagedCandidates: [
      {
        key: 'playwright-dev',
        command: 'node',
        argCount: 1,
        envKeys: ['PLAYWRIGHT_MCP_OUTPUT_DIR'],
      },
      { key: 'other-playwright', command: 'python', argCount: 0, envKeys: [] },
    ],
  };
  await main(
    { command: 'migrate', json: false },
    { commands: { migrate: async () => withCandidates }, write: (text) => writes.push(text) },
  );
  assert.equal(
    writes.join(''),
    'Migration complete.\n'
      + 'Warning: 2 unmanaged Playwright-looking MCP entries were left untouched;'
      + ' rerun with --json for details.\n',
  );

  writes.length = 0;
  await main(
    { command: 'migrate', json: true },
    { commands: { migrate: async () => withCandidates }, write: (text) => writes.push(text) },
  );
  assert.deepEqual(JSON.parse(writes.join('')), withCandidates);
});

test('CLI migrate dry-run human mode adds a count-only warning exactly when unmanaged candidates exist', async () => {
  const writes = [];
  const cleanReport = {
    dryRun: true,
    inventory: { schemaVersion: 1, unmanagedCandidates: [] },
    proposal: { mutations: [] },
  };
  await main(
    { command: 'migrate', json: false },
    { commands: { migrate: async () => cleanReport }, write: (text) => writes.push(text) },
  );
  assert.equal(writes.join(''), 'Migration dry-run complete; no changes were made.\n');

  writes.length = 0;
  const withCandidates = {
    ...cleanReport,
    inventory: {
      ...cleanReport.inventory,
      unmanagedCandidates: [
        {
          key: 'playwright-dev',
          command: 'node',
          argCount: 1,
          envKeys: ['PLAYWRIGHT_MCP_OUTPUT_DIR'],
        },
        { key: 'other-playwright', command: 'python', argCount: 0, envKeys: [] },
      ],
    },
  };
  await main(
    { command: 'migrate', json: false },
    { commands: { migrate: async () => withCandidates }, write: (text) => writes.push(text) },
  );
  assert.equal(
    writes.join(''),
    'Migration dry-run complete; no changes were made.\n'
      + 'Warning: 2 unmanaged Playwright-looking MCP entries were left untouched;'
      + ' rerun with --json for details.\n',
  );

  writes.length = 0;
  await main(
    { command: 'migrate', json: true },
    { commands: { migrate: async () => withCandidates }, write: (text) => writes.push(text) },
  );
  assert.deepEqual(JSON.parse(writes.join('')), withCandidates);
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
        sourceCommit: 'abc',
        runtime: { sha256: 'a'.repeat(64) },
        extension: { id: 'extension-id', version: '1.0.0' },
      }),
      installRuntime: async () => ({ version: '0.1.0-alpha.1' }),
      installExtension: async () => ({ unpacked: '/tmp/extension' }),
      installClaude: async () => ({ host: 'claude', changed: false, changes: [] }),
      installBuiltinMacros: async () => {},
      prepareRoutingTransition: async () => ({
        nextState: { profile: 'safe', files: [], blocks: [] },
        apply: async () => ({ rollback: async () => {} }),
      }),
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
