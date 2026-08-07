// Deterministic identity fields for a compiled flow artifact (WS4b plan,
// Task 1). Both the ingest pipeline (Task 5, server-side) and the client
// pull-merge (Task 7) key clustering and merge-conservatism off these two
// values, so they must be pure functions of a flow's structural shape --
// never of anything healing or locator-alternate discovery can touch.
//
// stepSignature reads exactly (op, target.role, target.name, urlPattern)
// per step, in order -- nothing else. In particular it never reads:
//   - target.locators (the ordered fallback-candidate list): appending a
//     locator alternate is exactly what healing does, and the CRITICAL
//     identity property this module exists to guarantee is that doing so
//     must NOT change a flow's cluster identity.
//   - any step's `value` (fill/select's templated value) or `files`
//     (upload): those carry argument data, not structure.
//   - `target.value`: not a field lib/flows/artifact.mjs's parseTarget
//     ever produces (locators/description/role/name only), named here only
//     to record that it is deliberately excluded were it ever added.
//
// "urlPattern shape" (the plan's Shared shapes wording): the current
// artifact schema has no per-step urlPattern field -- only a `goto` step
// carries a URL at all (its `url` field; every other op has none). So the
// fourth tuple element is that `goto` URL used verbatim when the op is
// goto, and '' otherwise. No path-segment collapsing (e.g. turning
// `/orders/123` into `/orders/:id`) is performed -- deliberately simple,
// per the plan's Task 1 brief.

function signatureTuple(step) {
  const role = step.target?.role ?? '';
  const name = step.target?.name ?? '';
  const urlPattern = step.op === 'goto' ? step.url : '';
  return [step.op, role, name, urlPattern];
}

// Deterministic, order-preserving. JSON.stringify of the tuple array is
// used instead of hand-joining with a delimiter so that no field value
// (role/name text can contain arbitrary characters) can ever collide with
// a separator and produce a false signature match.
export function stepSignature(flow) {
  return JSON.stringify(flow.steps.map(signatureTuple));
}

// Just the ops, joined -- the cheap cluster-candidate pre-filter run before
// the (more expensive) full stepSignature or cosine comparison. Op names
// come from artifact.mjs's closed STEP_OPS set, none of which contain a
// comma, so a plain join is unambiguous.
export function opSequence(flow) {
  return flow.steps.map((step) => step.op).join(',');
}

// --- per-step identity anchor ---
//
// stepSignature equality alone does NOT establish that two steps target the
// SAME element. Two concrete ways it was proven to fail (WS4b Task 5 fix
// round 1, Critical #2; re-proven against the client's own pull-merge path
// in WS4b Task 7's review, fix round 1):
//   - a target with neither `role` nor `name` set (a raw CSS/text selector
//     with no accessible-name info) collapses stepSignature's own (op,
//     role, name, urlPattern) tuple to (op, '', '', urlPattern) regardless
//     of what its locators actually point at -- `click #confirm` and
//     `click #delete-account` produce the IDENTICAL signature tuple.
//   - `drag`'s `to` (the drop destination) is not part of stepSignature AT
//     ALL -- two drags with wildly different destinations, same source,
//     still share stepSignature.
// Both are reachable with a real merge: the stepSignature gate forces the
// compared steps to already look identical on paper, leaving nothing else
// to distinguish WHICH element a step's locators actually resolve to.
//
// The fix: an explicit anchor check, run for every step pair BEFORE any
// merge is allowed, independent of and in addition to stepSignature
// equality. Conservative on purpose -- under-merging (two flows that stay
// separate when a human would call them the same) is recoverable later;
// over-merging (two different actions folded into one flow's fallback
// chain) corrupts that flow's replay irreversibly.
//
// SINGLE SOURCE OF TRUTH (WS4b Task 7 fix round 1, Critical #1): this used
// to be defined twice -- once in registry/lib/ingest.mjs for the server's
// own cluster-merge, and once hand-mirrored in the plugin's
// lib/commands/registry.mjs for the client's pull-merge -- and the
// hand-mirrored copy was missing the anchor check entirely, reopening
// exactly the #confirm/#delete-account and drag.to bugs Task 5 had already
// fixed server-side. Both `ingest.mjs` (registry/lib, deployed to Railway)
// and `lib/commands/registry.mjs` (the plugin, npm-packaged) import these
// three functions from here instead -- this module has zero imports of its
// own (see the module-level doc comment), so it is safe for either side to
// depend on without pulling in the other's runtime.

// A locator's identity for an anchor comparison. Kept local here since
// anchoring only ever needs the FIRST locator, not a whole-list identity
// (registry/lib/ingest.mjs's own `locatorKey`, and
// lib/commands/registry.mjs's mirrored copy, serve a different purpose --
// dedup across a whole locator list -- and are not reused here).
function primaryLocatorIdentity(target) {
  const locator = target?.locators?.[0];
  if (!locator) return null;
  return JSON.stringify([locator.kind, locator.selector]);
}

// Anchors ONE target-shaped object pair (a step's own `target`, or a
// drag's `to`) -- both `a` and `b` may be absent (undefined/null):
//   - presence must agree (a step with a target must be compared against
//     a step that also has one);
//   - if either side carries a non-empty role or name, BOTH role AND name
//     must be equal (this is already implied by a matching stepSignature
//     when `a`/`b` are both a step's `target` -- stepSignature encodes
//     exactly this tuple -- but is NOT implied for `to`, which
//     stepSignature never sees at all, so it is checked here
//     unconditionally rather than assumed);
//   - otherwise (both role and name empty on both sides) -- the shape
//     stepSignature is structurally blind to -- the PRIMARY (first)
//     locator's (kind, selector) must be equal instead.
export function targetsAreAnchored(a, b) {
  const aPresent = Boolean(a);
  const bPresent = Boolean(b);
  if (aPresent !== bPresent) return false;
  if (!aPresent) return true;

  const aRole = a.role ?? '';
  const aName = a.name ?? '';
  const bRole = b.role ?? '';
  const bName = b.name ?? '';
  if (aRole !== '' || aName !== '' || bRole !== '' || bName !== '') {
    return aRole === bRole && aName === bName;
  }
  return primaryLocatorIdentity(a) === primaryLocatorIdentity(b);
}

// Anchors a whole step pair: its own `target`, and -- for `drag` -- `to`
// as well (drag's OWN anchor gap; see this section's top comment). `stepA`
// determines which op is checked for `drag` -- safe because every real
// caller only reaches this after already confirming `stepSignature`
// equality, which guarantees both flows have the same op at each index.
export function stepsAreAnchored(stepA, stepB) {
  if (!targetsAreAnchored(stepA.target, stepB?.target)) return false;
  if (stepA.op === 'drag' && !targetsAreAnchored(stepA.to, stepB?.to)) return false;
  return true;
}

// Every step, positionally, must be anchored -- stepSignature equality
// (checked by the caller before this runs) already guarantees both flows
// have the same step COUNT and the same op at each index, so a plain
// positional walk is safe here without a separate length check.
export function flowsAreAnchored(flowA, flowB) {
  return flowA.steps.every((step, index) => stepsAreAnchored(step, flowB.steps[index]));
}
