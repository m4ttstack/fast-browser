import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import test from 'node:test';

import { flowId, parseFlow, serializeFlow } from '../../lib/flows/artifact.mjs';
import { createMemoryStore } from '../lib/memory-store.mjs';
import { embedTextFor, ingest } from '../lib/ingest.mjs';
import { sign, verify } from '../lib/signing.mjs';
import { opSequence, stepSignature } from '../lib/signature-fields.mjs';
import { REGISTRY_CLUSTER_THRESHOLD } from '../lib/constants.mjs';
import { baseFlow } from './helpers/fixtures.mjs';

// registry/lib/ingest.mjs (WS4b plan, Task 5): validate, verify, lint,
// dedup, cluster-merge, sign, index. See that module's own top comment for
// the exact pipeline order this suite pins.

function testSigner() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return { signer: { sign: (bytes) => sign(bytes, privateKey) }, publicKey };
}

function contentHashOf(flow) {
  return createHash('sha256').update(serializeFlow(flow)).digest('hex');
}

// Builds a push envelope ({ artifact, contentHash }) from flow overrides,
// matching the exact wire shape ingest() consumes -- no signature on push.
function envelopeFor(flowOverrides = {}) {
  const flow = parseFlow(baseFlow(flowOverrides));
  return { artifact: flow, contentHash: contentHashOf(flow) };
}

// A unit vector [cosTheta, sinTheta] against the reference vector [1, 0] --
// cosine similarity between the two is EXACTLY cosTheta, by construction
// (both vectors have norm 1), so tests can pin an exact threshold-adjacent
// cosine value rather than an approximate one.
function unitVectorAtCosine(cosTheta) {
  return Float64Array.from([cosTheta, Math.sqrt(1 - cosTheta ** 2)]);
}

// A queue-based embedder stub: the Nth call returns the Nth vector (the
// last vector repeats for any call past the end of the queue). Used
// instead of a text-keyed stub because two near-duplicate flows can
// legitimately embed the SAME text (same description, same stepSignature)
// yet need to compare at less than cosine 1.0 -- call order, not call
// content, is what has to vary here.
function queueEmbedder(vectors) {
  let index = 0;
  return async () => {
    const vector = vectors[Math.min(index, vectors.length - 1)];
    index += 1;
    return vector;
  };
}

const REFERENCE_VECTOR = Float64Array.from([1, 0]);

test('ingest() rejects a PII-tainted flow with the lint reasons, never touching the store', async () => {
  const store = createMemoryStore();
  await store.init();
  const { signer } = testSigner();

  const envelope = envelopeFor({ description: 'Contact support at jane.doe@example.com if this fails' });
  const result = await ingest({ envelope, store, signer, embedder: null });

  assert.equal(result.outcome, 'rejected');
  assert.equal(result.canonicalId, null);
  assert.deepEqual(result.reasons, [{ path: 'description', rule: 'email' }]);
  assert.deepEqual(await store.health(), { ok: true, count: 0 });
});

test('ingest() rejects a contentHash mismatch, never touching the store', async () => {
  const store = createMemoryStore();
  await store.init();
  const { signer } = testSigner();

  const flow = parseFlow(baseFlow());
  const result = await ingest({
    envelope: { artifact: flow, contentHash: '0'.repeat(64) },
    store,
    signer,
    embedder: null,
  });

  assert.equal(result.outcome, 'rejected');
  assert.equal(result.canonicalId, null);
  assert.deepEqual(result.reasons, [{ rule: 'content-hash-mismatch' }]);
  assert.deepEqual(await store.health(), { ok: true, count: 0 });
});

test('ingest() rejects a malformed artifact (fails parseFlow) with an invalid-artifact reason', async () => {
  const store = createMemoryStore();
  await store.init();
  const { signer } = testSigner();

  const result = await ingest({
    envelope: { artifact: { not: 'a flow' }, contentHash: '0'.repeat(64) },
    store,
    signer,
    embedder: null,
  });

  assert.equal(result.outcome, 'rejected');
  assert.equal(result.canonicalId, null);
  assert.equal(result.reasons.length, 1);
  assert.equal(result.reasons[0].rule, 'invalid-artifact');
  assert.equal(typeof result.reasons[0].message, 'string');
});

test('ingest() creates a new canonical for a clean flow, signed and verifiable, keyless (embedder null)', async () => {
  const store = createMemoryStore();
  await store.init();
  const { signer, publicKey } = testSigner();

  const envelope = envelopeFor({ name: 'ingest-create-flow' });
  const result = await ingest({ envelope, store, signer, embedder: null });

  assert.equal(result.name, 'ingest-create-flow');
  assert.equal(result.outcome, 'created');
  assert.equal(typeof result.canonicalId, 'string');
  assert.deepEqual(result.reasons, []);

  const stored = await store.get(result.canonicalId);
  assert.equal(stored.embedding, null, 'keyless ingest stores embedding null');
  assert.equal(stored.mergedCount, 0);

  // Signature round trip through the store: re-derive canonical bytes from
  // the STORED content (never trust the object's key order as-is) and
  // verify against the public key derived from the same test signing key.
  const canonicalFlow = parseFlow(stored.content);
  assert.equal(verify(serializeFlow(canonicalFlow), stored.signature, publicKey), true);
});

test('ingest() signature round-trip through the store survives a structuredClone-style key-reordering read', async () => {
  const store = createMemoryStore();
  await store.init();
  const { signer, publicKey } = testSigner();

  const envelope = envelopeFor({ name: 'ingest-roundtrip-flow' });
  const created = await ingest({ envelope, store, signer, embedder: null });

  // get() (unlike putCanonical's own return value) is the read path a
  // real caller (a future pull handler) would use -- round trip through
  // it specifically.
  const fetched = await store.get(created.canonicalId);
  const canonicalFlow = parseFlow(fetched.content);
  const bytes = serializeFlow(canonicalFlow);
  assert.equal(contentHashOf(canonicalFlow), fetched.contentHash);
  assert.equal(verify(bytes, fetched.signature, publicKey), true);

  // Tampering with even one byte of the re-derived canonical bytes must
  // fail verification -- proves this is a real signature check, not a
  // trivially-true stub.
  const tamperedFlow = parseFlow(baseFlow({ name: 'ingest-roundtrip-flow', description: 'tampered' }));
  assert.equal(verify(serializeFlow(tamperedFlow), fetched.signature, publicKey), false);
});

test('ingest() exact-hash re-push is idempotent: second push deduped, mergedCount unchanged', async () => {
  const store = createMemoryStore();
  await store.init();
  const { signer } = testSigner();

  const envelope = envelopeFor({ name: 'ingest-idempotent-flow' });
  const first = await ingest({ envelope, store, signer, embedder: null });
  assert.equal(first.outcome, 'created');

  const second = await ingest({ envelope, store, signer, embedder: null });
  assert.equal(second.outcome, 'deduped');
  assert.equal(second.canonicalId, first.canonicalId);
  assert.deepEqual(second.reasons, []);

  const stored = await store.get(first.canonicalId);
  assert.equal(stored.mergedCount, 0, 'a dedup must never increment mergedCount');
  assert.deepEqual(await store.health(), { ok: true, count: 1 }, 'a dedup must never create a second record');
});

test('ingest() with a null embedder (keyless) skips clustering entirely: two structurally-identical flows both create', async () => {
  const store = createMemoryStore();
  await store.init();
  const { signer } = testSigner();

  const a = await ingest({ envelope: envelopeFor({ name: 'ingest-keyless-a' }), store, signer, embedder: null });
  const b = await ingest({ envelope: envelopeFor({ name: 'ingest-keyless-b' }), store, signer, embedder: null });

  assert.equal(a.outcome, 'created');
  assert.equal(b.outcome, 'created');
  assert.notEqual(a.canonicalId, b.canonicalId);
  assert.deepEqual(await store.health(), { ok: true, count: 2 });
});

test('ingest() with an embedder that degrades to null for this envelope skips clustering, still creates with embedding null', async () => {
  const store = createMemoryStore();
  await store.init();
  const { signer } = testSigner();
  const flakyEmbedder = async () => null; // mirrors the production embedder degrading on a Voyage failure

  const result = await ingest({ envelope: envelopeFor({ name: 'ingest-degraded-embed' }), store, signer, embedder: flakyEmbedder });

  assert.equal(result.outcome, 'created');
  const stored = await store.get(result.canonicalId);
  assert.equal(stored.embedding, null);
});

// --- clustering: the pinned near-duplicate collapse ---

test('ingest() clusters two near-duplicate flows at cosine 0.96 (same origin + opSequence): alternates union append-only, canonical re-signed and verifiable, mergedCount incremented', async () => {
  const store = createMemoryStore();
  await store.init();
  const { signer, publicKey } = testSigner();

  const canonicalFlowInput = baseFlow({ name: 'ingest-cluster-canonical' });
  const incomingLocator = { kind: 'testid', selector: 'place-order-button' };
  const incomingFlowInput = baseFlow({
    name: 'ingest-cluster-incoming',
    steps: canonicalFlowInput.steps.map((step, index) => {
      if (index !== 2) return step; // the click step
      return { ...step, target: { ...step.target, locators: [...step.target.locators, incomingLocator] } };
    }),
  });

  // First call (canonical creation) -> the reference vector. Every call
  // after that -> a vector at exactly cosine 0.96 from the reference --
  // this is what makes the incoming-vs-stored comparison a REAL 0.96,
  // not two calls returning the same constant (which would trivially
  // cosine to 1.0 and prove nothing about the threshold).
  const embedder = queueEmbedder([REFERENCE_VECTOR, unitVectorAtCosine(0.96)]);

  const created = await ingest({ envelope: envelopeFor(canonicalFlowInput), store, signer, embedder });
  assert.equal(created.outcome, 'created');

  const result = await ingest({ envelope: envelopeFor(incomingFlowInput), store, signer, embedder });
  assert.equal(result.outcome, 'clustered');
  assert.equal(result.canonicalId, created.canonicalId);
  assert.deepEqual(result.reasons, []);

  const stored = await store.get(created.canonicalId);
  assert.equal(stored.mergedCount, 1);
  assert.equal(stored.name, 'ingest-cluster-canonical', 'the canonical keeps its OWN name across a merge');

  // Append-only alternates union: every original canonical locator
  // survives, in order, with the incoming flow's new alternate appended
  // after them -- never removed, never reordered.
  const clickLocators = stored.content.steps[2].target.locators;
  assert.deepEqual(clickLocators, [...canonicalFlowInput.steps[2].target.locators, incomingLocator]);

  // Every OTHER step is untouched.
  assert.deepEqual(stored.content.steps[0], canonicalFlowInput.steps[0]);
  assert.deepEqual(stored.content.steps[1].target.locators, canonicalFlowInput.steps[1].target.locators);
  assert.deepEqual(stored.content.steps[3].target.locators, canonicalFlowInput.steps[3].target.locators);

  // The merge changed content -> contentHash must have moved off the
  // pre-merge canonical's own hash, and the canonical's own content id was
  // recomputed from the merged content (mirrors lib/flows/heal.mjs's
  // applyHeal precedent -- "a heal recomputes id from the appended
  // locator"), while the STORE's own id (the primary key) stayed exactly
  // the same across the merge.
  const preMergeContentHash = contentHashOf(parseFlow(canonicalFlowInput));
  assert.notEqual(stored.contentHash, preMergeContentHash);
  assert.equal(stored.id, created.canonicalId);
  const canonicalFlow = parseFlow(stored.content);
  assert.equal(canonicalFlow.id, flowId(canonicalFlow));
  assert.equal(stored.contentHash, contentHashOf(canonicalFlow));

  // Re-signed over the refreshed canonical bytes, verifiable against the
  // signer's public key.
  assert.equal(verify(serializeFlow(canonicalFlow), stored.signature, publicKey), true);

  // stepSignature/opSequence/origin/description are identity fields that
  // must NOT change across a merge -- only the locators did.
  assert.equal(stored.stepSignature, stepSignature(parseFlow(canonicalFlowInput)));
  assert.equal(stored.opSequence, opSequence(parseFlow(canonicalFlowInput)));
  assert.equal(stored.origin, canonicalFlowInput.origin);
});

test('ingest() does NOT cluster at cosine 0.94 (below REGISTRY_CLUSTER_THRESHOLD): second push creates a separate canonical', async () => {
  assert.equal(REGISTRY_CLUSTER_THRESHOLD, 0.95, 'this test pins behavior right at the documented threshold');

  const store = createMemoryStore();
  await store.init();
  const { signer } = testSigner();

  const canonicalFlowInput = baseFlow({ name: 'ingest-nocluster-canonical' });
  const incomingFlowInput = baseFlow({ name: 'ingest-nocluster-incoming' });

  const embedder = queueEmbedder([REFERENCE_VECTOR, unitVectorAtCosine(0.94)]);

  const created = await ingest({ envelope: envelopeFor(canonicalFlowInput), store, signer, embedder });
  assert.equal(created.outcome, 'created');

  const result = await ingest({ envelope: envelopeFor(incomingFlowInput), store, signer, embedder });
  assert.equal(result.outcome, 'created');
  assert.notEqual(result.canonicalId, created.canonicalId);

  const stored = await store.get(created.canonicalId);
  assert.equal(stored.mergedCount, 0, 'a below-threshold cosine must never merge');
  assert.deepEqual(await store.health(), { ok: true, count: 2 });
});

test('ingest() never clusters across a different opSequence, regardless of cosine (a 1.0 cosine still does not merge)', async () => {
  const store = createMemoryStore();
  await store.init();
  const { signer } = testSigner();

  const canonicalFlowInput = baseFlow({ name: 'ingest-diffops-canonical' });
  // Drops the trailing 'expect' step -- a genuinely different opSequence,
  // even though the shared steps are otherwise identical and the stub
  // embedder below returns an IDENTICAL vector both times (cosine 1.0,
  // the most generous possible score).
  const incomingFlowInput = baseFlow({
    name: 'ingest-diffops-incoming',
    steps: canonicalFlowInput.steps.slice(0, -1),
  });
  assert.notEqual(
    opSequence(parseFlow(incomingFlowInput)),
    opSequence(parseFlow(canonicalFlowInput)),
    'the fixture must actually exercise a different opSequence',
  );

  const embedder = queueEmbedder([REFERENCE_VECTOR, REFERENCE_VECTOR]);

  const created = await ingest({ envelope: envelopeFor(canonicalFlowInput), store, signer, embedder });
  assert.equal(created.outcome, 'created');

  const result = await ingest({ envelope: envelopeFor(incomingFlowInput), store, signer, embedder });
  assert.equal(result.outcome, 'created');
  assert.notEqual(result.canonicalId, created.canonicalId);

  const stored = await store.get(created.canonicalId);
  assert.equal(stored.mergedCount, 0);
});

test('ingest() never clusters across a different stepSignature (same origin + opSequence, different target role/name)', async () => {
  const store = createMemoryStore();
  await store.init();
  const { signer } = testSigner();

  const canonicalFlowInput = baseFlow({ name: 'ingest-diffsig-canonical' });
  const incomingFlowInput = baseFlow({
    name: 'ingest-diffsig-incoming',
    steps: canonicalFlowInput.steps.map((step, index) => {
      if (index !== 2) return step; // the click step
      // Same op ('click'), same opSequence -- but a DIFFERENT target
      // (role/name), which changes stepSignature even though opSequence
      // is untouched. A real "different action that happens to look
      // similar" case -- exactly the shape stepSignature equality exists
      // to keep the alternates union from ever running against.
      return { ...step, target: { ...step.target, role: 'link', name: 'Cancel order' } };
    }),
  });
  assert.equal(
    opSequence(parseFlow(incomingFlowInput)),
    opSequence(parseFlow(canonicalFlowInput)),
    'this fixture must share opSequence -- the store prefilter alone must not be what blocks clustering here',
  );
  assert.notEqual(
    stepSignature(parseFlow(incomingFlowInput)),
    stepSignature(parseFlow(canonicalFlowInput)),
    'the fixture must actually exercise a different stepSignature',
  );

  const embedder = queueEmbedder([REFERENCE_VECTOR, REFERENCE_VECTOR]); // cosine 1.0, most generous possible

  const created = await ingest({ envelope: envelopeFor(canonicalFlowInput), store, signer, embedder });
  assert.equal(created.outcome, 'created');

  const result = await ingest({ envelope: envelopeFor(incomingFlowInput), store, signer, embedder });
  assert.equal(result.outcome, 'created');
  assert.notEqual(result.canonicalId, created.canonicalId);

  const stored = await store.get(created.canonicalId);
  assert.equal(stored.mergedCount, 0);
});

test('ingest() never clusters across a different origin, regardless of cosine or opSequence', async () => {
  const store = createMemoryStore();
  await store.init();
  const { signer } = testSigner();

  const canonicalFlowInput = baseFlow({ name: 'ingest-difforigin-canonical', origin: 'http://a.example' });
  const incomingFlowInput = baseFlow({ name: 'ingest-difforigin-incoming', origin: 'http://b.example' });

  const embedder = queueEmbedder([REFERENCE_VECTOR, REFERENCE_VECTOR]);

  const created = await ingest({ envelope: envelopeFor(canonicalFlowInput), store, signer, embedder });
  assert.equal(created.outcome, 'created');

  const result = await ingest({ envelope: envelopeFor(incomingFlowInput), store, signer, embedder });
  assert.equal(result.outcome, 'created');
  assert.notEqual(result.canonicalId, created.canonicalId);
});

// --- embedTextFor, the exported embedding-text builder ---

test('embedTextFor builds "description | stepSignature", the Shared shapes text contract', () => {
  const flow = parseFlow(baseFlow({ description: 'Fill the order form and place an order' }));
  assert.equal(embedTextFor(flow), `Fill the order form and place an order | ${stepSignature(flow)}`);
});
