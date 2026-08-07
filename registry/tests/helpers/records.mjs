// Shared record/embedding fixtures for the registry store parity suite
// (registry/tests/helpers/store-suite.mjs), used identically against
// memory-store and pg-store so the exact same test bodies exercise both.

import { createHash } from 'node:crypto';

import { parseFlow, serializeFlow } from '../../../lib/flows/artifact.mjs';
import { opSequence, stepSignature } from '../../lib/signature-fields.mjs';
import { baseFlow } from './fixtures.mjs';

function contentHashOf(flow) {
  return createHash('sha256').update(serializeFlow(flow)).digest('hex');
}

export function sha256Hex(seed) {
  return createHash('sha256').update(seed).digest('hex');
}

// Builds a store record per the plan's Shared shapes: { id, name, origin,
// description, stepSignature, opSequence, content, contentHash, signature,
// embedding, mergedCount, createdAt, updatedAt }.
//
// `idSeed` and `flowOverrides` are HELPER-ONLY inputs that steer how this
// function builds a record -- they are never part of the record shape
// itself (registry/lib/store.mjs's documented shape) and must NOT ride
// along into the stored record. Before parameterization (WS4b Task 1
// review, minor #8), the original memory-store-only version of this
// helper spread `...overrides` last, which meant these two keys landed in
// the object passed to putCanonical. memory-store's Map-backed storage
// silently tolerates unknown keys; pg-store's column-backed INSERT does
// not (there is no idSeed/flowOverrides column) -- destructuring them out
// here, before the final spread, is what makes the exact same fixture
// usable against both stores.
export function makeRecord(overrides = {}) {
  const { idSeed, flowOverrides, ...recordOverrides } = overrides;
  const flow = parseFlow(baseFlow(flowOverrides ?? {}));
  const content = flow;
  return {
    id: sha256Hex(idSeed ?? flow.name),
    name: flow.name,
    origin: flow.origin,
    description: flow.description,
    stepSignature: stepSignature(flow),
    opSequence: opSequence(flow),
    content,
    contentHash: contentHashOf(flow),
    signature: null,
    embedding: null,
    mergedCount: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...recordOverrides,
  };
}

// Builds an embedding array of exactly `dimensions` length (1024 by
// default, matching pg-store's fixed vector(1024) column and
// voyage-3.5-lite's real output width) with `sign` (default 1) at `index`
// and 0 everywhere else. A pair of unitEmbedding calls at different
// indices are orthogonal (cosine similarity 0); the same index with
// sign -1 is anti-parallel to sign 1 (cosine similarity -1); the same
// call twice is parallel (cosine similarity 1) -- so search-ranking tests
// can reason about simple, exact cosine values by hand while still using
// a dimension pg's fixed-width column will actually accept. Memory-store
// does not care about the width at all; using the same 1024-wide vectors
// there too is what lets the ranking tests run unmodified against both
// stores.
export function unitEmbedding(index, { dimensions = 1024, sign = 1 } = {}) {
  const vector = new Array(dimensions).fill(0);
  vector[index] = sign;
  return vector;
}

// Builds a two-nonzero-component embedding (`primaryWeight` at `index`,
// `otherWeight` at `otherIndex`, 0 elsewhere) -- WS4b Task 6 fix round 1,
// IMPORTANT #2: after the score<=0 exclusion filter, a search-ordering
// test that needs MORE THAN ONE surviving positive-scoring result (to
// still prove descending order, not just "one record made it through")
// cannot rely on unitEmbedding alone -- that only ever produces exactly
// cosine 1, 0, or -1 against a matching unitEmbedding query, and 0/-1 are
// now excluded outright. Neither component needs to be unit-normalized
// (cosineSimilarity/pgvector's `<=>` both normalize by each vector's own
// norm internally), so plain small integers keep the resulting cosine
// value exact and easy to reason about by hand.
export function partialEmbedding(index, otherIndex, primaryWeight, otherWeight, { dimensions = 1024 } = {}) {
  const vector = new Array(dimensions).fill(0);
  vector[index] = primaryWeight;
  vector[otherIndex] = otherWeight;
  return vector;
}
