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

// Prefers a candidate's `testid` (kind 'testid'); falls back to
// role+ACCESSIBLE-NAME (kind 'other' -- see the DEVIATION note at the top
// of this file, NOT the plan's literally pinned 'role') when testid is
// absent; returns null when nothing usable is left -- a candidate whose
// only evidence is bare `text` with NO role at all is too weak to heal
// from in v1 (Shared shapes).
//
// --- WS3b Task 8 (Scope ruling, binding): accessible name is `name ??
// text` when a role is present ---
//
// Task 5 made `collectCandidates` derive implicit roles (button/a-with-
// href/select/input types), so a plain `<button>Place order</button>` now
// collects `{ role: 'button', text: 'Place order' }` with no `name`. For a
// candidate that CARRIES a role, visible text IS the ARIA accessible name
// for name-from-content roles, so `name` is preferred but `text` (trimmed)
// is accepted as the same evidence when `name` is absent -- same 'other'
// kind, same `internal:role=<role>[name="..."i]` selector syntax and quote
// escaping either way. `text` is trimmed before both the emptiness check
// and the selector itself: a whitespace-only text is treated as no
// evidence, not as an accessible name of literal whitespace. A role with
// neither a usable name nor usable text is unsynthesizable -- this is also
// what naturally excludes Task 5's `textbox` tag for a hidden/file/image
// input (Task 5 review, binding constraint): that candidate never carries
// a name or text, so it falls through to null here rather than being
// blindly minted into a guaranteed-dead alternate. Bare text with NO role
// at all is unchanged from before Task 8: still unconditionally too weak.
function synthesizeLocator(candidate) {
  const testid = str(candidate.testid);
  if (testid.length > 0) {
    return { kind: 'testid', selector: `internal:testid=[data-testid="${escapeQuotes(testid)}"]` };
  }
  const role = str(candidate.role);
  if (role.length === 0) return null;
  const name = str(candidate.name);
  if (name.length > 0) {
    return { kind: 'other', selector: `internal:role=${role}[name="${escapeQuotes(name)}"i]` };
  }
  const text = str(candidate.text).trim();
  if (text.length > 0) {
    return { kind: 'other', selector: `internal:role=${role}[name="${escapeQuotes(text)}"i]` };
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

// WS3b Task 7: runs `ranker` and returns EITHER `{ ranked, usedFallback }`
// directly OR a Promise of that same shape -- `proposeHeal` below branches
// on which it got. Wraps every ranker failure -- a synchronous throw, or an
// async rejection -- in the SAME degrade-to-lexical fallback: this is where
// "ANY encoder failure silently degrades that call to lexical" (the WS3b
// plan's binding degrade rule) actually lands for the heal path
// specifically, so a caller that injects a broken or offline encoder-backed
// ranker still gets a normal lexical heal proposal rather than a thrown
// error or a stuck sweep. `args` is reused unchanged for the lexical
// fallback call -- it's the exact same `{ target, candidates }` shape
// either ranker reads.
//
// --- fix round 2 (review round 2, Important): `usedFallback` exists so the
// CALLER can tell which ranking actually ran ---
//
// Before this fix, `proposeHeal` read `ranker.minScore`/`ranker.minMargin`
// off the INJECTED ranker unconditionally, even when that ranker had just
// failed and the ranking actually used was this function's own lexical
// fallback. During a Voyage outage that meant a lexical-scale ranking (top
// ~0.6-1.0, small margins are common) got gated by the much looser
// encoder-calibrated thresholds (minMargin 0.05 instead of 0.2) instead of
// the lexical ones it was actually computed on -- an ambiguous lexical pair
// that the pure-lexical path would correctly reject could clear the
// encoder's looser margin and heal anyway. `usedFallback: true` tells
// `proposeHeal` "the ranked list you're holding came from the lexical
// fallback, not from `ranker` -- use HEAL_MIN_SCORE/HEAL_MIN_MARGIN for it,
// regardless of what thresholds `ranker` itself happens to carry."
function runRanker(ranker, args) {
  let result;
  try {
    result = ranker(args);
  } catch {
    return { ranked: rankCandidates(args), usedFallback: true };
  }
  if (result && typeof result.then === 'function') {
    return result.then(
      (ranked) => ({ ranked, usedFallback: false }),
      () => ({ ranked: rankCandidates(args), usedFallback: true }),
    );
  }
  return { ranked: result, usedFallback: false };
}

// Produces a heal decision from a failed replay's parsed payload, or null
// when the evidence doesn't clear the acceptance rule. Null cases (Shared
// shapes, exhaustive): no candidates; `failedStep` out of range or not a
// locator-bearing step; the step's stored target has neither a
// non-empty description nor a non-empty name; the top-ranked candidate
// doesn't clear the active minScore, or its margin over the runner-up
// doesn't clear the active minMargin (see the ranker-supplied-thresholds
// note below -- these default to HEAL_MIN_SCORE/HEAL_MIN_MARGIN, but a
// non-lexical ranker may carry its own); the top candidate has no
// synthesizable locator (no testid, no role, or a role with neither a
// usable name nor usable trimmed text -- see synthesizeLocator's own doc
// comment, including the Task 8 `name ?? text` widening); or the
// synthesized locator is already among the step's alternates (idempotence
// -- a sweep may see the same failure twice).
//
// --- fix round 1 (controller ruling, direction b): ranker-supplied
// acceptance thresholds ---
//
// HEAL_MIN_SCORE/HEAL_MIN_MARGIN are calibrated for the lexical scale
// (sparse Jaccard overlap x TOKEN_OVERLAP_WEIGHT, plus a flat role bonus).
// A cosine-based ranker's scores cluster much higher with much smaller
// adjacent-candidate margins -- applying the lexical thresholds to it would
// reject nearly every encoder-ranked heal, making the WS3b deliverable
// near-inert in production. Per the plan's own deferred decision ("start
// conservative, tune from drift-harness data" -- WS4 owns the actual
// tuning), thresholds are RANKER-SUPPLIED: a ranker function MAY carry
// `minScore`/`minMargin` properties (plain properties on the function
// itself -- keeps the `({ target, candidates }) -> [{index, score}]`
// call signature completely unchanged, so this is purely additive). When
// present and numeric, `finalize` below uses them instead of the module
// constants; the lexical default (`rankCandidates`, which carries neither
// property) is byte-for-byte unaffected -- every pre-fix-round-1 caller and
// test keeps HEAL_MIN_SCORE/HEAL_MIN_MARGIN exactly as before.
//
// --- fix round 2 (review round 2, Important): the RIGHT thresholds track
// the ranking that actually ran, not the ranker that was asked for ---
//
// `ranker.minScore`/`ranker.minMargin` are calibrated for THAT ranker's own
// score scale. When `ranker` fails and `runRanker` above falls back to the
// lexical `rankCandidates`, the `ranked` list `finalize` receives is on the
// LEXICAL scale even though `ranker` itself (a still-live reference to,
// say, a Voyage-backed `encoderRanker` instance) may still carry
// encoder-calibrated threshold properties. Gating a lexical-scale ranking
// with encoder-scale thresholds is exactly the kind of mismatch this
// module exists to prevent (a much looser minMargin would let an ambiguous
// lexical pair heal that the pure-lexical path would correctly reject) --
// so `finalize` below chooses its thresholds from `usedFallback`
// (`runRanker`'s own doc comment), never from `ranker` alone: `usedFallback
// === true` always uses HEAL_MIN_SCORE/HEAL_MIN_MARGIN, full stop, no
// matter what `ranker.minScore`/`ranker.minMargin` say.
//
// --- WS3b Task 7: optional injected `ranker` (Shared shapes, additive) ---
//
// `ranker` defaults to this module's own lexical `rankCandidates` above --
// every pre-Task-7 caller that never passes `ranker` gets the exact same
// synchronous call, in the exact same order, returning the exact same
// plain decision object (or null) it always did; nothing about that path
// changed. A caller MAY inject a different ranker conforming to the same
// `({ target, candidates }) -> [{index, score}]` shape -- e.g. WS3b's
// encoder-backed `encoderRanker` (lib/flows/encoder.mjs), which is
// necessarily ASYNC (it embeds over the network). Rather than make this
// function unconditionally `async` -- which would silently turn every
// existing synchronous caller's return value into an unresolved Promise --
// `runRanker` above is called plainly, and the rest of this function
// branches on whether what came back is a plain array or a thenable: a
// synchronous ranker (the default, or a synchronous test stub) keeps this
// whole function synchronous end to end; an asynchronous ranker makes THIS
// CALL return a Promise instead, which every actual production caller
// (sweep.mjs's `applyReplayRecords`, already an async function) awaits
// either way -- `await` on a plain value resolves immediately, so the two
// paths are indistinguishable to an awaiting caller.
export function proposeHeal({ flow, payload, ranker = rankCandidates }) {
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

  const rankArgs = {
    target: { description: target.description, name: target.name, role: target.role },
    candidates: payload.candidates,
  };

  // Turns a completed `{ ranked, usedFallback }` result into the final
  // decision object -- unchanged locator-synthesis logic from before Task
  // 7, just factored out so it can run either inline (synchronous ranker)
  // or inside a `.then` (asynchronous ranker) below without duplicating it.
  //
  // Threshold source (fix round 2, see the doc comment above): a fallback
  // ranking ALWAYS uses HEAL_MIN_SCORE/HEAL_MIN_MARGIN -- `ranker`'s own
  // properties are never consulted in that case, no matter what they say.
  // Only a ranking that actually came from `ranker` reads its thresholds,
  // and even then only when they're genuinely usable numbers:
  // `Number.isFinite` (not `typeof x === 'number'`, fix round 2's other
  // finding) rejects `NaN` along with every other non-finite value -- a
  // `NaN` threshold would make BOTH `<` comparisons below false
  // unconditionally (any real score "clears" a NaN gate), silently
  // admitting every candidate regardless of how weak its score actually
  // is.
  const finalize = ({ ranked, usedFallback }) => {
    if (!Array.isArray(ranked) || ranked.length === 0) return null;

    const minScore = !usedFallback && Number.isFinite(ranker?.minScore) ? ranker.minScore : HEAL_MIN_SCORE;
    const minMargin = !usedFallback && Number.isFinite(ranker?.minMargin) ? ranker.minMargin : HEAL_MIN_MARGIN;

    const top = ranked[0];
    const runnerUpScore = ranked.length > 1 ? ranked[1].score : 0;
    if (top.score < minScore) return null;
    if (top.score - runnerUpScore < minMargin) return null;

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
  };

  const rankResult = runRanker(ranker, rankArgs);
  if (rankResult && typeof rankResult.then === 'function') {
    return rankResult.then(finalize);
  }
  return finalize(rankResult);
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
// message (builtins/macros/flow-runner.js's `fail()`). Locates the marker
// via `indexOf` rather than requiring it at position 0 (Task 9 e2e finding,
// fix round): the trace-capture runtime records `record.error` as
// `String(error)`, which prepends the thrown Error's own `name` ahead of
// this macro's message -- in practice `"Error: FLOW_RUNNER_FAILURE:
// {...}"`, never the bare `"FLOW_RUNNER_FAILURE: {...}"` a position-0
// `startsWith` check requires. A `startsWith` check against real replay
// failures therefore never matched, so sweep's heal-merge never fired
// against a real deployment -- only against this module's own unit tests,
// whose hand-built fixtures never included that wrapper. `FAILURE_PREFIX`
// is macro-generated (flow-runner.js's own fixed `fail()` template) and
// cannot occur incidentally inside anything a runtime or transport would
// prepend, so finding it anywhere in the string is exactly as safe as
// requiring position 0 -- just no longer defeated by the wrapper. Fully
// try/caught; tolerates upstream truncation of the tail (see
// `recoverTruncatedCandidates`, which still only ever sees the text AFTER
// the located marker). Returns null when the marker is absent entirely, or
// when nothing could be recovered at all.
export function parseFailurePayload(errorString) {
  try {
    if (typeof errorString !== 'string') return null;
    const markerIndex = errorString.indexOf(FAILURE_PREFIX);
    if (markerIndex === -1) return null;
    const text = errorString.slice(markerIndex + FAILURE_PREFIX.length);
    return parseObjectOnly(text) || recoverTruncatedCandidates(text);
  } catch {
    return null;
  }
}
