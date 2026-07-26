import { readFileSync } from 'node:fs';

import { run as runProcess } from '../core/process.mjs';
import {
  marketplaceSourceMatches,
  normalizeMarketplaceSource,
} from './source.mjs';

const PLUGIN = 'fast-browser@mattstack';
const VERSION = JSON.parse(
  readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8'),
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

function parseBlocks(output, emptyText, heading) {
  if (output.includes('[output truncated at 1048576 bytes]')) throw new Error('truncated');
  const text = output.replaceAll('\r\n', '\n').replace(/\n+$/, '');
  if (text === emptyText) return [];
  const lines = text.split('\n');
  if (lines.shift() !== heading) throw new Error('heading');

  const blocks = [];
  let block;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const selector = /^\s{2,}❯\s+(\S+)\s*$/.exec(line);
    if (selector) {
      block = { selector: selector[1], fields: new Map() };
      blocks.push(block);
      continue;
    }
    const field = /^\s{4,}([A-Za-z][A-Za-z ]*):\s*(.+?)\s*$/.exec(line);
    if (!block || !field || block.fields.has(field[1])) throw new Error('block');
    block.fields.set(field[1], field[2]);
  }
  if (blocks.length === 0) throw new Error('empty blocks');
  return blocks;
}

function parsePluginList(output) {
  const blocks = parseBlocks(
    output,
    'No plugins installed. Use `claude plugin install` to install a plugin.',
    'Installed plugins:',
  );
  for (const block of blocks) {
    const version = block.fields.get('Version');
    if (!version || !/^\S+$/.test(version)) throw new Error('version');
  }
  const installed = blocks.find(({ selector }) => selector === PLUGIN);
  return installed
    ? { kind: 'present', version: installed.fields.get('Version') }
    : { kind: 'absent' };
}

function parseMarketplaceList(output) {
  const blocks = parseBlocks(
    output,
    'No marketplaces configured',
    'Configured marketplaces:',
  );
  for (const block of blocks) {
    const source = /^([^()]+?)\s+\((.+)\)$/.exec(block.fields.get('Source') ?? '');
    if (!source) throw new Error('source');
    const label = source[1].trim();
    if (!['Directory', 'Git', 'GitHub'].includes(label)) throw new Error('source type');
    block.sourceType = label === 'Directory' ? 'local' : 'git';
    block.source = source[2];
  }
  const marketplace = blocks.find(({ selector }) => selector === 'mattstack');
  return marketplace
    ? {
      kind: 'present',
      sourceType: marketplace.sourceType,
      source: marketplace.source,
    }
    : { kind: 'absent' };
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
    execute(run, ['plugin', 'list'], state, 'Fix Claude plugin listing and retry.'),
    execute(
      run,
      ['plugin', 'marketplace', 'list'],
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
    if (normalizedSource.sourceType === 'git') {
      args.push('--sparse', '.claude-plugin', 'plugins/fast-browser');
    }
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
    ['plugin', 'list'],
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
    ['plugin', 'list'],
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
