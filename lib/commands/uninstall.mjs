import { lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

import { loadConfig as loadSavedConfig, parseConfig } from '../core/config.mjs';
import { saveConfig as saveValidatedConfig } from '../core/files.mjs';
import { resolvePaths } from '../core/paths.mjs';
import {
  preflightClaudeUninstall,
  uninstallClaude as removeClaudePlugin,
} from '../hosts/claude.mjs';
import {
  preflightCodexUninstall,
  uninstallCodex as removeCodexPlugin,
} from '../hosts/codex.mjs';
import {
  preflightRoutingRemoval,
  removeRouting as removeOwnedRouting,
} from '../hosts/routing.mjs';
import {
  orderedHosts,
  routingState,
  safeError,
  selectedConfigHosts,
} from './shared.mjs';

async function inspectDirectory(target) {
  const state = await lstat(target);
  return {
    isDirectory: state.isDirectory(),
    isSymbolicLink: state.isSymbolicLink(),
    realpath: await realpath(target),
    dev: state.dev,
    ino: state.ino,
  };
}

function exactPurgeTarget(request, paths) {
  const requested = request.dataDir ?? paths.dataDir;
  const expected = path.join(path.resolve(paths.homeDir), '.fast-browser');
  if (
    typeof requested !== 'string'
    || requested.length === 0
    || requested.includes('\0')
    || requested === '/'
    || path.resolve(requested) === path.resolve(paths.homeDir)
    || requested !== expected
    || paths.dataDir !== expected
  ) {
    throw safeError('Purge requires the exact data directory with no aliases.', {
      stage: 'purge-preflight',
      exitCode: 2,
    });
  }
  return expected;
}

async function purgePreflight(request, paths, deps) {
  const target = exactPurgeTarget(request, paths);
  let inspected;
  try {
    inspected = await deps.inspectDataDir(target);
  } catch {
    throw safeError('Purge data directory could not be verified.', {
      stage: 'purge-preflight',
    });
  }
  if (
    !inspected.isDirectory
    || inspected.isSymbolicLink
    || inspected.realpath !== target
  ) {
    throw safeError('Purge refuses symlinks, aliases, and non-directory data roots.', {
      stage: 'purge-preflight',
      exitCode: 2,
    });
  }
  if (typeof deps.confirmPurge !== 'function' || !await deps.confirmPurge(target)) {
    throw safeError('Purge requires explicit confirmation.', {
      stage: 'purge-confirmation',
      exitCode: 2,
    });
  }
  return { target, inspected };
}

export async function uninstall(request, supplied = {}) {
  const paths = supplied.paths ?? resolvePaths({
    homeDir: supplied.homeDir,
    pluginRoot: supplied.pluginRoot,
  });
  const deps = {
    loadConfig: supplied.loadConfig ?? loadSavedConfig,
    saveConfig: supplied.saveConfig ?? saveValidatedConfig,
    preflightRouting: supplied.preflightRouting ?? preflightRoutingRemoval,
    preflightHostRemoval: supplied.preflightHostRemoval ?? (async ({ host }) => (
      host === 'claude'
        ? preflightClaudeUninstall()
        : preflightCodexUninstall()
    )),
    removeRouting: supplied.removeRouting ?? removeOwnedRouting,
    uninstallClaude: supplied.uninstallClaude ?? removeClaudePlugin,
    uninstallCodex: supplied.uninstallCodex ?? removeCodexPlugin,
    inspectDataDir: supplied.inspectDataDir ?? inspectDirectory,
    removeDataDir: supplied.removeDataDir ?? ((target) => rm(target, { recursive: true })),
    confirmPurge: supplied.confirmPurge,
  };
  const config = parseConfig(await deps.loadConfig(paths));
  const hosts = orderedHosts(
    request.hosts?.length > 0 ? request.hosts : selectedConfigHosts(config),
  );
  const managedState = routingState(config);

  let purge = null;
  await deps.preflightRouting({ paths, managedState });
  for (const host of hosts) {
    await deps.preflightHostRemoval({ host, config, paths });
  }
  if (request.purgeData) {
    purge = await purgePreflight(request, paths, deps);
  }

  const removedHosts = [];
  let routingRemoved = false;
  try {
    await deps.removeRouting({ paths, managedState });
    routingRemoved = true;
    for (const host of hosts) {
      if (host === 'claude') await deps.uninstallClaude({});
      else await deps.uninstallCodex({});
      removedHosts.push(host);
    }
  } catch {
    throw safeError('Uninstall stopped after a partial external removal.', {
      stage: 'remove',
      partialState: {
        removedHosts,
        remainingHosts: hosts.filter((host) => !removedHosts.includes(host)),
        routingRemoved,
      },
    });
  }

  const retained = parseConfig({
    ...config,
    hosts: { claude: false, codex: false },
    managed: { files: [], blocks: [] },
  });
  if (purge) {
    const latest = await deps.inspectDataDir(purge.target);
    if (
      !latest.isDirectory
      || latest.isSymbolicLink
      || latest.realpath !== purge.target
      || (
        purge.inspected.dev !== undefined
        && (
          latest.dev !== purge.inspected.dev
          || latest.ino !== purge.inspected.ino
        )
      )
    ) {
      throw safeError('Purge root changed or was replaced before deletion.', {
        stage: 'purge-revalidate',
        partialState: { removedHosts, routingRemoved, dataRetained: true },
      });
    }
    try {
      await deps.removeDataDir(purge.target);
    } catch {
      throw safeError('Uninstall completed, but the exact data directory was not purged.', {
        stage: 'purge-remove',
        partialState: { removedHosts, routingRemoved, dataRetained: true },
      });
    }
  } else {
    try {
      await deps.saveConfig(paths, retained);
    } catch {
      throw safeError('Uninstall completed, but retained config could not be updated.', {
        stage: 'save-retained-config',
        partialState: { removedHosts, routingRemoved, dataRetained: true },
      });
    }
  }
  return {
    command: 'uninstall',
    changed: true,
    hosts: removedHosts,
    dataRetained: !purge,
    keychainRetained: true,
  };
}
