// Parameterized store parity suite (WS4b Task 4). Every test body here
// was written once, against memory-store, in Task 1's
// registry/tests/memory-store.test.mjs -- this file is that same suite
// lifted behind a store factory so registry/tests/pg-store.test.mjs can
// run it verbatim against Postgres too, proving the two implementations
// agree rather than merely both compiling.
//
// registerStoreSuite(label, createFreshStore, { skip }) registers one
// node:test per assertion, named `${label}: ...`, each passed the SAME
// `{ skip }` option (a falsy value runs the test; a string names why it
// is skipped) -- the repo's established gating convention (see
// tests/e2e/*.test.mjs's FAST_BROWSER_RELEASE_DIR-gated tests). When
// skipped, node:test never calls the test function body, so
// `createFreshStore` is never invoked either -- pg-store.test.mjs can
// safely reference `process.env.REGISTRY_TEST_DATABASE_URL` inside it
// even when that variable is unset.
//
// `createFreshStore()` must return a ready-to-use, EMPTY store on every
// call, mirroring what `createMemoryStore()` + `store.init()` gives Task
// 1's suite for free (a brand new Map every call) -- for pg-store, the
// caller's factory is responsible for truncating the backing table before
// returning (see pg-store.test.mjs).
//
// NOT included here: the "throws loudly on a dimension-mismatched
// embedding" test. memory-store checks dimension pairwise, per
// comparison, so two records with different-length embeddings can both
// exist at once and the mismatch only surfaces at search time between a
// particular query and a particular stored record. pg-store's embedding
// column is a fixed vector(1024): a wrong-width embedding is rejected at
// putCanonical/insert time, structurally, before it could ever be stored
// to begin with. Same guarantee (never truncate, always fail loudly),
// different failure shape -- each store's own test file carries the
// version of this test that matches its real failure mode (see
// memory-store.test.mjs and pg-store.test.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';

import { makeRecord, sha256Hex, unitEmbedding } from './records.mjs';
import { opSequence } from '../../lib/signature-fields.mjs';
import { parseFlow } from '../../../lib/flows/artifact.mjs';
import { baseFlow } from './fixtures.mjs';

export function registerStoreSuite(label, createFreshStore, { skip = false } = {}) {
  test(`${label}: putCanonical stores a record and get retrieves it by id`, { skip }, async () => {
    const store = await createFreshStore();
    const record = makeRecord();

    const stored = await store.putCanonical(record);
    assert.equal(stored.id, record.id);

    const fetched = await store.get(record.id);
    assert.deepEqual(fetched.content, record.content);
    assert.equal(fetched.contentHash, record.contentHash);
  });

  test(`${label}: get returns null for an unknown id`, { skip }, async () => {
    const store = await createFreshStore();
    assert.equal(await store.get('f'.repeat(64)), null);
  });

  test(`${label}: putCanonical upserts by id: a second put with the same id replaces the record`, { skip }, async () => {
    const store = await createFreshStore();
    const record = makeRecord({ idSeed: 'same-id' });
    await store.putCanonical(record);

    const updated = { ...record, mergedCount: 1, updatedAt: '2026-08-02T00:00:00.000Z' };
    await store.putCanonical(updated);

    const fetched = await store.get(record.id);
    assert.equal(fetched.mergedCount, 1);
    assert.equal(fetched.updatedAt, '2026-08-02T00:00:00.000Z');

    const all = await store.list({});
    assert.equal(all.length, 1, 'upsert must not create a duplicate entry');
  });

  test(`${label}: putCanonical returns and stores a defensive copy, not a live reference`, { skip }, async () => {
    const store = await createFreshStore();
    const record = makeRecord({ idSeed: 'defensive' });
    const stored = await store.putCanonical(record);

    stored.mergedCount = 999;
    stored.content.name = 'mutated-after-store';

    const fetched = await store.get(record.id);
    assert.equal(fetched.mergedCount, 0);
    assert.equal(fetched.content.name, record.content.name);
  });

  test(`${label}: findByContentHash looks up by content hash and returns null when absent`, { skip }, async () => {
    const store = await createFreshStore();
    const record = makeRecord({ idSeed: 'by-hash' });
    await store.putCanonical(record);

    const found = await store.findByContentHash(record.contentHash);
    assert.equal(found.id, record.id);

    assert.equal(await store.findByContentHash('0'.repeat(64)), null);
  });

  test(`${label}: list filters by origin`, { skip }, async () => {
    const store = await createFreshStore();
    const a = makeRecord({
      idSeed: 'origin-a',
      flowOverrides: { origin: 'http://a.example', name: 'flow-a' },
    });
    const b = makeRecord({
      idSeed: 'origin-b',
      flowOverrides: { origin: 'http://b.example', name: 'flow-b' },
    });
    await store.putCanonical(a);
    await store.putCanonical(b);

    const onlyA = await store.list({ origin: 'http://a.example' });
    assert.deepEqual(onlyA.map((r) => r.id), [a.id]);
  });

  test(`${label}: list filters by since (updatedAt) inclusively and sorts ascending`, { skip }, async () => {
    const store = await createFreshStore();
    const early = makeRecord({
      idSeed: 'early',
      flowOverrides: { name: 'flow-early' },
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    });
    const middle = makeRecord({
      idSeed: 'middle',
      flowOverrides: { name: 'flow-middle' },
      createdAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
    });
    const late = makeRecord({
      idSeed: 'late',
      flowOverrides: { name: 'flow-late' },
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    });
    await store.putCanonical(late);
    await store.putCanonical(early);
    await store.putCanonical(middle);

    const since = await store.list({ since: '2026-08-02T00:00:00.000Z' });
    assert.deepEqual(since.map((r) => r.id), [middle.id, late.id]);

    const all = await store.list({});
    assert.deepEqual(all.map((r) => r.id), [early.id, middle.id, late.id]);
  });

  // WS4b Task 6 ledger finding (carried forward from Task 4): ORDER BY
  // updated_at with no tie-break is nondeterministic across store
  // implementations -- pg's heap-scan order vs. memory-store's insertion
  // order need not agree, and GET /v1/pull's result order must be
  // store-independent. Records are inserted in the REVERSE of
  // id-ascending order specifically so a passing result cannot be
  // mistaken for "insertion order happened to match" luck.
  test(`${label}: list ties on updatedAt are broken deterministically by id ascending, independent of insertion order`, { skip }, async () => {
    const store = await createFreshStore();
    const tiedAt = '2026-08-04T00:00:00.000Z';
    const records = ['tie-a', 'tie-b', 'tie-c'].map((idSeed) => makeRecord({
      idSeed,
      flowOverrides: { name: `flow-${idSeed}` },
      createdAt: tiedAt,
      updatedAt: tiedAt,
    }));
    const expectedIds = records.map((record) => record.id).slice().sort((a, b) => a.localeCompare(b));
    const insertOrder = records.slice().sort((a, b) => b.id.localeCompare(a.id));
    for (const record of insertOrder) {
      await store.putCanonical(record);
    }

    const listed = await store.list({});
    assert.deepEqual(listed.map((r) => r.id), expectedIds);
  });

  test(`${label}: findClusterCandidates prefilters by origin and opSequence exactly`, { skip }, async () => {
    const store = await createFreshStore();
    const flowA = parseFlow(baseFlow({ name: 'flow-a', origin: 'http://a.example' }));

    const match = makeRecord({ idSeed: 'match', flowOverrides: { name: 'flow-a', origin: 'http://a.example' } });
    const wrongOrigin = makeRecord({
      idSeed: 'wrong-origin',
      flowOverrides: { name: 'flow-b', origin: 'http://b.example' },
    });
    // Same origin as `match`, but a deliberately different opSequence value
    // -- the store trusts the caller-computed field rather than
    // recomputing it from `content`, so this isolates the store's own
    // filter logic from signature-fields.mjs (covered separately in
    // signature-fields.test.mjs).
    const wrongOps = makeRecord({
      idSeed: 'wrong-ops',
      opSequence: 'goto,hover',
      flowOverrides: { name: 'flow-c', origin: 'http://a.example' },
    });
    await store.putCanonical(match);
    await store.putCanonical(wrongOrigin);
    await store.putCanonical(wrongOps);

    const candidates = await store.findClusterCandidates({
      origin: 'http://a.example',
      opSequence: opSequence(flowA),
    });
    assert.deepEqual(candidates.map((r) => r.id), [match.id]);
  });

  test(`${label}: health reports ok and the current record count`, { skip }, async () => {
    const store = await createFreshStore();
    assert.deepEqual(await store.health(), { ok: true, count: 0 });
    await store.putCanonical(makeRecord({ idSeed: 'health-1' }));
    assert.deepEqual(await store.health(), { ok: true, count: 1 });
  });

  test(`${label}: search: semantic mode ranks by cosine similarity over stored embeddings, descending`, { skip }, async () => {
    const store = await createFreshStore();
    const close = makeRecord({
      idSeed: 'close',
      flowOverrides: { name: 'flow-close' },
      embedding: unitEmbedding(0),
    });
    const far = makeRecord({
      idSeed: 'far',
      flowOverrides: { name: 'flow-far' },
      embedding: unitEmbedding(1),
    });
    const opposite = makeRecord({
      idSeed: 'opposite',
      flowOverrides: { name: 'flow-opposite' },
      embedding: unitEmbedding(0, { sign: -1 }),
    });
    await store.putCanonical(far);
    await store.putCanonical(opposite);
    await store.putCanonical(close);

    const result = await store.search({ embedding: unitEmbedding(0), intentText: 'place an order' });
    assert.equal(result.mode, 'semantic');
    assert.deepEqual(result.results.map((r) => r.record.id), [close.id, far.id, opposite.id]);
    assert.ok(result.results[0].score > result.results[1].score);
    assert.equal(Math.round(result.results[0].score * 1000) / 1000, 1);
  });

  test(`${label}: search: semantic mode skips records with no stored embedding`, { skip }, async () => {
    const store = await createFreshStore();
    const embedded = makeRecord({ idSeed: 'embedded', flowOverrides: { name: 'flow-embedded' }, embedding: unitEmbedding(0) });
    const unembedded = makeRecord({ idSeed: 'unembedded', flowOverrides: { name: 'flow-unembedded' } });
    await store.putCanonical(embedded);
    await store.putCanonical(unembedded);

    const result = await store.search({ embedding: unitEmbedding(0), intentText: 'x' });
    assert.deepEqual(result.results.map((r) => r.record.id), [embedded.id]);
  });

  test(`${label}: search: semantic mode filters by origin`, { skip }, async () => {
    const store = await createFreshStore();
    const a = makeRecord({
      idSeed: 'origin-search-a',
      flowOverrides: { name: 'flow-search-a', origin: 'http://a.example' },
      embedding: unitEmbedding(0),
    });
    const b = makeRecord({
      idSeed: 'origin-search-b',
      flowOverrides: { name: 'flow-search-b', origin: 'http://b.example' },
      embedding: unitEmbedding(0),
    });
    await store.putCanonical(a);
    await store.putCanonical(b);

    const result = await store.search({ embedding: unitEmbedding(0), intentText: 'x', origin: 'http://a.example' });
    assert.deepEqual(result.results.map((r) => r.record.id), [a.id]);
  });

  test(`${label}: search: lexical mode scores by substring overlap over name and description when no embedding is given`, { skip }, async () => {
    const store = await createFreshStore();
    const strong = makeRecord({
      idSeed: 'lex-strong',
      flowOverrides: {
        name: 'place-order',
        description: 'Fill the order form and place an order at checkout',
      },
    });
    const weak = makeRecord({
      idSeed: 'lex-weak',
      flowOverrides: { name: 'log-in', description: 'Sign into the account with a password' },
    });
    const none = makeRecord({
      idSeed: 'lex-none',
      flowOverrides: { name: 'export-report', description: 'Download a CSV report of activity' },
    });
    await store.putCanonical(weak);
    await store.putCanonical(none);
    await store.putCanonical(strong);

    const result = await store.search({ intentText: 'place an order at checkout' });
    assert.equal(result.mode, 'lexical');
    assert.deepEqual(result.results.map((r) => r.record.id), [strong.id]);
  });

  test(`${label}: search: lexical mode returns the top 5 by descending score`, { skip }, async () => {
    const store = await createFreshStore();
    const records = Array.from({ length: 7 }, (_, i) => makeRecord({
      idSeed: `lex-many-${i}`,
      flowOverrides: {
        name: `checkout-flow-${i}`,
        description: i < 6 ? 'checkout order flow number' : 'unrelated flow with no overlap words',
      },
    }));
    await Promise.all(records.map((record) => store.putCanonical(record)));

    const result = await store.search({ intentText: 'checkout order flow' });
    assert.equal(result.results.length, 5);
    for (let i = 1; i < result.results.length; i += 1) {
      assert.ok(result.results[i - 1].score >= result.results[i].score);
    }
  });

  // Fix round 1, finding 2 (IMPORTANT, Task 4 review, verified live): a
  // query term containing a literal backslash exercises pg-store's ILIKE
  // escaping (registry/lib/pg-store.mjs's likeEscape). Before that fix,
  // an unescaped '\' in the pattern was consumed as LIKE's own escape
  // character, so `%c:\temp%` actually searched for "c:temp" (no
  // backslash) -- silently missing a row containing "c:\temp" that
  // memory-store's plain haystack.includes(term) correctly scores a full
  // match on. Confirmed directly against a real Postgres container (both
  // via psql and via this exact parameterized-query shape) before and
  // after the fix: 0 rows unescaped, 1 row escaped.
  test(`${label}: search: lexical mode matches a query term containing a literal backslash character`, { skip }, async () => {
    const store = await createFreshStore();
    const record = makeRecord({
      idSeed: 'lex-backslash',
      flowOverrides: {
        name: 'configure-path',
        description: 'Configure the path C:\\Temp for exports',
      },
    });
    await store.putCanonical(record);

    const result = await store.search({ intentText: 'C:\\Temp' });
    assert.equal(result.mode, 'lexical');
    assert.deepEqual(result.results.map((r) => r.record.id), [record.id]);
    assert.equal(result.results[0].score, 1);
  });

  test(`${label}: search: an empty store returns empty results in either mode`, { skip }, async () => {
    const store = await createFreshStore();
    assert.deepEqual(await store.search({ intentText: 'anything' }), { mode: 'lexical', results: [] });
    assert.deepEqual(
      await store.search({ embedding: unitEmbedding(0), intentText: 'anything' }),
      { mode: 'semantic', results: [] },
    );
  });

  // Fix round 1, finding 3 (IMPORTANT, Task 1): cluster-merge re-puts the
  // same canonical id with a refreshed contentHash on every merge.
  // putCanonical must evict the OLD contentHash -> record mapping when
  // that happens, in both stores -- for pg-store this falls out of the
  // UNIQUE index on content_hash tracking only the CURRENT column value
  // per row (see registry/migrations/001-init.sql), but the parity suite
  // still asserts the observable behavior directly rather than trusting
  // that as a given.
  test(`${label}: putCanonical evicts the previous contentHash index entry when upserting an id with a new contentHash`, { skip }, async () => {
    const store = await createFreshStore();
    const original = makeRecord({ idSeed: 'evict-id', flowOverrides: { name: 'flow-evict' } });
    await store.putCanonical(original);
    assert.ok(await store.findByContentHash(original.contentHash));

    const merged = { ...original, contentHash: sha256Hex('evict-id-new-content'), mergedCount: 1 };
    await store.putCanonical(merged);

    assert.equal(await store.findByContentHash(original.contentHash), null);
    const foundByNewHash = await store.findByContentHash(merged.contentHash);
    assert.equal(foundByNewHash.id, original.id);
    assert.equal(foundByNewHash.mergedCount, 1);
  });

  // Fix round 1, finding 4 (IMPORTANT, Task 1): the store interface
  // promises init() is idempotent and safe to call repeatedly -- pg-store's
  // init() runs migrations (never a destructive reset), and every store
  // implementation must honor that same contract.
  test(`${label}: init() is idempotent: calling it again does not wipe existing records`, { skip }, async () => {
    const store = await createFreshStore();
    const record = makeRecord({ idSeed: 'survives-reinit' });
    await store.putCanonical(record);

    await store.init();

    const fetched = await store.get(record.id);
    assert.ok(fetched);
    assert.equal(fetched.id, record.id);
    assert.deepEqual(await store.health(), { ok: true, count: 1 });
  });
}
