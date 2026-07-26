import { readFileSync } from 'node:fs';

import { run as runProcess } from '../core/process.mjs';
import {
  localPluginPathMatches,
  marketplaceSourceMatches,
  normalizeMarketplaceSource,
} from './source.mjs';

const PLUGIN = 'fast-browser@mattstack';
const VERSION = JSON.parse(
  readFileSync(new URL('../../.codex-plugin/plugin.json', import.meta.url), 'utf8'),
).version;

function resultState(changed = false, changes = []) {
  return { host: 'codex', changed, changes };
}

function failure(message, state, next) {
  const error = new Error(message);
  error.name = 'HostInstallError';
  error.result = { ...state, next };
  return error;
}

async function execute(run, args, state, next) {
  const context = `codex ${args.slice(0, 2).join(' ')}`;
  let commandResult;
  try {
    commandResult = await run('codex', args);
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'unknown error';
    throw failure(`${context} failed to start: ${code}`, state, next);
  }
  if (commandResult.exitCode !== 0) {
    throw failure(`${context} exited with code ${commandResult.exitCode}`, state, next);
  }
  return commandResult.stdout;
}

function json(output, context, state, next) {
  try {
    const value = JSON.parse(output);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw failure(`${context} returned invalid JSON`, state, next);
  }
}

async function executeJson(run, args, state, next, validate) {
  const output = await execute(run, args, state, next);
  const context = `codex ${args.slice(0, 2).join(' ')}`;
  const value = json(output, context, state, next);
  if (validate && !validate(value)) {
    throw failure(`${context} returned unexpected JSON`, state, next);
  }
  return value;
}

async function installedPlugin(value, source) {
  const matches = value.installed.filter((plugin) => plugin?.pluginId === PLUGIN);
  if (matches.length === 0) return null;
  if (matches.length !== 1) throw new Error('duplicate installed plugin');
  const [plugin] = matches;
  if (
    plugin.name !== 'fast-browser'
    || plugin.marketplaceName !== 'mattstack'
    || plugin.installed !== true
    || typeof plugin.version !== 'string'
    || plugin.version.length === 0
  ) {
    throw new Error('invalid installed plugin identity');
  }
  if (source !== undefined) {
    if (
      !await marketplaceSourceMatches(
        source,
        plugin.marketplaceSource?.sourceType,
        plugin.marketplaceSource?.source,
      )
    ) {
      throw new Error('invalid installed marketplace source');
    }
    if (source.sourceType === 'local') {
      if (
        plugin.source?.source !== 'local'
        || !await localPluginPathMatches(source, plugin.source?.path)
      ) {
        throw new Error('invalid installed plugin source');
      }
    }
  }
  return plugin;
}

function marketplaceFrom(value) {
  if (!Array.isArray(value.marketplaces)) return null;
  return value.marketplaces.find((marketplace) => marketplace?.name === 'mattstack') ?? null;
}

function requireArray(value, field, context, state, next) {
  if (!Array.isArray(value[field])) {
    throw failure(`${context} returned unexpected JSON`, state, next);
  }
}

export async function installCodex({ source, run = runProcess }) {
  const state = resultState();
  const retry = `Retry installing ${PLUGIN}.`;
  let normalizedSource;
  try {
    normalizedSource = await normalizeMarketplaceSource(source);
  } catch (error) {
    throw failure(
      error.message,
      state,
      'Use an absolute/explicit relative path or a supported Git source.',
    );
  }
  const pluginText = await execute(
    run,
    ['plugin', 'list', '--available', '--json'],
    state,
    'Fix Codex plugin listing and retry.',
  );
  const marketplaceText = await execute(
    run,
    ['plugin', 'marketplace', 'list', '--json'],
    state,
    'Fix Codex marketplace listing and retry.',
  );
  const pluginState = json(
    pluginText,
    'codex plugin list',
    state,
    'Fix Codex plugin listing and retry.',
  );
  const marketplaceState = json(
    marketplaceText,
    'codex plugin marketplace',
    state,
    'Fix Codex marketplace listing and retry.',
  );
  requireArray(
    pluginState,
    'installed',
    'codex plugin list',
    state,
    'Fix Codex plugin listing and retry.',
  );
  requireArray(
    pluginState,
    'available',
    'codex plugin list',
    state,
    'Fix Codex plugin listing and retry.',
  );
  requireArray(
    marketplaceState,
    'marketplaces',
    'codex plugin marketplace',
    state,
    'Fix Codex marketplace listing and retry.',
  );
  let installed;
  try {
    installed = await installedPlugin(pluginState, normalizedSource);
  } catch {
    throw failure(
      'codex plugin list returned unexpected JSON',
      state,
      'Fix Codex plugin listing and retry.',
    );
  }
  const marketplace = marketplaceFrom(marketplaceState);
  if (
    marketplace
    && !await marketplaceSourceMatches(
      normalizedSource,
      marketplace.marketplaceSource?.sourceType,
      marketplace.marketplaceSource?.source,
    )
  ) {
    throw failure(
      'mattstack marketplace is configured from a different source',
      state,
      'Remove the conflicting mattstack marketplace and retry.',
    );
  }

  if (!marketplace) {
    const args = ['plugin', 'marketplace', 'add', normalizedSource.source];
    if (normalizedSource.sourceType === 'git') {
      args.push('--sparse', '.agents/plugins', '--sparse', 'plugins/fast-browser');
    }
    args.push('--json');
    await executeJson(
      run,
      args,
      state,
      retry,
      (value) => (
        value.marketplaceName === 'mattstack'
        && (!Object.hasOwn(value, 'alreadyAdded') || value.alreadyAdded === false)
      ),
    );
    state.changed = true;
    state.changes.push('marketplace-added');
  } else if (normalizedSource.sourceType === 'git') {
    await executeJson(
      run,
      ['plugin', 'marketplace', 'upgrade', 'mattstack', '--json'],
      state,
      'Retry refreshing the mattstack marketplace.',
      (value) => value.marketplaceName === 'mattstack',
    );
    state.changes.push('marketplace-refreshed');
  }

  const exactInstalled = installed
    && installed.version === VERSION;
  if (exactInstalled) return state;
  if (installed) {
    await executeJson(
      run,
      ['plugin', 'remove', PLUGIN, '--json'],
      state,
      retry,
      (value) => value.pluginId === PLUGIN,
    );
    state.changed = true;
    state.changes.push('plugin-removed');
  }
  await executeJson(
    run,
    ['plugin', 'add', PLUGIN, '--json'],
    state,
    retry,
    (value) => value.pluginId === PLUGIN,
  );
  state.changed = true;
  state.changes.push('plugin-installed');
  return state;
}

export async function uninstallCodex({ run = runProcess }) {
  const state = resultState();
  const text = await execute(
    run,
    ['plugin', 'list', '--available', '--json'],
    state,
    `Retry uninstalling ${PLUGIN}.`,
  );
  const value = json(
    text,
    'codex plugin list',
    state,
    `Retry uninstalling ${PLUGIN}.`,
  );
  requireArray(
    value,
    'installed',
    'codex plugin list',
    state,
    `Retry uninstalling ${PLUGIN}.`,
  );
  requireArray(
    value,
    'available',
    'codex plugin list',
    state,
    `Retry uninstalling ${PLUGIN}.`,
  );
  let installed;
  try {
    installed = await installedPlugin(value);
  } catch {
    throw failure(
      'codex plugin list returned unexpected JSON',
      state,
      `Retry uninstalling ${PLUGIN}.`,
    );
  }
  if (!installed) return state;
  await executeJson(
    run,
    ['plugin', 'remove', PLUGIN, '--json'],
    state,
    `Retry uninstalling ${PLUGIN}.`,
    (result) => result.pluginId === PLUGIN,
  );
  state.changed = true;
  state.changes.push('plugin-removed');
  return state;
}
