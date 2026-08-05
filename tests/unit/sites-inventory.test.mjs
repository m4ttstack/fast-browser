import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { readTraceRecords } from '../../lib/flows/trace-reader.mjs';
import { mergeInventory, mineInventory } from '../../lib/sites/inventory.mjs';

const fixturesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/traces',
);
const basicDir = path.join(fixturesDir, 'trace-1754350000000');

const ORIGIN = 'https://example.com';
const FIXED_NOW = () => new Date('2026-08-05T12:00:00.000Z');
const FIXED_NOW_ISO = '2026-08-05T12:00:00.000Z';

function baseRecord(overrides = {}) {
  return {
    v: 1,
    seq: 1,
    tool: 'browser_click',
    startedAt: '2026-08-05T00:00:00.000Z',
    endedAt: '2026-08-05T00:00:00.100Z',
    params: {},
    urlBefore: `${ORIGIN}/cart`,
    urlAfter: `${ORIGIN}/cart`,
    targets: [],
    network: [],
    mutating: false,
    waits: { settleMs: 0, awaitedNavigation: false, awaitedRequests: 0 },
    code: [],
    ...overrides,
  };
}

function enrichedTarget(overrides = {}) {
  return {
    ref: 'e5',
    resolved: "getByRole('button', { name: 'Buy' })",
    alternates: [{ kind: 'role', selector: 'internal:role=button[name="Buy"i]' }],
    role: 'button',
    name: 'Buy',
    description: 'Buy',
    ...overrides,
  };
}

// --- mineInventory: golden fixture ---

test('mineInventory lands the golden fixture\'s click and fill_form targets under /cart with kinds recorded', async () => {
  const { records } = await readTraceRecords(basicDir);
  const { patterns } = mineInventory(records, { origin: ORIGIN, now: FIXED_NOW });

  assert.deepEqual(Object.keys(patterns), ['/cart']);
  assert.deepEqual(patterns['/cart'], {
    targets: [
      {
        role: 'button', name: 'Place order', kinds: ['role', 'testid'], count: 1, lastSeenAt: FIXED_NOW_ISO,
      },
      {
        role: 'textbox', name: 'Email', kinds: ['role'], count: 1, lastSeenAt: FIXED_NOW_ISO,
      },
      {
        role: 'textbox', name: 'Card number', kinds: ['role'], count: 1, lastSeenAt: FIXED_NOW_ISO,
      },
    ],
    lastSeenAt: FIXED_NOW_ISO,
  });
});

// --- mineInventory: records with no enriched targets contribute nothing ---

test('mineInventory skips records whose targets are empty or unenriched (no role/name)', () => {
  const noTargets = baseRecord({ tool: 'browser_navigate', targets: [] });
  const degraded = baseRecord({
    targets: [{ ref: 'e99', resolved: "getByRole('button')", alternates: [] }],
  });

  const { patterns } = mineInventory([noTargets, degraded], { origin: ORIGIN, now: FIXED_NOW });
  assert.deepEqual(patterns, {});
});

// --- mineInventory: kinds unioned + count incremented across records ---

test('mineInventory unions locator kinds and increments count for the same role|name target across records', () => {
  const first = baseRecord({
    targets: [enrichedTarget({
      alternates: [{ kind: 'role', selector: 'internal:role=button[name="Buy"i]' }],
    })],
  });
  const second = baseRecord({
    targets: [enrichedTarget({
      ref: 'e6',
      alternates: [{ kind: 'testid', selector: 'internal:testid=[data-testid="buy"]' }],
    })],
  });

  const { patterns } = mineInventory([first, second], { origin: ORIGIN, now: FIXED_NOW });

  assert.deepEqual(patterns['/cart'].targets, [
    {
      role: 'button', name: 'Buy', kinds: ['role', 'testid'], count: 2, lastSeenAt: FIXED_NOW_ISO,
    },
  ]);
});

// --- mineInventory: truncated targets tolerated ---

test('mineInventory tolerates a targets array truncated down to a bare marker', () => {
  const record = baseRecord({
    targets: { __truncated__: true, omittedElements: 2, sizeBytes: 999 },
  });

  const { patterns } = mineInventory([record], { origin: ORIGIN, now: FIXED_NOW });
  assert.deepEqual(patterns, {});
});

test('mineInventory keeps a real target that survives truncation of a trailing marker', () => {
  const record = baseRecord({
    targets: [
      enrichedTarget(),
      { __truncated__: true, omittedElements: 1, sizeBytes: 50 },
    ],
  });

  const { patterns } = mineInventory([record], { origin: ORIGIN, now: FIXED_NOW });
  assert.deepEqual(patterns['/cart'].targets, [
    {
      role: 'button', name: 'Buy', kinds: ['role'], count: 1, lastSeenAt: FIXED_NOW_ISO,
    },
  ]);
});

test('mineInventory tolerates a target whose own alternates array is a bare truncation marker', () => {
  const record = baseRecord({
    targets: [enrichedTarget({ alternates: { __truncated__: true, sizeBytes: 10 } })],
  });

  const { patterns } = mineInventory([record], { origin: ORIGIN, now: FIXED_NOW });
  assert.deepEqual(patterns['/cart'].targets, [
    {
      role: 'button', name: 'Buy', kinds: [], count: 1, lastSeenAt: FIXED_NOW_ISO,
    },
  ]);
});

// --- mineInventory: replay exclusion ---

test('mineInventory excludes a replay record even though its targets look enriched', () => {
  const replay = baseRecord({
    tool: 'browser_run_code_unsafe',
    params: { filename: '/macros/flow-runner.js', args: { flow: { name: 'checkout' } } },
    targets: [enrichedTarget()],
  });

  const { patterns } = mineInventory([replay], { origin: ORIGIN, now: FIXED_NOW });
  assert.deepEqual(patterns, {});
});

test('mineInventory does not treat an ordinary run_code_unsafe call (non-flow-runner filename) as a replay', () => {
  const record = baseRecord({
    tool: 'browser_run_code_unsafe',
    params: { filename: '/macros/page-recon.js' },
    targets: [enrichedTarget()],
  });

  const { patterns } = mineInventory([record], { origin: ORIGIN, now: FIXED_NOW });
  assert.equal(patterns['/cart'].targets.length, 1);
});

// --- mineInventory: keying falls back from urlBefore to urlAfter ---

test('mineInventory keys off urlAfter when urlBefore is missing or unparseable', () => {
  const missingBefore = baseRecord({ urlBefore: undefined, urlAfter: `${ORIGIN}/checkout`, targets: [enrichedTarget()] });
  const unparseableBefore = baseRecord({ urlBefore: 'about:blank', urlAfter: `${ORIGIN}/checkout`, targets: [enrichedTarget()] });

  for (const record of [missingBefore, unparseableBefore]) {
    const { patterns } = mineInventory([record], { origin: ORIGIN, now: FIXED_NOW });
    assert.deepEqual(Object.keys(patterns), ['/checkout']);
  }
});

// --- mineInventory: fix round 1, Major F1 -- a usable-but-cross-origin
// urlBefore must NOT fall back to urlAfter (that would mis-file the
// interaction under the destination page rather than the page it actually
// happened on); the record contributes nothing to THIS origin at all. It
// belongs to its urlBefore's own origin group instead -- sweep.mjs's Task 4
// grouping (fix round 1) guarantees that group exists whenever urlBefore
// and urlAfter resolve to different origins. ---

test('mineInventory drops a record whose urlBefore is usable but cross-origin, rather than falling back to urlAfter', () => {
  const crossOriginBefore = baseRecord({
    urlBefore: 'https://other.example/landing', urlAfter: `${ORIGIN}/checkout`, targets: [enrichedTarget()],
  });

  const { patterns } = mineInventory([crossOriginBefore], { origin: ORIGIN, now: FIXED_NOW });
  assert.deepEqual(patterns, {});
});

// --- mineInventory: cross-origin keying URL drops the record ---

test('mineInventory drops a record whose keying URL (after fallback) is not on origin', () => {
  const bothOffOrigin = baseRecord({
    urlBefore: 'https://other.example/a',
    urlAfter: 'https://other.example/b',
    targets: [enrichedTarget()],
  });

  const { patterns } = mineInventory([bothOffOrigin], { origin: ORIGIN, now: FIXED_NOW });
  assert.deepEqual(patterns, {});
});

// --- mineInventory: never throws on hostile records ---

test('mineInventory never throws on hostile record shapes', () => {
  const hostileRecords = [
    null,
    42,
    'not a record',
    {},
    { urlBefore: `${ORIGIN}/cart`, urlAfter: `${ORIGIN}/cart`, targets: 'nope' },
    { urlBefore: `${ORIGIN}/cart`, urlAfter: `${ORIGIN}/cart`, targets: [{ role: 42, name: null }] },
  ];

  assert.doesNotThrow(() => mineInventory(hostileRecords, { origin: ORIGIN, now: FIXED_NOW }));
  const { patterns } = mineInventory(hostileRecords, { origin: ORIGIN, now: FIXED_NOW });
  assert.deepEqual(patterns, {});
});

// --- mergeInventory: dedup + increment on role|name match ---

test('mergeInventory dedups a mined target against an existing one, incrementing count, unioning kinds and refreshing lastSeenAt', () => {
  const existing = {
    schemaVersion: 1,
    patterns: {
      '/cart': {
        targets: [
          {
            role: 'button', name: 'Buy', kinds: ['role'], count: 2, lastSeenAt: '2026-08-01T00:00:00.000Z',
          },
        ],
        lastSeenAt: '2026-08-01T00:00:00.000Z',
      },
    },
  };
  const mined = {
    patterns: {
      '/cart': {
        targets: [
          {
            role: 'button', name: 'Buy', kinds: ['testid'], count: 1, lastSeenAt: FIXED_NOW_ISO,
          },
        ],
        lastSeenAt: FIXED_NOW_ISO,
      },
    },
  };

  const { inventory, evicted } = mergeInventory(existing, mined, { now: FIXED_NOW });

  assert.deepEqual(inventory, {
    schemaVersion: 1,
    patterns: {
      '/cart': {
        targets: [
          {
            role: 'button', name: 'Buy', kinds: ['role', 'testid'], count: 3, lastSeenAt: FIXED_NOW_ISO,
          },
        ],
        lastSeenAt: FIXED_NOW_ISO,
      },
    },
  });
  assert.equal(evicted, 0);
});

test('mergeInventory appends a brand new pattern alongside an existing one without touching it', () => {
  const existing = {
    schemaVersion: 1,
    patterns: {
      '/cart': {
        targets: [
          {
            role: 'button', name: 'Buy', kinds: ['role'], count: 2, lastSeenAt: '2026-08-01T00:00:00.000Z',
          },
        ],
        lastSeenAt: '2026-08-01T00:00:00.000Z',
      },
    },
  };
  const mined = {
    patterns: {
      '/checkout': {
        targets: [
          {
            role: 'button', name: 'Pay', kinds: ['role'], count: 1, lastSeenAt: FIXED_NOW_ISO,
          },
        ],
        lastSeenAt: FIXED_NOW_ISO,
      },
    },
  };

  const { inventory, evicted } = mergeInventory(existing, mined, { now: FIXED_NOW });

  assert.deepEqual(inventory.patterns['/cart'], existing.patterns['/cart']); // untouched
  assert.deepEqual(inventory.patterns['/checkout'], mined.patterns['/checkout']);
  assert.equal(evicted, 0);
});

test('mergeInventory starts from an empty inventory when existing is nullish', () => {
  const mined = {
    patterns: {
      '/cart': {
        targets: [
          {
            role: 'button', name: 'Buy', kinds: ['role'], count: 1, lastSeenAt: FIXED_NOW_ISO,
          },
        ],
        lastSeenAt: FIXED_NOW_ISO,
      },
    },
  };

  const { inventory, evicted } = mergeInventory(undefined, mined, { now: FIXED_NOW });
  assert.equal(inventory.schemaVersion, 1);
  assert.deepEqual(inventory.patterns, mined.patterns);
  assert.equal(evicted, 0);
});

// --- mergeInventory: mined output feeds merge directly (mine -> merge integration) ---

test('mineInventory output merges cleanly into an empty inventory', async () => {
  const { records } = await readTraceRecords(basicDir);
  const mined = mineInventory(records, { origin: ORIGIN, now: FIXED_NOW });

  const { inventory, evicted } = mergeInventory(undefined, mined, { now: FIXED_NOW });
  assert.equal(evicted, 0);
  assert.deepEqual(inventory.patterns['/cart'].targets.map((target) => target.name).sort(), [
    'Card number', 'Email', 'Place order',
  ]);
});

// --- mergeInventory: per-pattern target bound eviction ---

test('mergeInventory evicts the lowest-count target first within a pattern, oldest lastSeenAt breaking ties, and reports evicted', () => {
  const existing = {
    schemaVersion: 1,
    patterns: {
      '/cart': {
        targets: [
          {
            role: 'button', name: 'A', kinds: ['role'], count: 1, lastSeenAt: '2026-08-01T00:00:00.000Z',
          },
          {
            role: 'button', name: 'B', kinds: ['role'], count: 1, lastSeenAt: '2026-08-02T00:00:00.000Z',
          },
          {
            role: 'button', name: 'C', kinds: ['role'], count: 5, lastSeenAt: '2026-08-03T00:00:00.000Z',
          },
        ],
        lastSeenAt: '2026-08-03T00:00:00.000Z',
      },
    },
  };
  const mined = {
    patterns: {
      '/cart': {
        targets: [
          {
            role: 'button', name: 'D', kinds: ['role'], count: 1, lastSeenAt: FIXED_NOW_ISO,
          },
        ],
        lastSeenAt: FIXED_NOW_ISO,
      },
    },
  };

  const { inventory, evicted } = mergeInventory(existing, mined, {
    now: FIXED_NOW,
    bounds: { maxTargetsPerPattern: 3 },
  });

  // Four targets after merge, bound is 3: one eviction. A, B, D all tie at
  // count 1; A has the oldest lastSeenAt among the tied group, so A goes.
  assert.equal(evicted, 1);
  assert.equal(inventory.patterns['/cart'].targets.length, 3);
  assert.deepEqual(inventory.patterns['/cart'].targets.map((target) => target.name).sort(), ['B', 'C', 'D']);
});

test('mergeInventory defaults its per-pattern bound to the shared MAX_TARGETS_PER_PATTERN constant', async () => {
  const { MAX_TARGETS_PER_PATTERN } = await import('../../lib/sites/store.mjs');
  const existing = {
    schemaVersion: 1,
    patterns: {
      '/cart': {
        targets: Array.from({ length: MAX_TARGETS_PER_PATTERN }, (_, index) => ({
          role: 'button',
          name: `target-${index}`,
          kinds: ['role'],
          count: 1,
          lastSeenAt: '2026-08-01T00:00:00.000Z',
        })),
        lastSeenAt: '2026-08-01T00:00:00.000Z',
      },
    },
  };
  const mined = {
    patterns: {
      '/cart': {
        targets: [
          {
            role: 'button', name: 'one-more', kinds: ['role'], count: 1, lastSeenAt: FIXED_NOW_ISO,
          },
        ],
        lastSeenAt: FIXED_NOW_ISO,
      },
    },
  };

  const { inventory, evicted } = mergeInventory(existing, mined, { now: FIXED_NOW });
  assert.equal(evicted, 1);
  assert.equal(inventory.patterns['/cart'].targets.length, MAX_TARGETS_PER_PATTERN);
});

// --- mergeInventory: per-origin pattern bound eviction ---

test('mergeInventory evicts the lowest-weight pattern first (sum of its target counts), oldest lastSeenAt breaking ties', () => {
  function pattern(count, lastSeenAt) {
    return {
      targets: [{
        role: 'button', name: 'X', kinds: ['role'], count, lastSeenAt,
      }],
      lastSeenAt,
    };
  }

  const existing = {
    schemaVersion: 1,
    patterns: {
      '/a': pattern(1, '2026-08-01T00:00:00.000Z'),
      '/b': pattern(2, '2026-08-02T00:00:00.000Z'),
      '/c': pattern(5, '2026-08-03T00:00:00.000Z'),
    },
  };
  const mined = { patterns: { '/d': pattern(1, FIXED_NOW_ISO) } };

  const { inventory, evicted } = mergeInventory(existing, mined, {
    now: FIXED_NOW,
    bounds: { maxPatternsPerOrigin: 3 },
  });

  // Four patterns after merge, bound is 3: one eviction. /a and /d tie at
  // weight 1 (sum of target counts); /a has the older lastSeenAt, so /a
  // goes.
  assert.equal(evicted, 1);
  assert.deepEqual(Object.keys(inventory.patterns).sort(), ['/b', '/c', '/d']);
});

test('mergeInventory defaults its per-origin bound to the shared MAX_PATTERNS_PER_ORIGIN constant', async () => {
  const { MAX_PATTERNS_PER_ORIGIN } = await import('../../lib/sites/store.mjs');
  const existing = {
    schemaVersion: 1,
    patterns: Object.fromEntries(Array.from({ length: MAX_PATTERNS_PER_ORIGIN }, (_, index) => [
      `/route-${index}`,
      {
        targets: [{
          role: 'button', name: 'X', kinds: ['role'], count: 1, lastSeenAt: '2026-08-01T00:00:00.000Z',
        }],
        lastSeenAt: '2026-08-01T00:00:00.000Z',
      },
    ])),
  };
  const mined = {
    patterns: {
      '/one-more': {
        targets: [{
          role: 'button', name: 'X', kinds: ['role'], count: 1, lastSeenAt: FIXED_NOW_ISO,
        }],
        lastSeenAt: FIXED_NOW_ISO,
      },
    },
  };

  const { inventory, evicted } = mergeInventory(existing, mined, { now: FIXED_NOW });
  assert.equal(evicted, 1);
  assert.equal(Object.keys(inventory.patterns).length, MAX_PATTERNS_PER_ORIGIN);
});

// --- mergeInventory: never throws on hostile existing/mined shapes ---

test('mergeInventory never throws on hostile existing/mined shapes', () => {
  const hostileShapes = [
    [null, null],
    [42, 'nope'],
    [{ patterns: 'nope' }, { patterns: [] }],
    [{ patterns: { '/cart': { targets: 'nope' } } }, { patterns: { '/cart': { targets: [{ role: 1 }] } } }],
  ];

  for (const [existing, mined] of hostileShapes) {
    assert.doesNotThrow(() => mergeInventory(existing, mined, { now: FIXED_NOW }));
  }
});

// --- mergeInventory: "__proto__" pattern key guard ---

test('mergeInventory guards a "__proto__" pattern key in existing/mined instead of a prototype-pollution assignment', () => {
  // JSON.parse (unlike an object literal or bracket assignment) always
  // produces a genuine own key here -- the same shape a corrupted
  // inventory.json or a hostile `mined` object could deliver. Unlike
  // store.mjs's parseInventory (a strict on-disk-shape validator that
  // throws), this module's contract is never-throw-on-hostile-input, so
  // the fix here is to skip the hazardous key rather than reject the
  // whole call.
  const pollutedExisting = JSON.parse(
    '{"schemaVersion":1,"patterns":{"__proto__":{"targets":[{"role":"button","name":"Evil","kinds":[],"count":1,"lastSeenAt":"2026-08-01T00:00:00.000Z"}],"lastSeenAt":"2026-08-01T00:00:00.000Z"},"/cart":{"targets":[],"lastSeenAt":"2026-08-01T00:00:00.000Z"}}}',
  );
  const pollutedMined = JSON.parse(
    '{"patterns":{"__proto__":{"targets":[{"role":"button","name":"Evil","kinds":[],"count":1,"lastSeenAt":"2026-08-05T00:00:00.000Z"}],"lastSeenAt":"2026-08-05T00:00:00.000Z"}}}',
  );
  assert.deepEqual(Object.keys(pollutedExisting.patterns).sort(), ['/cart', '__proto__']);

  const { inventory } = mergeInventory(pollutedExisting, pollutedMined, { now: FIXED_NOW });

  assert.deepEqual(Object.keys(inventory.patterns), ['/cart']);
  assert.equal(Object.hasOwn(inventory.patterns, '__proto__'), false);

  // No global corruption as a side effect of the skipped key: a fresh
  // plain object still inherits the real Object.prototype.
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
});
