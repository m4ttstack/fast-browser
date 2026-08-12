import assert from 'node:assert/strict';
import test from 'node:test';

import { assertStoreShape, createStore, STORE_METHODS } from '../lib/store.mjs';

test('STORE_METHODS matches the documented interface method list', () => {
  assert.deepEqual(
    [...STORE_METHODS].sort(),
    [
      'findByContentHash', 'findClusterCandidates', 'get', 'health', 'init', 'list', 'putCanonical', 'search',
      'updateEmbedding', 'updateSignature',
    ].sort(),
  );
});

test('assertStoreShape rejects a store missing any required method, naming it', () => {
  for (const missing of STORE_METHODS) {
    const stub = Object.fromEntries(
      STORE_METHODS.filter((method) => method !== missing).map((method) => [method, async () => {}]),
    );
    assert.throws(
      () => assertStoreShape(stub),
      (error) => error instanceof TypeError && error.message.includes(missing),
      `expected assertStoreShape to reject a store missing ${missing}`,
    );
  }
});

test('assertStoreShape rejects a store where a method exists but is not a function', () => {
  const stub = Object.fromEntries(STORE_METHODS.map((method) => [method, async () => {}]));
  stub.search = 'not-a-function';
  assert.throws(
    () => assertStoreShape(stub),
    (error) => error instanceof TypeError && /search/.test(error.message),
  );
});

test('assertStoreShape accepts and returns a store implementing every method', () => {
  const stub = Object.fromEntries(STORE_METHODS.map((method) => [method, async () => {}]));
  assert.equal(assertStoreShape(stub), stub);
});

test('createStore builds a working memory store by default', async () => {
  const store = await createStore();
  assert.deepEqual(await store.health(), { ok: true, count: 0 });
});

test('createStore("memory") builds the same store explicitly', async () => {
  const store = await createStore('memory');
  assert.deepEqual(await store.health(), { ok: true, count: 0 });
});

test('createStore throws loudly on an unknown driver', async () => {
  await assert.rejects(
    () => createStore('bogus-driver'),
    (error) => error instanceof Error && /bogus-driver/.test(error.message),
  );
});

// 'pg' is implemented as of WS4b Task 4 (registry/lib/pg-store.mjs). This
// only checks that the factory wires the driver name to a shape-complete
// store -- it must not require a real database: createPgStore() builds a
// node-postgres Pool lazily (Pool's constructor never connects on its
// own), so this stays a fast, offline test. The gated parity suite that
// actually exercises this store against Postgres lives in
// registry/tests/pg-store.test.mjs (REGISTRY_TEST_DATABASE_URL).
//
// No database, but it does need the DRIVER: building a Pool means
// constructing node-postgres's class. registry/ is a separate package and
// a root `npm install` does not install its dependencies, so on a fresh
// checkout the driver is simply absent. Skip by name in that case rather
// than failing, the same way the Postgres-backed suite skips on a missing
// REGISTRY_TEST_DATABASE_URL. Run `npm install` inside registry/ to get
// this covered.
const pgDriverMissing = await import('pg').then(() => false, () => true);
const skipWithoutDriver = pgDriverMissing
  ? "the 'pg' driver is not installed; run npm install inside registry/"
  : false;

test('createStore("pg") builds a shape-complete store without needing a real database', { skip: skipWithoutDriver }, async () => {
  const store = await createStore('pg', { connectionString: 'postgres://placeholder@127.0.0.1/placeholder' });
  assert.equal(typeof store.init, 'function');
  assert.equal(typeof store.search, 'function');
});
