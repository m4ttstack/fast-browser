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
//                            signature already verifies against it, and
//                            REFUSING (never signing) any whose recomputed
//                            contentHash does not match its stored one --
//                            see Fix round 1 #1 below.
//   --backfill-embeddings   embeds every canonical whose embedding is still
//                            null (keyless-era pushes, or a degraded ingest
//                            embed) under the CURRENT VOYAGE_API_KEY.
//
// Both actions are failure-contained per record (Fix round 1 #2 below) and
// the CLI exits non-zero whenever any record was refused or failed --
// counts and warnings are always printed, never just a raw crash.
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
//
// Fix round 1, IMPORTANT #1 (reviewer-reproduced, live): re-signing is the
// one moment the trust chain is re-minted, and it must not be WEAKER than
// ingest -- ingest refuses a contentHash mismatch outright (registry/lib/
// ingest.mjs step 2). An earlier version of runReSignPass signed whatever
// bytes were in `content` unconditionally, never checking them against the
// record's own stored `contentHash`; the reviewer proved live that a
// record tampered directly in the database (content changed, contentHash
// left stale) walked out of a re-sign pass validly signed under the
// CURRENT key, laundering the tamper. Every record's canonical bytes are
// now re-hashed and compared against the stored contentHash before
// signing; a mismatch REFUSES the write, is counted separately
// (`mismatched`, never folded into `failed`), and is named in a warning --
// this is the one place in this script a record's name/id is deliberately
// surfaced, because "which record is compromised" is exactly the
// information an operator needs to act on this. The CLI exits non-zero
// when `mismatched > 0`.
//
// Fix round 1, IMPORTANT #2 (controller ruling): both passes are
// failure-contained per record, not merely interrupt-safe. Earlier, one
// record whose content failed parseFlow (or a single failing store write)
// threw out of the whole loop, leaving every later record unprocessed and
// the CLI printing only the raw error with no counts at all. Each
// per-record body is now wrapped in its own try/catch: a throw increments
// `failed`, logs a warning naming the record (id + name -- both are store
// COLUMNS, independent of `content`, so they are always available even
// when `content` itself is what failed to parse), and the pass continues
// to the next record. Combined with each pass's existing idempotency
// (already-correct records are never rewritten), a run that hits N failures
// is safe to re-run after the underlying data problem is fixed -- the
// stragglers are picked up, nothing already-correct is redone. The CLI
// exits non-zero when `failed > 0`, same as `mismatched > 0`.

import { createHash, createPrivateKey } from 'node:crypto';
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
// counts-and-duration summary out; no env, no process, no console). Both
// are interrupt-safe (already-correct records are never rewritten, so a
// re-run after a partial run only touches what's left) AND
// failure-contained (one bad record's error never stops the rest from
// being processed) -- see this file's Fix round 1 top comment for the
// reproduced failure both properties fix. ---

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function warningFor(record, detail) {
  return `id=${record.id} name=${record.name ?? '(unknown)'} -- ${detail}`;
}

// Re-signs every canonical under `signer` (registry/lib/signing.mjs's
// `sign`, bound to a private key, same {sign(bytes) -> base64} shape
// server.mjs's boot() wires into ingest). CRITICAL serialization rule
// (registry/lib/ingest.mjs's own top comment, carried forward here
// unchanged): canonical bytes are ALWAYS recomputed via
// serializeFlow(parseFlow(record.content)), never a raw JSON.stringify of
// whatever shape a jsonb round trip left `content` in.
//
// Before signing anything, this recomputes sha256(canonicalBytes) and
// compares it against the record's own stored `contentHash` -- exactly
// ingest's step-2 check, run again here because re-signing is the one
// moment the trust chain is re-minted (see Fix round 1 #1 above). A
// mismatch means `content` and `contentHash` have drifted apart (a direct
// DB edit, a bug, tampering) and is REFUSED, not signed: counted as
// `mismatched`, named in a warning, and left alone for an operator to
// investigate -- the OLD (still-valid-under-the-OLD-key) signature is left
// in place rather than either signing stale/tampered bytes under the new
// key or silently dropping the record.
//
// A record whose signature already verifies against the current key is
// skipped (not rewritten) -- the idempotency property a second `--re-sign`
// run after a successful one depends on.
export async function runReSignPass({ store, signer }) {
  const startedAt = Date.now();
  const records = await store.list({});
  let updated = 0;
  let mismatched = 0;
  let failed = 0;
  const warnings = [];
  for (const record of records) {
    try {
      const flow = parseFlow(record.content);
      const canonicalBytes = serializeFlow(flow);
      const computedHash = sha256Hex(canonicalBytes);
      if (computedHash !== record.contentHash) {
        mismatched += 1;
        warnings.push(warningFor(record, `contentHash mismatch (stored ${record.contentHash}, recomputed ${computedHash}) -- refusing to re-sign`));
        continue;
      }
      const newSignature = signer.sign(canonicalBytes);
      if (newSignature !== record.signature) {
        await store.updateSignature(record.id, newSignature);
        updated += 1;
      }
    } catch (error) {
      failed += 1;
      warnings.push(warningFor(record, `failed to re-sign: ${error.message}`));
    }
  }
  return {
    scanned: records.length, updated, mismatched, failed, warnings, durationMs: Date.now() - startedAt,
  };
}

// Backfills the embedding of every canonical whose stored embedding is
// null, using `embedder` (registry/lib/embedder.mjs's createEmbedder
// output: an `async (text) -> Float64Array | null` function) over the
// SAME text construction registry/lib/ingest.mjs uses for every push --
// imported from there (embedTextFor) rather than re-derived, so the two
// can never drift apart on the `description + ' | ' + stepSignature`
// contract. A per-record embedder degrade (the production embedder never
// throws; see registry/lib/embedder.mjs -- a failure surfaces as a `null`
// return) is counted as `skipped` and the pass continues; a per-record
// EXCEPTION (e.g. parseFlow failing on corrupted content) is counted as
// `failed`, named in a warning, and the pass also continues (Fix round 1
// #2) -- neither ever aborts the whole run. Only null-embedding records are
// ever scanned or written, which is what makes a second run idempotent:
// already-filled records are never touched, and a `skipped` or `failed`
// record (still null either way) is retried, not silently abandoned, on
// the next run.
export async function runBackfillPass({ store, embedder }) {
  const startedAt = Date.now();
  const records = (await store.list({})).filter((record) => record.embedding === null);
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const warnings = [];
  for (const record of records) {
    try {
      const flow = parseFlow(record.content);
      const text = embedTextFor(flow);
      const embedding = await embedder(text);
      if (!embedding) {
        skipped += 1;
        continue;
      }
      await store.updateEmbedding(record.id, Array.from(embedding));
      updated += 1;
    } catch (error) {
      failed += 1;
      warnings.push(warningFor(record, `failed to backfill: ${error.message}`));
    }
  }
  return {
    scanned: records.length, updated, skipped, failed, warnings, durationMs: Date.now() - startedAt,
  };
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
// updated, mismatched?, skipped?, failed, warnings, durationMs }] }>
// Every summary is counts, a duration, and (Fix round 1) a `warnings` array
// naming any record that was refused (`mismatched`, --re-sign only) or
// threw (`failed`, both actions) -- record names/ids are deliberately
// surfaced ONLY in those two cases, never for an ordinary successful
// update. DATABASE_URL and REGISTRY_SIGNING_KEY are never echoed; a pg
// connection/init failure's message is passed through
// redactConnectionString (registry/server.mjs, the same helper boot()
// uses) before it can ever reach a caller.
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
  if (summary.action === 're-sign') parts.push(`mismatched ${summary.mismatched}`);
  if (summary.action === 'backfill-embeddings') parts.push(`skipped ${summary.skipped}`);
  parts.push(`failed ${summary.failed}`);
  return `[${summary.action}] ${parts.join(', ')} (${summary.durationMs}ms)`;
}

// True when any action reported a refused contentHash mismatch
// (--re-sign only) or a per-record failure (either action) -- Fix round 1's
// exit-non-zero signal. Exported so a test can assert this decision
// directly against a summary, rather than only through a spawned
// subprocess's numeric exit code.
export function needsAttention(actions) {
  return actions.some((action) => (action.mismatched ?? 0) > 0 || (action.failed ?? 0) > 0);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  runMaintenance()
    .then(({ actions }) => {
      console.log('fast-browser-registry maintain');
      console.log('');
      for (const action of actions) {
        console.log(formatAction(action));
        for (const warning of action.warnings) {
          console.log(`  ! ${warning}`);
        }
      }
      console.log('');
      if (needsAttention(actions)) {
        console.log('MAINTENANCE COMPLETED WITH ISSUES -- mismatched and/or failed records need attention, see warnings above');
        process.exitCode = 1;
      } else {
        console.log('MAINTENANCE COMPLETE');
      }
    })
    .catch((error) => {
      console.error(`fast-browser-registry maintain: ${error.message}`);
      process.exitCode = 1;
    });
}
