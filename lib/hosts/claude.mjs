import { readFileSync } from 'node:fs';

import { run as runProcess } from '../core/process.mjs';
import {
  marketplaceSourceMatches,
  normalizeMarketplaceSource,
} from './source.mjs';

const PLUGIN = 'fast-browser@mattstack';
// package.json, not .claude-plugin/plugin.json: the two carry the same version
// by release gate, but a consumer that embeds this package in a signed macOS
// app bundle must strip dotted directories — codesign rejects them as
// malformed nested bundles — and reading one at import time makes the whole
// module unloadable there.
const VERSION = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).version;

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

function parseJson(output) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error('invalid JSON');
  }
}

function parsePluginList(output) {
  const plugins = parseJson(output);
  if (!Array.isArray(plugins)) throw new Error('unexpected shape');
  const installed = plugins.find((entry) => entry && entry.id === PLUGIN);
  if (!installed) return { kind: 'absent' };
  const { version } = installed;
  if (typeof version !== 'string' || !/^\S+$/.test(version)) throw new Error('version');
  return { kind: 'present', version };
}

// Claude Code's marketplace entries carry a `source` discriminator whose
// values ('github', 'git', 'url', 'npm', ...) this host only ever needs to
// tell apart from 'directory': every non-directory kind resolves to a
// comparable source string on either `repo` (GitHub shorthand) or `url`
// (a plain git/https source), which normalizeMarketplaceSource's 'git'
// sourceType output is compared against.
function parseMarketplaceList(output) {
  const marketplaces = parseJson(output);
  if (!Array.isArray(marketplaces)) throw new Error('unexpected shape');
  const marketplace = marketplaces.find((entry) => entry && entry.name === 'mattstack');
  if (!marketplace) return { kind: 'absent' };
  if (marketplace.source === 'directory') {
    const { path } = marketplace;
    if (typeof path !== 'string' || path.length === 0) throw new Error('source');
    return { kind: 'present', sourceType: 'local', source: path };
  }
  const source = marketplace.repo ?? marketplace.url;
  if (typeof source !== 'string' || source.length === 0) throw new Error('source');
  return { kind: 'present', sourceType: 'git', source };
}

export async function installClaude({ source, run = runProcess }) {
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
  const [pluginOutput, marketplaceOutput] = await Promise.all([
    execute(run, ['plugin', 'list', '--json'], state, 'Fix Claude plugin listing and retry.'),
    execute(
      run,
      ['plugin', 'marketplace', 'list', '--json'],
      state,
      'Fix Claude marketplace listing and retry.',
    ),
  ]);
  let installed;
  let marketplace;
  try {
    installed = parsePluginList(pluginOutput);
  } catch {
    throw failure(
      'claude plugin list returned unrecognized output',
      state,
      'Update Claude Code and retry.',
    );
  }
  try {
    marketplace = parseMarketplaceList(marketplaceOutput);
  } catch {
    throw failure(
      'claude plugin marketplace list returned unrecognized output',
      state,
      'Update Claude Code and retry.',
    );
  }
  if (
    marketplace.kind === 'present'
    && !await marketplaceSourceMatches(
      normalizedSource,
      marketplace.sourceType,
      marketplace.source,
    )
  ) {
    throw failure(
      'mattstack marketplace is configured from a different source',
      state,
      'Remove the conflicting mattstack marketplace and retry.',
    );
  }

  if (marketplace.kind === 'absent') {
    const args = [
      'plugin',
      'marketplace',
      'add',
      normalizedSource.source,
      '--scope',
      'user',
    ];
    await execute(run, args, state, retry);
    state.changed = true;
    state.changes.push('marketplace-added');
  } else if (normalizedSource.sourceType === 'git') {
    await execute(
      run,
      ['plugin', 'marketplace', 'update', 'mattstack'],
      state,
      'Retry refreshing the mattstack marketplace.',
    );
    state.changes.push('marketplace-refreshed');
  }

  if (installed.kind === 'present' && installed.version === VERSION) return state;
  if (installed.kind === 'present') {
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
    ['plugin', 'list', '--json'],
    state,
    `Retry uninstalling ${PLUGIN}.`,
  );
  let installed;
  try {
    installed = parsePluginList(output);
  } catch {
    throw failure(
      'claude plugin list returned unrecognized output',
      state,
      'Update Claude Code and retry.',
    );
  }
  if (installed.kind === 'absent') return state;
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

export async function preflightClaudeUninstall({ run = runProcess } = {}) {
  const state = resultState();
  const output = await execute(
    run,
    ['plugin', 'list', '--json'],
    state,
    `Retry inspecting ${PLUGIN}.`,
  );
  try {
    const installed = parsePluginList(output);
    return { host: 'claude', installed: installed.kind === 'present' };
  } catch {
    throw failure(
      'claude plugin list returned unrecognized output',
      state,
      'Update Claude Code and retry.',
    );
  }
}
