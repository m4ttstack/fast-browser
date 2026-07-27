import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { startOrderFixture } from '../fixtures/order-flow/server.mjs';
import { startIdentityClient } from './helpers/identity-client.mjs';

const execFile = promisify(execFileCallback);
const pluginRoot = fileURLToPath(new URL('../../', import.meta.url));
const live = process.env.FAST_BROWSER_LIVE_E2E === '1';

const CHROME_APP_NAME = 'Google Chrome';

// ---------------------------------------------------------------------------
// Pure piece 1: focus-sample reducer. Samples in, booleans out; the live test
// never logs, prints, or persists a raw sample (app name / tab title / URL),
// only these derived booleans.
// ---------------------------------------------------------------------------

// `samples` is an in-memory array of { app, tabUrl } snapshots taken during
// the live run (tabUrl is only ever populated when app === CHROME_APP_NAME).
// This function is the ONLY place that looks at raw sample contents; its
// return value is all the live test keeps.
export function reduceFocusSamples(samples, { fixtureOrigins } = {}) {
  if (!Array.isArray(samples)) {
    throw new TypeError('samples must be an array');
  }
  if (!Array.isArray(fixtureOrigins) || fixtureOrigins.length === 0) {
    throw new TypeError('fixtureOrigins must be a non-empty array of origins');
  }
  const chromeWasFrontmostAtStart = samples.length > 0 && samples[0]?.app === CHROME_APP_NAME;
  const focusChangedToFixtureTab = samples.some((sample) => (
    typeof sample?.tabUrl === 'string' && fixtureOrigins.includes(sample.tabUrl)
  ));
  // Only meaningful when Chrome did not start frontmost (brief's design
  // section); it is a diagnostic signal, not part of the persisted evidence
  // schema, so it stays undefined rather than false when it does not apply.
  const frontmostBecameChrome = chromeWasFrontmostAtStart
    ? undefined
    : samples.some((sample) => sample?.app === CHROME_APP_NAME);
  return { chromeWasFrontmostAtStart, frontmostBecameChrome, focusChangedToFixtureTab };
}

test('reduceFocusSamples reports chromeWasFrontmostAtStart true when the first sample is Chrome', () => {
  const samples = [
    { app: 'Google Chrome', tabUrl: 'http://127.0.0.1:1/unrelated' },
    { app: 'Google Chrome', tabUrl: 'http://127.0.0.1:1/unrelated' },
  ];
  const result = reduceFocusSamples(samples, { fixtureOrigins: ['http://127.0.0.1:2'] });
  assert.equal(result.chromeWasFrontmostAtStart, true);
  assert.equal(result.frontmostBecameChrome, undefined);
});

test('reduceFocusSamples tracks frontmostBecameChrome when Chrome was not frontmost at start but becomes so', () => {
  const samples = [
    { app: 'Terminal', tabUrl: null },
    { app: 'Terminal', tabUrl: null },
    { app: 'Google Chrome', tabUrl: 'http://127.0.0.1:1/' },
  ];
  const result = reduceFocusSamples(samples, { fixtureOrigins: ['http://127.0.0.1:1'] });
  assert.equal(result.chromeWasFrontmostAtStart, false);
  assert.equal(result.frontmostBecameChrome, true);
});

test('reduceFocusSamples reports frontmostBecameChrome false when Chrome never becomes frontmost', () => {
  const samples = [
    { app: 'Terminal', tabUrl: null },
    { app: 'Finder', tabUrl: null },
  ];
  const result = reduceFocusSamples(samples, { fixtureOrigins: ['http://127.0.0.1:1'] });
  assert.equal(result.chromeWasFrontmostAtStart, false);
  assert.equal(result.frontmostBecameChrome, false);
});

test('reduceFocusSamples reports focusChangedToFixtureTab true when a sampled tab URL matches either fixture origin', () => {
  const samples = [
    { app: 'Google Chrome', tabUrl: 'http://127.0.0.1:11111' },
    { app: 'Google Chrome', tabUrl: 'http://127.0.0.1:22222' },
  ];
  const result = reduceFocusSamples(samples, {
    fixtureOrigins: ['http://127.0.0.1:11111', 'http://127.0.0.1:22222'],
  });
  assert.equal(result.focusChangedToFixtureTab, true);
});

test('reduceFocusSamples reports focusChangedToFixtureTab false when no sampled tab URL matches a fixture origin', () => {
  const samples = [
    { app: 'Google Chrome', tabUrl: 'http://127.0.0.1:99999' },
    { app: 'Slack', tabUrl: null },
  ];
  const result = reduceFocusSamples(samples, {
    fixtureOrigins: ['http://127.0.0.1:11111', 'http://127.0.0.1:22222'],
  });
  assert.equal(result.focusChangedToFixtureTab, false);
});

test('reduceFocusSamples returns all-false booleans for an empty sample list', () => {
  const result = reduceFocusSamples([], { fixtureOrigins: ['http://127.0.0.1:11111'] });
  assert.equal(result.chromeWasFrontmostAtStart, false);
  assert.equal(result.frontmostBecameChrome, false);
  assert.equal(result.focusChangedToFixtureTab, false);
});

test('reduceFocusSamples rejects a non-array samples argument', () => {
  assert.throws(
    () => reduceFocusSamples('not-an-array', { fixtureOrigins: ['http://127.0.0.1:11111'] }),
    TypeError,
  );
});

test('reduceFocusSamples rejects a missing or empty fixtureOrigins list', () => {
  assert.throws(() => reduceFocusSamples([], {}), TypeError);
  assert.throws(() => reduceFocusSamples([], { fixtureOrigins: [] }), TypeError);
});

// ---------------------------------------------------------------------------
// Pure piece 2: the production tab-group label formula (mirrors
// packages/extension/src/background.ts _connectTab in the fast-browser
// runtime reference worktree) and a distinctness assertion helper.
// ---------------------------------------------------------------------------

const WORKSPACE_LABEL_MAX_LENGTH = 24;

// Mirrors: let workspace = clientCwd?.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
//          if (workspace && workspace.length > 24) workspace = workspace.slice(0, 23) + '…';
function workspaceBasename(workspace) {
  if (typeof workspace !== 'string' || workspace.length === 0) return undefined;
  const trimmed = workspace.replace(/[\\/]+$/, '');
  const base = trimmed.split(/[\\/]/).pop();
  if (!base) return undefined;
  return base.length > WORKSPACE_LABEL_MAX_LENGTH
    ? `${base.slice(0, WORKSPACE_LABEL_MAX_LENGTH - 1)}…`
    : base;
}

// Mirrors: const label = `${workspace || (clientName === 'unknown' ? undefined : clientName)
//            || 'Fast Browser'} #${id}`;
export function computeProductionGroupLabel({ workspace, clientName, connectionId }) {
  if (!Number.isInteger(connectionId) || connectionId < 1) {
    throw new TypeError('connectionId must be a positive integer');
  }
  const base = workspaceBasename(workspace)
    || (clientName === 'unknown' ? undefined : clientName)
    || 'Fast Browser';
  return `${base} #${connectionId}`;
}

export function assertDistinctGroupLabels(labelA, labelB) {
  if (typeof labelA !== 'string' || typeof labelB !== 'string' || !labelA || !labelB) {
    throw new TypeError('group labels must be non-empty strings');
  }
  if (labelA === labelB) {
    throw new Error('expected each client to receive a distinct tab-group label');
  }
}

test('computeProductionGroupLabel uses the workspace folder basename over the client name', () => {
  assert.equal(
    computeProductionGroupLabel({ workspace: '/tmp/pw-bench/Claude', clientName: 'claude-code', connectionId: 1 }),
    'Claude #1',
  );
});

test('computeProductionGroupLabel falls back to the client name when no workspace is given', () => {
  assert.equal(
    computeProductionGroupLabel({ workspace: undefined, clientName: 'codex', connectionId: 2 }),
    'codex #2',
  );
});

test('computeProductionGroupLabel falls back to "Fast Browser" when the client name is "unknown" and there is no workspace', () => {
  assert.equal(
    computeProductionGroupLabel({ workspace: undefined, clientName: 'unknown', connectionId: 1 }),
    'Fast Browser #1',
  );
});

test('computeProductionGroupLabel truncates a workspace basename longer than 24 characters with an ellipsis', () => {
  const longName = 'a-very-long-workspace-folder-name';
  assert.equal(longName.length > 24, true);
  const label = computeProductionGroupLabel({ workspace: `/tmp/${longName}`, clientName: 'claude-code', connectionId: 3 });
  // Matches background.ts's `workspace.slice(0, 23) + '…'` exactly: 23 kept
  // characters, then the ellipsis.
  assert.equal(label, 'a-very-long-workspace-f… #3');
});

test('computeProductionGroupLabel strips trailing slashes before taking the basename', () => {
  assert.equal(
    computeProductionGroupLabel({ workspace: '/tmp/pw-bench/Codex/', clientName: 'codex', connectionId: 5 }),
    'Codex #5',
  );
});

test('computeProductionGroupLabel rejects a non-positive connectionId', () => {
  assert.throws(
    () => computeProductionGroupLabel({ workspace: '/tmp/x', clientName: 'x', connectionId: 0 }),
    TypeError,
  );
});

test('assertDistinctGroupLabels passes for two different labels', () => {
  assert.doesNotThrow(() => assertDistinctGroupLabels('Claude #1', 'Codex #2'));
});

test('assertDistinctGroupLabels throws when both labels are identical', () => {
  assert.throws(() => assertDistinctGroupLabels('Claude #1', 'Claude #1'), (error) => {
    assert.notEqual(error.constructor, ReferenceError);
    assert.match(error.message, /distinct/i);
    return true;
  });
});

// ---------------------------------------------------------------------------
// Pure piece 3: the evidence serializer. This is the redaction guard: only
// the exact allowed key set may ever reach the persisted evidence file.
// ---------------------------------------------------------------------------

const EVIDENCE_KEYS = new Set([
  'schemaVersion',
  'completedAt',
  'clients',
  'groupLabelsDistinct',
  'chromeWasFrontmostAtStart',
  'focusChangedToFixtureTab',
  'killClaudeLeftCodexFunctional',
  'reconnectLeftBothFunctional',
]);
const CLIENT_KEYS = new Set(['label', 'orderId', 'browserCalls', 'elapsedMs']);

function assertOnlyKeys(value, allowed, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} has a forbidden key: ${key}`);
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function requireNonNegativeNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative number`);
  }
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${label} must be a boolean`);
  }
}

// Only this exact key set may ever reach the evidence file: raw samples, tab
// titles, URLs beyond the two allowed order IDs, tokens, or absolute home
// paths all throw here instead of silently passing through.
export function serializeLiveEvidence(evidence) {
  assertOnlyKeys(evidence, EVIDENCE_KEYS, 'evidence');
  if (evidence.schemaVersion !== 1) {
    throw new Error('evidence.schemaVersion must be 1');
  }
  if (typeof evidence.completedAt !== 'string' || Number.isNaN(Date.parse(evidence.completedAt))) {
    throw new TypeError('evidence.completedAt must be an ISO timestamp string');
  }
  if (!Array.isArray(evidence.clients) || evidence.clients.length !== 2) {
    throw new Error('evidence.clients must contain exactly two entries');
  }
  for (const client of evidence.clients) {
    assertOnlyKeys(client, CLIENT_KEYS, 'evidence client');
    requireNonEmptyString(client.label, 'evidence client label');
    requireNonEmptyString(client.orderId, 'evidence client orderId');
    requireNonNegativeNumber(client.browserCalls, 'evidence client browserCalls');
    requireNonNegativeNumber(client.elapsedMs, 'evidence client elapsedMs');
  }
  requireBoolean(evidence.groupLabelsDistinct, 'evidence.groupLabelsDistinct');
  requireBoolean(evidence.chromeWasFrontmostAtStart, 'evidence.chromeWasFrontmostAtStart');
  requireBoolean(evidence.focusChangedToFixtureTab, 'evidence.focusChangedToFixtureTab');
  requireBoolean(evidence.killClaudeLeftCodexFunctional, 'evidence.killClaudeLeftCodexFunctional');
  requireBoolean(evidence.reconnectLeftBothFunctional, 'evidence.reconnectLeftBothFunctional');
  return `${JSON.stringify(evidence, null, 2)}\n`;
}

function validEvidence() {
  return {
    schemaVersion: 1,
    completedAt: '2026-07-25T00:00:00.000Z',
    clients: [
      { label: 'Claude #1', orderId: 'CLAUDE-TEAM-5', browserCalls: 2, elapsedMs: 1200 },
      { label: 'Codex #2', orderId: 'CODEX-SCALE-12', browserCalls: 2, elapsedMs: 1400 },
    ],
    groupLabelsDistinct: true,
    chromeWasFrontmostAtStart: false,
    focusChangedToFixtureTab: false,
    killClaudeLeftCodexFunctional: true,
    reconnectLeftBothFunctional: true,
  };
}

test('serializeLiveEvidence accepts a fully-populated evidence object with exactly the allowed keys', () => {
  const serialized = serializeLiveEvidence(validEvidence());
  assert.deepEqual(JSON.parse(serialized), validEvidence());
});

test('serializeLiveEvidence rejects an unexpected top-level key', () => {
  const evidence = { ...validEvidence(), rawSampleLog: ['Google Chrome'] };
  assert.throws(() => serializeLiveEvidence(evidence), /forbidden key/);
});

test('serializeLiveEvidence rejects an unexpected client key', () => {
  const evidence = validEvidence();
  evidence.clients[0] = { ...evidence.clients[0], pageTitle: 'Order complete' };
  assert.throws(() => serializeLiveEvidence(evidence), /forbidden key/);
});

test('serializeLiveEvidence rejects fewer or more than two client entries', () => {
  const oneClient = { ...validEvidence(), clients: [validEvidence().clients[0]] };
  assert.throws(() => serializeLiveEvidence(oneClient), /exactly two/);
  const threeClients = { ...validEvidence(), clients: [...validEvidence().clients, validEvidence().clients[0]] };
  assert.throws(() => serializeLiveEvidence(threeClients), /exactly two/);
});

test('serializeLiveEvidence rejects a non-boolean flag', () => {
  const evidence = { ...validEvidence(), groupLabelsDistinct: 'true' };
  assert.throws(() => serializeLiveEvidence(evidence), TypeError);
});

test('serializeLiveEvidence rejects a malformed completedAt timestamp', () => {
  const evidence = { ...validEvidence(), completedAt: 'not-a-timestamp' };
  assert.throws(() => serializeLiveEvidence(evidence), TypeError);
});

// ---------------------------------------------------------------------------
// Live-only helpers below. Used exclusively by the FAST_BROWSER_LIVE_E2E
// gated test at the bottom of this file, which this task's brief forbids
// executing. Never called by any test above this line.
// ---------------------------------------------------------------------------

// One AppleScript call per sample: frontmost application name, plus (only
// when Chrome is frontmost) the active tab URL. Returns the raw values to
// the caller; nothing here writes, logs, or persists them (that would
// violate the binding redaction rule). Only reduceFocusSamples' derived
// booleans are ever kept.
async function sampleFocusOnce() {
  const script = `
    tell application "System Events"
      set frontApp to name of first application process whose frontmost is true
    end tell
    set tabURL to ""
    if frontApp is "${CHROME_APP_NAME}" then
      tell application "${CHROME_APP_NAME}" to set tabURL to URL of active tab of front window
    end if
    return frontApp & "|||" & tabURL
  `;
  const { stdout } = await execFile('osascript', ['-e', script]);
  const [app, tabUrl] = stdout.trim().split('|||');
  return { app, tabUrl: tabUrl || null };
}

// Drives one full order flow with exactly two Fast Browser tool calls
// (navigate, then one browser_run_code_unsafe), matching the brief's
// "navigate + ONE browser_run_code_unsafe" requirement.
async function runOrderFlow(client, origin, { customer, plan, seats }) {
  const startedAt = performance.now();
  await client.callTool('browser_navigate', { url: origin });
  const result = await client.callTool('browser_run_code_unsafe', {
    code: `async (page, args) => {
      await page.getByRole('button', { name: 'Start order' }).click();
      await page.getByRole('textbox', { name: 'Customer name' }).fill(args.customer);
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.getByRole('combobox', { name: 'Plan' }).selectOption(args.plan);
      await page.getByRole('spinbutton', { name: 'Seats' }).fill(String(args.seats));
      await page.getByRole('button', { name: 'Review order' }).click();
      await page.getByRole('button', { name: 'Place order' }).click();
      await page.getByRole('heading', { name: 'Order complete' }).waitFor();
      return { orderId: await page.getByTestId('order-id').innerText() };
    }`,
    args: { customer, plan, seats },
  });
  return {
    orderId: result.orderId,
    browserCalls: 2,
    elapsedMs: Math.round(performance.now() - startedAt),
  };
}

// NEVER set FAST_BROWSER_LIVE_E2E while working this task; this test must
// never execute (see task-3-simultaneous-brief.md constraints).
test('two identity-carrying Fast Browser clients drive the paired real Chrome simultaneously', {
  skip: !live,
  timeout: 300_000,
}, async (t) => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-simultaneous-'));
  const workspaceRoot = path.join(outputRoot, 'workspaces');
  await mkdir(workspaceRoot, { recursive: true });
  // These workspace directory basenames are what background.ts turns into
  // the Chrome tab-group title. They stand in for a real Claude Code /
  // Codex session's project directory name (see task-3-simultaneous-report.md
  // for why the workspace root, not clientInfo.name, is the mechanism this
  // test actually exercises).
  const workspaceA = path.join(workspaceRoot, 'Claude');
  const workspaceB = path.join(workspaceRoot, 'Codex');
  await Promise.all([mkdir(workspaceA), mkdir(workspaceB)]);

  const fixtureA = await startOrderFixture();
  const fixtureB = await startOrderFixture();
  t.after(() => Promise.all([fixtureA.close(), fixtureB.close()]));

  let clientA = await startIdentityClient({
    identity: 'claude',
    outputDir: path.join(outputRoot, 'claude-output'),
    workspaceDir: workspaceA,
  });
  const clientB = await startIdentityClient({
    identity: 'codex',
    outputDir: path.join(outputRoot, 'codex-output'),
    workspaceDir: workspaceB,
  });
  t.after(() => Promise.all([clientA?.close(), clientB.close()].map((p) => p?.catch(() => {}))));

  const samples = [];
  const sampling = setInterval(() => {
    sampleFocusOnce().then((sample) => samples.push(sample), () => {});
  }, 1_000);

  let resultA;
  let resultB;
  try {
    [resultA, resultB] = await Promise.all([
      runOrderFlow(clientA, fixtureA.origin, { customer: 'CLAUDE', plan: 'team', seats: 5 }),
      runOrderFlow(clientB, fixtureB.origin, { customer: 'CODEX', plan: 'scale', seats: 12 }),
    ]);
  } finally {
    clearInterval(sampling);
  }

  assert.equal(resultA.orderId, 'CLAUDE-TEAM-5');
  assert.equal(resultB.orderId, 'CODEX-SCALE-12');

  const focus = reduceFocusSamples(samples, { fixtureOrigins: [fixtureA.origin, fixtureB.origin] });
  assert.equal(focus.focusChangedToFixtureTab, false);

  const [labelsA, labelsB] = await Promise.all([
    clientA.queryGroupLabels(),
    clientB.queryGroupLabels(),
  ]);
  const labelA = labelsA.find((title) => title.startsWith('Claude '));
  const labelB = labelsB.find((title) => title.startsWith('Codex '));
  assert.ok(labelA, 'expected a Claude-prefixed tab-group label');
  assert.ok(labelB, 'expected a Codex-prefixed tab-group label');
  assertDistinctGroupLabels(labelA, labelB);

  clientA.kill();
  const postKill = await clientB.callTool('browser_navigate', { url: fixtureB.origin });
  assert.ok(postKill);
  const killClaudeLeftCodexFunctional = true;

  const freshClientA = await startIdentityClient({
    identity: 'claude',
    outputDir: path.join(outputRoot, 'claude-output-reconnect'),
    workspaceDir: workspaceA,
  });
  const postReconnect = await freshClientA.callTool('browser_navigate', { url: fixtureA.origin });
  assert.ok(postReconnect);
  const reconnectLeftBothFunctional = true;
  clientA = freshClientA;

  const evidence = serializeLiveEvidence({
    schemaVersion: 1,
    completedAt: new Date().toISOString(),
    clients: [
      { label: labelA, orderId: resultA.orderId, browserCalls: resultA.browserCalls, elapsedMs: resultA.elapsedMs },
      { label: labelB, orderId: resultB.orderId, browserCalls: resultB.browserCalls, elapsedMs: resultB.elapsedMs },
    ],
    groupLabelsDistinct: true,
    chromeWasFrontmostAtStart: focus.chromeWasFrontmostAtStart,
    focusChangedToFixtureTab: focus.focusChangedToFixtureTab,
    killClaudeLeftCodexFunctional,
    reconnectLeftBothFunctional,
  });
  const evidenceDir = path.join(pluginRoot, '.local-dev', 'fast-browser');
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, 'live-e2e-results.json'), evidence);
});
