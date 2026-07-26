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
const HOSTS = Object.freeze(['claude', 'codex']);
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

async function assertConfinedTarget(home, target) {
  const relative = path.relative(home, target);
  if (
    relative === ''
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error(`routing target is not confined to the supplied home: ${target}`);
  }

  let current = home;
  for (const component of relative.split(path.sep)) {
    const state = await stateAt(current);
    if (state?.isSymbolicLink()) {
      throw new Error(`refusing symlink in confined routing path: ${current}`);
    }
    if (state && !state.isDirectory()) {
      throw new Error(`routing parent is not a directory: ${current}`);
    }
    current = path.join(current, component);
  }
  const targetState = await stateAt(target);
  if (targetState?.isSymbolicLink()) {
    throw new Error(`refusing symlink in confined routing path: ${target}`);
  }
}

function selectedHosts(hosts = HOSTS) {
  if (
    !Array.isArray(hosts)
    || hosts.some((host) => !HOSTS.includes(host))
  ) throw new Error('routing hosts must contain only claude and codex');
  const selected = new Set(hosts);
  return HOSTS.filter((host) => selected.has(host));
}

async function assertDesiredTargetsConfined(targets, hosts) {
  const selected = new Set(hosts);
  const desired = [];
  if (selected.has('claude')) {
    desired.push(targets.claudeRouting, targets.claudeConsent);
  }
  if (selected.has('codex')) {
    desired.push(
      targets.codexAgent,
      targets.codexAgents,
      targets.codexOverride,
      targets.codexConfig,
    );
  }
  await Promise.all(desired.map((target) => (
    assertConfinedTarget(targets.home, target)
  )));
}

async function assertRegularOrMissing(target) {
  const state = await stateAt(target);
  if (state?.isSymbolicLink() || (state && !state.isFile())) {
    throw new Error(`routing conflict at non-regular path: ${target}`);
  }
  return state;
}

async function readOptional(target) {
  return (await readOptionalState(target)).text;
}

async function readOptionalState(target) {
  const state = await assertRegularOrMissing(target);
  return {
    exists: Boolean(state),
    text: state ? await readFile(target, 'utf8') : '',
  };
}

async function ensurePrivateDirectory(home, directory) {
  await assertConfinedTarget(home, directory);
  const state = await stateAt(directory);
  if (state?.isSymbolicLink() || (state && !state.isDirectory())) {
    throw new Error(`routing conflict at non-directory path: ${directory}`);
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function atomicWrite(home, target, text) {
  await assertConfinedTarget(home, target);
  await ensurePrivateDirectory(home, path.dirname(target));
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
      || (after === '\r' && text[afterIndex + 1] !== '\n')
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

function recordBlock(pathname, id, kind, installed, containerCreated) {
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
    containerCreated,
  };
}

function priorContainerOwnership(managedState, pathname, id, kind, exists) {
  const prior = managedState?.blocks?.find((entry) => (
    entry.path === pathname && entry.id === id && entry.kind === kind
  ));
  return prior?.containerCreated ?? prior?.removeIfEmpty ?? !exists;
}

function recordedMarkdownTarget(targets, profile, selected, desiredState) {
  if (!desiredState) return null;
  const records = desiredState.blocks.filter(({ id, kind }) => (
    id === MARKDOWN_ID && kind === 'markdown'
  ));
  const expected = profile === 'full' && selected.has('codex') ? 1 : 0;
  if (records.length !== expected) {
    throw new Error('desired routing records do not match the requested layout');
  }
  if (records.length === 0) return null;
  if (records[0].path !== targets.codexAgents && records[0].path !== targets.codexOverride) {
    throw new Error('desired routing records do not match the requested layout');
  }
  return records[0].path;
}

function exactRecordSet(expected, actual, keyFor) {
  if (expected.length !== actual.length) return false;
  const expectedByKey = new Map(expected.map((entry) => [keyFor(entry), entry]));
  const actualByKey = new Map(actual.map((entry) => [keyFor(entry), entry]));
  if (expectedByKey.size !== expected.length || actualByKey.size !== actual.length) return false;
  for (const [key, expectedEntry] of expectedByKey) {
    if (actualByKey.get(key)?.sha256 !== expectedEntry.sha256) return false;
  }
  return true;
}

function exactDesiredRoutingState(computed, desiredState) {
  if (!desiredState) return computed;
  const filesMatch = exactRecordSet(
    desiredState.files,
    computed.files,
    ({ path: pathname }) => pathname,
  );
  const blocksMatch = exactRecordSet(
    desiredState.blocks,
    computed.blocks,
    ({ path: pathname, id, kind }) => `${kind}\0${pathname}\0${id}`,
  );
  if (desiredState.profile !== computed.profile || !filesMatch || !blocksMatch) {
    throw new Error('desired routing records do not match the requested layout');
  }
  return {
    ...computed,
    files: structuredClone(desiredState.files),
    blocks: structuredClone(desiredState.blocks),
  };
}

export async function installRouting({
  profile,
  hosts = HOSTS,
  paths,
  codexVersion = '',
  managedState = null,
  desiredState = null,
}) {
  if (profile !== 'safe' && profile !== 'full') {
    throw new Error(`unsupported routing profile: ${profile}`);
  }
  const targets = targetsFor(paths);
  const configuredHosts = selectedHosts(hosts);
  const selected = new Set(configuredHosts);
  if (desiredState) assertManagedTargets(paths, desiredState);
  await assertDesiredTargetsConfined(targets, configuredHosts);
  const usePreferredModel = shouldUsePreferredCodexModel(codexVersion);
  const desiredAgent = renderCodexAgent({ usePreferredModel });
  const dedicated = [];
  if (selected.has('codex')) {
    dedicated.push(await preflightDedicated(
      targets.codexAgent,
      desiredAgent,
      [
        renderCodexAgent({ usePreferredModel: false }),
        renderCodexAgent({ usePreferredModel: true }),
      ],
    ));
  }

  if (profile === 'full' && selected.has('claude')) {
    dedicated.push(
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

  const blocks = [];
  if (selected.has('codex')) {
    const configState = await readOptionalState(targets.codexConfig);
    const configOriginal = configState.text;
    const configInstalled = upsertTomlBlock(configOriginal, {
      id: POLICY_ID,
      body: profile === 'full' ? FULL_POLICY : SAFE_POLICY,
    });
    blocks.push({
      path: targets.codexConfig,
      original: configOriginal,
      installed: configInstalled,
      record: recordBlock(
        targets.codexConfig,
        POLICY_ID,
        'toml',
        configInstalled,
        priorContainerOwnership(
          managedState,
          targets.codexConfig,
          POLICY_ID,
          'toml',
          configState.exists,
        ),
      ),
    });
  }

  if (profile === 'full' && selected.has('codex')) {
    const overrideState = await assertRegularOrMissing(targets.codexOverride);
    const recordedAgents = recordedMarkdownTarget(
      targets,
      profile,
      selected,
      desiredState,
    );
    const activeAgents = recordedAgents ?? (overrideState
      ? targets.codexOverride
      : targets.codexAgents);
    const agentsState = await readOptionalState(activeAgents);
    const original = agentsState.text;
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
        priorContainerOwnership(
          desiredState ?? managedState,
          activeAgents,
          MARKDOWN_ID,
          'markdown',
          agentsState.exists,
        ),
      ),
    });
  }

  const nextState = exactDesiredRoutingState({
    profile,
    hosts: configuredHosts,
    files: dedicated.map(recordFile),
    blocks: blocks.map(({ record }) => record),
  }, desiredState);
  const priorPlans = managedState
    ? await preflightRemoval(paths, managedState)
    : null;

  for (const plan of dedicated) {
    await atomicWrite(targets.home, plan.path, plan.desired);
  }
  for (const block of blocks) {
    await atomicWrite(targets.home, block.path, block.installed);
  }

  if (priorPlans) {
    const retainedFiles = new Set(nextState.files.map(({ path: target }) => target));
    const retainedBlocks = new Set(nextState.blocks.map(
      ({ path: target, id, kind }) => `${kind}\0${target}\0${id}`,
    ));
    await applyRemovalPlans(targets.home, {
      files: priorPlans.files.filter(
        ({ entry }) => !retainedFiles.has(entry.path),
      ),
      blocks: priorPlans.blocks.filter(
        ({ entry }) => !retainedBlocks.has(
          `${entry.kind}\0${entry.path}\0${entry.id}`,
        ),
      ),
    });
  }

  return nextState;
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
  const targets = targetsFor(paths);
  assertManagedTargets(paths, managedState);
  await Promise.all([
    ...(managedState.files ?? []).map(({ path: target }) => target),
    ...(managedState.blocks ?? []).map(({ path: target }) => target),
  ].map((target) => assertConfinedTarget(targets.home, target)));
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

export async function preflightRoutingRemoval({ paths, managedState }) {
  const plans = await preflightRemoval(paths, managedState);
  return {
    files: plans.files.map(({ entry, exists }) => ({
      path: entry.path,
      exists,
    })),
    blocks: plans.blocks.map(({ entry, installedBlock }) => ({
      path: entry.path,
      id: entry.id,
      kind: entry.kind,
      exists: installedBlock !== null,
    })),
  };
}

export async function removeRouting({ paths, managedState }) {
  const home = targetsFor(paths).home;
  const plans = await preflightRemoval(paths, managedState);
  await applyRemovalPlans(home, plans);
}

async function applyRemovalPlans(home, plans) {
  for (const { entry, exists } of plans.files) {
    if (exists) await unlink(entry.path);
  }
  for (const { entry, current, installedBlock } of plans.blocks) {
    if (!installedBlock) continue;
    const updated = entry.kind === 'toml'
      ? removeTomlBlock(current, entry.id)
      : removeManagedBlock(current, entry.id);
    if (updated === '' && (entry.containerCreated ?? entry.removeIfEmpty)) {
      await unlink(entry.path);
    }
    else await atomicWrite(home, entry.path, updated);
  }
}

export async function beginOwnedCodexAgentFallback({
  paths,
  managedState,
}) {
  const targets = targetsFor(paths);
  await assertConfinedTarget(targets.home, targets.codexAgent);
  assertManagedTargets(paths, managedState);
  const target = targets.codexAgent;
  const entry = managedState.files.find(({ path: pathname }) => pathname === target);
  if (!entry) throw new Error('owned Codex browser-driver agent is not recorded');
  const state = await assertRegularOrMissing(target);
  const originalBytes = state ? await readFile(target) : null;
  const current = originalBytes?.toString('utf8') ?? '';
  if (!state || sha256(originalBytes) !== entry.sha256) {
    throw new Error('Codex agent ownership hash changed.');
  }
  const rewritten = removePreferredModelLine(current);
  if (rewritten === current) {
    return { managedState, rollback: async () => {} };
  }
  await atomicWrite(targets.home, target, rewritten);
  const rewrittenHash = sha256(rewritten);
  const nextManagedState = {
    ...managedState,
    files: managedState.files.map((file) => (
      file.path === target ? { ...file, sha256: rewrittenHash } : file
    )),
  };
  return {
    managedState: nextManagedState,
    rollback: async () => {
      const nextState = await assertRegularOrMissing(target);
      const nextBytes = nextState ? await readFile(target) : null;
      if (!nextState || sha256(nextBytes) !== rewrittenHash) {
        throw new Error('Codex agent ownership hash changed before rollback.');
      }
      await atomicWrite(targets.home, target, originalBytes);
    },
  };
}

export async function rewriteOwnedCodexAgentWithoutPreferredModel(options) {
  const receipt = await beginOwnedCodexAgentFallback(options);
  return receipt.managedState;
}
