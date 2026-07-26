import { readFileSync } from 'node:fs';

import { run as runProcess } from '../core/process.mjs';

const PLUGIN = 'fast-browser@mattstack';
const VERSION = JSON.parse(
  readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8'),
).version;

function localSource(source) {
  return source.startsWith('/') || source.startsWith('./') || source.startsWith('../');
}

function resultState(changed = false, changes = []) {
  return { host: 'claude', changed, changes };
}

function failure(message, state, next) {
  const error = new Error(message);
  error.name = 'HostInstallError';
  error.result = { ...state, next };
  return error;
}

async function execute(run, args, state, next) {
  const context = `claude ${args.slice(0, 2).join(' ')}`;
  let commandResult;
  try {
    commandResult = await run('claude', args);
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'unknown error';
    throw failure(`${context} failed to start: ${code}`, state, next);
  }
  if (commandResult.exitCode !== 0) {
    throw failure(`${context} exited with code ${commandResult.exitCode}`, state, next);
  }
  return commandResult.stdout;
}

function installedVersion(output) {
  const lines = output.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== `❯ ${PLUGIN}`) continue;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor].trim();
      if (line.startsWith('❯ ')) break;
      const match = /^Version:\s*(\S+)$/.exec(line);
      if (match) return match[1];
    }
    return null;
  }
  return null;
}

function marketplaceSource(output) {
  const lines = output.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== '❯ mattstack') continue;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor].trim();
      if (line.startsWith('❯ ')) break;
      const match = /^Source:\s*[^()]+\((.*)\)$/.exec(line);
      if (match) return match[1];
    }
    return '';
  }
  return null;
}

export async function installClaude({ source, run = runProcess }) {
  const state = resultState();
  const retry = `Retry installing ${PLUGIN}.`;
  const [pluginOutput, marketplaceOutput] = await Promise.all([
    execute(run, ['plugin', 'list'], state, 'Fix Claude plugin listing and retry.'),
    execute(
      run,
      ['plugin', 'marketplace', 'list'],
      state,
      'Fix Claude marketplace listing and retry.',
    ),
  ]);
  const configuredSource = marketplaceSource(marketplaceOutput);
  if (configuredSource !== null && configuredSource !== source) {
    throw failure(
      'mattstack marketplace is configured from a different source',
      state,
      'Remove the conflicting mattstack marketplace and retry.',
    );
  }

  if (configuredSource === null) {
    const args = ['plugin', 'marketplace', 'add', source, '--scope', 'user'];
    if (!localSource(source)) args.push('--sparse', '.claude-plugin', 'plugins/fast-browser');
    await execute(run, args, state, retry);
    state.changed = true;
    state.changes.push('marketplace-added');
  } else if (!localSource(source)) {
    await execute(
      run,
      ['plugin', 'marketplace', 'update', 'mattstack'],
      state,
      'Retry refreshing the mattstack marketplace.',
    );
    state.changes.push('marketplace-refreshed');
  }

  const currentVersion = installedVersion(pluginOutput);
  if (currentVersion === VERSION) return state;
  if (currentVersion !== null) {
    await execute(
      run,
      ['plugin', 'uninstall', PLUGIN, '--scope', 'user'],
      state,
      retry,
    );
    state.changed = true;
    state.changes.push('plugin-removed');
  }
  await execute(run, ['plugin', 'install', PLUGIN, '--scope', 'user'], state, retry);
  state.changed = true;
  state.changes.push('plugin-installed');
  return state;
}

export async function uninstallClaude({ run = runProcess }) {
  const state = resultState();
  const output = await execute(
    run,
    ['plugin', 'list'],
    state,
    `Retry uninstalling ${PLUGIN}.`,
  );
  if (installedVersion(output) === null) return state;
  await execute(
    run,
    ['plugin', 'uninstall', PLUGIN, '--scope', 'user'],
    state,
    `Retry uninstalling ${PLUGIN}.`,
  );
  state.changed = true;
  state.changes.push('plugin-removed');
  return state;
}
