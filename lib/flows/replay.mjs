// The replay wire payload (MAT-338). LEAF module: no imports, no I/O.
//
// A one-call replay is supposed to be the cheapest thing an agent can do --
// the MAT-330 spike measured a mined `next` flow replaying in 1 call where
// the discrete run took 10, and that is the whole point of the flywheel.
// What it also measured is that the agent still has to READ ~20k characters
// to collect that result, because `browser_run_code_unsafe` echoes back the
// code it ran plus a JSON dump of the arguments it was handed.
//
// The code half is settled at launch: `runtimeArgs` (lib/runtime/launch.mjs)
// now passes `--codegen=none`, which drops the runtime's "Ran Playwright
// code" section from every tool result. The arguments are this module's
// half: `flows find` used to hand the runner the ENTIRE stored artifact,
// provenance and prose included, and that payload is echoed whether or not
// the code section is.
//
// So the payload is projected down to exactly what flow-runner.js reads
// (`schemaVersion`, `name`, `origin`, `args`, `steps`) plus `id`, which the
// runner ignores but the replay-provenance lookup in lib/flows/sweep.mjs
// (`resolveReplayTarget`) matches a replay record back to its artifact by.
// Everything else -- `description`, `urlPattern`, `sideEffects`, `result`,
// `provenance` -- is prose or bookkeeping that only ever travelled to be
// echoed back.
//
// Per step, `target.description` goes the same way: the runner resolves
// candidates from `role`/`name` and never reads it, and the host-side heal
// ranker that DOES read it reads the artifact off disk, not the wire.
//
// This shape is deliberately NOT a valid `parseFlow` artifact and must
// never be fed back to one -- it is the runner's input, nothing else.
// MAT-336's fallback ladders made this matter more, not less: every target
// now carries several candidates, so a flow's `steps` are the one part of
// the payload that legitimately grew.

function projectTarget(target) {
  if (!target) return target;
  const { description, ...rest } = target;
  return rest;
}

function projectStep(step) {
  const projected = { ...step };
  if (step.target) projected.target = projectTarget(step.target);
  if (step.to) projected.to = projectTarget(step.to);
  return projected;
}

export function replayPayload(flow) {
  return {
    schemaVersion: flow.schemaVersion,
    id: flow.id,
    name: flow.name,
    origin: flow.origin,
    args: flow.args,
    steps: flow.steps.map(projectStep),
  };
}
