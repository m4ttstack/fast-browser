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

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
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
    async init() {
      byId.clear();
      byContentHash.clear();
    },

    async putCanonical(record) {
      const stored = structuredClone({ ...record, embedding: toEmbedding(record.embedding) });
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
