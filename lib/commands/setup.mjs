import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultConfig, loadConfig as loadSavedConfig, parseConfig } from '../core/config.mjs';
import { ensurePrivateDirectory, saveConfig as saveValidatedConfig } from '../core/files.mjs';
import { installLauncher as installPathLauncher, launcherWasWritten } from '../core/launcher.mjs';
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
import { installBuiltinMacros as installMacros, macrosWereWritten } from '../macros/install.mjs';
import { installRuntime as installPinnedRuntime } from '../runtime/install.mjs';
import { loadRuntimeLock as loadPinnedLock } from '../runtime/lock.mjs';
import { pruneSessions as pruneRetainedSessions } from '../sessions/retention.mjs';
import { doctor as runDoctor } from './doctor.mjs';
import {
  hostFlags,
  managedConfig,
  orderedHosts,
  profileDefaults,
  reportableCause,
  routingState,
  safeError,
} from './shared.mjs';
import { DRIFT_EXEMPT_CHECK_IDS, classifyLockUpgrade } from './upgrade.mjs';

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
    paths.flowsDir,
    paths.flowsPendingDir,
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
    installLauncher: supplied.installLauncher ?? installPathLauncher,
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

// A macro-only fix never moves runtime-lock.json, so no doctor check fails and
// no pinned artifact needs replacing: every outcome except a full reinstall
// used to return without ever consulting the built-ins, which left the whole
// refresh mechanism inert for the one case it was written for. Running it on
// every outcome is safe precisely because destinations are classified by
// checksum: one already holding the packaged bytes is not written at all, and
// one the user has edited is preserved, so the ordinary rerun still touches
// nothing.
async function refreshBuiltinMacros(deps) {
  try {
    return await deps.installBuiltinMacros(deps.paths);
  } catch (error) {
    if (error?.name === 'LifecycleError') throw error;
    throw safeError(
      'Setup could not refresh the built-in macros; the installation is otherwise unchanged.',
      { stage: 'install-macros' },
    );
  }
}

// Same contract as refreshBuiltinMacros above, for the PATH launcher shim.
// The shim embeds an absolute plugin root, and that root goes stale whenever
// the plugin moves: this session began with the plugin root moving when a
// worktree was deleted, which would have stranded a shim pointing at a
// directory that no longer exists. Rewriting on every setup outcome (plus
// doctor's launcher check) is what makes an absolute-path shim safe to have
// at all. Rerunning stays honest for the macro installer's reason: an
// identical shim is not written, and a file without our marker is preserved.
async function refreshLauncher(deps) {
  try {
    return await deps.installLauncher(deps.paths);
  } catch (error) {
    if (error?.name === 'LifecycleError') throw error;
    throw safeError(
      'Setup could not install the fast-browser PATH launcher.',
      { stage: 'install-launcher' },
    );
  }
}

// The same three lists on every outcome. Which repair branch a rerun happened
// to take must not decide whether the user is told a built-in of theirs was
// replaced or deliberately left stale.
//
// `installed` rides along with them because it is the third thing that can put
// bytes on disk, and the only one a macro-only release is guaranteed to
// produce: a new built-in is a new executable file in the user's macros
// directory. It is also what `changed` is partly computed from
// (macrosWereWritten counts it), so omitting it left `changed: true` with
// nothing anywhere, human or --json, that could explain the flag.
function macroSummary(report) {
  return {
    installed: report?.installed ?? [],
    refreshed: report?.refreshed ?? [],
    preserved: report?.preserved ?? [],
  };
}

// Returns the accepted lock (plus whether any of the evidence for it was
// UNVERIFIABLE rather than digest-confirmed, see classifyLockUpgrade) when
// the failing doctor report is fully explained by a legitimate lock-version
// bump. Fails closed on any error while loading the lock or reading
// installed artifacts: an exception here must never be mistaken for
// eligibility, so the caller still throws setup-drift.
async function attemptLockUpgrade({ deps, request, doctorReport }) {
  try {
    const lock = await deps.loadRuntimeLock(request);
    const { explained, unverifiable } = await classifyLockUpgrade({
      paths: deps.paths, lock, doctorReport,
    });
    if (!explained) return null;
    return { lock, unverifiable };
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
//
// `unverifiable` means at least one of the artifacts being replaced was
// evidenced only by a legacy, digest-less marker rather than a confirmed
// mismatch against the current lock. installRuntime/installExtension
// always perform a real, checksum-verified install regardless (this
// function never skips that), so the unverifiable install is genuinely
// replaced either way; this flag exists only so the CLI can tell the user
// it happened, per requirement 3.
async function performLockUpgrade({
  deps, request, profile, hosts, current, lock, unverifiable, supplied,
}) {
  // Ahead of the artifact installs so a packaged-manifest failure refuses
  // before anything is replaced, which is what lets refreshBuiltinMacros'
  // own error promise the installation is otherwise unchanged.
  const macroReport = await refreshBuiltinMacros(deps);
  const launcherReport = await refreshLauncher(deps);

  let runtime;
  let extension;
  try {
    runtime = await deps.installRuntime({ lock, paths: deps.paths, fetch: deps.fetch });
    extension = await deps.installExtension({ lock, paths: deps.paths, fetch: deps.fetch });
  } catch (error) {
    if (error?.name === 'LifecycleError') throw error;
    // Scoped to the artifacts, deliberately. The macro refresh above has
    // already run by now, so a user whose stale built-in was replaced and
    // whose runtime download then failed would be told their prior
    // installation was untouched, which is false about the one file they can
    // see changed.
    throw safeError(
      'Setup could not install the upgraded pinned artifacts; the pinned runtime and extension'
      + ' are unchanged, though any stale built-in macros were already refreshed.',
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
    // The install directory never changes, so an upgrade leaves Chrome
    // already pointing at the right path with stale content: a reload, not
    // another "Load unpacked".
    extensionAction: 'reload',
    unverifiedArtifactsReplaced: unverifiable === true,
    runtime,
    hostReports: [],
    retention: { removedPaths: [], removedBytes: 0 },
    macros: macroSummary(macroReport),
    launcher: launcherReport,
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
  const current = await optionalConfig(deps.loadConfig, deps.paths);
  // An omitted --profile means "keep what is configured", never "reset to
  // safe". Treating absence as a request for the default is what silently
  // downgraded a full-profile machine to safe on a routine rerun (live,
  // 2026-07-30), and with it reset the session settings keyed on the
  // profile. Only a machine with no config at all gets the safe default.
  const profile = request.profile ?? current?.profile ?? 'safe';
  profileDefaults(profile);
  const codexVersion = hosts.includes('codex')
    ? await deps.getCodexVersion()
    : '';
  if (
    current
    && current.profile === profile
    && JSON.stringify(current.hosts) === JSON.stringify(hostFlags(hosts))
  ) {
    const doctorReport = await deps.doctor({ ...request, profile }, supplied);
    // A pending extension reload is not drift and is not something rerunning
    // setup can fix: the bytes on disk are already the pinned ones (which
    // extension-artifact and extension-installed verify strictly), and only a
    // click in chrome://extensions clears it. Nor is a missing, optional
    // capability renderer (annotate-renderer): setup never installs it, so
    // failing is that check's ordinary resting state for anyone who has not
    // opted in. Counting either here would make an otherwise healthy install
    // raise "external drift" on the next setup run. Both failing checks still
    // ride along in the returned report so the CLI can tell the user what (if
    // anything) to do about them.
    const doctorCurrent = (doctorReport.checks ?? []).every(
      ({ id, status }) => status === 'pass' || DRIFT_EXEMPT_CHECK_IDS.has(id),
    );
    const stateCurrent = deps.isSetupCurrent
      ? await deps.isSetupCurrent({ request, config: current, paths: deps.paths })
      : true;
    if (!doctorCurrent || !stateCurrent) {
      const upgrade = stateCurrent
        ? await attemptLockUpgrade({ deps, request, doctorReport })
        : null;
      if (!upgrade) {
        throw safeError(
          'Existing Fast Browser configuration has external drift; repair the reported checks and rerun setup.',
          {
            stage: 'setup-drift',
            partialState: { doctor: doctorReport },
          },
        );
      }
      return performLockUpgrade({
        deps,
        request,
        profile,
        hosts,
        current,
        lock: upgrade.lock,
        unverifiable: upgrade.unverifiable,
        supplied,
      });
    }
    const macroReport = await refreshBuiltinMacros(deps);
    const launcherReport = await refreshLauncher(deps);
    return {
      command: 'setup',
      // Nothing else on this path writes anything, so `changed` is exactly
      // "did a built-in or the launcher get installed or refreshed". A rerun
      // with everything current still reports false, and a rerun that
      // replaced a stale macro or shim no longer claims it did nothing.
      changed: macrosWereWritten(macroReport) || launcherWasWritten(launcherReport),
      hosts,
      profile,
      extensionPath: null,
      extensionManual: false,
      extensionAction: null,
      unverifiedArtifactsReplaced: false,
      macros: macroSummary(macroReport),
      launcher: launcherReport,
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
    // A built-in the user has edited is kept, which means setup can finish
    // having deliberately left a stale macro in place. Carry that out to the
    // report: an unannounced skip is how the last stale built-in survived
    // every rerun unnoticed.
    const macroReport = await deps.installBuiltinMacros(deps.paths);
    // The launcher is what makes the skills' bare `fast-browser <cmd>`
    // contract hold; installed alongside the built-ins so a first install and
    // every repair rerun leave the shim pointing at this plugin root.
    const launcherReport = await deps.installLauncher(deps.paths);
    const defaults = profileDefaults(profile);
    // Session recording and retention are a user choice `setup` has no flag
    // for, so rebuilding them from defaultConfig() would silently re-enable
    // recording for anyone who ran `configure --no-record-sessions` and reset
    // the retention window they chose, on any rerun that reaches this branch
    // (an added host, a drift repair). The fallback is conditional rather
    // than a blanket carry because the profile is what defines these
    // defaults: adopting them on a genuine profile change is correct, and
    // only the unchanged-profile reruns were wrong. This mirrors
    // configure's own fallback. A first-ever setup has no `current` to carry,
    // so it still writes the profile defaults.
    const sessions = current && current.profile === profile
      ? current.sessions
      : defaults;
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
      // The rewrite contract for this path, stated by construction rather
      // than by a per-field carry list. This branch was the only config
      // rebuild in the codebase that started from defaultConfig() instead of
      // spreading the existing config, and every field not remembered here
      // was silently reset: session recording (a privacy regression), the
      // annotation palette, the connection mode, and finally the profile
      // itself, four instances found one shipped release at a time. Spreading
      // `current` inverts the default: a field added tomorrow is carried
      // without anyone remembering this branch exists, and what setup may
      // rewrite is exactly the keys listed after the spread:
      //
      //   profile, hosts    what this command was invoked to change
      //   sessions          profile-derived, so a GENUINE profile change
      //                     adopts the new profile's defaults (that part is
      //                     correct and must survive); an unchanged profile
      //                     carries the user's settings untouched
      //   runtime, managed  owned by setup outright, never a user choice
      //
      // Everything else (connection, annotation, video, whatever comes next)
      // is a `configure` choice this command has no flag for and therefore
      // no claim on.
      config = parseConfig({
        ...defaultConfig(),
        ...(current ?? {}),
        profile,
        hosts: hostFlags(hosts),
        sessions,
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
    // Prune against the values just persisted, not the profile defaults:
    // pruning a carried 90-day window at the 30-day default would delete the
    // very sessions the user widened the window to keep. The profile guard
    // matches configure's and keeps a hand-edited `safe` config that claims
    // recording from pruning anything.
    if (profile === 'full' && sessions.enabled) {
      try {
        retention = await deps.pruneSessions({
          paths: deps.paths,
          now: deps.now(),
          retentionDays: sessions.retentionDays,
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
      // A genuine profile change also resets the session settings to the new
      // profile's defaults, which is correct and therefore has to be said:
      // the one unannounced rewrite this path still performs must not be the
      // one nobody is told about.
      ...(current && current.profile !== profile
        ? { previousProfile: current.profile }
        : {}),
      extensionPath: extension.unpacked,
      extensionManual: true,
      extensionAction: 'load',
      unverifiedArtifactsReplaced: false,
      runtime,
      hostReports,
      retention,
      macros: macroSummary(macroReport),
      launcher: launcherReport,
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
    // A host preflight that throws before it can report a partial state
    // leaves `hosts` empty, so "inspect the reported managed state" pointed
    // at nothing at all while the one sentence naming the failure was
    // discarded. Quote it when it is ours (reportableCause vets that), in the
    // message for humans and in partialState for --json consumers.
    const cause = reportableCause(error);
    throw safeError(
      // No trailing period after the cause: it is somebody else's sentence
      // fragment and its own punctuation is not ours to assume.
      cause
        ? `Setup failed: ${cause}`
        : 'Setup failed; inspect the reported managed state and retry.',
      {
        stage: routing ? 'post-routing' : 'setup',
        partialState: {
          hosts: hostReports,
          ...(cause ? { cause } : {}),
          ...(routing ? { managedState: routing } : {}),
        },
      },
    );
  }
}
