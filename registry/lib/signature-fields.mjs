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
