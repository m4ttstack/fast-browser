// The registry ingest pipeline (WS4b plan, Task 5): validate, verify,
// lint, dedup, cluster-merge, sign, index. This is the one place every
// POST /v1/push envelope passes through (registry/lib/http.mjs calls
// ingest() once per flow in the request, in order) and the one place the
// plan's clustering/merge Scope decision is actually implemented.
//
// Pipeline order is EXACT (WS4b plan Task 5 brief), per envelope:
//   1. parseFlow validate (lib/flows/artifact.mjs)      -- malformed = rejected
//   2. contentHash verify (sha256 over serializeFlow bytes) -- mismatch = rejected
//   3. PII lint (registry/lib/pii-lint.mjs)              -- failure = rejected
//   4. exact dedup (store.findByContentHash)              -- hit = deduped
//   5. cluster candidates (store.findClusterCandidates({origin, opSequence})
//      prefilter, then cosine >= REGISTRY_CLUSTER_THRESHOLD when an
//      embedder is active) -> 'clustered' (alternates union) OR 'created'
//
// `ingest({envelope, store, signer, embedder})` never throws for an
// ordinary rejection -- every step above that can fail returns a
// `{ name, outcome: 'rejected', canonicalId: null, reasons }` result
// instead. A thrown error here means something outside the documented
// failure modes (a store method rejecting, a signer throwing) and is the
// caller's (http.mjs's) problem, same as any other unhandled route error.
//
// `signer` is `{ sign(bytes) -> base64 }` (registry/lib/signing.mjs's
// `sign`, bound to the boot private key by the caller -- server.mjs wires
// the real one; tests inject a throwaway-keypair stub with the same
// shape).
//
// `embedder` is EITHER `null` (keyless: no VOYAGE_API_KEY at boot,
// registry/lib/embedder.mjs's createEmbedder already returns exactly
// `null` in that case) -- clustering is skipped entirely and every created
// flow is stored with `embedding: null` -- OR an
// `async (text) -> Float64Array | null` function. Even with an embedder
// configured, a single degraded call (the production embedder never
// throws; see registry/lib/embedder.mjs) still means "skip clustering for
// THIS envelope, store it created with embedding null" -- an embedder
// hiccup must never fail a push.
//
// CRITICAL serialization rule (Task 4 ledger finding, carried forward):
// content that has passed through a store may have had its object keys
// reordered by a jsonb round trip. Canonical bytes for hashing/signing are
// ALWAYS recomputed via `serializeFlow(parseFlow(content))` -- never a raw
// `JSON.stringify` of whatever shape happens to come back from the store.

import { createHash, randomUUID } from 'node:crypto';

import { flowId, parseFlow, serializeFlow } from '../../lib/flows/artifact.mjs';
import { lintArtifact } from './pii-lint.mjs';
import {
  flowsAreAnchored, opSequence, stepSignature,
} from './signature-fields.mjs';
import { REGISTRY_CLUSTER_THRESHOLD } from './constants.mjs';

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// The embedding text contract (Shared shapes, pinned exactly):
// `description + ' | ' + stepSignature`. Exported so tests can compute the
// exact text a given flow will be embedded with, rather than duplicating
// this string-building logic by hand.
export function embedTextFor(flow) {
  return `${flow.description} | ${stepSignature(flow)}`;
}

// Cosine similarity between two embeddings that may be a Float64Array, a
// plain array (a test stub's return value, or a value that has round
// tripped through JSON), or anything else array-like/indexable with a
// `.length`. Returns `null` -- never throws -- on a dimension mismatch:
// unlike registry/lib/store.mjs's EmbeddingDimensionMismatchError (which
// governs the STORE's own search comparisons, where a silent truncation
// could score a false 1.0 against an unrelated vector), a mismatch here
// only ever means "this candidate cannot be the incoming flow's cluster
// match" -- treating it as automatically-not-a-match keeps one odd
// candidate (e.g. embedded under a since-retired model) from crashing the
// whole push rather than simply being skipped.
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// --- alternates union (mirrors lib/flows/heal.mjs's applyHeal discipline)
// ---

// A locator's identity for dedup purposes: (kind, selector). Matches
// lib/flows/heal.mjs's own `alreadyPresent` check byte-for-byte.
function locatorKey(locator) {
  return JSON.stringify([locator.kind, locator.selector]);
}

// Unions `incoming` into `existing`: every existing locator is kept, in
// order, and any incoming locator not already present by (kind, selector)
// identity is appended after it, in the order it appears in `incoming`.
// Append-only -- never removes, never reorders an existing entry -- same
// discipline as lib/flows/heal.mjs's applyHeal, generalized from "append
// one decided locator" to "union a whole incoming list".
function unionLocators(existing, incoming) {
  const seen = new Set(existing.map(locatorKey));
  const merged = [...existing];
  for (const locator of incoming) {
    const key = locatorKey(locator);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(locator);
    }
  }
  return merged;
}

function mergeTargetLocators(canonicalTarget, incomingTarget) {
  if (!canonicalTarget) return canonicalTarget;
  if (!incomingTarget) return canonicalTarget;
  return { ...canonicalTarget, locators: unionLocators(canonicalTarget.locators, incomingTarget.locators) };
}

// Merges one step pair (same index, both already proven ANCHORED -- see
// `stepsAreAnchored` below -- by the caller before ever reaching here).
// Only `target.locators` (and, for `drag`, `to.locators`) are ever
// touched; every other field of the CANONICAL's own step -- waitAfter,
// mutating, value, files, key, state, as, sha256, args -- rides through
// unchanged. The merge is INTO the canonical: the incoming step
// contributes fallback locator candidates, nothing else.
function mergeStep(canonicalStep, incomingStep) {
  const merged = { ...canonicalStep };
  if (canonicalStep.target) {
    merged.target = mergeTargetLocators(canonicalStep.target, incomingStep?.target);
  }
  if (canonicalStep.op === 'drag' && canonicalStep.to) {
    merged.to = mergeTargetLocators(canonicalStep.to, incomingStep?.to);
  }
  return merged;
}

// --- per-step identity anchor: moved to registry/lib/signature-fields.mjs
// (WS4b Task 7 fix round 1, Critical #1) so the plugin's own pull-merge
// (lib/commands/registry.mjs) shares the EXACT same anchor logic as this
// module's own cluster-merge below, rather than each side maintaining its
// own copy that can silently drift out of sync. `flowsAreAnchored` is
// imported above; see that module's own doc comment for the full
// #confirm/#delete-account and drag.to rationale this check exists for. ---

// --- the pipeline ---

function rejected(name, reasons) {
  return { name, outcome: 'rejected', canonicalId: null, reasons };
}

// Finds the best cluster-merge target among a store's cluster candidates
// (already prefiltered by the store to exact origin + opSequence
// matches), or `null` when none qualifies. A candidate qualifies only
// when ALL of:
//   - its stepSignature is IDENTICAL to the incoming flow's;
//   - EVERY step pair is anchored (`flowsAreAnchored` above -- fix round
//     1, Critical #2: stepSignature equality is necessary but NOT
//     sufficient on its own, see that section's top comment);
//   - it carries a stored embedding to compare against;
//   - cosine(incomingEmbedding, candidate.embedding) >= REGISTRY_CLUSTER_THRESHOLD.
// Among qualifying candidates, the highest-cosine one wins (ties broken by
// findClusterCandidates' own createdAt-ascending order, i.e. the earliest
// candidate already returned first).
function findClusterMatch(candidates, incomingFlow, incomingEmbedding) {
  const incomingStepSignature = stepSignature(incomingFlow);
  let best = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    if (candidate.stepSignature !== incomingStepSignature) continue;
    if (!candidate.embedding) continue;
    // CRITICAL serialization rule: re-parse the candidate's stored
    // content rather than trusting its object shape as-is (Task 4 ledger
    // finding, carried forward).
    const candidateFlow = parseFlow(candidate.content);
    if (!flowsAreAnchored(candidateFlow, incomingFlow)) continue;
    const score = cosineSimilarity(incomingEmbedding, candidate.embedding);
    if (score === null) continue;
    if (score >= REGISTRY_CLUSTER_THRESHOLD && score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

// The store's own row identity (`record.id`) is a pure SURROGATE key --
// `crypto.randomUUID()`, minted fresh at creation, with NO relationship to
// `contentHash` (or anything else about the content) EVER. Pin this as a
// non-invariant: nothing anywhere may assume a canonical's id can be
// recomputed from its content, because it structurally cannot be.
//
// Fix round 1, Critical #1 (reviewer-reproduced, live): an earlier version
// of this used `contentHash` itself as `record.id`. That collided with
// `putCanonical`'s upsert-by-id semantics the moment clustering was
// SKIPPED for an envelope whose bytes matched a canonical's PRE-merge
// content -- e.g. a keyless restart, or a Voyage degrade -- re-pushing
// flow A's original bytes after A had already been cluster-merged with B
// fell through to createCanonical (exact-dedup no longer matches: the
// canonical's contentHash moved when B merged in), which recomputed THE
// SAME id (A's own original contentHash never changes) and overwrote the
// merged canonical wholesale -- destroying B's alternates, resetting
// mergedCount to 0, and reporting 'created' for a row that already
// existed. A surrogate id can never coincide with a PRIOR content state
// this way, because it carries no information about content at all.
//
// (b) of the same ruling: `store.get(id)` is checked before every insert
// as a cheap, defense-in-depth guard -- a UUID collision is not expected
// to ever happen, but if it somehow did, silently overwriting an unrelated
// canonical would be exactly this bug again. Throws loudly instead.
async function createCanonical({ flow, canonicalBytes, contentHash, store, signer, embedding }) {
  const id = randomUUID();
  const existing = await store.get(id);
  if (existing) {
    throw new Error(`ingest: refusing to overwrite existing canonical ${id} -- a fresh crypto.randomUUID() should never already exist`);
  }

  const signature = signer.sign(canonicalBytes);
  const now = new Date().toISOString();
  const record = {
    id,
    name: flow.name,
    origin: flow.origin,
    description: flow.description,
    stepSignature: stepSignature(flow),
    opSequence: opSequence(flow),
    content: flow,
    contentHash,
    signature,
    embedding: embedding ? Array.from(embedding) : null,
    mergedCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  const stored = await store.putCanonical(record);
  return { name: flow.name, outcome: 'created', canonicalId: stored.id, reasons: [] };
}

// Collapses `incomingFlow` into `canonicalRecord`: unions locator
// alternates into the canonical per step (append-only), recomputes the
// canonical's own content id (mirrors lib/flows/heal.mjs's applyHeal
// precedent -- "a heal recomputes id from the appended locator"), re-signs
// the refreshed canonical bytes, REUSES the canonical's already-stored
// embedding unchanged (see MAT-160 Task 4 note below -- never calls the
// embedder here), and re-puts the SAME store id with mergedCount
// incremented. `name`/`origin`/`description`/`stepSignature`/`opSequence`
// never change across a merge -- only step-level locator lists and the
// derived id/contentHash/signature/mergedCount/updatedAt do.
//
// MAT-160 Task 4 (determinism sweep, merge re-embed elimination): an
// earlier version of this function called `embedder(embedTextFor(
// mergedFlow))` again on every merge, "refreshed anyway ... rather than
// assumed identical". That refresh is provably unnecessary, not merely
// probably unnecessary: `embedTextFor` is `description + ' | ' +
// stepSignature` (this module's own contract, above), a merge here only
// ever unions `target.locators` (`mergeStep` above never touches anything
// else), `stepSignature` is BY CONSTRUCTION blind to `target.locators`
// (registry/lib/signature-fields.mjs's own doc comment -- appending a
// locator alternate must never change a flow's cluster identity), and
// `description` is never touched by a merge at all (only `steps` is
// rewritten, above). So `embedTextFor(mergedFlow) ===
// embedTextFor(canonicalFlow)` always holds on this path, meaning the
// canonical's OWN stored embedding -- computed from that exact text when
// it was created or last merged -- is still exactly the value a fresh
// embed call would produce. Calling the embedder again here was therefore
// pure waste on every merge (an extra network round trip per push that
// clusters), and worse than merely wasteful against a NONDETERMINISTIC
// embedder: re-deriving "the same" text could silently drift the
// canonical's embedding away from what it was created under, for a
// content change (a locator alternate) that never touched the text being
// embedded at all. Reusing the canonical's own embedding outright is
// therefore strictly more correct, not just faster -- `embedder` is no
// longer a parameter this function needs.
async function mergeIntoCanonical({ canonicalRecord, incomingFlow, store, signer }) {
  // CRITICAL serialization rule: re-parse the canonical's stored content
  // rather than trusting its object shape as-is -- a jsonb round trip may
  // have reordered its keys (Task 4 ledger finding).
  const canonicalFlow = parseFlow(canonicalRecord.content);

  const mergedSteps = canonicalFlow.steps.map((step, index) => mergeStep(step, incomingFlow.steps[index]));
  const mergedDraft = { ...canonicalFlow, steps: mergedSteps };
  const mergedFlow = { ...mergedDraft, id: flowId(mergedDraft) };

  const canonicalBytes = serializeFlow(mergedFlow);
  const contentHash = sha256Hex(canonicalBytes);

  // Fix round 1, Important #3: a re-push whose alternates union adds
  // NOTHING new (every incoming locator was already present in the
  // canonical) must be a true no-op -- the merged bytes hash to the exact
  // same contentHash the canonical already has. Returning here, before
  // any signing/embedding/write work, means such a re-push never
  // increments mergedCount and never bumps updatedAt: without this,
  // Task 6's since-sync would re-emit an otherwise-unchanged canonical on
  // every such re-push, forever.
  if (contentHash === canonicalRecord.contentHash) {
    return { name: canonicalRecord.name, outcome: 'clustered', canonicalId: canonicalRecord.id, reasons: [] };
  }

  const signature = signer.sign(canonicalBytes);

  // MAT-160 Task 4: reuse the canonical's own already-stored embedding
  // outright -- see this function's top comment for why that is provably
  // still valid (embedTextFor is unchanged by a locator-only merge) and
  // why the embedder is never called on this path at all.
  const embedding = canonicalRecord.embedding ?? null;

  const now = new Date().toISOString();
  const updatedRecord = {
    ...canonicalRecord,
    content: mergedFlow,
    contentHash,
    signature,
    embedding,
    mergedCount: canonicalRecord.mergedCount + 1,
    updatedAt: now,
  };
  const stored = await store.putCanonical(updatedRecord);
  return { name: canonicalRecord.name, outcome: 'clustered', canonicalId: stored.id, reasons: [] };
}

// ingest({envelope, store, signer, embedder}) -> {name, outcome, canonicalId, reasons}
// (Shared shapes / push response vocabulary). See this module's top
// comment for the exact pipeline order and the signer/embedder seams.
export async function ingest({ envelope, store, signer, embedder }) {
  const artifactInput = envelope?.artifact;
  const bestEffortName = artifactInput && typeof artifactInput === 'object' && typeof artifactInput.name === 'string'
    ? artifactInput.name
    : null;

  // 1. parseFlow validate.
  let flow;
  try {
    flow = parseFlow(artifactInput);
  } catch (error) {
    return rejected(bestEffortName, [{ rule: 'invalid-artifact', message: error.message }]);
  }

  // 2. contentHash verify -- sha256 over serializeFlow bytes, always
  // recomputed from the freshly-parsed flow, never trusting the client's
  // own serialization.
  const canonicalBytes = serializeFlow(flow);
  const computedHash = sha256Hex(canonicalBytes);
  if (computedHash !== envelope.contentHash) {
    return rejected(flow.name, [{ rule: 'content-hash-mismatch' }]);
  }

  // 3. PII lint -- reject loudly, never sanitize.
  const lint = lintArtifact(flow);
  if (!lint.ok) {
    return rejected(flow.name, lint.reasons);
  }

  // 4. exact dedup.
  const existingByHash = await store.findByContentHash(computedHash);
  if (existingByHash) {
    return { name: flow.name, outcome: 'deduped', canonicalId: existingByHash.id, reasons: [] };
  }

  // 5. cluster candidates (only when an embedder is active) -> clustered
  // OR created.
  let incomingEmbedding = null;

  if (embedder) {
    // A degraded embed (production embedder: any Voyage failure; a test
    // stub: an explicit null) means clustering is skipped for THIS
    // envelope only -- it still proceeds to 'created' with embedding null,
    // exactly like a keyless service would for this one push.
    incomingEmbedding = await embedder(embedTextFor(flow));
  }

  if (incomingEmbedding) {
    const candidates = await store.findClusterCandidates({
      origin: flow.origin,
      opSequence: opSequence(flow),
    });
    const clusterTarget = findClusterMatch(candidates, flow, incomingEmbedding);
    if (clusterTarget) {
      return mergeIntoCanonical({ canonicalRecord: clusterTarget, incomingFlow: flow, store, signer });
    }
  }

  return createCanonical({
    flow,
    canonicalBytes,
    contentHash: computedHash,
    store,
    signer,
    embedding: incomingEmbedding,
  });
}
