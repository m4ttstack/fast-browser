import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampEmbedText,
  cosineSimilarity,
  createEncoder,
  encoderRanker,
  MAX_EMBED_TEXT_CHARS,
  MAX_EMBED_TEXTS,
  VOYAGE_API_KEY_ENV,
  VOYAGE_ENDPOINT,
  VOYAGE_MODEL,
  VOYAGE_TIMEOUT_MS,
} from '../../lib/flows/encoder.mjs';

// --- fetch/AbortSignal.timeout stubbing (this module's ONE privilege is
// the global `fetch` -- every test here stubs it, real network is never
// touched) ---

function stubFetch(t, implementation) {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  t.after(() => { globalThis.fetch = original; });
}

function stubAbortTimeout(t, implementation) {
  const original = AbortSignal.timeout;
  AbortSignal.timeout = implementation;
  t.after(() => { AbortSignal.timeout = original; });
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

function voyageBody(vectors) {
  return { data: vectors.map((embedding) => ({ embedding })) };
}

// ============================================================
// createEncoder
// ============================================================

test('createEncoder is inactive/lexical when config.encoder is lexical, even with a key present', () => {
  const encoder = createEncoder({
    config: { encoder: 'lexical' },
    env: { [VOYAGE_API_KEY_ENV]: 'a-real-key' },
  });
  assert.equal(encoder.active, false);
  assert.equal(encoder.kind, 'lexical');
});

test('createEncoder is inactive/lexical when config.encoder is voyage but no env key is present', () => {
  const encoder = createEncoder({ config: { encoder: 'voyage' }, env: {} });
  assert.equal(encoder.active, false);
  assert.equal(encoder.kind, 'lexical');
});

test('createEncoder is inactive/lexical for a missing/malformed config', () => {
  assert.equal(createEncoder({ config: undefined, env: {} }).active, false);
  assert.equal(createEncoder({ config: null, env: {} }).active, false);
  assert.equal(createEncoder({ config: { encoder: 'openai' }, env: {} }).active, false);
});

test('createEncoder is inactive/lexical when the env key is present but empty', () => {
  const encoder = createEncoder({ config: { encoder: 'voyage' }, env: { [VOYAGE_API_KEY_ENV]: '' } });
  assert.equal(encoder.active, false);
});

test('the lexical encoder\'s own embed throws rather than returning fake vectors', async () => {
  const encoder = createEncoder({ config: { encoder: 'lexical' }, env: {} });
  await assert.rejects(() => encoder.embed(['hello']));
});

test('createEncoder is active/voyage when config.encoder is voyage AND the env key is present', () => {
  const encoder = createEncoder({ config: { encoder: 'voyage' }, env: { [VOYAGE_API_KEY_ENV]: 'sk-test' } });
  assert.equal(encoder.active, true);
  assert.equal(encoder.kind, 'voyage');
  assert.equal(typeof encoder.embed, 'function');
});

// ============================================================
// voyage embed -- request shape, response parsing, unit normalization
// ============================================================

test('the active voyage encoder issues the exact pinned request shape', async (t) => {
  let capturedUrl = null;
  let capturedInit = null;
  stubFetch(t, async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse(voyageBody([[1, 0, 0], [0, 1, 0]]));
  });

  const encoder = createEncoder({ config: { encoder: 'voyage' }, env: { [VOYAGE_API_KEY_ENV]: 'sk-live-123' } });
  await encoder.embed(['find the checkout button', 'place order button']);

  assert.equal(capturedUrl, VOYAGE_ENDPOINT);
  assert.equal(capturedUrl, 'https://api.voyageai.com/v1/embeddings');
  assert.equal(capturedInit.method, 'POST');
  assert.equal(capturedInit.headers.Authorization, 'Bearer sk-live-123');
  const body = JSON.parse(capturedInit.body);
  assert.deepEqual(body.input, ['find the checkout button', 'place order button']);
  assert.equal(body.model, VOYAGE_MODEL);
  assert.equal(VOYAGE_MODEL, 'voyage-3.5-lite');
  assert.ok(capturedInit.signal instanceof AbortSignal, 'a real AbortSignal must be attached');
});

test('the voyage request wires AbortSignal.timeout with the pinned 5000ms bound', async (t) => {
  let capturedMs = null;
  stubAbortTimeout(t, (ms) => {
    capturedMs = ms;
    return new AbortController().signal;
  });
  stubFetch(t, async () => jsonResponse(voyageBody([[1, 0]])));

  const encoder = createEncoder({ config: { encoder: 'voyage' }, env: { [VOYAGE_API_KEY_ENV]: 'sk-live-123' } });
  await encoder.embed(['one text']);

  assert.equal(capturedMs, 5000);
  assert.equal(VOYAGE_TIMEOUT_MS, 5000);
});

test('voyage embed returns unit-normalized vectors, one per input text, same order', async (t) => {
  stubFetch(t, async () => jsonResponse(voyageBody([[3, 4, 0], [0, 0, 5]])));
  const encoder = createEncoder({ config: { encoder: 'voyage' }, env: { [VOYAGE_API_KEY_ENV]: 'sk-live' } });

  const vectors = await encoder.embed(['a', 'b']);
  assert.equal(vectors.length, 2);
  for (const vector of vectors) {
    assert.ok(vector instanceof Float64Array);
    let sumSquares = 0;
    for (const value of vector) sumSquares += value * value;
    assert.ok(Math.abs(Math.sqrt(sumSquares) - 1) < 1e-9, `vector norm should be ~1, got ${Math.sqrt(sumSquares)}`);
  }
  // [3,4,0] normalized is [0.6, 0.8, 0]
  assert.ok(Math.abs(vectors[0][0] - 0.6) < 1e-9);
  assert.ok(Math.abs(vectors[0][1] - 0.8) < 1e-9);
  // [0,0,5] normalized is [0,0,1]
  assert.ok(Math.abs(vectors[1][2] - 1) < 1e-9);
});

// ============================================================
// voyage embed -- every failure mode throws (caller degrades)
// ============================================================

test('embed throws on a non-200 response', async (t) => {
  stubFetch(t, async () => jsonResponse({}, { ok: false, status: 500 }));
  const encoder = createEncoder({ config: { encoder: 'voyage' }, env: { [VOYAGE_API_KEY_ENV]: 'sk-live' } });
  await assert.rejects(() => encoder.embed(['x']), /HTTP 500/);
});

test('embed throws on a malformed response body (missing data array)', async (t) => {
  stubFetch(t, async () => jsonResponse({ notData: [] }));
  const encoder = createEncoder({ config: { encoder: 'voyage' }, env: { [VOYAGE_API_KEY_ENV]: 'sk-live' } });
  await assert.rejects(() => encoder.embed(['x']));
});

test('embed throws on a response whose embedding count does not match the request', async (t) => {
  stubFetch(t, async () => jsonResponse(voyageBody([[1, 0]]))); // one text requested below is two
  const encoder = createEncoder({ config: { encoder: 'voyage' }, env: { [VOYAGE_API_KEY_ENV]: 'sk-live' } });
  await assert.rejects(() => encoder.embed(['x', 'y']));
});

test('embed throws on a response entry with no embedding array', async (t) => {
  stubFetch(t, async () => jsonResponse({ data: [{ embedding: null }] }));
  const encoder = createEncoder({ config: { encoder: 'voyage' }, env: { [VOYAGE_API_KEY_ENV]: 'sk-live' } });
  await assert.rejects(() => encoder.embed(['x']));
});

test('embed throws when the response body is not valid JSON', async (t) => {
  stubFetch(t, async () => ({
    ok: true,
    status: 200,
    json: async () => { throw new Error('Unexpected token'); },
  }));
  const encoder = createEncoder({ config: { encoder: 'voyage' }, env: { [VOYAGE_API_KEY_ENV]: 'sk-live' } });
  await assert.rejects(() => encoder.embed(['x']));
});

// A real timeout firing is `AbortSignal.timeout`'s own rejection of the
// fetch it's attached to -- simulated here by having the stubbed fetch
// itself reject with an AbortError, exactly what a real timeout produces,
// without this test actually waiting 5000ms.
test('embed throws when the request times out (fetch rejects with an AbortError)', async (t) => {
  stubFetch(t, async () => {
    const error = new Error('This operation was aborted');
    error.name = 'AbortError';
    throw error;
  });
  const encoder = createEncoder({ config: { encoder: 'voyage' }, env: { [VOYAGE_API_KEY_ENV]: 'sk-live' } });
  await assert.rejects(() => encoder.embed(['x']));
});

test('embed throws when fetch itself rejects (network error)', async (t) => {
  stubFetch(t, async () => { throw new Error('getaddrinfo ENOTFOUND'); });
  const encoder = createEncoder({ config: { encoder: 'voyage' }, env: { [VOYAGE_API_KEY_ENV]: 'sk-live' } });
  await assert.rejects(() => encoder.embed(['x']));
});

// ============================================================
// clampEmbedText / MAX_EMBED_TEXTS / MAX_EMBED_TEXT_CHARS
// ============================================================

test('clampEmbedText truncates to MAX_EMBED_TEXT_CHARS and passes short text through unchanged', () => {
  assert.equal(clampEmbedText('short'), 'short');
  const long = 'x'.repeat(MAX_EMBED_TEXT_CHARS + 500);
  const clamped = clampEmbedText(long);
  assert.equal(clamped.length, MAX_EMBED_TEXT_CHARS);
  assert.equal(MAX_EMBED_TEXT_CHARS, 2000);
});

test('clampEmbedText tolerates a non-string value', () => {
  assert.equal(clampEmbedText(undefined), '');
  assert.equal(clampEmbedText(null), '');
});

// ============================================================
// cosineSimilarity
// ============================================================

test('cosineSimilarity of identical unit vectors is 1', () => {
  const a = new Float64Array([1, 0, 0]);
  assert.equal(cosineSimilarity(a, a), 1);
});

test('cosineSimilarity of orthogonal unit vectors is 0', () => {
  const a = new Float64Array([1, 0, 0]);
  const b = new Float64Array([0, 1, 0]);
  assert.equal(cosineSimilarity(a, b), 0);
});

// ============================================================
// encoderRanker -- heal-side ranking (rankCandidates-compatible shape)
// ============================================================

function healCandidate(overrides = {}) {
  return { role: '', name: '', testid: '', text: '', ...overrides };
}

test('encoderRanker embeds target text (description+name) plus each candidate\'s name+text, in order', async (t) => {
  let capturedTexts = null;
  stubFetch(t, async (url, init) => {
    capturedTexts = JSON.parse(init.body).input;
    return jsonResponse(voyageBody(capturedTexts.map(() => [1, 0])));
  });
  const encoder = createEncoder({ config: { encoder: 'voyage' }, env: { [VOYAGE_API_KEY_ENV]: 'sk-live' } });
  const ranker = encoderRanker(encoder);

  const candidates = [
    healCandidate({ name: 'Place order', text: 'Place order button' }),
    healCandidate({ name: 'Cancel', text: 'Cancel order' }),
  ];
  await ranker({ target: { description: 'Place the order', name: 'Place order' }, candidates });

  assert.deepEqual(capturedTexts, [
    'Place the order Place order',
    'Place order Place order button',
    'Cancel Cancel order',
  ]);
});

test('encoderRanker returns [{index, score}] sorted desc by cosine similarity to the target', async (t) => {
  stubFetch(t, async () => jsonResponse(voyageBody([
    [1, 0], // target
    [0, 1], // candidate 0: orthogonal -- worst match
    [1, 0], // candidate 1: identical -- best match
  ])));
  const encoder = createEncoder({ config: { encoder: 'voyage' }, env: { [VOYAGE_API_KEY_ENV]: 'sk-live' } });
  const ranker = encoderRanker(encoder);

  const candidates = [healCandidate({ name: 'off-topic' }), healCandidate({ name: 'on-topic' })];
  const ranked = await ranker({ target: { description: 'topic', name: '' }, candidates });

  assert.deepEqual(ranked.map((entry) => entry.index), [1, 0]);
  assert.ok(ranked[0].score > ranked[1].score);
});

test('encoderRanker returns [] for no candidates without ever calling embed', async (t) => {
  let called = false;
  stubFetch(t, async () => { called = true; return jsonResponse(voyageBody([])); });
  const encoder = createEncoder({ config: { encoder: 'voyage' }, env: { [VOYAGE_API_KEY_ENV]: 'sk-live' } });
  const ranker = encoderRanker(encoder);

  const ranked = await ranker({ target: {}, candidates: [] });
  assert.deepEqual(ranked, []);
  assert.equal(called, false);
});

// --- clamping contract, pinned at this exact call site ---

test('encoderRanker clamps the embed batch to MAX_EMBED_TEXTS total texts (target + at most 31 candidates)', async (t) => {
  let capturedTexts = null;
  stubFetch(t, async (url, init) => {
    capturedTexts = JSON.parse(init.body).input;
    return jsonResponse(voyageBody(capturedTexts.map(() => [1, 0])));
  });
  const encoder = createEncoder({ config: { encoder: 'voyage' }, env: { [VOYAGE_API_KEY_ENV]: 'sk-live' } });
  const ranker = encoderRanker(encoder);

  const candidates = Array.from({ length: 40 }, (_, i) => healCandidate({ name: `candidate-${i}` }));
  const ranked = await ranker({ target: { description: 'target', name: '' }, candidates });

  assert.equal(capturedTexts.length, MAX_EMBED_TEXTS);
  assert.equal(MAX_EMBED_TEXTS, 32);
  // Every input candidate must still appear in the output (Shared shapes:
  // every index is represented), even the 9 that didn't fit in the batch.
  assert.equal(ranked.length, 40);
  // The clamped-out candidates (indices 31..39) sort last, never dropped.
  const clampedOutIndexes = new Set(Array.from({ length: 9 }, (_, i) => i + 31));
  const lastNine = ranked.slice(-9).map((entry) => entry.index);
  for (const index of lastNine) assert.ok(clampedOutIndexes.has(index));
});

test('encoderRanker clamps each individual text to MAX_EMBED_TEXT_CHARS characters', async (t) => {
  let capturedTexts = null;
  stubFetch(t, async (url, init) => {
    capturedTexts = JSON.parse(init.body).input;
    return jsonResponse(voyageBody(capturedTexts.map(() => [1, 0])));
  });
  const encoder = createEncoder({ config: { encoder: 'voyage' }, env: { [VOYAGE_API_KEY_ENV]: 'sk-live' } });
  const ranker = encoderRanker(encoder);

  const longDescription = 'd'.repeat(3000);
  const longCandidateText = 'c'.repeat(3000);
  await ranker({
    target: { description: longDescription, name: '' },
    candidates: [healCandidate({ name: '', text: longCandidateText })],
  });

  for (const text of capturedTexts) {
    assert.ok(text.length <= MAX_EMBED_TEXT_CHARS, `text length ${text.length} exceeds the ${MAX_EMBED_TEXT_CHARS} clamp`);
  }
});
