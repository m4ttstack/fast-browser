import assert from 'node:assert/strict';
import test from 'node:test';

import { createEmbedder, VOYAGE_ENDPOINT, VOYAGE_TIMEOUT_MS } from '../lib/embedder.mjs';
import { EMBED_DIM, EMBED_MODEL } from '../lib/constants.mjs';

// registry/lib/embedder.mjs (WS4b plan, Task 5). This module's ONE
// privilege is the global `fetch` -- every test here stubs it, real
// network is never touched.

// A well-formed embedding: exactly EMBED_DIM finite numbers. Every
// "successful path" test uses this rather than a short hand-rolled
// vector -- fix round 1, Important #4 rejects anything else.
function validEmbedding() {
  return Array.from({ length: EMBED_DIM }, (_, i) => (i === 0 ? 1 : 0));
}

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
  return { ok, status, json: async () => body };
}

test('createEmbedder returns null (not a function) when VOYAGE_API_KEY is absent', () => {
  assert.equal(createEmbedder({ env: {} }), null);
  assert.equal(createEmbedder({ env: undefined }), null);
});

test('createEmbedder returns null when VOYAGE_API_KEY is present but empty', () => {
  assert.equal(createEmbedder({ env: { VOYAGE_API_KEY: '' } }), null);
});

test('createEmbedder returns an embed function when VOYAGE_API_KEY is present', () => {
  const embedder = createEmbedder({ env: { VOYAGE_API_KEY: 'a-real-key' } });
  assert.equal(typeof embedder, 'function');
});

test('the embed function issues the exact pinned request shape', async (t) => {
  let capturedUrl = null;
  let capturedInit = null;
  const embedding = validEmbedding();
  stubFetch(t, async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse({ data: [{ embedding }] });
  });

  const embedder = createEmbedder({ env: { VOYAGE_API_KEY: 'sk-live-123' } });
  const vector = await embedder('place order button | ["goto"]');

  assert.equal(capturedUrl, VOYAGE_ENDPOINT);
  assert.equal(capturedUrl, 'https://api.voyageai.com/v1/embeddings');
  assert.equal(capturedInit.method, 'POST');
  assert.equal(capturedInit.headers.Authorization, 'Bearer sk-live-123');
  const body = JSON.parse(capturedInit.body);
  assert.deepEqual(body.input, ['place order button | ["goto"]']);
  assert.equal(body.model, EMBED_MODEL);
  assert.ok(capturedInit.signal instanceof AbortSignal, 'a real AbortSignal must be attached');
  assert.ok(vector instanceof Float64Array);
  assert.deepEqual(Array.from(vector), embedding);
});

test('the embed function wires AbortSignal.timeout with the pinned 5000ms bound', async (t) => {
  let capturedMs = null;
  stubAbortTimeout(t, (ms) => {
    capturedMs = ms;
    return new AbortController().signal;
  });
  stubFetch(t, async () => jsonResponse({ data: [{ embedding: validEmbedding() }] }));

  const embedder = createEmbedder({ env: { VOYAGE_API_KEY: 'sk-live-123' } });
  await embedder('some text');

  assert.equal(capturedMs, VOYAGE_TIMEOUT_MS);
  assert.equal(VOYAGE_TIMEOUT_MS, 5000);
});

test('a fetch rejection degrades to null, not a throw', async (t) => {
  stubFetch(t, async () => { throw new Error('network is down'); });
  const embedder = createEmbedder({ env: { VOYAGE_API_KEY: 'sk-live-123' } });
  assert.equal(await embedder('some text'), null);
});

test('a non-ok HTTP response degrades to null, not a throw', async (t) => {
  stubFetch(t, async () => jsonResponse({}, { ok: false, status: 500 }));
  const embedder = createEmbedder({ env: { VOYAGE_API_KEY: 'sk-live-123' } });
  assert.equal(await embedder('some text'), null);
});

test('a non-JSON response body degrades to null, not a throw', async (t) => {
  stubFetch(t, async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }));
  const embedder = createEmbedder({ env: { VOYAGE_API_KEY: 'sk-live-123' } });
  assert.equal(await embedder('some text'), null);
});

test('a malformed response body (missing embedding) degrades to null, not a throw', async (t) => {
  stubFetch(t, async () => jsonResponse({ data: [] }));
  const embedder = createEmbedder({ env: { VOYAGE_API_KEY: 'sk-live-123' } });
  assert.equal(await embedder('some text'), null);
});

// Fix round 1, Important #4: a SUCCESSFUL, well-SHAPED (array, non-empty)
// response can still be wrong in a way the pre-fix checks never caught --
// pinned here as their own regression tests.

test('a wrong-width embedding (a model change returning something other than EMBED_DIM) degrades to null, not a throw', async (t) => {
  assert.equal(EMBED_DIM, 1024, 'this test pins behavior against the documented width');
  const wrongWidth = Array.from({ length: 512 }, () => 0.1); // every element finite, just the wrong length
  stubFetch(t, async () => jsonResponse({ data: [{ embedding: wrongWidth }] }));
  const embedder = createEmbedder({ env: { VOYAGE_API_KEY: 'sk-live-123' } });
  assert.equal(await embedder('some text'), null);
});

test('an embedding with a non-numeric element degrades to null, not a NaN-poisoned vector', async (t) => {
  const withStringElement = validEmbedding();
  withStringElement[5] = 'not-a-number';
  stubFetch(t, async () => jsonResponse({ data: [{ embedding: withStringElement }] }));
  const embedder = createEmbedder({ env: { VOYAGE_API_KEY: 'sk-live-123' } });
  assert.equal(await embedder('some text'), null);
});

test('an aborted signal (what firing the pinned 5000ms timeout looks like) degrades to null, not an unhandled rejection', async (t) => {
  // A manually-driven AbortController rather than a real
  // AbortSignal.timeout(5000) -- deterministic and instant, with no
  // dependency on a real timer actually firing (this also proves the
  // module wires WHATEVER signal AbortSignal.timeout returns straight
  // through to fetch, which is the only thing worth pinning here; Node's
  // own timer firing after 5000ms is not this module's code to test).
  const controller = new AbortController();
  stubAbortTimeout(t, () => controller.signal);
  stubFetch(t, async (_url, init) => {
    await new Promise((resolvePromise, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('The operation was aborted')));
    });
  });
  const embedder = createEmbedder({ env: { VOYAGE_API_KEY: 'sk-live-123' } });
  const pending = embedder('some text');
  // By the time embedder()'s call has returned a pending promise, its
  // synchronous prefix (through fetch's stub constructing the Promise
  // whose executor registers the 'abort' listener) has already run --
  // aborting here is not a race.
  controller.abort();
  assert.equal(await pending, null);
});

test('a degraded call never echoes the API key into whatever gets logged', async (t) => {
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  t.after(() => { console.error = originalConsoleError; });

  stubFetch(t, async () => jsonResponse({}, { ok: false, status: 401 }));
  const embedder = createEmbedder({ env: { VOYAGE_API_KEY: 'sk-super-secret-key-value' } });
  await embedder('some text');

  assert.ok(logged.length > 0, 'a warning should have been logged');
  for (const line of logged) {
    assert.ok(!line.includes('sk-super-secret-key-value'), 'the API key must never be logged');
  }
});
