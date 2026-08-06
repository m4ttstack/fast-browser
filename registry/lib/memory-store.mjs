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

const TOP_RESULTS = 5;

// Thrown by cosineSimilarity on a dimension mismatch rather than silently
// truncating to the shorter vector -- a silent truncation is exactly the
// mis-bind failure class the WS4a drift harness measured (a shorter/longer
// embedding scoring a false 1.0 against an unrelated vector because only
// their common prefix ever got compared). Two embeddings only belong in the
// same comparison at all if they came from the same model; a length
// mismatch means they didn't, and that must fail loudly, not silently
// degrade the search.
export class EmbeddingDimensionMismatchError extends Error {
  constructor(aLength, bLength) {
    super(`embedding dimension mismatch: ${aLength} vs ${bLength}`);
    this.name = 'EmbeddingDimensionMismatchError';
  }
}

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

// Term-overlap scoring over `name + description`: the fraction of the
// (lowercased, whitespace-split) query terms that appear as a substring of
// the haystack. 0 when nothing matches (excluded from results), up to 1
// when every query term is present. Simple and honest rather than a real
// text-search ranking -- this is the keyless fallback the plan documents
// as clearly-marked 'lexical' mode, not a semantic replacement.
function lexicalScore(record, queryTerms) {
  if (queryTerms.length === 0) return 0;
  const haystack = `${record.name} ${record.description}`.toLowerCase();
  const matched = queryTerms.filter((term) => haystack.includes(term)).length;
  return matched / queryTerms.length;
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

    async list({ since, origin } = {}) {
      let records = [...byId.values()];
      if (origin) records = records.filter((record) => record.origin === origin);
      if (since) records = records.filter((record) => record.updatedAt >= since);
      records.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      return records.map((record) => structuredClone(record));
    },

    async search({ embedding, intentText, origin } = {}) {
      let scoped = [...byId.values()];
      if (origin) scoped = scoped.filter((record) => record.origin === origin);

      if (embedding) {
        const query = toEmbedding(embedding);
        const scored = scoped
          .filter((record) => record.embedding)
          .map((record) => ({ record: structuredClone(record), score: cosineSimilarity(query, record.embedding) }));
        scored.sort((a, b) => b.score - a.score || a.record.name.localeCompare(b.record.name));
        return { mode: 'semantic', results: scored.slice(0, TOP_RESULTS) };
      }

      const queryTerms = (intentText ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const scored = scoped
        .map((record) => ({ record: structuredClone(record), score: lexicalScore(record, queryTerms) }))
        .filter(({ score }) => score > 0);
      scored.sort((a, b) => b.score - a.score || a.record.name.localeCompare(b.record.name));
      return { mode: 'lexical', results: scored.slice(0, TOP_RESULTS) };
    },

    async health() {
      return { ok: true, count: byId.size };
    },
  };
}
