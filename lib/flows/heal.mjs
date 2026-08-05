// Host-side healing (WS3a flywheel plan, Task 5). Pure functions that turn
// a failed flow replay's FLOW_RUNNER_FAILURE payload (thrown by
// builtins/macros/flow-runner.js's `fail()`) into an additive locator
// repair a caller (Task 6's sweep) can apply to a flow artifact. LEAF
// module: no imports from any other lib/ module, no I/O, no clock -- Task 6
// owns wiring this into sweep, provenance stamping, and flowId
// recomputation.
//
// `rankCandidates({ target, candidates })` is deliberately kept generic:
// this is the WS3b plug point where a future encoder-based ranker can
// implement the exact same signature as a drop-in replacement for the
// lexical scorer below.
//
// --- CARRY-FORWARD from Task 3's review (binding) ---
// The flow-runner payload's `locatorFallbacks` can carry TWO entries for
// the same (step, part): a normal rung-1/2 entry and a separate rung-3
// `escalated: true` entry from the post-quirk whole-step re-resolution.
// Neither the entry count nor `escalated` is trustworthy signal on its own
// without deduping by (step, part) first. This module's posture: ignore
// `locatorFallbacks` entirely -- ranking and acceptance below never read
// it. The `candidates` list already carries everything a lexical rank
// needs, and is simpler and sufficient for v1.
//
// --- DEVIATION from the plan's pinned `kind: 'role'` (controller ruling,
// Task 5 review round 1, binding) ---
// A role+name fallback locator is synthesized with `kind: 'other'`, not the
// plan's literally pinned `kind: 'role'`: the runner's dedupe/resolution
// (flow-runner.js's `candidateKey`/`candidateLocator`) interprets a
// `kind: 'role'` alternate from the step's OWN `target.role`/`target.name`,
// never from that alternate's own `selector` string -- so an appended
// `kind: 'role'` heal would dedupe away against (or resolve identically to)
// the step's existing captured locator whenever the target already has both
// fields, which is the common case, making the heal a silent no-op.
// `kind: 'other'` always takes the runner's verbatim `page.locator(selector)`
// branch, so the synthesized selector is actually the one probed.

const FAILURE_PREFIX = 'FLOW_RUNNER_FAILURE: ';

// --- rankCandidates weights (Shared shapes, pinned exactly) ---
// Bounded by construction, no clamping needed anywhere below: token overlap
// is a Jaccard similarity (always in [0, 1]) scaled by TOKEN_OVERLAP_WEIGHT,
// and ROLE_MATCH_BONUS is added on top only when the target's and
// candidate's roles agree case-folded. The two sum to exactly 1.0 -- the
// maximum any candidate can ever score is a perfect token match on a
// role-matching element.
export const TOKEN_OVERLAP_WEIGHT = 0.85;
export const ROLE_MATCH_BONUS = 0.15;

// --- acceptance rule (Shared shapes, pinned exactly) ---
export const HEAL_MIN_SCORE = 0.6;
export const HEAL_MIN_MARGIN = 0.2;

// --- small string/shape helpers ---

function str(value) {
  return typeof value === 'string' ? value : '';
}

const TOKEN_PATTERN = /[a-z0-9]+/g;

function tokenize(text) {
  const source = str(text);
  if (source.length === 0) return new Set();
  return new Set(source.toLowerCase().match(TOKEN_PATTERN) || []);
}

function jaccard(setA, setB) {
  let intersectionSize = 0;
  for (const token of setA) {
    if (setB.has(token)) intersectionSize += 1;
  }
  const unionSize = setA.size + setB.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

// Ranks `candidates` (the flow-runner's `{ role, name, testid, text }`
// page-evidence shape) against `target` (a flow step's stored `{
// description?, name?, role? }`) by case-folded token overlap of candidate
// name+text vs target description+name, plus a flat bonus when the two
// roles agree case-folded. Returns `[{ index, score }]` sorted descending
// by score; `index` matches the candidate's position in the input array so
// a caller can look the winner back up. Deterministic:
// `Array.prototype.sort` is stable (guaranteed since Node 11 / V8 7), so
// two candidates tied on score keep their original `candidates` array
// order in the output -- no separate tie-break key is needed.
export function rankCandidates({ target, candidates } = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];

  const safeTarget = target && typeof target === 'object' ? target : {};
  const targetTokens = new Set([...tokenize(safeTarget.description), ...tokenize(safeTarget.name)]);
  const targetRole = str(safeTarget.role).toLowerCase();

  return candidates
    .map((candidateValue, index) => {
      const safeCandidate = candidateValue && typeof candidateValue === 'object' ? candidateValue : {};
      const candidateTokens = new Set([...tokenize(safeCandidate.name), ...tokenize(safeCandidate.text)]);
      const overlap = TOKEN_OVERLAP_WEIGHT * jaccard(targetTokens, candidateTokens);
      const roleMatches = targetRole.length > 0 && str(safeCandidate.role).toLowerCase() === targetRole;
      return { index, score: overlap + (roleMatches ? ROLE_MATCH_BONUS : 0) };
    })
    .sort((a, b) => b.score - a.score);
}

// --- locator synthesis from a winning candidate ---

function escapeQuotes(value) {
  return value.replace(/"/g, '\\"');
}

// Prefers a candidate's `testid` (kind 'testid'); falls back to role+name
// (kind 'other' -- see the DEVIATION note at the top of this file, NOT the
// plan's literally pinned 'role') when testid is absent; returns null when
// neither is usable -- a candidate whose only evidence is bare `text` is
// too weak to heal from in v1 (Shared shapes).
function synthesizeLocator(candidate) {
  const testid = str(candidate.testid);
  if (testid.length > 0) {
    return { kind: 'testid', selector: `internal:testid=[data-testid="${escapeQuotes(testid)}"]` };
  }
  const role = str(candidate.role);
  const name = str(candidate.name);
  if (role.length > 0 && name.length > 0) {
    return { kind: 'other', selector: `internal:role=${role}[name="${escapeQuotes(name)}"i]` };
  }
  return null;
}

// Steps whose stored target this module can heal: exactly one `target`
// object carrying a `locators` array. `drag` is deliberately excluded even
// though it has two targets (`target`/`to`) -- the flow-runner failure
// payload's `failedStep` names only the STEP, not which of the two targets
// missed, and per the CARRY-FORWARD posture above this module does not
// read `locatorFallbacks` (the one place a `part` tag would say which).
function isLocatorBearingStep(step) {
  if (!step || typeof step !== 'object' || step.op === 'drag') return false;
  return !!(step.target && typeof step.target === 'object' && Array.isArray(step.target.locators));
}

// Produces a heal decision from a failed replay's parsed payload, or null
// when the evidence doesn't clear the acceptance rule. Null cases (Shared
// shapes, exhaustive): no candidates; `failedStep` out of range or not a
// locator-bearing step; the step's stored target has neither a
// non-empty description nor a non-empty name; the top-ranked candidate
// doesn't clear HEAL_MIN_SCORE, or its margin over the runner-up doesn't
// clear HEAL_MIN_MARGIN; the top candidate has no synthesizable locator
// (bare text only); or the synthesized locator is already among the
// step's alternates (idempotence -- a sweep may see the same failure
// twice).
export function proposeHeal({ flow, payload }) {
  if (!flow || !Array.isArray(flow.steps)) return null;
  if (!payload || !Array.isArray(payload.candidates) || payload.candidates.length === 0) return null;

  const stepIndex = payload.failedStep;
  if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= flow.steps.length) return null;

  const step = flow.steps[stepIndex];
  if (!isLocatorBearingStep(step)) return null;

  const target = step.target;
  const hasDescription = typeof target.description === 'string' && target.description.length > 0;
  const hasName = typeof target.name === 'string' && target.name.length > 0;
  // Explicit guard, not merely implied by the score threshold below: v1's
  // lexical scorer can never clear HEAL_MIN_SCORE from an empty target
  // (its token set is empty), but this is a spec-required, independent
  // condition kept explicit for forward compatibility with a future
  // non-lexical ranker (see the WS3b plug-point note above) that might
  // otherwise score a description-less/name-less target highly on some
  // other signal.
  if (!hasDescription && !hasName) return null;

  const ranked = rankCandidates({
    target: { description: target.description, name: target.name, role: target.role },
    candidates: payload.candidates,
  });
  if (ranked.length === 0) return null;

  const top = ranked[0];
  const runnerUpScore = ranked.length > 1 ? ranked[1].score : 0;
  if (top.score < HEAL_MIN_SCORE) return null;
  if (top.score - runnerUpScore < HEAL_MIN_MARGIN) return null;

  const winningCandidateValue = payload.candidates[top.index];
  const winningCandidate = winningCandidateValue && typeof winningCandidateValue === 'object'
    ? winningCandidateValue
    : {};
  const locator = synthesizeLocator(winningCandidate);
  if (!locator) return null;

  const alreadyPresent = target.locators.some(
    (existing) => existing && existing.kind === locator.kind && existing.selector === locator.selector,
  );
  if (alreadyPresent) return null;

  return {
    flowName: flow.name,
    flowId: flow.id,
    stepIndex,
    locator,
    score: top.score,
    runnerUp: runnerUpScore,
  };
}

// Returns a NEW flow object with `decision.locator` appended at the LAST
// position of the failed step's locator alternates; `flow` is not mutated.
// Does not set `provenance.lastHealed` (the sweep stamps that with its own
// clock) and does not recompute `flow.id` (the caller does, once, after
// deciding whether to keep this heal). Trusts `decision` was produced by
// `proposeHeal` against this same `flow` -- `stepIndex` is already proven
// in range and locator-bearing there, and is not re-validated here.
export function applyHeal(flow, decision) {
  const steps = flow.steps.map((step, index) => {
    if (index !== decision.stepIndex) return step;
    return {
      ...step,
      target: {
        ...step.target,
        locators: [...step.target.locators, decision.locator],
      },
    };
  });
  return { ...flow, steps };
}

// --- Step 1: FLOW_RUNNER_FAILURE payload parsing ---

function parseObjectOnly(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Recovers a payload whose JSON text was cut off mid-`candidates` tail by
// some upstream transport. `candidates` is deliberately the LAST key the
// flow-runner macro ever writes (see its own `fail()`/enrichment comment)
// exactly so a byte-level truncation degrades this recovery to fewer
// candidates, or none, rather than losing the whole payload. Not a general
// JSON repairer: it only understands this one shape (a flat array of flat
// `{ role, name, testid, text }` objects as the payload's final key) and
// only ever trims from that array's tail. Returns null when the marker
// itself was never reached (truncation happened somewhere earlier, which
// this targeted recovery has no way to repair).
function recoverTruncatedCandidates(text) {
  const marker = '"candidates":[';
  const markerIndex = text.indexOf(marker);
  if (markerIndex === -1) return null;

  const arrayStart = markerIndex + marker.length; // just past the array's '['
  let depth = 0;
  let inString = false;
  let escaped = false;
  let lastCompleteEnd = -1; // index just past the last fully-closed candidate object's '}'
  for (let i = arrayStart; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') { depth += 1; continue; }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) lastCompleteEnd = i + 1;
    }
  }

  const dropCandidatesKey = () => {
    const prefix = text.slice(0, markerIndex).replace(/,\s*$/, '');
    return parseObjectOnly(`${prefix}}`);
  };

  if (lastCompleteEnd === -1) return dropCandidatesKey(); // not even one complete candidate survived

  const recoveredArrayText = text.slice(arrayStart, lastCompleteEnd);
  const rebuilt = `${text.slice(0, arrayStart)}${recoveredArrayText}]}`;
  return parseObjectOnly(rebuilt) || dropCandidatesKey();
}

// Parses the `FLOW_RUNNER_FAILURE: <json>` payload out of a replay error's
// message (builtins/macros/flow-runner.js's `fail()`). Requires the exact
// prefix; fully try/caught; tolerates upstream truncation of the tail (see
// `recoverTruncatedCandidates`). Returns null when nothing could be
// recovered at all.
export function parseFailurePayload(errorString) {
  try {
    if (typeof errorString !== 'string' || !errorString.startsWith(FAILURE_PREFIX)) return null;
    const text = errorString.slice(FAILURE_PREFIX.length);
    return parseObjectOnly(text) || recoverTruncatedCandidates(text);
  } catch {
    return null;
  }
}
