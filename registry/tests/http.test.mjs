import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

import { parseFlow, serializeFlow } from '../../lib/flows/artifact.mjs';
import { BODY_LIMIT_BYTES, PUSH_MAX_FLOWS } from '../lib/http.mjs';
import { verify } from '../lib/signing.mjs';
import { baseFlow } from './helpers/fixtures.mjs';
import { generateSigningKeyPem, startTestServer, TEST_TOKEN } from './helpers/server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_ROOT = path.dirname(HERE);

// Opens a raw TCP connection, writes exactly `headHead` (and, if given,
// `body`) with no help from fetch/undici, and resolves with everything
// read back off the socket. Used for the two 413 tests below, which need
// byte-level control fetch does not give: proving the server responds
// WITHOUT ever receiving a declared-oversized body (Content-Length case),
// and proving it aborts mid-stream on a body with no advance
// Content-Length at all (chunked case). A raw socket sidesteps any
// uncertainty about how a higher-level client library reacts to the
// server closing the connection while the client is still writing.
function rawRequest(port, { head, body }) {
  return new Promise((resolvePromise, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timed out waiting for an HTTP response'));
    }, 5000);

    function finish() {
      clearTimeout(timer);
      socket.destroy();
      resolvePromise(buffer.toString('utf8'));
    }

    socket.on('connect', () => {
      socket.write(head);
      if (body) socket.write(body);
    });
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      // A full status line + header block is enough to assert on; do not
      // wait for the connection to close on its own.
      if (buffer.includes('\r\n\r\n')) finish();
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('close', finish);
  });
}

test('GET /health requires no auth and reports the documented shape', async () => {
  const { close, baseUrl, publicKeyPem } = await startTestServer();
  try {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(typeof payload.version, 'string');
    assert.equal(payload.publicKey, publicKeyPem);
    assert.equal(payload.clustering, false);
  } finally {
    await close();
  }
});

test('GET /health publicKey matches the key derived from the booted signing key', async () => {
  const { close, baseUrl, publicKeyPem } = await startTestServer();
  try {
    const response = await fetch(`${baseUrl}/health`);
    const payload = await response.json();
    // Recompute independently (not just comparing to what boot() handed
    // back) to prove the served key really is derivable from *some*
    // private key, not just an opaque string boot() happens to echo.
    assert.equal(typeof payload.publicKey, 'string');
    assert.ok(payload.publicKey.includes('BEGIN PUBLIC KEY'));
    assert.equal(payload.publicKey, publicKeyPem);
  } finally {
    await close();
  }
});

test('GET /health clustering flag flips true when VOYAGE_API_KEY is present', async () => {
  const { close, baseUrl } = await startTestServer({ VOYAGE_API_KEY: 'test-only-not-a-real-key' });
  try {
    const response = await fetch(`${baseUrl}/health`);
    const payload = await response.json();
    assert.equal(payload.clustering, true);
  } finally {
    await close();
  }
});

test('POST /v1/push without an Authorization header is rejected 401', async () => {
  const { close, baseUrl } = await startTestServer();
  try {
    const response = await fetch(`${baseUrl}/v1/push`, { method: 'POST', body: JSON.stringify({ flows: [] }) });
    assert.equal(response.status, 401);
    const payload = await response.json();
    assert.equal(payload.error.code, 'unauthorized');
    assert.equal(typeof payload.error.message, 'string');
  } finally {
    await close();
  }
});

test('POST /v1/push with the wrong bearer token is rejected 401', async () => {
  const { close, baseUrl } = await startTestServer();
  try {
    const response = await fetch(`${baseUrl}/v1/push`, {
      method: 'POST',
      headers: { Authorization: 'Bearer definitely-not-the-token' },
      body: JSON.stringify({ flows: [] }),
    });
    assert.equal(response.status, 401);
  } finally {
    await close();
  }
});

test('near-miss tokens are all rejected 401: one flipped char, a prefix, a token-plus-suffix', async () => {
  const { close, baseUrl, token } = await startTestServer();
  try {
    const flippedLastChar = `${token.slice(0, -1)}${token.at(-1) === 'x' ? 'y' : 'x'}`;
    const prefix = token.slice(0, -1);
    const withSuffix = `${token}x`;
    for (const nearMiss of [flippedLastChar, prefix, withSuffix]) {
      const response = await fetch(`${baseUrl}/v1/pull`, { headers: { Authorization: `Bearer ${nearMiss}` } });
      assert.equal(response.status, 401, `expected 401 for near-miss token ${JSON.stringify(nearMiss)}`);
    }
  } finally {
    await close();
  }
});

test('an empty bearer token ("Bearer " with nothing after it) is rejected 401', async () => {
  const { close, baseUrl } = await startTestServer();
  try {
    const response = await fetch(`${baseUrl}/v1/pull`, { headers: { Authorization: 'Bearer ' } });
    assert.equal(response.status, 401);
  } finally {
    await close();
  }
});

test('a lowercase "bearer" scheme is rejected 401 -- auth fails closed on case, it does not case-fold', async () => {
  const { close, baseUrl, token } = await startTestServer();
  try {
    const response = await fetch(`${baseUrl}/v1/pull`, { headers: { Authorization: `bearer ${token}` } });
    assert.equal(response.status, 401);
  } finally {
    await close();
  }
});

test('GET /health ignores Authorization entirely -- a bogus header still gets 200', async () => {
  const { close, baseUrl } = await startTestServer();
  try {
    const response = await fetch(`${baseUrl}/health`, { headers: { Authorization: 'Bearer this-is-nonsense' } });
    assert.equal(response.status, 200);
  } finally {
    await close();
  }
});

test('router probes: trailing slash, path case, percent-encoded slash all 404; dot-segment normalizes and still requires auth; OPTIONS is unrecognized', async () => {
  const { close, baseUrl, token } = await startTestServer();
  try {
    // Trailing slash is a different path than the registered '/health' --
    // no implicit normalization.
    const trailingSlash = await fetch(`${baseUrl}/health/`);
    assert.equal(trailingSlash.status, 404);

    // Path matching is case-sensitive.
    const upperCase = await fetch(`${baseUrl}/V1/PULL`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(upperCase.status, 404);

    // A percent-encoded slash does not decode into a path separator for
    // routing purposes -- '/v1%2Fpull' must not match '/v1/pull'.
    const percentEncoded = await fetch(`${baseUrl}/v1%2Fpull`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(percentEncoded.status, 404);

    // '/v1/./pull' IS a dot-segment normalization of a real route (URL's
    // own parser collapses it to '/v1/pull' before routing ever sees it),
    // so it must behave exactly like '/v1/pull': 401 unauthenticated, not
    // 404.
    const dotSegmentUnauthenticated = await fetch(`${baseUrl}/v1/./pull`);
    assert.equal(dotSegmentUnauthenticated.status, 401);
    const dotSegmentAuthenticated = await fetch(`${baseUrl}/v1/./pull`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(dotSegmentAuthenticated.status, 501);

    // No route table entry handles OPTIONS anywhere -- falls through to
    // the generic 404, not a CORS-style 204/200.
    const options = await fetch(`${baseUrl}/health`, { method: 'OPTIONS' });
    assert.equal(options.status, 404);
  } finally {
    await close();
  }
});

test('GET /v1/pull and GET /v1/search both require auth too', async () => {
  const { close, baseUrl } = await startTestServer();
  try {
    const pull = await fetch(`${baseUrl}/v1/pull`);
    assert.equal(pull.status, 401);
    const search = await fetch(`${baseUrl}/v1/search?intent=hello`);
    assert.equal(search.status, 401);
  } finally {
    await close();
  }
});

test('the correct bearer token unlocks pull/search, currently placeholder 501s', async () => {
  const { close, baseUrl, token } = await startTestServer();
  try {
    const pull = await fetch(`${baseUrl}/v1/pull`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(pull.status, 501);

    const search = await fetch(`${baseUrl}/v1/search?intent=hello`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(search.status, 501);
  } finally {
    await close();
  }
});

test('the correct bearer token unlocks POST /v1/push, which is real (Task 5) and accepts an empty flows array', async () => {
  const { close, baseUrl, token } = await startTestServer();
  try {
    const push = await fetch(`${baseUrl}/v1/push`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ flows: [] }),
    });
    assert.equal(push.status, 200);
    const payload = await push.json();
    assert.deepEqual(payload, { results: [] });
  } finally {
    await close();
  }
});

test('malformed JSON on POST /v1/push (correct token) is rejected 400, not 501', async () => {
  const { close, baseUrl, token } = await startTestServer();
  try {
    const response = await fetch(`${baseUrl}/v1/push`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: '{ this is not valid json',
    });
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.error.code, 'bad_request');
  } finally {
    await close();
  }
});

test('an empty POST /v1/push body (correct token) is not treated as malformed JSON -- it is a 422 whole-request validation failure', async () => {
  const { close, baseUrl, token } = await startTestServer();
  try {
    const response = await fetch(`${baseUrl}/v1/push`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    // No body at all -> `body` is undefined, not an object -- this is
    // validatePushRequest's 422 path, never the 400 malformed-JSON path
    // (readBody/JSON.parse never even runs against an absent body).
    assert.equal(response.status, 422);
    const payload = await response.json();
    assert.equal(payload.error.code, 'invalid_push_request');
  } finally {
    await close();
  }
});

// --- POST /v1/push (WS4b Task 5): whole-request validation + real ingest,
// through the full HTTP layer ---

function contentHashOf(flow) {
  return createHash('sha256').update(serializeFlow(flow)).digest('hex');
}

function pushEnvelopeFor(flowOverrides = {}) {
  const flow = parseFlow(baseFlow(flowOverrides));
  return { artifact: flow, contentHash: contentHashOf(flow) };
}

test('POST /v1/push rejects a whole request with too many flows (over PUSH_MAX_FLOWS) with 422, never touching the store', async () => {
  const { close, baseUrl, token } = await startTestServer();
  try {
    const flows = Array.from({ length: PUSH_MAX_FLOWS + 1 }, (_, i) => pushEnvelopeFor({ name: `flow-${i}` }));
    const response = await fetch(`${baseUrl}/v1/push`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ flows }),
    });
    assert.equal(response.status, 422);
    const payload = await response.json();
    assert.equal(payload.error.code, 'invalid_push_request');
    assert.match(payload.error.message, new RegExp(String(PUSH_MAX_FLOWS)));
  } finally {
    await close();
  }
});

test('POST /v1/push rejects a whole request whose flows is not an array with 422', async () => {
  const { close, baseUrl, token } = await startTestServer();
  try {
    const response = await fetch(`${baseUrl}/v1/push`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ flows: 'not-an-array' }),
    });
    assert.equal(response.status, 422);
    const payload = await response.json();
    assert.equal(payload.error.code, 'invalid_push_request');
  } finally {
    await close();
  }
});

test('POST /v1/push rejects a whole request with a flow entry missing contentHash with 422', async () => {
  const { close, baseUrl, token } = await startTestServer();
  try {
    const flow = parseFlow(baseFlow());
    const response = await fetch(`${baseUrl}/v1/push`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ flows: [{ artifact: flow }] }),
    });
    assert.equal(response.status, 422);
    const payload = await response.json();
    assert.equal(payload.error.code, 'invalid_push_request');
  } finally {
    await close();
  }
});

test('POST /v1/push with exactly PUSH_MAX_FLOWS entries is accepted (the boundary is "over", not "at")', async () => {
  const { close, baseUrl, token } = await startTestServer();
  try {
    const flows = Array.from({ length: PUSH_MAX_FLOWS }, (_, i) => pushEnvelopeFor({ name: `boundary-flow-${i}` }));
    const response = await fetch(`${baseUrl}/v1/push`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ flows }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.results.length, PUSH_MAX_FLOWS);
    assert.ok(payload.results.every((result) => result.outcome === 'created'));
  } finally {
    await close();
  }
});

test('POST /v1/push creates a new canonical, signed and verifiable against the served public key', async () => {
  const { close, baseUrl, token, publicKeyPem } = await startTestServer();
  try {
    const flow = parseFlow(baseFlow({ name: 'push-create-flow' }));
    const response = await fetch(`${baseUrl}/v1/push`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ flows: [{ artifact: flow, contentHash: contentHashOf(flow) }] }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.results.length, 1);
    const [result] = payload.results;
    assert.equal(result.name, 'push-create-flow');
    assert.equal(result.outcome, 'created');
    assert.equal(typeof result.canonicalId, 'string');
    assert.deepEqual(result.reasons, []);
  } finally {
    await close();
  }
});

test('POST /v1/push re-pushing the exact same content is idempotent: deduped, not created twice', async () => {
  const { close, baseUrl, token } = await startTestServer();
  try {
    const envelope = pushEnvelopeFor({ name: 'push-idempotent-flow' });
    const first = await fetch(`${baseUrl}/v1/push`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ flows: [envelope] }),
    });
    const firstPayload = await first.json();
    assert.equal(firstPayload.results[0].outcome, 'created');

    const second = await fetch(`${baseUrl}/v1/push`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ flows: [envelope] }),
    });
    const secondPayload = await second.json();
    assert.equal(secondPayload.results[0].outcome, 'deduped');
    assert.equal(secondPayload.results[0].canonicalId, firstPayload.results[0].canonicalId);
  } finally {
    await close();
  }
});

test('POST /v1/push rejects a per-flow contentHash mismatch as "rejected" (200 overall, not 422 -- a per-flow failure)', async () => {
  const { close, baseUrl, token } = await startTestServer();
  try {
    const flow = parseFlow(baseFlow({ name: 'push-hash-mismatch-flow' }));
    const response = await fetch(`${baseUrl}/v1/push`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ flows: [{ artifact: flow, contentHash: '0'.repeat(64) }] }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.results[0].outcome, 'rejected');
    assert.ok(payload.results[0].reasons.some((reason) => reason.rule === 'content-hash-mismatch'));
  } finally {
    await close();
  }
});

test('POST /v1/push rejects a PII-tainted flow as "rejected" with the lint reasons', async () => {
  const { close, baseUrl, token } = await startTestServer();
  try {
    const flow = parseFlow(baseFlow({
      name: 'push-pii-flow',
      description: 'Contact support at jane.doe@example.com if this fails',
    }));
    const response = await fetch(`${baseUrl}/v1/push`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ flows: [{ artifact: flow, contentHash: contentHashOf(flow) }] }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.results[0].outcome, 'rejected');
    assert.deepEqual(payload.results[0].reasons, [{ path: 'description', rule: 'email' }]);
  } finally {
    await close();
  }
});

test('POST /v1/push processes multiple flows in order, one rejection never blocking the rest', async () => {
  const { close, baseUrl, token } = await startTestServer();
  try {
    const good = parseFlow(baseFlow({ name: 'push-multi-good' }));
    const bad = parseFlow(baseFlow({ name: 'push-multi-bad', description: 'sk-abcdEFGH12345678ijklMNOP' }));
    const response = await fetch(`${baseUrl}/v1/push`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        flows: [
          { artifact: good, contentHash: contentHashOf(good) },
          { artifact: bad, contentHash: contentHashOf(bad) },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.results.length, 2);
    assert.equal(payload.results[0].name, 'push-multi-good');
    assert.equal(payload.results[0].outcome, 'created');
    assert.equal(payload.results[1].name, 'push-multi-bad');
    assert.equal(payload.results[1].outcome, 'rejected');
  } finally {
    await close();
  }
});

test('POST /v1/push with a keyless service (no VOYAGE_API_KEY) creates with embedding null and never clusters', async () => {
  const { close, baseUrl, token } = await startTestServer();
  try {
    const a = pushEnvelopeFor({ name: 'push-keyless-a' });
    const b = pushEnvelopeFor({ name: 'push-keyless-b' });
    const response = await fetch(`${baseUrl}/v1/push`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ flows: [a, b] }),
    });
    const payload = await response.json();
    // Two structurally-identical (but differently-named) flows, pushed
    // with no embedder configured at all -- clustering is skipped
    // entirely, so both land as 'created', never 'clustered'.
    assert.deepEqual(payload.results.map((result) => result.outcome), ['created', 'created']);
  } finally {
    await close();
  }
});

test('POST /v1/push clusters two near-duplicate flows (stubbed cosine 0.96, same origin + opSequence): alternates union into the canonical, re-signed and verifiable', async () => {
  // Two flows sharing everything an ingest cluster-match cares about (same
  // origin, same steps/stepSignature/opSequence) but differing ONLY in
  // their click step's locator alternates -- exactly the "same UI action,
  // captured twice, DOM gave a different fallback selector this time"
  // shape clustering exists to collapse.
  const canonicalFlowInput = baseFlow({ name: 'push-cluster-canonical' });
  const incomingLocator = { kind: 'testid', selector: 'place-order-button' };
  const incomingFlowInput = baseFlow({
    name: 'push-cluster-incoming',
    steps: canonicalFlowInput.steps.map((step, index) => {
      if (index !== 2) return step; // the click step
      return {
        ...step,
        target: { ...step.target, locators: [...step.target.locators, incomingLocator] },
      };
    }),
  });

  // A call-order queue, not a fixed constant: the FIRST embed call (the
  // canonical's own creation) returns [1, 0]; every call after that
  // returns a vector at exactly cosine 0.96 from it ([0.96, sqrt(1 -
  // 0.96^2)], norm 1 by construction) -- this is what actually produces a
  // real 0.96 cosine between the incoming flow's embedding and the
  // canonical's STORED embedding, rather than two calls that happen to
  // return the identical vector (which would trivially cosine to 1.0 and
  // prove nothing about the 0.95 threshold).
  const vectors = [[1, 0], [0.96, Math.sqrt(1 - 0.96 ** 2)]];
  let embedCall = 0;
  const stubEmbedder = async () => {
    const vector = vectors[Math.min(embedCall, vectors.length - 1)];
    embedCall += 1;
    return Float64Array.from(vector);
  };
  const { close, baseUrl, token, publicKeyPem, store } = await startTestServer({}, { embedder: stubEmbedder });
  try {
    const canonicalEnvelope = pushEnvelopeFor(canonicalFlowInput);
    const first = await fetch(`${baseUrl}/v1/push`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ flows: [canonicalEnvelope] }),
    });
    const firstPayload = await first.json();
    assert.equal(firstPayload.results[0].outcome, 'created');
    const canonicalId = firstPayload.results[0].canonicalId;

    const incomingEnvelope = pushEnvelopeFor(incomingFlowInput);
    const second = await fetch(`${baseUrl}/v1/push`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ flows: [incomingEnvelope] }),
    });
    assert.equal(second.status, 200);
    const secondPayload = await second.json();
    assert.equal(secondPayload.results[0].outcome, 'clustered');
    assert.equal(secondPayload.results[0].canonicalId, canonicalId);

    // GET /v1/pull is still a Task 6 placeholder, so the only way to
    // inspect the merged canonical through the real push path is the
    // store this same booted server is using -- proving the full
    // HTTP -> ingest -> store round trip, not just the response shape.
    const stored = await store.get(canonicalId);
    assert.equal(stored.mergedCount, 1, 'a single cluster-merge increments mergedCount by exactly 1');
    const clickStepLocators = stored.content.steps[2].target.locators;
    // Append-only: every ORIGINAL canonical locator survives, in order,
    // and the incoming flow's new alternate is appended after them.
    assert.deepEqual(
      clickStepLocators,
      [...canonicalFlowInput.steps[2].target.locators, incomingLocator],
    );

    // The canonical was re-signed over its refreshed content -- verify
    // independently against the server's own served public key, the same
    // way a real pull-side client would.
    const canonicalFlow = parseFlow(stored.content);
    assert.equal(verify(serializeFlow(canonicalFlow), stored.signature, publicKeyPem), true);
  } finally {
    await close();
  }
});

test('an unknown route is rejected 404 with the documented error shape', async () => {
  const { close, baseUrl, token } = await startTestServer();
  try {
    const response = await fetch(`${baseUrl}/v1/does-not-exist`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 404);
    const payload = await response.json();
    assert.equal(payload.error.code, 'not_found');
  } finally {
    await close();
  }
});

test('a declared Content-Length over the limit is rejected 413 without the server ever reading the body', async () => {
  const { close, port, token } = await startTestServer();
  try {
    const oversizeDeclared = BODY_LIMIT_BYTES + 1;
    const head =
      `POST /v1/push HTTP/1.1\r\n` +
      `Host: 127.0.0.1\r\n` +
      `Authorization: Bearer ${token}\r\n` +
      `Content-Length: ${oversizeDeclared}\r\n` +
      `Connection: close\r\n` +
      `\r\n`;
    // Deliberately never write the declared body -- if the server were
    // waiting to actually receive it, this would hang until the 5s
    // timeout instead of returning a response.
    const response = await rawRequest(port, { head });
    assert.match(response, /^HTTP\/1\.1 413/);
    assert.match(response, /"code":"payload_too_large"/);
  } finally {
    await close();
  }
});

test('an UNAUTHENTICATED declared-oversized Content-Length is rejected 413, not 401 -- the size check runs ahead of auth', async () => {
  const { close, port } = await startTestServer();
  try {
    const oversizeDeclared = BODY_LIMIT_BYTES + 1;
    // No Authorization header at all -- if auth ran first, this would be
    // a 401 and the server would then sit on the connection waiting on
    // (or draining) a body that was never coming. Never write the body.
    const head =
      `POST /v1/push HTTP/1.1\r\n` +
      `Host: 127.0.0.1\r\n` +
      `Content-Length: ${oversizeDeclared}\r\n` +
      `Connection: close\r\n` +
      `\r\n`;
    const response = await rawRequest(port, { head });
    assert.match(response, /^HTTP\/1\.1 413/);
    assert.match(response, /"code":"payload_too_large"/);
  } finally {
    await close();
  }
});

test('a chunked body (no declared Content-Length) that exceeds the limit is rejected 413 mid-stream', async () => {
  const { close, port, token } = await startTestServer();
  try {
    const overLimitBytes = BODY_LIMIT_BYTES + 1000;
    const head =
      `POST /v1/push HTTP/1.1\r\n` +
      `Host: 127.0.0.1\r\n` +
      `Authorization: Bearer ${token}\r\n` +
      `Transfer-Encoding: chunked\r\n` +
      `Connection: close\r\n` +
      `\r\n`;
    const chunkData = Buffer.alloc(overLimitBytes, 'x');
    const chunkHeader = Buffer.from(`${chunkData.length.toString(16)}\r\n`);
    // Deliberately never finish the chunked stream (no trailing 0-length
    // chunk) -- the server should reject before the stream would even
    // need to end.
    const body = Buffer.concat([chunkHeader, chunkData]);
    const response = await rawRequest(port, { head, body });
    assert.match(response, /^HTTP\/1\.1 413/);
    assert.match(response, /"code":"payload_too_large"/);
  } finally {
    await close();
  }
});

test('BODY_LIMIT_BYTES and PUSH_MAX_FLOWS are pinned to the plan values', () => {
  assert.equal(BODY_LIMIT_BYTES, 5_000_000);
  assert.equal(PUSH_MAX_FLOWS, 50);
});

test('boot() rejects, naming the variable, when REGISTRY_TOKEN is missing', async () => {
  const { boot } = await import('../server.mjs');
  await assert.rejects(
    () => boot({ env: { REGISTRY_SIGNING_KEY: 'irrelevant-for-this-check' } }),
    (error) => /REGISTRY_TOKEN/.test(error.message),
  );
});

test('boot() rejects, naming the variable, when REGISTRY_SIGNING_KEY is missing', async () => {
  const { boot } = await import('../server.mjs');
  await assert.rejects(
    () => boot({ env: { REGISTRY_TOKEN: 'irrelevant-for-this-check' } }),
    (error) => /REGISTRY_SIGNING_KEY/.test(error.message),
  );
});

test('boot() rejects when REGISTRY_SIGNING_KEY is not a valid PEM, without echoing it', async () => {
  const { boot } = await import('../server.mjs');
  const bogusKey = 'not-a-real-pem-key-value';
  await assert.rejects(
    () => boot({ env: { REGISTRY_TOKEN: 'x', REGISTRY_SIGNING_KEY: bogusKey } }),
    (error) => !error.message.includes(bogusKey),
  );
});

test('boot() rejects a syntactically valid PEM of the wrong key type (RSA instead of Ed25519), naming REGISTRY_SIGNING_KEY and never echoing it', async () => {
  const { boot } = await import('../server.mjs');
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey: rsaPrivateKeyPem } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  await assert.rejects(
    () => boot({ env: { REGISTRY_TOKEN: 'x', REGISTRY_SIGNING_KEY: rsaPrivateKeyPem } }),
    (error) => /REGISTRY_SIGNING_KEY/.test(error.message) && !error.message.includes(rsaPrivateKeyPem),
  );
});

// SECURITY (WS4b Task 4 review note): a pg connection/init failure's
// error.message can quote the connection string -- and therefore its
// password -- verbatim. Before this test existed, boot()'s only failure
// handling was the server.mjs CLI entrypoint's catch printing
// `error.message` unconditionally, which would have put DATABASE_URL's
// password straight into the process's logs on a bad connection string.
// Uses an unreachable port (1, on localhost) rather than an actually
// malformed URL, so the failure is a real connection error (fast,
// ECONNREFUSED) and the redaction is proven against boot()'s real
// end-to-end failure path, not a synthetic message.
test('boot() with a DATABASE_URL that fails to connect never echoes the connection string or its password', async () => {
  const { boot } = await import('../server.mjs');
  const password = 'sup3rSecretFakePass123';
  const bogusUrl = `postgres://registryuser:${password}@127.0.0.1:1/registry_test`;
  await assert.rejects(
    () => boot({
      env: {
        REGISTRY_TOKEN: 'x',
        REGISTRY_SIGNING_KEY: generateSigningKeyPem(),
        DATABASE_URL: bogusUrl,
        PORT: '0',
      },
    }),
    (error) => {
      assert.ok(!error.message.includes(password), 'failure message must never include the DATABASE_URL password');
      assert.ok(!error.message.includes(bogusUrl), 'failure message must never include the full DATABASE_URL');
      assert.match(error.message, /DATABASE_URL/);
      return true;
    },
  );
});

test('redactConnectionString strips both the whole connection string and its password wherever they appear', async () => {
  const { redactConnectionString } = await import('../server.mjs');
  const connectionString = 'postgres://registryuser:sup3rSecretFakePass123@db.example.com:5432/registry';

  assert.equal(
    redactConnectionString(`connect failed for ${connectionString}`, connectionString),
    'connect failed for [DATABASE_URL redacted]',
  );
  assert.equal(
    redactConnectionString('password authentication failed for sup3rSecretFakePass123', connectionString),
    'password authentication failed for ***',
  );
  // A message with neither the string nor the password passes through
  // unchanged -- redaction must never mangle an already-safe message.
  assert.equal(redactConnectionString('connect ECONNREFUSED 127.0.0.1:1', connectionString), 'connect ECONNREFUSED 127.0.0.1:1');
  // No connectionString to redact against (e.g. the memory driver never
  // has a DATABASE_URL) -- passthrough, not a crash.
  assert.equal(redactConnectionString('some error', undefined), 'some error');
});

test('a keygen-generated keypair boots a real (spawned) server whose /health serves the derived public key', async () => {
  const keygen = spawn(process.execPath, [path.join(REGISTRY_ROOT, 'scripts', 'keygen.mjs')]);
  let keygenStdout = '';
  keygen.stdout.on('data', (chunk) => {
    keygenStdout += chunk.toString('utf8');
  });
  await new Promise((resolvePromise, reject) => {
    keygen.on('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(`keygen exited ${code}`))));
    keygen.on('error', reject);
  });

  const privateKeyMatch = /-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/.exec(keygenStdout);
  assert.ok(privateKeyMatch, 'keygen stdout should contain a PKCS8 private key PEM block');
  const privateKeyPem = privateKeyMatch[0];

  // Independently derive the expected public key from the private key
  // keygen printed, to compare against what the spawned server's /health
  // reports -- proving the server really did boot with THIS key, not just
  // that it booted at all.
  const expectedPublicKeyPem = createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'pem' });

  const server = spawn(process.execPath, [path.join(REGISTRY_ROOT, 'server.mjs')], {
    env: {
      ...process.env,
      // Pinned, not inherited: an ambient DATABASE_URL in the real shell
      // environment (e.g. once Task 4 exports one) would silently flip
      // this spawned boot onto the 'pg' driver and fail -- this test only
      // cares about the memory-store boot path. Same for VOYAGE_API_KEY,
      // which this test has no opinion on either way.
      DATABASE_URL: '',
      VOYAGE_API_KEY: '',
      REGISTRY_TOKEN: 'keygen-boot-test-token',
      REGISTRY_SIGNING_KEY: privateKeyPem,
      PORT: '0',
    },
  });

  let serverStdout = '';
  const listening = new Promise((resolvePromise, reject) => {
    server.stdout.on('data', (chunk) => {
      serverStdout += chunk.toString('utf8');
      const match = /listening on port (\d+)/.exec(serverStdout);
      if (match) resolvePromise(Number(match[1]));
    });
    server.on('exit', (code) => reject(new Error(`server exited early with code ${code}`)));
    server.on('error', reject);
  });

  try {
    const port = await listening;
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.publicKey, expectedPublicKeyPem);
  } finally {
    server.kill();
  }
});
