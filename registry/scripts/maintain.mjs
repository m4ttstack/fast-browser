#!/usr/bin/env node
// Registry maintenance passes (MAT-160 Task 2): key-rotation re-sign and
// embedding backfill. Operator-invoked, NO new HTTP surface -- this closes
// WS4b's biggest known operational gap: the service signs only at ingest
// (registry/lib/ingest.mjs), so rotating REGISTRY_SIGNING_KEY strands every
// pre-rotation canonical (a client that re-pins the new key, per
// `registry init`'s TOFU flow, then fails verification on every signature
// the OLD key produced -- loud and safe, but unpullable until re-signed).
//
// Two independent actions, explicit flags, either or both per invocation:
//   --re-sign               re-signs every canonical under the CURRENT
//                            REGISTRY_SIGNING_KEY, skipping any whose
//                            signature already verifies against it.
//   --backfill-embeddings   embeds every canonical whose embedding is still
//                            null (keyless-era pushes, or a degraded ingest
//                            embed) under the CURRENT VOYAGE_API_KEY.
//
// Store access uses the SAME driver-selection seam registry/server.mjs's
// boot() uses (registry/lib/store.mjs's createStore), but this script
// REQUIRES DATABASE_URL unconditionally -- maintenance against the
// in-process memory store is meaningless (nothing else can see it, and the
// process exits the moment the script does). The memory-store path is
// exercised ONLY by registry/tests/maintain.test.mjs, via the
// {store, signer, embedder} injection seam below -- never by this file's
// own CLI entrypoint.
//
// Fail-fast env convention (mirrors registry/server.mjs's requireEnv,
// re-declared here rather than imported: server.mjs does not export it,
// and it is small enough that duplicating it is cheaper than reaching into
// another module's private helper): every required variable is named in
// the failure, never echoed -- not the value, not a hint of its shape.
//
// updatedAt / targeted-write decision (MAT-160 Task 2 plan Scope): a
// re-sign or embedding-backfill write must NOT bump a canonical's
// updatedAt. GET /v1/pull?since= is live on the wire (registry/lib/
// http.mjs), and bumping updatedAt on every canonical during a rotation or
// a backfill would make every client's next `since`-scoped pull re-emit
// the ENTIRE registry for a change that altered no content the client
// would recognize as new -- a self-inflicted stampede, for a content-free
// value change. registry/lib/store.mjs's putCanonical is a wholesale
// upsert (every column, including the caller-supplied updatedAt); using it
// here would require either bumping updatedAt (the stampede above) or
// forging the OLD updatedAt back into a full record roundtrip (fragile:
// wrong the instant putCanonical's column set changes). Both stores
// instead got two new, narrow, interface-documented methods
// (registry/lib/store.mjs's updateSignature/updateEmbedding) that write
// exactly one field via a targeted UPDATE and never touch updatedAt --
// pg-store does this as a real single-column SQL UPDATE; memory-store
// mutates the stored record in place. See registry/lib/store.mjs's
// interface doc comment for the full rationale.

import { createPrivateKey } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { parseFlow, serializeFlow } from '../../lib/flows/artifact.mjs';
import { createStore } from '../lib/store.mjs';
import { createEmbedder } from '../lib/embedder.mjs';
import { sign } from '../lib/signing.mjs';
import { embedTextFor } from '../lib/ingest.mjs';
import { redactConnectionString } from '../server.mjs';

export class MaintainError extends Error {}

// Same shape and intent as registry/server.mjs's own requireEnv: names the
// missing variable, never its value.
function requireEnv(env, name) {
  const value = env[name];
  if (!value) {
    throw new MaintainError(`missing required environment variable: ${name}`);
  }
  return value;
}

// Mirrors registry/server.mjs's derivePublicKeyPem validation exactly
// (SYNC NOTE, the convention registry/lib/constants.mjs's EMBED_MODEL
// comment documents for this codebase): that function is not exported --
// its Ed25519-only check is deliberately private to boot()'s own sequence
// -- so this script re-validates independently rather than reaching into
// server.mjs internals. Keep the two in sync by hand if the accepted key
// shape ever changes. Rejecting a non-Ed25519 key here, before any store
// write, matters for the same reason it matters at boot: signing.mjs's
// sign() would otherwise happily sign with an RSA/EC key and produce
// signatures no Ed25519-verifying client could ever check.
function assertEd25519SigningKey(signingKeyPem) {
  let privateKey;
  try {
    privateKey = createPrivateKey(signingKeyPem);
  } catch {
    throw new MaintainError(
      'REGISTRY_SIGNING_KEY is not a valid PEM private key (expected an Ed25519 PKCS8 PEM -- see registry/scripts/keygen.mjs)',
    );
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new MaintainError(
      'REGISTRY_SIGNING_KEY is the wrong key type (expected an Ed25519 PKCS8 PEM -- see registry/scripts/keygen.mjs)',
    );
  }
}

// --- passes (the test-injection seam: {store, signer/embedder} in, a
// counts-and-duration summary out; no env, no process, no console). ---

// Re-signs every canonical under `signer` (registry/lib/signing.mjs's
// `sign`, bound to a private key, same {sign(bytes) -> base64} shape
// server.mjs's boot() wires into ingest). CRITICAL serialization rule
// (registry/lib/ingest.mjs's own top comment, carried forward here
// unchanged): canonical bytes are ALWAYS recomputed via
// serializeFlow(parseFlow(record.content)), never a raw JSON.stringify of
// whatever shape a jsonb round trip left `content` in. Skips (and does not
// write) any record whose current signature already matches -- the
// idempotency property a second `--re-sign` run after a successful one
// depends on, and the property that makes an interrupted/retried run safe.
export async function runReSignPass({ store, signer }) {
  const startedAt = Date.now();
  const records = await store.list({});
  let updated = 0;
  for (const record of records) {
    const flow = parseFlow(record.content);
    const canonicalBytes = serializeFlow(flow);
    const newSignature = signer.sign(canonicalBytes);
    if (newSignature !== record.signature) {
      await store.updateSignature(record.id, newSignature);
      updated += 1;
    }
  }
  return { scanned: records.length, updated, durationMs: Date.now() - startedAt };
}

// Backfills the embedding of every canonical whose stored embedding is
// null, using `embedder` (registry/lib/embedder.mjs's createEmbedder
// output: an `async (text) -> Float64Array | null` function) over the
// SAME text construction registry/lib/ingest.mjs uses for every push --
// imported from there (embedTextFor) rather than re-derived, so the two
// can never drift apart on the `description + ' | ' + stepSignature`
// contract. A per-record embedder degrade (the production embedder never
// throws; see registry/lib/embedder.mjs -- a failure surfaces as a `null`
// return) is counted as `skipped` and the pass continues; it never aborts
// the whole run. Only null-embedding records are ever scanned or written,
// which is what makes a second run idempotent: already-filled records are
// never touched, and a `skipped` record (still null) is retried, not
// silently abandoned, on the next run.
export async function runBackfillPass({ store, embedder }) {
  const startedAt = Date.now();
  const records = (await store.list({})).filter((record) => record.embedding === null);
  let updated = 0;
  let skipped = 0;
  for (const record of records) {
    const flow = parseFlow(record.content);
    const text = embedTextFor(flow);
    const embedding = await embedder(text);
    if (!embedding) {
      skipped += 1;
      continue;
    }
    await store.updateEmbedding(record.id, Array.from(embedding));
    updated += 1;
  }
  return { scanned: records.length, updated, skipped, durationMs: Date.now() - startedAt };
}

// --- CLI wiring: env validation (fail-fast, named, never echoed) -> store
// connection (DATABASE_URL required, redacted on failure) -> the requested
// pass(es) -> a compact summary. Never invokes process.exit itself (that is
// the isMain block's job, mirroring registry/server.mjs's own boot()/isMain
// split) so tests can call this directly and get a rejected Promise instead
// of losing the test process. ---

function parseFlags(argv) {
  return {
    reSign: argv.includes('--re-sign'),
    backfillEmbeddings: argv.includes('--backfill-embeddings'),
  };
}

// runMaintenance({ env, argv }) -> Promise<{ actions: [{ action, scanned,
// updated, skipped?, durationMs }] }>
// Record names are never printed by this script, at any point -- the
// summaries below are counts and a duration only. DATABASE_URL and
// REGISTRY_SIGNING_KEY are never echoed; a pg connection/init failure's
// message is passed through redactConnectionString (registry/server.mjs,
// the same helper boot() uses) before it can ever reach a caller.
export async function runMaintenance({ env = process.env, argv = process.argv.slice(2) } = {}) {
  const { reSign, backfillEmbeddings } = parseFlags(argv);
  if (!reSign && !backfillEmbeddings) {
    throw new MaintainError(
      'no action requested -- pass --re-sign, --backfill-embeddings, or both',
    );
  }

  // Every required env var is validated BEFORE any store connection is
  // attempted, for every requested action -- so a missing/invalid var never
  // depends on network timing to surface, and a test can exercise every
  // fail-fast path with a bogus (or absent) DATABASE_URL and never actually
  // reach Postgres.
  const databaseUrl = requireEnv(env, 'DATABASE_URL');

  let signingKeyPem;
  if (reSign) {
    signingKeyPem = requireEnv(env, 'REGISTRY_SIGNING_KEY');
    assertEd25519SigningKey(signingKeyPem);
  }

  if (backfillEmbeddings) {
    requireEnv(env, 'VOYAGE_API_KEY');
  }

  let store;
  try {
    store = await createStore('pg', { connectionString: databaseUrl });
    await store.init();
  } catch (error) {
    // Same redaction discipline as registry/server.mjs's boot(): a pg
    // connection/init failure's own error.message can quote the connection
    // string (and therefore its password) verbatim -- strip both out
    // before this can ever propagate to a caller or a printed line.
    throw new MaintainError(
      `failed to initialize the Postgres store from DATABASE_URL: ${redactConnectionString(error.message, databaseUrl)}`,
    );
  }

  try {
    const actions = [];
    if (reSign) {
      const signer = { sign: (bytes) => sign(bytes, signingKeyPem) };
      const result = await runReSignPass({ store, signer });
      actions.push({ action: 're-sign', ...result });
    }
    if (backfillEmbeddings) {
      const embedder = createEmbedder({ env });
      const result = await runBackfillPass({ store, embedder });
      actions.push({ action: 'backfill-embeddings', ...result });
    }
    return { actions };
  } finally {
    if (typeof store.close === 'function') await store.close();
  }
}

function formatAction(summary) {
  const parts = [`scanned ${summary.scanned}`, `updated ${summary.updated}`];
  if (summary.action === 'backfill-embeddings') parts.push(`skipped ${summary.skipped}`);
  return `[${summary.action}] ${parts.join(', ')} (${summary.durationMs}ms)`;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  runMaintenance()
    .then(({ actions }) => {
      console.log('fast-browser-registry maintain');
      console.log('');
      for (const action of actions) {
        console.log(formatAction(action));
      }
      console.log('');
      console.log('MAINTENANCE COMPLETE');
    })
    .catch((error) => {
      console.error(`fast-browser-registry maintain: ${error.message}`);
      process.exitCode = 1;
    });
}
