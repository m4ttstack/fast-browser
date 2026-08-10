import { flowsAreAnchored, opSequence, stepSignature } from '../../registry/lib/signature-fields.mjs';
import { flowId } from './artifact.mjs';

// Local clustering for newly compiled flows (MAT-337).
//
// --- why this exists ---
//
// The MAT-330 spike compiled 18 benchmark sessions into 15 flows, six of
// which were the SAME login journey captured in six sessions, plus four
// `toggle-todo` twins. Exact-content dedup could not see them: the first
// name collision renames the candidate (`login-2`) and -- correctly --
// rehashes it, because `flowId` covers `name`. The NEXT identical candidate
// still hashes under the base name, matches nothing in the registry, and
// gets renamed in turn. Six sessions, six flows, all competing in recall
// for one journey (and, measured live, being reordered against each other
// by the Voyage reranker, which is exactly zero signal).
//
// Clustering already existed, but only server-side at registry push time
// (registry/lib/ingest.mjs), which is unreachable for the machine-local
// case that produces the duplicates in the first place.
//
// --- what counts as the same journey ---
//
// Deliberately conservative, and deliberately the SAME gate the server
// uses: identical `stepSignature` AND every step pair anchored. Signature
// equality alone is not sufficient and never has been -- a target with no
// role and no name collapses `#confirm` and `#delete-account` onto the
// identical tuple -- which is why `flowsAreAnchored` is imported from
// registry/lib/signature-fields.mjs rather than reimplemented: it is the
// gate that decides whether a merge is safe at all, and this codebase has
// already been bitten once by keeping two copies of it.
//
// On top of the server's gate, three flow-level fields must also agree
// before two local flows are called the same journey -- `urlPattern`,
// `result`, and `args`. The server can be laxer because it clusters
// artifacts that a human already approved and pushed; here the loser is
// DELETED before anyone ever sees it, so a flow that recall would answer a
// different question with (a different entry URL, a different extraction,
// a different parameterization) must survive. `origin` and `sideEffects`
// are in the key for the same reason.
//
// Step `value`s are NOT part of the identity, matching the server: they
// carry argument data, not structure, and the compiler already lifts
// anything high-entropy into `args`. The canonical's values win, which is
// the same "the merge is INTO the canonical; the incoming flow contributes
// fallback locator candidates, nothing else" rule ingest.mjs states.

// Mirrors registry/lib/ingest.mjs's `locatorKey`/`unionLocators`/
// `mergeTargetLocators`/`mergeStep`, the same way lib/commands/registry.mjs
// mirrors them for its own pull-merge, and for the same reason that module
// gives: the union MECHANISM is pure data plumbing and safe to duplicate,
// while the anchor check that gates it is not and is shared instead.
function locatorKey(locator) {
  return JSON.stringify([locator.kind, locator.selector]);
}

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

function sortedArgs(args) {
  const sorted = {};
  for (const key of Object.keys(args).sort()) sorted[key] = args[key];
  return sorted;
}

// The cheap prefilter: every flow sharing this string is a CANDIDATE for
// the same journey, never a confirmed match -- `flowsAreCoJourney` below
// still has to anchor the step pairs. Excludes `name`, `description`, `id`
// and `provenance`, which is the whole point: those are precisely the
// fields that differ across captures of one journey.
export function journeyKey(flow) {
  return JSON.stringify([
    flow.origin,
    flow.urlPattern,
    flow.sideEffects,
    flow.result,
    sortedArgs(flow.args),
    opSequence(flow),
    stepSignature(flow),
  ]);
}

export function flowsAreCoJourney(canonicalFlow, incomingFlow) {
  return journeyKey(canonicalFlow) === journeyKey(incomingFlow)
    && flowsAreAnchored(canonicalFlow, incomingFlow);
}

// Unions `incomingFlow`'s locator candidates into `canonicalFlow`,
// append-only, and returns the merged flow with its `id` recomputed -- or
// `null` when the incoming flow contributed nothing new, so a caller can
// skip a rewrite that would only churn the file's mtime. `provenance` rides
// through untouched: it describes where the CANONICAL came from, and the
// collapsed twin's own provenance is discarded along with the twin.
//
// The caller is responsible for having established `flowsAreCoJourney`
// first; this function assumes it and walks the step lists positionally.
export function mergeCoJourney(canonicalFlow, incomingFlow) {
  const mergedSteps = canonicalFlow.steps.map((step, index) => mergeStep(step, incomingFlow.steps[index]));
  const draft = { ...canonicalFlow, steps: mergedSteps };
  const merged = { ...draft, id: flowId(draft) };
  return merged.id === canonicalFlow.id ? null : merged;
}
