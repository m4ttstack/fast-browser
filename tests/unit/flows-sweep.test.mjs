import assert from 'node:assert/strict';
import {
  mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { flowId } from '../../lib/flows/artifact.mjs';
import { resolvePaths } from '../../lib/core/paths.mjs';
import { sweep } from '../../lib/flows/sweep.mjs';

// --- fixture builders (mirrors flows-compile.test.mjs's `record()`/
// `traceTarget()` helper style, but written to real actions.jsonl files in
// a real tmp dataDir -- this module reads from disk, incrementally, so its
// tests need real growth between sweep calls, not just in-memory arrays) ---

async function tempPaths(t) {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-sweep-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  return resolvePaths({ homeDir, pluginRoot: '/plugin' });
}

function record(overrides) {
  return {
    v: 1,
    seq: 1,
    tool: 'browser_click',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:00.100Z',
    params: {},
    urlBefore: 'https://example.com/app',
    urlAfter: 'https://example.com/app',
    targets: [],
    network: [],
    mutating: false,
    waits: { settleMs: 0, awaitedNavigation: false, awaitedRequests: 0 },
    code: [],
    ...overrides,
  };
}

function traceTarget({ name, role = 'button' }) {
  return {
    ref: 'e1',
    resolved: `getByRole('${role}', { name: '${name}' })`,
    alternates: [{ kind: 'role', selector: `internal:role=${role}[name="${name}"i]` }],
    role,
    name,
    description: name,
  };
}

function baseMeta(overrides = {}) {
  return {
    schemaVersion: 1,
    productVersion: '0.1.0-test',
    protocolVersion: 2,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:10:00.000Z',
    ...overrides,
  };
}

function jsonl(records) {
  return `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;
}

async function writeSession(paths, epochMs, { meta, records }) {
  const dir = path.join(paths.dataDir, `trace-${epochMs}`);
  await mkdir(dir, { recursive: true });
  if (meta !== null) await writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta));
  await writeFile(path.join(dir, 'actions.jsonl'), jsonl(records));
  return dir;
}

async function appendRecords(paths, epochMs, records) {
  const dir = path.join(paths.dataDir, `trace-${epochMs}`);
  const existing = await readFile(path.join(dir, 'actions.jsonl'), 'utf8');
  await writeFile(path.join(dir, 'actions.jsonl'), existing + jsonl(records));
}

async function rewriteMeta(paths, epochMs, meta) {
  const dir = path.join(paths.dataDir, `trace-${epochMs}`);
  await writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta));
}

async function listFlowFiles(dir) {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

async function readFlow(dir, fileName) {
  return JSON.parse(await readFile(path.join(dir, fileName), 'utf8'));
}

// Two-segment session (origin change splits them, no error record needed):
// a read-only flow (nav + non-mutating click) on shop.example, and a
// mutating flow (nav + mutating click) on checkout.example.
function twoTierRecords() {
  return [
    record({
      seq: 1, tool: 'browser_navigate', params: { url: 'https://shop.example/cart' },
    }),
    record({
      seq: 2, targets: [traceTarget({ name: 'View details' })], mutating: false,
    }),
    record({
      seq: 3, tool: 'browser_navigate', params: { url: 'https://checkout.example/pay' },
    }),
    record({
      seq: 4, targets: [traceTarget({ name: 'Place order' })], mutating: true,
    }),
  ];
}

// --- fresh sweep ---

test('a fresh sweep compiles a session into flows landed in the correct tier dirs', async (t) => {
  const paths = await tempPaths(t);
  await writeSession(paths, 1000, { meta: baseMeta(), records: twoTierRecords() });

  const result = await sweep({ paths });

  assert.deepEqual(
    result.compiled.slice().sort((a, b) => a.name.localeCompare(b.name)),
    [
      { name: 'place-order', tier: 'pending' },
      { name: 'view-details', tier: 'ready' },
    ],
  );
  assert.equal(result.sessionsProcessed, 1);
  assert.deepEqual(result.updated, []);
  assert.equal(result.replaysSeen, 0);
  assert.deepEqual(result.skippedBySession, {});
  assert.deepEqual(result.cursor, { 'trace-1000': { lines: 4 } });

  assert.deepEqual(await listFlowFiles(paths.flowsDir), ['view-details.flow.json']);
  assert.deepEqual(await listFlowFiles(paths.flowsPendingDir), ['place-order.flow.json']);

  const readyFlow = await readFlow(paths.flowsDir, 'view-details.flow.json');
  assert.equal(readyFlow.sideEffects, 'read-only');
  assert.equal(readyFlow.provenance.traceDir, 'trace-1000'); // session dir BASENAME, not the full path
  assert.equal(readyFlow.provenance.compiledAt, '2026-01-01T00:10:00.000Z'); // from meta.endedAt

  const pendingFlow = await readFlow(paths.flowsPendingDir, 'place-order.flow.json');
  assert.equal(pendingFlow.sideEffects, 'mutating');

  // Writes land with the private-file mode the temp+rename idiom enforces.
  const fileStat = await stat(path.join(paths.flowsDir, 'view-details.flow.json'));
  assert.equal(fileStat.mode & 0o777, 0o600);
});

// --- second sweep is a no-op ---

test('a second sweep with no new lines compiles nothing and leaves the cursor unchanged', async (t) => {
  const paths = await tempPaths(t);
  await writeSession(paths, 2000, { meta: baseMeta(), records: twoTierRecords() });

  const first = await sweep({ paths });
  assert.equal(first.compiled.length, 2);

  const second = await sweep({ paths });
  assert.deepEqual(second.compiled, []);
  assert.deepEqual(second.updated, []);
  assert.equal(second.sessionsProcessed, 0);
  assert.equal(second.replaysSeen, 0);
  assert.deepEqual(second.skippedBySession, {});
  assert.deepEqual(second.cursor, first.cursor);

  // No new artifacts, no duplicates.
  assert.deepEqual(await listFlowFiles(paths.flowsDir), ['view-details.flow.json']);
  assert.deepEqual(await listFlowFiles(paths.flowsPendingDir), ['place-order.flow.json']);
});

// --- grown session: only new lines are reprocessed ---

test('a session that grows between sweeps is reprocessed from its saved line cursor only', async (t) => {
  const paths = await tempPaths(t);
  await writeSession(paths, 3000, {
    meta: baseMeta(),
    records: [
      record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://shop.example/cart' } }),
      record({ seq: 2, targets: [traceTarget({ name: 'View details' })], mutating: false }),
    ],
  });

  const first = await sweep({ paths });
  assert.deepEqual(first.compiled, [{ name: 'view-details', tier: 'ready' }]);
  assert.deepEqual(first.cursor, { 'trace-3000': { lines: 2 } });

  await appendRecords(paths, 3000, [
    record({
      seq: 3, tool: 'browser_navigate', params: { url: 'https://checkout.example/pay' },
    }),
    record({
      seq: 4, targets: [traceTarget({ name: 'Place order' })], mutating: true,
    }),
  ]);

  const second = await sweep({ paths });
  assert.deepEqual(second.compiled, [{ name: 'place-order', tier: 'pending' }]);
  assert.equal(second.sessionsProcessed, 1);
  assert.deepEqual(second.cursor, { 'trace-3000': { lines: 4 } });

  // The first flow was never recompiled/rewritten a second time.
  assert.deepEqual(await listFlowFiles(paths.flowsDir), ['view-details.flow.json']);
  assert.deepEqual(await listFlowFiles(paths.flowsPendingDir), ['place-order.flow.json']);
});

// --- replay provenance ---

test('a successful replay record increments successRuns and resets failStreak on the matching stored artifact', async (t) => {
  const paths = await tempPaths(t);
  await writeSession(paths, 4000, {
    meta: baseMeta(),
    records: [
      record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://shop.example/cart' } }),
      record({ seq: 2, targets: [traceTarget({ name: 'View details' })], mutating: false }),
    ],
  });
  const first = await sweep({ paths });
  const [{ name }] = first.compiled;
  const stored = await readFlow(paths.flowsDir, 'view-details.flow.json');
  assert.equal(stored.provenance.successRuns, 0);
  assert.equal(stored.provenance.failStreak, 0);

  await appendRecords(paths, 4000, [
    record({
      seq: 3,
      tool: 'browser_run_code_unsafe',
      params: {
        filename: '/some/path/to/flow-runner.js',
        args: { flow: { id: stored.id, name: stored.name } },
      },
    }),
  ]);

  const second = await sweep({ paths });
  assert.equal(second.replaysSeen, 1);
  assert.deepEqual(second.compiled, []); // never compiled into a js-step flow
  assert.deepEqual(second.updated, [{ name, successRuns: 1, failStreak: 0 }]);

  const updatedOnDisk = await readFlow(paths.flowsDir, 'view-details.flow.json');
  assert.equal(updatedOnDisk.provenance.successRuns, 1);
  assert.equal(updatedOnDisk.provenance.failStreak, 0);
  assert.equal(updatedOnDisk.id, stored.id); // provenance-only edit never changes identity
});

test('a failing replay record increments failStreak and does not touch successRuns; matches by name when id is absent', async (t) => {
  const paths = await tempPaths(t);
  await writeSession(paths, 5000, {
    meta: baseMeta(),
    records: [
      record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://shop.example/cart' } }),
      record({ seq: 2, targets: [traceTarget({ name: 'View details' })], mutating: false }),
    ],
  });
  const first = await sweep({ paths });
  const [{ name }] = first.compiled;

  // First replay succeeds (built up successRuns), second fails: failStreak
  // increments but successRuns is left at its prior value (ruling c is
  // additive on failure, not a reset of the success count).
  await appendRecords(paths, 5000, [
    record({
      seq: 3,
      tool: 'browser_run_code_unsafe',
      params: { filename: 'flow-runner.js', args: { flow: { name } } }, // no id -- name-only match
    }),
  ]);
  const second = await sweep({ paths });
  assert.deepEqual(second.updated, [{ name, successRuns: 1, failStreak: 0 }]);

  await appendRecords(paths, 5000, [
    record({
      seq: 4,
      tool: 'browser_run_code_unsafe',
      params: { filename: 'flow-runner.js', args: { flow: { name } } },
      error: 'replay failed: locator not found',
    }),
  ]);
  const third = await sweep({ paths });
  assert.equal(third.replaysSeen, 1);
  assert.deepEqual(third.updated, [{ name, successRuns: 1, failStreak: 1 }]);

  const updatedOnDisk = await readFlow(paths.flowsDir, 'view-details.flow.json');
  assert.equal(updatedOnDisk.provenance.successRuns, 1);
  assert.equal(updatedOnDisk.provenance.failStreak, 1);
});

// --- id-dedup ---

test('a newly compiled flow whose content (flowId) matches an existing artifact is dropped, not duplicated', async (t) => {
  const paths = await tempPaths(t);
  // An error record forces a segment flush; the ORIGIN resets afterward, so
  // the following nav+click reproduces byte-identical segment content
  // (same origin, same urlPattern, same target) -- same flowId.
  await writeSession(paths, 6000, {
    meta: baseMeta(),
    records: [
      record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://shop.example/cart' } }),
      record({ seq: 2, targets: [traceTarget({ name: 'Refresh' })], mutating: false }),
      record({
        seq: 3, targets: [traceTarget({ name: 'Doomed' })], mutating: false, error: 'boom',
      }),
      record({ seq: 4, tool: 'browser_navigate', params: { url: 'https://shop.example/cart' } }),
      record({ seq: 5, targets: [traceTarget({ name: 'Refresh' })], mutating: false }),
    ],
  });

  const result = await sweep({ paths });

  assert.equal(result.compiled.length, 1);
  assert.equal(result.compiled[0].name, 'refresh');
  assert.deepEqual(await listFlowFiles(paths.flowsDir), ['refresh.flow.json']);
});

// --- name-collision suffixing (including within one session) ---

test('two same-named, different-content flows compiled in one sweep get -2 suffixed, with a re-derived id', async (t) => {
  const paths = await tempPaths(t);
  // Two segments, different origins (so genuinely different content/ids),
  // whose last click's target both slug to "save" -- a pure NAME collision
  // produced within a single compileSession call.
  await writeSession(paths, 7000, {
    meta: baseMeta(),
    records: [
      record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://a.example/page' } }),
      record({ seq: 2, targets: [traceTarget({ name: 'Save' })], mutating: true }),
      record({ seq: 3, tool: 'browser_navigate', params: { url: 'https://b.example/page' } }),
      record({ seq: 4, targets: [traceTarget({ name: 'Save' })], mutating: true }),
    ],
  });

  const result = await sweep({ paths });

  assert.deepEqual(
    result.compiled.map((f) => f.name).sort(),
    ['save', 'save-2'],
  );
  const files = await listFlowFiles(paths.flowsPendingDir);
  assert.deepEqual(files, ['save-2.flow.json', 'save.flow.json']);

  const original = await readFlow(paths.flowsPendingDir, 'save.flow.json');
  const renamed = await readFlow(paths.flowsPendingDir, 'save-2.flow.json');
  assert.equal(renamed.name, 'save-2');
  assert.notEqual(renamed.id, original.id); // renaming changes identity
  assert.notEqual(renamed.origin, original.origin); // genuinely different content, not just a name clash

  // The id on disk must always match the stored content (id excludes
  // id/provenance from its own hash, so re-deriving it here must agree).
  assert.equal(renamed.id, flowId(renamed));
});

// --- corrupt state file ---

test('a corrupt flows-state.json is treated as empty and never throws; a fresh valid one is written back', async (t) => {
  const paths = await tempPaths(t);
  await writeSession(paths, 8000, {
    meta: baseMeta(),
    records: [
      record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://shop.example/cart' } }),
      record({ seq: 2, targets: [traceTarget({ name: 'View details' })], mutating: false }),
    ],
  });
  await mkdir(paths.dataDir, { recursive: true });
  await writeFile(paths.flowsStateFile, 'not json at all {{{');

  const result = await sweep({ paths });

  assert.deepEqual(result.compiled, [{ name: 'view-details', tier: 'ready' }]);
  assert.deepEqual(result.cursor, { 'trace-8000': { lines: 2 } });

  const onDisk = JSON.parse(await readFile(paths.flowsStateFile, 'utf8'));
  assert.deepEqual(onDisk, { schemaVersion: 1, processed: { 'trace-8000': { lines: 2 } } });
});

test('a flows-state.json with the wrong schemaVersion is also treated as empty', async (t) => {
  const paths = await tempPaths(t);
  await writeSession(paths, 8100, {
    meta: baseMeta(),
    records: [
      record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://shop.example/cart' } }),
      record({ seq: 2, targets: [traceTarget({ name: 'View details' })], mutating: false }),
    ],
  });
  await mkdir(paths.dataDir, { recursive: true });
  await writeFile(paths.flowsStateFile, JSON.stringify({ schemaVersion: 99, processed: { foo: { lines: 5 } } }));

  const result = await sweep({ paths });
  assert.deepEqual(result.compiled, [{ name: 'view-details', tier: 'ready' }]);
});

// --- incomplete session re-sweep ---

test('a session with no meta.endedAt is swept but stays incomplete; it completes once endedAt appears, even with no new lines', async (t) => {
  const paths = await tempPaths(t);
  const clock = () => new Date('2026-02-02T00:00:00.000Z');
  await writeSession(paths, 9000, {
    meta: baseMeta({ endedAt: undefined }),
    records: [
      record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://shop.example/cart' } }),
      record({ seq: 2, targets: [traceTarget({ name: 'View details' })], mutating: false }),
    ],
  });

  const first = await sweep({ paths, now: clock });
  assert.equal(first.compiled.length, 1);
  assert.deepEqual(first.cursor, { 'trace-9000': { lines: 2, incomplete: true } });
  const compiledFlow = await readFlow(paths.flowsDir, 'view-details.flow.json');
  assert.equal(compiledFlow.provenance.compiledAt, '2026-02-02T00:00:00.000Z'); // from the injected clock

  // Second sweep: still no endedAt, no new lines -- a genuine no-op, but the
  // session must still be re-checked (not silently dropped from the cursor).
  const second = await sweep({ paths, now: clock });
  assert.deepEqual(second.compiled, []);
  assert.equal(second.sessionsProcessed, 0);
  assert.deepEqual(second.cursor, { 'trace-9000': { lines: 2, incomplete: true } });

  // The session ends: meta gains endedAt, still zero new lines.
  await rewriteMeta(paths, 9000, baseMeta());
  const third = await sweep({ paths, now: clock });
  assert.deepEqual(third.compiled, []);
  assert.equal(third.sessionsProcessed, 0);
  assert.deepEqual(third.cursor, { 'trace-9000': { lines: 2 } }); // incomplete flag dropped
});
