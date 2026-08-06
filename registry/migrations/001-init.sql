-- Registry store schema (WS4b Task 4). Applied once by pg-store.mjs's
-- init() boot check, which tracks applied filenames in a schema_migrations
-- table (created by that boot check itself, not by this file) and never
-- reapplies a filename already recorded there -- running this file's SQL
-- a second time against the same database is never attempted by that
-- boot check, but every statement below is still written defensively
-- (IF NOT EXISTS) so a manual re-run stays harmless too.

CREATE EXTENSION IF NOT EXISTS vector;

-- One row per canonical flow record (registry/lib/store.mjs's documented
-- Shared shape). `embedding` is fixed at 1024 dimensions to match
-- voyage-3.5-lite's output width -- Postgres/pgvector enforce that width
-- at INSERT/UPDATE time (a differently-sized embedding is rejected
-- loudly: "expected 1024 dimensions, not N") and at comparison time in a
-- query ("different vector dimensions 1024 and N"). That is the pg-native
-- equivalent of memory-store's EmbeddingDimensionMismatchError check --
-- same "never truncate, always fail loudly" guarantee, enforced
-- structurally instead of in application code. See registry/lib/
-- pg-store.mjs's top-of-file comment for where this parity is documented
-- in code.
CREATE TABLE IF NOT EXISTS canonical_flows (
  id             text PRIMARY KEY,
  name           text NOT NULL,
  origin         text NOT NULL,
  description    text NOT NULL DEFAULT '',
  step_signature text,
  op_sequence    text,
  content        jsonb NOT NULL,
  content_hash   text NOT NULL,
  signature      text,
  embedding      vector(1024),
  merged_count   integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL
);

-- Exact-dedup lookup (store.findByContentHash): a unique index rather than
-- a UNIQUE column constraint, functionally identical either way, but it
-- also means an upsert that changes a row's content_hash (pg-store.mjs's
-- putCanonical, ON CONFLICT (id) DO UPDATE) naturally drops the OLD hash
-- out of this index the moment that row's content_hash column value
-- changes -- Postgres indexes only ever reflect the CURRENT column
-- values, so there is no separate cleanup step, unlike memory-store's
-- byContentHash Map, which has to evict the stale entry itself.
CREATE UNIQUE INDEX IF NOT EXISTS canonical_flows_content_hash_idx
  ON canonical_flows (content_hash);

-- The clustering prefilter (store.findClusterCandidates) and store.list()
-- both filter on origin.
CREATE INDEX IF NOT EXISTS canonical_flows_origin_idx
  ON canonical_flows (origin);

-- Deliberately no ivfflat (or any other approximate) index on `embedding`.
-- v1 scale for this registry is small enough that an exact sequential-scan
-- cosine search (the pgvector `<=>` operator, no supporting index) stays
-- fast, and an exact search is strictly more correct than an approximate
-- one. Revisit with an ivfflat or HNSW index -- and the lossy-recall
-- tradeoff that comes with one -- only once table size actually demands
-- it.
