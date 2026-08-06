// Postgres + pgvector implementation of the registry store interface
// (registry/lib/store.mjs). Production driver behind registry/server.mjs's
// store-driver seam (DATABASE_URL present -> 'pg'); registry/tests/
// pg-store.test.mjs runs the exact same parity suite memory-store.test.mjs
// does (registry/tests/helpers/store-suite.mjs) against a real database,
// gated on REGISTRY_TEST_DATABASE_URL.
//
// Schema: registry/migrations/001-init.sql (one table, canonical_flows;
// one unique index on content_hash; one index on origin; no ivfflat --
// exact cosine search at v1 scale). init() applies any not-yet-applied
// migration file in registry/migrations/, in filename order, each inside
// its own transaction, and records the filename in a schema_migrations
// table it creates itself on first use -- calling init() again is a
// no-op once every migration file is recorded, matching the store
// interface's "never destructive, safe to call more than once" contract.
//
// Dimension parity with memory-store's EmbeddingDimensionMismatchError
// (registry/lib/store.mjs): memory-store checks embedding dimensions
// pairwise, at comparison time, because it has no fixed width -- two
// records with different-length embeddings can coexist. pg-store's
// `embedding` column is a fixed vector(1024) (registry/migrations/
// 001-init.sql), so Postgres enforces the same "never truncate, always
// fail loudly" guarantee structurally instead: a wrong-width embedding is
// rejected at putCanonical/insert time (pg's own error: "expected 1024
// dimensions, not N"), and a wrong-width query embedding is rejected at
// search/compare time against any row that already has a stored
// embedding ("different vector dimensions 1024 and N"). Both of pg's own
// errors already name both dimensions, so this file lets them propagate
// unwrapped rather than translating them into an EmbeddingDimensionMismatchError
// instance -- that class documents memory-store's specific pairwise check,
// not a store-interface-wide type every implementation must throw.
import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOP_RESULTS } from './store.mjs';
import { lexicalScore, queryTermsFrom } from './lexical-score.mjs';

const { Pool } = pg;

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = join(HERE, '..', 'migrations');

// Bounds how long a boot waits to discover an unreachable Postgres host
// rather than hanging indefinitely (node-postgres's own default is no
// timeout at all) -- deliberately short: a registry boot should fail fast
// and loudly, not stall.
const CONNECTION_TIMEOUT_MILLIS = 5000;

function toIsoString(value) {
  return value instanceof Date ? value.toISOString() : value;
}

// pgvector returns a stored `vector` column as its text literal, e.g.
// "[1,2,3]" -- valid JSON array syntax, so JSON.parse recovers the plain
// number array before it is wrapped in the Float64Array the store
// interface documents (Record shape: `embedding: Float64Array | null`).
function toEmbedding(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return Float64Array.from(JSON.parse(value));
  return Float64Array.from(value);
}

// The inverse: formats an embedding (array or Float64Array) as the
// pgvector text literal a `::vector` cast accepts, or null to store/query
// "no embedding" -- pgvector's own dimension check on the column then
// enforces exactly the parity documented at the top of this file.
function embeddingLiteral(embedding) {
  if (embedding === null || embedding === undefined) return null;
  return `[${Array.from(embedding).join(',')}]`;
}

function rowToRecord(row) {
  return {
    id: row.id,
    name: row.name,
    origin: row.origin,
    description: row.description,
    stepSignature: row.step_signature,
    opSequence: row.op_sequence,
    content: row.content,
    contentHash: row.content_hash,
    signature: row.signature,
    embedding: toEmbedding(row.embedding),
    mergedCount: row.merged_count,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

export function createPgStore(options = {}) {
  const { connectionString, migrationsDir = DEFAULT_MIGRATIONS_DIR } = options;
  const pool = new Pool({ connectionString, connectionTimeoutMillis: CONNECTION_TIMEOUT_MILLIS });

  return {
    // Idempotent per the store interface contract: schema_migrations
    // tracks which migration filenames have already been applied, so a
    // second (or Nth) call in the same process, or a fresh boot against
    // an already-migrated database, applies nothing and never touches
    // existing rows in canonical_flows.
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          filename text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      const { rows: appliedRows } = await pool.query('SELECT filename FROM schema_migrations');
      const applied = new Set(appliedRows.map((row) => row.filename));

      const filenames = (await readdir(migrationsDir))
        .filter((name) => name.endsWith('.sql'))
        .sort();

      // Deliberately sequential (not Promise.all): migrations must apply
      // strictly in filename order, one at a time, never concurrently.
      for (const filename of filenames) {
        if (applied.has(filename)) continue;
        const sql = await readFile(join(migrationsDir, filename), 'utf8');
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      }
    },

    // Upserts by id via ON CONFLICT (id) DO UPDATE SET <every column> --
    // a wholesale replace, matching the store interface's "replaces the
    // stored record wholesale if the id already exists" (does not merge
    // partial fields). The UNIQUE index on content_hash (registry/
    // migrations/001-init.sql) means a hash-changing upsert never leaves
    // a stale findByContentHash entry: Postgres indexes only reflect the
    // row's CURRENT content_hash value, so the old hash simply stops
    // resolving to anything the instant this UPDATE commits.
    async putCanonical(record) {
      const { rows } = await pool.query(
        `INSERT INTO canonical_flows (
           id, name, origin, description, step_signature, op_sequence,
           content, content_hash, signature, embedding, merged_count,
           created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::vector,$11,$12,$13)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           origin = EXCLUDED.origin,
           description = EXCLUDED.description,
           step_signature = EXCLUDED.step_signature,
           op_sequence = EXCLUDED.op_sequence,
           content = EXCLUDED.content,
           content_hash = EXCLUDED.content_hash,
           signature = EXCLUDED.signature,
           embedding = EXCLUDED.embedding,
           merged_count = EXCLUDED.merged_count,
           created_at = EXCLUDED.created_at,
           updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [
          record.id,
          record.name,
          record.origin,
          record.description,
          record.stepSignature,
          record.opSequence,
          record.content,
          record.contentHash,
          record.signature,
          embeddingLiteral(record.embedding),
          record.mergedCount,
          record.createdAt,
          record.updatedAt,
        ],
      );
      return rowToRecord(rows[0]);
    },

    async findByContentHash(hash) {
      const { rows } = await pool.query('SELECT * FROM canonical_flows WHERE content_hash = $1', [hash]);
      return rows[0] ? rowToRecord(rows[0]) : null;
    },

    async findClusterCandidates({ origin, opSequence }) {
      const { rows } = await pool.query(
        'SELECT * FROM canonical_flows WHERE origin = $1 AND op_sequence = $2 ORDER BY created_at ASC',
        [origin, opSequence],
      );
      return rows.map(rowToRecord);
    },

    async get(id) {
      const { rows } = await pool.query('SELECT * FROM canonical_flows WHERE id = $1', [id]);
      return rows[0] ? rowToRecord(rows[0]) : null;
    },

    async list({ since, origin } = {}) {
      const conditions = [];
      const params = [];
      if (origin) {
        params.push(origin);
        conditions.push(`origin = $${params.length}`);
      }
      if (since) {
        params.push(since);
        conditions.push(`updated_at >= $${params.length}`);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const { rows } = await pool.query(
        `SELECT * FROM canonical_flows ${where} ORDER BY updated_at ASC`,
        params,
      );
      return rows.map(rowToRecord);
    },

    // Semantic mode (embedding given): pgvector's `<=>` cosine-distance
    // operator, exact (no ivfflat/HNSW index -- see registry/migrations/
    // 001-init.sql), `1 - distance` recovers cosine similarity, top 5
    // descending. Lexical mode (embedding omitted): ILIKE narrows to rows
    // where name/description contain at least one query term, then this
    // file scores that narrowed set with the SAME lexicalScore function
    // memory-store uses (registry/lib/lexical-score.mjs), so both stores'
    // lexical rankings and score values match exactly, not just "close
    // enough".
    async search({ embedding, intentText, origin } = {}) {
      if (embedding) {
        const params = [embeddingLiteral(embedding)];
        const conditions = ['embedding IS NOT NULL'];
        if (origin) {
          params.push(origin);
          conditions.push(`origin = $${params.length}`);
        }
        const { rows } = await pool.query(
          `SELECT *, 1 - (embedding <=> $1::vector) AS score
           FROM canonical_flows
           WHERE ${conditions.join(' AND ')}
           ORDER BY embedding <=> $1::vector ASC, name ASC
           LIMIT ${TOP_RESULTS}`,
          params,
        );
        return {
          mode: 'semantic',
          results: rows.map((row) => ({ record: rowToRecord(row), score: Number(row.score) })),
        };
      }

      const queryTerms = queryTermsFrom(intentText);
      if (queryTerms.length === 0) {
        // lexicalScore returns 0 for every record when there are no query
        // terms at all, which the >0 filter below would discard anyway --
        // short-circuit rather than fetch every row only to throw it away.
        return { mode: 'lexical', results: [] };
      }

      const params = [];
      const conditions = [];
      if (origin) {
        params.push(origin);
        conditions.push(`origin = $${params.length}`);
      }
      const termConditions = queryTerms.map((term) => {
        params.push(`%${term}%`);
        return `(name || ' ' || description) ILIKE $${params.length}`;
      });
      conditions.push(`(${termConditions.join(' OR ')})`);

      const { rows } = await pool.query(
        `SELECT * FROM canonical_flows WHERE ${conditions.join(' AND ')}`,
        params,
      );
      const scored = rows
        .map(rowToRecord)
        .map((record) => ({ record, score: lexicalScore(record, queryTerms) }))
        .filter(({ score }) => score > 0);
      scored.sort((a, b) => b.score - a.score || a.record.name.localeCompare(b.record.name));
      return { mode: 'lexical', results: scored.slice(0, TOP_RESULTS) };
    },

    async health() {
      const { rows } = await pool.query('SELECT count(*)::int AS count FROM canonical_flows');
      return { ok: true, count: rows[0].count };
    },

    // Not part of STORE_METHODS (registry/lib/store.mjs) -- memory-store
    // has no connection pool to release, but pg-store does, and both
    // server.mjs shutdown and pg-store.test.mjs's teardown need a clean
    // way to end it.
    async close() {
      await pool.end();
    },
  };
}
