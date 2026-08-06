// pg-store.mjs's tests (WS4b Task 4). Gated on REGISTRY_TEST_DATABASE_URL
// with a NAMED skip -- the repo's established convention (see how
// tests/e2e/*.test.mjs skip on missing FAST_BROWSER_RELEASE_DIR). Without
// it, every test below is registered but skipped, and `npm run
// test:registry`/`npm test` stay fully green with no Postgres available.
// With it, e.g.:
//
//   docker run --rm -d --name ws4b-pgtest -p 127.0.0.1:5433:5432 \
//     -e POSTGRES_PASSWORD=test -e POSTGRES_DB=registry_test \
//     pgvector/pgvector:pg17
//   REGISTRY_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:5433/registry_test \
//     npm run test:registry
//   docker rm -f ws4b-pgtest
//
// registerStoreSuite (registry/tests/helpers/store-suite.mjs) runs the
// SAME assertions memory-store.test.mjs runs, proving the two
// implementations agree. Beyond that shared suite, this file adds the
// pg-only tests the WS4b Task 4 brief calls for by name: migration
// idempotency (boot twice), and pg's structural (column-width) version of
// "never truncate a dimension mismatch, always fail loudly" -- see
// registry/lib/pg-store.mjs's top-of-file comment for why that test is
// not shared with memory-store.test.mjs's version of the same guarantee.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import pg from 'pg';

import { createStore } from '../lib/store.mjs';
import { registerStoreSuite } from './helpers/store-suite.mjs';
import { makeRecord, unitEmbedding } from './helpers/records.mjs';

const DATABASE_URL = process.env.REGISTRY_TEST_DATABASE_URL;
const skip = DATABASE_URL
  ? false
  : 'REGISTRY_TEST_DATABASE_URL is not set; the pg-store parity suite needs a local Postgres+pgvector instance';

// Lazily built once per test run (never when skipped -- node:test does
// not execute a skipped test's body, so this is never even referenced
// without REGISTRY_TEST_DATABASE_URL set), then reused: init() runs the
// migration exactly once and every subsequent createFreshStore() call
// only needs to empty the table, matching memory-store's "every call
// starts from a fresh, empty store" semantics without re-migrating a
// database that is already caught up.
let sharedStore;
let truncatePool;

async function createFreshPgStore() {
  if (!sharedStore) {
    sharedStore = await createStore('pg', { connectionString: DATABASE_URL });
    await sharedStore.init();
    truncatePool = new pg.Pool({ connectionString: DATABASE_URL });
  }
  await truncatePool.query('TRUNCATE TABLE canonical_flows');
  return sharedStore;
}

after(async () => {
  if (truncatePool) await truncatePool.end();
  if (sharedStore) await sharedStore.close();
});

registerStoreSuite('pg-store', createFreshPgStore, { skip });

// Migration idempotency: "boot twice must be safe" (registry/lib/
// store.mjs's init() contract, and the WS4b Task 4 brief's explicit pin).
// Builds two independent pg-store instances (each its own connection
// pool) against the SAME already-migrated database -- simulating two
// separate process boots -- and asserts the second init() neither errors
// nor loses a record the first store wrote before it ran.
test('pg-store: init() is idempotent across two separate boots against the same database', { skip }, async () => {
  // Ensures the shared pool/table exist and starts from an empty table --
  // other fixture records in this suite share this record's default (no
  // flowOverrides) content, and therefore its content_hash, so leftover
  // rows from an earlier test would collide with the unique index on
  // content_hash the moment this one inserts.
  await createFreshPgStore();

  const first = await createStore('pg', { connectionString: DATABASE_URL });
  await first.init();
  const record = makeRecord({ idSeed: 'pg-migration-idempotency' });
  await first.putCanonical(record);

  const second = await createStore('pg', { connectionString: DATABASE_URL });
  await second.init();

  const fetched = await second.get(record.id);
  assert.ok(fetched, 'a record written before the second boot must survive it');
  assert.equal(fetched.id, record.id);
  assert.equal(fetched.contentHash, record.contentHash);

  await first.close();
  await second.close();
});

// pg-native version of memory-store.test.mjs's "throws loudly on a
// dimension-mismatched embedding instead of truncating": the embedding
// column is a fixed vector(1024) (registry/migrations/001-init.sql), so a
// wrong-width embedding cannot be stored at all -- Postgres rejects the
// INSERT itself, naming both the column's width and the value's actual
// length, before any truncate-and-compare could ever happen.
test('pg-store: putCanonical rejects an embedding that is not exactly 1024 dimensions, naming both, instead of truncating', { skip }, async () => {
  const store = await createFreshPgStore();
  const record = makeRecord({ idSeed: 'pg-dim-mismatch-put', embedding: [1, 0, 0] });

  await assert.rejects(
    () => store.putCanonical(record),
    (error) => {
      assert.match(error.message, /1024/);
      assert.match(error.message, /3/);
      return true;
    },
  );
});

// The search-time counterpart: comparing a wrong-width query embedding
// against an existing stored (1024-dim) embedding is rejected by
// pgvector's `<=>` operator itself, naming both dimensions -- rather than
// silently comparing only a truncated prefix of either vector.
test('pg-store: search rejects a query embedding that is not exactly 1024 dimensions, naming both, instead of truncating', { skip }, async () => {
  const store = await createFreshPgStore();
  await store.putCanonical(makeRecord({ idSeed: 'pg-dim-mismatch-search-stored', embedding: unitEmbedding(0) }));

  await assert.rejects(
    () => store.search({ embedding: [1, 0, 0], intentText: 'x' }),
    (error) => {
      assert.match(error.message, /1024/);
      assert.match(error.message, /3/);
      return true;
    },
  );
});
