import crypto from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  open,
  realpath,
} from 'node:fs/promises';
import path from 'node:path';

import { defaultConfig, parseConfig } from '../core/config.mjs';
import { saveConfig as saveValidatedConfig } from '../core/files.mjs';
import { resolvePaths } from '../core/paths.mjs';
import { run as runProcess } from '../core/process.mjs';
import { installClaude as installClaudePlugin, uninstallClaude } from '../hosts/claude.mjs';
import { installCodex as installCodexPlugin, uninstallCodex } from '../hosts/codex.mjs';
import { detectHosts as detectInstalledHosts } from '../hosts/detect.mjs';
import { renderCodexAgent } from '../hosts/codex-agent.mjs';
import { installRouting, removeRouting } from '../hosts/routing.mjs';
import { applyMigration as applyLegacyMigration } from '../migration/apply.mjs';
import { inventoryLegacy as inventoryLegacyState } from '../migration/inventory.mjs';
import { rollbackMigration as rollbackLegacyMigration } from '../migration/rollback.mjs';
import {
  readToken as readKeychainToken,
  writeMigratedToken as writeToken,
} from '../keychain/keychain.mjs';
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

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function exactConfigPaths(paths) {
  if (
    typeof paths?.homeDir !== 'string'
    || typeof paths?.dataDir !== 'string'
    || typeof paths?.configFile !== 'string'
  ) throw new Error('migration config paths are incomplete');

  const homeDir = path.resolve(paths.homeDir);
  const dataDir = path.join(homeDir, '.fast-browser');
  const configFile = path.join(dataDir, 'config.json');
  if (
    paths.homeDir !== homeDir
    || paths.dataDir !== dataDir
    || paths.configFile !== configFile
  ) throw new Error('migration config paths are not exact canonical children');
  return { homeDir, dataDir, configFile };
}

async function canonicalDirectoryState(target, label, expected = null) {
  const state = await lstat(target);
  if (state.isSymbolicLink() || !state.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
  if (await realpath(target) !== target) {
    throw new Error(`${label} must be canonical`);
  }
  if (expected && !sameIdentity(state, expected)) {
    throw new Error(`${label} changed during config preflight`);
  }
  return state;
}

async function lexicalConfigState(configFile) {
  try {
    return await lstat(configFile);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function readExactConfig(paths) {
  const exact = exactConfigPaths(paths);
  const homeState = await canonicalDirectoryState(exact.homeDir, 'migration home');
  let dataState = null;
  try {
    dataState = await canonicalDirectoryState(exact.dataDir, 'migration data directory');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const configState = await lexicalConfigState(exact.configFile);
  if (!configState) return null;
  if (!dataState || configState.isSymbolicLink() || !configState.isFile()) {
    throw new Error('migration config must be a real regular file');
  }

  let handle;
  try {
    handle = await open(
      exact.configFile,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const openedState = await handle.stat();
    if (!openedState.isFile() || !sameIdentity(configState, openedState)) {
      throw new Error('migration config changed before it could be read');
    }
    const raw = await handle.readFile({ encoding: 'utf8' });
    await canonicalDirectoryState(exact.homeDir, 'migration home', homeState);
    await canonicalDirectoryState(exact.dataDir, 'migration data directory', dataState);
    const latestConfig = await lstat(exact.configFile);
    if (
      latestConfig.isSymbolicLink()
      || !latestConfig.isFile()
      || !sameIdentity(latestConfig, openedState)
    ) throw new Error('migration config changed while it was read');
    return JSON.parse(raw);
  } finally {
    await handle?.close();
  }
}

async function preflightConfig(paths, suppliedLoadConfig) {
  try {
    const value = suppliedLoadConfig
      ? await suppliedLoadConfig(paths)
      : await readExactConfig(paths);
    return value === null ? null : parseConfig(value);
  } catch {
    throw safeError('Existing config could not be validated before migration.', {
      stage: 'config-preflight',
    });
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

function priorCodexVersion(config, paths, fallback) {
  const agentPath = path.join(
    path.resolve(paths.homeDir),
    '.codex',
    'agents',
    'browser_driver.toml',
  );
  const entry = config.managed.files.find(({ path: target }) => target === agentPath);
  if (!entry) return fallback;
  const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
  if (entry.sha256 === hash(renderCodexAgent({ usePreferredModel: false }))) return '';
  if (entry.sha256 === hash(renderCodexAgent({ usePreferredModel: true }))) {
    return 'codex-cli 0.145.0';
  }
  throw new Error('prior Codex agent ownership cannot be reconstructed');
}

function migrationComposition(request, supplied, paths, preflightedConfig) {
  let verificationState = null;
  const saveConfig = supplied.saveConfig ?? saveValidatedConfig;
  const detectHosts = supplied.detectHosts ?? detectInstalledHosts;
  const installClaude = supplied.installClaude ?? installClaudePlugin;
  const installCodex = supplied.installCodex ?? installCodexPlugin;
  const installOwnedRouting = supplied.installRouting ?? installRouting;
  const getCodexVersion = supplied.getCodexVersion ?? (
    supplied.installRouting
      ? async () => ''
      : async () => {
        const result = await runProcess('codex', ['--version'], { timeoutMs: 10_000 });
        if (result.exitCode !== 0) throw new Error('Codex version detection failed');
        return result.stdout.trim();
      }
  );
  const removeOwnedRouting = supplied.removeRouting ?? removeRouting;
  const removeClaude = supplied.uninstallClaude ?? uninstallClaude;
  const removeCodex = supplied.uninstallCodex ?? uninstallCodex;
  const runDoctor = supplied.doctor ?? doctor;

  const installAdaptersAndRouting = supplied.installAdaptersAndRouting ?? (async () => {
    const hadPreviousConfig = preflightedConfig !== null;
    const previousConfig = preflightedConfig ?? defaultConfig();
    const previousHosts = selectedConfigHosts(previousConfig);
    let hosts = orderedHosts(request.hosts);
    if (hosts.length === 0) hosts = previousHosts;
    if (hosts.length === 0) hosts = orderedHosts(await detectHosts());
    const state = {
      hosts: [],
      managedState: null,
      hadPreviousConfig,
      previousConfig,
      previousRouting: {
        profile: previousConfig.profile,
        hosts: previousHosts,
        codexVersion: '',
      },
      configPersisted: false,
    };
    try {
      for (const host of hosts) {
        const report = host === 'claude'
          ? await installClaude({ source: request.source })
          : await installCodex({ source: request.source });
        state.hosts.push(publicHostReport(report, host));
      }
      const codexVersion = (hosts.includes('codex') || previousHosts.includes('codex'))
        ? await getCodexVersion()
        : '';
      state.previousRouting.codexVersion = previousHosts.includes('codex')
        ? priorCodexVersion(previousConfig, paths, codexVersion)
        : codexVersion;
      state.managedState = await installOwnedRouting({
        profile: previousConfig.profile,
        hosts,
        paths,
        codexVersion,
        managedState: routingState(previousConfig),
      });
      const next = parseConfig({
        ...previousConfig,
        hosts: hostFlags(hosts),
        managed: managedConfig(state.managedState),
      });
      await saveConfig(paths, next);
      state.configPersisted = true;
      verificationState = { profile: next.profile, hosts };
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
    if (state.managedState && state.hadPreviousConfig && state.previousConfig) {
      await installOwnedRouting({
        profile: state.previousRouting.profile,
        hosts: state.previousRouting.hosts,
        paths,
        codexVersion: state.previousRouting.codexVersion,
        managedState: state.managedState,
      });
    } else if (state.managedState) {
      await removeOwnedRouting({ paths, managedState: state.managedState });
    }
    for (const report of [...(state.hosts ?? [])].reverse()) {
      if (!report.changed || !report.changes.includes('plugin-installed')) continue;
      if (report.host === 'claude') await removeClaude({});
      if (report.host === 'codex') await removeCodex({});
    }
    if (state.hadPreviousConfig && state.previousConfig) {
      await saveConfig(paths, state.previousConfig);
    }
  });

  const verify = supplied.verify ?? (async () => {
    const report = await runDoctor(
      {
        profile: verificationState?.profile ?? 'safe',
        hosts: verificationState?.hosts ?? [],
      },
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
      readMigratedToken: supplied.readMigratedToken
        ?? supplied.readToken
        ?? readKeychainToken,
    });
  }
  if (request.dryRun) {
    const inventory = await inventoryLegacy(paths);
    const proposal = await proposeMigration(inventory);
    return { dryRun: true, inventory, proposal };
  }
  const existingConfig = await preflightConfig(paths, supplied.loadConfig);
  const composition = migrationComposition(request, supplied, paths, existingConfig);
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
