import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { parseFlow, serializeFlow } from '../../lib/flows/artifact.mjs';
import { createMemoryStore } from '../lib/memory-store.mjs';
import { opSequence, stepSignature } from '../lib/signature-fields.mjs';
import { baseFlow } from './helpers/fixtures.mjs';

function contentHashOf(flow) {
  return createHash('sha256').update(serializeFlow(flow)).digest('hex');
}

function sha256Hex(seed) {
  return createHash('sha256').update(seed).digest('hex');
}

// Builds a store record per the plan's Shared shapes: { id, name, origin,
// description, stepSignature, opSequence, content, contentHash, signature,
// embedding, mergedCount, createdAt, updatedAt }.
function makeRecord(overrides = {}) {
  const flow = parseFlow(baseFlow(overrides.flowOverrides ?? {}));
  const content = flow;
  return {
    id: sha256Hex(overrides.idSeed ?? flow.name),
    name: flow.name,
    origin: flow.origin,
    description: flow.description,
    stepSignature: stepSignature(flow),
    opSequence: opSequence(flow),
    content,
    contentHash: contentHashOf(flow),
    signature: null,
    embedding: null,
    mergedCount: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

test('putCanonical stores a record and get retrieves it by id', async () => {
  const store = createMemoryStore();
  await store.init();
  const record = makeRecord();

  const stored = await store.putCanonical(record);
  assert.equal(stored.id, record.id);

  const fetched = await store.get(record.id);
  assert.deepEqual(fetched.content, record.content);
  assert.equal(fetched.contentHash, record.contentHash);
});

test('get returns null for an unknown id', async () => {
  const store = createMemoryStore();
  await store.init();
  assert.equal(await store.get('f'.repeat(64)), null);
});

test('putCanonical upserts by id: a second put with the same id replaces the record', async () => {
  const store = createMemoryStore();
  await store.init();
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

test('putCanonical returns and stores a defensive copy, not a live reference', async () => {
  const store = createMemoryStore();
  await store.init();
  const record = makeRecord({ idSeed: 'defensive' });
  const stored = await store.putCanonical(record);

  stored.mergedCount = 999;
  stored.content.name = 'mutated-after-store';

  const fetched = await store.get(record.id);
  assert.equal(fetched.mergedCount, 0);
  assert.equal(fetched.content.name, record.content.name);
});

test('findByContentHash looks up by content hash and returns null when absent', async () => {
  const store = createMemoryStore();
  await store.init();
  const record = makeRecord({ idSeed: 'by-hash' });
  await store.putCanonical(record);

  const found = await store.findByContentHash(record.contentHash);
  assert.equal(found.id, record.id);

  assert.equal(await store.findByContentHash('0'.repeat(64)), null);
});

test('list filters by origin', async () => {
  const store = createMemoryStore();
  await store.init();
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

test('list filters by since (updatedAt) inclusively and sorts ascending', async () => {
  const store = createMemoryStore();
  await store.init();
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

test('findClusterCandidates prefilters by origin and opSequence exactly', async () => {
  const store = createMemoryStore();
  await store.init();
  const flowA = parseFlow(baseFlow({ name: 'flow-a', origin: 'http://a.example' }));

  const match = makeRecord({ idSeed: 'match', flowOverrides: { name: 'flow-a', origin: 'http://a.example' } });
  const wrongOrigin = makeRecord({
    idSeed: 'wrong-origin',
    flowOverrides: { name: 'flow-b', origin: 'http://b.example' },
  });
  // Same origin as `match`, but a deliberately different opSequence value --
  // the store trusts the caller-computed field rather than recomputing it
  // from `content`, so this isolates the store's own filter logic from
  // signature-fields.mjs (covered separately in signature-fields.test.mjs).
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

test('health reports ok and the current record count', async () => {
  const store = createMemoryStore();
  await store.init();
  assert.deepEqual(await store.health(), { ok: true, count: 0 });
  await store.putCanonical(makeRecord({ idSeed: 'health-1' }));
  assert.deepEqual(await store.health(), { ok: true, count: 1 });
});

test('search: semantic mode ranks by cosine similarity over stored embeddings, descending', async () => {
  const store = createMemoryStore();
  await store.init();
  const close = makeRecord({
    idSeed: 'close',
    flowOverrides: { name: 'flow-close' },
    embedding: [1, 0, 0],
  });
  const far = makeRecord({
    idSeed: 'far',
    flowOverrides: { name: 'flow-far' },
    embedding: [0, 1, 0],
  });
  const opposite = makeRecord({
    idSeed: 'opposite',
    flowOverrides: { name: 'flow-opposite' },
    embedding: [-1, 0, 0],
  });
  await store.putCanonical(far);
  await store.putCanonical(opposite);
  await store.putCanonical(close);

  const result = await store.search({ embedding: [1, 0, 0], intentText: 'place an order' });
  assert.equal(result.mode, 'semantic');
  assert.deepEqual(result.results.map((r) => r.record.id), [close.id, far.id, opposite.id]);
  assert.ok(result.results[0].score > result.results[1].score);
  assert.equal(Math.round(result.results[0].score * 1000) / 1000, 1);
});

test('search: semantic mode skips records with no stored embedding', async () => {
  const store = createMemoryStore();
  await store.init();
  const embedded = makeRecord({ idSeed: 'embedded', flowOverrides: { name: 'flow-embedded' }, embedding: [1, 0] });
  const unembedded = makeRecord({ idSeed: 'unembedded', flowOverrides: { name: 'flow-unembedded' } });
  await store.putCanonical(embedded);
  await store.putCanonical(unembedded);

  const result = await store.search({ embedding: [1, 0], intentText: 'x' });
  assert.deepEqual(result.results.map((r) => r.record.id), [embedded.id]);
});

test('search: semantic mode filters by origin', async () => {
  const store = createMemoryStore();
  await store.init();
  const a = makeRecord({
    idSeed: 'origin-search-a',
    flowOverrides: { name: 'flow-search-a', origin: 'http://a.example' },
    embedding: [1, 0],
  });
  const b = makeRecord({
    idSeed: 'origin-search-b',
    flowOverrides: { name: 'flow-search-b', origin: 'http://b.example' },
    embedding: [1, 0],
  });
  await store.putCanonical(a);
  await store.putCanonical(b);

  const result = await store.search({ embedding: [1, 0], intentText: 'x', origin: 'http://a.example' });
  assert.deepEqual(result.results.map((r) => r.record.id), [a.id]);
});

test('search: lexical mode scores by substring overlap over name and description when no embedding is given', async () => {
  const store = createMemoryStore();
  await store.init();
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

test('search: lexical mode returns the top 5 by descending score', async () => {
  const store = createMemoryStore();
  await store.init();
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

test('search: an empty store returns empty results in either mode', async () => {
  const store = createMemoryStore();
  await store.init();
  assert.deepEqual(await store.search({ intentText: 'anything' }), { mode: 'lexical', results: [] });
  assert.deepEqual(await store.search({ embedding: [1, 0], intentText: 'anything' }), { mode: 'semantic', results: [] });
});
