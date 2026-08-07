import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import test from 'node:test';

import { flowId, parseFlow, serializeFlow } from '../../lib/flows/artifact.mjs';
import { createMemoryStore } from '../lib/memory-store.mjs';
import { embedTextFor, ingest } from '../lib/ingest.mjs';
import { sign, verify } from '../lib/signing.mjs';
import { opSequence, stepSignature } from '../lib/signature-fields.mjs';
import { REGISTRY_CLUSTER_THRESHOLD } from '../lib/constants.mjs';
import { baseFlow, target } from './helpers/fixtures.mjs';

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

// --- fix round 1: Critical #1 (surrogate ids, refuse-overwrite guard) ---

test('ingest() never lets two different flows collide on the store id, even when they share the same self-declared artifact id', async () => {
  const store = createMemoryStore();
  await store.init();
  const { signer } = testSigner();

  const aFlow = parseFlow(baseFlow({ name: 'ingest-idcollision-a' }));
  const bFlow = parseFlow(baseFlow({ name: 'ingest-idcollision-b' }));
  // baseFlow()'s own default `id` is a fixed constant unless overridden --
  // both fixtures above share it, on purpose, proving the store's row
  // identity does not depend on it at all (fix round 1, Critical #1(a):
  // crypto.randomUUID(), never contentHash, never the artifact's own id).
  assert.equal(aFlow.id, bFlow.id, 'the fixture must actually exercise a shared self-declared artifact id');

  const a = await ingest({ envelope: envelopeFor({ name: 'ingest-idcollision-a' }), store, signer, embedder: null });
  const b = await ingest({ envelope: envelopeFor({ name: 'ingest-idcollision-b' }), store, signer, embedder: null });

  assert.equal(a.outcome, 'created');
  assert.equal(b.outcome, 'created');
  assert.notEqual(a.canonicalId, b.canonicalId);
  assert.notEqual(a.canonicalId, contentHashOf(aFlow), 'the store id must never equal contentHash either');

  const storedA = await store.get(a.canonicalId);
  const storedB = await store.get(b.canonicalId);
  assert.equal(storedA.name, 'ingest-idcollision-a');
  assert.equal(storedB.name, 'ingest-idcollision-b');
  assert.deepEqual(await store.health(), { ok: true, count: 2 });
});

// --- fix round 1: Critical #1 (the reviewer's exact overwrite scenario)
// ---

test('ingest() re-pushing a canonical\'s ORIGINAL pre-merge bytes with a null embedder must NOT destroy an already-merged canonical', async () => {
  const store = createMemoryStore();
  await store.init();
  const { signer, publicKey } = testSigner();

  const canonicalFlowInput = baseFlow({ name: 'ingest-overwrite-canonical' });
  const incomingLocator = { kind: 'testid', selector: 'place-order-button' };
  const incomingFlowInput = baseFlow({
    name: 'ingest-overwrite-incoming',
    steps: canonicalFlowInput.steps.map((step, index) => {
      if (index !== 2) return step; // the click step
      return { ...step, target: { ...step.target, locators: [...step.target.locators, incomingLocator] } };
    }),
  });
  const canonicalEnvelope = envelopeFor(canonicalFlowInput);

  // Step 1: create A, using a real embedder so it can later cluster.
  const embedder = queueEmbedder([REFERENCE_VECTOR, unitVectorAtCosine(0.99)]);
  const created = await ingest({ envelope: canonicalEnvelope, store, signer, embedder });
  assert.equal(created.outcome, 'created');

  // Step 2: push a near-duplicate B -- clusters into A's canonical.
  const clustered = await ingest({ envelope: envelopeFor(incomingFlowInput), store, signer, embedder });
  assert.equal(clustered.outcome, 'clustered');
  assert.equal(clustered.canonicalId, created.canonicalId);

  const mergedBefore = await store.get(created.canonicalId);
  assert.equal(mergedBefore.mergedCount, 1);
  const mergedLocatorsBefore = mergedBefore.content.steps[2].target.locators;
  assert.deepEqual(mergedLocatorsBefore, [...canonicalFlowInput.steps[2].target.locators, incomingLocator]);

  // Step 3: the reviewer's exact scenario -- re-push A's ORIGINAL bytes
  // (the exact same envelope from step 1), but this time with a NULL
  // embedder (a keyless restart, or every Voyage call degrading). A's own
  // contentHash is no longer indexed (it moved when B merged in), so
  // exact-dedup does not catch this, and clustering cannot even be
  // attempted without an embedder -- before the fix, this fell through to
  // createCanonical, which recomputed the SAME id (contentHash-derived)
  // and overwrote the merged canonical wholesale.
  const rePush = await ingest({ envelope: canonicalEnvelope, store, signer, embedder: null });

  // Acceptable outcome per the ruling: 'created' as a NEW, separate
  // record -- a keyless pipeline cannot prove cluster identity, so it
  // must never silently resurrect or merge into the existing canonical
  // either; it must simply never DESTROY it.
  assert.equal(rePush.outcome, 'created');
  assert.notEqual(rePush.canonicalId, created.canonicalId);

  // The merged canonical (A+B) must be completely untouched: same
  // mergedCount, same alternates, same signature.
  const mergedAfter = await store.get(created.canonicalId);
  assert.equal(mergedAfter.mergedCount, 1, 'the merged canonical\'s mergedCount must survive the re-push');
  assert.deepEqual(
    mergedAfter.content.steps[2].target.locators,
    mergedLocatorsBefore,
    'the merged canonical\'s alternates must survive the re-push',
  );
  assert.deepEqual(mergedAfter, mergedBefore, 'the merged canonical must be byte-for-byte untouched by the re-push');
  const mergedCanonicalFlow = parseFlow(mergedAfter.content);
  assert.equal(verify(serializeFlow(mergedCanonicalFlow), mergedAfter.signature, publicKey), true);

  // Both records exist, independently.
  assert.deepEqual(await store.health(), { ok: true, count: 2 });
  const rePushed = await store.get(rePush.canonicalId);
  assert.equal(rePushed.name, 'ingest-overwrite-canonical');
});

// --- fix round 1: Important #3 (no-op re-merge must not bump mergedCount
// or updatedAt) ---

test('ingest() re-pushing the SAME near-duplicate repeatedly after a merge is a true no-op: mergedCount and updatedAt stay stable', async () => {
  const store = createMemoryStore();
  await store.init();
  const { signer } = testSigner();

  const canonicalFlowInput = baseFlow({ name: 'ingest-noop-remerge-canonical' });
  const incomingLocator = { kind: 'testid', selector: 'place-order-button' };
  const incomingFlowInput = baseFlow({
    name: 'ingest-noop-remerge-incoming',
    steps: canonicalFlowInput.steps.map((step, index) => {
      if (index !== 2) return step;
      return { ...step, target: { ...step.target, locators: [...step.target.locators, incomingLocator] } };
    }),
  });
  const incomingEnvelope = envelopeFor(incomingFlowInput);

  // Every call returns the same vector -- cosine 1.0 throughout, so every
  // push in this test clears the cluster threshold if a candidate exists.
  const embedder = async () => REFERENCE_VECTOR;

  const created = await ingest({ envelope: envelopeFor(canonicalFlowInput), store, signer, embedder });
  assert.equal(created.outcome, 'created');

  const firstMerge = await ingest({ envelope: incomingEnvelope, store, signer, embedder });
  assert.equal(firstMerge.outcome, 'clustered');
  const afterFirstMerge = await store.get(created.canonicalId);
  assert.equal(afterFirstMerge.mergedCount, 1);
  const updatedAtAfterFirstMerge = afterFirstMerge.updatedAt;

  // Re-push the SAME B bytes three more times -- every incoming locator is
  // already present in the canonical, so the union adds nothing new.
  for (let i = 0; i < 3; i += 1) {
    const rePush = await ingest({ envelope: incomingEnvelope, store, signer, embedder });
    assert.equal(rePush.outcome, 'clustered');
    assert.equal(rePush.canonicalId, created.canonicalId);
  }

  const afterRepeats = await store.get(created.canonicalId);
  assert.equal(afterRepeats.mergedCount, 1, 'a no-op re-merge must never increment mergedCount');
  assert.equal(afterRepeats.updatedAt, updatedAtAfterFirstMerge, 'a no-op re-merge must never bump updatedAt');
  assert.deepEqual(afterRepeats, afterFirstMerge, 'a no-op re-merge must leave the stored record byte-for-byte unchanged');
});

// --- fix round 1: Critical #2 (per-step identity anchor) ---
//
// stepSignature equality alone does not establish that two steps target
// the SAME element -- these three regression pins are the reviewer's own
// reproduced cases; the two positive cases after them prove the anchor
// check is not simply refusing to cluster ANYTHING.

test('ingest() does NOT cluster an expect step whose text-target content differs ("Order placed" vs "Order FAILED"), even at cosine 1.0', async () => {
  const store = createMemoryStore();
  await store.init();
  const { signer } = testSigner();

  // baseFlow()'s own expect step already has neither role nor name (see
  // registry/tests/helpers/fixtures.mjs) -- exactly the shape stepSignature
  // is structurally blind to. Only the expect step's locator/description
  // differs between the two fixtures below; every other step is identical.
  const canonicalFlowInput = baseFlow({ name: 'ingest-anchor-expect-canonical' });
  const incomingFlowInput = baseFlow({
    name: 'ingest-anchor-expect-incoming',
    steps: canonicalFlowInput.steps.map((step, index) => {
      if (index !== 3) return step; // the expect step
      return {
        ...step,
        target: target({
          locators: [{ kind: 'text', selector: 'internal:text="Order FAILED"' }],
          description: 'Order FAILED',
          role: undefined,
          name: undefined,
        }),
      };
    }),
  });
  assert.equal(
    stepSignature(parseFlow(incomingFlowInput)),
    stepSignature(parseFlow(canonicalFlowInput)),
    'the fixture must actually exercise an IDENTICAL stepSignature -- proving the anchor check, not the signature gate, is what blocks this',
  );

  const embedder = async () => REFERENCE_VECTOR; // cosine 1.0, the most generous possible score

  const created = await ingest({ envelope: envelopeFor(canonicalFlowInput), store, signer, embedder });
  assert.equal(created.outcome, 'created');

  const result = await ingest({ envelope: envelopeFor(incomingFlowInput), store, signer, embedder });
  assert.equal(result.outcome, 'created', '"Order placed" and "Order FAILED" must never be treated as the same canonical');
  assert.notEqual(result.canonicalId, created.canonicalId);

  const stored = await store.get(created.canonicalId);
  assert.equal(stored.mergedCount, 0);
});

test('ingest() does NOT cluster a drag step whose "to" (drop destination) differs, even at cosine 1.0', async () => {
  const store = createMemoryStore();
  await store.init();
  const { signer } = testSigner();

  function dragFlow(name, toSelector) {
    return baseFlow({
      name,
      steps: [
        { op: 'goto', url: '/checkout/{plan}' },
        {
          op: 'drag',
          target: target({
            locators: [{ kind: 'css', selector: '#item-1' }],
            description: undefined,
            role: undefined,
            name: undefined,
          }),
          to: target({
            locators: [{ kind: 'css', selector: toSelector }],
            description: undefined,
            role: undefined,
            name: undefined,
          }),
        },
      ],
    });
  }

  const canonicalFlowInput = dragFlow('ingest-anchor-drag-canonical', '#bin-a');
  const incomingFlowInput = dragFlow('ingest-anchor-drag-incoming', '#bin-b');
  assert.equal(
    stepSignature(parseFlow(incomingFlowInput)),
    stepSignature(parseFlow(canonicalFlowInput)),
    'drag\'s `to` is not part of stepSignature at all -- the fixture must share stepSignature despite a different destination',
  );

  const embedder = async () => REFERENCE_VECTOR;

  const created = await ingest({ envelope: envelopeFor(canonicalFlowInput), store, signer, embedder });
  assert.equal(created.outcome, 'created');

  const result = await ingest({ envelope: envelopeFor(incomingFlowInput), store, signer, embedder });
  assert.equal(result.outcome, 'created', 'a drag to a different destination must never be treated as the same canonical');
  assert.notEqual(result.canonicalId, created.canonicalId);
});

test('ingest() does NOT cluster two clicks on different CSS-selector targets (#confirm vs #delete-account) with no role/name, even at cosine 1.0', async () => {
  const store = createMemoryStore();
  await store.init();
  const { signer } = testSigner();

  function clickFlow(name, selector) {
    return baseFlow({
      name,
      steps: [
        { op: 'goto', url: '/checkout/{plan}' },
        {
          op: 'click',
          target: target({
            locators: [{ kind: 'css', selector }],
            description: undefined,
            role: undefined,
            name: undefined,
          }),
        },
      ],
    });
  }

  const canonicalFlowInput = clickFlow('ingest-anchor-click-canonical', '#confirm');
  const incomingFlowInput = clickFlow('ingest-anchor-click-incoming', '#delete-account');
  assert.equal(
    stepSignature(parseFlow(incomingFlowInput)),
    stepSignature(parseFlow(canonicalFlowInput)),
    'both targets have neither role nor name -- the fixture must share the collapsed (op, "", "", "") stepSignature tuple',
  );

  const embedder = async () => REFERENCE_VECTOR;

  const created = await ingest({ envelope: envelopeFor(canonicalFlowInput), store, signer, embedder });
  assert.equal(created.outcome, 'created');

  const result = await ingest({ envelope: envelopeFor(incomingFlowInput), store, signer, embedder });
  assert.equal(result.outcome, 'created', '#confirm and #delete-account must never be treated as the same canonical');
  assert.notEqual(result.canonicalId, created.canonicalId);

  const stored = await store.get(created.canonicalId);
  assert.equal(stored.mergedCount, 0, 'the canonical\'s fallback chain must never gain #delete-account');
});

// MAT-160 Task 4 (determinism sweep): both-null anchor tightening. Two
// flows whose only difference is a locator-less, role/name-less step
// (neither carries ANY locator at all -- not merely a matching-but-empty
// role/name, but zero locators to fall back on either) must NOT cluster,
// even at cosine 1.0 -- before this fix, `primaryLocatorIdentity(a) ===
// primaryLocatorIdentity(b)` collapsed to `null === null`, anchoring two
// steps that carry no identifying information about what either one
// targets at all.
test('ingest() does NOT cluster two flows whose only difference is a locator-less, role/name-less step (both-null anchor tightening)', async () => {
  const store = createMemoryStore();
  await store.init();
  const { signer } = testSigner();

  function locatorLessClickFlow(name) {
    return baseFlow({
      name,
      steps: [
        { op: 'goto', url: '/checkout/{plan}' },
        { op: 'click', target: { locators: [] } },
      ],
    });
  }

  const canonicalFlowInput = locatorLessClickFlow('ingest-anchor-bothnull-canonical');
  const incomingFlowInput = locatorLessClickFlow('ingest-anchor-bothnull-incoming');
  assert.equal(
    stepSignature(parseFlow(incomingFlowInput)),
    stepSignature(parseFlow(canonicalFlowInput)),
    'both targets have no role/name AND no locators -- the fixture must share the collapsed (op, "", "", "") stepSignature tuple',
  );

  const embedder = async () => REFERENCE_VECTOR; // cosine 1.0, the most generous possible score

  const created = await ingest({ envelope: envelopeFor(canonicalFlowInput), store, signer, embedder });
  assert.equal(created.outcome, 'created');

  const result = await ingest({ envelope: envelopeFor(incomingFlowInput), store, signer, embedder });
  assert.equal(result.outcome, 'created', 'two locator-less, role/name-less steps must never be treated as anchored to the same element');
  assert.notEqual(result.canonicalId, created.canonicalId);

  const stored = await store.get(created.canonicalId);
  assert.equal(stored.mergedCount, 0);
});

test('ingest() still clusters when role+name are identical and only the alternates differ (the anchor check does not over-block)', async () => {
  const store = createMemoryStore();
  await store.init();
  const { signer } = testSigner();

  const canonicalFlowInput = baseFlow({ name: 'ingest-anchor-positive-rolename-canonical' });
  const incomingLocator = { kind: 'testid', selector: 'place-order-button' };
  const incomingFlowInput = baseFlow({
    name: 'ingest-anchor-positive-rolename-incoming',
    steps: canonicalFlowInput.steps.map((step, index) => {
      if (index !== 2) return step; // the click step -- role 'button', name 'Place order', both non-empty
      return { ...step, target: { ...step.target, locators: [...step.target.locators, incomingLocator] } };
    }),
  });

  const embedder = queueEmbedder([REFERENCE_VECTOR, unitVectorAtCosine(0.99)]);

  const created = await ingest({ envelope: envelopeFor(canonicalFlowInput), store, signer, embedder });
  assert.equal(created.outcome, 'created');

  const result = await ingest({ envelope: envelopeFor(incomingFlowInput), store, signer, embedder });
  assert.equal(result.outcome, 'clustered');
  assert.equal(result.canonicalId, created.canonicalId);

  const stored = await store.get(created.canonicalId);
  assert.equal(stored.mergedCount, 1);
  assert.deepEqual(
    stored.content.steps[2].target.locators,
    [...canonicalFlowInput.steps[2].target.locators, incomingLocator],
  );
});

// --- MAT-160 Task 4 (merge re-embed elimination) ---

// embedTextFor is `description | stepSignature` (this module's own
// contract), and a cluster-merge only ever unions target.locators
// (mergeStep, above) -- stepSignature is structurally blind to locators
// (registry/lib/signature-fields.mjs's own doc comment), and description
// is untouched by a merge -- so embedTextFor(mergedFlow) is PROVABLY the
// same text the canonical was already embedded under. This pins the
// resulting call-count contract directly: clustering an unchanged-text
// flow must perform ZERO additional embedder calls beyond the incoming
// envelope's own embed (needed to find the cluster match at all).
test('ingest() cluster-merge reuses the canonical\'s existing embedding, performing ZERO embedder calls beyond the incoming envelope\'s own embed', async () => {
  const store = createMemoryStore();
  await store.init();
  const { signer } = testSigner();

  const canonicalFlowInput = baseFlow({ name: 'ingest-reembed-canonical' });
  const incomingLocator = { kind: 'testid', selector: 'place-order-button' };
  const incomingFlowInput = baseFlow({
    name: 'ingest-reembed-incoming',
    steps: canonicalFlowInput.steps.map((step, index) => {
      if (index !== 2) return step; // the click step
      return { ...step, target: { ...step.target, locators: [...step.target.locators, incomingLocator] } };
    }),
  });

  let calls = 0;
  const underlyingEmbedder = queueEmbedder([REFERENCE_VECTOR, unitVectorAtCosine(0.99)]);
  const countingEmbedder = async (text) => {
    calls += 1;
    return underlyingEmbedder(text);
  };

  const created = await ingest({ envelope: envelopeFor(canonicalFlowInput), store, signer, embedder: countingEmbedder });
  assert.equal(created.outcome, 'created');
  assert.equal(calls, 1, 'the canonical\'s own creation calls the embedder exactly once');

  const result = await ingest({ envelope: envelopeFor(incomingFlowInput), store, signer, embedder: countingEmbedder });
  assert.equal(result.outcome, 'clustered');
  assert.equal(result.canonicalId, created.canonicalId);

  // Call #2 is the incoming envelope's OWN embed (needed to even find a
  // cluster candidate to compare against) -- the merge path itself must
  // add ZERO further calls on top of that.
  assert.equal(calls, 2, 'the merge path must never call the embedder again beyond the incoming envelope\'s own embed');

  const stored = await store.get(created.canonicalId);
  assert.deepEqual(
    Array.from(stored.embedding),
    Array.from(REFERENCE_VECTOR),
    'the canonical keeps its ORIGINAL (creation-time) embedding across the merge, unchanged',
  );
});

test('ingest() still clusters when role+name are both empty but the primary locator is identical (the anchor check does not over-block)', async () => {
  const store = createMemoryStore();
  await store.init();
  const { signer } = testSigner();

  function clickFlow(name, extraLocators = []) {
    return baseFlow({
      name,
      steps: [
        { op: 'goto', url: '/checkout/{plan}' },
        {
          op: 'click',
          target: target({
            locators: [{ kind: 'css', selector: '#confirm' }, ...extraLocators],
            description: undefined,
            role: undefined,
            name: undefined,
          }),
        },
      ],
    });
  }

  const extraLocator = { kind: 'testid', selector: 'confirm-button' };
  const canonicalFlowInput = clickFlow('ingest-anchor-positive-primary-canonical');
  const incomingFlowInput = clickFlow('ingest-anchor-positive-primary-incoming', [extraLocator]);
  assert.equal(
    stepSignature(parseFlow(incomingFlowInput)),
    stepSignature(parseFlow(canonicalFlowInput)),
    'both share the SAME primary (#confirm) locator, so both collapse to the same stepSignature tuple',
  );

  const embedder = queueEmbedder([REFERENCE_VECTOR, unitVectorAtCosine(0.99)]);

  const created = await ingest({ envelope: envelopeFor(canonicalFlowInput), store, signer, embedder });
  assert.equal(created.outcome, 'created');

  const result = await ingest({ envelope: envelopeFor(incomingFlowInput), store, signer, embedder });
  assert.equal(result.outcome, 'clustered', 'an identical PRIMARY locator with empty role/name must still be allowed to cluster');
  assert.equal(result.canonicalId, created.canonicalId);

  const stored = await store.get(created.canonicalId);
  assert.equal(stored.mergedCount, 1);
  assert.deepEqual(
    stored.content.steps[1].target.locators,
    [{ kind: 'css', selector: '#confirm' }, extraLocator],
  );
});
