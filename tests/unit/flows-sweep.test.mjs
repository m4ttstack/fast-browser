import assert from 'node:assert/strict';
import {
  chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { flowId } from '../../lib/flows/artifact.mjs';
import { resolvePaths } from '../../lib/core/paths.mjs';
import { sweep } from '../../lib/flows/sweep.mjs';
import { originDirName } from '../../lib/sites/store.mjs';

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

async function readState(paths) {
  return JSON.parse(await readFile(paths.flowsStateFile, 'utf8'));
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

// --- site memory fixtures (WS2b Task 4) ---
//
// Unlike `twoTierRecords()` above (whose `urlBefore`/`urlAfter` are left at
// `record()`'s own default on every record -- irrelevant to `compileSession`,
// which derives origin/segmentation from a goto step's `params.url`, not
// these fields), the graph/inventory miners key entirely off `urlBefore`/
// `urlAfter`. These fixtures set both explicitly so mining has real
// navigation/target signal to work with.

// One origin: an entry navigation (from outside shop.example) followed by a
// same-origin navigation-by-click. Mines to 2 graph edges (entry -> /cart,
// /cart -> /product/:id) and 1 inventory target (View details on /cart).
function siteMiningRecords() {
  return [
    record({
      seq: 1,
      tool: 'browser_navigate',
      params: { url: 'https://shop.example/cart' },
      urlBefore: 'about:blank',
      urlAfter: 'https://shop.example/cart',
    }),
    record({
      seq: 2,
      targets: [traceTarget({ name: 'View details' })],
      mutating: false,
      urlBefore: 'https://shop.example/cart',
      urlAfter: 'https://shop.example/product/42',
    }),
  ];
}

// Two origins in one session (mirrors `twoTierRecords()`'s read-only/
// mutating split, but with real urlBefore/urlAfter progression): shop.example
// (nav + same-page click, so only the nav yields a graph edge) and
// checkout.example (cross-origin nav + same-page mutating click).
function multiOriginSiteRecords() {
  return [
    record({
      seq: 1,
      tool: 'browser_navigate',
      params: { url: 'https://shop.example/cart' },
      urlBefore: 'about:blank',
      urlAfter: 'https://shop.example/cart',
    }),
    record({
      seq: 2,
      targets: [traceTarget({ name: 'View details' })],
      mutating: false,
      urlBefore: 'https://shop.example/cart',
      urlAfter: 'https://shop.example/cart',
    }),
    record({
      seq: 3,
      tool: 'browser_navigate',
      params: { url: 'https://checkout.example/pay' },
      urlBefore: 'https://shop.example/cart',
      urlAfter: 'https://checkout.example/pay',
    }),
    record({
      seq: 4,
      targets: [traceTarget({ name: 'Place order' })],
      mutating: true,
      urlBefore: 'https://checkout.example/pay',
      urlAfter: 'https://checkout.example/pay',
    }),
  ];
}

async function readSiteFile(paths, origin, fileName) {
  return JSON.parse(
    await readFile(path.join(paths.sitesDir, originDirName(origin), fileName), 'utf8'),
  );
}

// --- fresh sweep ---

test('a fresh sweep compiles a completed session into flows landed in the correct tier dirs', async (t) => {
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
  assert.deepEqual(result.cursor, { 'trace-1000': { lines: 4, provenanceLines: 4 } });

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

// --- grown session: only new lines are reprocessed (F5: discriminate true
// slicing from a "recompile everything, dedup absorbs the redundancy" bug)
// ---

test('a completed session that grows after its first sweep is reprocessed from its saved line cursor only, not recompiled wholesale', async (t) => {
  const paths = await tempPaths(t);
  // seq2 errors -- forces a segment flush, and (on its own) an
  // 'error-truncated' skip that must be reported EXACTLY ONCE, on the
  // sweep that first observes it. If a later sweep ever re-feeds records
  // 1-2 to the compiler (the "recompile everything, let dedup mask it"
  // bug this test is designed to catch), that skip reappears -- dedup has
  // no equivalent protection for report.skipped the way it does for
  // `compiled`, so this is a genuine discriminator, not just a duplicate
  // assertion of what `compiled` already shows.
  await writeSession(paths, 3000, {
    meta: baseMeta(),
    records: [
      record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://shop.example/cart' } }),
      record({
        seq: 2, targets: [traceTarget({ name: 'Whoops' })], mutating: false, error: 'boom',
      }),
    ],
  });

  const first = await sweep({ paths });
  assert.deepEqual(first.compiled, []); // nav-only fragment, too short either way
  assert.deepEqual(first.skippedBySession, {
    'trace-3000': [
      { reason: 'error-truncated', seqRange: [1, 1] },
      { reason: 'error-truncated', seqRange: [2, 2] },
    ],
  });
  assert.deepEqual(first.cursor, { 'trace-3000': { lines: 2, provenanceLines: 2 } });

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
  // The discriminator: records 1-2 (and their error skip) must NOT be
  // re-reported. A wholesale-recompile bug would show the same `compiled`
  // array (dedup absorbs the redundant 'place-order'... no -- it would
  // absorb a redundant nothing here, since records 1-2 never compiled a
  // flow at all -- but it WOULD re-surface both error-truncated skips).
  assert.deepEqual(second.skippedBySession, {});
  assert.deepEqual(second.cursor, { 'trace-3000': { lines: 4, provenanceLines: 4 } });

  assert.deepEqual(await listFlowFiles(paths.flowsDir), []);
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
  assert.deepEqual(second.cursor, { 'trace-4000': { lines: 3, provenanceLines: 3 } });

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
  assert.deepEqual(second.compiled, []);
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
  assert.deepEqual(third.compiled, []);
  assert.deepEqual(third.updated, [{ name, successRuns: 1, failStreak: 1 }]);

  const updatedOnDisk = await readFlow(paths.flowsDir, 'view-details.flow.json');
  assert.equal(updatedOnDisk.provenance.successRuns, 1);
  assert.equal(updatedOnDisk.provenance.failStreak, 1);
});

// --- F3: replays never reach the compiler, tested directly (not via an
// accidental too-short pass) ---

test('a completed session whose new records are ALL replays never reaches the compiler: nothing compiled, both tier dirs stay empty', async (t) => {
  const paths = await tempPaths(t);
  await writeSession(paths, 5500, {
    meta: baseMeta(),
    records: [
      record({
        seq: 1,
        tool: 'browser_run_code_unsafe',
        params: { filename: 'flow-runner.js', args: { flow: { id: 'a'.repeat(64), name: 'ghost' } } },
      }),
      record({
        seq: 2,
        tool: 'browser_run_code_unsafe',
        params: { filename: 'flow-runner.js', args: { flow: { id: 'b'.repeat(64), name: 'ghost-2' } } },
        error: 'replay failed',
      }),
    ],
  });

  const result = await sweep({ paths });

  assert.deepEqual(result.compiled, []);
  assert.deepEqual(result.skippedBySession, {}); // compileSession was never even called
  assert.equal(result.replaysSeen, 2);
  assert.deepEqual(result.updated, []); // neither ghost id/name matches a stored artifact
  assert.deepEqual(await listFlowFiles(paths.flowsDir), []);
  assert.deepEqual(await listFlowFiles(paths.flowsPendingDir), []);
});

// --- F7: `updated` is aggregated per flow id at sweep level ---

test('a flow replayed from two different sessions in one sweep gets exactly one final updated entry, not two contradictory ones', async (t) => {
  const paths = await tempPaths(t);
  await writeSession(paths, 5600, {
    meta: baseMeta(),
    records: [
      record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://shop.example/cart' } }),
      record({ seq: 2, targets: [traceTarget({ name: 'View details' })], mutating: false }),
    ],
  });
  const setup = await sweep({ paths });
  const [{ name }] = setup.compiled;
  const stored = await readFlow(paths.flowsDir, 'view-details.flow.json');

  // Two DIFFERENT sessions, each replaying the same flow once, swept
  // together in a single sweep() call.
  await writeSession(paths, 5700, {
    meta: baseMeta(),
    records: [
      record({
        seq: 1,
        tool: 'browser_run_code_unsafe',
        params: { filename: 'flow-runner.js', args: { flow: { id: stored.id, name } } },
      }),
    ],
  });
  await writeSession(paths, 5800, {
    meta: baseMeta(),
    records: [
      record({
        seq: 1,
        tool: 'browser_run_code_unsafe',
        params: { filename: 'flow-runner.js', args: { flow: { id: stored.id, name } } },
        error: 'boom',
      }),
    ],
  });

  const result = await sweep({ paths });
  assert.equal(result.replaysSeen, 2);
  // Exactly one entry for this flow, reflecting BOTH replays applied in
  // session order (success then failure): successRuns from the first,
  // failStreak from the second -- never two separate/contradictory rows.
  assert.deepEqual(result.updated, [{ name, successRuns: 1, failStreak: 1 }]);

  const onDisk = await readFlow(paths.flowsDir, 'view-details.flow.json');
  assert.equal(onDisk.provenance.successRuns, 1);
  assert.equal(onDisk.provenance.failStreak, 1);
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
  assert.deepEqual(result.cursor, { 'trace-8000': { lines: 2, provenanceLines: 2 } });

  const onDisk = await readState(paths);
  assert.deepEqual(onDisk, { schemaVersion: 1, processed: { 'trace-8000': { lines: 2, provenanceLines: 2 } } });
});

test('a flows-state.json with the wrong schemaVersion is treated as empty; a poisoned cursor for a REAL session does not survive the gate', async (t) => {
  const paths = await tempPaths(t);
  await writeSession(paths, 8100, {
    meta: baseMeta(),
    records: [
      record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://shop.example/cart' } }),
      record({ seq: 2, targets: [traceTarget({ name: 'View details' })], mutating: false }),
    ],
  });
  await mkdir(paths.dataDir, { recursive: true });
  // N2 (fix round 2): the poisoned cursor is seeded under the REAL session
  // basename (trace-8100), not an unrelated key -- `lines: 99` is past the
  // actual 2-record file, which would suppress compilation entirely if
  // this state were trusted. A well-typed { lines: 99 } would otherwise
  // pass per-entry validation on its own shape merits, so this is the
  // assertion that actually depends on the schemaVersion gate firing (the
  // prior fixture used an unrelated 'foo' key, which could never fail
  // this way even if the gate were silently removed).
  await writeFile(
    paths.flowsStateFile,
    JSON.stringify({ schemaVersion: 99, processed: { 'trace-8100': { lines: 99, provenanceLines: 99 } } }),
  );

  const result = await sweep({ paths });
  assert.deepEqual(result.compiled, [{ name: 'view-details', tier: 'ready' }]);
  assert.deepEqual(result.cursor, { 'trace-8100': { lines: 2, provenanceLines: 2 } });

  const onDisk = await readState(paths);
  assert.deepEqual(onDisk.processed, { 'trace-8100': { lines: 2, provenanceLines: 2 } });
});

test('an old (pre-fix) one-cursor state entry upgrades cleanly: absent provenanceLines defaults to lines, no re-counted replay', async (t) => {
  const paths = await tempPaths(t);
  await writeSession(paths, 8200, {
    meta: baseMeta(),
    records: [
      record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://shop.example/cart' } }),
      record({ seq: 2, targets: [traceTarget({ name: 'View details' })], mutating: false }),
      record({
        seq: 3,
        tool: 'browser_run_code_unsafe',
        params: { filename: 'flow-runner.js', args: { flow: { name: 'view-details' } } },
      }),
    ],
  });
  // Seed a stored artifact matching what a prior (old-design) sweep would
  // have already produced and already applied the replay to.
  const preSweep = await sweep({ paths }); // establishes the real flow + applies the one replay once
  assert.deepEqual(preSweep.updated, [{ name: 'view-details', successRuns: 1, failStreak: 0 }]);

  // Now hand-roll an old-shape state entry (as if written before this fix)
  // that only carries `lines`, at the same total the real sweep just
  // reached -- overwriting the (already-correct) new-shape entry.
  const state = await readState(paths);
  state.processed['trace-8200'] = { lines: 3 }; // no provenanceLines at all
  await writeFile(paths.flowsStateFile, JSON.stringify(state));

  const second = await sweep({ paths });
  assert.deepEqual(second.compiled, []);
  assert.deepEqual(second.updated, []); // NOT re-applied -- provenanceLines defaulted to lines (3), already caught up
  assert.deepEqual(second.cursor, { 'trace-8200': { lines: 3, provenanceLines: 3 } });

  const onDisk = await readFlow(paths.flowsDir, 'view-details.flow.json');
  assert.equal(onDisk.provenance.successRuns, 1); // still just the one real application
});

// --- F2: live-session compilation deferral ---

test('a live session (no meta.endedAt) defers compilation entirely; it compiles the whole coherent trace once meta.endedAt appears', async (t) => {
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
  assert.deepEqual(first.compiled, []); // deferred -- not yet complete
  assert.equal(first.sessionsProcessed, 0); // nothing substantive happened (no compile, no replay)
  assert.deepEqual(first.cursor, { 'trace-9000': { lines: 0, provenanceLines: 2, incomplete: true } });
  assert.deepEqual(await listFlowFiles(paths.flowsDir), []);
  assert.deepEqual(await listFlowFiles(paths.flowsPendingDir), []);

  // Still live, no new lines -- a genuine no-op, but re-checked every sweep.
  const second = await sweep({ paths, now: clock });
  assert.deepEqual(second.compiled, []);
  assert.equal(second.sessionsProcessed, 0);
  assert.deepEqual(second.cursor, { 'trace-9000': { lines: 0, provenanceLines: 2, incomplete: true } });

  // The session ends -- meta gains endedAt, still zero new lines beyond
  // what was already scanned for provenance. The WHOLE coherent file
  // compiles in one shot now, never having been fragmented while live.
  await rewriteMeta(paths, 9000, baseMeta());
  const third = await sweep({ paths, now: clock });
  assert.deepEqual(third.compiled, [{ name: 'view-details', tier: 'ready' }]);
  assert.deepEqual(third.cursor, { 'trace-9000': { lines: 2, provenanceLines: 2 } });

  const compiledFlow = await readFlow(paths.flowsDir, 'view-details.flow.json');
  // meta.endedAt now present -- wins over the injected clock (compile.mjs's
  // own resolveCompiledAt contract), so compiledAt is the real close time,
  // not the moment this sweep happened to run.
  assert.equal(compiledFlow.provenance.compiledAt, '2026-01-01T00:10:00.000Z');
});

test('a replay record inside a still-live session updates the stored artifact immediately, even though the replaying session itself stays uncompiled', async (t) => {
  const paths = await tempPaths(t);
  // A separate, already-complete session establishes the flow to replay.
  await writeSession(paths, 12000, {
    meta: baseMeta(),
    records: [
      record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://shop.example/cart' } }),
      record({ seq: 2, targets: [traceTarget({ name: 'View details' })], mutating: false }),
    ],
  });
  const setup = await sweep({ paths });
  const [{ name }] = setup.compiled;
  const stored = await readFlow(paths.flowsDir, 'view-details.flow.json');

  // A live session (no endedAt) whose only content, so far, is a replay of
  // that flow.
  await writeSession(paths, 13000, {
    meta: baseMeta({ endedAt: undefined }),
    records: [
      record({
        seq: 1,
        tool: 'browser_run_code_unsafe',
        params: { filename: 'flow-runner.js', args: { flow: { id: stored.id, name } } },
      }),
    ],
  });

  const result = await sweep({ paths });
  assert.equal(result.replaysSeen, 1);
  assert.equal(result.sessionsProcessed, 1); // only the live session did anything this round
  assert.deepEqual(result.updated, [{ name, successRuns: 1, failStreak: 0 }]);
  assert.deepEqual(result.compiled, []); // the live session itself compiles nothing
  assert.deepEqual(result.cursor['trace-13000'], { lines: 0, provenanceLines: 1, incomplete: true });

  const updatedOnDisk = await readFlow(paths.flowsDir, 'view-details.flow.json');
  assert.equal(updatedOnDisk.provenance.successRuns, 1);

  // The live session later completes with no new lines: it contributes
  // nothing further (the replay was already counted; there was nothing
  // else in it to compile).
  await rewriteMeta(paths, 13000, baseMeta());
  const after = await sweep({ paths });
  assert.deepEqual(after.compiled, []);
  assert.deepEqual(after.updated, []); // not re-applied
  assert.deepEqual(after.cursor['trace-13000'], { lines: 1, provenanceLines: 1 });
});

// --- F1: per-session state persistence survives a mid-sweep failure ---

test('a write failure on a later session does not lose an earlier session\'s already-persisted progress; a retry does not double-count', async (t) => {
  const paths = await tempPaths(t);

  // Session Z: already complete, swept on its own first -- establishes a
  // stored flow to replay against.
  await writeSession(paths, 500, {
    meta: baseMeta(),
    records: [
      record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://shop.example/cart' } }),
      record({ seq: 2, targets: [traceTarget({ name: 'View details' })], mutating: false }),
    ],
  });
  const zeroth = await sweep({ paths });
  const [{ name }] = zeroth.compiled;
  const storedBefore = await readFlow(paths.flowsDir, 'view-details.flow.json');

  // Session A (epochMs 1000, processed before B in listTraceSessions'
  // ascending order): a completed session whose only new content is a
  // successful replay of the stored flow.
  await writeSession(paths, 1000, {
    meta: baseMeta(),
    records: [
      record({
        seq: 1,
        tool: 'browser_run_code_unsafe',
        params: { filename: 'flow-runner.js', args: { flow: { id: storedBefore.id, name } } },
      }),
    ],
  });

  // Session B (epochMs 2000): a completed session that would compile a new
  // mutating flow into flowsPendingDir -- but that directory is sabotaged
  // (a FILE sits where the directory belongs), so the write throws mid-
  // sweep, strictly AFTER A has already been fully processed.
  await writeSession(paths, 2000, {
    meta: baseMeta(),
    records: [
      record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://other.example/checkout' } }),
      record({ seq: 2, targets: [traceTarget({ name: 'Confirm' })], mutating: true }),
    ],
  });
  await rm(paths.flowsPendingDir, { recursive: true, force: true });
  await writeFile(paths.flowsPendingDir, 'not a directory');

  await assert.rejects(() => sweep({ paths }));

  // A's work already landed on disk before B blew up.
  const afterCrash = await readFlow(paths.flowsDir, 'view-details.flow.json');
  assert.equal(afterCrash.provenance.successRuns, 1);
  const stateAfterCrash = await readState(paths);
  assert.equal(stateAfterCrash.processed['trace-1000'].provenanceLines, 1);
  assert.equal('trace-2000' in stateAfterCrash.processed, false); // B never got as far as recording its own entry

  // Repair the sabotage and retry: B now succeeds, and A's already-counted
  // replay is NOT re-applied (state already reflects it was processed).
  await rm(paths.flowsPendingDir, { force: true });
  const retry = await sweep({ paths });
  assert.deepEqual(retry.compiled, [{ name: 'confirm', tier: 'pending' }]);
  assert.deepEqual(retry.updated, []); // A contributes nothing new this time

  const afterRetry = await readFlow(paths.flowsDir, 'view-details.flow.json');
  assert.equal(afterRetry.provenance.successRuns, 1); // NOT double-counted
});

// --- F8: stale state entries are pruned at save time ---

test('a state entry for a trace dir that no longer exists is pruned from the persisted state on the next save', async (t) => {
  const paths = await tempPaths(t);
  await writeSession(paths, 11000, {
    meta: baseMeta(),
    records: [
      record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://shop.example/cart' } }),
      record({ seq: 2, targets: [traceTarget({ name: 'View details' })], mutating: false }),
    ],
  });
  const first = await sweep({ paths });
  assert.deepEqual(first.cursor, { 'trace-11000': { lines: 2, provenanceLines: 2 } });

  // The session directory is gone (e.g. archived/cleaned up elsewhere).
  await rm(path.join(paths.dataDir, 'trace-11000'), { recursive: true, force: true });

  const second = await sweep({ paths });
  assert.deepEqual(second.cursor, {});
  const onDisk = await readState(paths);
  assert.deepEqual(onDisk.processed, {});
});

// --- N1 (fix round 2, Important): a read fault must not be mistaken for
// an empty session ---

test('a session whose actions.jsonl becomes unreadable is left completely untouched: cursor unchanged, reported as unreadable, no re-counted replay once readable again', async (t) => {
  const paths = await tempPaths(t);
  await writeSession(paths, 14000, {
    meta: baseMeta(),
    records: [
      record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://shop.example/cart' } }),
      record({ seq: 2, targets: [traceTarget({ name: 'View details' })], mutating: false }),
    ],
  });
  const first = await sweep({ paths });
  const [{ name }] = first.compiled;
  const stored = await readFlow(paths.flowsDir, 'view-details.flow.json');

  // Establish a counted replay (cursor n) before the fault, per the
  // regression scenario: a re-count on recovery would show up here.
  await appendRecords(paths, 14000, [
    record({
      seq: 3,
      tool: 'browser_run_code_unsafe',
      params: { filename: 'flow-runner.js', args: { flow: { id: stored.id, name } } },
    }),
  ]);
  const second = await sweep({ paths });
  assert.deepEqual(second.updated, [{ name, successRuns: 1, failStreak: 0 }]);
  const cursorBeforeFault = second.cursor['trace-14000'];
  assert.deepEqual(cursorBeforeFault, { lines: 3, provenanceLines: 3 });

  const actionsFile = path.join(paths.dataDir, 'trace-14000', 'actions.jsonl');
  await chmod(actionsFile, 0o000);
  t.after(() => chmod(actionsFile, 0o600).catch(() => {})); // safety net for the outer tmpdir rm

  const third = await sweep({ paths });
  assert.deepEqual(third.compiled, []);
  assert.deepEqual(third.updated, []);
  assert.deepEqual(
    third.skippedBySession,
    { 'trace-14000': [{ reason: 'unreadable', seqRange: [null, null] }] },
  );
  assert.deepEqual(third.cursor['trace-14000'], cursorBeforeFault); // cursor unchanged on disk

  const stateWhileFaulted = await readState(paths);
  assert.deepEqual(stateWhileFaulted.processed['trace-14000'], cursorBeforeFault);

  await chmod(actionsFile, 0o600);
  const fourth = await sweep({ paths });
  assert.deepEqual(fourth.compiled, []); // no fresh compile duplicate
  assert.deepEqual(fourth.updated, []); // no re-count
  assert.deepEqual(fourth.cursor['trace-14000'], cursorBeforeFault);

  const finalFlow = await readFlow(paths.flowsDir, 'view-details.flow.json');
  assert.equal(finalFlow.provenance.successRuns, 1); // still just the one real application
  assert.deepEqual(await listFlowFiles(paths.flowsDir), ['view-details.flow.json']);
});

// --- shrunk session (Task 8, folded MAT-136 debt #2): actions.jsonl itself
// vanishes (ENOENT) inside a still-present session dir, which now reads as
// readable: true, records: [] (trace-reader.mjs's ENOENT carve-out) rather
// than readable: false -- so this session does NOT take the N1
// "leave completely untouched" early-continue path above. Its records array
// genuinely shrinks below the saved cursor, which the OLD `nextLines =
// records.length` / `nextProvenanceLines = records.length` assignments would
// have written straight back into state, rewinding the cursor and
// re-counting the replay above on the very next sweep that finds the file
// restored. The chosen behavior (documented in sweep.mjs): treat a
// records.length below the saved cursor as "no new lines this sweep" and
// leave the cursor exactly where it was -- never write a SMALLER cursor than
// is already on disk. State pruning (F8) is a separate mechanism that only
// fires for a deleted trace DIRECTORY (`listTraceSessions` no longer seeing
// it at all); this is a file missing from a dir that's still there, so F8
// does not apply and the shrink guard is what protects the cursor instead.
test('a session whose actions.jsonl vanishes (file deleted, dir still present) reads as empty/readable but leaves its cursor untouched: no crash, no rewind, no re-counted replay on restore', async (t) => {
  const paths = await tempPaths(t);
  await writeSession(paths, 15000, {
    meta: baseMeta(),
    records: [
      record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://shop.example/cart' } }),
      record({ seq: 2, targets: [traceTarget({ name: 'View details' })], mutating: false }),
    ],
  });
  const first = await sweep({ paths });
  const [{ name }] = first.compiled;
  const stored = await readFlow(paths.flowsDir, 'view-details.flow.json');

  // Counted replay at cursor n=3, exactly the N1 regression's setup.
  await appendRecords(paths, 15000, [
    record({
      seq: 3,
      tool: 'browser_run_code_unsafe',
      params: { filename: 'flow-runner.js', args: { flow: { id: stored.id, name } } },
    }),
  ]);
  const second = await sweep({ paths });
  assert.deepEqual(second.updated, [{ name, successRuns: 1, failStreak: 0 }]);
  const cursorBeforeVanish = second.cursor['trace-15000'];
  assert.deepEqual(cursorBeforeVanish, { lines: 3, provenanceLines: 3 });

  // The file itself vanishes -- the session DIRECTORY (and its meta.json)
  // stays put, so this is not the F8 stale-directory-pruning case.
  await unlink(path.join(paths.dataDir, 'trace-15000', 'actions.jsonl'));

  const third = await sweep({ paths });
  assert.deepEqual(third.compiled, []);
  assert.deepEqual(third.updated, []);
  // readable: true now (ENOENT carve-out), so this is NOT reported as
  // 'unreadable' -- it genuinely read as an (honest, if surprising) empty
  // session, and the shrink guard is what keeps that from mangling state.
  assert.deepEqual(third.skippedBySession, {});
  assert.deepEqual(third.cursor['trace-15000'], cursorBeforeVanish); // cursor NOT rewound to 0

  const stateWhileVanished = await readState(paths);
  assert.deepEqual(stateWhileVanished.processed['trace-15000'], cursorBeforeVanish);

  // Restored with EXACTLY its prior content: records.length (3) is no
  // longer less than the saved cursor (3), so nothing new is (re-)sliced.
  await writeFile(
    path.join(paths.dataDir, 'trace-15000', 'actions.jsonl'),
    jsonl([
      record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://shop.example/cart' } }),
      record({ seq: 2, targets: [traceTarget({ name: 'View details' })], mutating: false }),
      record({
        seq: 3,
        tool: 'browser_run_code_unsafe',
        params: { filename: 'flow-runner.js', args: { flow: { id: stored.id, name } } },
      }),
    ]),
  );
  const fourth = await sweep({ paths });
  assert.deepEqual(fourth.compiled, []); // no fresh compile duplicate
  assert.deepEqual(fourth.updated, []); // no re-counted replay
  assert.deepEqual(fourth.cursor['trace-15000'], cursorBeforeVanish);

  const restoredFlow = await readFlow(paths.flowsDir, 'view-details.flow.json');
  assert.equal(restoredFlow.provenance.successRuns, 1); // still just the one real application

  // Restored with MORE than its prior content: only the genuinely new
  // record (seq 4) is processed -- the shrink guard doesn't also block
  // legitimate growth once the cursor has caught back up.
  await appendRecords(paths, 15000, [
    record({
      seq: 4,
      tool: 'browser_run_code_unsafe',
      params: { filename: 'flow-runner.js', args: { flow: { id: stored.id, name } } },
      error: 'replay failed',
    }),
  ]);
  const fifth = await sweep({ paths });
  assert.deepEqual(fifth.updated, [{ name, successRuns: 1, failStreak: 1 }]);
  assert.deepEqual(fifth.cursor['trace-15000'], { lines: 4, provenanceLines: 4 });
});

// --- site memory mining (WS2b plan, Task 4) ---

test('a completed session mines graph edges and inventory targets into the correctly encoded origin dir, reported in sites', async (t) => {
  const paths = await tempPaths(t);
  await writeSession(paths, 20000, { meta: baseMeta(), records: siteMiningRecords() });

  const result = await sweep({ paths });

  assert.deepEqual(result.sites.origins, ['https://shop.example']);
  assert.equal(result.sites.edges, 2);
  assert.equal(result.sites.targets, 1);
  assert.equal(result.sites.evicted, 0);
  assert.deepEqual(result.sites.errors, []);

  // Origin dir is the store's own encoding -- not something this module
  // reinvents.
  const originDir = path.join(paths.sitesDir, originDirName('https://shop.example'));
  assert.equal((await stat(originDir)).isDirectory(), true);

  const graph = await readSiteFile(paths, 'https://shop.example', 'graph.json');
  assert.equal(graph.edges.length, 2);
  assert.deepEqual(
    graph.edges.map((e) => [e.from, e.to, e.action.tool, e.action.targetName ?? null]).sort(),
    [
      [null, '/cart', 'browser_navigate', null],
      ['/cart', '/product/:id', 'browser_click', 'View details'],
    ].sort(),
  );

  const inventory = await readSiteFile(paths, 'https://shop.example', 'inventory.json');
  assert.deepEqual(Object.keys(inventory.patterns), ['/cart']);
  assert.equal(inventory.patterns['/cart'].targets.length, 1);
  assert.equal(inventory.patterns['/cart'].targets[0].name, 'View details');

  // Flows still compile normally alongside mining -- mining is additive,
  // never a substitute for compilation.
  assert.deepEqual(result.compiled, [{ name: 'view-details', tier: 'ready' }]);
});

test('a second sweep with no new lines mines nothing further: sites reports zeros, on-disk edge/target counts are unchanged (CONTRACT: sites.origins lists only origins written THIS sweep call)', async (t) => {
  const paths = await tempPaths(t);
  await writeSession(paths, 21000, { meta: baseMeta(), records: siteMiningRecords() });

  const first = await sweep({ paths });
  assert.equal(first.sites.edges, 2);

  const second = await sweep({ paths });
  assert.deepEqual(second.sites, {
    origins: [], edges: 0, targets: 0, evicted: 0, errors: [],
  });

  const graph = await readSiteFile(paths, 'https://shop.example', 'graph.json');
  assert.equal(graph.edges.length, 2);
  assert.deepEqual(graph.edges.map((e) => e.count), [1, 1]); // not double-counted

  const inventory = await readSiteFile(paths, 'https://shop.example', 'inventory.json');
  assert.equal(inventory.patterns['/cart'].targets[0].count, 1);
});

test('a live session (no meta.endedAt) mines nothing: no sites dir is created at all', async (t) => {
  const paths = await tempPaths(t);
  await writeSession(paths, 22000, {
    meta: baseMeta({ endedAt: undefined }),
    records: siteMiningRecords(),
  });

  const result = await sweep({ paths });

  assert.deepEqual(result.sites, {
    origins: [], edges: 0, targets: 0, evicted: 0, errors: [],
  });
  await assert.rejects(() => stat(paths.sitesDir), { code: 'ENOENT' });
});

test('a completed session whose new records are ALL replays mines nothing: sites reports zeros, no sites dir', async (t) => {
  const paths = await tempPaths(t);
  await writeSession(paths, 23000, {
    meta: baseMeta(),
    records: [
      record({
        seq: 1,
        tool: 'browser_run_code_unsafe',
        params: { filename: 'flow-runner.js', args: { flow: { id: 'a'.repeat(64), name: 'ghost' } } },
        urlBefore: 'https://shop.example/cart',
        urlAfter: 'https://shop.example/product/42',
      }),
    ],
  });

  const result = await sweep({ paths });

  assert.deepEqual(result.sites, {
    origins: [], edges: 0, targets: 0, evicted: 0, errors: [],
  });
  await assert.rejects(() => stat(paths.sitesDir), { code: 'ENOENT' });
});

test('a sites store write failure is caught per-origin and reported in sites.errors; flows still compile and the cursor still advances', async (t) => {
  const paths = await tempPaths(t);
  await writeSession(paths, 24000, { meta: baseMeta(), records: siteMiningRecords() });

  // Sabotage the PARENT sites dir (not a specific origin subdir, which
  // doesn't exist yet): `ensurePrivateDirectory` re-chmods any dir it's
  // handed to 0o700, so a read-only ORIGIN dir would just get repaired in
  // place. A read-only PARENT blocks `mkdir` of the new origin subdir
  // itself, which is a real, uncorrectable failure (mirrors
  // tests/unit/macros.test.mjs's `chmod(paths.macrosDir, 0o500)` pattern).
  await mkdir(paths.sitesDir, { recursive: true });
  await chmod(paths.sitesDir, 0o500);
  t.after(() => chmod(paths.sitesDir, 0o700).catch(() => {}));

  let result;
  try {
    result = await sweep({ paths });
  } finally {
    await chmod(paths.sitesDir, 0o700);
  }

  assert.equal(result.sites.errors.length, 1);
  assert.equal(result.sites.errors[0].origin, 'https://shop.example');
  assert.equal(typeof result.sites.errors[0].error, 'string');
  assert.deepEqual(result.sites.origins, []);
  assert.equal(result.sites.edges, 0);
  assert.equal(result.sites.targets, 0);

  // Flows compile regardless -- a sites store fault never fails the flow
  // sweep.
  assert.deepEqual(result.compiled, [{ name: 'view-details', tier: 'ready' }]);
  assert.deepEqual(result.cursor, { 'trace-24000': { lines: 2, provenanceLines: 2 } });
});

test('a multi-origin session mines both origins into their own dirs, aggregated into one sites report', async (t) => {
  const paths = await tempPaths(t);
  await writeSession(paths, 25000, { meta: baseMeta(), records: multiOriginSiteRecords() });

  const result = await sweep({ paths });

  assert.deepEqual(
    result.sites.origins.slice().sort(),
    ['https://checkout.example', 'https://shop.example'],
  );
  assert.equal(result.sites.edges, 2); // one entry edge per origin
  assert.equal(result.sites.targets, 2); // one target per origin
  assert.deepEqual(result.sites.errors, []);

  const shopDir = path.join(paths.sitesDir, originDirName('https://shop.example'));
  const checkoutDir = path.join(paths.sitesDir, originDirName('https://checkout.example'));
  assert.equal((await stat(shopDir)).isDirectory(), true);
  assert.equal((await stat(checkoutDir)).isDirectory(), true);

  const shopGraph = await readSiteFile(paths, 'https://shop.example', 'graph.json');
  assert.equal(shopGraph.edges.length, 1);
  const checkoutGraph = await readSiteFile(paths, 'https://checkout.example', 'graph.json');
  assert.equal(checkoutGraph.edges.length, 1);

  const shopInventory = await readSiteFile(paths, 'https://shop.example', 'inventory.json');
  assert.equal(shopInventory.patterns['/cart'].targets[0].name, 'View details');
  const checkoutInventory = await readSiteFile(paths, 'https://checkout.example', 'inventory.json');
  assert.equal(checkoutInventory.patterns['/pay'].targets[0].name, 'Place order');
});

// --- fix round 1, Major F1: a navigating interaction attributes its target
// to the page it happened ON, never the page it navigated TO ---

test('a click that navigates cross-origin attributes its target to the SOURCE page\'s inventory, not the destination\'s; the destination still gets its (targetless) graph entry edge', async (t) => {
  const paths = await tempPaths(t);
  await writeSession(paths, 27000, {
    meta: baseMeta(),
    records: [
      record({
        seq: 1,
        tool: 'browser_navigate',
        params: { url: 'https://shop.example/cart' },
        urlBefore: 'about:blank',
        urlAfter: 'https://shop.example/cart',
      }),
      // The click happens ON shop.example/cart but navigates to
      // checkout.example/pay -- before this fix, this record was grouped
      // ONLY under checkout (urlAfter-first grouping), so
      // inventory.mjs's old urlBefore-usable-but-cross-origin fallback
      // keyed the target under checkout's /pay instead of shop's /cart.
      record({
        seq: 2,
        targets: [traceTarget({ name: 'Proceed to checkout' })],
        mutating: false,
        urlBefore: 'https://shop.example/cart',
        urlAfter: 'https://checkout.example/pay',
      }),
    ],
  });

  const result = await sweep({ paths });

  assert.deepEqual(result.sites.origins.slice().sort(), ['https://checkout.example', 'https://shop.example']);
  assert.equal(result.sites.edges, 2); // shop's entry nav + checkout's entry edge
  assert.equal(result.sites.targets, 1); // ONLY shop's -- checkout gets none from this record

  const shopInventory = await readSiteFile(paths, 'https://shop.example', 'inventory.json');
  assert.deepEqual(Object.keys(shopInventory.patterns), ['/cart']);
  assert.equal(shopInventory.patterns['/cart'].targets.length, 1);
  assert.equal(shopInventory.patterns['/cart'].targets[0].name, 'Proceed to checkout');

  // Checkout gets NO inventory entry from this record at all -- the record
  // never belongs there (it happened on shop.example, not checkout.example).
  const checkoutInventory = await readSiteFile(paths, 'https://checkout.example', 'inventory.json');
  assert.deepEqual(checkoutInventory.patterns, {});

  // The graph entry edge into checkout is unaffected by this fix and must
  // stay: `from: null` (urlBefore is usable but off-origin), `to: '/pay'`.
  const checkoutGraph = await readSiteFile(paths, 'https://checkout.example', 'graph.json');
  assert.equal(checkoutGraph.edges.length, 1);
  assert.equal(checkoutGraph.edges[0].from, null);
  assert.equal(checkoutGraph.edges[0].to, '/pay');
});

// --- fix round 1, F2: reported sites counts are the NEW-mined output for
// THIS sweep call, not the resulting on-disk totals -- a second session on
// an already-mined origin exercises the real merge path (count-increment,
// kinds-union), which only shows up on disk, not in the report ---

test('a second session on an already-mined origin reports the NEW-mined edges/targets, while on-disk totals grow further via count-increment and kinds-union', async (t) => {
  const paths = await tempPaths(t);
  await writeSession(paths, 28000, { meta: baseMeta(), records: siteMiningRecords() });
  const first = await sweep({ paths });
  assert.equal(first.sites.edges, 2);
  assert.equal(first.sites.targets, 1);

  await writeSession(paths, 28100, {
    meta: baseMeta(),
    records: [
      // A genuinely new route (`/product/:id` -> `/wishlist`): 1 new mined
      // edge, no dedup match against session 1's edges.
      record({
        seq: 1,
        tool: 'browser_navigate',
        params: { url: 'https://shop.example/wishlist' },
        urlBefore: 'https://shop.example/product/42',
        urlAfter: 'https://shop.example/wishlist',
      }),
      // Re-touches session 1's EXISTING '/cart' -> 'View details' target,
      // with a DIFFERENT locator kind -- this is what exercises
      // count-increment and kinds-union through the real merge, once
      // written to disk.
      record({
        seq: 2,
        targets: [{
          ref: 'e2',
          resolved: "getByTestId('view-details')",
          alternates: [{ kind: 'testid', selector: '[data-testid="view-details"]' }],
          role: 'button',
          name: 'View details',
          description: 'View details',
        }],
        mutating: false,
        urlBefore: 'https://shop.example/cart',
        urlAfter: 'https://shop.example/cart',
      }),
    ],
  });

  const second = await sweep({ paths });

  // Reported counts are session 2's OWN mined output only.
  assert.deepEqual(second.sites.origins, ['https://shop.example']);
  assert.equal(second.sites.edges, 1);
  assert.equal(second.sites.targets, 1);
  assert.equal(second.sites.evicted, 0);

  // On-disk totals reflect the accumulated merge across BOTH sessions --
  // strictly larger than what session 2 alone reported.
  const graph = await readSiteFile(paths, 'https://shop.example', 'graph.json');
  assert.equal(graph.edges.length, 3); // session 1's 2 + session 2's 1 new route

  const inventory = await readSiteFile(paths, 'https://shop.example', 'inventory.json');
  const cartTarget = inventory.patterns['/cart'].targets.find((t) => t.name === 'View details');
  assert.equal(cartTarget.count, 2); // incremented across the two sessions, not reset
  assert.deepEqual(cartTarget.kinds.slice().sort(), ['role', 'testid']); // unioned across sessions
});
