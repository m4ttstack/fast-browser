import { loadConfig as loadSavedConfig, parseConfig } from '../core/config.mjs';
import { saveConfig as saveValidatedConfig } from '../core/files.mjs';
import { resolvePaths } from '../core/paths.mjs';
import { run as runProcess } from '../core/process.mjs';
import { confirmTty } from '../cli/confirm.mjs';
import { isRoutingTransactionRecoveryRequired } from '../hosts/file-transaction.mjs';
import { prepareRoutingTransition as prepareHostRoutingTransition } from '../hosts/routing.mjs';
import { hasToken as keychainHasToken } from '../keychain/keychain.mjs';
import {
  PairingError,
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
  selectedConfigHosts,
} from './shared.mjs';

function dependencies(request, supplied) {
  const paths = supplied.paths ?? resolvePaths({
    homeDir: supplied.homeDir,
    pluginRoot: supplied.pluginRoot,
  });
  const input = supplied.input ?? process.stdin;
  const output = supplied.output ?? process.stdout;
  const interactive = (
    request.json !== true
    && (supplied.interactive ?? (input.isTTY === true && output.isTTY === true))
  );
  return {
    paths,
    loadConfig: supplied.loadConfig ?? loadSavedConfig,
    saveConfig: supplied.saveConfig ?? saveValidatedConfig,
    prepareRoutingTransition: supplied.prepareRoutingTransition ?? prepareHostRoutingTransition,
    getCodexVersion: supplied.getCodexVersion ?? (
      supplied.prepareRoutingTransition
        ? async () => ''
        : async () => {
          const result = await runProcess('codex', ['--version'], { timeoutMs: 10_000 });
          if (result.exitCode !== 0) throw new Error('Codex version detection failed');
          return result.stdout.trim();
        }
    ),
    pairAutoConnect: supplied.pairAutoConnect ?? pairAutomatically,
    setManualConnection: supplied.setManualConnection ?? setManual,
    pruneSessions: supplied.pruneSessions ?? pruneRetainedSessions,
    now: supplied.now ?? (() => new Date()),
    confirmDeleteToken: supplied.confirmDeleteToken,
    deleteToken: supplied.deleteToken,
    writeTokenFromPrompt: supplied.writeTokenFromPrompt,
    hasToken: supplied.hasToken ?? keychainHasToken,
    interactive,
    confirmReplaceToken: supplied.confirmReplaceToken ?? (() => confirmTty({
      input,
      output,
      createInterface: supplied.createInterface,
      prompt: 'Type REPLACE to replace the existing Fast Browser Keychain item: ',
      expected: 'REPLACE',
    })),
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
  const deps = dependencies(request, supplied);
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

  let replacementConfirmed = false;
  if (request.connection === 'auto') {
    let existing;
    try {
      existing = await deps.hasToken();
    } catch {
      throw new PairingError('unable to check for an existing Keychain token');
    }
    if (existing) {
      let confirmed = false;
      if (deps.interactive) {
        try {
          confirmed = await deps.confirmReplaceToken();
        } catch {
          throw new PairingError('unable to confirm Keychain token replacement');
        }
      }
      if (!confirmed) {
        throw new PairingError(
          'automatic pairing requires explicit replacement confirmation for the existing Keychain item',
        );
      }
      replacementConfirmed = true;
    }
  }

  let managedState;
  let routingReceipt;
  const hosts = selectedConfigHosts(current);
  let codexVersion = '';
  if (hosts.includes('codex')) {
    try {
      codexVersion = await deps.getCodexVersion();
    } catch {
      throw safeError('Configure could not detect the selected Codex CLI version.', {
        stage: 'detect-hosts',
      });
    }
  }
  try {
    const preparedRouting = await deps.prepareRoutingTransition({
      profile,
      hosts,
      paths: deps.paths,
      codexVersion,
      managedState: routingState(current),
    });
    managedState = preparedRouting.nextState;
    routingReceipt = await preparedRouting.apply();
  } catch (cause) {
    if (isRoutingTransactionRecoveryRequired(cause)) {
      throw safeError(
        'Configure could not save config and routing requires recovery.',
        {
          stage: 'save-config',
          code: cause.code,
        },
      );
    }
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
  let configPersisted = false;
  const persist = async (config) => {
    await deps.saveConfig(deps.paths, config);
    configPersisted = true;
  };

  try {
    if (request.connection === 'auto') {
      next = await deps.pairAutoConnect(next, {
        updateConfig: persist,
        writeTokenFromPrompt: deps.writeTokenFromPrompt,
        hasToken: deps.hasToken,
        interactive: deps.interactive,
        json: request.json,
        replacementConfirmed,
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
    if (configPersisted && cause?.name === 'PairingError') throw cause;
    try {
      await routingReceipt.rollback();
    } catch {
      throw safeError(
        'Configure could not save config and routing requires recovery.',
        { stage: 'save-config' },
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
