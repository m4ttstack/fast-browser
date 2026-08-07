// The registry store interface (WS4b plan, Shared shapes). Every store
// implementation -- memory-store.mjs (tests, and honest enough to run the
// whole API without Postgres) and, from Task 4, pg-store.mjs (production,
// Postgres + pgvector) -- implements this identically, so the ingest
// pipeline (Task 5) and the HTTP layer (Tasks 3/6) never branch on which
// backend is live.
//
// A store owns no business logic: it persists and queries exactly what it
// is given. Identity fields (stepSignature/opSequence, see
// signature-fields.mjs), content hashing, PII linting, clustering
// decisions, and signing all live upstream in the ingest pipeline -- the
// store's job is CRUD plus two read shapes (cluster-candidate prefilter,
// search).
//
// Every method is async (returns a Promise) even in the in-memory
// implementation, so calling code never has to special-case which backend
// it is talking to.
//
//   init()
//     -> Promise<void>
//     Prepares the store for use (e.g. runs migrations for pg-store;
//     create-if-absent, no-op-if-already-there for memory-store). MUST be
//     idempotent: safe to call more than once against the same backing
//     store WITHOUT dropping existing records -- pg-store's init() runs
//     migrations, never a destructive reset, and every store implementation
//     must honor that same contract.
//
//   putCanonical(record)
//     -> Promise<Record>
//     Upserts `record` keyed by `record.id`: inserts if the id is new,
//     replaces the stored record wholesale if the id already exists. Does
//     NOT compute or default any field (id, timestamps, hashes, ...) --
//     the caller (ingest) is responsible for a fully-formed record. Never
//     returns a live reference the caller could mutate to corrupt store
//     state.
//
//   findByContentHash(hash)
//     -> Promise<Record|null>
//     Exact-dedup lookup: the ingest pipeline's first check on every push.
//
//   findClusterCandidates({ origin, opSequence })
//     -> Promise<Record[]>
//     The clustering pre-filter: every canonical record with an EXACT
//     match on both origin and opSequence (cheap, index-friendly), before
//     the ingest pipeline does the more expensive cosine-similarity pass
//     over this narrowed set.
//
//   get(id)
//     -> Promise<Record|null>
//
//   updateSignature(id, signature)
//     -> Promise<Record|null>
//     MAT-160 Task 2 (registry maintenance script) addition: a TARGETED
//     write of exactly the `signature` column/field, for id -- returns the
//     updated record, or null if id is unknown. Deliberately narrower than
//     putCanonical's wholesale upsert-and-replace: a key-rotation re-sign
//     pass (registry/scripts/maintain.mjs) must refresh a canonical's
//     signature WITHOUT bumping `updatedAt`, since bumping it would make
//     every client's next GET /v1/pull?since= re-emit the entire registry
//     on the next rotation for no content reason. Every other field
//     (content, contentHash, embedding, mergedCount, createdAt, updatedAt)
//     is left untouched.
//
//   updateEmbedding(id, embedding)
//     -> Promise<Record|null>
//     MAT-160 Task 2 addition, same rationale as updateSignature above: a
//     TARGETED write of exactly the `embedding` column/field (Float64Array
//     | array | null), for id -- returns the updated record, or null if id
//     is unknown, and never bumps `updatedAt`. Used by the embedding
//     backfill pass (registry/scripts/maintain.mjs) to fill a previously-
//     null embedding without touching sync-pull ordering.
//
//   list({ since, origin })
//     -> Promise<Record[]>
//     `since` filters on updatedAt (inclusive) -- the sync-pull semantics
//     (GET /v1/pull?since=). `origin` filters exactly. Both filters are
//     optional; omitting both lists everything. Results are sorted
//     ascending by updatedAt.
//
//   search({ embedding, intentText, origin })
//     -> Promise<{ mode: 'semantic' | 'lexical', results: [{ record, score }] }>
//     Semantic mode (embedding provided): cosine similarity against each
//     record's stored embedding, records with no embedding excluded.
//     Lexical mode (embedding omitted): substring/term-overlap scoring
//     over name + description. Either mode: optional origin filter,
//     descending score, top 5.
//
//   health()
//     -> Promise<{ ok: boolean, count: number }>
//
// Record shape (plan Shared shapes, verbatim):
//   {
//     id, name, origin, description,
//     stepSignature, opSequence,
//     content,       // the parsed flow artifact (lib/flows/artifact.mjs)
//     contentHash,   // sha256 of the canonical serialized artifact bytes
//     signature,     // base64 Ed25519 over the canonical bytes, or null
//                     // before the service has signed it (Task 3)
//     embedding,     // Float64Array | null
//     mergedCount,   // times a cluster collapsed a duplicate into this one
//     createdAt, updatedAt,
//   }

// Search-mode constants shared by every store implementation (memory-store
// and pg-store), so "top 5" and the dimension-mismatch error type are
// pinned in exactly one place rather than redefined per store.
export const TOP_RESULTS = 5;

// Thrown by memory-store's cosineSimilarity on a dimension mismatch rather
// than silently truncating to the shorter vector -- a silent truncation is
// exactly the mis-bind failure class the WS4a drift harness measured (a
// shorter/longer embedding scoring a false 1.0 against an unrelated vector
// because only their common prefix ever got compared). Two embeddings only
// belong in the same comparison at all if they came from the same model; a
// length mismatch means they didn't, and that must fail loudly, not
// silently degrade the search.
//
// pg-store enforces the same "never truncate, always fail loudly" contract
// structurally instead: its embedding column is a fixed vector(1024), so
// Postgres itself rejects a wrong-width value (at putCanonical/insert time)
// or a wrong-width query vector (at search/compare time) with its own loud
// error naming both dimensions -- pg-store does not raise this class. See
// registry/lib/pg-store.mjs's top-of-file comment for where that structural
// parity (same guarantee, different failure shape) is documented.
export class EmbeddingDimensionMismatchError extends Error {
  constructor(aLength, bLength) {
    super(`embedding dimension mismatch: ${aLength} vs ${bLength}`);
    this.name = 'EmbeddingDimensionMismatchError';
  }
}

export const STORE_METHODS = Object.freeze([
  'init',
  'putCanonical',
  'findByContentHash',
  'findClusterCandidates',
  'get',
  'updateSignature',
  'updateEmbedding',
  'list',
  'search',
  'health',
]);

// Fails loudly (rather than a confusing later TypeError) when a store
// implementation is missing part of the interface -- used by the store's
// own factory below and, from Task 4, by the parameterized store-parity
// suite that runs the same tests against memory-store and pg-store.
export function assertStoreShape(store) {
  for (const method of STORE_METHODS) {
    if (typeof store?.[method] !== 'function') {
      throw new TypeError(`store is missing required method: ${method}`);
    }
  }
  return store;
}

// Selects a store implementation by driver name: 'memory' (Task 1) or 'pg'
// (Task 4, Postgres + pgvector, registry/lib/pg-store.mjs). Keeping the
// factory here (rather than having callers import memory-store.mjs or
// pg-store.mjs directly) gives server.mjs's boot() one place to add a
// driver without touching any other call site -- boot() only ever calls
// createStore(selectStoreDriver(env), { connectionString: env.DATABASE_URL }).
// `options.connectionString` is ignored by the memory driver.
export async function createStore(driver = 'memory', options = {}) {
  if (driver === 'memory') {
    const { createMemoryStore } = await import('./memory-store.mjs');
    return assertStoreShape(createMemoryStore(options));
  }
  if (driver === 'pg') {
    const { createPgStore } = await import('./pg-store.mjs');
    return assertStoreShape(createPgStore(options));
  }
  throw new Error(`unknown or not-yet-implemented store driver: ${driver}`);
}
