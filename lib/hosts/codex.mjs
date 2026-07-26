import { readFileSync } from 'node:fs';

import { run as runProcess } from '../core/process.mjs';

const PLUGIN = 'fast-browser@mattstack';
const VERSION = JSON.parse(
  readFileSync(new URL('../../.codex-plugin/plugin.json', import.meta.url), 'utf8'),
).version;

function localSource(source) {
  return source.startsWith('/') || source.startsWith('./') || source.startsWith('../');
}

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

async function executeJson(run, args, state, next) {
  const output = await execute(run, args, state, next);
  return json(output, `codex ${args.slice(0, 2).join(' ')}`, state, next);
}

function pluginFrom(value) {
  if (!Array.isArray(value.installed)) return null;
  return value.installed.find((plugin) => (
    plugin
    && plugin.pluginId === PLUGIN
    && plugin.name === 'fast-browser'
    && plugin.marketplaceName === 'mattstack'
  )) ?? null;
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
  const marketplace = marketplaceFrom(marketplaceState);
  if (marketplace && marketplace.marketplaceSource?.source !== source) {
    throw failure(
      'mattstack marketplace is configured from a different source',
      state,
      'Remove the conflicting mattstack marketplace and retry.',
    );
  }

  if (!marketplace) {
    const args = ['plugin', 'marketplace', 'add', source];
    if (!localSource(source)) {
      args.push('--sparse', '.agents/plugins', '--sparse', 'plugins/fast-browser');
    }
    args.push('--json');
    await executeJson(run, args, state, retry);
    state.changed = true;
    state.changes.push('marketplace-added');
  } else if (!localSource(source)) {
    await executeJson(
      run,
      ['plugin', 'marketplace', 'upgrade', 'mattstack', '--json'],
      state,
      'Retry refreshing the mattstack marketplace.',
    );
    state.changes.push('marketplace-refreshed');
  }

  const installed = pluginFrom(pluginState);
  const exactInstalled = installed
    && installed.version === VERSION
    && installed.marketplaceSource?.source === source;
  if (exactInstalled) return state;
  if (installed) {
    await executeJson(run, ['plugin', 'remove', PLUGIN, '--json'], state, retry);
    state.changed = true;
    state.changes.push('plugin-removed');
  }
  await executeJson(run, ['plugin', 'add', PLUGIN, '--json'], state, retry);
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
  if (!pluginFrom(value)) return state;
  await executeJson(
    run,
    ['plugin', 'remove', PLUGIN, '--json'],
    state,
    `Retry uninstalling ${PLUGIN}.`,
  );
  state.changed = true;
  state.changes.push('plugin-removed');
  return state;
}
