import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { readTraceRecords } from '../../lib/flows/trace-reader.mjs';
import { mergeGraph, mineGraphEdges } from '../../lib/sites/graph.mjs';

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
    urlAfter: `${ORIGIN}/orders/789`,
    targets: [],
    network: [],
    mutating: false,
    waits: { settleMs: 0, awaitedNavigation: false, awaitedRequests: 0 },
    code: [],
    ...overrides,
  };
}

// --- mineGraphEdges: golden fixture ---

test('mineGraphEdges yields an entry edge (from: null) for the golden navigate record', async () => {
  const { records } = await readTraceRecords(basicDir);
  const { edges, skippedRecords } = mineGraphEdges(records, { origin: ORIGIN, now: FIXED_NOW });

  // Only the navigate record (about:blank -> /cart) has urlBefore !==
  // urlAfter; every other record in the fixture stays on /cart, so it
  // produces zero edges of its own -- and is NOT counted as skipped,
  // since "nothing navigated" is not one of the two skip reasons.
  assert.deepEqual(edges, [
    {
      from: null,
      to: '/cart',
      action: { tool: 'browser_navigate' },
      count: 1,
      lastSeenAt: FIXED_NOW_ISO,
    },
  ]);
  assert.equal(skippedRecords, 0);
});

// --- mineGraphEdges: synthetic cross-page click with targetName + :id ---

test('mineGraphEdges maps a same-origin click to a normalized edge with targetName', () => {
  const record = baseRecord({
    tool: 'browser_click',
    params: { ref: 'e5' },
    urlBefore: `${ORIGIN}/cart`,
    urlAfter: `${ORIGIN}/orders/789`,
    targets: [{
      ref: 'e5',
      resolved: "getByRole('button', { name: 'Place order' })",
      alternates: [{ kind: 'role', selector: 'internal:role=button[name="Place order"i]' }],
      role: 'button',
      name: 'Place order',
      description: 'Place order',
    }],
  });

  const { edges, skippedRecords } = mineGraphEdges([record], { origin: ORIGIN, now: FIXED_NOW });

  assert.deepEqual(edges, [
    {
      from: '/cart',
      to: '/orders/:id',
      action: { tool: 'browser_click', targetName: 'Place order' },
      count: 1,
      lastSeenAt: FIXED_NOW_ISO,
    },
  ]);
  assert.equal(skippedRecords, 0);
});

// --- graph mining includes tools the flow compiler skips ---

test('mineGraphEdges mines browser_navigate_back even though the compiler treats it as unsupported', () => {
  const record = baseRecord({
    tool: 'browser_navigate_back',
    params: {},
    urlBefore: `${ORIGIN}/orders/789`,
    urlAfter: `${ORIGIN}/cart`,
    targets: [],
  });

  const { edges } = mineGraphEdges([record], { origin: ORIGIN, now: FIXED_NOW });

  assert.deepEqual(edges, [
    {
      from: '/orders/:id',
      to: '/cart',
      action: { tool: 'browser_navigate_back' },
      count: 1,
      lastSeenAt: FIXED_NOW_ISO,
    },
  ]);
});

// --- replay exclusion ---

test('mineGraphEdges excludes a replay record and counts it as skipped', () => {
  const replay = baseRecord({
    tool: 'browser_run_code_unsafe',
    params: { filename: '/macros/flow-runner.js', args: { flow: { name: 'checkout' } } },
    urlBefore: `${ORIGIN}/cart`,
    urlAfter: `${ORIGIN}/orders/789`,
  });

  const { edges, skippedRecords } = mineGraphEdges([replay], { origin: ORIGIN, now: FIXED_NOW });

  assert.deepEqual(edges, []);
  assert.equal(skippedRecords, 1);
});

test('mineGraphEdges does not treat an ordinary run_code_unsafe call (non-flow-runner filename) as a replay', () => {
  const record = baseRecord({
    tool: 'browser_run_code_unsafe',
    params: { filename: '/macros/page-recon.js' },
    urlBefore: `${ORIGIN}/cart`,
    urlAfter: `${ORIGIN}/orders/789`,
  });

  const { edges, skippedRecords } = mineGraphEdges([record], { origin: ORIGIN, now: FIXED_NOW });

  assert.equal(edges.length, 1);
  assert.equal(skippedRecords, 0);
});

// --- cross-origin urlAfter dropped, not counted as skipped ---

test('mineGraphEdges drops a cross-origin urlAfter without counting it as skipped', () => {
  const record = baseRecord({
    urlBefore: `${ORIGIN}/cart`,
    urlAfter: 'https://checkout.example/pay',
  });

  const { edges, skippedRecords } = mineGraphEdges([record], { origin: ORIGIN, now: FIXED_NOW });

  assert.deepEqual(edges, []);
  assert.equal(skippedRecords, 0);
});

// --- unusable urlAfter: missing or unparseable ---

test('mineGraphEdges counts a missing urlAfter as skipped', () => {
  const record = baseRecord({ urlBefore: `${ORIGIN}/cart`, urlAfter: undefined });
  const { edges, skippedRecords } = mineGraphEdges([record], { origin: ORIGIN, now: FIXED_NOW });
  assert.deepEqual(edges, []);
  assert.equal(skippedRecords, 1);
});

test('mineGraphEdges counts an unparseable urlAfter as skipped', () => {
  const record = baseRecord({ urlBefore: `${ORIGIN}/cart`, urlAfter: 'about:blank' });
  const { edges, skippedRecords } = mineGraphEdges([record], { origin: ORIGIN, now: FIXED_NOW });
  assert.deepEqual(edges, []);
  assert.equal(skippedRecords, 1);
});

// --- from: null when urlBefore is off-origin/unparseable but urlAfter is usable ---

test('mineGraphEdges treats an off-origin or unparseable urlBefore as an entry edge (from: null)', () => {
  const fromOtherOrigin = baseRecord({
    tool: 'browser_navigate',
    urlBefore: 'https://other.example/landing',
    urlAfter: `${ORIGIN}/cart`,
  });
  const fromBlank = baseRecord({
    tool: 'browser_navigate',
    urlBefore: 'about:blank',
    urlAfter: `${ORIGIN}/cart`,
  });

  for (const record of [fromOtherOrigin, fromBlank]) {
    const { edges } = mineGraphEdges([record], { origin: ORIGIN, now: FIXED_NOW });
    assert.equal(edges[0].from, null);
    assert.equal(edges[0].to, '/cart');
  }
});

// --- hostile targets: truncation marker survives via cleanArray ---

test('mineGraphEdges tolerates a targets array truncated down to a bare marker', () => {
  const record = baseRecord({
    targets: [{ __truncated__: true, omittedElements: 1, sizeBytes: 999 }],
  });

  const { edges } = mineGraphEdges([record], { origin: ORIGIN, now: FIXED_NOW });

  assert.equal(edges.length, 1);
  assert.equal(Object.hasOwn(edges[0].action, 'targetName'), false);
});

// --- never throws on hostile records ---

test('mineGraphEdges never throws on hostile record shapes', () => {
  const hostileRecords = [
    null,
    42,
    'not a record',
    {},
    { tool: 42, urlBefore: `${ORIGIN}/cart`, urlAfter: `${ORIGIN}/orders/1` },
    { tool: 'browser_click', urlBefore: `${ORIGIN}/cart`, urlAfter: `${ORIGIN}/orders/1`, targets: 'nope' },
  ];

  assert.doesNotThrow(() => mineGraphEdges(hostileRecords, { origin: ORIGIN, now: FIXED_NOW }));
  const { skippedRecords } = mineGraphEdges(hostileRecords, { origin: ORIGIN, now: FIXED_NOW });
  // null, 42, 'not a record', {} (unusable urlAfter), and the non-string
  // `tool` record are all skipped; the final record (`targets: 'nope'`,
  // cleanArray-tolerated down to no targetName) is a real edge.
  assert.equal(skippedRecords, 5);
});

// --- mergeGraph: dedup + increment ---

test('mergeGraph dedups a new edge against an existing one, incrementing count and refreshing lastSeenAt', () => {
  const existing = {
    schemaVersion: 1,
    edges: [
      {
        from: null, to: '/cart', action: { tool: 'browser_navigate' }, count: 2, lastSeenAt: '2026-08-01T00:00:00.000Z',
      },
    ],
  };
  const newEdges = [
    {
      from: null, to: '/cart', action: { tool: 'browser_navigate' }, count: 1, lastSeenAt: '2026-08-04T00:00:00.000Z',
    },
  ];

  const { graph, evicted } = mergeGraph(existing, newEdges, { now: FIXED_NOW });

  assert.deepEqual(graph, {
    schemaVersion: 1,
    edges: [
      {
        from: null, to: '/cart', action: { tool: 'browser_navigate' }, count: 3, lastSeenAt: FIXED_NOW_ISO,
      },
    ],
  });
  assert.equal(evicted, 0);
});

test('mergeGraph appends a brand new edge alongside existing edges without touching them', () => {
  const existing = {
    schemaVersion: 1,
    edges: [
      {
        from: null, to: '/cart', action: { tool: 'browser_navigate' }, count: 2, lastSeenAt: '2026-08-01T00:00:00.000Z',
      },
    ],
  };
  const newEdges = [
    {
      from: '/cart', to: '/orders/:id', action: { tool: 'browser_click', targetName: 'Place order' }, count: 1, lastSeenAt: '2026-08-04T00:00:00.000Z',
    },
  ];

  const { graph, evicted } = mergeGraph(existing, newEdges, { now: FIXED_NOW });

  assert.equal(graph.edges.length, 2);
  assert.deepEqual(graph.edges[0], existing.edges[0]); // untouched
  assert.deepEqual(graph.edges[1], newEdges[0]); // added as given, own lastSeenAt kept
  assert.equal(evicted, 0);
});

test('mergeGraph treats the same targetName vs no targetName as distinct dedup keys', () => {
  const existing = {
    schemaVersion: 1,
    edges: [
      {
        from: '/cart', to: '/orders/:id', action: { tool: 'browser_click' }, count: 1, lastSeenAt: '2026-08-01T00:00:00.000Z',
      },
    ],
  };
  const newEdges = [
    {
      from: '/cart', to: '/orders/:id', action: { tool: 'browser_click', targetName: 'Place order' }, count: 1, lastSeenAt: '2026-08-04T00:00:00.000Z',
    },
  ];

  const { graph } = mergeGraph(existing, newEdges, { now: FIXED_NOW });
  assert.equal(graph.edges.length, 2);
});

test('mergeGraph starts from an empty graph when existing is nullish', () => {
  const newEdges = [
    {
      from: null, to: '/cart', action: { tool: 'browser_navigate' }, count: 1, lastSeenAt: '2026-08-04T00:00:00.000Z',
    },
  ];
  const { graph, evicted } = mergeGraph(undefined, newEdges, { now: FIXED_NOW });
  assert.equal(graph.schemaVersion, 1);
  assert.deepEqual(graph.edges, newEdges);
  assert.equal(evicted, 0);
});

// --- mergeGraph: dedup within the same newEdges batch ---

test('mergeGraph collapses duplicate edges within the same newEdges batch', () => {
  const newEdges = [
    {
      from: '/cart', to: '/orders/:id', action: { tool: 'browser_click', targetName: 'Place order' }, count: 1, lastSeenAt: '2026-08-04T00:00:00.000Z',
    },
    {
      from: '/cart', to: '/orders/:id', action: { tool: 'browser_click', targetName: 'Place order' }, count: 1, lastSeenAt: '2026-08-04T00:00:01.000Z',
    },
  ];

  const { graph } = mergeGraph(null, newEdges, { now: FIXED_NOW });

  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].count, 2);
  assert.equal(graph.edges[0].lastSeenAt, FIXED_NOW_ISO);
});

// --- mergeGraph: eviction ---

test('mergeGraph evicts the lowest-count edge first, oldest lastSeenAt breaking ties, and reports evicted', () => {
  const existing = {
    schemaVersion: 1,
    edges: [
      {
        from: null, to: '/a', action: { tool: 'browser_navigate' }, count: 1, lastSeenAt: '2026-08-01T00:00:00.000Z',
      },
      {
        from: null, to: '/b', action: { tool: 'browser_navigate' }, count: 1, lastSeenAt: '2026-08-02T00:00:00.000Z',
      },
      {
        from: null, to: '/c', action: { tool: 'browser_navigate' }, count: 5, lastSeenAt: '2026-08-03T00:00:00.000Z',
      },
    ],
  };
  const newEdges = [
    {
      from: null, to: '/d', action: { tool: 'browser_navigate' }, count: 1, lastSeenAt: '2026-08-04T00:00:00.000Z',
    },
  ];

  const { graph, evicted } = mergeGraph(existing, newEdges, {
    now: FIXED_NOW,
    bounds: { maxEdgesPerOrigin: 3 },
  });

  // Four edges after merge, bound is 3: one eviction. /a, /b, /d all tie at
  // count 1; /a has the oldest lastSeenAt among the tied group, so /a goes.
  assert.equal(evicted, 1);
  assert.equal(graph.edges.length, 3);
  assert.deepEqual(graph.edges.map((edge) => edge.to).sort(), ['/b', '/c', '/d']);
});

test('mergeGraph evicts more than one edge and keeps counting when far over bound', () => {
  const existing = {
    schemaVersion: 1,
    edges: [
      {
        from: null, to: '/a', action: { tool: 'browser_navigate' }, count: 1, lastSeenAt: '2026-08-01T00:00:00.000Z',
      },
      {
        from: null, to: '/b', action: { tool: 'browser_navigate' }, count: 2, lastSeenAt: '2026-08-02T00:00:00.000Z',
      },
      {
        from: null, to: '/c', action: { tool: 'browser_navigate' }, count: 3, lastSeenAt: '2026-08-03T00:00:00.000Z',
      },
    ],
  };

  const { graph, evicted } = mergeGraph(existing, [], {
    now: FIXED_NOW,
    bounds: { maxEdgesPerOrigin: 1 },
  });

  assert.equal(evicted, 2);
  assert.deepEqual(graph.edges.map((edge) => edge.to), ['/c']);
});

test('mergeGraph defaults its bound to the shared MAX_EDGES_PER_ORIGIN constant', async () => {
  const { MAX_EDGES_PER_ORIGIN } = await import('../../lib/sites/store.mjs');
  const existing = {
    schemaVersion: 1,
    edges: Array.from({ length: MAX_EDGES_PER_ORIGIN }, (_, index) => ({
      from: null,
      to: `/route-${index}`,
      action: { tool: 'browser_navigate' },
      count: 1,
      lastSeenAt: '2026-08-01T00:00:00.000Z',
    })),
  };
  const newEdges = [
    {
      from: null, to: '/one-more', action: { tool: 'browser_navigate' }, count: 1, lastSeenAt: '2026-08-04T00:00:00.000Z',
    },
  ];

  const { graph, evicted } = mergeGraph(existing, newEdges, { now: FIXED_NOW });
  assert.equal(evicted, 1);
  assert.equal(graph.edges.length, MAX_EDGES_PER_ORIGIN);
});
