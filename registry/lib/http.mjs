// HTTP surface for the registry service (WS4b plan, Task 3): routing,
// bearer auth, request-body limits, and the JSON error envelope every
// endpoint uses. Owns none of the API's actual behavior beyond health --
// POST /v1/push, GET /v1/pull, and GET /v1/search are wired here as 501
// placeholders; Task 5 (push/ingest) and Task 6 (pull/search) replace the
// placeholder handlers with real ones, in this same route table, without
// touching auth/body-limit/error plumbing.
//
// Zero runtime deps: node:crypto only (registry/server.mjs owns node:http
// itself -- createServer/listen -- this module only builds the request
// listener function).

import { createHash, timingSafeEqual } from 'node:crypto';

// Pinned constants (plan's Shared shapes). PUSH_MAX_FLOWS is not yet
// enforced here -- POST /v1/push is a placeholder until Task 5 -- but it
// is pinned in exactly one place now so Task 5 imports it rather than
// re-guessing the value.
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

// Discards (does not buffer) any request body the router has decided not
// to read -- the 404/401 branches below reject before readBody() ever
// runs. Draining rather than leaving the body dangling lets a keep-alive
// connection close/reuse cleanly instead of the next request on the same
// socket getting corrupted by a previous request's unread trailing bytes.
// req.resume() is O(1) memory regardless of how much body is left (each
// chunk is discarded as it arrives, never accumulated), so this is safe
// even against a request whose (unauthorized, so never route-handled)
// body happens to be large.
function drainUnreadBody(req) {
  if (!req.readableEnded) req.resume();
}

// "Abort early": respond 413 and then close the connection instead of
// draining whatever the client is still sending, whether the oversized
// body was known up front (a declared Content-Length over the limit) or
// only discovered mid-stream (chunked transfer, or a lying
// Content-Length). The response is written and flushed on the still-live
// socket first -- destroying `req` before that would take the socket down
// with it and the client would see a reset instead of a 413 -- and only
// once the write callback confirms the bytes are flushed does this
// function cut the connection.
function send413(req, res) {
  const payload = JSON.stringify({
    error: { code: 'payload_too_large', message: `request body exceeds ${BODY_LIMIT_BYTES} bytes` },
  });
  res.writeHead(413, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    Connection: 'close',
  });
  res.end(payload, () => {
    req.destroy();
  });
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

function notImplemented(routeLabel) {
  return async function handler(_req, res) {
    sendError(res, 501, 'not_implemented', `${routeLabel} is not implemented yet`);
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
// `store` is threaded through to every route handler's context even though
// no Task 3 handler reads it yet -- Tasks 5/6 add real handlers to this
// same table and need it there.
export function createRequestListener({ token, store, publicKeyPem, version, clustering }) {
  const routes = [
    { method: 'GET', path: '/health', auth: false, hasBody: false, handler: health({ publicKeyPem, version, clustering }) },
    { method: 'POST', path: '/v1/push', auth: true, hasBody: true, handler: notImplemented('POST /v1/push') },
    { method: 'GET', path: '/v1/pull', auth: true, hasBody: false, handler: notImplemented('GET /v1/pull') },
    { method: 'GET', path: '/v1/search', auth: true, hasBody: false, handler: notImplemented('GET /v1/search') },
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
      drainUnreadBody(req);
      sendError(res, 404, 'not_found', `no route for ${req.method} ${url.pathname}`);
      return;
    }

    if (route.auth && !isAuthorized(req, token)) {
      drainUnreadBody(req);
      sendError(res, 401, 'unauthorized', 'missing or invalid bearer token');
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
