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

export const STORE_METHODS = Object.freeze([
  'init',
  'putCanonical',
  'findByContentHash',
  'findClusterCandidates',
  'get',
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

// Selects a store implementation by driver name. 'memory' is the only
// driver Task 1 ships; 'pg' arrives in Task 4 (Postgres + pgvector,
// registry/lib/pg-store.mjs). Keeping the factory here (rather than having
// callers import memory-store.mjs directly) gives server.mjs (Task 3) one
// place to add the 'pg' branch without touching any other call site.
export async function createStore(driver = 'memory', options = {}) {
  if (driver === 'memory') {
    const { createMemoryStore } = await import('./memory-store.mjs');
    return assertStoreShape(createMemoryStore(options));
  }
  throw new Error(`unknown or not-yet-implemented store driver: ${driver}`);
}
