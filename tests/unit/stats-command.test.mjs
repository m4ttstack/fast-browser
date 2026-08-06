import assert from 'node:assert/strict';
import {
  mkdir, mkdtemp, rm, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { stats } from '../../lib/commands/stats.mjs';
import { resolvePaths } from '../../lib/core/paths.mjs';
import { serializeFlow, parseFlow } from '../../lib/flows/artifact.mjs';
import { QUARANTINE_FAIL_STREAK_THRESHOLD } from '../../lib/flows/match.mjs';

async function tempPaths(t) {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-stats-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  return resolvePaths({ homeDir, pluginRoot: '/plugin' });
}

// --- fixture builder (mirrors tests/unit/flows-match.test.mjs's own
// baseFlow/baseProvenance helper style: minimal-but-valid flow objects
// round-tripped through parseFlow) ---

function target({ name, description = name, role = 'button' } = {}) {
  return {
    locators: [{ kind: 'text', selector: `internal:text="${name}"` }],
    description,
    role,
    name,
  };
}

function baseProvenance(overrides = {}) {
  return {
    compiledAt: '2026-01-01T00:00:00.000Z',
    traceDir: 'trace-1',
    seqRange: [0, 1],
    productVersion: '0.1.0-test',
    successRuns: 0,
    failStreak: 0,
    lastHealed: null,
    ...overrides,
  };
}

function baseFlow({ name = 'view-details', sideEffects = 'read-only', provenance, ...overrides } = {}) {
  return parseFlow({
    schemaVersion: 1,
    id: 'a'.repeat(64),
    name,
    description: 'View order details',
    origin: 'https://shop.example',
    urlPattern: '/cart',
    sideEffects,
    args: {},
    result: { kind: 'completion', keys: [] },
    steps: [{ op: 'click', target: target({ name: 'View details' }) }],
    provenance: baseProvenance(provenance),
    ...overrides,
  });
}

async function writeFlowFile(dir, flow) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${flow.name}.flow.json`), serializeFlow(flow));
}

async function writeRunsLedger(paths, lines) {
  await mkdir(paths.runsDir, { recursive: true });
  const text = lines.map((line) => JSON.stringify(line)).join('\n');
  await writeFile(paths.runsFile, text.length > 0 ? `${text}\n` : '');
}

test('exports a dependency-injected stats command function', () => {
  assert.equal(typeof stats, 'function');
});

// --- runs.jsonl: ENOENT = empty (Shared shapes) ---

test('an absent runs.jsonl reports an all-zero, additive-stable stats shape', async (t) => {
  const paths = await tempPaths(t);
  const report = await stats({}, { paths });
  assert.deepEqual(report, {
    command: 'stats',
    replays: 0,
    outcomes: {
      clean: 0, fallback: 0, escalated: 0, 'quirk-recovered': 0, healed: 0, failed: 0,
    },
    healRate: 0,
    cleanRate: 0,
    quarantined: 0,
    flowsHealed: 0,
  });
});

// --- exact --json shape, pinned against a fixture ledger ---

test('stats --json computes exact outcome counts and rates from a fixture runs.jsonl (Shared shapes)', async (t) => {
  const paths = await tempPaths(t);
  const line = (outcome) => ({
    v: 1,
    ts: '2026-04-01T00:00:00.000Z',
    flowName: 'view-details',
    flowId: 'a'.repeat(64),
    origin: 'https://shop.example',
    outcome,
    quirkAttempted: null,
    healedKind: null,
    sessionDir: 'trace-1',
  });
  await writeRunsLedger(paths, [
    line('clean'), line('clean'), line('clean'), line('clean'), line('clean'), line('clean'),
    line('fallback'), line('fallback'),
    line('escalated'),
    line('quirk-recovered'),
    line('healed'),
    line('failed'),
  ]);

  const report = await stats({}, { paths });
  assert.equal(report.replays, 12);
  assert.deepEqual(report.outcomes, {
    clean: 6, fallback: 2, escalated: 1, 'quirk-recovered': 1, healed: 1, failed: 1,
  });
  assert.equal(report.healRate, 1 / 12);
  assert.equal(report.cleanRate, 6 / 12);
  assert.equal(report.quarantined, 0);
  assert.equal(report.flowsHealed, 0);
});

test('malformed and blank lines in runs.jsonl are skipped, never thrown on -- the ledger is derived, best-effort data', async (t) => {
  const paths = await tempPaths(t);
  await mkdir(paths.runsDir, { recursive: true });
  await writeFile(
    paths.runsFile,
    [
      '',
      'not json at all',
      JSON.stringify({ outcome: 'not-a-real-outcome' }),
      JSON.stringify({
        v: 1,
        ts: '2026-04-01T00:00:00.000Z',
        flowName: 'view-details',
        flowId: 'a'.repeat(64),
        origin: 'https://shop.example',
        outcome: 'clean',
        quirkAttempted: null,
        healedKind: null,
        sessionDir: 'trace-1',
      }),
      '',
    ].join('\n'),
  );
  const report = await stats({}, { paths });
  assert.equal(report.replays, 1);
  assert.equal(report.outcomes.clean, 1);
});

// --- quarantine + flowsHealed: real flow dirs, the same match.mjs constant ---

test('quarantined counts flows across BOTH tiers whose failStreak has reached the real quarantine threshold', async (t) => {
  const paths = await tempPaths(t);
  const healthy = baseFlow({ name: 'healthy-flow', provenance: { successRuns: 5, failStreak: QUARANTINE_FAIL_STREAK_THRESHOLD - 1, compiledAt: '2026-01-01T00:00:00.000Z', traceDir: 'trace-1', lastHealed: null } });
  const quarantinedReady = baseFlow({ name: 'quarantined-ready', provenance: { successRuns: 0, failStreak: QUARANTINE_FAIL_STREAK_THRESHOLD, compiledAt: '2026-01-01T00:00:00.000Z', traceDir: 'trace-1', lastHealed: null } });
  const quarantinedPending = baseFlow({ name: 'quarantined-pending', sideEffects: 'mutating', provenance: { successRuns: 0, failStreak: QUARANTINE_FAIL_STREAK_THRESHOLD + 4, compiledAt: '2026-01-01T00:00:00.000Z', traceDir: 'trace-1', lastHealed: null } });

  await writeFlowFile(paths.flowsDir, healthy);
  await writeFlowFile(paths.flowsDir, quarantinedReady);
  await writeFlowFile(paths.flowsPendingDir, quarantinedPending);

  const report = await stats({}, { paths });
  assert.equal(report.quarantined, 2);
});

test('flowsHealed counts flows across BOTH tiers with a non-null provenance.lastHealed', async (t) => {
  const paths = await tempPaths(t);
  const neverHealed = baseFlow({ name: 'never-healed' });
  const healedReady = baseFlow({ name: 'healed-ready', provenance: { successRuns: 3, failStreak: 0, compiledAt: '2026-01-01T00:00:00.000Z', traceDir: 'trace-1', lastHealed: '2026-03-01T00:00:00.000Z' } });
  const healedPending = baseFlow({ name: 'healed-pending', sideEffects: 'mutating', provenance: { successRuns: 0, failStreak: 1, compiledAt: '2026-01-01T00:00:00.000Z', traceDir: 'trace-1', lastHealed: '2026-03-02T00:00:00.000Z' } });

  await writeFlowFile(paths.flowsDir, neverHealed);
  await writeFlowFile(paths.flowsDir, healedReady);
  await writeFlowFile(paths.flowsPendingDir, healedPending);

  const report = await stats({}, { paths });
  assert.equal(report.flowsHealed, 2);
});

test('an unreadable/invalid flow artifact file is skipped rather than thrown on', async (t) => {
  const paths = await tempPaths(t);
  await mkdir(paths.flowsDir, { recursive: true });
  await writeFile(path.join(paths.flowsDir, 'corrupt.flow.json'), 'not json');
  const healthy = baseFlow({ name: 'healthy-flow' });
  await writeFlowFile(paths.flowsDir, healthy);

  const report = await stats({}, { paths });
  assert.equal(report.quarantined, 0);
  assert.equal(report.flowsHealed, 0);
});

// --- CLI discipline: a genuine (non-ENOENT) read fault is reported, not swallowed ---

test('a non-ENOENT runs.jsonl read fault surfaces as a LifecycleError, never silently reports an empty ledger', async (t) => {
  const paths = await tempPaths(t);
  const readFile = async () => {
    const error = new Error('permission denied');
    error.code = 'EACCES';
    throw error;
  };
  await assert.rejects(
    () => stats({}, { paths, readFile }),
    (error) => error.name === 'LifecycleError',
  );
});
