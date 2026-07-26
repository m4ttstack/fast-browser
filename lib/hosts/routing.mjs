import crypto from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import {
  removePreferredModelLine,
  renderCodexAgent,
  shouldUsePreferredCodexModel,
} from './codex-agent.mjs';
import { removeManagedBlock, upsertManagedBlock } from './managed-block.mjs';

const MARKDOWN_ID = 'routing-v1';
const POLICY_ID = 'mcp-policy-v1';
const SAFE_POLICY = [
  '[plugins."fast-browser@mattstack".mcp_servers.fast_browser]',
  'enabled = true',
  'default_tools_approval_mode = "writes"',
  '',
  '[plugins."fast-browser@mattstack".mcp_servers.fast_browser.tools.browser_run_code_unsafe]',
  'approval_mode = "prompt"',
].join('\n');
const FULL_POLICY = SAFE_POLICY
  .replace('"writes"', '"approve"')
  .replace('"prompt"', '"approve"');

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

async function stateAt(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function targetsFor(paths) {
  const home = path.resolve(paths.homeDir);
  const claudeRules = path.join(home, '.claude', 'rules');
  const codex = path.join(home, '.codex');
  return {
    home,
    claudeRouting: path.join(claudeRules, 'fast-browser-routing.md'),
    claudeConsent: path.join(
      claudeRules,
      'fast-browser-verification-consent.md',
    ),
    codexAgent: path.join(codex, 'agents', 'browser_driver.toml'),
    codexAgents: path.join(codex, 'AGENTS.md'),
    codexOverride: path.join(codex, 'AGENTS.override.md'),
    codexConfig: path.join(codex, 'config.toml'),
  };
}

async function assertRegularOrMissing(target) {
  const state = await stateAt(target);
  if (state?.isSymbolicLink() || (state && !state.isFile())) {
    throw new Error(`routing conflict at non-regular path: ${target}`);
  }
  return state;
}

async function readOptional(target) {
  const state = await assertRegularOrMissing(target);
  return state ? readFile(target, 'utf8') : '';
}

async function ensurePrivateDirectory(directory) {
  const state = await stateAt(directory);
  if (state?.isSymbolicLink() || (state && !state.isDirectory())) {
    throw new Error(`routing conflict at non-directory path: ${directory}`);
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function atomicWrite(target, text) {
  await ensurePrivateDirectory(path.dirname(target));
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') error.cleanupError = cleanupError;
    }
    throw error;
  }
}

function newlineFor(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function parseTomlBlocks(text) {
  const exact =
    /# fast-browser:(start|end) ([A-Za-z0-9][A-Za-z0-9._-]*)/g;
  const prefix = /# fast-browser:(?:start|end)\b/g;
  const markers = [...text.matchAll(exact)];
  const starts = new Set(markers.map((marker) => marker.index));
  for (const marker of text.matchAll(prefix)) {
    if (!starts.has(marker.index)) {
      throw new Error('malformed Fast Browser TOML marker');
    }
  }
  const blocks = new Map();
  let active = null;
  for (const marker of markers) {
    const [value, kind, id] = marker;
    const before = marker.index === 0 ? '' : text[marker.index - 1];
    const afterIndex = marker.index + value.length;
    const after = text[afterIndex] ?? '';
    if (
      (before !== '' && before !== '\n')
      || (after !== '' && after !== '\r' && after !== '\n')
    ) {
      throw new Error('malformed Fast Browser TOML marker');
    }
    if (kind === 'start') {
      if (active) throw new Error('overlapping Fast Browser TOML blocks');
      if (blocks.has(id)) {
        throw new Error(`duplicate Fast Browser TOML block: ${id}`);
      }
      active = { id, start: marker.index };
    } else {
      if (!active) throw new Error('malformed Fast Browser TOML markers');
      if (active.id !== id) {
        throw new Error('overlapping Fast Browser TOML blocks');
      }
      blocks.set(id, { start: active.start, end: afterIndex });
      active = null;
    }
  }
  if (active) throw new Error('malformed Fast Browser TOML markers');
  return blocks;
}

function renderTomlBlock(id, body, newline) {
  return [
    `# fast-browser:start ${id}`,
    body.replace(/\r\n|\r|\n/g, newline).replace(/(?:\r\n|\r|\n)$/, ''),
    `# fast-browser:end ${id}`,
  ].join(newline);
}

function upsertTomlBlock(text, { id, body }) {
  const existing = parseTomlBlocks(text).get(id);
  const newline = newlineFor(text);
  const rendered = renderTomlBlock(id, body, newline);
  if (!existing) return text.length === 0 ? rendered : text + newline + rendered;
  return text.slice(0, existing.start) + rendered + text.slice(existing.end);
}

function removeTomlBlock(text, id) {
  const block = parseTomlBlocks(text).get(id);
  if (!block) return text;
  let prefix = text.slice(0, block.start);
  let suffix = text.slice(block.end);
  if (prefix.endsWith('\r\n')) prefix = prefix.slice(0, -2);
  else if (prefix.endsWith('\n')) prefix = prefix.slice(0, -1);
  else if (suffix.startsWith('\r\n')) suffix = suffix.slice(2);
  else if (suffix.startsWith('\n')) suffix = suffix.slice(1);
  return prefix + suffix;
}

function exactBlock(text, start, end) {
  const first = text.indexOf(start);
  const last = text.indexOf(end, first);
  if (first < 0 || last < 0) throw new Error('installed managed block missing');
  return text.slice(first, last + end.length);
}

async function template(relative) {
  return readFile(new URL(`../../templates/${relative}`, import.meta.url), 'utf8');
}

async function preflightDedicated(target, desired, allowed = [desired]) {
  const state = await assertRegularOrMissing(target);
  const current = state ? await readFile(target, 'utf8') : '';
  if (state && !allowed.includes(current)) {
    throw new Error(`non-owned routing file conflict: ${target}`);
  }
  return { path: target, desired };
}

function recordFile(plan) {
  return { path: plan.path, sha256: sha256(plan.desired) };
}

function recordBlock(pathname, id, kind, installed, removeIfEmpty) {
  const start = kind === 'toml'
    ? `# fast-browser:start ${id}`
    : `<!-- fast-browser:start ${id} -->`;
  const end = kind === 'toml'
    ? `# fast-browser:end ${id}`
    : `<!-- fast-browser:end ${id} -->`;
  return {
    path: pathname,
    id,
    kind,
    sha256: sha256(exactBlock(installed, start, end)),
    removeIfEmpty,
  };
}

export async function installRouting({
  profile,
  paths,
  codexVersion = '',
}) {
  if (profile !== 'safe' && profile !== 'full') {
    throw new Error(`unsupported routing profile: ${profile}`);
  }
  const targets = targetsFor(paths);
  const usePreferredModel = shouldUsePreferredCodexModel(codexVersion);
  const desiredAgent = renderCodexAgent({ usePreferredModel });
  const dedicated = [
    await preflightDedicated(
      targets.codexAgent,
      desiredAgent,
      [
        renderCodexAgent({ usePreferredModel: false }),
        renderCodexAgent({ usePreferredModel: true }),
      ],
    ),
  ];

  if (profile === 'full') {
    dedicated.unshift(
      await preflightDedicated(
        targets.claudeRouting,
        await template('routing/claude/fast-browser-routing.md'),
      ),
      await preflightDedicated(
        targets.claudeConsent,
        await template('routing/claude/fast-browser-verification-consent.md'),
      ),
    );
  }

  const configOriginal = await readOptional(targets.codexConfig);
  const configInstalled = upsertTomlBlock(configOriginal, {
    id: POLICY_ID,
    body: profile === 'full' ? FULL_POLICY : SAFE_POLICY,
  });
  const blocks = [{
    path: targets.codexConfig,
    original: configOriginal,
    installed: configInstalled,
    record: recordBlock(
      targets.codexConfig,
      POLICY_ID,
      'toml',
      configInstalled,
      removeTomlBlock(configInstalled, POLICY_ID) === '',
    ),
  }];

  if (profile === 'full') {
    const overrideState = await assertRegularOrMissing(targets.codexOverride);
    const activeAgents = overrideState
      ? targets.codexOverride
      : targets.codexAgents;
    const original = await readOptional(activeAgents);
    const installed = upsertManagedBlock(original, {
      id: MARKDOWN_ID,
      body: await template('routing/codex/fast-browser.md'),
    });
    blocks.unshift({
      path: activeAgents,
      original,
      installed,
      record: recordBlock(
        activeAgents,
        MARKDOWN_ID,
        'markdown',
        installed,
        removeManagedBlock(installed, MARKDOWN_ID) === '',
      ),
    });
  }

  for (const plan of dedicated) await atomicWrite(plan.path, plan.desired);
  for (const block of blocks) await atomicWrite(block.path, block.installed);

  return {
    profile,
    files: dedicated.map(recordFile),
    blocks: blocks.map(({ record }) => record),
  };
}

function assertManagedTargets(paths, managedState) {
  const targets = targetsFor(paths);
  const allowedFiles = new Set([
    targets.claudeRouting,
    targets.claudeConsent,
    targets.codexAgent,
  ]);
  const allowedBlocks = new Set([
    targets.codexAgents,
    targets.codexOverride,
    targets.codexConfig,
  ]);
  for (const entry of managedState.files ?? []) {
    if (!allowedFiles.has(entry.path)) {
      throw new Error(`invalid managed routing file path: ${entry.path}`);
    }
  }
  for (const entry of managedState.blocks ?? []) {
    if (!allowedBlocks.has(entry.path)) {
      throw new Error(`invalid managed routing block path: ${entry.path}`);
    }
  }
}

async function preflightRemoval(paths, managedState) {
  assertManagedTargets(paths, managedState);
  const files = [];
  for (const entry of managedState.files) {
    const state = await assertRegularOrMissing(entry.path);
    const current = state ? await readFile(entry.path, 'utf8') : '';
    if (state && sha256(current) !== entry.sha256) {
      throw new Error(`routing file ownership hash changed: ${entry.path}`);
    }
    files.push({ entry, current, exists: Boolean(state) });
  }
  const blocks = [];
  for (const entry of managedState.blocks) {
    const current = await readOptional(entry.path);
    if (current === '') {
      blocks.push({ entry, current, installedBlock: null });
      continue;
    }
    const start = entry.kind === 'toml'
      ? `# fast-browser:start ${entry.id}`
      : `<!-- fast-browser:start ${entry.id} -->`;
    const end = entry.kind === 'toml'
      ? `# fast-browser:end ${entry.id}`
      : `<!-- fast-browser:end ${entry.id} -->`;
    if (entry.kind === 'toml') parseTomlBlocks(current);
    else upsertManagedBlock(current, { id: entry.id, body: '' });
    const first = current.indexOf(start);
    const last = current.indexOf(end, first);
    const installedBlock = first < 0 || last < 0
      ? null
      : current.slice(first, last + end.length);
    if (installedBlock && sha256(installedBlock) !== entry.sha256) {
      throw new Error(`routing block ownership hash changed: ${entry.path}`);
    }
    blocks.push({ entry, current, installedBlock });
  }
  return { files, blocks };
}

export async function removeRouting({ paths, managedState }) {
  const plans = await preflightRemoval(paths, managedState);
  for (const { entry, exists } of plans.files) {
    if (exists) await unlink(entry.path);
  }
  for (const { entry, current, installedBlock } of plans.blocks) {
    if (!installedBlock) continue;
    const updated = entry.kind === 'toml'
      ? removeTomlBlock(current, entry.id)
      : removeManagedBlock(current, entry.id);
    if (updated === '' && entry.removeIfEmpty) await unlink(entry.path);
    else await atomicWrite(entry.path, updated);
  }
}

export async function rewriteOwnedCodexAgentWithoutPreferredModel({
  paths,
  managedState,
}) {
  assertManagedTargets(paths, managedState);
  const target = targetsFor(paths).codexAgent;
  const entry = managedState.files.find(({ path: pathname }) => pathname === target);
  if (!entry) throw new Error('owned Codex browser-driver agent is not recorded');
  const state = await assertRegularOrMissing(target);
  const current = state ? await readFile(target, 'utf8') : '';
  if (!state || sha256(current) !== entry.sha256) {
    throw new Error(`Codex agent ownership hash changed: ${target}`);
  }
  const rewritten = removePreferredModelLine(current);
  if (rewritten === current) return managedState;
  await atomicWrite(target, rewritten);
  return {
    ...managedState,
    files: managedState.files.map((file) => (
      file.path === target ? { ...file, sha256: sha256(rewritten) } : file
    )),
  };
}
