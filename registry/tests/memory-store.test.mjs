// memory-store.mjs's tests. Task 1 wrote every assertion in this file
// directly against createMemoryStore(); WS4b Task 4 lifted that suite
// into registerStoreSuite (registry/tests/helpers/store-suite.mjs) so the
// exact same assertions also run against pg-store (registry/tests/
// pg-store.test.mjs, gated on REGISTRY_TEST_DATABASE_URL) -- this file now
// just supplies the memory-store factory, plus the one test that is
// memory-store-specific by nature (see the comment on it below).
import assert from 'node:assert/strict';
import test from 'node:test';

import { createMemoryStore, EmbeddingDimensionMismatchError } from '../lib/memory-store.mjs';
import { registerStoreSuite } from './helpers/store-suite.mjs';
import { makeRecord } from './helpers/records.mjs';

registerStoreSuite('memory-store', async () => {
  const store = createMemoryStore();
  await store.init();
  return store;
});

// NOT part of the shared parity suite (registerStoreSuite deliberately
// excludes this one -- see the comment at the top of store-suite.mjs):
// memory-store has no fixed embedding width, so it can store a 4-dim and
// a 2-dim embedding side by side and only detect the mismatch pairwise,
// at search time, between one particular query and one particular stored
// record. pg-store.test.mjs carries the pg-appropriate version of this
// same "throw loudly, never truncate" guarantee, where the mismatch is
// instead structural (a fixed vector(1024) column) and surfaces at
// putCanonical/insert time.
//
// Fix round 1, finding 2 (CRITICAL, Task 1): a dimension-mismatched query
// vs a stored embedding used to silently truncate to the shorter length
// via Math.min, so a 4-dim [1,0,0,0] stored embedding could score a false
// 1.0 against a 2-dim [1,0] query -- exactly the mis-bind failure class
// the WS4a drift harness measured. Must throw loudly instead, naming both
// lengths, rather than ever returning a comparison between vectors that
// were never the same shape to begin with.
test('search: semantic mode throws loudly on a dimension-mismatched embedding instead of truncating', async () => {
  const store = createMemoryStore();
  await store.init();
  await store.putCanonical(makeRecord({
    idSeed: 'dim-mismatch-stored',
    flowOverrides: { name: 'flow-dim-mismatch' },
    embedding: [1, 0, 0, 0],
  }));

  await assert.rejects(
    () => store.search({ embedding: [1, 0], intentText: 'x' }),
    (error) => {
      assert.ok(error instanceof EmbeddingDimensionMismatchError);
      assert.match(error.message, /4/);
      assert.match(error.message, /2/);
      return true;
    },
  );
});
