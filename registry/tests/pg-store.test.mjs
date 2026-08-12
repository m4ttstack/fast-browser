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

import { createStore } from '../lib/store.mjs';
import { registerStoreSuite } from './helpers/store-suite.mjs';
import { makeRecord, unitEmbedding } from './helpers/records.mjs';

// `pg` is imported lazily, inside the helper below, for the same reason
// pg-store.mjs defers it: a static import here ran at module load, BEFORE
// the skip gate below could skip anything, so a checkout without
// registry/'s own dependencies installed failed to load this file at all
// rather than skipping its suite. The comment on `sharedStore` further
// down reasoned correctly that a skipped test's body never runs, but an
// import is not a body.
async function pgPool(connectionString) {
  const { Pool } = (await import('pg')).default;
  return new Pool({ connectionString });
}

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
    truncatePool = await pgPool(DATABASE_URL);
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

// Fix round 1, finding 1 (IMPORTANT, Task 4 review, verified live): the
// reviewer parked an idle pooled client and pg_terminate_backend'd it --
// exactly what a Railway restart or failover does to a connection this
// process is not actively using -- and the process died on an unhandled
// Pool 'error' event. Reproduced directly, twice: once without
// pool.on('error', ...) attached (uncaught exception, process exit code
// 1), and once with it (logged, process survives, pool recovers on its
// next query) -- this test is that second run, wired into the suite.
// Uses the test-only `store.__pool` escape hatch (registry/lib/
// pg-store.mjs) rather than merely asserting a listener count, per the
// review note that a live kill is the more convincing proof when a
// throwaway container is this cheap to spin up.
test('pg-store: an idle pooled client killed out from under it (e.g. a Railway restart/failover) does not crash the process', { skip }, async () => {
  const store = await createFreshPgStore();

  const idleClient = await store.__pool.connect();
  const { rows: [{ pid }] } = await idleClient.query('SELECT pg_backend_pid() AS pid');
  idleClient.release(); // back to the pool, now idle -- not associated with any in-flight query.

  // A second, independent connection plays the role of Postgres itself
  // (or an operator) terminating the first connection's backend -- the
  // same effect a managed Postgres's own restart/failover has on a
  // connection nothing in this process is currently using.
  const killer = await pgPool(DATABASE_URL);
  try {
    // Races the Pool's 'error' event against the kill query's own
    // response: pg_terminate_backend's result can come back on the
    // killer connection before or after the victim connection's 'error'
    // event fires on `store.__pool`, so wait for the event explicitly
    // (with a generous timeout) rather than a fixed sleep -- if the
    // listener in pg-store.mjs were missing, node would throw
    // synchronously within this same event-loop turn and this whole test
    // process would exit nonzero, not just fail this assertion.
    const poolErrorSeen = new Promise((resolve) => store.__pool.once('error', resolve));
    await killer.query('SELECT pg_terminate_backend($1)', [pid]);
    await Promise.race([
      poolErrorSeen,
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  } finally {
    await killer.end();
  }

  // The store must still be usable afterward: node-postgres discards the
  // dead client and opens a fresh one on the next query.
  assert.deepEqual(await store.health(), { ok: true, count: 0 });
});

// Fix round 1, finding 3 (IMPORTANT, Task 4 review, verified live):
// reproduced directly against a real Postgres container before this fix
// existed -- 4 concurrent, unlocked `CREATE EXTENSION IF NOT EXISTS
// vector` calls against a fresh database, 3 of the 4 failed with
// "duplicate key value violates unique constraint
// pg_extension_name_index" (Postgres's own catalog has no
// IF-NOT-EXISTS-safe way to create the same extension/type twice at
// once) -- and confirmed the pg_advisory_lock in pg-store.mjs's init()
// serializes them cleanly (all 4 succeed) before relying on it. This is
// that same race, through the real store's real init(), not the raw SQL
// probe: resets to a truly not-yet-migrated database (drops everything
// 001-init.sql creates, including the schema_migrations tracking table
// itself -- an already-migrated database would give two concurrent
// init() calls nothing left to race over), then runs two independent
// pg-store instances' init() concurrently.
test('pg-store: concurrent init() against a not-yet-migrated database both succeed (one applies, one waits and no-ops)', { skip }, async () => {
  const resetPool = await pgPool(DATABASE_URL);
  try {
    await resetPool.query('DROP TABLE IF EXISTS canonical_flows');
    await resetPool.query('DROP TABLE IF EXISTS schema_migrations');
    await resetPool.query('DROP EXTENSION IF EXISTS vector');
  } finally {
    await resetPool.end();
  }

  const first = await createStore('pg', { connectionString: DATABASE_URL });
  const second = await createStore('pg', { connectionString: DATABASE_URL });
  try {
    await Promise.all([first.init(), second.init()]);
  } finally {
    await first.close();
    await second.close();
  }

  const checkPool = await pgPool(DATABASE_URL);
  try {
    const { rows } = await checkPool.query('SELECT filename FROM schema_migrations');
    assert.deepEqual(rows.map((row) => row.filename), ['001-init.sql'], 'the migration must be recorded exactly once, not twice, not zero times');

    const { rows: [{ count }] } = await checkPool.query('SELECT count(*)::int AS count FROM canonical_flows');
    assert.equal(count, 0, 'the recreated table must be empty and queryable, proving the schema is fully usable afterward');
  } finally {
    await checkPool.end();
  }
});
