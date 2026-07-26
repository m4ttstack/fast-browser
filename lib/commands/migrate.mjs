import path from 'node:path';

import { defaultConfig, loadConfig as loadSavedConfig, parseConfig } from '../core/config.mjs';
import { saveConfig as saveValidatedConfig } from '../core/files.mjs';
import { resolvePaths } from '../core/paths.mjs';
import { installClaude as installClaudePlugin, uninstallClaude } from '../hosts/claude.mjs';
import { installCodex as installCodexPlugin, uninstallCodex } from '../hosts/codex.mjs';
import { detectHosts as detectInstalledHosts } from '../hosts/detect.mjs';
import { installRouting, removeRouting } from '../hosts/routing.mjs';
import { applyMigration as applyLegacyMigration } from '../migration/apply.mjs';
import { inventoryLegacy as inventoryLegacyState } from '../migration/inventory.mjs';
import { rollbackMigration as rollbackLegacyMigration } from '../migration/rollback.mjs';
import { writeMigratedToken as writeToken } from '../keychain/keychain.mjs';
import { doctor } from './doctor.mjs';
import {
  hostFlags,
  managedConfig,
  orderedHosts,
  routingState,
  safeError,
  selectedConfigHosts,
} from './shared.mjs';

function proposedMutations(inventory) {
  return {
    mutations: [
      ...inventory.files.map(({ path: target }) => ({
        action: 'backup-and-remove-legacy-file',
        path: target,
      })),
      ...inventory.symlinks.map(({ path: target }) => ({
        action: 'backup-and-remove-legacy-symlink',
        path: target,
      })),
      ...inventory.imports.macros.map(({ path: target }) => ({
        action: 'copy-legacy-macro',
        path: target,
      })),
      ...inventory.imports.sessions.map(({ path: target }) => ({
        action: 'copy-legacy-session',
        path: target,
      })),
    ],
  };
}

function exactRollbackManifest(input, paths) {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) {
    throw safeError('Rollback requires one exact migration manifest.', {
      stage: 'rollback-validate',
      exitCode: 2,
    });
  }
  const root = path.resolve(paths.backupsDir);
  const manifest = path.isAbsolute(input)
    ? path.resolve(input)
    : path.resolve(root, input);
  const relative = path.relative(root, manifest);
  if (
    relative === ''
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
    || path.basename(manifest) !== 'rollback.json'
  ) {
    throw safeError('Rollback manifest must be one exact file below the backup directory.', {
      stage: 'rollback-validate',
      exitCode: 2,
    });
  }
  return manifest;
}

async function optionalConfig(loadConfig, paths) {
  try {
    return parseConfig(await loadConfig(paths));
  } catch {
    return defaultConfig();
  }
}

function publicHostReport(value, host) {
  return {
    host,
    changed: value?.changed === true,
    changes: Array.isArray(value?.changes)
      ? value.changes.filter((entry) => typeof entry === 'string')
      : [],
  };
}

function migrationComposition(request, supplied, paths) {
  let verificationState = null;
  const loadConfig = supplied.loadConfig ?? loadSavedConfig;
  const saveConfig = supplied.saveConfig ?? saveValidatedConfig;
  const detectHosts = supplied.detectHosts ?? detectInstalledHosts;
  const installClaude = supplied.installClaude ?? installClaudePlugin;
  const installCodex = supplied.installCodex ?? installCodexPlugin;
  const installOwnedRouting = supplied.installRouting ?? installRouting;
  const removeOwnedRouting = supplied.removeRouting ?? removeRouting;
  const removeClaude = supplied.uninstallClaude ?? uninstallClaude;
  const removeCodex = supplied.uninstallCodex ?? uninstallCodex;
  const runDoctor = supplied.doctor ?? doctor;

  const installAdaptersAndRouting = supplied.installAdaptersAndRouting ?? (async () => {
    const previousConfig = await optionalConfig(loadConfig, paths);
    let hosts = orderedHosts(request.hosts);
    if (hosts.length === 0) hosts = selectedConfigHosts(previousConfig);
    if (hosts.length === 0) hosts = orderedHosts(await detectHosts());
    const state = {
      hosts: [],
      managedState: null,
      previousConfig,
      configPersisted: false,
    };
    try {
      for (const host of hosts) {
        const report = host === 'claude'
          ? await installClaude({ source: request.source })
          : await installCodex({ source: request.source });
        state.hosts.push(publicHostReport(report, host));
      }
      state.managedState = await installOwnedRouting({
        profile: previousConfig.profile,
        paths,
        managedState: routingState(previousConfig),
      });
      const next = parseConfig({
        ...previousConfig,
        hosts: hostFlags(hosts),
        managed: managedConfig(state.managedState),
      });
      await saveConfig(paths, next);
      state.configPersisted = true;
      verificationState = { profile: next.profile };
      return state;
    } catch {
      throw safeError('Migration install failed before legacy cleanup.', {
        stage: 'migration-install',
        partialState: state,
      });
    }
  });

  const cleanupInstalled = supplied.cleanupInstalled ?? (async (state) => {
    if (!state || typeof state !== 'object') return;
    if (state.managedState) {
      await removeOwnedRouting({ paths, managedState: state.managedState });
    }
    for (const report of [...(state.hosts ?? [])].reverse()) {
      if (!report.changed || !report.changes.includes('plugin-installed')) continue;
      if (report.host === 'claude') await removeClaude({});
      if (report.host === 'codex') await removeCodex({});
    }
    if (state.previousConfig) await saveConfig(paths, state.previousConfig);
  });

  const verify = supplied.verify ?? (async () => {
    const report = await runDoctor(
      { profile: verificationState?.profile ?? 'safe' },
      supplied,
    );
    if (!report.ok) {
      throw safeError('Migration verification failed; legacy setup remains active.', {
        stage: 'migration-verify',
      });
    }
  });
  return { installAdaptersAndRouting, cleanupInstalled, verify };
}

export async function migrate(request, supplied = {}) {
  const paths = supplied.paths ?? resolvePaths({
    homeDir: supplied.homeDir,
    pluginRoot: supplied.pluginRoot,
  });
  const inventoryLegacy = supplied.inventoryLegacy ?? inventoryLegacyState;
  const proposeMigration = supplied.proposeMigration ?? proposedMutations;
  const rollbackMigration = supplied.rollbackMigration ?? rollbackLegacyMigration;
  const applyMigration = supplied.applyMigration ?? applyLegacyMigration;

  if (request.rollback) {
    const manifest = exactRollbackManifest(request.rollback, paths);
    return rollbackMigration(manifest, {
      homeDir: paths.homeDir,
      readMigratedToken: supplied.readMigratedToken,
    });
  }
  if (request.dryRun) {
    const inventory = await inventoryLegacy(paths);
    const proposal = await proposeMigration(inventory);
    return { dryRun: true, inventory, proposal };
  }
  const composition = migrationComposition(request, supplied, paths);
  return applyMigration({
    paths,
    now: supplied.now,
    migrationId: supplied.migrationId,
    writeMigratedToken: supplied.writeMigratedToken ?? writeToken,
    installAdaptersAndRouting: composition.installAdaptersAndRouting,
    cleanupInstalled: composition.cleanupInstalled,
    verify: composition.verify,
  });
}
