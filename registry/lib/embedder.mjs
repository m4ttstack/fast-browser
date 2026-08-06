// Production Voyage embedder for the registry ingest pipeline (WS4b plan,
// Task 5). Mirrors lib/flows/encoder.mjs's resilience posture -- the same
// endpoint, the same 5000ms AbortSignal.timeout, the same "every failure
// mode is contained, never a hung request" discipline -- WITHOUT importing
// that module: encoder.mjs is the PLUGIN's own leaf module (its own top
// comment pins fetch as its one privilege, scoped to the plugin's own
// callers -- find's rerank stage, heal's ranker); the registry is a
// separate deployable, with its own env var (VOYAGE_API_KEY -- not
// encoder.mjs's FAST_BROWSER_VOYAGE_API_KEY) and its own failure contract,
// described below.
//
// Diverges from encoder.mjs on purpose in exactly one way: encoder.mjs's
// embed() THROWS on every failure (a missing key, a bad response, the
// timeout firing) and leaves "degrade to lexical" up to ITS caller. This
// module's embed function never throws -- it returns `null` on every
// failure mode and logs a message-only warning via console.error (never
// the raw error object, never a request/response body) -- because
// ingest.mjs's contract (WS4b plan, Shared shapes) is that a Voyage
// failure degrades exactly ONE envelope to keyless behavior for that push
// (created with embedding null, clustering skipped for that flow) rather
// than ever failing the whole push. Reasons on the push response are
// reserved for 'rejected' outcomes only -- a degraded embed is never one
// of them, so it is surfaced server-side only, never on the wire.
//
// LEAF module, same privilege boundary as encoder.mjs: the only I/O is the
// global `fetch`, gated behind the same 5000ms AbortSignal.timeout. Tests
// stub globalThis.fetch; this module never makes a real network request
// under `npm test`.

import { EMBED_MODEL } from './constants.mjs';

export const VOYAGE_ENDPOINT = 'https://api.voyageai.com/v1/embeddings';
export const VOYAGE_TIMEOUT_MS = 5000;

// One text in, one embedding out -- ingest.mjs's own contract is one push
// envelope, one candidate embedding, one canonical-refresh embedding,
// never a batch. Throws on any failure; createEmbedder's returned function
// (below) is the layer that catches and degrades to null.
async function voyageEmbed(text, key) {
  let response;
  try {
    response = await fetch(VOYAGE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ input: [text], model: EMBED_MODEL }),
      // 5000ms hard timeout (Shared shapes, pinned exactly, mirrors
      // encoder.mjs's own VOYAGE_TIMEOUT_MS): a fetch that hangs must
      // never hang a push indefinitely.
      signal: AbortSignal.timeout(VOYAGE_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`voyage embeddings request failed: ${error?.message ?? String(error)}`);
  }

  if (!response.ok) {
    throw new Error(`voyage embeddings request failed: HTTP ${response.status}`);
  }

  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(`voyage embeddings response was not valid JSON: ${error?.message ?? String(error)}`);
  }

  const vector = body?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error('voyage embeddings response was malformed: missing embedding');
  }
  return Float64Array.from(vector);
}

// createEmbedder({ env }) -> (async (text) -> Float64Array | null) | null
// (Shared shapes, WS4b Task 5). Returns `null` -- the whole embedder
// value, not a function that itself returns null -- when env.VOYAGE_API_KEY
// is absent or empty: ingest.mjs treats a null embedder as "keyless",
// skipping clustering entirely and storing every created flow with
// embedding null. When a key IS present, the returned function embeds one
// text at a time and degrades a single failing call to null rather than
// throwing, so one bad Voyage response degrades exactly the one envelope
// being ingested, never the rest of the push.
export function createEmbedder({ env } = {}) {
  const key = env?.VOYAGE_API_KEY;
  if (typeof key !== 'string' || key.length === 0) return null;

  return async function embed(text) {
    try {
      return await voyageEmbed(text, key);
    } catch (error) {
      // Message-only: never the raw error object (which could, in
      // principle, wrap a fetch/Response object with headers), and never
      // a request/response body -- mirrors encoder.mjs's own convention
      // for what safely crosses a log boundary.
      console.error(`fast-browser-registry: voyage embed degraded to null: ${error?.message ?? String(error)}`);
      return null;
    }
  };
}
