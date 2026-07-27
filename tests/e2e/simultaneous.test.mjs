import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { startOrderFixture } from '../fixtures/order-flow/server.mjs';
import { ensureIdentityDirectories, startIdentityClient } from './helpers/identity-client.mjs';

const execFile = promisify(execFileCallback);
const pluginRoot = fileURLToPath(new URL('../../', import.meta.url));
const live = process.env.FAST_BROWSER_LIVE_E2E === '1';
// The tab-group label check is independently gated behind this being
// explicitly set, never inferred or defaulted: Chrome refuses
// --remote-debugging-port on the default user-data-dir a real paired
// profile must use (proven live: identical flag on an isolated
// --user-data-dir answered CDP; the default profile stayed refused; an
// isolated profile cannot host the pairing). So this is permanently
// unreachable on any Chrome that actually has the extension paired, and the
// live test must never attempt it, nor fabricate its result, unless a human
// opts in by setting this themselves against a Chrome they configured for it.
const cdpUrl = process.env.FAST_BROWSER_LIVE_CDP_URL;

const CHROME_APP_NAME = 'Google Chrome';

// ---------------------------------------------------------------------------
// Pure piece 1: focus-sample reducer. Samples in, booleans out; the live test
// never logs, prints, or persists a raw sample (app name / tab title / URL),
// only these derived booleans.
// ---------------------------------------------------------------------------

// A real browser tab URL is always fully qualified ("http://host:port/path"),
// so its origin is exactly what new URL(...).origin reports. Returns null
// for anything unparsable rather than throwing, since a malformed sample
// must not crash the reducer.
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

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
  // fixtureOrigins itself may or may not carry a trailing slash; normalize
  // once so the comparison below is origin-vs-origin, never a raw string
  // comparison a browser's own URL normalization (added trailing slash,
  // added path/query) would silently defeat.
  const normalizedFixtureOrigins = fixtureOrigins.map((origin) => {
    const normalized = originOf(origin);
    if (normalized === null) {
      throw new TypeError(`fixtureOrigins must contain valid origins, got: ${origin}`);
    }
    return normalized;
  });
  const chromeWasFrontmostAtStart = samples.length > 0 && samples[0]?.app === CHROME_APP_NAME;
  const focusChangedToFixtureTab = samples.some((sample) => {
    if (typeof sample?.tabUrl !== 'string') return false;
    const sampleOrigin = originOf(sample.tabUrl);
    return sampleOrigin !== null && normalizedFixtureOrigins.includes(sampleOrigin);
  });
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

test('reduceFocusSamples detects a fixture-tab focus change when the sampled tab URL has a trailing slash the fixture origin lacks', () => {
  // A real browser normalizes "http://127.0.0.1:PORT" to
  // "http://127.0.0.1:PORT/" once it becomes the active tab. fixtureOrigins
  // never carries a trailing slash (see startOrderFixture's `origin` in
  // tests/fixtures/order-flow/server.mjs). A strict string comparison here
  // would silently never match, making this assertion pass vacuously
  // whether or not focus was actually stolen.
  const samples = [
    { app: 'Google Chrome', tabUrl: 'http://127.0.0.1:41111/' },
  ];
  const result = reduceFocusSamples(samples, { fixtureOrigins: ['http://127.0.0.1:41111'] });
  assert.equal(result.focusChangedToFixtureTab, true);
});

test('reduceFocusSamples detects a fixture-tab focus change when the sampled tab URL carries a path and query', () => {
  const samples = [
    { app: 'Google Chrome', tabUrl: 'http://127.0.0.1:41111/checkout?step=2' },
  ];
  const result = reduceFocusSamples(samples, { fixtureOrigins: ['http://127.0.0.1:41111'] });
  assert.equal(result.focusChangedToFixtureTab, true);
});

test('reduceFocusSamples does not match a tab URL on a different port even after origin normalization', () => {
  const samples = [
    { app: 'Google Chrome', tabUrl: 'http://127.0.0.1:41111/' },
  ];
  const result = reduceFocusSamples(samples, { fixtureOrigins: ['http://127.0.0.1:22222'] });
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
  'groupLabelsVerified',
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

function requireNull(value, label) {
  if (value !== null) {
    throw new TypeError(`${label} must be null`);
  }
}

// Only this exact key set may ever reach the evidence file: raw samples, tab
// titles, URLs beyond the two allowed order IDs, tokens, or absolute home
// paths all throw here instead of silently passing through.
//
// The tab-group label check is independently gated (it only runs when
// FAST_BROWSER_LIVE_CDP_URL is explicitly set; see the live test below and
// task-3-simultaneous-report.md for why: Chrome refuses
// --remote-debugging-port on the default user-data-dir a real pairing must
// use). groupLabelsVerified records whether that check ran at all.
// groupLabelsDistinct and every client label must be null when it did not
// (never a fabricated boolean/string standing in for an unmade observation),
// and must be a real boolean / non-empty string when it did.
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
  requireBoolean(evidence.groupLabelsVerified, 'evidence.groupLabelsVerified');
  if (evidence.groupLabelsVerified) {
    requireBoolean(evidence.groupLabelsDistinct, 'evidence.groupLabelsDistinct');
  } else {
    requireNull(evidence.groupLabelsDistinct, 'evidence.groupLabelsDistinct (must be null when groupLabelsVerified is false)');
  }
  for (const client of evidence.clients) {
    assertOnlyKeys(client, CLIENT_KEYS, 'evidence client');
    if (evidence.groupLabelsVerified) {
      requireNonEmptyString(client.label, 'evidence client label');
    } else {
      requireNull(client.label, 'evidence client label (must be null when groupLabelsVerified is false)');
    }
    requireNonEmptyString(client.orderId, 'evidence client orderId');
    requireNonNegativeNumber(client.browserCalls, 'evidence client browserCalls');
    requireNonNegativeNumber(client.elapsedMs, 'evidence client elapsedMs');
  }
  requireBoolean(evidence.chromeWasFrontmostAtStart, 'evidence.chromeWasFrontmostAtStart');
  requireBoolean(evidence.focusChangedToFixtureTab, 'evidence.focusChangedToFixtureTab');
  requireBoolean(evidence.killClaudeLeftCodexFunctional, 'evidence.killClaudeLeftCodexFunctional');
  requireBoolean(evidence.reconnectLeftBothFunctional, 'evidence.reconnectLeftBothFunctional');
  return `${JSON.stringify(evidence, null, 2)}\n`;
}

// groupLabelsVerified: true variant. The tab-group label check ran (i.e.
// FAST_BROWSER_LIVE_CDP_URL was set) and both labels were actually observed.
function validVerifiedEvidence() {
  return {
    schemaVersion: 1,
    completedAt: '2026-07-25T00:00:00.000Z',
    clients: [
      { label: 'Claude #1', orderId: 'CLAUDE-TEAM-5', browserCalls: 2, elapsedMs: 1200 },
      { label: 'Codex #2', orderId: 'CODEX-SCALE-12', browserCalls: 2, elapsedMs: 1400 },
    ],
    groupLabelsVerified: true,
    groupLabelsDistinct: true,
    chromeWasFrontmostAtStart: false,
    focusChangedToFixtureTab: false,
    killClaudeLeftCodexFunctional: true,
    reconnectLeftBothFunctional: true,
  };
}

// groupLabelsVerified: false variant. The tab-group label check was skipped
// (FAST_BROWSER_LIVE_CDP_URL was not set: a permanently unreachable path on
// any Chrome profile hosting the real pairing, per the proven environment
// fact that Chrome refuses --remote-debugging-port on its default
// user-data-dir). Nothing about the label was observed, so groupLabelsDistinct
// and every client label are explicit null, never a fabricated value.
function validUnverifiedEvidence() {
  return {
    ...validVerifiedEvidence(),
    clients: [
      { label: null, orderId: 'CLAUDE-TEAM-5', browserCalls: 2, elapsedMs: 1200 },
      { label: null, orderId: 'CODEX-SCALE-12', browserCalls: 2, elapsedMs: 1400 },
    ],
    groupLabelsVerified: false,
    groupLabelsDistinct: null,
  };
}

test('serializeLiveEvidence accepts a fully-populated verified evidence object with exactly the allowed keys', () => {
  const serialized = serializeLiveEvidence(validVerifiedEvidence());
  assert.deepEqual(JSON.parse(serialized), validVerifiedEvidence());
});

test('serializeLiveEvidence accepts the unverified group-label shape (label check was skipped)', () => {
  const serialized = serializeLiveEvidence(validUnverifiedEvidence());
  assert.deepEqual(JSON.parse(serialized), validUnverifiedEvidence());
});

test('serializeLiveEvidence rejects groupLabelsDistinct true when groupLabelsVerified is false', () => {
  // The exact fabricated-looking shape this schema exists to reject: a
  // claimed distinctness result for a check that never ran.
  const evidence = { ...validUnverifiedEvidence(), groupLabelsDistinct: true };
  assert.throws(() => serializeLiveEvidence(evidence), TypeError);
});

test('serializeLiveEvidence rejects a non-null client label when groupLabelsVerified is false', () => {
  const evidence = validUnverifiedEvidence();
  evidence.clients[0] = { ...evidence.clients[0], label: 'Claude #1' };
  assert.throws(() => serializeLiveEvidence(evidence), TypeError);
});

test('serializeLiveEvidence rejects a null groupLabelsDistinct when groupLabelsVerified is true', () => {
  const evidence = { ...validVerifiedEvidence(), groupLabelsDistinct: null };
  assert.throws(() => serializeLiveEvidence(evidence), TypeError);
});

test('serializeLiveEvidence rejects a null client label when groupLabelsVerified is true', () => {
  const evidence = validVerifiedEvidence();
  evidence.clients[0] = { ...evidence.clients[0], label: null };
  assert.throws(() => serializeLiveEvidence(evidence), TypeError);
});

test('serializeLiveEvidence rejects a missing groupLabelsVerified flag', () => {
  const evidence = validVerifiedEvidence();
  delete evidence.groupLabelsVerified;
  assert.throws(() => serializeLiveEvidence(evidence), TypeError);
});

test('serializeLiveEvidence rejects an unexpected top-level key', () => {
  const evidence = { ...validVerifiedEvidence(), rawSampleLog: ['Google Chrome'] };
  assert.throws(() => serializeLiveEvidence(evidence), /forbidden key/);
});

test('serializeLiveEvidence rejects an unexpected client key', () => {
  const evidence = validVerifiedEvidence();
  evidence.clients[0] = { ...evidence.clients[0], pageTitle: 'Order complete' };
  assert.throws(() => serializeLiveEvidence(evidence), /forbidden key/);
});

test('serializeLiveEvidence rejects fewer or more than two client entries', () => {
  const oneClient = { ...validVerifiedEvidence(), clients: [validVerifiedEvidence().clients[0]] };
  assert.throws(() => serializeLiveEvidence(oneClient), /exactly two/);
  const threeClients = {
    ...validVerifiedEvidence(),
    clients: [...validVerifiedEvidence().clients, validVerifiedEvidence().clients[0]],
  };
  assert.throws(() => serializeLiveEvidence(threeClients), /exactly two/);
});

test('serializeLiveEvidence rejects a non-boolean flag', () => {
  const evidence = { ...validVerifiedEvidence(), groupLabelsDistinct: 'true' };
  assert.throws(() => serializeLiveEvidence(evidence), TypeError);
});

test('serializeLiveEvidence rejects a malformed completedAt timestamp', () => {
  const evidence = { ...validVerifiedEvidence(), completedAt: 'not-a-timestamp' };
  assert.throws(() => serializeLiveEvidence(evidence), TypeError);
});

// ---------------------------------------------------------------------------
// Regression coverage for the exact defect a real live run surfaced:
// startIdentityClient (tests/e2e/helpers/identity-client.mjs) passed
// outputDir straight to mcp-client.mjs's runtimeCliFor, which writes a real
// file into it, without ever creating that directory first. This exercises
// the small extracted helper (ensureIdentityDirectories) directly, so it is
// a real regression test without connecting to anything live or gated.
// ---------------------------------------------------------------------------

test('ensureIdentityDirectories creates a missing outputDir and workspaceDir', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-identity-dirs-'));
  try {
    // Nested paths that do not exist yet, matching the live test's own
    // path.join(outputRoot, 'claude-output')-style construction: mkdtemp
    // only creates `root` itself, never these children.
    const outputDir = path.join(root, 'nested', 'claude-output');
    const workspaceDir = path.join(root, 'nested', 'Claude');
    await ensureIdentityDirectories({ outputDir, workspaceDir });
    const [outputStat, workspaceStat] = await Promise.all([stat(outputDir), stat(workspaceDir)]);
    assert.equal(outputStat.isDirectory(), true);
    assert.equal(workspaceStat.isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ensureIdentityDirectories tolerates directories that already exist', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-identity-dirs-'));
  try {
    const outputDir = path.join(root, 'claude-output');
    const workspaceDir = path.join(root, 'Claude');
    await Promise.all([mkdir(outputDir), mkdir(workspaceDir)]);
    await assert.doesNotReject(() => ensureIdentityDirectories({ outputDir, workspaceDir }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
  // node:test runs t.after() hooks in REGISTRATION order, not LIFO
  // (verified empirically: three t.after() calls print in the order they
  // were added). That makes registration order a real dependency ordering,
  // not cosmetic: outputRoot must not be rm'd until every client whose
  // runtime process uses paths under it (--output-dir, cwd) has been
  // closed, and those clients must not be closed until the fixtures they
  // were talking to no longer matter. So directory removal is registered
  // LAST, below, after every client-close hook, even though outputRoot
  // itself is created first.
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

  // Created explicitly here (belt and suspenders on top of
  // startIdentityClient's own defensive ensureIdentityDirectories call):
  // a real live run surfaced that these were never created before this
  // fix, which made runtimeCliFor's writeFile fail with ENOENT, mapped to
  // the generic "could not be extracted" error.
  const claudeOutputDir = path.join(outputRoot, 'claude-output');
  const codexOutputDir = path.join(outputRoot, 'codex-output');
  await Promise.all([
    mkdir(claudeOutputDir, { recursive: true }),
    mkdir(codexOutputDir, { recursive: true }),
  ]);

  // Cleanup is registered right after each client connects (not batched
  // afterward): if clientB's connection attempt below throws, clientA must
  // still be torn down rather than leaking its child process. These two
  // hooks are registered before the fixture-close and outputRoot-rm hooks
  // below, so (per the registration-order note above) clients are always
  // closed first at cleanup time.
  let clientA = await startIdentityClient({
    identity: 'claude',
    outputDir: claudeOutputDir,
    workspaceDir: workspaceA,
  });
  t.after(() => clientA?.close().catch(() => {}));
  const clientB = await startIdentityClient({
    identity: 'codex',
    outputDir: codexOutputDir,
    workspaceDir: workspaceB,
  });
  t.after(() => clientB.close().catch(() => {}));
  t.after(() => Promise.all([fixtureA.close(), fixtureB.close()]));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));

  const samples = [];
  // Minor fix: an all-failed (or never-attempted) sampling run must not
  // silently masquerade as "focus was never stolen" via an empty samples
  // array. Count attempts and failures so that case is asserted against
  // below instead.
  let sampleAttempts = 0;
  let sampleFailures = 0;
  const sampling = setInterval(() => {
    sampleAttempts += 1;
    sampleFocusOnce().then(
      (sample) => samples.push(sample),
      () => { sampleFailures += 1; },
    );
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

  assert.ok(
    samples.length > 0,
    `expected at least one successful focus sample but got none `
    + `(${sampleAttempts} attempt(s), ${sampleFailures} failure(s)); an empty `
    + 'sample set must never be treated as "focus never changed"',
  );
  const focus = reduceFocusSamples(samples, { fixtureOrigins: [fixtureA.origin, fixtureB.origin] });
  assert.equal(focus.focusChangedToFixtureTab, false);

  // Independently gated: only attempt the CDP-based label query when
  // FAST_BROWSER_LIVE_CDP_URL was explicitly set. It is not part of the
  // FAST_BROWSER_LIVE_E2E-gated run by default because it is permanently
  // unreachable against a Chrome that actually hosts the real pairing (see
  // the cdpUrl comment above and task-3-simultaneous-report.md). When
  // skipped: no CDP connection is attempted, no distinctness assertion
  // runs, and the evidence below records this honestly rather than
  // fabricating a result.
  let labelA = null;
  let labelB = null;
  let groupLabelsVerified = false;
  let groupLabelsDistinct = null;
  if (cdpUrl) {
    const [labelsA, labelsB] = await Promise.all([
      clientA.queryGroupLabels(),
      clientB.queryGroupLabels(),
    ]);
    labelA = labelsA.find((title) => title.startsWith('Claude '));
    labelB = labelsB.find((title) => title.startsWith('Codex '));
    assert.ok(labelA, 'expected a Claude-prefixed tab-group label');
    assert.ok(labelB, 'expected a Codex-prefixed tab-group label');
    assertDistinctGroupLabels(labelA, labelB);
    // Derived directly from the two observed label strings (not a bare
    // literal): assertDistinctGroupLabels above would already have thrown
    // if this were false, but the evidence value itself must come from the
    // actual comparison, never a hardcoded "true" alongside it.
    groupLabelsDistinct = labelA !== labelB;
    groupLabelsVerified = true;
  }

  // kill() resolves only after the child has actually exited (see
  // identity-client.mjs), so this ordering cannot race the OS: clientB is
  // only checked once clientA's process is confirmed gone.
  await clientA.kill();
  const postKill = await clientB.callTool('browser_navigate', { url: fixtureB.origin });
  const killClaudeLeftCodexFunctional = Boolean(postKill);
  assert.equal(killClaudeLeftCodexFunctional, true);

  // A third output directory, distinct from claudeOutputDir above (a fresh
  // client needs its own runtime working directory). Found during the
  // line-by-line audit: this one had the exact same missing-mkdir defect
  // as the original two, just not named in the report that first surfaced
  // the bug.
  const claudeReconnectOutputDir = path.join(outputRoot, 'claude-output-reconnect');
  await mkdir(claudeReconnectOutputDir, { recursive: true });
  const freshClientA = await startIdentityClient({
    identity: 'claude',
    outputDir: claudeReconnectOutputDir,
    workspaceDir: workspaceA,
  });
  const postReconnectA = await freshClientA.callTool('browser_navigate', { url: fixtureA.origin });
  // "Both functional" must be observed for BOTH clients, not assumed for B
  // because it was already checked once earlier. Re-check clientB now, after
  // the reconnect, so the claim reflects an actual observation of both.
  const postReconnectB = await clientB.callTool('browser_navigate', { url: fixtureB.origin });
  const reconnectLeftBothFunctional = Boolean(postReconnectA) && Boolean(postReconnectB);
  assert.equal(reconnectLeftBothFunctional, true);
  clientA = freshClientA;

  const evidence = serializeLiveEvidence({
    schemaVersion: 1,
    completedAt: new Date().toISOString(),
    clients: [
      { label: labelA, orderId: resultA.orderId, browserCalls: resultA.browserCalls, elapsedMs: resultA.elapsedMs },
      { label: labelB, orderId: resultB.orderId, browserCalls: resultB.browserCalls, elapsedMs: resultB.elapsedMs },
    ],
    groupLabelsVerified,
    groupLabelsDistinct,
    chromeWasFrontmostAtStart: focus.chromeWasFrontmostAtStart,
    focusChangedToFixtureTab: focus.focusChangedToFixtureTab,
    killClaudeLeftCodexFunctional,
    reconnectLeftBothFunctional,
  });
  const evidenceDir = path.join(pluginRoot, '.local-dev', 'fast-browser');
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, 'live-e2e-results.json'), evidence);
});
