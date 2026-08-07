#!/usr/bin/env node
// Deploy smoke test for the registry service (WS4b plan, Task 9). Run this
// against ANY already-deployed registry (local boot or Railway) to prove
// the whole push/pull/search/verify surface works end to end, without
// needing a browser, the CLI, or a checkout's own local flows directory.
//
// Usage: REGISTRY_URL=<url> FAST_BROWSER_REGISTRY_TOKEN=<token> \
//   node registry/scripts/smoke.mjs
//
// ZERO EXTERNAL DEPS: only node:crypto (built in) plus two in-repo, already
// dependency-free leaf modules -- lib/flows/artifact.mjs and
// registry/lib/signing.mjs (see their own doc comments: neither imports
// anything outside node's standard library). This script deliberately does
// NOT import registry/tests/helpers/fixtures.mjs: that module lives under
// tests/, is not guaranteed to ship or stay stable outside a full dev
// checkout, and coupling a deploy diagnostic to a test helper would make
// the two drift for no benefit -- the canary flow is built inline below
// instead, from the same schema fixtures.mjs itself targets.
//
// SECRET HYGIENE: the bearer token is read from FAST_BROWSER_REGISTRY_TOKEN
// and used ONLY in an Authorization header, never logged, never
// interpolated into an error message, never echoed on a missing-env-var
// failure. If you extend this script to print request details, redact
// Authorization the same way.

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { parseFlow, serializeFlow } from '../../lib/flows/artifact.mjs';
import { verify } from '../lib/signing.mjs';

const REQUEST_TIMEOUT_MS = 15_000;

// A fixed, clearly-namespaced, never-real origin/name so the canary can
// never collide with a real user's flow (the registry has no delete API,
// so this canary is expected to live in the registry permanently) and so
// repeated smoke runs keep hitting the exact same identity -- that is what
// makes idempotency observable: an unchanged canary re-pushed a second
// time must hash to the exact same contentHash and come back 'deduped'.
const CANARY_NAME = 'smoke-test-canary';
const CANARY_ORIGIN = 'https://smoke-test.invalid';
const CANARY_ID = createHash('sha256').update('fast-browser-registry-smoke-canary-v1').digest('hex');

// Outcomes a push of an unchanged canary may legitimately report across
// repeated runs (brief's documented set): a first-ever push on a fresh
// registry creates the canonical; a byte-identical re-push exact-dedups
// against it; a keyed (VOYAGE_API_KEY set) registry may instead cluster-
// merge it against a near-identical prior canary. 'rejected' is never
// acceptable for a well-formed canary and fails the step.
const ACCEPTABLE_PUSH_OUTCOMES = new Set(['created', 'deduped', 'clustered']);

function buildCanaryFlow() {
  return {
    schemaVersion: 1,
    id: CANARY_ID,
    name: CANARY_NAME,
    description: 'Fast Browser registry deploy smoke test canary -- never a real flow, safe to leave forever',
    origin: CANARY_ORIGIN,
    urlPattern: '/smoke-test',
    sideEffects: 'read-only',
    args: {},
    result: { kind: 'completion', keys: [] },
    steps: [{ op: 'goto', url: '/smoke-test' }],
    provenance: {
      compiledAt: '2026-08-06T00:00:00.000Z',
      traceDir: 'registry-smoke-test',
      seqRange: [0, 0],
      productVersion: 'smoke',
      successRuns: 0,
      failStreak: 0,
      lastHealed: null,
    },
  };
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

class SmokeStepError extends Error {}

function fail(message) {
  throw new SmokeStepError(message);
}

// One place every request is issued: bearer auth, a fixed timeout
// (AbortSignal.timeout -- no manual clearTimeout bookkeeping needed), and a
// response-body-as-JSON contract. Never logs headers or the token; the
// only thing ever printed about a failed request is its status code and a
// truncated, non-secret body snippet.
async function registryRequest(baseUrl, { method = 'GET', path: requestPath, query, auth = true, body }) {
  const url = new URL(requestPath, baseUrl);
  if (query) {
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  }
  const headers = { Accept: 'application/json' };
  if (auth) headers.Authorization = `Bearer ${process.env.FAST_BROWSER_REGISTRY_TOKEN}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // error.message on an AbortError/network failure never contains the
    // token (fetch does not echo request headers back into its errors) --
    // safe to surface as-is.
    fail(`${method} ${requestPath}: request failed (${error?.message ?? error})`);
  }

  const text = await response.text();
  let parsed;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    fail(`${method} ${requestPath}: response was not valid JSON (status ${response.status})`);
  }

  if (!response.ok) {
    const code = parsed?.error?.code ?? '(no error code)';
    fail(`${method} ${requestPath}: HTTP ${response.status} ${code}`);
  }

  return parsed;
}

// --- steps ---

async function stepHealth(baseUrl) {
  const payload = await registryRequest(baseUrl, { path: '/health', auth: false });
  if (payload?.ok !== true) fail('GET /health did not report ok: true');
  if (typeof payload.publicKey !== 'string' || !payload.publicKey.includes('BEGIN PUBLIC KEY')) {
    fail('GET /health did not serve a PEM public key');
  }
  return {
    detail: `version ${payload.version}, clustering ${payload.clustering ? 'on' : 'off'}`,
    publicKeyPem: payload.publicKey,
    clustering: Boolean(payload.clustering),
  };
}

async function stepPush(baseUrl) {
  const flow = parseFlow(buildCanaryFlow());
  const canonicalBytes = serializeFlow(flow);
  const contentHash = sha256Hex(canonicalBytes);

  const payload = await registryRequest(baseUrl, {
    method: 'POST',
    path: '/v1/push',
    body: { flows: [{ artifact: flow, contentHash }] },
  });

  const results = Array.isArray(payload?.results) ? payload.results : [];
  const result = results.find((entry) => entry.name === CANARY_NAME);
  if (!result) fail('POST /v1/push response did not include a result for the canary flow');
  if (!ACCEPTABLE_PUSH_OUTCOMES.has(result.outcome)) {
    const reasons = Array.isArray(result.reasons) ? JSON.stringify(result.reasons) : '(no reasons)';
    fail(`canary push outcome was '${result.outcome}' (expected one of ${[...ACCEPTABLE_PUSH_OUTCOMES].join(', ')}); reasons: ${reasons}`);
  }
  return { detail: `outcome '${result.outcome}'`, outcome: result.outcome, contentHash };
}

// TOFU-for-diagnostics: this script trusts whatever public key THIS SAME
// run's own GET /health just served, and verifies the pulled canary's
// signature against it. That is deliberately weaker than the real client's
// trust model (lib/commands/registry.mjs's `registry init`: a human types
// TRUST once, pinning the key to config, and every later pull/search is
// checked against that PINNED value, catching a key that silently changed
// out from under a long-lived install). A smoke run has no persisted state
// across invocations to pin a key into, and pinning-then-comparing would
// only prove "the key didn't change during this one script run", which
// /health already guarantees by construction. What this step DOES prove --
// and the reason it exists -- is that the service actually signs what it
// serves: the canary's signature verifies against the service's own
// current key, over the same canonical bytes the client would recompute.
// It is not, and is not meant to be, proof of the registry's long-term
// identity.
async function stepPullAndVerify(baseUrl, publicKeyPem, expectedContentHash) {
  const payload = await registryRequest(baseUrl, {
    path: '/v1/pull',
    query: { origin: CANARY_ORIGIN },
  });
  const envelopes = Array.isArray(payload?.flows) ? payload.flows : [];
  const envelope = envelopes.find((entry) => entry?.artifact?.name === CANARY_NAME);
  if (!envelope) fail('GET /v1/pull did not return the canary flow');
  // Matching by name alone would also accept a same-named flow with
  // unrelated content; comparing against the contentHash computed at push
  // time (above) confirms this is genuinely the same canonical.
  if (envelope.contentHash !== expectedContentHash) fail(`pulled canary contentHash did not match the hash computed at push time (pulled ${envelope.contentHash}, expected ${expectedContentHash})`);

  let flow;
  try {
    flow = parseFlow(envelope.artifact);
  } catch (error) {
    fail(`pulled canary artifact failed to parse: ${error.message}`);
  }
  const canonicalBytes = serializeFlow(flow);
  const signatureOk = verify(canonicalBytes, envelope.signature, publicKeyPem);
  if (!signatureOk) fail('pulled canary signature did not verify against the /health public key');

  return { detail: 'signature verified against /health publicKey' };
}

async function stepSearch(baseUrl) {
  const payload = await registryRequest(baseUrl, {
    path: '/v1/search',
    // The canary's own name, scoped to its own origin: an exact
    // name/haystack match scores 1.0 in lexical mode and is the query text
    // regardless of mode, so this is expected to surface the canary top of
    // its (origin-scoped, therefore small) result set in either mode.
    query: { intent: CANARY_NAME, origin: CANARY_ORIGIN },
  });
  const mode = payload?.mode;
  if (mode !== 'lexical' && mode !== 'semantic') fail(`GET /v1/search reported an unrecognized mode: ${mode}`);
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const found = results.some((entry) => entry?.envelope?.artifact?.name === CANARY_NAME);
  if (!found) fail(`GET /v1/search (mode '${mode}') did not return the canary flow`);
  return { detail: `mode '${mode}'` };
}

// --- runner ---

async function main() {
  const missing = ['REGISTRY_URL', 'FAST_BROWSER_REGISTRY_TOKEN'].filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.error(`fast-browser-registry smoke: missing required environment variable(s): ${missing.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const baseUrl = process.env.REGISTRY_URL;
  const steps = [
    { name: 'GET /health', run: () => stepHealth(baseUrl) },
    { name: 'POST /v1/push (canary)', run: () => stepPush(baseUrl) },
    { name: 'GET /v1/pull + verify signature', run: (ctx) => stepPullAndVerify(baseUrl, ctx.publicKeyPem, ctx.canaryContentHash) },
    { name: 'GET /v1/search', run: () => stepSearch(baseUrl) },
  ];

  const results = [];
  const ctx = {};
  let allPassed = true;

  for (const step of steps) {
    if (!allPassed) {
      results.push({ name: step.name, status: 'SKIP', detail: 'a previous step failed' });
      continue;
    }
    try {
      const outcome = await step.run(ctx);
      if (outcome?.publicKeyPem) ctx.publicKeyPem = outcome.publicKeyPem;
      if (outcome?.contentHash) ctx.canaryContentHash = outcome.contentHash;
      results.push({ name: step.name, status: 'PASS', detail: outcome?.detail ?? '' });
    } catch (error) {
      allPassed = false;
      const message = error instanceof SmokeStepError ? error.message : `unexpected error: ${error?.stack ?? error}`;
      results.push({ name: step.name, status: 'FAIL', detail: message });
    }
  }

  console.log(`fast-browser-registry smoke against ${baseUrl}`);
  console.log('');
  for (const result of results) {
    const marker = result.status === 'PASS' ? 'PASS' : result.status === 'SKIP' ? 'SKIP' : 'FAIL';
    console.log(`[${marker}] ${result.name}${result.detail ? ` -- ${result.detail}` : ''}`);
  }
  console.log('');
  console.log(allPassed ? 'SMOKE PASSED' : 'SMOKE FAILED');

  process.exitCode = allPassed ? 0 : 1;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(`fast-browser-registry smoke: unexpected error: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}

export { buildCanaryFlow, CANARY_NAME, CANARY_ORIGIN };
