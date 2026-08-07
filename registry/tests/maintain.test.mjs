// registry/scripts/maintain.mjs's tests (MAT-160 Task 2: key-rotation
// re-sign + embedding backfill maintenance passes).
//
// Three sections:
//   1. Pass-level tests (runReSignPass/runBackfillPass) against the MEMORY
//      store, via the {store, signer/embedder} injection seam. The CLI
//      itself requires DATABASE_URL (registry/scripts/maintain.mjs's own
//      top comment explains why: maintenance against the in-process memory
//      store is meaningless in production) -- the memory-store path below
//      exists ONLY so these passes can be tested fast and without a real
//      Postgres; it is never reachable from the script's CLI entrypoint.
//   2. CLI-level (runMaintenance) env fail-fast + DATABASE_URL-redaction
//      tests -- no real Postgres needed: every fail-fast check runs before
//      any store connection is attempted (see runMaintenance's own
//      comment), and the redaction test uses an unreachable local port for
//      a real-but-fast connection failure, mirroring registry/tests/
//      http.test.mjs's identical boot() test.
//   3. Gated pg tests (REGISTRY_TEST_MAINTAIN_DATABASE_URL) proving the
//      same rotation/backfill behavior against a real Postgres+pgvector
//      store, end to end through runMaintenance's own 'pg' driver path.
//      Deliberately a SEPARATE env var (and, when run locally, a separate
//      container/port) from registry/tests/pg-store.test.mjs's own
//      REGISTRY_TEST_DATABASE_URL: these tests run and TRUNCATE against the
//      whole canonical_flows table with no scoping (matching what
//      runMaintenance's passes actually do -- they iterate every canonical,
//      unscoped), and node's test runner executes separate test FILES
//      concurrently by default. Sharing one database with pg-store.test.mjs
//      -- which ALSO truncates that table, repeatedly, throughout its own
//      suite -- is a real, reproduced race (caught while writing this
//      suite: pg-store.test.mjs's truncate landing between this file's
//      insert and its assertion silently drops the row this suite is
//      asserting against). A dedicated instance removes the race
//      structurally rather than papering over it with retries. Run locally
//      with:
//
//        docker run --rm -d --name ws4b-maint-test -p 127.0.0.1:5434:5432 \
//          -e POSTGRES_PASSWORD=test -e POSTGRES_DB=registry_test \
//          pgvector/pgvector:pg17
//        REGISTRY_TEST_MAINTAIN_DATABASE_URL=postgres://postgres:test@127.0.0.1:5434/registry_test \
//          npm run test:registry
//        docker rm -f ws4b-maint-test
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import test from 'node:test';

import { parseFlow, serializeFlow } from '../../lib/flows/artifact.mjs';
import { createMemoryStore } from '../lib/memory-store.mjs';
import { createStore } from '../lib/store.mjs';
import { ingest } from '../lib/ingest.mjs';
import { sign, verify } from '../lib/signing.mjs';
import { baseFlow } from './helpers/fixtures.mjs';
import { generateSigningKeyPem } from './helpers/server.mjs';
import {
  MaintainError, needsAttention, runBackfillPass, runMaintenance, runReSignPass,
} from '../scripts/maintain.mjs';

function publicKeyPemFor(privateKeyPem) {
  return createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'pem' });
}

function signerFor(privateKeyPem) {
  return { sign: (bytes) => sign(bytes, privateKeyPem) };
}

async function pushFlow(store, signer, overrides = {}) {
  const flow = parseFlow(baseFlow(overrides));
  const canonicalBytes = serializeFlow(flow);
  const { createHash } = await import('node:crypto');
  const contentHash = createHash('sha256').update(canonicalBytes).digest('hex');
  const result = await ingest({
    envelope: { artifact: flow, contentHash },
    store,
    signer,
    embedder: null,
  });
  assert.equal(result.outcome, 'created', 'test setup expects a fresh canonical');
  return result.canonicalId;
}

function stubFetch(t, implementation) {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  t.after(() => { globalThis.fetch = original; });
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

function validEmbedding() {
  return Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
}

// --- 1. pass-level tests, memory store ---

test('runReSignPass: a rotated key end to end -- signed under A fails verify against B, re-signed under B verifies, idempotent second run', async () => {
  const store = createMemoryStore();
  const keyA = generateSigningKeyPem();
  const keyB = generateSigningKeyPem();
  const publicKeyB = publicKeyPemFor(keyB);

  const id = await pushFlow(store, signerFor(keyA), { name: 'rotate-me' });
  const before = await store.get(id);
  const canonicalBytes = serializeFlow(parseFlow(before.content));
  assert.equal(verify(canonicalBytes, before.signature, publicKeyB), false, 'a key-A signature must not verify against key B before re-signing');

  const first = await runReSignPass({ store, signer: signerFor(keyB) });
  assert.equal(first.scanned, 1);
  assert.equal(first.updated, 1);

  const after = await store.get(id);
  assert.equal(verify(canonicalBytes, after.signature, publicKeyB), true, 're-signing under key B must produce a signature that verifies against key B');

  const second = await runReSignPass({ store, signer: signerFor(keyB) });
  assert.equal(second.scanned, 1);
  assert.equal(second.updated, 0, 'a second run against an already-current signature must be a no-op');
});

test('runReSignPass does not bump updatedAt', async () => {
  const store = createMemoryStore();
  const keyA = generateSigningKeyPem();
  const keyB = generateSigningKeyPem();

  const id = await pushFlow(store, signerFor(keyA));
  const before = await store.get(id);

  await runReSignPass({ store, signer: signerFor(keyB) });

  const after = await store.get(id);
  assert.equal(after.updatedAt, before.updatedAt);
  assert.notEqual(after.signature, before.signature);
});

test('runReSignPass skips a canonical whose signature already verifies against the current key (no store write)', async () => {
  const store = createMemoryStore();
  const key = generateSigningKeyPem();
  const id = await pushFlow(store, signerFor(key));
  const before = await store.get(id);

  const result = await runReSignPass({ store, signer: signerFor(key) });
  assert.equal(result.updated, 0);

  const after = await store.get(id);
  assert.equal(after.signature, before.signature);
  assert.equal(after.updatedAt, before.updatedAt);
});

test('runBackfillPass fills only null-embedding records, skips on embedder degrade with a count, and is idempotent', async () => {
  const store = createMemoryStore();
  const key = generateSigningKeyPem();
  const signer = signerFor(key);

  const alreadyEmbeddedId = await pushFlow(store, signer, { name: 'already-embedded', description: 'already embedded description' });
  await store.updateEmbedding(alreadyEmbeddedId, [1, 0, 0]);
  const willFillId = await pushFlow(store, signer, { name: 'will-fill', description: 'will fill description' });
  const willDegradeId = await pushFlow(store, signer, { name: 'will-degrade', description: 'will degrade description' });

  // Keyed off the embed TEXT, not call order: runBackfillPass's scan order
  // ties on updatedAt (both records above can share the exact same
  // millisecond timestamp) and breaks ties by id -- a fresh randomUUID(),
  // so which of will-fill/will-degrade is embedded first is not
  // deterministic. Degrading by content, not by "the Nth call", is what
  // makes this test's outcome deterministic regardless of scan order.
  let calls = 0;
  const embedder = async (text) => {
    calls += 1;
    // Proves the pass continues past a degraded record rather than
    // aborting, and that skipped/updated are counted independently.
    if (text.startsWith('will degrade description')) return null;
    return new Float64Array([1, 0, 0]);
  };

  const first = await runBackfillPass({ store, embedder });
  assert.equal(first.scanned, 2, 'only the two null-embedding records are scanned, not the already-embedded one');
  assert.equal(first.updated, 1);
  assert.equal(first.skipped, 1);
  assert.equal(calls, 2, 'the already-embedded record must never be sent to the embedder');

  const filled = await store.get(willFillId);
  assert.ok(filled.embedding, 'the non-degraded record must now have an embedding');
  const stillNull = await store.get(willDegradeId);
  assert.equal(stillNull.embedding, null, 'a degraded embed must leave the record embedding null, not partially written');

  // Idempotent: only the still-null (degraded) record is retried; the
  // filled one is never touched again.
  let secondCalls = 0;
  const secondEmbedder = async () => {
    secondCalls += 1;
    return new Float64Array([0, 1, 0]);
  };
  const second = await runBackfillPass({ store, embedder: secondEmbedder });
  assert.equal(second.scanned, 1);
  assert.equal(second.updated, 1);
  assert.equal(second.skipped, 0);
  assert.equal(secondCalls, 1);
});

test('runBackfillPass does not bump updatedAt', async () => {
  const store = createMemoryStore();
  const id = await pushFlow(store, signerFor(generateSigningKeyPem()));
  const before = await store.get(id);

  await runBackfillPass({ store, embedder: async () => new Float64Array([1, 0, 0]) });

  const after = await store.get(id);
  assert.equal(after.updatedAt, before.updatedAt);
  assert.ok(after.embedding);
});

test('runBackfillPass embeds the same description + stepSignature text ingest.mjs uses', async () => {
  const store = createMemoryStore();
  const id = await pushFlow(store, signerFor(generateSigningKeyPem()), { name: 'text-contract' });
  const record = await store.get(id);
  const { embedTextFor } = await import('../lib/ingest.mjs');
  const expectedText = embedTextFor(parseFlow(record.content));

  let capturedText = null;
  await runBackfillPass({
    store,
    embedder: async (text) => {
      capturedText = text;
      return new Float64Array([1, 0, 0]);
    },
  });

  assert.equal(capturedText, expectedText);
});

// --- Fix round 1, IMPORTANT #1: re-sign must not be weaker than ingest --
// a tampered record (content changed, contentHash left stale, exactly what
// a direct DB edit looks like) must be REFUSED, not signed under the
// current key. Reproduces the reviewer's exact scenario. ---

test('runReSignPass refuses to re-sign a record whose content no longer matches its stored contentHash (tampered), counts it as mismatched, names it in a warning, and still re-signs the other records', async () => {
  const store = createMemoryStore();
  const key = generateSigningKeyPem();
  const signer = signerFor(key);

  const tamperedId = await pushFlow(store, signer, { name: 'tampered-record' });
  const otherId = await pushFlow(store, signer, { name: 'clean-record' });
  const otherBefore = await store.get(otherId);

  const original = await store.get(tamperedId);
  // Simulates a direct DB edit: `content` changes, `contentHash` is left
  // stale -- putCanonical is a wholesale upsert, so every other field
  // (including the now-stale contentHash and the OLD signature) rides
  // through unchanged, exactly like a hand-edited row would.
  const tamperedContent = { ...original.content, description: 'TAMPERED description -- contentHash left stale' };
  await store.putCanonical({ ...original, content: tamperedContent });

  const keyB = generateSigningKeyPem();
  const result = await runReSignPass({ store, signer: signerFor(keyB) });

  assert.equal(result.scanned, 2);
  assert.equal(result.mismatched, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.updated, 1, 'the untampered record must still be re-signed');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], new RegExp(tamperedId));
  assert.match(result.warnings[0], /tampered-record/);
  assert.match(result.warnings[0], /contentHash mismatch/);

  const stillTampered = await store.get(tamperedId);
  assert.equal(stillTampered.signature, original.signature, 'a mismatched record must NOT be re-signed -- the old signature is left in place, never signed under the new key');

  const other = await store.get(otherId);
  assert.notEqual(other.signature, otherBefore.signature, 're-sign for the untampered record must actually have run');
  assert.equal(verify(serializeFlow(parseFlow(other.content)), other.signature, publicKeyPemFor(keyB)), true, 'the untampered record must verify against the NEW key');
});

test('runReSignPass is idempotent after a mismatch: a second run still refuses the same tampered record and still reports it as mismatched', async () => {
  const store = createMemoryStore();
  const key = generateSigningKeyPem();
  const id = await pushFlow(store, signerFor(key));
  const original = await store.get(id);
  await store.putCanonical({ ...original, content: { ...original.content, description: 'tampered again' } });

  const keyB = generateSigningKeyPem();
  const first = await runReSignPass({ store, signer: signerFor(keyB) });
  const second = await runReSignPass({ store, signer: signerFor(keyB) });

  assert.equal(first.mismatched, 1);
  assert.equal(second.mismatched, 1);
  assert.equal(second.updated, 0);
});

// --- Fix round 1, IMPORTANT #2: a per-record error (corrupted content
// that fails parseFlow) must not stop the rest of the pass. Reproduces the
// reviewer's exact scenario: a MIDDLE record, so the records after it in
// scan order are the ones that would previously have been silently
// dropped by an uncaught throw. ---

test('runReSignPass: a middle record with corrupted content (steps not an array) is counted as failed, named in a warning, and does not stop the other records from being re-signed', async () => {
  const store = createMemoryStore();
  const key = generateSigningKeyPem();
  const signer = signerFor(key);

  const firstId = await pushFlow(store, signer, { name: 'first-record' });
  const corruptId = await pushFlow(store, signer, { name: 'corrupt-record' });
  const lastId = await pushFlow(store, signer, { name: 'last-record' });

  const firstBefore = await store.get(firstId);
  const lastBefore = await store.get(lastId);
  const corruptBefore = await store.get(corruptId);
  await store.putCanonical({ ...corruptBefore, content: { ...corruptBefore.content, steps: 'not-an-array' } });

  const keyB = generateSigningKeyPem();
  const result = await runReSignPass({ store, signer: signerFor(keyB) });

  assert.equal(result.scanned, 3);
  assert.equal(result.failed, 1);
  assert.equal(result.mismatched, 0);
  assert.equal(result.updated, 2, 'the two uncorrupted records must still be re-signed despite the middle record throwing');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], new RegExp(corruptId));
  assert.match(result.warnings[0], /corrupt-record/);

  const firstAfter = await store.get(firstId);
  const lastAfter = await store.get(lastId);
  assert.notEqual(firstAfter.signature, firstBefore.signature, 'the record before the corrupted one must still be re-signed');
  assert.notEqual(lastAfter.signature, lastBefore.signature, 'the record after the corrupted one must still be re-signed');

  const corruptAfter = await store.get(corruptId);
  assert.equal(corruptAfter.signature, corruptBefore.signature, 'the corrupted record itself must be left untouched, not partially written');
});

test('runBackfillPass: a middle record with corrupted content (steps not an array) is counted as failed, named in a warning, and does not stop the other records from being backfilled', async () => {
  const store = createMemoryStore();
  const key = generateSigningKeyPem();
  const signer = signerFor(key);

  const firstId = await pushFlow(store, signer, { name: 'first-record', description: 'first description' });
  const corruptId = await pushFlow(store, signer, { name: 'corrupt-record', description: 'corrupt description' });
  const lastId = await pushFlow(store, signer, { name: 'last-record', description: 'last description' });

  const corruptBefore = await store.get(corruptId);
  await store.putCanonical({ ...corruptBefore, content: { ...corruptBefore.content, steps: 'not-an-array' } });

  const result = await runBackfillPass({ store, embedder: async () => new Float64Array([1, 0, 0]) });

  assert.equal(result.scanned, 3);
  assert.equal(result.failed, 1);
  assert.equal(result.updated, 2, 'the two uncorrupted records must still be backfilled despite the middle record throwing');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], new RegExp(corruptId));
  assert.match(result.warnings[0], /corrupt-record/);

  assert.ok((await store.get(firstId)).embedding, 'the record before the corrupted one must still be backfilled');
  assert.ok((await store.get(lastId)).embedding, 'the record after the corrupted one must still be backfilled');
  assert.equal((await store.get(corruptId)).embedding, null, 'the corrupted record itself must be left untouched (still null), not partially written');
});

test('needsAttention is true when any action reports a mismatched or failed record, and false otherwise -- the CLI\'s exit-code signal', () => {
  assert.equal(needsAttention([{ action: 're-sign', mismatched: 0, failed: 0 }]), false);
  assert.equal(needsAttention([{ action: 're-sign', mismatched: 1, failed: 0 }]), true);
  assert.equal(needsAttention([{ action: 're-sign', mismatched: 0, failed: 1 }]), true);
  assert.equal(needsAttention([{ action: 'backfill-embeddings', skipped: 3, failed: 0 }]), false);
  assert.equal(needsAttention([{ action: 'backfill-embeddings', skipped: 3, failed: 2 }]), true);
  assert.equal(
    needsAttention([
      { action: 're-sign', mismatched: 0, failed: 0 },
      { action: 'backfill-embeddings', skipped: 0, failed: 0 },
    ]),
    false,
  );
});

// --- 2. CLI-level (runMaintenance): env fail-fast + redaction ---

test('runMaintenance rejects when no action flag is given, naming neither env var nor a database', async () => {
  await assert.rejects(
    () => runMaintenance({ env: { DATABASE_URL: 'postgres://fake' }, argv: [] }),
    (error) => error instanceof MaintainError && /--re-sign|--backfill-embeddings/.test(error.message),
  );
});

test('runMaintenance requires DATABASE_URL unconditionally, naming it and never a value', async () => {
  await assert.rejects(
    () => runMaintenance({ env: {}, argv: ['--re-sign'] }),
    (error) => error instanceof MaintainError && error.message === 'missing required environment variable: DATABASE_URL',
  );
});

test('runMaintenance --re-sign requires REGISTRY_SIGNING_KEY, naming it and never a value, before any store connection', async () => {
  await assert.rejects(
    () => runMaintenance({ env: { DATABASE_URL: 'postgres://fake' }, argv: ['--re-sign'] }),
    (error) => error instanceof MaintainError && error.message === 'missing required environment variable: REGISTRY_SIGNING_KEY',
  );
});

test('runMaintenance --re-sign rejects a REGISTRY_SIGNING_KEY that is not a valid PEM, naming the var and never echoing the bogus value', async () => {
  const bogusKey = 'not-a-real-pem-at-all';
  await assert.rejects(
    () => runMaintenance({
      env: { DATABASE_URL: 'postgres://fake', REGISTRY_SIGNING_KEY: bogusKey },
      argv: ['--re-sign'],
    }),
    (error) => /REGISTRY_SIGNING_KEY/.test(error.message) && !error.message.includes(bogusKey),
  );
});

test('runMaintenance --re-sign rejects a syntactically valid PEM of the wrong key type (RSA), naming the var and never echoing it', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey: rsaPem } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  await assert.rejects(
    () => runMaintenance({
      env: { DATABASE_URL: 'postgres://fake', REGISTRY_SIGNING_KEY: rsaPem },
      argv: ['--re-sign'],
    }),
    (error) => /REGISTRY_SIGNING_KEY/.test(error.message) && !error.message.includes(rsaPem),
  );
});

test('runMaintenance --backfill-embeddings requires VOYAGE_API_KEY, naming it and never a value, before any store connection', async () => {
  await assert.rejects(
    () => runMaintenance({ env: { DATABASE_URL: 'postgres://fake' }, argv: ['--backfill-embeddings'] }),
    (error) => error instanceof MaintainError && error.message === 'missing required environment variable: VOYAGE_API_KEY',
  );
});

// SECURITY: mirrors registry/tests/http.test.mjs's identical boot() test --
// an unreachable local port (real ECONNREFUSED, fast) rather than a
// malformed URL, proving the redaction against a real end-to-end pg
// connection failure, not a synthetic message.
test('runMaintenance with a DATABASE_URL that fails to connect never echoes the connection string or its password', async () => {
  const password = 'sup3rSecretFakePass123';
  const bogusUrl = `postgres://registryuser:${password}@127.0.0.1:1/registry_test`;
  await assert.rejects(
    () => runMaintenance({
      env: { DATABASE_URL: bogusUrl, REGISTRY_SIGNING_KEY: generateSigningKeyPem() },
      argv: ['--re-sign'],
    }),
    (error) => {
      assert.ok(!error.message.includes(password), 'failure message must never include the DATABASE_URL password');
      assert.ok(!error.message.includes(bogusUrl), 'failure message must never include the full DATABASE_URL');
      assert.match(error.message, /DATABASE_URL/);
      return true;
    },
  );
});

// --- 3. gated pg tests ---

const DATABASE_URL = process.env.REGISTRY_TEST_MAINTAIN_DATABASE_URL;
const skip = DATABASE_URL
  ? false
  : 'REGISTRY_TEST_MAINTAIN_DATABASE_URL is not set; the maintain gated suite needs its own local Postgres+pgvector instance, separate from REGISTRY_TEST_DATABASE_URL (see this file\'s top comment for the docker command, container name ws4b-maint-test)';

async function freshPgStore() {
  const store = await createStore('pg', { connectionString: DATABASE_URL });
  await store.init();
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  await pool.query('TRUNCATE TABLE canonical_flows');
  return { store, pool };
}

test('maintain.mjs (gated pg): --re-sign rotates every canonical to a new key against a real Postgres store, idempotently', { skip }, async () => {
  const { store, pool } = await freshPgStore();
  try {
    const keyA = generateSigningKeyPem();
    const keyB = generateSigningKeyPem();
    const publicKeyB = publicKeyPemFor(keyB);

    const id = await pushFlow(store, signerFor(keyA), { name: 'gated-rotate-me' });
    const before = await store.get(id);
    const canonicalBytes = serializeFlow(parseFlow(before.content));
    assert.equal(verify(canonicalBytes, before.signature, publicKeyB), false);

    const first = await runMaintenance({
      env: { DATABASE_URL, REGISTRY_SIGNING_KEY: keyB },
      argv: ['--re-sign'],
    });
    assert.equal(first.actions[0].action, 're-sign');
    assert.equal(first.actions[0].updated, 1);

    const after = await store.get(id);
    assert.equal(verify(canonicalBytes, after.signature, publicKeyB), true);
    assert.equal(after.updatedAt, before.updatedAt);

    const second = await runMaintenance({
      env: { DATABASE_URL, REGISTRY_SIGNING_KEY: keyB },
      argv: ['--re-sign'],
    });
    assert.equal(second.actions[0].updated, 0);
  } finally {
    await pool.end();
    await store.close();
  }
});

// Fix round 1, IMPORTANT #1 pg parity: proves the targeted-write refusal
// (recompute sha256(canonicalBytes), compare to the stored contentHash,
// refuse the write on mismatch) against a REAL Postgres row, not just the
// memory-store version above -- the reviewer's tamper reproduction was
// against a live service, so this closes the loop against the real driver
// too.
test('maintain.mjs (gated pg): --re-sign refuses a tampered record (contentHash mismatch), counts and reports it, still re-signs the other record, and needsAttention flags the run', { skip }, async () => {
  const { store, pool } = await freshPgStore();
  try {
    const key = generateSigningKeyPem();
    const signer = signerFor(key);
    const tamperedId = await pushFlow(store, signer, { name: 'gated-tampered-record' });
    const cleanId = await pushFlow(store, signer, { name: 'gated-clean-record' });

    const original = await store.get(tamperedId);
    await store.putCanonical({
      ...original,
      content: { ...original.content, description: 'TAMPERED via gated pg test -- contentHash left stale' },
    });

    const keyB = generateSigningKeyPem();
    const result = await runMaintenance({
      env: { DATABASE_URL, REGISTRY_SIGNING_KEY: keyB },
      argv: ['--re-sign'],
    });

    const action = result.actions[0];
    assert.equal(action.mismatched, 1);
    assert.equal(action.updated, 1, 'the untampered record must still be re-signed');
    assert.equal(action.warnings.length, 1);
    assert.match(action.warnings[0], new RegExp(tamperedId));
    assert.equal(needsAttention(result.actions), true, 'a mismatched record must make the CLI exit non-zero');

    const stillTampered = await store.get(tamperedId);
    assert.equal(stillTampered.signature, original.signature, 'the tampered record must not be re-signed');

    const clean = await store.get(cleanId);
    const publicKeyB = publicKeyPemFor(keyB);
    assert.equal(verify(serializeFlow(parseFlow(clean.content)), clean.signature, publicKeyB), true);
  } finally {
    await pool.end();
    await store.close();
  }
});

test('maintain.mjs (gated pg): --backfill-embeddings fills null embeddings against a real Postgres store, idempotently, skipping on degrade', { skip }, async (t) => {
  const { store, pool } = await freshPgStore();
  try {
    const key = generateSigningKeyPem();
    const signer = signerFor(key);
    const willFillId = await pushFlow(store, signer, { name: 'gated-will-fill' });
    const willDegradeId = await pushFlow(store, signer, { name: 'gated-will-degrade' });

    let calls = 0;
    stubFetch(t, async () => {
      calls += 1;
      if (calls === 2) return jsonResponse({}, { ok: false, status: 500 });
      return jsonResponse({ data: [{ embedding: validEmbedding() }] });
    });

    const result = await runMaintenance({
      env: { DATABASE_URL, VOYAGE_API_KEY: 'fake-key-stubbed-fetch-never-hits-network' },
      argv: ['--backfill-embeddings'],
    });
    assert.equal(result.actions[0].action, 'backfill-embeddings');
    assert.equal(result.actions[0].updated, 1);
    assert.equal(result.actions[0].skipped, 1);

    const filled = await store.get(willFillId);
    assert.ok(filled.embedding);
    const stillNull = await store.get(willDegradeId);
    assert.equal(stillNull.embedding, null);
  } finally {
    await pool.end();
    await store.close();
  }
});
