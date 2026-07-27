import { access, lstat, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig as loadSavedConfig, parseConfig } from '../core/config.mjs';
import { saveConfig as saveValidatedConfig } from '../core/files.mjs';
import { resolvePaths } from '../core/paths.mjs';
import { openNdjsonProcess, run as runProcess } from '../core/process.mjs';
import { DOCTOR_CHECK_IDS, defaultCheck } from '../doctor/checks.mjs';
import { detectChromeExtension } from '../extension/detect.mjs';
import { preflightClaudeUninstall } from '../hosts/claude.mjs';
import { preflightCodexUninstall } from '../hosts/codex.mjs';
import { runWithCodexModelFallback } from '../hosts/codex-agent.mjs';
import { detectHosts } from '../hosts/detect.mjs';
import {
  beginOwnedCodexAgentFallback,
  preflightRoutingRemoval,
} from '../hosts/routing.mjs';
import { hasToken, readToken } from '../keychain/keychain.mjs';
import { runtimeArgs } from '../runtime/launch.mjs';
import { loadRuntimeLock, runtimeLockIdentity } from '../runtime/lock.mjs';

const STATUSES = new Set(['pass', 'warn', 'fail']);
const PLUGIN_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PREFERRED_CODEX_MODEL = 'gpt-5.6-terra';
const CODEX_SMOKE_MARKER = 'FAST_BROWSER_DRIVER_OK';
const CODEX_FALLBACK_RECOVERY_REQUIRED = 'CODEX_FALLBACK_RECOVERY_REQUIRED';
const CODEX_SMOKE_PROMPT =
  `Delegate to browser_driver. Return exactly ${CODEX_SMOKE_MARKER} without using browser tools.`;

class CodexBrowserDriverSmokeError extends Error {
  constructor(message, { code = 'SMOKE_FAILED', model = null } = {}) {
    super(message);
    this.name = 'CodexBrowserDriverSmokeError';
    this.code = code;
    this.model = model;
  }
}

function jsonLines(text) {
  const events = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const value = JSON.parse(line);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error();
      }
      events.push(value);
    } catch {
      throw new CodexBrowserDriverSmokeError('Codex browser-driver smoke returned malformed JSON.');
    }
  }
  return events;
}

export function isPreferredCodexModelRejection(error) {
  return (
    error?.name === 'CodexBrowserDriverSmokeError'
    && error?.code === 'MODEL_NOT_FOUND'
    && error?.model === PREFERRED_CODEX_MODEL
  );
}

export async function runCodexBrowserDriverSmoke({
  cwd,
  run = runProcess,
} = {}) {
  const result = await run(
    'codex',
    [
      'exec',
      '--ephemeral',
      '--sandbox',
      'read-only',
      '--json',
      '--skip-git-repo-check',
      '-C',
      cwd,
      CODEX_SMOKE_PROMPT,
    ],
    // exec is already non-interactive; a real agent run measured 23.6s, so
    // give it headroom above the 10s that was tuned for a stub response.
    { timeoutMs: 60_000 },
  );
  const events = jsonLines(result.stdout);
  const preferredRejection = events.find((event) => (
    event.type === 'error'
    && event.error?.code === 'model_not_found'
    && event.error?.model === PREFERRED_CODEX_MODEL
  ));
  if (preferredRejection) {
    throw new CodexBrowserDriverSmokeError(
      'Codex rejected the preferred browser-driver model.',
      { code: 'MODEL_NOT_FOUND', model: PREFERRED_CODEX_MODEL },
    );
  }
  if (result.exitCode !== 0) {
    throw new CodexBrowserDriverSmokeError('Codex browser-driver smoke failed.');
  }
  const completed = events.some((event) => (
    event.type === 'item.completed'
    && event.item?.type === 'agent_message'
    && event.item?.text === CODEX_SMOKE_MARKER
  ));
  if (!completed) {
    throw new CodexBrowserDriverSmokeError(
      'Codex browser-driver smoke did not return its expected marker.',
    );
  }
}

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

  const selected = (host) => config?.hosts?.[host] === true;
  const notSelected = (host, label) => (
    !selected(host)
      ? pass(`${label} is not selected for this configuration.`)
      : null
  );

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
      notSelected('claude', 'Claude Code')
      ?? ((await detected()).includes('claude')
        ? pass('Claude Code CLI is available.')
        : fail('Claude Code CLI is unavailable.', 'Install Claude Code or select Codex only.'))
    ),
    'codex-cli': async () => (
      notSelected('codex', 'Codex')
      ?? ((await detected()).includes('codex')
        ? pass('Codex CLI is available.')
        : fail('Codex CLI is unavailable.', 'Install Codex or select Claude Code only.'))
    ),
    'claude-plugin': async () => (
      notSelected('claude', 'Claude Code')
      ?? ((await (dependencies.preflightClaude ?? preflightClaudeUninstall)()).installed
        ? pass('Claude Code has the exact Fast Browser plugin.')
        : fail('Claude Code does not have Fast Browser installed.', 'Run `fast-browser setup --host claude`.'))
    ),
    'codex-plugin': async () => (
      notSelected('codex', 'Codex')
      ?? ((await (dependencies.preflightCodex ?? preflightCodexUninstall)()).installed
        ? pass('Codex has the exact Fast Browser plugin.')
        : fail('Codex does not have Fast Browser installed.', 'Run `fast-browser setup --host codex`.'))
    ),
    'claude-routing': async () => {
      const skipped = notSelected('claude', 'Claude routing');
      if (skipped) return skipped;
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
      const skipped = notSelected('codex', 'Codex routing');
      if (skipped) return skipped;
      await routing();
      const installed = config?.managed.blocks.some(({ path: target }) => (
        target.endsWith(path.join('.codex', 'config.toml'))
      ));
      return installed
        ? pass('Codex routing ownership is valid.')
        : fail('Codex routing is missing.', 'Run `fast-browser configure`.');
    },
    'browser-driver': async () => {
      const skipped = notSelected('codex', 'Codex browser-driver');
      if (skipped) return skipped;
      await routing();
      const installed = config?.managed.files.some(({ path: target }) => (
        target.endsWith(path.join('.codex', 'agents', 'browser_driver.toml'))
      ));
      if (!installed) {
        return fail('The browser-driver agent is missing.', 'Run `fast-browser configure`.');
      }
      const smoke = dependencies.runCodexAgentSmoke
        ?? (() => runCodexBrowserDriverSmoke({
          cwd: dependencies.codexSmokeCwd ?? paths.homeDir,
          run: dependencies.runProcess ?? runProcess,
        }));
      try {
        await runWithCodexModelFallback({
          run: smoke,
          isPreferredModelRejection: isPreferredCodexModelRejection,
          rewriteOwnedAgent: async () => {
            const receipt = await (
              dependencies.beginOwnedCodexAgentFallback
              ?? beginOwnedCodexAgentFallback
            )({
              paths,
              managedState: {
                profile: config.profile,
                files: config.managed.files,
                blocks: config.managed.blocks,
              },
            });
            const managedState = receipt.managedState;
            const nextConfig = parseConfig({
              ...config,
              managed: {
                files: managedState.files,
                blocks: managedState.blocks,
              },
            });
            try {
              await (dependencies.saveConfig ?? saveValidatedConfig)(paths, nextConfig);
            } catch {
              try {
                await receipt.rollback();
              } catch {
                const recoveryError = new Error('Codex agent fallback recovery is required.');
                recoveryError.code = CODEX_FALLBACK_RECOVERY_REQUIRED;
                throw recoveryError;
              }
              throw new Error('Codex agent fallback config persistence failed.');
            }
            config = nextConfig;
          },
        });
      } catch (error) {
        if (error?.code === CODEX_FALLBACK_RECOVERY_REQUIRED) {
          return fail(
            'The browser-driver agent fallback requires recovery.',
            'Run `fast-browser configure` to restore the owned agent.',
          );
        }
        throw error;
      }
      return pass('The browser-driver agent is installed, owned, and runnable.');
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

  const openMcpTransport = dependencies.openMcpTransport ?? (async (options = {}) => {
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
    try {
      return await (dependencies.openNdjsonProcess ?? openNdjsonProcess)(
        process.execPath,
        [cli, ...runtimeArgs({ config, paths, lock })],
        {
          env,
          outputCapBytes: options.outputCapBytes,
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
    openMcpTransport,
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
