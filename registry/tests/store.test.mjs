import assert from 'node:assert/strict';
import test from 'node:test';

import { assertStoreShape, createStore, STORE_METHODS } from '../lib/store.mjs';

test('STORE_METHODS matches the documented interface method list', () => {
  assert.deepEqual(
    [...STORE_METHODS].sort(),
    ['findByContentHash', 'findClusterCandidates', 'get', 'health', 'init', 'list', 'putCanonical', 'search'].sort(),
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

test('createStore throws loudly on an unknown or not-yet-implemented driver', async () => {
  await assert.rejects(
    () => createStore('pg'),
    (error) => error instanceof Error && /pg/.test(error.message),
  );
  await assert.rejects(
    () => createStore('bogus-driver'),
    (error) => error instanceof Error && /bogus-driver/.test(error.message),
  );
});
