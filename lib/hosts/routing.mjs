import crypto from 'node:crypto';
import {
  lstat,
  readFile,
} from 'node:fs/promises';
import path from 'node:path';

import {
  removePreferredModelLine,
  renderCodexAgent,
  shouldUsePreferredCodexModel,
} from './codex-agent.mjs';
import { prepareFileTransaction } from './file-transaction.mjs';
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

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
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

function snapshotPathUnion({
  targets,
  profile,
  configuredHosts = [],
  managedState,
  desiredState,
}) {
  const pathnames = new Set();
  for (const state of [managedState, desiredState]) {
    for (const entry of state?.files ?? []) pathnames.add(entry.path);
    for (const entry of state?.blocks ?? []) pathnames.add(entry.path);
  }
  const selected = new Set(configuredHosts);
  if (profile === 'full' && selected.has('claude')) {
    pathnames.add(targets.claudeRouting);
    pathnames.add(targets.claudeConsent);
  }
  if (selected.has('codex')) {
    pathnames.add(targets.codexAgent);
    pathnames.add(targets.codexConfig);
    if (profile === 'full') {
      pathnames.add(targets.codexAgents);
      pathnames.add(targets.codexOverride);
    }
  }
  return [...pathnames];
}

async function assertConfinedTarget(home, target) {
  const relative = path.relative(home, target);
  if (
    relative === ''
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error('routing target is not confined to the supplied home');
  }

  let current = home;
  for (const component of relative.split(path.sep)) {
    const state = await stateAt(current);
    if (state?.isSymbolicLink()) {
      throw new Error('refusing symlink in confined routing path');
    }
    if (state && !state.isDirectory()) {
      throw new Error('routing parent is not a directory');
    }
    current = path.join(current, component);
  }
  const targetState = await stateAt(target);
  if (targetState?.isSymbolicLink()) {
    throw new Error('refusing symlink in confined routing path');
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

async function assertRegularOrMissing(target) {
  const state = await stateAt(target);
  if (state?.isSymbolicLink() || (state && !state.isFile())) {
    throw new Error('routing conflict at non-regular path');
  }
  return state;
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

function markerFor(id, kind) {
  return kind === 'toml'
    ? {
      start: `# fast-browser:start ${id}`,
      end: `# fast-browser:end ${id}`,
    }
    : {
      start: `<!-- fast-browser:start ${id} -->`,
      end: `<!-- fast-browser:end ${id} -->`,
    };
}

function blockAt(text, id, kind) {
  let range;
  if (kind === 'toml') {
    range = parseTomlBlocks(text).get(id);
  } else {
    upsertManagedBlock(text, { id, body: '' });
    const { start, end } = markerFor(id, kind);
    const first = text.indexOf(start);
    const last = text.indexOf(end, first);
    range = first < 0 || last < 0
      ? null
      : { start: first, end: last + end.length };
  }
  return range ? text.slice(range.start, range.end) : null;
}

async function template(relative) {
  return readFile(new URL(`../../templates/${relative}`, import.meta.url), 'utf8');
}

function recordFile(pathname, bytes) {
  return { path: pathname, sha256: sha256(bytes) };
}

function recordBlock(pathname, id, kind, installed, containerCreated) {
  const exact = blockAt(installed, id, kind);
  if (exact === null) throw new Error('installed managed block missing');
  return {
    path: pathname,
    id,
    kind,
    sha256: sha256(exact),
    containerCreated,
  };
}

function priorContainerOwnership(state, pathname, id, kind, exists) {
  const prior = state?.blocks?.find((entry) => (
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
  if (
    records[0].path !== targets.codexAgents
    && records[0].path !== targets.codexOverride
  ) {
    throw new Error('desired routing records do not match the requested layout');
  }
  return records[0].path;
}

function blockKey({ path: pathname, id, kind }) {
  return `${kind}\0${pathname}\0${id}`;
}

function exactRecordSet(expected, actual, keyFor, fields) {
  if (expected.length !== actual.length) return false;
  const expectedByKey = new Map(expected.map((entry) => [keyFor(entry), entry]));
  const actualByKey = new Map(actual.map((entry) => [keyFor(entry), entry]));
  if (
    expectedByKey.size !== expected.length
    || actualByKey.size !== actual.length
  ) return false;
  for (const [key, expectedEntry] of expectedByKey) {
    const actualEntry = actualByKey.get(key);
    if (!actualEntry) return false;
    if (fields.some((field) => actualEntry[field] !== expectedEntry[field])) {
      return false;
    }
  }
  return true;
}

function exactDesiredRoutingState(computed, desiredState) {
  if (!desiredState) return computed;
  const filesMatch = exactRecordSet(
    desiredState.files,
    computed.files,
    ({ path: pathname }) => pathname,
    ['sha256'],
  );
  const blocksMatch = exactRecordSet(
    desiredState.blocks,
    computed.blocks,
    blockKey,
    ['sha256', 'containerCreated'],
  );
  const hostsMatch = desiredState.hosts === undefined
    || JSON.stringify(selectedHosts(desiredState.hosts))
      === JSON.stringify(computed.hosts);
  if (
    desiredState.profile !== computed.profile
    || !hostsMatch
    || !filesMatch
    || !blocksMatch
  ) {
    throw new Error('desired routing records do not match the requested layout');
  }
  return Object.freeze({
    ...computed,
    files: structuredClone(desiredState.files),
    blocks: structuredClone(desiredState.blocks),
  });
}

function assertManagedTargets(paths, state) {
  if (
    !state
    || typeof state !== 'object'
    || (state.profile !== 'safe' && state.profile !== 'full')
    || !Array.isArray(state.files)
    || !Array.isArray(state.blocks)
  ) {
    throw new Error('invalid managed routing state');
  }
  if (state.hosts !== undefined) selectedHosts(state.hosts);
  const targets = targetsFor(paths);
  const allowedFiles = new Set([
    targets.claudeRouting,
    targets.claudeConsent,
    targets.codexAgent,
  ]);
  const allowedBlocks = new Map([
    [`markdown\0${targets.codexAgents}\0${MARKDOWN_ID}`, true],
    [`markdown\0${targets.codexOverride}\0${MARKDOWN_ID}`, true],
    [`toml\0${targets.codexConfig}\0${POLICY_ID}`, true],
  ]);
  const seenFiles = new Set();
  for (const entry of state.files) {
    if (
      !entry
      || typeof entry !== 'object'
      || !allowedFiles.has(entry.path)
      || seenFiles.has(entry.path)
      || typeof entry.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      throw new Error('invalid managed routing file record');
    }
    seenFiles.add(entry.path);
  }
  const seenBlocks = new Set();
  for (const entry of state.blocks) {
    const key = entry && typeof entry === 'object' ? blockKey(entry) : '';
    if (
      !allowedBlocks.has(key)
      || seenBlocks.has(key)
      || typeof entry.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(entry.sha256)
      || (
        entry.containerCreated !== undefined
        && typeof entry.containerCreated !== 'boolean'
      )
      || (
        entry.removeIfEmpty !== undefined
        && typeof entry.removeIfEmpty !== 'boolean'
      )
    ) {
      throw new Error('invalid managed routing block record');
    }
    seenBlocks.add(key);
  }
}

async function snapshotTargets(pathnames) {
  const snapshots = new Map();
  for (const target of pathnames) {
    const state = await assertRegularOrMissing(target);
    snapshots.set(target, Object.freeze({
      exists: Boolean(state),
      bytes: state ? await readFile(target) : null,
    }));
  }
  return snapshots;
}

function snapshotText(snapshot) {
  return snapshot.exists ? snapshot.bytes.toString('utf8') : '';
}

function validateOwnership(snapshots, managedState) {
  const files = [];
  for (const entry of managedState?.files ?? []) {
    const snapshot = snapshots.get(entry.path);
    if (snapshot.exists && sha256(snapshot.bytes) !== entry.sha256) {
      throw new Error('routing file ownership hash changed');
    }
    files.push({ entry, exists: snapshot.exists });
  }
  const blocks = [];
  for (const entry of managedState?.blocks ?? []) {
    const snapshot = snapshots.get(entry.path);
    const installedBlock = blockAt(
      snapshotText(snapshot),
      entry.id,
      entry.kind,
    );
    if (installedBlock && sha256(installedBlock) !== entry.sha256) {
      throw new Error('routing block ownership hash changed');
    }
    blocks.push({ entry, installedBlock });
  }
  return { files, blocks };
}

async function prepareContext({
  paths,
  profile = null,
  configuredHosts = [],
  managedState,
  desiredState = null,
}) {
  if (managedState) assertManagedTargets(paths, managedState);
  if (desiredState) assertManagedTargets(paths, desiredState);
  const targets = targetsFor(paths);
  const pathnames = snapshotPathUnion({
    targets,
    profile,
    configuredHosts,
    managedState,
    desiredState,
  });
  await Promise.all(pathnames.map((target) => (
    assertConfinedTarget(targets.home, target)
  )));
  const snapshots = await snapshotTargets(pathnames);
  const ownership = validateOwnership(snapshots, managedState);
  return { targets, snapshots, ownership };
}

function cloneSnapshots(snapshots) {
  return new Map([...snapshots].map(([pathname, snapshot]) => [
    pathname,
    {
      exists: snapshot.exists,
      bytes: snapshot.exists ? Buffer.from(snapshot.bytes) : null,
    },
  ]));
}

function snapshotsEqual(left, right) {
  return left.exists === right.exists
    && (left.exists ? left.bytes.equals(right.bytes) : left.bytes === null);
}

function changesFromSnapshots(original, working) {
  const changes = [];
  for (const [pathname, before] of original) {
    const after = working.get(pathname);
    changes.push({ path: pathname, before, after });
  }
  return changes;
}

function removeOwnedRecords(working, ownership, retainedFiles, retainedBlocks) {
  for (const { entry, exists } of ownership.files) {
    if (!retainedFiles.has(entry.path) && exists) {
      working.set(entry.path, { exists: false, bytes: null });
    }
  }
  for (const { entry, installedBlock } of ownership.blocks) {
    if (retainedBlocks.has(blockKey(entry)) || installedBlock === null) continue;
    const current = working.get(entry.path);
    const text = snapshotText(current);
    const updated = entry.kind === 'toml'
      ? removeTomlBlock(text, entry.id)
      : removeManagedBlock(text, entry.id);
    if (updated === '' && (entry.containerCreated ?? entry.removeIfEmpty)) {
      working.set(entry.path, { exists: false, bytes: null });
    } else {
      working.set(entry.path, {
        exists: true,
        bytes: Buffer.from(updated),
      });
    }
  }
}

async function desiredLayout({
  profile,
  configuredHosts,
  codexVersion,
  desiredState,
  targets,
  snapshots,
}) {
  const selected = new Set(configuredHosts);
  const dedicated = [];
  if (selected.has('codex')) {
    dedicated.push({
      path: targets.codexAgent,
      bytes: Buffer.from(renderCodexAgent({
        usePreferredModel: shouldUsePreferredCodexModel(codexVersion),
      })),
    });
  }
  if (profile === 'full' && selected.has('claude')) {
    dedicated.push(
      {
        path: targets.claudeRouting,
        bytes: await template('routing/claude/fast-browser-routing.md'),
      },
      {
        path: targets.claudeConsent,
        bytes: await template(
          'routing/claude/fast-browser-verification-consent.md',
        ),
      },
    );
  }
  for (const entry of dedicated) {
    if (!Buffer.isBuffer(entry.bytes)) entry.bytes = Buffer.from(entry.bytes);
  }

  const blocks = [];
  if (profile === 'full' && selected.has('codex')) {
    const recorded = recordedMarkdownTarget(
      targets,
      profile,
      selected,
      desiredState,
    );
    blocks.push({
      path: recorded ?? (
        snapshots.get(targets.codexOverride).exists
          ? targets.codexOverride
          : targets.codexAgents
      ),
      id: MARKDOWN_ID,
      kind: 'markdown',
      body: await template('routing/codex/fast-browser.md'),
    });
  } else {
    recordedMarkdownTarget(targets, profile, selected, desiredState);
  }
  if (selected.has('codex')) {
    blocks.push({
      path: targets.codexConfig,
      id: POLICY_ID,
      kind: 'toml',
      body: profile === 'full' ? FULL_POLICY : SAFE_POLICY,
    });
  }
  return { dedicated, blocks };
}

async function prepareRoutingChanges({
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
  const configuredHosts = selectedHosts(hosts);
  const context = await prepareContext({
    paths,
    profile,
    configuredHosts,
    managedState,
    desiredState,
  });
  const layout = await desiredLayout({
    profile,
    configuredHosts,
    codexVersion,
    desiredState,
    ...context,
  });
  const managedFiles = new Map(
    (managedState?.files ?? []).map((entry) => [entry.path, entry]),
  );
  const managedBlocks = new Map(
    (managedState?.blocks ?? []).map((entry) => [blockKey(entry), entry]),
  );

  for (const entry of layout.dedicated) {
    if (
      !managedFiles.has(entry.path)
      && context.snapshots.get(entry.path).exists
    ) {
      throw new Error('routing file destination conflict');
    }
  }
  for (const entry of layout.blocks) {
    if (
      !managedBlocks.has(blockKey(entry))
      && blockAt(
        snapshotText(context.snapshots.get(entry.path)),
        entry.id,
        entry.kind,
      ) !== null
    ) {
      throw new Error('routing block destination conflict');
    }
  }

  const retainedFiles = new Set(layout.dedicated.map(({ path: pathname }) => (
    pathname
  )));
  const retainedBlocks = new Set(layout.blocks.map(blockKey));
  const working = cloneSnapshots(context.snapshots);
  removeOwnedRecords(
    working,
    context.ownership,
    retainedFiles,
    retainedBlocks,
  );
  for (const entry of layout.dedicated) {
    working.set(entry.path, {
      exists: true,
      bytes: Buffer.from(entry.bytes),
    });
  }
  for (const entry of layout.blocks) {
    const current = working.get(entry.path);
    const installed = entry.kind === 'toml'
      ? upsertTomlBlock(snapshotText(current), entry)
      : upsertManagedBlock(snapshotText(current), entry);
    working.set(entry.path, {
      exists: true,
      bytes: Buffer.from(installed),
    });
  }

  const computed = {
    profile,
    hosts: configuredHosts,
    files: layout.dedicated.map((entry) => (
      recordFile(entry.path, working.get(entry.path).bytes)
    )),
    blocks: layout.blocks.map((entry) => recordBlock(
      entry.path,
      entry.id,
      entry.kind,
      snapshotText(working.get(entry.path)),
      priorContainerOwnership(
        desiredState ?? managedState,
        entry.path,
        entry.id,
        entry.kind,
        context.snapshots.get(entry.path).exists,
      ),
    )),
  };
  const nextState = exactDesiredRoutingState(computed, desiredState);
  return {
    nextState,
    changes: changesFromSnapshots(context.snapshots, working),
  };
}

export async function prepareRoutingTransition(options) {
  const { nextState, changes } = await prepareRoutingChanges(options);
  const transaction = prepareFileTransaction({
    home: targetsFor(options.paths).home,
    changes,
    ...(options.transactionIo ? { io: options.transactionIo } : {}),
  });
  return Object.freeze({
    nextState,
    apply: transaction.apply,
  });
}

export async function installRouting(options) {
  const prepared = await prepareRoutingTransition(options);
  await prepared.apply();
  return prepared.nextState;
}

async function prepareRoutingRemoval({ paths, managedState, transactionIo }) {
  const context = await prepareContext({ paths, managedState });
  const working = cloneSnapshots(context.snapshots);
  removeOwnedRecords(working, context.ownership, new Set(), new Set());
  const transaction = prepareFileTransaction({
    home: context.targets.home,
    changes: changesFromSnapshots(context.snapshots, working),
    ...(transactionIo ? { io: transactionIo } : {}),
  });
  return { context, transaction };
}

export async function preflightRoutingRemoval({ paths, managedState }) {
  const { context } = await prepareRoutingRemoval({ paths, managedState });
  return {
    files: context.ownership.files.map(({ entry, exists }) => ({
      path: entry.path,
      exists,
    })),
    blocks: context.ownership.blocks.map(({ entry, installedBlock }) => ({
      path: entry.path,
      id: entry.id,
      kind: entry.kind,
      exists: installedBlock !== null,
    })),
  };
}

export async function removeRouting({ paths, managedState, transactionIo }) {
  const prepared = await prepareRoutingRemoval({
    paths,
    managedState,
    transactionIo,
  });
  await prepared.transaction.apply();
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
  const rewrittenBytes = Buffer.from(rewritten);
  const transaction = prepareFileTransaction({
    home: targets.home,
    changes: [{
      path: target,
      before: { exists: true, bytes: originalBytes },
      after: { exists: true, bytes: rewrittenBytes },
    }],
  });
  const reciprocal = await transaction.apply();
  const rewrittenHash = sha256(rewrittenBytes);
  const nextManagedState = {
    ...managedState,
    files: managedState.files.map((file) => (
      file.path === target ? { ...file, sha256: rewrittenHash } : file
    )),
  };
  return {
    managedState: nextManagedState,
    rollback: async () => {
      try {
        return await reciprocal.rollback();
      } catch {
        throw new Error('Codex agent ownership hash changed before rollback.');
      }
    },
  };
}

export async function rewriteOwnedCodexAgentWithoutPreferredModel(options) {
  const receipt = await beginOwnedCodexAgentFallback(options);
  return receipt.managedState;
}
