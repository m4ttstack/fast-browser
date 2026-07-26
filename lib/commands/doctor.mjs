import { access, lstat, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig as loadSavedConfig } from '../core/config.mjs';
import { resolvePaths } from '../core/paths.mjs';
import { run as runProcess } from '../core/process.mjs';
import { DOCTOR_CHECK_IDS, defaultCheck } from '../doctor/checks.mjs';
import { detectChromeExtension } from '../extension/detect.mjs';
import { preflightClaudeUninstall } from '../hosts/claude.mjs';
import { preflightCodexUninstall } from '../hosts/codex.mjs';
import { detectHosts } from '../hosts/detect.mjs';
import { preflightRoutingRemoval } from '../hosts/routing.mjs';
import { hasToken, readToken } from '../keychain/keychain.mjs';
import { runtimeArgs } from '../runtime/launch.mjs';
import { loadRuntimeLock, runtimeLockIdentity } from '../runtime/lock.mjs';

const STATUSES = new Set(['pass', 'warn', 'fail']);
const PLUGIN_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function checkResult(status, message, remediation = null) {
  return { status, message, remediation };
}

function pass(message) {
  return checkResult('pass', message);
}

function fail(message, remediation) {
  return checkResult('fail', message, remediation);
}

async function installedRuntime(paths, lock) {
  if (!lock) throw new Error('runtime lock unavailable');
  const directory = path.join(paths.runtimeDir, lock.productVersion);
  const cli = path.join(directory, 'fast-browser-mcp', 'cli.cjs');
  const markerPath = path.join(directory, 'installed.json');
  const [marker, cliState, markerState] = await Promise.all([
    readFile(markerPath, 'utf8').then(JSON.parse),
    stat(cli),
    lstat(markerPath),
  ]);
  if (
    markerState.isSymbolicLink()
    || !markerState.isFile()
    || !cliState.isFile()
    || JSON.stringify(marker.lock) !== JSON.stringify(runtimeLockIdentity(lock))
  ) throw new Error('runtime install mismatch');
  return cli;
}

async function extensionArtifact(paths, lock) {
  if (!lock) throw new Error('runtime lock unavailable');
  const directory = path.join(paths.extensionDir, lock.extension.version);
  const markerPath = path.join(directory, 'installed.json');
  const manifestPath = path.join(directory, 'unpacked', 'manifest.json');
  const [marker, manifest, markerState, manifestState] = await Promise.all([
    readFile(markerPath, 'utf8').then(JSON.parse),
    readFile(manifestPath, 'utf8').then(JSON.parse),
    lstat(markerPath),
    lstat(manifestPath),
  ]);
  if (
    markerState.isSymbolicLink()
    || manifestState.isSymbolicLink()
    || !markerState.isFile()
    || !manifestState.isFile()
    || JSON.stringify(marker.lock) !== JSON.stringify(runtimeLockIdentity(lock))
    || manifest.version !== lock.extension.version
  ) throw new Error('extension artifact mismatch');
  return path.join(directory, 'unpacked');
}

async function productionDependencies(request, dependencies, paths) {
  let config = dependencies.config;
  if (!config) {
    try {
      config = await (dependencies.loadConfig ?? loadSavedConfig)(paths);
    } catch {
      config = null;
    }
  }
  let lock = dependencies.lock;
  if (!lock) {
    try {
      lock = await (dependencies.loadRuntimeLock ?? loadRuntimeLock)({
        bundledPath: path.join(paths.pluginRoot ?? PLUGIN_ROOT, 'runtime-lock.json'),
        overridePath: request.runtimeLock,
      });
    } catch {
      lock = null;
    }
  }
  let detectedPromise;
  const detected = () => {
    detectedPromise ??= (dependencies.detectHosts ?? detectHosts)();
    return detectedPromise;
  };
  let routingPromise;
  const routing = () => {
    if (!config) throw new Error('config unavailable');
    routingPromise ??= (dependencies.preflightRouting ?? preflightRoutingRemoval)({
      paths,
      managedState: {
        profile: config.profile,
        files: config.managed.files,
        blocks: config.managed.blocks,
      },
    });
    return routingPromise;
  };
  const chromeUserDataDir = dependencies.chromeUserDataDir
    ?? path.join(paths.homeDir, 'Library', 'Application Support', 'Google', 'Chrome');

  const checks = {
    platform: async () => (
      (dependencies.platform ?? process.platform) === 'darwin'
        ? pass('macOS is supported.')
        : fail(
          'Fast Browser supports macOS only.',
          'Run Fast Browser on macOS with Google Chrome.',
        )
    ),
    node: async () => (
      Number.parseInt((dependencies.nodeVersion ?? process.versions.node).split('.')[0], 10) >= 20
        ? pass('Node 20 or newer is available.')
        : fail('Node 20 or newer is required.', 'Install Node 20 or newer.')
    ),
    chrome: async () => {
      await (dependencies.checkChrome ?? (() => access('/Applications/Google Chrome.app')))();
      return pass('Google Chrome is available.');
    },
    'claude-cli': async () => (
      (await detected()).includes('claude')
        ? pass('Claude Code CLI is available.')
        : fail('Claude Code CLI is unavailable.', 'Install Claude Code or select Codex only.')
    ),
    'codex-cli': async () => (
      (await detected()).includes('codex')
        ? pass('Codex CLI is available.')
        : fail('Codex CLI is unavailable.', 'Install Codex or select Claude Code only.')
    ),
    'claude-plugin': async () => (
      (await (dependencies.preflightClaude ?? preflightClaudeUninstall)()).installed
        ? pass('Claude Code has the exact Fast Browser plugin.')
        : fail('Claude Code does not have Fast Browser installed.', 'Run `fast-browser setup --host claude`.')
    ),
    'codex-plugin': async () => (
      (await (dependencies.preflightCodex ?? preflightCodexUninstall)()).installed
        ? pass('Codex has the exact Fast Browser plugin.')
        : fail('Codex does not have Fast Browser installed.', 'Run `fast-browser setup --host codex`.')
    ),
    'claude-routing': async () => {
      await routing();
      const installed = config?.profile !== 'full'
        || config.managed.files.some(({ path: target }) => target.endsWith(
          path.join('.claude', 'rules', 'fast-browser-routing.md'),
        ));
      return installed
        ? pass('Claude routing ownership is valid.')
        : fail('Claude routing is missing.', 'Run `fast-browser configure --profile full`.');
    },
    'codex-routing': async () => {
      await routing();
      const installed = config?.managed.blocks.some(({ path: target }) => (
        target.endsWith(path.join('.codex', 'config.toml'))
      ));
      return installed
        ? pass('Codex routing ownership is valid.')
        : fail('Codex routing is missing.', 'Run `fast-browser configure`.');
    },
    'browser-driver': async () => {
      await routing();
      const installed = config?.managed.files.some(({ path: target }) => (
        target.endsWith(path.join('.codex', 'agents', 'browser_driver.toml'))
      ));
      return installed
        ? pass('The browser-driver agent is installed and owned.')
        : fail('The browser-driver agent is missing.', 'Run `fast-browser configure`.');
    },
    'runtime-checksum': async () => {
      await (dependencies.checkRuntime ?? installedRuntime)(paths, lock);
      return pass(`Runtime ${lock.productVersion} matches its lock.`);
    },
    'extension-artifact': async () => {
      await (dependencies.checkExtensionArtifact ?? extensionArtifact)(paths, lock);
      return pass(`Extension artifact ${lock.extension.version} matches its lock.`);
    },
    'extension-installed': async () => {
      const profiles = await (dependencies.detectChromeExtension ?? detectChromeExtension)({
        extensionId: lock.extension.id,
        chromeUserDataDir,
      });
      return profiles.some(({ installed, manifestVersion }) => (
        installed && manifestVersion === lock.extension.version
      ))
        ? pass('The pinned Chrome extension is installed.')
        : fail(
          'The pinned Chrome extension is not installed.',
          'Load the unpacked extension artifact in Google Chrome.',
        );
    },
    pairing: async () => (
      config?.connection.mode !== 'auto'
      || await (dependencies.hasToken ?? hasToken)()
        ? pass(config?.connection.mode === 'auto'
          ? 'Automatic pairing is available.'
          : 'Manual extension connection is configured.')
        : fail('Automatic pairing is missing.', 'Run `fast-browser configure --connection auto`.')
    ),
    'data-permissions': async () => {
      if (dependencies.checkDataPermissions) {
        await dependencies.checkDataPermissions(paths);
        return pass('Fast Browser data permissions are private.');
      }
      const [directory, configFile] = await Promise.all([
        lstat(paths.dataDir),
        lstat(paths.configFile),
      ]);
      return (
        !directory.isSymbolicLink()
        && directory.isDirectory()
        && (directory.mode & 0o777) === 0o700
        && !configFile.isSymbolicLink()
        && configFile.isFile()
        && (configFile.mode & 0o777) === 0o600
      )
        ? pass('Fast Browser data permissions are private.')
        : fail('Fast Browser data permissions are unsafe.', 'Run `fast-browser setup` to repair permissions.');
    },
  };

  const runMcpSession = dependencies.runMcpSession ?? (async (messages, options) => {
    if (!config || !lock) throw new Error('runtime configuration unavailable');
    const cli = await installedRuntime(paths, lock);
    let token = null;
    if (config.connection.mode === 'auto') {
      token = await (dependencies.readToken ?? readToken)();
      if (!token) throw new Error('pairing token unavailable');
    }
    const env = token
      ? { ...process.env, PLAYWRIGHT_MCP_EXTENSION_TOKEN: token }
      : process.env;
    const input = `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`;
    try {
      return await (dependencies.runProcess ?? runProcess)(
        process.execPath,
        [cli, ...runtimeArgs({ config, paths, lock })],
        {
          env,
          input,
          timeoutMs: options.timeoutMs,
        },
      );
    } finally {
      token = null;
    }
  });
  return {
    ...dependencies,
    paths,
    config,
    lock,
    checks: { ...checks, ...dependencies.checks },
    runMcpSession,
  };
}

function normalizedResult(id, value) {
  if (
    !value
    || typeof value !== 'object'
    || !STATUSES.has(value.status)
    || typeof value.message !== 'string'
    || !(value.remediation === null || typeof value.remediation === 'string')
  ) {
    return {
      id,
      status: 'fail',
      message: `${id} check returned an invalid result.`,
      remediation: `Run \`fast-browser doctor\` after fixing ${id}.`,
    };
  }
  return {
    id,
    status: value.status,
    message: value.message.replaceAll('\n', ' '),
    remediation: value.remediation?.replaceAll('\n', ' ') ?? null,
  };
}

function failedResult(id) {
  const label = id === 'chrome' ? 'Chrome' : id;
  return {
    id,
    status: 'fail',
    message: `${label} check failed.`,
    remediation: `Run \`fast-browser doctor\` after fixing ${label}.`,
  };
}

async function profileFor(request, dependencies, paths) {
  if (request.profile === 'safe' || request.profile === 'full') return request.profile;
  if (dependencies.config?.profile) return dependencies.config.profile;
  try {
    return (await (dependencies.loadConfig ?? loadSavedConfig)(paths)).profile;
  } catch {
    return 'safe';
  }
}

export async function doctor(request = {}, dependencies = {}) {
  const paths = dependencies.paths ?? resolvePaths({
    homeDir: dependencies.homeDir,
    pluginRoot: dependencies.pluginRoot ?? PLUGIN_ROOT,
  });
  const composed = await productionDependencies(request, dependencies, paths);
  const profile = await profileFor(request, composed, paths);
  const context = {};
  const checks = [];
  for (const id of DOCTOR_CHECK_IDS) {
    const implementation = composed.checks?.[id]
      ?? defaultCheck(id, composed);
    try {
      checks.push(normalizedResult(id, await implementation(context)));
    } catch {
      checks.push(failedResult(id));
    }
  }
  return {
    schemaVersion: 1,
    ok: checks.every(({ status }) => status !== 'fail'),
    profile,
    checks,
  };
}
