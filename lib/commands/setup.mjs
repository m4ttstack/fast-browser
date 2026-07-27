import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultConfig, loadConfig as loadSavedConfig, parseConfig } from '../core/config.mjs';
import { ensurePrivateDirectory, saveConfig as saveValidatedConfig } from '../core/files.mjs';
import { resolvePaths } from '../core/paths.mjs';
import { run as runProcess } from '../core/process.mjs';
import { installExtension as installExtensionArtifact } from '../extension/install.mjs';
import {
  installClaude as installClaudePlugin,
  uninstallClaude as uninstallClaudePlugin,
} from '../hosts/claude.mjs';
import {
  installCodex as installCodexPlugin,
  uninstallCodex as uninstallCodexPlugin,
} from '../hosts/codex.mjs';
import { detectHosts as detectInstalledHosts } from '../hosts/detect.mjs';
import { isRoutingTransactionRecoveryRequired } from '../hosts/file-transaction.mjs';
import { prepareRoutingTransition as prepareHostRoutingTransition } from '../hosts/routing.mjs';
import { installBuiltinMacros as installMacros } from '../macros/install.mjs';
import { installRuntime as installPinnedRuntime } from '../runtime/install.mjs';
import { loadRuntimeLock as loadPinnedLock } from '../runtime/lock.mjs';
import { pruneSessions as pruneRetainedSessions } from '../sessions/retention.mjs';
import { doctor as runDoctor } from './doctor.mjs';
import {
  hostFlags,
  managedConfig,
  orderedHosts,
  profileDefaults,
  routingState,
  safeError,
} from './shared.mjs';
import { isExplainedByLockUpgrade } from './upgrade.mjs';

const PLUGIN_ROOT = fileURLToPath(new URL('../..', import.meta.url));

async function lstatOrNull(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function ensureSetupDirectories(paths) {
  const expectedData = path.join(path.resolve(paths.homeDir), '.fast-browser');
  if (path.resolve(paths.dataDir) !== expectedData) {
    throw new Error('data directory is not the exact Fast Browser home child');
  }
  const directories = [
    paths.dataDir,
    paths.runtimeDir,
    paths.extensionDir,
    paths.macrosDir,
    paths.sessionsDir,
    paths.archiveDir,
    paths.backupsDir,
  ];
  for (const directory of directories) {
    if (
      directory !== paths.dataDir
      && path.dirname(path.resolve(directory)) !== expectedData
    ) throw new Error('managed directory is not an exact data-directory child');
    const state = await lstatOrNull(directory);
    if (state && (state.isSymbolicLink() || !state.isDirectory())) {
      throw new Error('managed data path must be a real directory');
    }
  }
  const configState = await lstatOrNull(paths.configFile);
  if (configState && (configState.isSymbolicLink() || !configState.isFile())) {
    throw new Error('config target must be a real regular file');
  }
  for (const directory of directories) await ensurePrivateDirectory(directory);
}

function productionDependencies(request, supplied) {
  const paths = supplied.paths ?? resolvePaths({
    homeDir: supplied.homeDir,
    pluginRoot: supplied.pluginRoot ?? PLUGIN_ROOT,
  });
  return {
    paths,
    interactive: supplied.interactive ?? process.stdin.isTTY,
    checkPlatform: supplied.checkPlatform ?? (async () => {
      if (process.platform !== 'darwin') {
        throw safeError('Fast Browser supports macOS with Google Chrome only.', {
          stage: 'check-platform',
        });
      }
    }),
    detectHosts: supplied.detectHosts ?? (() => detectInstalledHosts()),
    getCodexVersion: supplied.getCodexVersion ?? (
      supplied.detectHosts
        ? async () => ''
        : async () => {
          const result = await runProcess('codex', ['--version'], { timeoutMs: 10_000 });
          if (result.exitCode !== 0) {
            throw safeError('Codex CLI version detection failed.', {
              stage: 'detect-hosts',
            });
          }
          return result.stdout.trim();
        }
    ),
    ensureDataDirs: supplied.ensureDataDirs ?? (() => ensureSetupDirectories(paths)),
    loadRuntimeLock: supplied.loadRuntimeLock ?? (() => loadPinnedLock({
      bundledPath: path.join(paths.pluginRoot, 'runtime-lock.json'),
      overridePath: request.runtimeLock,
    })),
    installRuntime: supplied.installRuntime ?? installPinnedRuntime,
    installExtension: supplied.installExtension ?? installExtensionArtifact,
    installClaude: supplied.installClaude ?? installClaudePlugin,
    installCodex: supplied.installCodex ?? installCodexPlugin,
    uninstallClaude: supplied.uninstallClaude ?? uninstallClaudePlugin,
    uninstallCodex: supplied.uninstallCodex ?? uninstallCodexPlugin,
    installBuiltinMacros: supplied.installBuiltinMacros ?? installMacros,
    pruneSessions: supplied.pruneSessions ?? pruneRetainedSessions,
    prepareRoutingTransition: supplied.prepareRoutingTransition ?? prepareHostRoutingTransition,
    saveConfig: supplied.saveConfig ?? saveValidatedConfig,
    loadConfig: supplied.loadConfig ?? loadSavedConfig,
    isSetupCurrent: supplied.isSetupCurrent ?? null,
    doctor: supplied.doctor ?? runDoctor,
    now: supplied.now ?? (() => new Date()),
    fetch: supplied.fetch ?? globalThis.fetch,
  };
}

function nonInteractiveHostError(detected) {
  const names = detected.map((host) => (
    host === 'claude' ? 'Claude Code' : 'Codex'
  )).join(', ') || 'none';
  const selector = detected.length === 2 ? 'both' : detected[0] ?? 'claude|codex|both';
  return safeError(
    `Detected hosts: ${names}. Non-interactive setup requires an explicit host. `
    + `Run \`fast-browser setup --host ${selector}\`.`,
    { stage: 'select-hosts', exitCode: 2 },
  );
}

async function optionalConfig(loadConfig, paths) {
  try {
    return await loadConfig(paths);
  } catch (error) {
    if (error?.code === 'ENOENT' || /\bENOENT\b/.test(error?.message ?? '')) {
      return null;
    }
    throw safeError('Existing config could not be validated before setup.', {
      stage: 'config-preflight',
    });
  }
}

// Returns the accepted lock when the failing doctor report is fully
// explained by a legitimate lock-version bump (see isExplainedByLockUpgrade
// for the exact tampering-vs-upgrade evidence). Fails closed on any error
// while loading the lock or reading installed artifacts: an exception here
// must never be mistaken for eligibility, so the caller still throws
// setup-drift.
async function attemptLockUpgrade({ deps, request, doctorReport }) {
  try {
    const lock = await deps.loadRuntimeLock(request);
    if (!await isExplainedByLockUpgrade({ paths: deps.paths, lock, doctorReport })) return null;
    return lock;
  } catch {
    return null;
  }
}

// A pending upgrade only ever replaces the pinned runtime and extension
// artifacts through the exact same installation path a first-time setup
// uses. Everything else already recorded in `current` (profile, hosts,
// connection/pairing, session settings, and managed routing/host
// ownership) is carried over unchanged: this function never calls the
// host, routing, or session-pruning dependencies the fresh-install branch
// below uses, so none of that state is even touched, let alone rewritten.
async function performLockUpgrade({
  deps, request, profile, hosts, current, lock, supplied,
}) {
  let runtime;
  let extension;
  try {
    runtime = await deps.installRuntime({ lock, paths: deps.paths, fetch: deps.fetch });
    extension = await deps.installExtension({ lock, paths: deps.paths, fetch: deps.fetch });
  } catch (error) {
    if (error?.name === 'LifecycleError') throw error;
    throw safeError(
      'Setup could not install the upgraded pinned artifacts; the prior installation is unchanged.',
      { stage: 'upgrade-install' },
    );
  }

  let config;
  try {
    config = parseConfig({
      ...current,
      runtime: {
        version: runtime.version ?? lock.productVersion,
        sha256: lock.runtime.sha256,
        sourceCommit: lock.sourceCommit,
      },
    });
    await deps.saveConfig(deps.paths, config);
  } catch (error) {
    if (error?.name === 'LifecycleError') throw error;
    throw safeError(
      'Setup installed the upgraded pinned artifacts, but the updated config could not be saved.',
      { stage: 'save-config' },
    );
  }

  // extension-installed is expected to still fail here: Chrome keeps the
  // prior unpacked copy loaded until the user manually reloads it, exactly
  // like a first-time install. Report success anyway, the same way the
  // fresh-install branch below never gates its return on doctor.ok, so that
  // one expected, documented manual step is never mistaken for drift.
  const doctorReport = await deps.doctor({ ...request, profile }, supplied);
  return {
    command: 'setup',
    changed: true,
    hosts,
    profile,
    extensionPath: extension.unpacked,
    extensionManual: true,
    runtime,
    hostReports: [],
    retention: { removedPaths: [], removedBytes: 0 },
    config,
    doctor: doctorReport,
  };
}

function publicHostState(value, fallbackHost = null) {
  if (!value || typeof value !== 'object') return null;
  const state = {
    host: value.host === 'claude' || value.host === 'codex'
      ? value.host
      : fallbackHost,
    changed: value.changed === true,
    changes: Array.isArray(value.changes)
      ? value.changes.filter((entry) => typeof entry === 'string')
      : [],
  };
  if (typeof value.next === 'string') state.next = value.next.replaceAll('\n', ' ');
  return state;
}

export async function setup(request, supplied = {}) {
  const deps = productionDependencies(request, supplied);
  await deps.checkPlatform();
  const detected = orderedHosts(await deps.detectHosts());
  let hosts = orderedHosts(request.hosts);
  if (hosts.length === 0) {
    if (!deps.interactive) throw nonInteractiveHostError(detected);
    hosts = detected;
  }
  if (hosts.length === 0) throw nonInteractiveHostError(detected);
  for (const host of hosts) {
    if (!detected.includes(host)) {
      throw safeError(`Requested ${host} host was not detected.`, {
        stage: 'select-hosts',
        exitCode: 2,
      });
    }
  }
  const profile = request.profile ?? 'safe';
  profileDefaults(profile);
  const current = await optionalConfig(deps.loadConfig, deps.paths);
  const codexVersion = hosts.includes('codex')
    ? await deps.getCodexVersion()
    : '';
  if (
    current
    && current.profile === profile
    && JSON.stringify(current.hosts) === JSON.stringify(hostFlags(hosts))
  ) {
    const doctorReport = await deps.doctor({ ...request, profile }, supplied);
    const doctorCurrent = (
      doctorReport?.ok === true
      && (doctorReport.checks ?? []).every(({ status }) => status === 'pass')
    );
    const stateCurrent = deps.isSetupCurrent
      ? await deps.isSetupCurrent({ request, config: current, paths: deps.paths })
      : true;
    if (!doctorCurrent || !stateCurrent) {
      const upgradeLock = stateCurrent
        ? await attemptLockUpgrade({ deps, request, doctorReport })
        : null;
      if (!upgradeLock) {
        throw safeError(
          'Existing Fast Browser configuration has external drift; repair the reported checks and rerun setup.',
          {
            stage: 'setup-drift',
            partialState: { doctor: doctorReport },
          },
        );
      }
      return performLockUpgrade({
        deps, request, profile, hosts, current, lock: upgradeLock, supplied,
      });
    }
    return {
      command: 'setup',
      changed: false,
      hosts,
      profile,
      extensionPath: null,
      extensionManual: false,
      config: current,
      doctor: doctorReport,
    };
  }

  let routing = null;
  let routingReceipt = null;
  let persistedConfig = null;
  const hostReports = [];
  try {
    await deps.ensureDataDirs(deps.paths);
    const lock = await deps.loadRuntimeLock(request);
    const runtime = await deps.installRuntime({
      lock,
      paths: deps.paths,
      fetch: deps.fetch,
    });
    const extension = await deps.installExtension({
      lock,
      paths: deps.paths,
      fetch: deps.fetch,
    });
    if (hosts.includes('claude')) {
      hostReports.push(publicHostState(
        await deps.installClaude({ source: request.source }),
        'claude',
      ));
    }
    if (hosts.includes('codex')) {
      try {
        hostReports.push(publicHostState(
          await deps.installCodex({ source: request.source }),
          'codex',
        ));
      } catch (error) {
        const partial = publicHostState(error?.result, 'codex');
        if (partial) hostReports.push(partial);
        throw error;
      }
    }
    await deps.installBuiltinMacros(deps.paths);
    const defaults = profileDefaults(profile);
    const preparedRouting = await deps.prepareRoutingTransition({
      profile,
      hosts,
      paths: deps.paths,
      codexVersion,
      managedState: current ? routingState(current) : null,
    });
    routing = preparedRouting.nextState;
    routingReceipt = await preparedRouting.apply();
    let config;
    try {
      config = parseConfig({
        ...defaultConfig(),
        profile,
        hosts: hostFlags(hosts),
        sessions: defaults,
        runtime: {
          version: runtime.version ?? lock.productVersion,
          sha256: lock.runtime.sha256,
          sourceCommit: lock.sourceCommit,
        },
        managed: managedConfig(routing),
      });
      await deps.saveConfig(deps.paths, config);
      persistedConfig = config;
    } catch {
      if (routingReceipt) {
        try {
          await routingReceipt.rollback();
        } catch {
          throw safeError(
            'Setup could not save config; installed routing requires recovery.',
            { stage: 'save-config' },
          );
        }
      }
      throw safeError('Setup could not save config; routing was rolled back.', {
        stage: 'save-config',
      });
    }
    let retention = { removedPaths: [], removedBytes: 0 };
    if (defaults.enabled) {
      try {
        retention = await deps.pruneSessions({
          paths: deps.paths,
          now: deps.now(),
          retentionDays: defaults.retentionDays,
        });
      } catch {
        throw safeError(
          'Setup was saved, but eligible session retention could not be applied.',
          {
            stage: 'retention-prune',
            partialState: {
              configPersisted: true,
              managedState: routing,
            },
          },
        );
      }
    }
    const doctorReport = await deps.doctor({ ...request, profile }, supplied);
    return {
      command: 'setup',
      changed: true,
      hosts,
      profile,
      extensionPath: extension.unpacked,
      extensionManual: true,
      runtime,
      hostReports,
      retention,
      config,
      doctor: doctorReport,
    };
  } catch (error) {
    if (persistedConfig) {
      if (error?.name === 'LifecycleError') throw error;
      throw safeError('Setup was saved, but post-save verification failed.', {
        stage: 'post-save',
        partialState: {
          configPersisted: true,
          managedState: routing,
        },
      });
    }
    for (const report of [...hostReports].reverse()) {
      if (!report?.changed || !report.changes.includes('plugin-installed')) continue;
      try {
        if (report.host === 'claude') await deps.uninstallClaude({});
        if (report.host === 'codex') await deps.uninstallCodex({});
      } catch {
        // The redacted partial state below is the recovery source of truth.
      }
    }
    if (isRoutingTransactionRecoveryRequired(error)) {
      throw safeError(
        'Setup could not save config; installed routing requires recovery.',
        {
          stage: 'save-config',
          code: error.code,
        },
      );
    }
    if (error?.name === 'LifecycleError') throw error;
    throw safeError('Setup failed; inspect the reported managed state and retry.', {
      stage: routing ? 'post-routing' : 'setup',
      partialState: {
        hosts: hostReports,
        ...(routing ? { managedState: routing } : {}),
      },
    });
  }
}
