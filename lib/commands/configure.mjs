import { loadConfig as loadSavedConfig, parseConfig } from '../core/config.mjs';
import { saveConfig as saveValidatedConfig } from '../core/files.mjs';
import { resolvePaths } from '../core/paths.mjs';
import { installRouting as installHostRouting } from '../hosts/routing.mjs';
import {
  pairAutoConnect as pairAutomatically,
  setManualConnection as setManual,
} from '../keychain/pair.mjs';
import { pruneSessions as pruneRetainedSessions } from '../sessions/retention.mjs';
import {
  managedConfig,
  profileDefaults,
  retentionDays,
  routingState,
  safeError,
} from './shared.mjs';

function dependencies(supplied) {
  const paths = supplied.paths ?? resolvePaths({
    homeDir: supplied.homeDir,
    pluginRoot: supplied.pluginRoot,
  });
  return {
    paths,
    loadConfig: supplied.loadConfig ?? loadSavedConfig,
    saveConfig: supplied.saveConfig ?? saveValidatedConfig,
    installRouting: supplied.installRouting ?? installHostRouting,
    pairAutoConnect: supplied.pairAutoConnect ?? pairAutomatically,
    setManualConnection: supplied.setManualConnection ?? setManual,
    pruneSessions: supplied.pruneSessions ?? pruneRetainedSessions,
    now: supplied.now ?? (() => new Date()),
    confirmDeleteToken: supplied.confirmDeleteToken,
    deleteToken: supplied.deleteToken,
    writeTokenFromPrompt: supplied.writeTokenFromPrompt,
    hasToken: supplied.hasToken,
    print: supplied.print,
  };
}

function selectedProfile(request, current) {
  if (
    request.explicitOptions
    && !request.explicitOptions.has('--profile')
  ) return current.profile;
  return request.profile ?? current.profile;
}

export async function configure(request, supplied = {}) {
  const deps = dependencies(supplied);
  const current = parseConfig(await deps.loadConfig(deps.paths));
  const profile = selectedProfile(request, current);
  const defaults = profileDefaults(profile);
  const days = retentionDays(request.retentionDays ?? defaults.retentionDays);
  const enabled = request.recordSessions ?? defaults.enabled;
  if (profile === 'safe' && enabled) {
    throw safeError('The safe profile cannot record sessions.', {
      stage: 'validate',
      exitCode: 2,
    });
  }

  let managedState;
  try {
    managedState = await deps.installRouting({
      profile,
      paths: deps.paths,
      managedState: routingState(current),
    });
  } catch {
    throw safeError('Configure could not reconcile owned routing.', {
      stage: 'install-routing',
    });
  }
  let next = parseConfig({
    ...current,
    profile,
    sessions: { enabled, retentionDays: days },
    managed: managedConfig(managedState),
  });
  const persist = (config) => deps.saveConfig(deps.paths, config);

  try {
    if (request.connection === 'auto') {
      next = await deps.pairAutoConnect(next, {
        updateConfig: persist,
        writeTokenFromPrompt: deps.writeTokenFromPrompt,
        hasToken: deps.hasToken,
        print: deps.print,
      });
    } else if (request.connection === 'manual') {
      next = await deps.setManualConnection(next, {
        updateConfig: persist,
        confirmDeleteToken: deps.confirmDeleteToken,
        deleteToken: deps.deleteToken,
      });
    } else {
      await persist(next);
    }
  } catch (cause) {
    try {
      await deps.installRouting({
        profile: current.profile,
        paths: deps.paths,
        managedState,
      });
    } catch {
      throw safeError(
        'Configure could not save config and routing requires recovery.',
        {
          stage: 'save-config',
          partialState: { managedState },
        },
      );
    }
    if (cause?.name === 'PairingError') throw cause;
    throw safeError('Configure could not save config; routing was rolled back.', {
      stage: 'save-config',
    });
  }

  let retention = { removedPaths: [], removedBytes: 0 };
  if (next.profile === 'full' && next.sessions.enabled) {
    try {
      retention = await deps.pruneSessions({
        paths: deps.paths,
        now: deps.now(),
        retentionDays: next.sessions.retentionDays,
      });
    } catch {
      throw safeError(
        'Configuration was saved, but eligible session retention could not be applied.',
        {
          stage: 'retention-prune',
          partialState: {
            configPersisted: true,
            managedState,
          },
        },
      );
    }
  }
  return {
    command: 'configure',
    changed: JSON.stringify(current) !== JSON.stringify(next),
    config: next,
    managedState,
    retention,
  };
}
