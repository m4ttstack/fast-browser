// In-memory implementation of the registry store interface (registry/lib/
// store.mjs). Used by every registry test suite and, per the plan, honest
// enough to run the whole API without Postgres -- it implements both
// search modes for real (cosine over stored embeddings; lexical substring
// scoring), not stubs.
//
// Storage: a single Map keyed by record.id, plus a Map keyed by
// contentHash for the exact-dedup lookup (both point at the same stored
// record object). Every value that crosses the store boundary -- in via
// putCanonical, out via get/list/search/findByContentHash/
// findClusterCandidates -- is structuredClone'd, so callers can freely
// mutate what they receive (e.g. the ingest pipeline appending a locator
// alternate before calling putCanonical again) without corrupting the
// store's own state, and the store's internal state can never be corrupted
// by a caller mutating a record it already stored.

import { EmbeddingDimensionMismatchError, TOP_RESULTS } from './store.mjs';
import { lexicalScore, queryTermsFrom } from './lexical-score.mjs';

// Re-exported for backward compatibility: existing imports of this error
// class from memory-store.mjs keep working now that its canonical home is
// store.mjs (registry/lib/store.mjs), shared with pg-store.mjs.
export { EmbeddingDimensionMismatchError };

function cosineSimilarity(a, b) {
  if (a.length !== b.length) {
    throw new EmbeddingDimensionMismatchError(a.length, b.length);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function toEmbedding(value) {
  if (value === null || value === undefined) return null;
  return Float64Array.from(value);
}

export function createMemoryStore() {
  const byId = new Map();
  const byContentHash = new Map();

  return {
    // Idempotent by construction: the Maps above are created once, when
    // createMemoryStore() is called, and live for the store's whole
    // lifetime. init() itself does no destructive reset -- there is
    // nothing to migrate for an in-memory store, and a caller that calls
    // init() more than once (matching pg-store's migration-on-boot
    // contract) must never lose records already written.
    async init() {},

    async putCanonical(record) {
      const stored = structuredClone({ ...record, embedding: toEmbedding(record.embedding) });
      const previous = byId.get(stored.id);
      // Upserting an existing id with a NEW contentHash (exactly what
      // cluster-merge does on every collapse: re-put the same canonical id
      // with a refreshed content/hash) must retire the old hash entry --
      // otherwise findByContentHash keeps resolving the old hash to a
      // stale snapshot of a record that has since moved on.
      if (previous && previous.contentHash !== stored.contentHash) {
        byContentHash.delete(previous.contentHash);
      }
      byId.set(stored.id, stored);
      byContentHash.set(stored.contentHash, stored);
      return structuredClone(stored);
    },

    async findByContentHash(hash) {
      const found = byContentHash.get(hash);
      return found ? structuredClone(found) : null;
    },

    async findClusterCandidates({ origin, opSequence }) {
      const candidates = [...byId.values()]
        .filter((record) => record.origin === origin && record.opSequence === opSequence)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return candidates.map((record) => structuredClone(record));
    },

    async get(id) {
      const found = byId.get(id);
      return found ? structuredClone(found) : null;
    },

    // MAT-160 Task 2: targeted write of exactly `signature`, never
    // `updatedAt` (registry/lib/store.mjs's interface doc explains why).
    // Mutates the same stored object both byId and byContentHash point at
    // -- since a signature change never changes contentHash, the
    // byContentHash entry stays valid with no separate bookkeeping needed.
    async updateSignature(id, signature) {
      const found = byId.get(id);
      if (!found) return null;
      found.signature = signature;
      return structuredClone(found);
    },

    // MAT-160 Task 2: targeted write of exactly `embedding`, never
    // `updatedAt`. Same in-place-mutation reasoning as updateSignature
    // above.
    async updateEmbedding(id, embedding) {
      const found = byId.get(id);
      if (!found) return null;
      found.embedding = toEmbedding(embedding);
      return structuredClone(found);
    },

    async list({ since, origin } = {}) {
      let records = [...byId.values()];
      if (origin) records = records.filter((record) => record.origin === origin);
      if (since) records = records.filter((record) => record.updatedAt >= since);
      // Tie-break by id ascending (WS4b Task 6 ledger finding, carried
      // forward from Task 4): updatedAt alone is not a total order --
      // multiple records can share the exact same updatedAt (a batch
      // push, or two fixtures with hand-pinned timestamps in tests), and
      // sorting on updatedAt alone leaves their relative order to
      // whatever this Map happened to iterate them in (insertion order,
      // here) -- which pg-store's own heap-scan order does NOT agree
      // with. GET /v1/pull's result order must be store-independent, so
      // both stores add the SAME deterministic second key.
      records.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
      return records.map((record) => structuredClone(record));
    },

    async search({ embedding, intentText, origin } = {}) {
      let scoped = [...byId.values()];
      if (origin) scoped = scoped.filter((record) => record.origin === origin);

      if (embedding) {
        const query = toEmbedding(embedding);
        // Fix round 1, IMPORTANT #2 (controller ruling): a non-positive
        // cosine (orthogonal or anti-aligned) is no-signal and is excluded
        // outright -- mirrors lexical mode's own `score > 0` filter below.
        // Before this fix, e.g. an anti-aligned stored embedding rode all
        // the way to the wire as `score: -1`, contradicting the plan's
        // documented "score": 0-1.
        const scored = scoped
          .filter((record) => record.embedding)
          .map((record) => ({ record: structuredClone(record), score: cosineSimilarity(query, record.embedding) }))
          .filter(({ score }) => score > 0);
        // MAT-160 Task 4 (determinism sweep): score DESC, name ASC is
        // still not a TOTAL order -- two records can share both the exact
        // same score AND the exact same name (the same flow name pushed
        // from two different origins, or two fixtures with a forced tie
        // in tests). id ASC is the final tie-break, matching the SAME
        // discipline list()'s own updatedAt/id tie-break already applies,
        // and pg-store.mjs's identical addition (both stores must agree,
        // not just each independently be deterministic).
        scored.sort((a, b) => b.score - a.score
          || a.record.name.localeCompare(b.record.name)
          || a.record.id.localeCompare(b.record.id));
        return { mode: 'semantic', results: scored.slice(0, TOP_RESULTS) };
      }

      const queryTerms = queryTermsFrom(intentText);
      const scored = scoped
        .map((record) => ({ record: structuredClone(record), score: lexicalScore(record, queryTerms) }))
        .filter(({ score }) => score > 0);
      // Same id ASC final tie-break as the semantic branch above.
      scored.sort((a, b) => b.score - a.score
        || a.record.name.localeCompare(b.record.name)
        || a.record.id.localeCompare(b.record.id));
      return { mode: 'lexical', results: scored.slice(0, TOP_RESULTS) };
    },

    async health() {
      return { ok: true, count: byId.size };
    },
  };
}
