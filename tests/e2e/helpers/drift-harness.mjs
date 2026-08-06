import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { flows as flowsCommand } from '../../../lib/commands/flows.mjs';
import { flowFileName } from '../../../lib/flows/artifact.mjs';
import { proposeHeal } from '../../../lib/flows/heal.mjs';
import { tracedSession } from './flow-fixtures.mjs';

// WS4a Task 3: the drift-harness driver + rung classifier. Consumes the
// mutation-profile registry Tasks 1-2 built (tests/fixtures/order-flow/
// profiles.mjs) and the shared e2e flow-fixture trio (WS3b Task 10,
// ./flow-fixtures.mjs) to record a flow ONCE and replay it against every
// named profile, turning each replay's observable evidence into a rung on
// the healing ladder. Task 4 adds the full per-profile assertion matrix on
// top of this file's `runHarness`; this file only has to prove the
// mechanism (base profile only, see tests/e2e/drift-harness.test.mjs).

// --- classifyReplay: pure, no browser, no fs, no network ---
//
// Rung vocabulary and precedence (highest wins), per the plan's Shared
// shapes: 'heal' (sweepHealed non-empty) > 'quirk' (dismissCount > 0,
// success) > 'escalated' (any fallback entry with escalated:true) >
// 'fallback' (any fallback entry) > 'clean' (success, empty fallbacks);
// 'fail' when error is present and no heal resulted.
//
// Why 'heal' is checked FIRST, ahead of even 'fail': a heal is discovered
// by a SWEEP that runs strictly after the replay that produced `result`/
// `error` -- the replay itself may have failed outright (locator miss,
// `error` set, `result` null), and it is the sweep's own heal.mjs pass
// over that failure's evidence that produces the `sweepHealed` entry. So
// "the replay failed AND a heal resulted from it" is not a contradiction,
// it is the exact healing-ladder success story (see
// tests/e2e/healing.test.mjs's own drift/heal/replay-again scenario) --
// and the caller-visible outcome for THAT replay attempt is still 'heal',
// never 'fail', because the flow is healthy again by the time this
// classification is asked for. This is the "fail vs heal disambiguation"
// the brief calls out explicitly.
//
// Why 'quirk' only applies to a SUCCESS: dismissCount > 0 with `error`
// present means a quirk was attempted (flow-runner.js's own
// `quirkAttempted` field, which only ever appears inside a FAILURE
// payload) but the step still ultimately failed -- that is a 'fail', not
// a recovered 'quirk'. classifyReplay never inspects `error`'s contents to
// know this; it does not need to, because 'fail' is checked before
// 'quirk' whenever `error` is present at all.
export function classifyReplay({
  result, error, sweepHealed, dismissCount,
}) {
  const healed = sweepHealed ?? [];
  const fallbacks = result?.locatorFallbacks ?? [];
  // flow-runner.js's own contract (resolveTarget/resolveEscalated): a
  // rung-1 fallback entry (first probe pass, index > 0) never carries an
  // `escalated` key at all; a rung-2 entry (the escalated single-pass
  // probe) always carries `escalated: true`. There is no `escalated:
  // false` in the real payload -- this filter tolerates one anyway
  // (`=== true`, not truthy-check) so a hand-built test shape that DOES
  // spell it out explicitly still classifies correctly.
  const escalatedFallbacks = fallbacks.filter((entry) => entry.escalated === true);

  const evidence = {
    healed,
    dismissCount,
    fallbacks,
    escalatedFallbacks,
    ok: result?.ok ?? false,
    error: error ?? null,
  };

  if (healed.length > 0) return { rung: 'heal', evidence };
  if (error) return { rung: 'fail', evidence };
  if (dismissCount > 0) return { rung: 'quirk', evidence };
  if (escalatedFallbacks.length > 0) return { rung: 'escalated', evidence };
  if (fallbacks.length > 0) return { rung: 'fallback', evidence };
  return { rung: 'clean', evidence };
}

const FLOW_RUNNER_FAILURE_PREFIX = 'FLOW_RUNNER_FAILURE: ';

// Extracts the raw `FLOW_RUNNER_FAILURE: <json>` substring from a rejected
// callTool's error message -- the same marker tests/e2e/healing.test.mjs's
// own `parseFlowRunnerFailure` finds, but returned as the STRING
// classifyReplay's `error` input expects (per the plan's Shared shapes:
// "error = the FLOW_RUNNER_FAILURE string or null"), not parsed JSON --
// classifyReplay only ever needs to know an error is present, never its
// contents. An error whose message does NOT carry the marker is not a
// flow-runner domain failure (a locator miss, a quirk that never
// recovered) -- it is unexpected breakage in the harness's own plumbing
// (a crashed macro, a transport error), and is rethrown rather than
// silently reclassified as a replay 'fail'.
function extractFlowRunnerFailure(caughtError) {
  const markerIndex = caughtError.message.indexOf(FLOW_RUNNER_FAILURE_PREFIX);
  if (markerIndex === -1) throw caughtError;
  return caughtError.message.slice(markerIndex);
}

// Builds a replay call's arguments from a `flows find` invocation, swapping
// in real arg values for the invocation's `<REQUIRED: string>` placeholders
// -- same shape tests/e2e/healing.test.mjs's own `replayArgsFor` builds.
// Exported so a flow descriptor's own `replayArgs` can reuse it instead of
// each descriptor re-deriving the same merge.
export function replayArgsFor(invocation, argValues) {
  return {
    ...invocation.arguments,
    args: { ...invocation.arguments.args, args: argValues },
  };
}

// Default dismiss-counter reader: two fixture-side counters exist today
// (tests/fixtures/order-flow/index.html's 'intercept'/'banner-intercepts'
// branch sets `window.__interceptDismissClicks__`; the 'overlay'/
// 'banner-hides' branch mirrors it with `window.__consentDismissClicks__`,
// added by WS4a Task 4 per the ledger ruling that 'banner-hides' needs its
// own countable dismiss evidence -- see index.html's own doc comment).
// Exactly one of the two variants is ever live on a given page load (they
// are mutually exclusive overlays), so summing both is equivalent to
// reading "whichever one applies" without this reader needing to know
// which profile is currently selected. Both are `undefined` (-> 0) on
// every OTHER variant/profile, including 'base', which is exactly what the
// base-profile skeleton leg needs. A flow descriptor may override this via
// its own `readDismissCount` for a fixture with a different (or
// additional) counter.
async function defaultReadDismissCount(session) {
  return session.callTool('browser_evaluate', {
    function: '() => (window.__interceptDismissClicks__ || 0) + (window.__consentDismissClicks__ || 0)',
  });
}

// --- the driver ---
//
// A flow descriptor (the `flows` array entries `runHarness` takes) is
// harness-local, not a Shared shape -- Task 3 needs exactly one (the order
// flow), and this shape is deliberately generic so Task 4+ can add more
// without touching this driver:
//   {
//     name: string,                                   // harness-facing label
//     intent: string,                                  // `flows find` intent
//     startFixture: () => Promise<{ origin, close, setProfile }>,
//     setup?: ({ origin, paths }) => Promise<void>,     // WS4a Task 4: runs
//                                                        // once, right after
//                                                        // startFixture, before
//                                                        // recording -- e.g.
//                                                        // registering site-
//                                                        // memory quirks
//                                                        // against the
//                                                        // fixture's real
//                                                        // origin so every
//                                                        // leg's own `flows
//                                                        // find` embeds them
//     record: (session, origin) => Promise<void>,       // discrete tool calls
//     replayArgs: (invocation) => object,                // -> callTool args
//     readDismissCount?: (session) => Promise<number>,   // default above
//   }

// Records the flow ONCE (against whatever profile the fixture is on when
// `startFixture` returns it -- every caller today starts on 'base', the
// only variant a recording may ever capture), compiles, and approves it
// via an injected always-true confirm -- the exact pattern
// tests/e2e/healing.test.mjs uses for every one of its own legs. Snapshots
// the approved artifact's raw bytes immediately after approval: this is
// the ONE canonical recording every profile leg below replays against, and
// the snapshot is what makes each leg's own restore step meaningful.
export async function recordAndApprove(t, flow, fixture, paths) {
  const recorder = await tracedSession(t, paths.dataDir);
  await flow.record(recorder, fixture.origin);
  await recorder.close();

  const compileReport = await flowsCommand({ sub: 'compile', json: true }, { paths });
  if (compileReport.compiled.length !== 1) {
    throw new Error(
      `drift-harness: expected exactly one newly compiled flow while recording `
      + `"${flow.name}", got ${compileReport.compiled.length}`,
    );
  }
  const { name: flowName, tier } = compileReport.compiled[0];
  if (tier !== 'pending') {
    throw new Error(
      `drift-harness: recorded flow "${flowName}" compiled straight to tier `
      + `"${tier}", expected "pending"`,
    );
  }

  const approveReport = await flowsCommand(
    { sub: 'approve', name: flowName, json: false },
    {
      paths, interactive: true, confirmApprove: async () => true, print: () => {},
    },
  );
  if (!approveReport.moved) {
    throw new Error(`drift-harness: approve did not move flow "${flowName}" into the ready tier`);
  }

  const flowFilePath = path.join(paths.flowsDir, flowFileName({ name: flowName }));
  const snapshot = await readFile(flowFilePath);

  return {
    flow: flow.name, compiledName: flowName, flowFilePath, snapshot,
  };
}

// Runs ONE (flow, profile) leg: restore the approved artifact to its
// just-recorded bytes, select the profile, re-`find` (so the invocation is
// derived fresh from the just-restored artifact, never a prior leg's
// mutated one), replay, read the dismiss-counter delta, sweep, classify.
//
// Exported (WS4a Task 4) so a caller that needs finer-grained control than
// `runHarness`'s own all-restore-every-leg loop can drive extra legs
// directly: the quarantine-threshold leg (`text-rename-far`, three
// consecutive failures needed to trip `QUARANTINE_FAIL_STREAK_THRESHOLD`)
// must NOT restore between attempts (a restore would reset `failStreak`
// back to 0 every time, exactly the isolation this function's own restore
// step deliberately provides for every OTHER, independent leg) -- passing
// `restore: false` skips exactly that one step and nothing else, so a
// caller opting out of it takes on full responsibility for what's left on
// disk when it starts.
//
// The restore happens BEFORE every leg, including the very first, and it
// undoes MORE than heals: sweep.mjs's `applyReplayRecords` rewrites the
// SAME ready-tier file for every processed replay it sees, heal or not --
// a plain (non-heal) success/failure still bumps
// `provenance.successRuns`/`failStreak` and writes that back via the exact
// same `writeAtomicCore(location.filePath, ...)` call a heal uses; only
// the CONTENT of the write differs (heals also append a locator). So
// without an unconditional per-leg restore, provenance would accumulate
// monotonically across profiles even on an all-'clean' matrix, on top of
// whatever an actual heal changes -- both are "profile N leaking into
// profile N+1", just at different severities, and this restore step
// erases both the same way. This is why the skeleton test below pins
// successRuns staying flat at 1 across two consecutive 'base' legs, not
// raw byte-equality against the snapshot after any leg's OWN sweep has
// run (that sweep's own provenance bump is real, expected drift from an
// actual replay, not a leak -- see that test's own comment).
export async function replayOneProfile({
  t, flow, fixture, paths, recorded, profileName, restore = true,
}) {
  if (restore) await writeFile(recorded.flowFilePath, recorded.snapshot);
  fixture.setProfile(profileName);

  const findReport = await flowsCommand(
    { sub: 'find', intent: flow.intent, origin: fixture.origin, url: null, json: true },
    { paths },
  );
  if (findReport.candidates.length === 0) {
    throw new Error(
      `drift-harness: "flows find" returned no candidates for "${flow.intent}" `
      + `against profile "${profileName}"`,
    );
  }
  const invocation = findReport.candidates[0].invocation;

  const session = await tracedSession(t, paths.dataDir);
  let result = null;
  let error = null;
  try {
    result = await session.callTool(invocation.tool, flow.replayArgs(invocation));
  } catch (caughtError) {
    error = extractFlowRunnerFailure(caughtError);
  }
  const readDismissCount = flow.readDismissCount ?? defaultReadDismissCount;
  const dismissCount = await readDismissCount(session);
  await session.close();

  const sweepReport = await flowsCommand({ sub: 'compile', json: true }, { paths });
  const sweepHealed = sweepReport.healed.filter((entry) => entry.name === recorded.compiledName);
  // Not an input to classifyReplay (the classifier never sees provenance,
  // by design -- see its own doc comment) -- carried on the result entry
  // purely as the isolation instrument: whatever this leg's own sweep just
  // wrote, sourced straight from the report sweep.mjs already produces
  // rather than re-reading the file back.
  const sweepUpdated = sweepReport.updated.find((entry) => entry.name === recorded.compiledName) ?? null;

  const { rung, evidence } = classifyReplay({
    result, error, sweepHealed, dismissCount,
  });

  return {
    flow: flow.name,
    profile: profileName,
    rung,
    evidence,
    provenance: sweepUpdated && {
      successRuns: sweepUpdated.successRuns, failStreak: sweepUpdated.failStreak,
    },
    // WS4a Task 7: sweep's own `warnings` (lib/flows/sweep.mjs's
    // heal-degrade visibility), passed straight through from THIS leg's own
    // sweep call -- not filtered by flow name the way `sweepHealed` above
    // is, since a `{ kind: 'encoder-degraded', reason }` entry carries no
    // flow identity to filter on in the first place (sweep.mjs's own
    // `warningTrackingRanker` observes the ranker call itself, independent
    // of which flow the failed replay it was ranking for belongs to). Every
    // existing caller of `replayOneProfile` ignores this new field (Tasks
    // 3-6 destructure `rung`/`evidence` only), so this is additive-only.
    warnings: sweepReport.warnings ?? [],
  };
}

// Prints a compact per-(flow, profile) summary via `console.table` (zero
// deps -- built into `console`), plus the leading blank line so it is
// visually distinct from node:test's own TAP output when a caller runs
// `npm run test:drift` at a terminal.
function printSummary(results) {
  console.log('\ndrift-harness summary:');
  console.table(results.map((entry) => ({
    flow: entry.flow,
    profile: entry.profile,
    rung: entry.rung,
    dismissCount: entry.evidence.dismissCount,
    fallbacks: entry.evidence.fallbacks.length,
    escalated: entry.evidence.escalatedFallbacks.length,
    healed: entry.evidence.healed.length,
    successRuns: entry.provenance?.successRuns ?? null,
  })));
}

// The driver: for each flow descriptor, record once (against whatever
// profile the fixture starts on), then replay it once per named profile in
// `profiles` (a plain array of profile-name strings -- 'base' plus any of
// tests/fixtures/order-flow/profiles.mjs's `PROFILES` keys; `runHarness`
// itself never imports `PROFILES`, callers select which names to drive).
// Returns the full per-(flow, profile) table, the path the same table was
// written to as JSON under the caller's own scratch dir
// (`paths.dataDir` -- always a `mkdtemp` under `os.tmpdir()` in every
// caller today, never committed), and one `recordings` entry per flow
// descriptor (its compiled name, the approved artifact's path, and the
// post-approval byte snapshot) so a caller can independently verify the
// restore-before-each-leg isolation guarantee held.
export async function runHarness({
  profiles, flows: flowDescriptors, paths, t,
}) {
  const results = [];
  const recordings = [];

  for (const flow of flowDescriptors) {
    const fixture = await flow.startFixture();
    try {
      if (flow.setup) await flow.setup({ origin: fixture.origin, paths });
      const recorded = await recordAndApprove(t, flow, fixture, paths);
      recordings.push(recorded);

      for (const profileName of profiles) {
        // Sequential by construction: each profile leg depends on the
        // previous one's artifact-restore/sweep having fully settled
        // first, so there is nothing here to run concurrently.
        const entry = await replayOneProfile({
          t, flow, fixture, paths, recorded, profileName,
        });
        results.push(entry);
      }
    } finally {
      await fixture.close();
    }
  }

  const resultsPath = path.join(paths.dataDir, 'drift-harness-results.json');
  await writeFile(resultsPath, JSON.stringify(results, null, 2));
  printSummary(results);

  return { results, resultsPath, recordings };
}

// --- WS4a Task 6: tuning-report lines (Shared shapes) ---
//
// One line per (profile, ranker) pair -- `{ profile, flow, ranker, top,
// runnerUp, margin, healed, correct }` -- computed from an ALREADY-RUN
// ranking (`ranked`, the caller's own `[{index, score}]`, sorted desc, from
// EITHER heal.mjs's lexical `rankCandidates` or encoder.mjs's
// `encoderRanker(encoder)`), never computed by calling `ranker` itself a
// second time here: a Voyage-backed ranker's one real network embed call
// belongs entirely to the caller (see tests/e2e/drift-harness.test.mjs's
// own call sites), so this function's own job is purely post-processing
// numbers that already exist.
//
// `healed` is this line's OWN acceptance verdict -- recomputed from
// `ranked`'s own top/runnerUp against `minScore`/`minMargin` (the same two
// numbers `proposeHeal`'s own `finalize` would use for this ranker: either
// heal.mjs's `HEAL_MIN_SCORE`/`HEAL_MIN_MARGIN`, or an encoder ranker's own
// attached `.minScore`/`.minMargin`) -- not read off a real replay's
// evidence, so a control row (a ranker whose real replay never even ran,
// e.g. the far-rename profile's lexical control) still gets an honest
// `healed` verdict for what THAT ranker alone would have decided.
//
// `correct` answers a DIFFERENT question than `healed`: "is the top-ranked
// candidate the fixture's actual intended drift target", independent of
// whether the score/margin cleared the real threshold -- the Shared
// shapes' own "[would-heal] winner" phrasing. Answered by re-running
// `proposeHeal` against the SAME `ranked` result through a synchronous stub
// ranker whose thresholds are forced wide open (well below any real score
// this codebase ever produces), so `finalize`'s real `synthesizeLocator`
// step is always reached for whatever candidate ranked first -- this reuses
// the exact production locator-synthesis logic (testid preferred, then
// role+name-or-text, with the same quote-escaping) rather than a
// hand-rolled duplicate that could quietly drift from it, and costs no
// extra network call: the stub never touches `encoder.embed`, it just
// returns the array the caller already computed.
const FORCE_OPEN_THRESHOLD = -1000;

// Extracts the SAME `{ description, name, role }` shape `proposeHeal`
// itself builds internally (lib/flows/heal.mjs's own `rankArgs.target`) for
// a failed replay's target step -- exported so a caller computing a tuning
// line's `ranked` result up front (this file's own doc comment on
// `tuningLineFor`: the ranker call happens exactly once, by the caller)
// builds its ranker args from the identical fields `proposeHeal` would use
// for the real heal attempt, never a hand-derived subset that could drift
// from it.
export function targetForFailedStep(flow, payload) {
  const step = flow.steps[payload.failedStep];
  return { description: step.target.description, name: step.target.name, role: step.target.role };
}

export function tuningLineFor({
  profile, flowName, rankerName, ranked, minScore, minMargin, flow, payload, expectedSelector,
}) {
  const top = ranked.length > 0 ? ranked[0].score : 0;
  const runnerUp = ranked.length > 1 ? ranked[1].score : 0;
  const margin = top - runnerUp;
  const healed = ranked.length > 0 && top >= minScore && margin >= minMargin;

  const openRanker = () => ranked;
  openRanker.minScore = FORCE_OPEN_THRESHOLD;
  openRanker.minMargin = FORCE_OPEN_THRESHOLD;
  const wouldHealDecision = proposeHeal({ flow, payload, ranker: openRanker });
  // Review round 1 (folded minor c): `correct: false` is produced by TWO
  // distinct situations this single boolean does not distinguish --
  // "the top-ranked candidate synthesizes to the WRONG selector" (a real
  // mis-bind, e.g. WS4a Task 6's own "Confirm order" vs "Checkout" finding)
  // and "the top-ranked candidate has no synthesizable locator at all"
  // (`wouldHealDecision` itself is null -- `synthesizeLocator`'s own null
  // cases: no testid, no role, or a role with neither a usable name nor
  // usable text). Not split into two fields here (the Shared shapes'
  // `correct` is a single boolean Task 7 already consumes) -- a caller
  // that needs to tell these apart can re-derive it from `ranked[0]` and
  // `payload.candidates` directly; this field alone conflates them by
  // design, not by oversight.
  const correct = Boolean(wouldHealDecision && wouldHealDecision.locator.selector === expectedSelector);

  return {
    profile, flow: flowName, ranker: rankerName, top, runnerUp, margin, healed, correct,
  };
}

// Groups tuning lines by (ranker, profile) and reports min/median `top` and
// `margin` per group -- Task 7's own consumption target ("the harness
// prints the aggregate"). A group with a single line reports that line's
// own values for both min and median (both are well-defined for n=1).
//
// Review round 1 (Important 1): `healed`/`correct` counts are carried into
// the aggregate too, not just top/margin. Before this fix, the printed
// table (and the scratch JSONL it summarizes, which the aggregate test
// itself deletes at the end of the run -- see drift-harness.test.mjs's own
// doc comment) was the ONLY surviving artifact of a run, and it showed
// nothing but a healthy-looking score/margin number for a ranker that
// WS4a Task 6's own encoder leg actually observed binding to the WRONG
// candidate -- a reader of the aggregate alone had no way to know that.
// `"<healedCount>/<n>"`/`"<correctCount>/<n>"` (not a bare rate) keeps `n`
// visible right on the same fields, so a 1/1 correct is not confused with
// a 5/5 at a glance.
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function aggregateTuning(lines) {
  const groups = new Map();
  for (const line of lines) {
    const key = `${line.ranker}::${line.profile}`;
    if (!groups.has(key)) {
      groups.set(key, {
        ranker: line.ranker, profile: line.profile, tops: [], margins: [], healedCount: 0, correctCount: 0,
      });
    }
    const group = groups.get(key);
    group.tops.push(line.top);
    group.margins.push(line.margin);
    if (line.healed) group.healedCount += 1;
    if (line.correct) group.correctCount += 1;
  }
  return [...groups.values()].map((group) => ({
    ranker: group.ranker,
    profile: group.profile,
    n: group.tops.length,
    minTop: Math.min(...group.tops),
    medianTop: median(group.tops),
    minMargin: Math.min(...group.margins),
    medianMargin: median(group.margins),
    healed: `${group.healedCount}/${group.tops.length}`,
    correct: `${group.correctCount}/${group.tops.length}`,
  }));
}

// Prints the aggregate via `console.table`, mirroring `printSummary`'s own
// zero-deps convention. Prints a plain "no data" line rather than an empty
// table when `lines` is empty (the keyless, no-runtime run: neither
// gated leg contributed anything) -- still a normal, expected outcome, not
// a failure.
export function printTuningAggregate(lines) {
  console.log('\ndrift-harness tuning aggregate:');
  if (lines.length === 0) {
    console.log('  (no tuning lines collected this run -- gated legs did not execute)');
    return;
  }
  console.table(aggregateTuning(lines));
}
