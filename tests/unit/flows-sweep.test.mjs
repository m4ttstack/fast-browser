import assert from 'node:assert/strict';
import {
  chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  flowId, parseFlow, serializeFlow,
} from '../../lib/flows/artifact.mjs';
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

// WS3b Task 2: the byte cursor a fully-caught-up sweep writes back is
// exactly the session's actions.jsonl current byte length (every fixture
// here writes complete, newline-terminated lines -- `jsonl()` above -- so
// there is never a trailing partial line to exclude). Reading the real
// file's size, rather than hand-computing/hardcoding it, keeps these
// assertions honest against whatever `record()`/`traceTarget()` actually
// serialize to.
async function sessionByteLength(paths, epochMs) {
  const { size } = await stat(path.join(paths.dataDir, `trace-${epochMs}`, 'actions.jsonl'));
  return size;
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
  const bytes1000 = await sessionByteLength(paths, 1000);
  assert.deepEqual(result.cursor, {
    'trace-1000': {
      lines: 4, provenanceLines: 4, bytes: bytes1000, provenanceBytes: bytes1000,
    },
  });

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
  const bytesAfterFirst = await sessionByteLength(paths, 3000);
  assert.deepEqual(first.cursor, {
    'trace-3000': {
      lines: 2, provenanceLines: 2, bytes: bytesAfterFirst, provenanceBytes: bytesAfterFirst,
    },
  });

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
  const bytesAfterSecond = await sessionByteLength(paths, 3000);
  assert.deepEqual(second.cursor, {
    'trace-3000': {
      lines: 4, provenanceLines: 4, bytes: bytesAfterSecond, provenanceBytes: bytesAfterSecond,
    },
  });

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
  const bytes4000 = await sessionByteLength(paths, 4000);
  assert.deepEqual(second.cursor, {
    'trace-4000': {
      lines: 3, provenanceLines: 3, bytes: bytes4000, provenanceBytes: bytes4000,
    },
  });

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
  const bytes8000 = await sessionByteLength(paths, 8000);
  assert.deepEqual(result.cursor, {
    'trace-8000': {
      lines: 2, provenanceLines: 2, bytes: bytes8000, provenanceBytes: bytes8000,
    },
  });

  const onDisk = await readState(paths);
  assert.deepEqual(onDisk, {
    schemaVersion: 1,
    processed: {
      'trace-8000': {
        lines: 2, provenanceLines: 2, bytes: bytes8000, provenanceBytes: bytes8000,
      },
    },
  });
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
  const bytes8100 = await sessionByteLength(paths, 8100);
  assert.deepEqual(result.cursor, {
    'trace-8100': {
      lines: 2, provenanceLines: 2, bytes: bytes8100, provenanceBytes: bytes8100,
    },
  });

  const onDisk = await readState(paths);
  assert.deepEqual(onDisk.processed, {
    'trace-8100': {
      lines: 2, provenanceLines: 2, bytes: bytes8100, provenanceBytes: bytes8100,
    },
  });
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
  // reached -- overwriting the (already-correct) new-shape entry. No
  // `bytes`/`provenanceBytes` at all -- the pre-WS3b-Task-2 shape.
  const state = await readState(paths);
  state.processed['trace-8200'] = { lines: 3 }; // no provenanceLines at all
  await writeFile(paths.flowsStateFile, JSON.stringify(state));

  // WS3b Task 2: with no byte cursor to resume from, this sweep falls back
  // to a full read from byte zero (exactly what every pre-Task-2 sweep
  // always did) and backfills a fresh, correct `bytes`/`provenanceBytes`
  // pair matching the session's actual current byte length -- never a
  // guess, and never something that skips/loses content.
  const second = await sweep({ paths });
  assert.deepEqual(second.compiled, []);
  assert.deepEqual(second.updated, []); // NOT re-applied -- provenanceLines defaulted to lines (3), already caught up
  const bytes8200 = await sessionByteLength(paths, 8200);
  assert.deepEqual(second.cursor, {
    'trace-8200': {
      lines: 3, provenanceLines: 3, bytes: bytes8200, provenanceBytes: bytes8200,
    },
  });

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

  const bytes9000 = await sessionByteLength(paths, 9000); // constant -- nothing appended in this test

  const first = await sweep({ paths, now: clock });
  assert.deepEqual(first.compiled, []); // deferred -- not yet complete
  assert.equal(first.sessionsProcessed, 0); // nothing substantive happened (no compile, no replay)
  // WS3b Task 2: `bytes` mirrors `lines` -- frozen at 0 while live, since
  // the compile cursor never advances (compilation deferred); only
  // `provenanceBytes` (mirroring `provenanceLines`) catches up.
  assert.deepEqual(first.cursor, {
    'trace-9000': {
      lines: 0, provenanceLines: 2, bytes: 0, provenanceBytes: bytes9000, incomplete: true,
    },
  });
  assert.deepEqual(await listFlowFiles(paths.flowsDir), []);
  assert.deepEqual(await listFlowFiles(paths.flowsPendingDir), []);

  // Still live, no new lines -- a genuine no-op, but re-checked every sweep.
  const second = await sweep({ paths, now: clock });
  assert.deepEqual(second.compiled, []);
  assert.equal(second.sessionsProcessed, 0);
  assert.deepEqual(second.cursor, {
    'trace-9000': {
      lines: 0, provenanceLines: 2, bytes: 0, provenanceBytes: bytes9000, incomplete: true,
    },
  });

  // The session ends -- meta gains endedAt, still zero new lines beyond
  // what was already scanned for provenance. The WHOLE coherent file
  // compiles in one shot now, never having been fragmented while live.
  await rewriteMeta(paths, 9000, baseMeta());
  const third = await sweep({ paths, now: clock });
  assert.deepEqual(third.compiled, [{ name: 'view-details', tier: 'ready' }]);
  assert.deepEqual(third.cursor, {
    'trace-9000': {
      lines: 2, provenanceLines: 2, bytes: bytes9000, provenanceBytes: bytes9000,
    },
  });

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

  const bytes13000 = await sessionByteLength(paths, 13000); // constant -- nothing appended in this test

  const result = await sweep({ paths });
  assert.equal(result.replaysSeen, 1);
  assert.equal(result.sessionsProcessed, 1); // only the live session did anything this round
  assert.deepEqual(result.updated, [{ name, successRuns: 1, failStreak: 0 }]);
  assert.deepEqual(result.compiled, []); // the live session itself compiles nothing
  assert.deepEqual(result.cursor['trace-13000'], {
    lines: 0, provenanceLines: 1, bytes: 0, provenanceBytes: bytes13000, incomplete: true,
  });

  const updatedOnDisk = await readFlow(paths.flowsDir, 'view-details.flow.json');
  assert.equal(updatedOnDisk.provenance.successRuns, 1);

  // The live session later completes with no new lines: it contributes
  // nothing further (the replay was already counted; there was nothing
  // else in it to compile).
  await rewriteMeta(paths, 13000, baseMeta());
  const after = await sweep({ paths });
  assert.deepEqual(after.compiled, []);
  assert.deepEqual(after.updated, []); // not re-applied
  assert.deepEqual(after.cursor['trace-13000'], {
    lines: 1, provenanceLines: 1, bytes: bytes13000, provenanceBytes: bytes13000,
  });
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
  const bytes11000 = await sessionByteLength(paths, 11000);
  const first = await sweep({ paths });
  assert.deepEqual(first.cursor, {
    'trace-11000': {
      lines: 2, provenanceLines: 2, bytes: bytes11000, provenanceBytes: bytes11000,
    },
  });

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
  const bytes14000 = await sessionByteLength(paths, 14000);
  assert.deepEqual(cursorBeforeFault, {
    lines: 3, provenanceLines: 3, bytes: bytes14000, provenanceBytes: bytes14000,
  });

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
  const bytes15000 = await sessionByteLength(paths, 15000);
  assert.deepEqual(cursorBeforeVanish, {
    lines: 3, provenanceLines: 3, bytes: bytes15000, provenanceBytes: bytes15000,
  });

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
  const bytes15000After4 = await sessionByteLength(paths, 15000);
  const fifth = await sweep({ paths });
  assert.deepEqual(fifth.updated, [{ name, successRuns: 1, failStreak: 1 }]);
  assert.deepEqual(fifth.cursor['trace-15000'], {
    lines: 4, provenanceLines: 4, bytes: bytes15000After4, provenanceBytes: bytes15000After4,
  });
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
  const bytes24000 = await sessionByteLength(paths, 24000);
  assert.deepEqual(result.cursor, {
    'trace-24000': {
      lines: 2, provenanceLines: 2, bytes: bytes24000, provenanceBytes: bytes24000,
    },
  });
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

// --- healing (WS3a flywheel plan, Task 6) ---
//
// Payloads are built to clear heal.mjs's acceptance rule trivially (a
// candidate whose role+name exactly matches the target's role+description
// scores 1.0: full token overlap plus the role-match bonus) or to miss it
// trivially (no token overlap, no role match, scoring 0) -- the scoring
// math itself is heal.mjs's own, already-tested contract; these tests only
// need ONE clearly-over and ONE clearly-under case, not the boundary.

function failurePayload(failedStep, candidates) {
  return `FLOW_RUNNER_FAILURE: ${JSON.stringify({ failedStep, candidates })}`;
}

test('a failed replay with a heal-worthy payload heals the artifact: alternate appended, id recomputed and matching content, lastHealed stamped, tier unchanged; report.healed is pinned', async (t) => {
  const paths = await tempPaths(t);
  const healClock = () => new Date('2026-03-01T00:00:00.000Z');
  await writeSession(paths, 30000, {
    meta: baseMeta(),
    records: [
      record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://shop.example/cart' } }),
      record({ seq: 2, targets: [traceTarget({ name: 'View details' })], mutating: false }),
    ],
  });
  const first = await sweep({ paths });
  const [{ name }] = first.compiled;
  const stored = await readFlow(paths.flowsDir, 'view-details.flow.json');
  assert.equal(stored.provenance.lastHealed, null);

  await appendRecords(paths, 30000, [
    record({
      seq: 3,
      tool: 'browser_run_code_unsafe',
      params: { filename: 'flow-runner.js', args: { flow: { id: stored.id, name } } },
      // Task 9 e2e finding (fix round): the real trace-capture runtime
      // records `record.error` as `String(error)` -- wrapped with the
      // thrown Error's own `name` ahead of this macro's message
      // ("Error: FLOW_RUNNER_FAILURE: {...}"), never the bare form
      // `failurePayload` alone produces. This, the primary heal
      // happy-path fixture, wraps it the same way so the unit layer can
      // never again silently regress to a position-0/unwrapped
      // assumption; the other heal fixtures below are left on the bare
      // form deliberately (parseFailurePayload's own unit tests are where
      // the wrapped-vs-bare distinction itself is exhaustively covered).
      error: `Error: ${failurePayload(1, [{
        role: 'button', name: 'View details', testid: 'vd-btn', text: 'View details',
      }])}`,
    }),
  ]);

  const second = await sweep({ paths, now: healClock });
  assert.equal(second.replaysSeen, 1);
  assert.deepEqual(second.updated, [{ name, successRuns: 0, failStreak: 1 }]);
  assert.deepEqual(second.healed, [{ name, stepIndex: 1, kind: 'testid' }]);
  assert.deepEqual(second.healErrors, []);

  const healedFlow = await readFlow(paths.flowsDir, 'view-details.flow.json');
  assert.notEqual(healedFlow.id, stored.id); // content changed -- id must too
  assert.equal(healedFlow.id, flowId(healedFlow)); // id always matches stored bytes
  assert.equal(healedFlow.provenance.lastHealed, '2026-03-01T00:00:00.000Z'); // the SWEEP's own clock
  assert.equal(healedFlow.provenance.failStreak, 1);
  assert.deepEqual(
    healedFlow.steps[1].target.locators,
    [
      ...stored.steps[1].target.locators,
      { kind: 'testid', selector: 'internal:testid=[data-testid="vd-btn"]' },
    ],
  ); // alternate appended LAST, original locator untouched
  assert.deepEqual(await listFlowFiles(paths.flowsDir), ['view-details.flow.json']); // tier unchanged
  assert.deepEqual(await listFlowFiles(paths.flowsPendingDir), []); // heal never moves tiers
});

test('a failed replay whose payload scores below the heal threshold leaves the artifact\'s steps/id untouched; failStreak still increments', async (t) => {
  const paths = await tempPaths(t);
  await writeSession(paths, 31000, {
    meta: baseMeta(),
    records: [
      record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://shop.example/cart' } }),
      record({ seq: 2, targets: [traceTarget({ name: 'View details' })], mutating: false }),
    ],
  });
  const first = await sweep({ paths });
  const [{ name }] = first.compiled;
  const stored = await readFlow(paths.flowsDir, 'view-details.flow.json');

  await appendRecords(paths, 31000, [
    record({
      seq: 3,
      tool: 'browser_run_code_unsafe',
      params: { filename: 'flow-runner.js', args: { flow: { id: stored.id, name } } },
      // No token overlap with the target's description/name ("View
      // details"), and a non-matching role -- clears neither
      // HEAL_MIN_SCORE nor the margin over the (nonexistent) runner-up.
      error: failurePayload(1, [{ role: 'link', name: 'Unrelated action', text: 'Unrelated action' }]),
    }),
  ]);

  const second = await sweep({ paths });
  assert.deepEqual(second.updated, [{ name, successRuns: 0, failStreak: 1 }]);
  assert.deepEqual(second.healed, []);
  assert.deepEqual(second.healErrors, []);

  const onDisk = await readFlow(paths.flowsDir, 'view-details.flow.json');
  assert.equal(onDisk.id, stored.id); // no content change -- no heal write beyond provenance
  assert.equal(onDisk.provenance.failStreak, 1);
  assert.equal(onDisk.provenance.lastHealed, null);
  assert.deepEqual(onDisk.steps, stored.steps);
});

test('healing is idempotent across a re-sweep: the cursor already consumed the replay, so nothing re-processes', async (t) => {
  const paths = await tempPaths(t);
  await writeSession(paths, 32000, {
    meta: baseMeta(),
    records: [
      record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://shop.example/cart' } }),
      record({ seq: 2, targets: [traceTarget({ name: 'View details' })], mutating: false }),
    ],
  });
  const first = await sweep({ paths });
  const [{ name }] = first.compiled;
  const stored = await readFlow(paths.flowsDir, 'view-details.flow.json');

  await appendRecords(paths, 32000, [
    record({
      seq: 3,
      tool: 'browser_run_code_unsafe',
      params: { filename: 'flow-runner.js', args: { flow: { id: stored.id, name } } },
      error: failurePayload(1, [{
        role: 'button', name: 'View details', testid: 'vd-btn', text: 'View details',
      }]),
    }),
  ]);

  const second = await sweep({ paths });
  assert.equal(second.healed.length, 1);
  const healedOnce = await readFlow(paths.flowsDir, 'view-details.flow.json');

  const third = await sweep({ paths });
  assert.deepEqual(third.healed, []);
  assert.deepEqual(third.updated, []);
  assert.deepEqual(third.cursor, second.cursor);

  const stillHealedOnce = await readFlow(paths.flowsDir, 'view-details.flow.json');
  assert.deepEqual(stillHealedOnce, healedOnce); // byte-identical -- not healed twice
});

test('a heal write failure is caught and reported in healErrors; the sweep still completes and the on-disk artifact is untouched', async (t) => {
  const paths = await tempPaths(t);
  await writeSession(paths, 33000, {
    meta: baseMeta(),
    records: [
      record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://shop.example/cart' } }),
      record({ seq: 2, targets: [traceTarget({ name: 'View details' })], mutating: false }),
    ],
  });
  const first = await sweep({ paths });
  const [{ name }] = first.compiled;
  const stored = await readFlow(paths.flowsDir, 'view-details.flow.json');

  await appendRecords(paths, 33000, [
    record({
      seq: 3,
      tool: 'browser_run_code_unsafe',
      params: { filename: 'flow-runner.js', args: { flow: { id: stored.id, name } } },
      error: failurePayload(1, [{
        role: 'button', name: 'View details', testid: 'vd-btn', text: 'View details',
      }]),
    }),
  ]);

  // Read+execute only: discovery (readdir/readFile) still works, but the
  // temp-file write a heal needs is blocked. Unlike the sites-store
  // sabotage pattern (which blocks `mkdir` of a not-yet-existing subdir),
  // this targets a directory the artifact is already known to live in, so
  // sabotaging it must survive `ensurePrivateDirectory`-style self-healing
  // to matter -- see sweep.mjs's `writeAtomicCore` doc comment for why the
  // replay-write path skips that step.
  await chmod(paths.flowsDir, 0o500);
  t.after(() => chmod(paths.flowsDir, 0o700).catch(() => {}));

  let result;
  try {
    result = await sweep({ paths });
  } finally {
    await chmod(paths.flowsDir, 0o700);
  }

  assert.deepEqual(result.healed, []);
  assert.equal(result.healErrors.length, 1);
  assert.equal(result.healErrors[0].name, name);
  assert.equal(typeof result.healErrors[0].error, 'string');
  assert.deepEqual(result.updated, []); // the write never landed -- no update recorded either
  // The cursor still advances -- as if the heal attempt had not run at all
  // (mirrors the sites-mining containment posture: "the cursor still
  // advances, exactly as if mining had not run at all for that origin").
  const bytes33000 = await sessionByteLength(paths, 33000);
  assert.deepEqual(result.cursor, {
    'trace-33000': {
      lines: 3, provenanceLines: 3, bytes: bytes33000, provenanceBytes: bytes33000,
    },
  });

  const onDisk = await readFlow(paths.flowsDir, 'view-details.flow.json');
  assert.equal(onDisk.id, stored.id);
  assert.equal(onDisk.provenance.failStreak, 0);
});

// --- MAT-137: replay records as segment boundaries ---

test('records A,B / replay / C,D compile into two segments, never one merged A-B-C-D flow', async (t) => {
  const paths = await tempPaths(t);
  await writeSession(paths, 34000, {
    meta: baseMeta(),
    records: [
      record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://shop.example/cart' } }), // A
      record({ seq: 2, targets: [traceTarget({ name: 'View details' })], mutating: false }), // B
      record({
        seq: 3,
        tool: 'browser_run_code_unsafe',
        params: { filename: 'flow-runner.js', args: { flow: { id: 'a'.repeat(64), name: 'ghost' } } },
      }), // replay boundary -- unmatched, its only effect here is the split
      record({ seq: 4, tool: 'browser_navigate', params: { url: 'https://shop.example/cart' } }), // C -- SAME origin
      record({ seq: 5, targets: [traceTarget({ name: 'Refresh' })], mutating: false }), // D
    ],
  });

  const result = await sweep({ paths });

  assert.equal(result.replaysSeen, 1);
  assert.deepEqual(
    result.compiled.slice().sort((a, b) => a.name.localeCompare(b.name)),
    [
      { name: 'refresh', tier: 'ready' },
      { name: 'view-details', tier: 'ready' },
    ],
  );

  // Each flow has ONLY its own 2 actions -- proof they compiled as two
  // separate segments, not one 4-step flow. Pre-fix, same origin and no
  // error record meant the old filter-then-merge behavior would have
  // stitched A,B,C,D into one segment (named after D's click, "refresh").
  const viewDetails = await readFlow(paths.flowsDir, 'view-details.flow.json');
  const refresh = await readFlow(paths.flowsDir, 'refresh.flow.json');
  assert.equal(viewDetails.steps.length, 2);
  assert.equal(refresh.steps.length, 2);
});

// --- BINDING (Task 5 review): both obligations must appear in tests, not
// just in the implementation ---

// WS3b Task 2 fold-in: this test used to pin WS3a's "skip, not misapplied"
// response to a stale-flowId gate failure. That response over-corrected --
// a stale `flow` reference only means the FIRST proposal was scored
// against outdated content, not that the second replay's failure evidence
// is unhealable. The fix re-proposes ONCE against the freshly-read
// `current` flow before giving up (sweep.mjs's `applyReplayRecords` doc
// comment, "WS3b Task 2 fold-in" note); here that retry legitimately heals
// a SECOND, different locator onto the SAME step, since record 4's
// candidate (`vd-btn-2`) is not what record 3 already healed in
// (`vd-btn-1`). The registry-supersession mechanics this test exercises
// (byId still resolving to the pre-heal entry, byName always current) are
// unchanged -- only the outcome of what happens once the gate fails is
// different, so this test still pins that machinery, just against its
// corrected result. See the two dedicated re-propose tests below for the
// "different step" and "idempotent skip" branches.
test('a replay naming a flow by an id from before an earlier heal in this same sweep resolves to a superseded registry entry: the second heal re-proposes against the freshly healed flow and heals a second locator', async (t) => {
  const paths = await tempPaths(t);
  await writeSession(paths, 35000, {
    meta: baseMeta(),
    records: [
      record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://shop.example/cart' } }),
      record({ seq: 2, targets: [traceTarget({ name: 'View details' })], mutating: false }),
    ],
  });
  const first = await sweep({ paths });
  const [{ name }] = first.compiled;
  const stored = await readFlow(paths.flowsDir, 'view-details.flow.json');

  // TWO failed replays in the SAME provenance slice, BOTH naming the flow
  // by `stored.id` -- the id from BEFORE either heal. The first heals
  // successfully (changing the on-disk id); `resolveReplayTarget`'s
  // id-first match (ruling c, unchanged) then resolves the SECOND record
  // straight back to the now-superseded `stored.id` registry entry --
  // exactly what happens when a caller replays the same flow twice from
  // one cached `{id, name}` reference without re-fetching in between.
  await appendRecords(paths, 35000, [
    record({
      seq: 3,
      tool: 'browser_run_code_unsafe',
      params: { filename: 'flow-runner.js', args: { flow: { id: stored.id, name } } },
      error: failurePayload(1, [{
        role: 'button', name: 'View details', testid: 'vd-btn-1', text: 'View details',
      }]),
    }),
    record({
      seq: 4,
      tool: 'browser_run_code_unsafe',
      params: { filename: 'flow-runner.js', args: { flow: { id: stored.id, name } } },
      error: failurePayload(1, [{
        role: 'button', name: 'View details', testid: 'vd-btn-2', text: 'View details',
      }]),
    }),
  ]);

  const result = await sweep({ paths });
  assert.equal(result.replaysSeen, 2);
  // BOTH heal: the second's stale-gate failure is re-proposed against the
  // freshly healed `current` flow, and `vd-btn-2` is a genuinely new
  // locator (not what record 3 already healed in), so it heals too.
  assert.equal(result.healed.length, 2);
  assert.equal(result.healed[0].name, name);
  assert.equal(result.healed[1].name, name);
  assert.deepEqual(result.healErrors, []);
  // Both failures still counted.
  assert.deepEqual(result.updated, [{ name, successRuns: 0, failStreak: 2 }]);

  const onDisk = await readFlow(paths.flowsDir, 'view-details.flow.json');
  // Both locators landed, in order -- record 2's write was based on the
  // FRESHEST known copy (resolved by name), never the stale `stored.id`
  // snapshot, so the first heal's locator was never lost or regressed.
  assert.equal(onDisk.steps[1].target.locators.length, 3);
  assert.equal(onDisk.steps[1].target.locators[1].selector, 'internal:testid=[data-testid="vd-btn-1"]');
  assert.equal(onDisk.steps[1].target.locators[2].selector, 'internal:testid=[data-testid="vd-btn-2"]');
  assert.equal(onDisk.provenance.failStreak, 2);
  assert.equal(onDisk.id, flowId(onDisk));
});

test('a drag step\'s replay failure never proposes a heal, even with a heal-worthy-looking payload: no healErrors entry, failStreak still increments normally', async (t) => {
  const paths = await tempPaths(t);
  await writeSession(paths, 36000, {
    meta: baseMeta(),
    records: [
      record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://shop.example/board' } }),
      record({
        seq: 2,
        tool: 'browser_drag',
        targets: [traceTarget({ name: 'Card' }), traceTarget({ name: 'Column' })],
        mutating: true,
      }),
    ],
  });
  const first = await sweep({ paths });
  const [{ name }] = first.compiled;
  const stored = await readFlow(paths.flowsPendingDir, `${name}.flow.json`);
  assert.equal(stored.steps[1].op, 'drag');

  await appendRecords(paths, 36000, [
    record({
      seq: 3,
      tool: 'browser_run_code_unsafe',
      params: { filename: 'flow-runner.js', args: { flow: { id: stored.id, name } } },
      error: failurePayload(1, [{ role: 'button', name: 'Card', testid: 'card-1', text: 'Card' }]),
    }),
  ]);

  const result = await sweep({ paths });
  assert.deepEqual(result.healed, []);
  assert.deepEqual(result.healErrors, []);
  assert.deepEqual(result.updated, [{ name, successRuns: 0, failStreak: 1 }]);

  const onDisk = await readFlow(paths.flowsPendingDir, `${name}.flow.json`);
  assert.equal(onDisk.id, stored.id); // untouched -- proposeHeal never even returns a decision
  assert.deepEqual(onDisk.steps, stored.steps);
  assert.equal(onDisk.provenance.failStreak, 1);
});

// --- fix review round 1: a name shared by both tiers must never let a
// replay resolved-by-id to the PENDING artifact adopt the READY artifact's
// content as "fresher" ---

// Builds a full, schema-valid flow object (not derived from a compile --
// this test needs two DIFFERENT artifacts sharing one NAME, which the
// sweep's own dedup-on-compile logic (ruling a) never produces on its own;
// this simulates the same name existing in both tiers by some other means
// -- manual placement, external tooling -- exactly the shape
// `loadArtifactRegistry`'s first-key-wins scan has to tolerate).
function rawFlow(overrides = {}) {
  const base = {
    schemaVersion: 1,
    name: 'view-details',
    description: 'On https://shop.example, this flow clicks "Buy now".',
    origin: 'https://shop.example',
    urlPattern: '/checkout',
    sideEffects: 'mutating',
    args: {},
    result: { kind: 'completion', keys: [] },
    steps: [
      { op: 'goto', url: '/checkout' },
      {
        op: 'click',
        target: {
          locators: [{ kind: 'role', selector: 'internal:role=button[name="Buy now"i]' }],
          description: 'Buy now',
          role: 'button',
          name: 'Buy now',
        },
        mutating: true,
      },
    ],
    provenance: {
      compiledAt: '2026-01-01T00:00:00.000Z',
      traceDir: 'trace-manual',
      seqRange: [0, 0],
      productVersion: '0.1.0-test',
      successRuns: 0,
      failStreak: 0,
      lastHealed: null,
    },
    ...overrides,
  };
  return parseFlow({ ...base, id: flowId(base) });
}

test('a name shared by both tiers: a replay resolved by id to the PENDING artifact heals the PENDING file, never adopts or overwrites the READY artifact sharing its name', async (t) => {
  const paths = await tempPaths(t);

  // The READY artifact, compiled normally -- lands in flowsDir, name
  // 'view-details'.
  await writeSession(paths, 37000, {
    meta: baseMeta(),
    records: [
      record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://shop.example/cart' } }),
      record({ seq: 2, targets: [traceTarget({ name: 'View details' })], mutating: false }),
    ],
  });
  const first = await sweep({ paths });
  assert.deepEqual(first.compiled, [{ name: 'view-details', tier: 'ready' }]);
  const readyBefore = await readFlow(paths.flowsDir, 'view-details.flow.json');

  // A SEPARATE, genuinely different-content PENDING artifact that happens
  // to share the SAME name -- placed directly, bypassing the sweep's own
  // dedup entirely (this state can't arise from `sweep()` alone).
  await mkdir(paths.flowsPendingDir, { recursive: true });
  const pendingBefore = rawFlow();
  assert.notEqual(pendingBefore.id, readyBefore.id); // genuinely different content
  await writeFile(
    path.join(paths.flowsPendingDir, 'view-details.flow.json'),
    serializeFlow(pendingBefore),
  );

  // A failed replay naming the PENDING artifact by ID -- `loadArtifactRegistry`
  // scans flowsDir first, so `registry.byName.get('view-details')` only
  // ever remembers the READY one; resolving by id must still land on the
  // PENDING artifact (ruling c, unchanged), and healing it must never pull
  // in the READY artifact's content just because the names collide.
  await writeSession(paths, 38000, {
    meta: baseMeta(),
    records: [
      record({
        seq: 1,
        tool: 'browser_run_code_unsafe',
        params: { filename: 'flow-runner.js', args: { flow: { id: pendingBefore.id, name: 'view-details' } } },
        error: failurePayload(1, [{
          role: 'button', name: 'Buy now', testid: 'buy-now-btn', text: 'Buy now',
        }]),
      }),
    ],
  });

  const result = await sweep({ paths });
  assert.equal(result.healed.length, 1);
  assert.equal(result.healed[0].stepIndex, 1);
  assert.deepEqual(result.healErrors, []);

  // The PENDING file got the healed PENDING content.
  const pendingAfter = await readFlow(paths.flowsPendingDir, 'view-details.flow.json');
  assert.notEqual(pendingAfter.id, pendingBefore.id); // content changed -- id recomputed
  assert.equal(pendingAfter.id, flowId(pendingAfter));
  assert.equal(pendingAfter.origin, pendingBefore.origin); // PENDING content, not READY's
  assert.equal(pendingAfter.steps[1].target.locators.length, 2);
  assert.equal(
    pendingAfter.steps[1].target.locators[1].selector,
    'internal:testid=[data-testid="buy-now-btn"]',
  );
  assert.equal(pendingAfter.provenance.failStreak, 1);

  // The READY file with the same NAME is completely untouched.
  const readyAfter = await readFlow(paths.flowsDir, 'view-details.flow.json');
  assert.deepEqual(readyAfter, readyBefore);

  // byId still resolves the PENDING id to the PENDING path -- a follow-up
  // successful replay against the (now healed) pending id updates the
  // PENDING file only, never the ready one.
  await writeSession(paths, 39000, {
    meta: baseMeta(),
    records: [
      record({
        seq: 1,
        tool: 'browser_run_code_unsafe',
        params: { filename: 'flow-runner.js', args: { flow: { id: pendingAfter.id, name: 'view-details' } } },
      }),
    ],
  });
  const followUp = await sweep({ paths });
  // A success resets failStreak to 0 (unrelated to this fix -- ordinary
  // replay-provenance semantics, unchanged).
  assert.deepEqual(followUp.updated, [{ name: 'view-details', successRuns: 1, failStreak: 0 }]);

  const pendingFinal = await readFlow(paths.flowsPendingDir, 'view-details.flow.json');
  assert.equal(pendingFinal.provenance.successRuns, 1);
  const readyFinal = await readFlow(paths.flowsDir, 'view-details.flow.json');
  assert.deepEqual(readyFinal, readyBefore); // still fully untouched
});

// --- WS3b Task 2: byte cursors ---

// Observation mechanism (pinned here, per the task brief): a `JSON.parse`
// counting wrapper. `node:fs/promises`'s named exports are frozen ESM
// namespace bindings (cannot be monkey-patched from a test), and
// `node:test`'s `mock.module` needs `--experimental-test-module-mocks`,
// which this repo's `npm test`/`npm run test:unit` scripts don't pass and
// which doesn't exist at all on Node 20 (this repo's stated floor) --
// neither is available here. `JSON.parse` is a plain, writable global
// property, unaffected by either constraint, and every trace line
// sweep.mjs's byte-cursor path might re-parse goes through it exactly once
// per line (trace-reader.mjs's `readTraceRecordsFrom`). Each fixture
// record embeds a unique marker string (via its `params.url`/target
// `name`, themselves plain fields JSON.stringify/JSON.parse round-trips
// verbatim) so the wrapper can attribute each parse call to the specific
// line it came from, filtering out incidental JSON.parse calls elsewhere
// in the sweep pipeline (the state file, existing flow artifacts) whose
// content never contains these markers -- with ONE exception the fixture
// below deliberately avoids: a marker placed in a field compile.mjs COPIES
// into the compiled flow (a target's `name`, a goto's url) would ALSO show
// up when `loadArtifactRegistry` re-reads that flow file at the START of
// sweep 2 (an unrelated, expected read on every sweep, not the trace-line
// re-parse this test is pinning) -- so each marker instead rides a
// dedicated `_testMarker` field on the record itself, a key
// `readTraceRecordsFrom` happily preserves (unknown fields on an
// otherwise-valid v1 record are never stripped) but `compileSession` never
// reads or copies anywhere.
test('a second sweep over an append-only session parses only the appended lines: a JSON.parse counting wrapper shows the already-consumed lines are never re-parsed', async (t) => {
  const paths = await tempPaths(t);
  const OLD_MARKER = 'ws3b-task2-old-marker-19f2';
  const NEW_MARKER = 'ws3b-task2-new-marker-7ac4';
  await writeSession(paths, 50000, {
    meta: baseMeta(),
    records: [
      record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://shop.example/cart' }, _testMarker: OLD_MARKER }),
      record({
        seq: 2, targets: [traceTarget({ name: 'View details' })], mutating: false, _testMarker: OLD_MARKER,
      }),
    ],
  });

  const originalParse = JSON.parse;
  let parsedTexts = [];
  JSON.parse = (text, ...rest) => {
    if (typeof text === 'string') parsedTexts.push(text);
    return originalParse(text, ...rest);
  };
  t.after(() => { JSON.parse = originalParse; });

  const first = await sweep({ paths });
  assert.equal(first.compiled.length, 1);
  // Sanity on the harness itself: sweep 1 (a fresh session, no byte cursor
  // yet) genuinely parsed the old lines at least once.
  assert.ok(parsedTexts.some((text) => text.includes(OLD_MARKER)));

  await appendRecords(paths, 50000, [
    record({
      seq: 3, tool: 'browser_navigate', params: { url: 'https://other.example/checkout' }, _testMarker: NEW_MARKER,
    }),
    record({
      seq: 4, targets: [traceTarget({ name: 'Buy now' })], mutating: true, _testMarker: NEW_MARKER,
    }),
  ]);

  parsedTexts = []; // only interested in what sweep 2 itself parses
  const second = await sweep({ paths });
  assert.equal(second.compiled.length, 1); // the newly appended segment compiles

  const oldMarkerReparses = parsedTexts.filter((text) => text.includes(OLD_MARKER));
  const newMarkerParses = parsedTexts.filter((text) => text.includes(NEW_MARKER));
  // The byte-cursor optimization: sweep 2 never hands the already-consumed
  // lines back to JSON.parse at all.
  assert.deepEqual(oldMarkerReparses, []);
  // Each of the two genuinely new lines is parsed exactly once.
  assert.equal(newMarkerParses.length, 2);
});

test('a corrupted byte cursor (bytes greater than the file\'s actual size) falls back to a full read and loses nothing', async (t) => {
  const paths = await tempPaths(t);
  await writeSession(paths, 51000, {
    meta: baseMeta(),
    records: [
      record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://shop.example/cart' } }),
      record({ seq: 2, targets: [traceTarget({ name: 'View details' })], mutating: false }),
    ],
  });
  const first = await sweep({ paths });
  assert.deepEqual(first.compiled, [{ name: 'view-details', tier: 'ready' }]);

  // Hand-corrupt the byte cursor to a value well past the file's actual
  // size -- e.g. a stale value left over from a since-truncated/replaced
  // file. Trusting it would resume `readTraceRecordsFrom` past EOF, which
  // silently reports "nothing new" (`Buffer#indexOf` past the buffer's
  // length just returns -1) and would permanently lose the record appended
  // below.
  const state = await readState(paths);
  state.processed['trace-51000'].bytes = 999999;
  state.processed['trace-51000'].provenanceBytes = 999999;
  await writeFile(paths.flowsStateFile, JSON.stringify(state));

  await appendRecords(paths, 51000, [
    record({ seq: 3, tool: 'browser_navigate', params: { url: 'https://shop.example/other' } }),
    record({ seq: 4, targets: [traceTarget({ name: 'Buy now' })], mutating: true }),
  ]);

  const second = await sweep({ paths });
  assert.deepEqual(second.compiled, [{ name: 'buy-now', tier: 'pending' }]);
  const bytes51000 = await sessionByteLength(paths, 51000);
  assert.deepEqual(second.cursor, {
    'trace-51000': {
      lines: 4, provenanceLines: 4, bytes: bytes51000, provenanceBytes: bytes51000,
    },
  });
});

// Reviewer-reproduced regression (review round 1, Critical): an old-format
// entry (no bytes/provenanceBytes at all) that then hits a sweep with no
// trustworthy byte value to report -- here, `actions.jsonl` vanishing --
// used to get `bytes: 0`/`provenanceBytes: 0` written back alongside its
// real, nonzero `lines`/`provenanceLines`. That poisoned pair still passed
// `byteCursorsSane` (which only checks `bytes <= provenanceBytes`, never
// bytes-against-lines), so the NEXT sweep -- the file restored, byte-
// identical to before -- resumed from byte 0 while still treating the
// result as a from-`previousLines` delta: every already-counted record got
// read and counted again (`lines` inflating past its true total, a
// replay's `successRuns` incrementing a second time). The fix
// (`resolveNextByteCursor`) omits the byte key entirely when there is
// nothing trustworthy to write, which correctly fails `byteCursorsSane`
// next time and forces a full read that backfills cleanly once the session
// actually has new content to report.
test('an old-format entry whose actions.jsonl vanishes then is restored byte-identically does not inflate lines or double-count a replay (review round 1 regression)', async (t) => {
  const paths = await tempPaths(t);
  const sessionRecords = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://shop.example/cart' } }),
    record({ seq: 2, targets: [traceTarget({ name: 'View details' })], mutating: false }),
    record({
      seq: 3,
      tool: 'browser_run_code_unsafe',
      params: { filename: 'flow-runner.js', args: { flow: { name: 'view-details' } } },
    }),
  ];
  await writeSession(paths, 55000, { meta: baseMeta(), records: sessionRecords });

  const setup = await sweep({ paths }); // compiles the flow + applies the one replay
  assert.deepEqual(setup.updated, [{ name: 'view-details', successRuns: 1, failStreak: 0 }]);

  // Downgrade the just-written new-format entry to the OLD (pre-Task-2)
  // shape -- no bytes/provenanceBytes at all -- simulating state carried
  // forward from before this optimization existed.
  const state = await readState(paths);
  state.processed['trace-55000'] = { lines: 3, provenanceLines: 3 };
  await writeFile(paths.flowsStateFile, JSON.stringify(state));

  // The file vanishes (dir stays put) -- the sweep that observes this has
  // no new content and no prior byte value to carry forward.
  await unlink(path.join(paths.dataDir, 'trace-55000', 'actions.jsonl'));
  const vanished = await sweep({ paths });
  assert.deepEqual(vanished.updated, []); // nothing new -- not yet the bug's trigger point
  assert.deepEqual(vanished.cursor['trace-55000'], { lines: 3, provenanceLines: 3 }); // still old-shaped: no poisoned bytes

  // Restored with EXACTLY its prior content (byte-identical) -- the bug's
  // trigger: a buggy `bytes: 0` cursor would resume from byte zero here and
  // treat all 3 already-counted records as new.
  await writeFile(
    path.join(paths.dataDir, 'trace-55000', 'actions.jsonl'),
    jsonl(sessionRecords),
  );
  const restored = await sweep({ paths });
  assert.deepEqual(restored.compiled, []); // no fresh compile duplicate
  assert.deepEqual(restored.updated, []); // NOT re-applied -- the successful replay is not re-counted
  // NOT inflated to 6 -- the byte-identical restore reads as a genuine
  // full-file re-parse whose 3 records were already fully accounted for
  // (the safe fallback path was taken throughout; no byte cursor was ever
  // trusted for this session). `bytes`/`provenanceBytes` are correctly
  // backfilled this time, since this read's own total (3) finally matches
  // both line cursors.
  const bytes55000 = await sessionByteLength(paths, 55000);
  assert.deepEqual(restored.cursor['trace-55000'], {
    lines: 3, provenanceLines: 3, bytes: bytes55000, provenanceBytes: bytes55000,
  });

  const onDisk = await readFlow(paths.flowsDir, 'view-details.flow.json');
  assert.equal(onDisk.provenance.successRuns, 1); // still just the one real application
});

// --- WS3b Task 2: single-pass site mining ---

test('mining runs ONCE per session over the concatenated completed-segment records: a target on both sides of a mid-session replay boundary is counted once, matching WS2b single-pass semantics (WS3a per-chunk mining double-counted it)', async (t) => {
  const paths = await tempPaths(t);
  await writeSession(paths, 52000, {
    meta: baseMeta(),
    records: [
      ...siteMiningRecords(), // seq 1 (nav -> /cart), seq 2 (click 'View details', /cart -> /product/42)
      record({
        seq: 3,
        tool: 'browser_run_code_unsafe',
        params: { filename: 'flow-runner.js', args: { flow: { id: 'a'.repeat(64), name: 'ghost' } } },
      }), // replay boundary -- unmatched, its only effect here is the segment split
      // The SAME origin/target content again, on the OTHER side of the
      // replay -- a session that legitimately touches the same route twice.
      record({
        seq: 4,
        tool: 'browser_navigate',
        params: { url: 'https://shop.example/cart' },
        urlBefore: 'about:blank',
        urlAfter: 'https://shop.example/cart',
      }),
      record({
        seq: 5,
        targets: [traceTarget({ name: 'View details' })],
        mutating: false,
        urlBefore: 'https://shop.example/cart',
        urlAfter: 'https://shop.example/product/42',
      }),
    ],
  });

  const result = await sweep({ paths });

  assert.equal(result.replaysSeen, 1);
  assert.deepEqual(result.sites.origins, ['https://shop.example']);
  // `mineInventory` dedupes duplicate (pattern, role, name) targets WITHIN
  // one call -- the discriminating metric here (`mineGraphEdges` never
  // dedupes its own per-record output either way, so `sites.edges` is the
  // same total under both per-chunk and single-pass mining and would not
  // have caught the WS3a regression). Two per-chunk `mineSiteMemory` calls
  // would report `targets: 2` (one fresh Map per chunk, no memory of the
  // other); a single call over the concatenated segments reports 1.
  assert.equal(result.sites.targets, 1);

  const inventory = await readSiteFile(paths, 'https://shop.example', 'inventory.json');
  // Both real occurrences are still counted -- merged into ONE store
  // write, not lost.
  assert.equal(inventory.patterns['/cart'].targets[0].count, 2);
});

// --- WS3b Task 2: stale-flow second-heal re-propose ---

test('two heal-worthy failures for the same flow in one sweep, for DIFFERENT steps: the first heals, the second (naming the flow by its now-stale pre-heal id) re-proposes against the freshly healed flow and heals the other step', async (t) => {
  const paths = await tempPaths(t);
  await writeSession(paths, 53000, {
    meta: baseMeta(),
    records: [
      record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://shop.example/cart' } }),
      record({ seq: 2, targets: [traceTarget({ name: 'View details' })], mutating: false }),
      record({ seq: 3, targets: [traceTarget({ name: 'Buy now' })], mutating: true }),
    ],
  });
  const first = await sweep({ paths });
  const [{ name, tier }] = first.compiled;
  const dir = tier === 'pending' ? paths.flowsPendingDir : paths.flowsDir;
  const stored = await readFlow(dir, `${name}.flow.json`);
  assert.equal(stored.steps.length, 3); // goto + 2 clicks
  assert.equal(stored.steps[1].target.name, 'View details');
  assert.equal(stored.steps[2].target.name, 'Buy now');

  // TWO failed replays in the SAME provenance slice, both naming the flow
  // by `stored.id` (the pre-either-heal id) -- the first heals step 1
  // ("View details"); `resolveReplayTarget`'s id-first match then resolves
  // the SECOND record straight back to the now-superseded registry entry
  // (same setup as the id-supersession test above), but THIS record's
  // payload targets a DIFFERENT step (2, "Buy now") -- the re-propose
  // fold-in re-tries it against the freshly healed `current` flow, and it
  // heals cleanly since nothing about step 2 was touched by the first heal.
  await appendRecords(paths, 53000, [
    record({
      seq: 4,
      tool: 'browser_run_code_unsafe',
      params: { filename: 'flow-runner.js', args: { flow: { id: stored.id, name } } },
      error: failurePayload(1, [{
        role: 'button', name: 'View details', testid: 'vd-btn', text: 'View details',
      }]),
    }),
    record({
      seq: 5,
      tool: 'browser_run_code_unsafe',
      params: { filename: 'flow-runner.js', args: { flow: { id: stored.id, name } } },
      error: failurePayload(2, [{
        role: 'button', name: 'Buy now', testid: 'buy-btn', text: 'Buy now',
      }]),
    }),
  ]);

  const result = await sweep({ paths });
  assert.equal(result.replaysSeen, 2);
  // BOTH heal -- one per step, neither discarded by the stale-id gate.
  assert.equal(result.healed.length, 2);
  assert.deepEqual(result.healed.map((h) => h.stepIndex).sort(), [1, 2]);
  assert.deepEqual(result.healErrors, []);
  assert.deepEqual(result.updated, [{ name, successRuns: 0, failStreak: 2 }]);

  const healedFlow = await readFlow(dir, `${name}.flow.json`);
  assert.equal(healedFlow.steps[1].target.locators.length, 2);
  assert.equal(healedFlow.steps[1].target.locators[1].selector, 'internal:testid=[data-testid="vd-btn"]');
  assert.equal(healedFlow.steps[2].target.locators.length, 2);
  assert.equal(healedFlow.steps[2].target.locators[1].selector, 'internal:testid=[data-testid="buy-btn"]');
  assert.equal(healedFlow.id, flowId(healedFlow));
});

// Note: this test passes against BOTH the pre-fix (WS3a "skip on gate
// failure") and post-fix (re-propose once) implementations -- the two only
// diverge in OBSERVABLE outcome when the re-proposal legitimately finds
// new heal-worthy content (see the two tests above); here it doesn't
// (`proposeHeal`'s own idempotence check returns null either way), so
// "skip" and "re-propose then get null" produce the identical result. Kept
// per the brief's "pin both branches" instruction -- it still verifies the
// required behavior, just isn't independent RED/GREEN evidence for the
// fold-in the way the other two re-propose tests are.
test('two heal-worthy failures for the same flow, same step, same winning candidate: the first heals, the second re-proposes against the healed flow and skips idempotently (no error, no double heal)', async (t) => {
  const paths = await tempPaths(t);
  await writeSession(paths, 54000, {
    meta: baseMeta(),
    records: [
      record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://shop.example/cart' } }),
      record({ seq: 2, targets: [traceTarget({ name: 'View details' })], mutating: false }),
    ],
  });
  const first = await sweep({ paths });
  const [{ name }] = first.compiled;
  const stored = await readFlow(paths.flowsDir, 'view-details.flow.json');

  // TWO failed replays, both naming the flow by its pre-heal id, both
  // carrying the EXACT SAME winning candidate (testid `vd-btn-1`). The
  // first heals normally. The second's proposal (against the stale `flow`)
  // fails the flowId gate and is re-proposed against `current` -- but
  // `current` already has `vd-btn-1` from the first heal, so
  // `proposeHeal`'s own idempotence check (the synthesized locator is
  // already present) returns null: not an error, just no second heal.
  await appendRecords(paths, 54000, [
    record({
      seq: 3,
      tool: 'browser_run_code_unsafe',
      params: { filename: 'flow-runner.js', args: { flow: { id: stored.id, name } } },
      error: failurePayload(1, [{
        role: 'button', name: 'View details', testid: 'vd-btn-1', text: 'View details',
      }]),
    }),
    record({
      seq: 4,
      tool: 'browser_run_code_unsafe',
      params: { filename: 'flow-runner.js', args: { flow: { id: stored.id, name } } },
      error: failurePayload(1, [{
        role: 'button', name: 'View details', testid: 'vd-btn-1', text: 'View details',
      }]),
    }),
  ]);

  const result = await sweep({ paths });
  assert.equal(result.replaysSeen, 2);
  // Only the FIRST heals -- the second's re-propose is an idempotent no-op.
  assert.equal(result.healed.length, 1);
  assert.deepEqual(result.healErrors, []);
  // Both failures still counted -- an idempotent skip is not an error.
  assert.deepEqual(result.updated, [{ name, successRuns: 0, failStreak: 2 }]);

  const onDisk = await readFlow(paths.flowsDir, 'view-details.flow.json');
  assert.equal(onDisk.steps[1].target.locators.length, 2); // not 3 -- no double heal
  assert.equal(onDisk.steps[1].target.locators[1].selector, 'internal:testid=[data-testid="vd-btn-1"]');
  assert.equal(onDisk.provenance.failStreak, 2);
});
