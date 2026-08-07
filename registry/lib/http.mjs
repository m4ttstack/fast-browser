// HTTP surface for the registry service (WS4b plan, Task 3): routing,
// bearer auth, request-body limits, and the JSON error envelope every
// endpoint uses. From Task 5, POST /v1/push; from Task 6, GET /v1/pull
// (sync-pull, since/origin filters) and GET /v1/search (server-side
// semantic-or-lexical search) are real handlers in this same route table,
// leaving auth/body-limit/error plumbing untouched.
//
// Neither GET route has a body (hasBody: false in the route table below),
// so both read their input from the WHATWG URL the router already builds
// per request (`context.url`, a `new URL(req.url, 'http://localhost')`) --
// query params only, never a request body.
//
// Envelope shape (plan's Shared shapes, both routes): `{ artifact,
// contentHash, signature }`, where `artifact` is the record's stored
// `content` AS-IS (see `toEnvelope` below for why: it deliberately does
// NOT re-serialize it) and `signature` is the CURRENT stored signature --
// canonical bytes were signed once, at ingest time (registry/lib/
// ingest.mjs); neither read path re-signs.
//
// Zero runtime deps: node:crypto only (registry/server.mjs owns node:http
// itself -- createServer/listen -- this module only builds the request
// listener function).

import { createHash, timingSafeEqual } from 'node:crypto';

import { ingest } from './ingest.mjs';

// Pinned constants (plan's Shared shapes). PUSH_MAX_FLOWS is enforced by
// `validatePushRequest` below: a push with more than this many flows is a
// whole-request 422, never a per-flow rejection.
export const PUSH_MAX_FLOWS = 50;
export const BODY_LIMIT_BYTES = 5_000_000;

export class BodyTooLargeError extends Error {}

// Constant-time bearer-token comparison. Hashing both sides first means
// timingSafeEqual always compares two fixed-length (32-byte) digests
// regardless of the presented token's length -- comparing raw tokens of
// different lengths directly would either throw (timingSafeEqual requires
// equal-length buffers) or, if length-padded first, leak the true token
// length through a timing side channel. Digest-then-compare sidesteps
// both.
function tokensMatch(presented, configured) {
  const presentedDigest = createHash('sha256').update(presented, 'utf8').digest();
  const configuredDigest = createHash('sha256').update(configured, 'utf8').digest();
  return timingSafeEqual(presentedDigest, configuredDigest);
}

function isAuthorized(req, token) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return false;
  return tokensMatch(match[1], token);
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// `message` must never echo a secret or a request body -- every call site
// below passes a fixed, static string; none interpolate request data.
function sendError(res, statusCode, code, message) {
  sendJson(res, statusCode, { error: { code, message } });
}

// True when the request declared a body at the protocol level (a
// Content-Length or a Transfer-Encoding header) -- independent of whether
// the matched route (or the lack of one, on a 404) actually wants to read
// it. Used to choose, on a 404/401 rejection, between draining a body that
// plainly isn't there (nothing to drain, keep-alive is fine) and NOT
// draining one that is (see sendErrorClosing below -- draining a body the
// client is still actively sending, even discard-only, means the server
// keeps receiving that client's bytes off the network for as long as the
// connection stays open).
function hasDeclaredBody(req) {
  return Boolean(req.headers['content-length']) || Boolean(req.headers['transfer-encoding']);
}

// Discards (does not buffer) any request body the router has decided not
// to read, for the one case where that's actually safe: no body was ever
// declared, so there is nothing to drain and nothing to keep receiving.
// req.resume() is O(1) memory regardless of how much (if anything) arrives
// (each chunk is discarded as it arrives, never accumulated) -- kept as a
// defensive no-op rather than removed outright, in case a body arrives
// with neither header (not valid HTTP, but node's parser is lenient).
function drainUnreadBody(req) {
  if (!req.readableEnded) req.resume();
}

// Writes a JSON error response and then closes the connection instead of
// leaving it open -- used whenever the request declared a body (whether
// or not it turns out to be within the size limit) that the router has
// decided not to read: rejecting to keep-alive there would leave the
// socket sitting open for as long as the client keeps sending the bytes
// it promised, which the server would then keep receiving (even if it
// discards them) for no reason once the response is already final. The
// response is written and flushed on the still-live socket FIRST --
// destroying `req` before that would take the socket down with it and the
// client would see a connection reset instead of the intended status code
// -- and only once the write callback confirms the bytes are flushed does
// this function cut the connection.
function sendErrorClosing(req, res, statusCode, code, message) {
  const payload = JSON.stringify({ error: { code, message } });
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    Connection: 'close',
  });
  res.end(payload, () => {
    req.destroy();
  });
}

function send413(req, res) {
  sendErrorClosing(req, res, 413, 'payload_too_large', `request body exceeds ${BODY_LIMIT_BYTES} bytes`);
}

// Rejects on a declared-oversized Content-Length -- used both ahead of
// auth (so an unauthenticated client announcing an oversized upload never
// even reaches the auth check, let alone gets read) and, redundantly but
// harmlessly, inside readBody() below (which also catches the
// no-advance-declaration / lying-Content-Length / chunked case that this
// early check cannot).
function declaredContentLengthExceeds(req, limit) {
  const declared = Number(req.headers['content-length']);
  return Number.isFinite(declared) && declared > limit;
}

// Reads the full request body into a Buffer, enforcing `limit` two ways:
//   - up front, off the declared Content-Length header, before a single
//     body byte is read (a client that announces an oversized upload never
//     gets read at all -- true early-abort, not read-then-discard);
//   - while streaming, off the actual bytes received (a client that lies
//     about Content-Length, omits it, or uses chunked transfer-encoding
//     gets caught the moment the running total crosses `limit`, without
//     waiting for the rest of the body).
// Rejects with BodyTooLargeError in either case; the caller (the router
// below) turns that into a 413 -- this function only reads bytes, it never
// touches `res`.
export function readBody(req, limit) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    return Promise.reject(new BodyTooLargeError());
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    function onData(chunk) {
      received += chunk.length;
      if (received > limit) {
        cleanup();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    }
    function onEnd() {
      cleanup();
      resolve(Buffer.concat(chunks));
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    function cleanup() {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    }
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

// Builds the wire envelope both GET /v1/pull and GET /v1/search ship
// (plan's Shared shapes): `{ artifact, contentHash, signature }`.
//
// `artifact` is `record.content` handed straight through, UNCHANGED --
// deliberately not `serializeFlow(parseFlow(record.content))` or any other
// re-serialization. CRITICAL (Task 4 ledger finding, carried forward by
// ingest.mjs and pinned again here): content that has passed through a
// store may have had its object keys reordered by a jsonb round trip
// (pg-store). `signature` was computed once, at ingest time, over
// canonical bytes recomputed via serializeFlow(parseFlow(...)) -- it is
// NEVER recomputed here. A client verifies by doing exactly what ingest
// did: parseFlow(artifact) to normalize the shape, then serializeFlow that
// to reproduce the same canonical bytes independent of this object's key
// order, then checking `signature` against those bytes. Shipping the
// stored content object as-is is what makes that reproduction work --
// re-serializing it here some other way risks producing bytes that don't
// match what was actually signed.
function toEnvelope(record) {
  return { artifact: record.content, contentHash: record.contentHash, signature: record.signature };
}

// Validates AND normalizes the `since` query param for GET /v1/pull (WS4b
// Task 6 ledger finding; fix round 1, IMPORTANT #1). `since` must parse as
// a real date (`Number.isFinite(Date.parse(since))`); an absent or empty
// value means "no since filter" (both query params are optional).
//
// Normalizing the parsed value back to a canonical `toISOString()` (rather
// than passing the client's RAW string straight through, which the
// original version of this function did) is not cosmetic -- it closes two
// separate divergences the fix round 1 review reproduced live:
//   - Date.parse() accepts far more than ISO 8601 ('Aug 1 2026', a bare
//     '2026', RFC 1123 dates, ...). pg-store hands `since` straight to a
//     `timestamptz` parameter -- Postgres's own timestamptz parser rejects
//     most of those forms outright (-> an unhandled 500). Passing pg a
//     value already round-tripped through JS's Date is a literal every
//     `timestamptz` cast accepts, every time.
//   - memory-store's `list()` filters via a plain lexicographic string
//     compare (`record.updatedAt >= since`) against `updatedAt` values
//     that are ALWAYS full ISO strings with milliseconds
//     (`new Date().toISOString()`, registry/lib/ingest.mjs). A
//     milliseconds-trimmed ISO client value (e.g.
//     '2026-08-06T23:22:39Z', a perfectly valid `Date.parse` input) sorts
//     LEXICOGRAPHICALLY *after* '2026-08-06T23:22:39.000Z' ('Z' > '.' by
//     code point) even though the two name the identical instant -- so an
//     equal-or-later record was silently excluded. A sync pull reading
//     "nothing new" when there in fact IS something new is the dangerous
//     failure direction here (the opposite -- an extra stale record --
//     is merely redundant work), which is exactly why this is fixed by
//     normalizing the input to the same always-has-milliseconds shape
//     `updatedAt` values are already in, rather than, say, only checking
//     for milliseconds specifically.
function parseSinceQueryParam(url) {
  const raw = url.searchParams.get('since');
  if (raw === null || raw === '') return { ok: true, value: undefined };
  const parsedMillis = Date.parse(raw);
  if (!Number.isFinite(parsedMillis)) return { ok: false };
  return { ok: true, value: new Date(parsedMillis).toISOString() };
}

// GET /v1/pull?since=<iso>&origin=<origin> (WS4b plan Task 6): both filters
// optional, `since` inclusive on updatedAt (store.list's own documented
// semantics -- see registry/lib/store.mjs), `origin` exact. Ordering is
// the store's own (updatedAt ASC, id ASC tie-break -- WS4b Task 6 ledger
// finding, fixed identically in both memory-store.mjs and pg-store.mjs),
// so pull's result order is store-independent.
function pull({ store }) {
  return async function handler(_req, res, { url }) {
    const since = parseSinceQueryParam(url);
    if (!since.ok) {
      // Never echo the raw `since` value back -- established hygiene
      // (this file's sendError/sendErrorClosing convention): a client
      // could put arbitrary text in a query string, and a 422 that
      // interpolated it would be an unvalidated-input echo.
      sendError(res, 422, 'invalid_pull_request', 'invalid since parameter');
      return;
    }
    const origin = url.searchParams.get('origin') || undefined;

    const records = await store.list({ since: since.value, origin });
    sendJson(res, 200, { flows: records.map(toEnvelope) });
  };
}

// GET /v1/search?intent=...&origin=... (WS4b plan Task 6): `intent` is
// REQUIRED (missing or empty -> 422); `origin` is optional. `embedder` is
// the same seam POST /v1/push's ingest() calls use (registry/server.mjs's
// boot() derives it from VOYAGE_API_KEY, or a test stub with the same
// `async (text) -> Float64Array | null` shape) -- this handler calls it
// directly with the raw intent text (no helper needed: embedding an
// arbitrary text string is already exactly what that function signature
// does; ingest.mjs's own embedTextFor exists only to build ITS specific
// `description | stepSignature` text and has nothing to add here).
//
// Mode is decided per-request, honestly: `embedder` absent (keyless
// service) -> lexical; `embedder` present but this one call degrades to
// null (a Voyage hiccup, or a test stub simulating one) -> lexical, same
// as keyless, never a fabricated "semantic"; `embedder` present and this
// call returns a real embedding -> semantic. Either way, the MODE
// reported on the wire is store.search()'s own returned `mode` -- this
// handler never claims a mode the store didn't actually run.
function search({ store, embedder }) {
  return async function handler(_req, res, { url }) {
    const intent = url.searchParams.get('intent');
    if (!intent) {
      sendError(res, 422, 'invalid_search_request', 'intent is required');
      return;
    }
    const origin = url.searchParams.get('origin') || undefined;

    const embedding = embedder ? await embedder(intent) : null;
    const searchResult = embedding
      ? await store.search({ embedding, intentText: intent, origin })
      : await store.search({ intentText: intent, origin });

    sendJson(res, 200, {
      mode: searchResult.mode,
      results: searchResult.results.map(({ record, score }) => ({
        envelope: toEnvelope(record),
        score,
        // args schema surfaced from the stored artifact -- record.content
        // is the parsed flow (lib/flows/artifact.mjs's own `args` field),
        // never recomputed or re-derived.
        args: record.content.args,
      })),
    });
  };
}

// Whole-REQUEST validation for POST /v1/push (Shared shapes: "422 only for
// a malformed request as a whole -- not per-flow failures", which ride
// each flow's own 'rejected' outcome instead, from ingest() itself). This
// deliberately checks only the SHAPE a push envelope must have to be
// worth handing to ingest() at all (an object with an `artifact` object
// and a `contentHash` string) -- it never validates the artifact's own
// schema; that is parseFlow's job, one layer down, and a schema failure
// there is a per-flow 'rejected', not a 422.
function validatePushRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'request body must be a JSON object' };
  }
  if (!Array.isArray(body.flows)) {
    return { ok: false, message: 'flows must be an array' };
  }
  if (body.flows.length > PUSH_MAX_FLOWS) {
    return { ok: false, message: `flows must not exceed ${PUSH_MAX_FLOWS} entries` };
  }
  for (let index = 0; index < body.flows.length; index += 1) {
    const entry = body.flows[index];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, message: `flows[${index}] must be an object` };
    }
    if (!entry.artifact || typeof entry.artifact !== 'object' || Array.isArray(entry.artifact)) {
      return { ok: false, message: `flows[${index}].artifact must be an object` };
    }
    if (typeof entry.contentHash !== 'string' || entry.contentHash.length === 0) {
      return { ok: false, message: `flows[${index}].contentHash must be a non-empty string` };
    }
  }
  return { ok: true, flows: body.flows };
}

// POST /v1/push (WS4b plan Task 5): validates the request as a whole
// (422 on failure, see validatePushRequest above), then runs ingest() once
// per flow, IN ORDER, accumulating each outcome into `results` -- a
// per-flow ingest failure never aborts the rest of the push; only a
// whole-request shape failure does. `signer`/`embedder` are threaded
// straight through to ingest() unchanged (registry/server.mjs's boot()
// builds both; registry/tests/helpers/server.mjs's test harness can
// override the embedder to a stub, see that module's own doc comment).
function push({ store, signer, embedder }) {
  return async function handler(_req, res, { body }) {
    const validation = validatePushRequest(body);
    if (!validation.ok) {
      sendError(res, 422, 'invalid_push_request', validation.message);
      return;
    }

    const results = [];
    for (const envelope of validation.flows) {
      // Deliberately sequential, not Promise.all: push results must
      // preserve request order, and ingest() calls are not independent of
      // store state (an earlier flow in this same push can be the exact
      // duplicate or cluster target of a later one in the same push), so
      // they cannot run concurrently without changing behavior.
      const result = await ingest({ envelope, store, signer, embedder });
      results.push({
        name: result.name,
        outcome: result.outcome,
        canonicalId: result.canonicalId,
        reasons: result.reasons,
      });
    }

    sendJson(res, 200, { results });
  };
}

function health({ publicKeyPem, version, clustering }) {
  return async function handler(_req, res) {
    sendJson(res, 200, { ok: true, version, publicKey: publicKeyPem, clustering });
  };
}

// Builds the request listener node:http.createServer() takes. `token` is
// the configured REGISTRY_TOKEN; `publicKeyPem`/`version`/`clustering` feed
// GET /health verbatim (registry/server.mjs computes all three at boot).
// `store` is threaded through to every route handler's context. `signer`
// (registry/lib/signing.mjs's sign, bound to the boot private key) and
// `embedder` (registry/lib/embedder.mjs's createEmbedder output, or a test
// stub with the same `async (text) -> Float64Array | null` shape, or
// `null` when keyless) is threaded to POST /v1/push's ingest() calls AND
// (Task 6) GET /v1/search's own direct embed-intent call; `store` is
// threaded to all three real routes' handlers; `signer` remains push-only
// (neither GET route re-signs -- see toEnvelope's doc comment above).
export function createRequestListener({ token, store, signer, embedder, publicKeyPem, version, clustering }) {
  const routes = [
    { method: 'GET', path: '/health', auth: false, hasBody: false, handler: health({ publicKeyPem, version, clustering }) },
    { method: 'POST', path: '/v1/push', auth: true, hasBody: true, handler: push({ store, signer, embedder }) },
    { method: 'GET', path: '/v1/pull', auth: true, hasBody: false, handler: pull({ store }) },
    { method: 'GET', path: '/v1/search', auth: true, hasBody: false, handler: search({ store, embedder }) },
  ];

  return async function requestListener(req, res) {
    // Safety nets, not behavior: without a listener, an 'error' event on
    // either stream throws and can take the whole process down (e.g. a
    // client resetting the connection after we're done reading but before
    // we've written a response). Best-effort swallow -- there is nothing
    // meaningful to respond with once the socket itself has failed.
    req.on('error', () => {});
    res.on('error', () => {});

    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      sendError(res, 400, 'bad_request', 'unparseable request URL');
      return;
    }

    const route = routes.find((candidate) => candidate.method === req.method && candidate.path === url.pathname);
    if (!route) {
      if (hasDeclaredBody(req)) {
        sendErrorClosing(req, res, 404, 'not_found', `no route for ${req.method} ${url.pathname}`);
      } else {
        drainUnreadBody(req);
        sendError(res, 404, 'not_found', `no route for ${req.method} ${url.pathname}`);
      }
      return;
    }

    // Ahead of auth: a client that declares an oversized upload gets
    // rejected before the auth check even runs, let alone before a single
    // body byte is read. Without this ordering, an UNAUTHENTICATED request
    // declaring e.g. Content-Length: 200MB would get its 401 quickly, but
    // -- since the connection would otherwise stay open, keep-alive, past
    // that 401 -- the server would keep receiving (whether drained or
    // simply left flowing) every byte of that 200MB the client goes on to
    // send, for a request that was never going to be accepted regardless
    // of its body. Checking size before identity closes that resource
    // drain: the response here is 413, not 401, since the body itself is
    // rejected outright.
    if (route.hasBody && declaredContentLengthExceeds(req, BODY_LIMIT_BYTES)) {
      send413(req, res);
      return;
    }

    if (route.auth && !isAuthorized(req, token)) {
      if (hasDeclaredBody(req)) {
        sendErrorClosing(req, res, 401, 'unauthorized', 'missing or invalid bearer token');
      } else {
        drainUnreadBody(req);
        sendError(res, 401, 'unauthorized', 'missing or invalid bearer token');
      }
      return;
    }

    let body;
    if (route.hasBody) {
      let raw;
      try {
        raw = await readBody(req, BODY_LIMIT_BYTES);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          send413(req, res);
          return;
        }
        sendError(res, 400, 'bad_request', 'failed to read request body');
        return;
      }
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          sendError(res, 400, 'bad_request', 'request body is not valid JSON');
          return;
        }
      }
    }

    try {
      await route.handler(req, res, { url, body, store });
    } catch (error) {
      // Never echo the error's own message back to the client -- it may
      // embed request data (e.g. a future store error quoting part of the
      // record it choked on). Log server-side only, respond generically.
      console.error('fast-browser-registry: unhandled request error:', error);
      if (!res.headersSent) {
        sendError(res, 500, 'internal_error', 'unexpected server error');
      }
    }
  };
}
