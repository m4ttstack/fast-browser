import assert from 'node:assert/strict';
import {
  appendFile, mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { flows } from '../../lib/commands/flows.mjs';
import { sites } from '../../lib/commands/sites.mjs';
import { defaultConfig, loadConfig } from '../../lib/core/config.mjs';
import { createEncoder, encoderRanker, VOYAGE_API_KEY_ENV } from '../../lib/flows/encoder.mjs';
import {
  HEAL_MIN_MARGIN, HEAL_MIN_SCORE, parseFailurePayload, proposeHeal, rankCandidates,
} from '../../lib/flows/heal.mjs';
import { QUARANTINE_FAIL_STREAK_THRESHOLD } from '../../lib/flows/match.mjs';
import { listTraceSessions, readTraceRecordsFrom } from '../../lib/flows/trace-reader.mjs';
import { startOrderFixture } from '../fixtures/order-flow/server.mjs';
import {
  classifyReplay, printTuningAggregate, recordAndApprove, replayArgsFor, replayOneProfile,
  runHarness, targetForFailedStep, tuningLineFor,
} from './helpers/drift-harness.mjs';
import { installFlowRunner, pathsForOutputDir, tracedSession } from './helpers/flow-fixtures.mjs';

// --- WS4a Task 6: tuning-report scratch dir + in-process line collector ---
//
// ONE scratch dir, ONE JSONL file, for the whole test file's run (module
// scope, not per-test): the printed aggregate at the bottom needs every
// heal-path leg's contribution regardless of which test produced it, and
// `node:test` runs this file's top-level tests sequentially in declaration
// order (no `concurrency` option set anywhere below), so by the time the
// final aggregate test (the LAST one declared) runs, every earlier test has
// already pushed whatever it was going to push. Never committed -- a
// mkdtemp under `os.tmpdir()`, cleaned up by the aggregate test itself once
// it has read the file back and printed the summary.
const TUNING_SCRATCH_DIR = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-drift-tuning-'));
const TUNING_REPORT_PATH = path.join(TUNING_SCRATCH_DIR, 'tuning-report.jsonl');
const TUNING_LINES = [];

async function recordTuningLine(line) {
  TUNING_LINES.push(line);
  await appendFile(TUNING_REPORT_PATH, `${JSON.stringify(line)}\n`);
}

// WS4a Task 6 finding (see the task report): a direct `encoderRanker(...)`
// call made WHILE a real browser session is actively navigating/clicking
// concurrently can occasionally miss its own 5000ms `AbortSignal.timeout`
// budget (lib/flows/encoder.mjs's `VOYAGE_TIMEOUT_MS`) under real system
// load -- observed directly during this task's own manual verification. A
// call made in ISOLATION (no concurrent browser activity) was 100%
// reliable across repeated trials. ONE bounded retry -- never a loop --
// absorbs that specific, real transient-timeout class of failure without
// masking a genuine, persistent one (which still throws on the second
// attempt).
async function withOneVoyageRetry(fn) {
  try {
    return await fn();
  } catch (firstError) {
    // Review round 1 (folded minor b): the swallowed first attempt is real
    // signal (exactly the transient-timeout class this helper exists to
    // absorb, per its own doc comment above) -- logged rather than
    // silently discarded, so a run that needed the retry still leaves a
    // trace of why in `npm run test:drift`'s own output.
    console.warn(`fast-browser drift-harness: voyage call failed once, retrying once -- ${firstError?.message ?? firstError}`);
    return fn();
  }
}

// WS4a Task 3: drift-harness driver + rung classifier.
//
// --- Step 1 (TDD): classifyReplay is pure -- covered here with hand-built
// success/failure/heal shapes, no browser, no FAST_BROWSER_RELEASE_DIR.
// Every rung label, plus the full precedence chain the plan's Shared
// shapes pins (heal > quirk > escalated > fallback > clean; fail only
// when nothing healed), gets its own case below so `npm run test:drift`
// stays green -- these subtests running -- even without a local runtime.
// ---

function successResult({ locatorFallbacks = [] } = {}) {
  return {
    ok: true, result: { completed: true }, stepsRun: 7, locatorFallbacks, ms: 42,
  };
}

// flow-runner.js's own contract: a rung-1 fallback entry never carries an
// `escalated` key; a rung-2 (resolveEscalated) entry always carries
// `escalated: true`. See tests/e2e/healing.test.mjs's healed/overlay legs
// for the real payloads these mirror.
const FALLBACK_ENTRY = { step: 1, usedKind: 'css', usedIndex: 1 };
const ESCALATED_ENTRY = {
  step: 1, usedKind: 'role', usedIndex: 0, escalated: true,
};
const HEALED_ENTRY = { name: 'place-order', stepIndex: 5, kind: 'testid' };
const FAILURE_STRING = 'FLOW_RUNNER_FAILURE: {"failedStep":1,"error":"no locator candidate matched"}';

test('classifyReplay: clean -- success, empty fallbacks, no dismiss, no heal', () => {
  const { rung, evidence } = classifyReplay({
    result: successResult(), error: null, sweepHealed: [], dismissCount: 0,
  });
  assert.equal(rung, 'clean');
  assert.deepEqual(evidence.fallbacks, []);
  assert.deepEqual(evidence.escalatedFallbacks, []);
  assert.deepEqual(evidence.healed, []);
  assert.equal(evidence.dismissCount, 0);
  assert.equal(evidence.ok, true);
  assert.equal(evidence.error, null);
});

test('classifyReplay: fallback -- success with a non-escalated fallback entry', () => {
  const { rung, evidence } = classifyReplay({
    result: successResult({ locatorFallbacks: [FALLBACK_ENTRY] }),
    error: null,
    sweepHealed: [],
    dismissCount: 0,
  });
  assert.equal(rung, 'fallback');
  assert.deepEqual(evidence.fallbacks, [FALLBACK_ENTRY]);
  assert.deepEqual(evidence.escalatedFallbacks, []);
});

test('classifyReplay: escalated -- success with an escalated fallback entry', () => {
  const { rung, evidence } = classifyReplay({
    result: successResult({ locatorFallbacks: [ESCALATED_ENTRY] }),
    error: null,
    sweepHealed: [],
    dismissCount: 0,
  });
  assert.equal(rung, 'escalated');
  assert.deepEqual(evidence.escalatedFallbacks, [ESCALATED_ENTRY]);
});

test('classifyReplay: quirk -- success with a nonzero dismiss-counter delta', () => {
  const { rung, evidence } = classifyReplay({
    result: successResult(), error: null, sweepHealed: [], dismissCount: 1,
  });
  assert.equal(rung, 'quirk');
  assert.equal(evidence.dismissCount, 1);
});

test('classifyReplay: heal -- a non-empty sweepHealed slice always wins', () => {
  const { rung, evidence } = classifyReplay({
    result: successResult(), error: null, sweepHealed: [HEALED_ENTRY], dismissCount: 0,
  });
  assert.equal(rung, 'heal');
  assert.deepEqual(evidence.healed, [HEALED_ENTRY]);
});

test('classifyReplay: fail -- an error present, no heal resulted', () => {
  const { rung, evidence } = classifyReplay({
    result: null, error: FAILURE_STRING, sweepHealed: [], dismissCount: 0,
  });
  assert.equal(rung, 'fail');
  assert.equal(evidence.error, FAILURE_STRING);
  assert.equal(evidence.ok, false);
  assert.deepEqual(evidence.fallbacks, []);
});

// --- precedence: heal > quirk > escalated > fallback > clean; fail is
// disambiguated from heal (a failed replay whose evidence a later sweep
// heals still classifies 'heal') and from quirk (a quirk attempted on a
// replay that ultimately still failed classifies 'fail', not 'quirk'). ---

test('classifyReplay precedence: heal beats quirk', () => {
  const { rung } = classifyReplay({
    result: successResult(), error: null, sweepHealed: [HEALED_ENTRY], dismissCount: 1,
  });
  assert.equal(rung, 'heal');
});

test('classifyReplay precedence: heal beats escalated', () => {
  const { rung } = classifyReplay({
    result: successResult({ locatorFallbacks: [ESCALATED_ENTRY] }),
    error: null,
    sweepHealed: [HEALED_ENTRY],
    dismissCount: 0,
  });
  assert.equal(rung, 'heal');
});

test('classifyReplay precedence: heal beats fallback', () => {
  const { rung } = classifyReplay({
    result: successResult({ locatorFallbacks: [FALLBACK_ENTRY] }),
    error: null,
    sweepHealed: [HEALED_ENTRY],
    dismissCount: 0,
  });
  assert.equal(rung, 'heal');
});

test('classifyReplay precedence: heal beats clean', () => {
  const { rung } = classifyReplay({
    result: successResult(), error: null, sweepHealed: [HEALED_ENTRY], dismissCount: 0,
  });
  assert.equal(rung, 'heal');
});

test('classifyReplay precedence: heal beats fail (the fail/heal disambiguation)', () => {
  const { rung } = classifyReplay({
    result: null, error: FAILURE_STRING, sweepHealed: [HEALED_ENTRY], dismissCount: 0,
  });
  assert.equal(rung, 'heal');
});

test('classifyReplay precedence: fail beats quirk (a quirk attempted on a replay that still failed)', () => {
  const { rung } = classifyReplay({
    result: null, error: FAILURE_STRING, sweepHealed: [], dismissCount: 1,
  });
  assert.equal(rung, 'fail');
});

// `error` present short-circuits before `result` is ever consulted at all
// -- a hand-built shape carrying BOTH (never a real flow-runner payload,
// which always sets `result` to null on failure) still classifies 'fail',
// proving the fail-vs-{escalated,fallback,clean} legs of the precedence
// order the code path structure implies rather than testing separately.
test('classifyReplay precedence: fail beats escalated/fallback signals on the same (hypothetical) call', () => {
  const { rung } = classifyReplay({
    result: successResult({ locatorFallbacks: [FALLBACK_ENTRY, ESCALATED_ENTRY] }),
    error: FAILURE_STRING,
    sweepHealed: [],
    dismissCount: 0,
  });
  assert.equal(rung, 'fail');
});

test('classifyReplay precedence: quirk beats escalated', () => {
  const { rung } = classifyReplay({
    result: successResult({ locatorFallbacks: [ESCALATED_ENTRY] }),
    error: null,
    sweepHealed: [],
    dismissCount: 1,
  });
  assert.equal(rung, 'quirk');
});

test('classifyReplay precedence: quirk beats fallback', () => {
  const { rung } = classifyReplay({
    result: successResult({ locatorFallbacks: [FALLBACK_ENTRY] }),
    error: null,
    sweepHealed: [],
    dismissCount: 1,
  });
  assert.equal(rung, 'quirk');
});

test('classifyReplay precedence: quirk beats clean', () => {
  const { rung } = classifyReplay({
    result: successResult(), error: null, sweepHealed: [], dismissCount: 1,
  });
  assert.equal(rung, 'quirk');
});

test('classifyReplay precedence: escalated beats fallback (mixed fallback entries, same replay)', () => {
  const { rung, evidence } = classifyReplay({
    result: successResult({ locatorFallbacks: [FALLBACK_ENTRY, ESCALATED_ENTRY] }),
    error: null,
    sweepHealed: [],
    dismissCount: 0,
  });
  assert.equal(rung, 'escalated');
  assert.equal(evidence.fallbacks.length, 2);
  assert.equal(evidence.escalatedFallbacks.length, 1);
});

test('classifyReplay precedence: fallback beats clean', () => {
  const { rung } = classifyReplay({
    result: successResult({ locatorFallbacks: [FALLBACK_ENTRY] }),
    error: null,
    sweepHealed: [],
    dismissCount: 0,
  });
  assert.equal(rung, 'fallback');
});

// --- Step 2/3: the driver, against a real browser + the real fixture.
// Skeleton only (this task): ONE leg, ONLY the base profile, asserting
// classification 'clean'. Task 4 adds the full per-profile matrix on top
// of this same runHarness call shape -- this test is written so a future
// leg only has to add more names to `profiles` and more assertions per
// entry in `results`, never restructure the setup below.
//
// Env-gated the same way tests/e2e/host-parity.test.mjs and
// tests/e2e/simultaneous.test.mjs gate their own live legs (a `const live
// = process.env.<VAR> === ...` computed once, then `{ skip: ... }` on the
// test itself): FAST_BROWSER_RELEASE_DIR is what every browser-driving e2e
// suite in this repo needs (tests/e2e/helpers/mcp-client.mjs's
// `resolveReleaseDir`), so this leg skips cleanly without it rather than
// falling through to that helper's own directory-walk-up auto-discovery --
// the point is a deterministic, named skip when no runtime was explicitly
// configured, not "skip unless one happens to be found nearby".
const releaseDirConfigured = Boolean(process.env.FAST_BROWSER_RELEASE_DIR);

// WS4a Task 6: the encoder leg's own gate. Named after the exact env var
// (lib/flows/encoder.mjs's own `VOYAGE_API_KEY_ENV`, never a re-typed
// literal) so the skip reason a keyless `npm run test:drift` reports names
// precisely what is missing -- mirrors `releaseDirConfigured` immediately
// above, computed once, consulted by both `{ skip }` gates below.
const voyageKeyConfigured = Boolean(process.env[VOYAGE_API_KEY_ENV]);

const HARNESS_RECORDED = { customerName: 'Harness', plan: 'team', seats: '4' };

// Verbatim the tests/e2e/healing.test.mjs recording script (no confirmation
// step -- the plain, four-field order flow every OTHER e2e suite in this
// repo also records).
async function recordOrderFlow(session, origin, { customerName, plan, seats }) {
  await session.callTool('browser_navigate', { url: origin });
  await session.callTool('browser_click', { target: 'role=button[name="Start order"]' });
  await session.callTool('browser_type', { target: 'role=textbox[name="Customer name"]', text: customerName });
  await session.callTool('browser_click', { target: 'role=button[name="Continue"]' });
  await session.callTool('browser_select_option', { target: 'role=combobox[name="Plan"]', values: [plan] });
  await session.callTool('browser_type', { target: 'role=spinbutton[name="Seats"]', text: seats });
  await session.callTool('browser_click', { target: 'role=button[name="Review order"]' });
  await session.callTool('browser_click', { target: 'role=button[name="Place order"]' });
  await session.callTool('browser_wait_for', { text: 'Order complete' });
}

const orderFlow = {
  name: 'order-flow',
  intent: 'place an order',
  startFixture: () => startOrderFixture(),
  record: (session, origin) => recordOrderFlow(session, origin, HARNESS_RECORDED),
  replayArgs: (invocation) => replayArgsFor(invocation, HARNESS_RECORDED),
};

test(
  'drift-harness: base profile classifies clean, and per-leg restore keeps profiles independent',
  { skip: releaseDirConfigured ? false : 'FAST_BROWSER_RELEASE_DIR is not set; this leg needs a local runtime' },
  async (t) => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-drift-harness-'));
    const paths = pathsForOutputDir(outputDir);
    await installFlowRunner(paths);

    // The SAME profile ('base') driven twice, deliberately: a single leg
    // cannot distinguish "the driver restored the artifact" from "nothing
    // ever mutated it" (a single successful replay's own sweep pass is
    // real, expected drift either way -- see drift-harness.mjs's own doc
    // comment on `replayOneProfile`). Running it twice gives the second
    // leg an actual prior leg's provenance write to have to undo.
    const { results, resultsPath, recordings } = await runHarness({
      profiles: ['base', 'base'],
      flows: [orderFlow],
      paths,
      t,
    });

    assert.equal(results.length, 2);
    for (const entry of results) {
      assert.equal(entry.flow, 'order-flow');
      assert.equal(entry.profile, 'base');
      assert.equal(entry.rung, 'clean');
      assert.deepEqual(entry.evidence.fallbacks, []);
      assert.deepEqual(entry.evidence.escalatedFallbacks, []);
      assert.deepEqual(entry.evidence.healed, []);
      assert.equal(entry.evidence.dismissCount, 0);
      assert.equal(entry.evidence.error, null);
    }

    // The results table was actually written to the harness scratch dir
    // (under this test's own mkdtemp -- never committed) and round-trips.
    const persisted = JSON.parse(await readFile(resultsPath, 'utf8'));
    assert.deepEqual(persisted, results);

    // Artifact isolation pin: the approved recording's own snapshot has
    // successRuns 0 (nothing has replayed against it yet at approval
    // time) --
    const recording = recordings.find((entry) => entry.flow === 'order-flow');
    assert.ok(recording, 'expected a recording entry for flow "order-flow"');
    const snapshotFlow = JSON.parse(recording.snapshot.toString('utf8'));
    assert.equal(snapshotFlow.provenance.successRuns, 0);

    // -- and BOTH legs report successRuns === 1 after their own sweep, not
    // 1 then 2. `runHarness` restores the artifact to that same
    // successRuns-0 snapshot immediately before EVERY leg (drift-
    // harness.mjs's `replayOneProfile`), so the second leg's own sweep
    // increments from the restored baseline exactly like the first leg's
    // did -- it never sees the first leg's own successRuns:1 write. If the
    // restore step were missing entirely, the second entry here would
    // report successRuns: 2 instead: this is the isolation guarantee the
    // task's design constraints ask to pin, expressed through sweep.mjs's
    // own real provenance-write behavior rather than raw byte-equality
    // (which a real, non-heal replay's own sweep legitimately changes
    // every time -- see drift-harness.mjs's comment for why).
    assert.deepEqual(results[0].provenance, { successRuns: 1, failStreak: 0 });
    assert.deepEqual(results[1].provenance, { successRuns: 1, failStreak: 0 });

    t.after(() => rm(outputDir, { recursive: true, force: true }));
  },
);

// --- Task 4: the full rung-distribution matrix -- the durability pin ---
//
// One recording, one fixture instance, every named mutation profile
// (tests/fixtures/order-flow/profiles.mjs's `PROFILES`) replayed against
// it in turn, each leg isolated by `runHarness`/`replayOneProfile`'s own
// per-leg restore (see that file's doc comment). Every expected rung below
// is a LITERAL, independent of `profiles.mjs`'s own `expected` metadata --
// this is the point of a durability pin: a stray future edit to that
// metadata must not be able to silently drag this test's own expectations
// along with it. `tests/unit/fixture-profiles.test.mjs` separately pins
// the metadata's own shape/values; this file pins what the RUNTIME
// actually does.
//
// Leg order below is LOAD-BEARING: `text-rename-far` must stay LAST. Its
// own quarantine drive (below) issues two extra `replayOneProfile` calls
// with `restore: false`, deliberately NOT restoring the golden artifact in
// between so `failStreak` accumulates instead of resetting -- any other
// leg running after the first `text-rename-far` attempt would restore the
// artifact via its own default `restore: true` and silently erase that
// accumulation before the drive ever got to observe the threshold trip.
//
// Unlike the skeleton test above (Task 3, `recordOrderFlow` -- no
// "Confirm order" click at all), every leg here needs BOTH interactive
// buttons the fixture's `showReview()` renders exercised by the recording:
// `text-rename-near` drifts "Confirm order" specifically, and
// `dom-reshuffle` reparents both buttons together -- a recording that
// never clicks "Confirm order" would never give either profile anything
// to prove. This is `tests/e2e/healing.test.mjs`'s own
// `recordOrderFlowWithConfirmation`, copied verbatim (this repo's existing
// convention -- see that file's own doc comment on the shared
// `pathsForOutputDir`/`installFlowRunner`/`tracedSession` trio for why the
// RECORDING scripts themselves are not similarly extracted: each e2e file
// keeps its own copy).
async function recordOrderFlowWithConfirmation(session, origin, { customerName, plan, seats }) {
  await session.callTool('browser_navigate', { url: origin });
  await session.callTool('browser_click', { target: 'role=button[name="Start order"]' });
  await session.callTool('browser_type', { target: 'role=textbox[name="Customer name"]', text: customerName });
  await session.callTool('browser_click', { target: 'role=button[name="Continue"]' });
  await session.callTool('browser_select_option', { target: 'role=combobox[name="Plan"]', values: [plan] });
  await session.callTool('browser_type', { target: 'role=spinbutton[name="Seats"]', text: seats });
  await session.callTool('browser_click', { target: 'role=button[name="Review order"]' });
  await session.callTool('browser_click', { target: 'role=button[name="Confirm order"]' });
  await session.callTool('browser_click', { target: 'role=button[name="Place order"]' });
  await session.callTool('browser_wait_for', { text: 'Order complete' });
}

const MATRIX_RECORDED = { customerName: 'Robin', plan: 'team', seats: '5' };

// Registers the two site-memory quirks the 'banner-hides'/'banner-
// intercepts' legs need -- `#consent-accept` and `#intercept-dismiss` --
// against the fixture's own real origin, exactly the way
// tests/e2e/healing.test.mjs's own overlay/intercept legs do via the real
// `sites quirk add` CLI (not a hand-built quirks.json fixture). Registered
// ONCE, up front, against BOTH selectors regardless of which profile a
// given leg selects: a quirk only ever fires when its OWN selector's
// element is actually present and the step it's attached to has actually
// missed (per-URL/per-step matching lives in flow-runner.js itself, not
// here), so registering both ahead of time is inert for every OTHER
// profile in the matrix -- see lib/commands/sites.mjs's own "no approval
// gate" doc comment for why this registration step itself needs none.
async function registerOverlayQuirks({ origin, paths }) {
  await sites(
    {
      sub: 'quirk',
      verb: 'add',
      name: 'consent-accept',
      origin,
      selector: '#consent-accept',
      description: 'Dismiss the consent overlay',
      urlPattern: null,
      json: true,
    },
    { paths },
  );
  await sites(
    {
      sub: 'quirk',
      verb: 'add',
      name: 'intercept-dismiss',
      origin,
      selector: '#intercept-dismiss',
      description: 'Dismiss the pointer-event-intercepting overlay',
      urlPattern: null,
      json: true,
    },
    { paths },
  );
}

const matrixFlow = {
  name: 'order-flow',
  intent: 'place an order',
  startFixture: () => startOrderFixture(),
  record: (session, origin) => recordOrderFlowWithConfirmation(session, origin, MATRIX_RECORDED),
  replayArgs: (invocation) => replayArgsFor(invocation, MATRIX_RECORDED),
};

// Heal-path belt-and-suspenders (Task 3's review ledger, constraint 2): a
// heal leg's on-disk artifact carries an appended locator right after its
// own sweep; asserts that appended locator matches `expectedLocator`
// exactly, THEN performs the very restore `replayOneProfile` would run at
// the START of the next leg anyway, and re-reads the file to prove that
// restore genuinely erases the appended entry -- byte-identical to the
// pre-heal golden snapshot's own locator list for that step -- rather than
// inferring isolation only indirectly through `provenance.successRuns`
// (the skeleton test's own, weaker proof).
async function assertHealPinnedAndRestoreErasesIt({
  recorded, golden, entry, stepIndex, expectedLocator,
}) {
  assert.equal(entry.rung, 'heal');
  assert.equal(entry.evidence.healed.length, 1);
  assert.equal(entry.evidence.healed[0].stepIndex, stepIndex);
  assert.equal(entry.evidence.healed[0].kind, expectedLocator.kind);
  // The fail-vs-heal disambiguation drift-harness.mjs's own doc comment
  // calls out: THIS replay attempt genuinely fails outright (the locator
  // walk misses against the still-drifted artifact) -- it is the sweep
  // that runs strictly AFTER it that discovers the heal from that
  // failure's own evidence. A single (leg = one replay + one sweep) never
  // gets to replay AGAIN against the now-healed artifact to observe
  // `ok: true`, so `ok: false` + a real error string here is the correct,
  // expected shape for a heal leg -- not a contradiction of `rung: 'heal'`
  // (classifyReplay's own precedence: heal beats fail).
  assert.equal(entry.evidence.ok, false);
  assert.ok(
    typeof entry.evidence.error === 'string' && entry.evidence.error.startsWith('FLOW_RUNNER_FAILURE: '),
    `expected a FLOW_RUNNER_FAILURE error string on the drifted attempt that triggered this heal: ${entry.evidence.error}`,
  );

  const healedOnDisk = JSON.parse(await readFile(recorded.flowFilePath, 'utf8'));
  const healedLocators = healedOnDisk.steps[stepIndex].target.locators;
  const goldenLocators = golden.steps[stepIndex].target.locators;
  const appendedLocator = healedLocators[healedLocators.length - 1];
  assert.deepEqual(appendedLocator, expectedLocator);
  // Purely additive: every golden locator is still present, ahead of the
  // appended alternate.
  assert.deepEqual(healedLocators.slice(0, -1), goldenLocators);
  assert.notDeepEqual(healedLocators, goldenLocators, `${expectedLocator.kind}: expected the heal to have actually changed the on-disk locator list`);

  await writeFile(recorded.flowFilePath, recorded.snapshot);
  const restoredOnDisk = JSON.parse(await readFile(recorded.flowFilePath, 'utf8'));
  assert.deepEqual(
    restoredOnDisk.steps[stepIndex].target.locators,
    goldenLocators,
    `${expectedLocator.kind}: expected the post-leg restore to erase the appended heal locator`,
  );
}

test(
  'drift-harness: rung distribution pinned across every mutation profile',
  {
    timeout: 300_000,
    skip: releaseDirConfigured ? false : 'FAST_BROWSER_RELEASE_DIR is not set; this leg needs a local runtime',
  },
  async (t) => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-drift-matrix-'));
    const paths = pathsForOutputDir(outputDir);
    await installFlowRunner(paths);

    const fixture = await startOrderFixture();
    t.after(() => fixture.close());

    await registerOverlayQuirks({ origin: fixture.origin, paths });

    const recorded = await recordAndApprove(t, matrixFlow, fixture, paths);
    const golden = JSON.parse(recorded.snapshot.toString('utf8'));
    const startOrderStepIndex = golden.steps.findIndex(
      (step) => step.op === 'click' && step.target?.name === 'Start order',
    );
    const confirmOrderStepIndex = golden.steps.findIndex(
      (step) => step.op === 'click' && step.target?.name === 'Confirm order',
    );
    const placeOrderStepIndex = golden.steps.findIndex(
      (step) => step.op === 'click' && step.target?.name === 'Place order',
    );
    assert.notEqual(startOrderStepIndex, -1, 'expected a click step targeting "Start order"');
    assert.notEqual(confirmOrderStepIndex, -1, 'expected a click step targeting "Confirm order"');
    assert.notEqual(placeOrderStepIndex, -1, 'expected a click step targeting "Place order"');

    async function replayLeg(profileName) {
      const entry = await replayOneProfile({
        t, flow: matrixFlow, fixture, paths, recorded, profileName,
      });
      t.diagnostic(`${profileName}: rung=${entry.rung} evidence=${JSON.stringify(entry.evidence)} provenance=${JSON.stringify(entry.provenance)}`);
      return entry;
    }

    // WS4a Task 6: tuning-report emission for this matrix's own heal-path
    // legs -- lexical is ALWAYS computable (no network, the payload is
    // already captured evidence sitting in `errorString`); the voyage row
    // is additive, only computed when `voyageKeyConfigured` (Shared shapes:
    // "voyage only when keyed"). Always against `golden` (the PRE-heal
    // snapshot closed over from this test's own scope) -- never the
    // on-disk flow, which by the time this runs already carries THIS leg's
    // own appended heal locator, and re-proposing against it would trip
    // `finalize`'s idempotence guard (the locator is "already present") for
    // both rankers, silently forcing every line's `correct` to false
    // regardless of what actually ranked first.
    async function emitHealPathTuningLines({ profile, errorString, expectedSelector }) {
      const payload = parseFailurePayload(errorString);
      const target = targetForFailedStep(golden, payload);

      const lexicalRanked = rankCandidates({ target, candidates: payload.candidates });
      await recordTuningLine(tuningLineFor({
        profile,
        flowName: matrixFlow.name,
        rankerName: 'lexical',
        ranked: lexicalRanked,
        minScore: HEAL_MIN_SCORE,
        minMargin: HEAL_MIN_MARGIN,
        flow: golden,
        payload,
        expectedSelector,
      }));

      if (voyageKeyConfigured) {
        // Optional, additive data (Shared shapes: "voyage only when keyed")
        // -- contained separately from the matrix's own required rung
        // assertions: a transient Voyage failure here (this call runs
        // between profile legs, while the shared runtime process from
        // `startFixture` is still alive from earlier legs -- see
        // `withOneVoyageRetry`'s own doc comment) must never take down the
        // matrix test's real job (the rung-distribution pins), so it is
        // caught and skipped with a diagnostic rather than left to
        // propagate after the one bounded retry is exhausted.
        try {
          const encoder = createEncoder({ config: { encoder: 'voyage' }, env: process.env });
          const ranker = encoderRanker(encoder);
          const voyageRanked = await withOneVoyageRetry(
            () => ranker({ target, candidates: payload.candidates }),
          );
          await recordTuningLine(tuningLineFor({
            profile,
            flowName: matrixFlow.name,
            rankerName: 'voyage',
            ranked: voyageRanked,
            minScore: ranker.minScore,
            minMargin: ranker.minMargin,
            flow: golden,
            payload,
            expectedSelector,
          }));
        } catch (error) {
          t.diagnostic(`optional voyage tuning line for "${profile}" skipped: ${error?.message ?? error}`);
        }
      }
    }

    // --- class-rename: declared 'clean' in the plan, but INFERRED, not
    // observed (Task 3's review ledger, constraint 3) -- the id->class
    // rename only defeats a css-kind locator, and this is only truthfully
    // 'clean' if the recording's own FIRST candidate for a plain button is
    // role-kind (profiles.mjs's own doc comment cites
    // tests/e2e/healing.test.mjs's intercept leg as that same evidence).
    // Observed to match the inference: role resolves first, the css-hook
    // rename never gets consulted at all -- 'clean', zero fallbacks.
    const classRename = await replayLeg('class-rename');
    assert.equal(classRename.rung, 'clean');
    assert.deepEqual(classRename.evidence.fallbacks, []);
    assert.deepEqual(classRename.evidence.healed, []);
    assert.equal(classRename.evidence.dismissCount, 0);
    assert.equal(classRename.evidence.ok, true);

    // --- dom-reshuffle: same declared-vs-inferred posture as class-rename
    // -- reparenting is only truthfully invisible to the recorded locators
    // if neither the role nor the css-id query is ancestor-scoped, which
    // `page.getByRole()`/a bare `#id` css selector never are. Observed to
    // match: 'clean', zero fallbacks, on BOTH reshuffled buttons (this
    // leg's replay drives both "Confirm order" and "Place order").
    const domReshuffle = await replayLeg('dom-reshuffle');
    assert.equal(domReshuffle.rung, 'clean');
    assert.deepEqual(domReshuffle.evidence.fallbacks, []);
    assert.deepEqual(domReshuffle.evidence.healed, []);
    assert.equal(domReshuffle.evidence.dismissCount, 0);
    assert.equal(domReshuffle.evidence.ok, true);

    // --- testid-rename: WS3a's original drift, replayed through the same
    // matrix machinery. A testid-carrying candidate is what the failed
    // probe's own evidence surfaces (tests/e2e/healing.test.mjs's own
    // "3. sweep -> heal" step proves this at the unit-of-work level); here
    // only the CLASSIFIED outcome and the synthesized selector matter.
    const testidRename = await replayLeg('testid-rename');
    await assertHealPinnedAndRestoreErasesIt({
      recorded,
      golden,
      entry: testidRename,
      stepIndex: placeOrderStepIndex,
      expectedLocator: { kind: 'testid', selector: 'internal:testid=[data-testid="submit-v2"]' },
    });
    await emitHealPathTuningLines({
      profile: 'testid-rename',
      errorString: testidRename.evidence.error,
      expectedSelector: 'internal:testid=[data-testid="submit-v2"]',
    });

    // --- text-rename-near: the WS3b role+text heal path -- kind 'other',
    // per heal.mjs's own DEVIATION note (a role+name/text heal is always
    // synthesized as kind 'other', never kind 'role').
    const textRenameNear = await replayLeg('text-rename-near');
    await assertHealPinnedAndRestoreErasesIt({
      recorded,
      golden,
      entry: textRenameNear,
      stepIndex: confirmOrderStepIndex,
      expectedLocator: { kind: 'other', selector: 'internal:role=button[name="Confirm your order"i]' },
    });
    await emitHealPathTuningLines({
      profile: 'text-rename-near',
      errorString: textRenameNear.evidence.error,
      expectedSelector: 'internal:role=button[name="Confirm your order"i]',
    });

    // --- delayed-render: RETIMED (WS4a Task 4 review round 2, Critical).
    // profiles.mjs's own doc comment above `DELAYED_INSERT_CALL` has the
    // full g-aware margin write-up: at 4500ms, rung 1's own two-candidate
    // walk (3000ms total from the step's own probe start) is exhausted
    // regardless of host speed, and the render lands inside rung 2's
    // escalated pass's own candidate-0 (role) window with a wide margin on
    // both edges. This is the one profile in the whole matrix that proves
    // `resolveTarget`'s NATURAL rung-1-exhausted escalation path (as
    // opposed to `banner-hides`/`banner-intercepts`'s quirk-driven
    // recovery, or healing.test.mjs's own POST-QUIRK forced-escalated
    // pass) -- pinned to the exact fallback entry, not a loose `>= 1`,
    // mirroring healing.test.mjs's own overlay-leg style.
    const delayedRender = await replayLeg('delayed-render');
    assert.equal(delayedRender.rung, 'escalated');
    assert.deepEqual(delayedRender.evidence.healed, []);
    assert.equal(delayedRender.evidence.dismissCount, 0);
    assert.deepEqual(delayedRender.evidence.fallbacks, [
      {
        step: placeOrderStepIndex, usedKind: 'role', usedIndex: 0, escalated: true,
      },
    ]);
    assert.deepEqual(delayedRender.evidence.escalatedFallbacks, delayedRender.evidence.fallbacks);
    assert.equal(delayedRender.evidence.ok, true);

    // --- banner-hides: constraint 1's own fixture -- the fixture-side
    // `window.__consentDismissClicks__` counter (this task's own addition
    // to index.html) is what turns this leg's recovery into a countable
    // 'quirk', not the escalated-fallback-only 'escalated' the mechanism
    // would otherwise classify as (see index.html's and drift-harness.mjs's
    // own doc comments). The recovery still also leaves an escalated
    // fallback entry on the "Start order" step (the probe-miss path, per
    // healing.test.mjs's own overlay leg, pinned exactly here too, not just
    // `>= 1`) -- both are true at once; classifyReplay's own precedence
    // (quirk beats escalated) is what resolves that to a single rung.
    const bannerHides = await replayLeg('banner-hides');
    assert.equal(bannerHides.rung, 'quirk');
    assert.equal(bannerHides.evidence.dismissCount, 1);
    assert.deepEqual(bannerHides.evidence.healed, []);
    assert.equal(bannerHides.evidence.ok, true);
    assert.deepEqual(bannerHides.evidence.fallbacks, [
      {
        step: startOrderStepIndex, usedKind: 'role', usedIndex: 0, escalated: true,
      },
    ]);
    assert.deepEqual(bannerHides.evidence.escalatedFallbacks, bannerHides.evidence.fallbacks);

    // --- banner-intercepts: the existing `__interceptDismissClicks__`
    // counter (unchanged by this task) already makes this a 'quirk'. The
    // WS3b fallbacks contract this leg proves: EMPTY locatorFallbacks --
    // the probe never failed at all (the recorded target's first, index-0
    // locator hits immediately), only the ACT (`.click()`) was intercepted
    // -- so classifyReplay's own 'quirk' label here rests entirely on the
    // dismiss counter, by design, never on a fallback entry (there isn't
    // one).
    const bannerIntercepts = await replayLeg('banner-intercepts');
    assert.equal(bannerIntercepts.rung, 'quirk');
    assert.equal(bannerIntercepts.evidence.dismissCount, 1);
    assert.deepEqual(bannerIntercepts.evidence.healed, []);
    assert.equal(bannerIntercepts.evidence.ok, true);
    assert.deepEqual(bannerIntercepts.evidence.fallbacks, [], 'expected an EMPTY locatorFallbacks -- the act, never the probe, is what failed here');

    // --- text-rename-far: keyless -- zero lexical token overlap can never
    // clear HEAL_MIN_SCORE, so no heal fires no matter how many times this
    // replays. 'fail', WITHOUT a healSelector key (there is no heal to
    // report a selector for at all -- `evidence.healed` stays empty, not
    // merely "the wrong kind"). This is the leg's own restored-golden-state
    // attempt (`replayLeg` -> `replayOneProfile`'s default `restore: true`)
    // -- failStreak 1, the first of the three consecutive failures the
    // quarantine drive below continues from the SAME on-disk state
    // (`restore: false`), never restoring back to 0 in between.
    const textRenameFarFirst = await replayLeg('text-rename-far');
    assert.equal(textRenameFarFirst.rung, 'fail');
    assert.deepEqual(textRenameFarFirst.evidence.healed, []);
    assert.equal(textRenameFarFirst.evidence.ok, false);
    assert.ok(
      typeof textRenameFarFirst.evidence.error === 'string' && textRenameFarFirst.evidence.error.startsWith('FLOW_RUNNER_FAILURE: '),
      `expected a FLOW_RUNNER_FAILURE error string: ${textRenameFarFirst.evidence.error}`,
    );
    assert.deepEqual(textRenameFarFirst.provenance, { successRuns: 0, failStreak: 1 });

    // WS4a Task 6: "the far-rename lexical control" tuning line (Shared
    // shapes) -- LEXICAL ONLY, always, regardless of `voyageKeyConfigured`:
    // this is the keyless baseline every future retune compares the keyed
    // leg's own contrast against, not just another "both rankers when
    // keyed" row (this profile's real voyage numbers, when keyed, come
    // from the dedicated encoder-leg test below instead, which captures
    // its OWN independent payload from its OWN recording -- this control's
    // payload is THIS matrix's, a different fixture instance entirely).
    // `expectedSelector` mirrors the literal the dedicated encoder leg
    // pins for the same profile: what the fixture's own intended drift
    // target would synthesize to, had a ranker's top pick actually been
    // it.
    {
      const farPayload = parseFailurePayload(textRenameFarFirst.evidence.error);
      const farTarget = targetForFailedStep(golden, farPayload);
      const farLexicalRanked = rankCandidates({ target: farTarget, candidates: farPayload.candidates });
      await recordTuningLine(tuningLineFor({
        profile: 'text-rename-far',
        flowName: matrixFlow.name,
        rankerName: 'lexical',
        ranked: farLexicalRanked,
        minScore: HEAL_MIN_SCORE,
        minMargin: HEAL_MIN_MARGIN,
        flow: golden,
        payload: farPayload,
        expectedSelector: 'internal:role=button[name="Checkout"i]',
      }));
    }

    // --- quarantine drive: two MORE consecutive failures against the SAME
    // (never-restored) on-disk artifact, reaching QUARANTINE_FAIL_STREAK_
    // THRESHOLD (3, lib/flows/match.mjs) exactly on the third. No encoder
    // config is set anywhere in this task (Task 6's own concern) -- this
    // drive only exercises the plain lexical matcher's own quarantine
    // multiplier.
    const textRenameFarSecond = await replayOneProfile({
      t, flow: matrixFlow, fixture, paths, recorded, profileName: 'text-rename-far', restore: false,
    });
    assert.equal(textRenameFarSecond.rung, 'fail');
    assert.deepEqual(textRenameFarSecond.provenance, { successRuns: 0, failStreak: 2 });

    const textRenameFarThird = await replayOneProfile({
      t, flow: matrixFlow, fixture, paths, recorded, profileName: 'text-rename-far', restore: false,
    });
    assert.equal(textRenameFarThird.rung, 'fail');
    assert.deepEqual(textRenameFarThird.provenance, { successRuns: 0, failStreak: 3 });
    assert.ok(textRenameFarThird.provenance.failStreak >= QUARANTINE_FAIL_STREAK_THRESHOLD);

    // A fresh `find` after the third failure surfaces the quarantine
    // reason -- the SAME literal `matchFlows` (lib/flows/match.mjs) emits,
    // pinned verbatim here too (tests/unit/flows-match.test.mjs already
    // pins it at the unit level; this proves the real CLI path produces it
    // end to end).
    const quarantineFind = await flows(
      {
        sub: 'find', intent: matrixFlow.intent, origin: fixture.origin, url: null, json: true,
      },
      { paths },
    );
    const quarantineCandidate = quarantineFind.candidates.find((candidate) => candidate.name === recorded.compiledName);
    assert.ok(quarantineCandidate, `expected "${recorded.compiledName}" to still surface as a match candidate while quarantined`);
    assert.ok(
      quarantineCandidate.reasons.includes('quarantined: re-record likely cheaper'),
      `expected a quarantine reason: ${JSON.stringify(quarantineCandidate.reasons)}`,
    );

    t.after(() => rm(outputDir, { recursive: true, force: true }));
  },
);

// --- Task 5: the at-most-once kill test ---
//
// Pins the spec's at-most-once consent invariant end to end: a replay
// killed mid-flow must never have fired its mutating action twice, and the
// session it leaves behind must sweep cleanly under lib/flows/sweep.mjs's
// live-session deferral contract (module doc comment, "incremental
// cursors: TWO of them" -- compilation deferred entirely until
// `meta.endedAt` exists; replay-record PROVENANCE scanning is NOT deferred,
// it runs every sweep, live or complete).
//
// WORDING NOTE (review round 1): that session is ABANDONED, not truncated.
// "Truncated" implies a partial/incomplete record -- what actually happens
// (the FINDING further down, ~90 lines below) is the opposite: the client
// gives up on the call, but the SERVER keeps running the macro to its own
// full natural conclusion regardless, so the trace this session ends up
// with is a COMPLETE record of one failed attempt, not a cut-off fragment.
// "Truncated" would describe a real host-level kill (SIGKILL on the runtime
// process mid-macro) -- see the coverage-gap note near the bottom of this
// test for why that scenario is NOT what this leg exercises.
//
// Independent of the matrix legs above (own fixture instance, own output
// dir, own recording) -- per the plan's own Scope note that the kill leg
// must not share isolation state with the rung-distribution matrix.
//
// The mutating step + stall mechanism (tests/fixtures/order-flow/server.mjs
// / index.html, both amended by this task):
//   - `fixture.setKillTest({ token, stall })` is a server MODE (not a
//     mutation PROFILE -- profiles.mjs is untouched by this task): the
//     NEXT '/' request embeds `window.__KILL_TEST_TOKEN__`/
//     `__KILL_TEST_STALL__`, read once at page load, same "flips what the
//     next request serves, never touches one in flight" contract
//     `setProfile` already has.
//   - The "Place order" click fires a REAL `POST /order` (index.html,
//     delegated at the `app` container so the existing mutation profiles'
//     own exact-substring targeting of showReview()'s click-wiring line
//     stays completely untouched -- see that file's own doc comment).
//     server.mjs counts it per TOKEN in an in-memory Map; `GET
//     /order/count?token=` reads it back over plain HTTP, independent of
//     any browser session -- this is how this test PROVES the mutation
//     fired, rather than assuming it from timing.
//   - The stall itself is the brief's own SECOND documented option ("the
//     client script never renders the next element"), not the first
//     ("server holds the response"): under `stall: true`, `showComplete()`
//     still renders "Order complete" (the mutating action's own visible
//     effect completes) but withholds the "Confirm receipt" button
//     entirely -- the kill-test flow's own compiled step immediately AFTER
//     the mutating click. `flow-runner.js` has no code path that can hang a
//     replay call truly forever (its own header comment: "a settle wait
//     that can never hang the replay" is a deliberate design property, not
//     an oversight) -- the withheld button instead makes the runner's own
//     bounded, real locator walk (rung 1's 1500ms + rung 2's 3000ms =
//     4500ms worst case, builtins/macros/flow-runner.js's `resolveTarget`)
//     spin genuinely, for a real window strictly AFTER the mutation has
//     already fired -- long enough to reliably land a kill inside it, which
//     is what "hangs after the mutation" needs to mean for a runner that
//     intentionally never hangs forever. That window alone is bounded at
//     4500ms; the grace-period comment further down measures the actual
//     observed total (longer -- an extra settle-wait stacks on top of it,
//     for a reason explained there).
//
// The kill itself: `tests/e2e/helpers/mcp-client.mjs`'s `callTool` now
// forwards an optional third `options` argument straight to the MCP SDK's
// own `client.callTool(params, resultSchema, options)` -- `{ signal }` is
// the SDK's real cancellation surface (`protocol.js`: on abort, the LOCAL
// call rejects and a `notifications/cancelled` is sent to the server).
// Whether the SERVER actually stops executing the in-flight
// `browser_run_code_unsafe` macro on receiving that notification, or keeps
// running it to its own natural conclusion regardless, is exactly the
// empirical question this test is built to observe rather than assume --
// see the report for what was actually observed.

async function recordKillTestFlow(session, origin, { customerName, plan, seats }) {
  await session.callTool('browser_navigate', { url: origin });
  await session.callTool('browser_click', { target: 'role=button[name="Start order"]' });
  await session.callTool('browser_type', { target: 'role=textbox[name="Customer name"]', text: customerName });
  await session.callTool('browser_click', { target: 'role=button[name="Continue"]' });
  await session.callTool('browser_select_option', { target: 'role=combobox[name="Plan"]', values: [plan] });
  await session.callTool('browser_type', { target: 'role=spinbutton[name="Seats"]', text: seats });
  await session.callTool('browser_click', { target: 'role=button[name="Review order"]' });
  await session.callTool('browser_click', { target: 'role=button[name="Place order"]' });
  // Recorded ONLY when kill-test mode is on (stall: false at record time --
  // see the test body below) -- "Confirm receipt" is the element that never
  // renders under stall at REPLAY time, giving the compiled flow a real
  // step immediately after the mutating click.
  await session.callTool('browser_click', { target: 'role=button[name="Confirm receipt"]' });
}

const KILL_RECORDED = { customerName: 'Kilo', plan: 'team', seats: '2' };

const killTestFlow = {
  name: 'order-flow-kill-test',
  record: (session, origin) => recordKillTestFlow(session, origin, KILL_RECORDED),
};

test(
  'drift-harness: mid-flow kill never double-submits; abandoned sessions sweep clean',
  {
    timeout: 300_000,
    skip: releaseDirConfigured ? false : 'FAST_BROWSER_RELEASE_DIR is not set; this leg needs a local runtime',
  },
  async (t) => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-drift-kill-'));
    const paths = pathsForOutputDir(outputDir);
    await installFlowRunner(paths);

    const fixture = await startOrderFixture();
    t.after(() => fixture.close());

    // Two DISTINCT tokens: RECORD is a throwaway used only so "Confirm
    // receipt" renders during recording (stall off) and can be clicked into
    // the compiled flow; REPLAY is the one this test's own assertions read
    // back. Never touched before this leg sets it, so it starts genuinely
    // at 0 -- the counter-reset semantics this task pins ("per fresh server
    // instance or per token" -- here, per token, on a fresh server
    // instance).
    const KILL_RECORD_TOKEN = 'kill-leg-record-probe';
    const KILL_REPLAY_TOKEN = 'kill-leg-replay-probe';

    fixture.setKillTest({ token: KILL_RECORD_TOKEN, stall: false });
    const recorded = await recordAndApprove(t, killTestFlow, fixture, paths);

    const findReport = await flows(
      { sub: 'find', intent: 'place an order', origin: fixture.origin, url: null, json: true },
      { paths },
    );
    assert.ok(findReport.candidates.length > 0, 'expected the kill-test flow to be findable');
    const invocation = findReport.candidates[0].invocation;
    const replayArgs = replayArgsFor(invocation, { customerName: 'Killed', plan: 'team', seats: '1' });

    // Flips what the replay's OWN internal `goto` step picks up (never
    // touches a request already in flight -- server.mjs's own doc
    // comment): stall now ON, and a fresh token this test hasn't used yet.
    fixture.setKillTest({ token: KILL_REPLAY_TOKEN, stall: true });

    const countUrl = (token) => `${fixture.origin}/order/count?token=${encodeURIComponent(token)}`;
    async function readCount(token) {
      const response = await fetch(countUrl(token));
      return (await response.json()).count;
    }

    assert.equal(await readCount(KILL_REPLAY_TOKEN), 0, "sanity: the kill leg's own token must start unused");

    // Snapshotted BEFORE creating the kill session (at this point only the
    // already-closed recording session's own trace dir exists) so the poll
    // below can identify the kill session's dir by DIFFERENCE, not by
    // assuming it is whatever `listTraceSessions` returns last. Review
    // round 1 caught a real bug here: querying `listTraceSessions`
    // immediately after `tracedSession()` resolves is a genuine race -- the
    // runtime does not necessarily have the trace-<epochMs> directory on
    // disk the instant the MCP connection itself is established, so an
    // "assume it exists at connection time" version of this lookup can (and
    // in one real run, did) return the RECORDING session's own directory
    // instead, silently corrupting every assertion downstream of it.
    const priorTraceBasenames = new Set(
      (await listTraceSessions(paths.dataDir)).map((session) => path.basename(session.dir)),
    );

    const killSession = await tracedSession(t, paths.dataDir);

    // COVERAGE GAP (review round 1, controller-filed): this leg kills the
    // replay by abandoning it CLIENT-SIDE (AbortSignal on the MCP call --
    // see below). It does NOT exercise the ORIGINAL scenario the spec's
    // at-most-once language was written against: a true mid-execution kill
    // (the host process dying, e.g. SIGKILL, partway through the macro).
    // That scenario -- and whether runtime cancellation ever propagates
    // into flow-runner.js's own execution rather than being silently
    // ignored, per the FINDING below -- is real, separate coverage this
    // leg does not provide. Backlog: true-kill coverage + runtime
    // cancellation propagation.
    const controller = new AbortController();

    // Issued without awaiting yet: grabbed as a promise so the counter can
    // be polled concurrently, then aborted mid-flight. The .catch here is
    // purely to stop Node from ever surfacing the eventual (expected)
    // rejection as an unhandled-rejection warning before the real `await`
    // further down.
    const replayPromise = killSession.callTool(invocation.tool, replayArgs, { signal: controller.signal });
    replayPromise.catch(() => {});

    // Resolved by polling for a NEW trace directory (one absent from the
    // pre-connection snapshot above) rather than by any assumption about
    // exactly when it appears. Review round 1 caught a real bug here: an
    // earlier version of this lookup ran BEFORE the replay call was even
    // issued and assumed the directory already existed at connection time
    // -- it does not (confirmed directly: that version timed out after
    // 30s, since nothing is traced yet for a connection that has not been
    // asked to do anything). Running the poll AFTER the call is issued,
    // concurrently with the counter poll below, is correct regardless of
    // exactly when the directory is created -- at the first action, or
    // (per the FINDING further down) only once the whole macro call has
    // run to its own natural completion.
    async function pollUntilNewTraceSession(priorBasenames, { intervalMs = 50, timeoutMs = 30_000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const sessions = await listTraceSessions(paths.dataDir);
        const fresh = sessions.find((session) => !priorBasenames.has(path.basename(session.dir)));
        if (fresh) return fresh;
        if (Date.now() >= deadline) {
          throw new Error('timed out waiting for the kill-leg trace session directory to appear');
        }
        await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
      }
    }

    const killTraceSessionAtStart = await pollUntilNewTraceSession(priorTraceBasenames);
    const killSessionDir = killTraceSessionAtStart.dir;
    const killBasename = path.basename(killSessionDir);

    // How we KNOW the mutation fired before we abort: not a timer or a
    // guess, a genuine independent HTTP read of the fixture's own counter
    // (a plain `fetch`, entirely outside the MCP session about to be
    // killed). `count` can only read 1 once the server has actually
    // processed and durably stored the increment -- polling until that's
    // true is the only way to prove ordering here, since the single
    // `browser_run_code_unsafe` call is opaque from the caller's side; no
    // partial progress is otherwise observable.
    async function pollUntilCount(token, target, { intervalMs = 25, timeoutMs = 15_000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const count = await readCount(token);
        if (count >= target) return count;
        if (Date.now() >= deadline) {
          throw new Error(`timed out waiting for token "${token}" to reach count ${target}; last observed ${count}`);
        }
        await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
      }
    }

    const observedAtAbort = await pollUntilCount(KILL_REPLAY_TOKEN, 1);
    assert.equal(observedAtAbort, 1, 'expected the mutating POST to have fired exactly once before the kill');

    const abortedAt = Date.now();
    controller.abort();

    let replayOutcome;
    try {
      const result = await replayPromise;
      replayOutcome = { settled: 'resolved', result };
    } catch (error) {
      replayOutcome = { settled: 'rejected', message: error?.message ?? String(error) };
    }
    const localSettleMs = Date.now() - abortedAt;
    t.diagnostic(`kill leg: local call settled "${replayOutcome.settled}" ${localSettleMs}ms after abort() -- ${JSON.stringify(replayOutcome).slice(0, 400)}`);

    // FINDING (see the report): aborting the MCP call does NOT cancel the
    // server-side browser_run_code_unsafe execution. A `notifications/
    // cancelled` IS sent (protocol.js's own `cancel()`), and the LOCAL
    // promise above rejects near-instantly regardless of anything the
    // server does -- but the runtime keeps running the flow-runner macro to
    // its own natural conclusion. Measured directly (a standalone timing
    // probe, run separately from this test): the "Place order" step's own
    // compiled `waitAfter.networkSettled` (set because the RECORDING
    // observed a real awaited request from this task's own mutating fetch)
    // adds flow-runner.js's `settleNetwork`'s full bounded 5000ms wait
    // after the click, and "Confirm receipt" then spins its own genuine,
    // real rung 1 + rung 2 walk (1500ms + 3000ms = 4500ms) before failing
    // with "no locator candidate matched" -- roughly 9.5-10s of real
    // server-side execution AFTER the mutating click, not merely the
    // ~4.5s a locator-only stall would need.
    //
    // Rather than sleep a fixed duration tuned to that measurement (review
    // round 1: the natural-completion window is downstream of runtime
    // timing this test does not control, and a constant tuned to one
    // observed run is exactly the kind of thing that quietly flakes on a
    // slower host or a future runtime release), this polls the trace file
    // itself, directly, until the replay's own record genuinely lands --
    // bounded generously (60s) as a backstop, not as the expected wait.
    async function pollUntilTraceRecordArrives(sessionDir, { intervalMs = 250, timeoutMs = 60_000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const result = await readTraceRecordsFrom(sessionDir, 0);
        if (result.readable && result.records.length > 0) return result.records;
        if (Date.now() >= deadline) {
          throw new Error(`timed out after ${timeoutMs}ms waiting for the kill-leg trace record to arrive`);
        }
        await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
      }
    }

    const arrivedRecords = await pollUntilTraceRecordArrives(killSessionDir);
    t.diagnostic(`kill leg: trace record arrived (${arrivedRecords.length} record(s)) -- natural server-side completion confirmed`);
    assert.equal(
      arrivedRecords.length,
      1,
      'expected exactly one trace record for the kill-leg session -- a single browser_run_code_unsafe call, nothing else',
    );

    // At-most-once, checked at the moment we have real EVIDENCE (not a
    // guess) that the server-side execution has run all the way to its own
    // natural conclusion: the record above only exists once that call
    // fully settled server-side.
    const countAfterNaturalCompletion = await readCount(KILL_REPLAY_TOKEN);
    t.diagnostic(`kill leg: counter after natural completion confirmed = ${countAfterNaturalCompletion}`);
    assert.equal(
      countAfterNaturalCompletion,
      1,
      'at-most-once: the mutating POST must never fire a second time, whether or not the abort actually cancelled server-side execution',
    );

    // --- the sweep half: live-session deferral, then no double-count ---

    const sessionsBeforeClose = await listTraceSessions(paths.dataDir);
    const killTraceSession = sessionsBeforeClose.find((session) => path.basename(session.dir) === killBasename);
    assert.equal(
      typeof killTraceSession?.meta?.endedAt,
      'undefined',
      'expected the kill-leg trace session to still have no endedAt (not yet closed)',
    );

    const preSweepArtifact = JSON.parse(await readFile(recorded.flowFilePath, 'utf8'));

    const firstSweep = await flows({ sub: 'compile', json: true }, { paths });
    t.diagnostic(`kill leg: first sweep (session still live) = ${JSON.stringify(firstSweep)}`);

    const firstCursorEntry = firstSweep.cursor[killBasename];
    assert.ok(firstCursorEntry, 'expected a cursor entry for the kill-leg trace session after the first sweep');
    assert.equal(
      firstCursorEntry.incomplete,
      true,
      'expected the still-live kill-leg session to be marked incomplete (provenance-swept only, per the live-session deferral contract)',
    );
    // The `incomplete` flag alone is a summary someone else could get right
    // by accident; the actual TWO-CURSOR deferral it summarizes is these
    // two numbers disagreeing (review round 1: pin the values, not just the
    // flag). `lines` (compilation) stays frozen at 0 -- deferred entirely,
    // since this session has no `meta.endedAt` yet -- while
    // `provenanceLines` (replay-record scanning, NOT deferred by liveness)
    // has already caught all the way up to 1, having just seen the one real
    // record the poll above proved exists.
    assert.deepEqual(
      { lines: firstCursorEntry.lines, provenanceLines: firstCursorEntry.provenanceLines },
      { lines: 0, provenanceLines: 1 },
      'expected compilation frozen at 0 (deferred while live) while provenance scanning already reached 1 -- the two-cursor deferral model, pinned as real cursor values',
    );
    assert.deepEqual(firstSweep.compiled, [], 'expected nothing new compiled from a pure-replay session, live or not');

    // FINDING, pinned: because the server-side execution ran to its own
    // natural conclusion despite the abort (see the grace-period comment
    // above), the trace already carries a completed (failed) replay record
    // by the time this FIRST sweep runs -- and sweep.mjs's own contract
    // (module doc comment: "replay-record PROVENANCE scanning is NOT
    // deferred, it runs every sweep, live or complete") means THIS sweep,
    // while the session is still live/incomplete, already applies it:
    // `updated` carries a real entry, `failStreak` goes from 0 to 1
    // (the mutating action fired -- successRuns stays 0, this attempt did
    // not succeed -- "Confirm receipt" never resolved). This is "provenance
    // -swept only" exactly as the contract promises: a replay was counted,
    // but nothing compiled, and the cursor above still reads `incomplete:
    // true`.
    const postFirstSweepArtifact = JSON.parse(await readFile(recorded.flowFilePath, 'utf8'));
    const firstUpdatedEntry = firstSweep.updated.find((entry) => entry.name === recorded.compiledName);
    t.diagnostic(
      `kill leg: pre-sweep provenance=${JSON.stringify(preSweepArtifact.provenance)} `
      + `post-first-sweep provenance=${JSON.stringify(postFirstSweepArtifact.provenance)} `
      + `updated-entry=${JSON.stringify(firstUpdatedEntry)}`,
    );
    assert.deepEqual(preSweepArtifact.provenance.successRuns, 0);
    assert.deepEqual(preSweepArtifact.provenance.failStreak, 0);
    assert.deepEqual(
      firstUpdatedEntry,
      { name: recorded.compiledName, successRuns: 0, failStreak: 1 },
      'expected the first (live-session) sweep to already count the killed replay as one failed attempt via provenance scanning',
    );
    assert.equal(postFirstSweepArtifact.provenance.successRuns, 0);
    assert.equal(postFirstSweepArtifact.provenance.failStreak, 1);

    // Now let the session actually end (writes meta.endedAt) and sweep
    // again -- the live-session deferral contract's OTHER half: a
    // SUBSEQUENT sweep, once the session is complete, must not double-count
    // whatever the first (live) sweep already counted via provenance
    // scanning (sweep.mjs's own two-cursor model: `provenanceLines` already
    // caught all the way up on the first pass, regardless of whether that
    // pass found zero replay records or one).
    let closeError = null;
    try {
      await killSession.close();
    } catch (error) {
      closeError = error?.message ?? String(error);
    }
    t.diagnostic(`kill leg: killSession.close() ${closeError ? `threw: ${closeError}` : 'succeeded'}`);

    const sessionsAfterClose = await listTraceSessions(paths.dataDir);
    const killTraceSessionAfterClose = sessionsAfterClose.find((session) => path.basename(session.dir) === killBasename);
    assert.equal(
      typeof killTraceSessionAfterClose?.meta?.endedAt,
      'string',
      'expected the kill-leg trace session to now carry a real endedAt after closing',
    );

    const secondSweep = await flows({ sub: 'compile', json: true }, { paths });
    t.diagnostic(`kill leg: second sweep (session now closed) = ${JSON.stringify(secondSweep)}`);

    const secondCursorEntry = secondSweep.cursor[killBasename];
    assert.ok(secondCursorEntry, 'expected the cursor entry to persist across the second sweep');
    assert.equal(
      secondCursorEntry.incomplete,
      undefined,
      'expected the now-closed session to no longer be marked incomplete',
    );
    // Compilation catches up to match provenance now that the session is
    // complete -- both cursors land on the same value, 1, exactly the
    // `provenanceLines >= lines` invariant converging once `lines` is no
    // longer frozen (sweep.mjs's own module doc comment: "both land on the
    // same value" once a session completes).
    assert.deepEqual(
      { lines: secondCursorEntry.lines, provenanceLines: secondCursorEntry.provenanceLines },
      { lines: 1, provenanceLines: 1 },
      'expected compilation to catch up to provenance (both at 1) now that the session has ended',
    );
    assert.deepEqual(secondSweep.compiled, [], 'expected still nothing to compile from a pure-replay session, complete or not');

    const postSecondSweepArtifact = JSON.parse(await readFile(recorded.flowFilePath, 'utf8'));
    assert.deepEqual(
      postSecondSweepArtifact.provenance,
      postFirstSweepArtifact.provenance,
      'expected the SECOND sweep (now that the session has ended) to make no further provenance change -- '
      + 'whatever the FIRST (live) sweep already counted via provenance scanning must not be counted again',
    );
    const secondUpdatedEntry = secondSweep.updated.find((entry) => entry.name === recorded.compiledName);
    assert.equal(
      secondUpdatedEntry,
      undefined,
      "expected the second sweep's own `updated` report to carry NO entry for this flow -- any provenance-affecting "
      + "replay record was already fully consumed by the first (live) sweep's cursor advance",
    );

    t.after(() => rm(outputDir, { recursive: true, force: true }));
  },
);

// --- WS4a Task 6: the encoder harness leg (env-gated) -- the spec's rung-4
// semantic re-bind proof ---
//
// `text-rename-far` ("Place order" -> "Checkout", zero lexical token
// overlap, testid removed) is pinned WITHOUT a key as keyless 'fail' ->
// quarantine (the matrix test above, and profiles.mjs's own doc comment).
// This leg proves the OTHER half: WITH a live Voyage key, `config.encoder:
// "voyage"` makes the encoder ranker CLEAR ENCODER_MIN_SCORE/
// ENCODER_MIN_MARGIN on this same payload where lexical scores far below
// HEAL_MIN_SCORE (the matrix's own "far-rename lexical control" tuning
// line, emitted above, pins the exact lexical numbers this leg's own
// contrast reproduces from a fresh recording).
//
// OBSERVED FINDING (binding -- see the task report for the full write-up):
// this fixture's own two-candidate scene for "Place order" carries a
// SECOND, unrelated button ("Confirm order", from the SAME `showReview()`
// render) that is ALSO a native `<button>` (role bonus applies to both)
// and turns out to be MORE cosine-similar to the target text "Place order"
// under voyage-3.5-lite than the fixture's actual drifted target
// ("Checkout") is -- both candidates individually clear
// ENCODER_MIN_SCORE, and "Confirm order"'s margin over "Checkout" (~0.095)
// clears ENCODER_MIN_MARGIN too, so the encoder ranker deterministically
// (pinned directly, repeatedly, in isolation -- see the report) prefers
// "Confirm order". The mechanism this leg exists to prove -- "the encoder
// clears the gate where lexical cannot" -- holds; it does NOT, for this
// specific fixture pairing, pick the fixture's OWN intended drift target.
// `ENCODER_EXPECTED_SELECTOR` below is the target profiles.mjs actually
// drifted TO (used only for tuning-report `correct` grading, per Shared
// shapes: "judged... against the profile's declared expected selector");
// `OBSERVED_HEALED_SELECTOR` is what the encoder ranker actually,
// reproducibly picks.
//
// A SEPARATE, real-world reliability finding (also in the report): a
// direct Voyage call made WHILE a real browser session is concurrently
// navigating/clicking can occasionally miss its own 5000ms
// `AbortSignal.timeout` budget, silently degrading `flows compile`'s own
// live heal attempt to lexical (heal.mjs's `runRanker` catch -- by
// design, never a crash). This leg's OWN proof does not depend on that
// live call succeeding: the CONTRAST below runs a direct, isolated
// `encoderRanker` call AFTER the browser session has already closed (not
// competing for the same resources), which is what was observed to be
// reliable across every trial -- see `withOneVoyageRetry`'s own doc
// comment for the bounded, non-masking safety margin kept around it
// anyway. The live sweep's own outcome (`firstAttempt.rung`) is therefore
// treated as OBSERVATIONAL below, never a hard requirement.
//
// Own fixture instance, own paths, own recording -- independent of the
// matrix test above (same isolation posture as the Task 5 kill leg): nothing
// here shares on-disk state with any other test in this file.
//
// Gated on BOTH env vars: `voyageKeyConfigured` first (this leg's OWN named
// reason -- the point Task 6's brief asks for), `releaseDirConfigured`
// second (every browser-driving leg in this file needs it) -- named
// distinctly so a keyless `npm run test:drift` reports exactly which
// precondition is missing rather than a generic "skipped".
const encoderLegSkipReason = !voyageKeyConfigured
  ? `${VOYAGE_API_KEY_ENV} is not set; this leg needs a live Voyage key to prove the rung-4 semantic re-bind (source ~/.fast-browser/voyage.env)`
  : (!releaseDirConfigured ? 'FAST_BROWSER_RELEASE_DIR is not set; this leg needs a local runtime' : false);

const ENCODER_EXPECTED_SELECTOR = 'internal:role=button[name="Checkout"i]';
const OBSERVED_HEALED_SELECTOR = 'internal:role=button[name="Confirm order"i]';

test(
  'drift-harness: text-rename-far clears the encoder gate where lexical cannot; the same payload proves both verdicts (rung-4 semantic re-bind)',
  {
    timeout: 300_000,
    skip: encoderLegSkipReason,
  },
  async (t) => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-drift-encoder-'));
    // WS4a Task 6: `pathsForOutputDir` (WS3b Task 10's shared trio) never
    // included `configFile` -- no e2e suite before this task ever needed to
    // configure anything beyond the defaults it reads when absent
    // (`resolveEncoder`'s own tolerant-missing-config posture,
    // lib/commands/flows.mjs). This leg is the first that does: the extra
    // key matches lib/core/paths.mjs's own real `configFile` shape
    // (`path.join(dataDir, 'config.json')`) exactly, so `loadConfig`
    // (lib/core/config.mjs, unmocked -- this leg drives the REAL config
    // read/encoder-resolution path end to end, not a stubbed one) reads it
    // from the same place production would.
    const paths = { ...pathsForOutputDir(outputDir), configFile: path.join(outputDir, 'config.json') };
    await installFlowRunner(paths);
    await writeFile(
      paths.configFile,
      `${JSON.stringify({ ...defaultConfig(), encoder: 'voyage' }, null, 2)}\n`,
      { mode: 0o600 },
    );

    const fixture = await startOrderFixture();
    t.after(() => fixture.close());

    // The plain, four-field recording (no "Confirm order" click -- see
    // `orderFlow` above): `text-rename-far` only ever touches "Place
    // order", so the shorter recording is sufficient and keeps this leg's
    // own real Voyage traffic to exactly what the scenario needs.
    const recorded = await recordAndApprove(t, orderFlow, fixture, paths);
    const golden = JSON.parse(recorded.snapshot.toString('utf8'));
    const placeOrderStepIndex = golden.steps.findIndex(
      (step) => step.op === 'click' && step.target?.name === 'Place order',
    );
    assert.notEqual(placeOrderStepIndex, -1, 'expected a click step targeting "Place order"');

    // --- first replay: fails against the drifted markup; the sweep this
    // same call triggers (`replayOneProfile` -> `flows compile`) resolves
    // `config.encoder: "voyage"` + the real env key into an ACTIVE encoder
    // and threads `encoderRanker(encoder)` into `proposeHeal` for us --
    // this is the real production path (lib/commands/flows.mjs's own
    // `resolveEncoder`/`ranker` wiring), not a hand-built ranker call. ---
    const firstAttempt = await replayOneProfile({
      t, flow: orderFlow, fixture, paths, recorded, profileName: 'text-rename-far',
    });
    t.diagnostic(`encoder leg: first attempt rung=${firstAttempt.rung} evidence=${JSON.stringify(firstAttempt.evidence)}`);

    assert.equal(firstAttempt.evidence.ok, false, 'expected the drifted replay itself to fail outright (the heal is discovered by the SWEEP after it, per classifyReplay\'s own fail-vs-heal doc comment)');
    assert.ok(
      typeof firstAttempt.evidence.error === 'string' && firstAttempt.evidence.error.startsWith('FLOW_RUNNER_FAILURE: '),
      `expected a FLOW_RUNNER_FAILURE error string: ${firstAttempt.evidence.error}`,
    );

    const firstPayload = parseFailurePayload(firstAttempt.evidence.error);
    assert.ok(firstPayload, 'expected a parseable FLOW_RUNNER_FAILURE payload');
    const checkoutCandidate = firstPayload.candidates.find((candidate) => candidate.text === 'Checkout');
    assert.ok(checkoutCandidate, `expected a candidate carrying the drifted "Checkout" text: ${JSON.stringify(firstPayload.candidates)}`);
    assert.equal(checkoutCandidate.role, 'button', 'expected the derived native-button role on the drifted candidate');

    // Task 7: sweep's own `warnings` surface (`{ kind: 'encoder-degraded',
    // reason }` entries, lib/flows/sweep.mjs's `warningTrackingRanker`) now
    // ships, so this leg's own OBSERVATIONAL branch (see the doc comment
    // above and the task report -- the live sweep's own encoder call is
    // made concurrently with a real browser session and can occasionally
    // miss its own timeout budget, degrading to lexical) is asserted
    // EXHAUSTIVELY rather than inferred from `rung` alone: EITHER this
    // replay's sweep reported a warning naming the degrade-to-lexical
    // reason (rung stays 'fail' -- lexical cannot clear its own threshold
    // on this zero-token-overlap payload), OR it healed with the OBSERVED
    // selector -- never neither (a silent third outcome would mean this
    // leg stopped covering what it claims to), never both (a warning would
    // mean the ranker never actually ran, contradicting a heal that
    // required it to).
    const sweepWarnedDegraded = firstAttempt.warnings.some((warning) => warning.kind === 'encoder-degraded');
    const healedThisAttempt = firstAttempt.evidence.healed.length === 1;
    assert.notEqual(
      sweepWarnedDegraded,
      healedThisAttempt,
      `expected exactly one of {sweep warned encoder-degraded, this replay healed}, got warned=${sweepWarnedDegraded} healed=${healedThisAttempt} (warnings=${JSON.stringify(firstAttempt.warnings)})`,
    );

    // Review round 1 (Important 3), folded re-review minor: pin the
    // INERTNESS itself, not just `ok: true`, via a completely independent,
    // real HTTP-level signal -- Task 5's own kill-test instrumentation
    // (`fixture.setKillTest` + `GET /order/count`), reused here for a
    // different purpose than the kill leg's own at-most-once proof.
    // Armed ONCE, BEFORE either branch below runs any replay -- the
    // re-review minor found the original draft only enabled this inside
    // the 'heal' branch, silently skipping the inertness pin on a degrade
    // run; arming it unconditionally here means the `/order/count`
    // assertion after the branch below covers BOTH outcomes uniformly.
    // Enabling it makes the fixture's delegated `app`-level click listener
    // attempt a real `POST /order` whenever the CLICKED element's `id` is
    // exactly "place-order" -- honest caveat: under `text-rename-far`
    // NEITHER candidate carries that id at all ("Confirm order" has
    // `id="confirm-order"`; the drifted "Checkout" button has no id --
    // that is literally what this profile drifts, per profiles.mjs's own
    // doc comment), so this counter cannot distinguish "clicked the wrong
    // button" from "clicked the right one" for this specific profile -- it
    // structurally cannot fire for EITHER. What it still proves: a
    // completely separate, out-of-band, server-side signal confirms
    // neither this leg's first attempt (a locator-resolution failure that
    // never reached a click) nor whatever follows below ever triggered a
    // real mutating action, not merely that flow-runner's own step
    // resolved without throwing.
    const KILL_TEST_TOKEN = 'encoder-leg-wrong-target-probe';
    fixture.setKillTest({ token: KILL_TEST_TOKEN, stall: false });

    if (healedThisAttempt) {
      assert.equal(firstAttempt.evidence.healed[0].stepIndex, placeOrderStepIndex);
      assert.equal(firstAttempt.evidence.healed[0].kind, 'other');

      const healedOnDisk = JSON.parse(await readFile(recorded.flowFilePath, 'utf8'));
      const healedLocators = healedOnDisk.steps[placeOrderStepIndex].target.locators;
      const appendedLocator = healedLocators[healedLocators.length - 1];
      // OBSERVED (pinned, not the fixture's intended target -- see this
      // leg's own doc comment above): the live sweep healed to the SAME
      // candidate the isolated contrast below deterministically ranks
      // first.
      assert.deepEqual(appendedLocator, { kind: 'other', selector: OBSERVED_HEALED_SELECTOR });
      assert.deepEqual(healedLocators.slice(0, -1), golden.steps[placeOrderStepIndex].target.locators);

      // --- second replay: the SAME (never-restored) on-disk artifact, now
      // carrying the healed alternate. OBSERVED: `ok: true` -- but this is
      // NOT a functional success (see the task report): clicking "Confirm
      // order" has no handler at all in this fixture (index.html only
      // wires a click listener onto whichever button `showReview()`
      // inserted LAST, "Checkout" here); the recording's own `browser_
      // wait_for({ text: 'Order complete' })` step never becomes a
      // compiled artifact step at all (lib/flows/compile.mjs: a
      // text-only, non-timed `browser_wait_for` is observation-only and
      // compiles to NO step), so nothing in the REPLAYED artifact ever
      // actually checks that the order completed -- the replay reports
      // success purely because the click resolved and threw nothing.
      const secondAttempt = await replayOneProfile({
        t, flow: orderFlow, fixture, paths, recorded, profileName: 'text-rename-far', restore: false,
      });
      t.diagnostic(`encoder leg: second attempt (OBSERVED "success" is NOT functional -- see doc comment) rung=${secondAttempt.rung} evidence=${JSON.stringify(secondAttempt.evidence)}`);
      assert.equal(secondAttempt.evidence.ok, true);
      assert.deepEqual(secondAttempt.evidence.healed, [], 'expected no NEW heal on the second replay (idempotence: the locator is already present)');
    } else {
      assert.equal(firstAttempt.rung, 'fail', 'expected the degrade-to-lexical branch to leave this replay unhealed (rung "fail")');
      t.diagnostic(`encoder leg: OBSERVED -- the live sweep's own encoder call degraded to lexical this run (warnings=${JSON.stringify(firstAttempt.warnings)}); the isolated contrast below is this leg's hard proof and does not depend on this branch`);
    }

    const countResponse = await fetch(`${fixture.origin}/order/count?token=${encodeURIComponent(KILL_TEST_TOKEN)}`);
    const { count: orderCount } = await countResponse.json();
    t.diagnostic(`encoder leg: /order/count after this leg's replay(s) = ${orderCount}`);
    assert.equal(
      orderCount,
      0,
      'expected no real mutating action to have been submitted by this leg\'s replay(s) (heal-branch wrong-target click, or a degrade-branch locator-resolution failure), confirmed via the fixture\'s own independent HTTP-level mutation counter',
    );

    // --- the lexical contrast: the SAME captured payload, two verdicts ---
    //
    // `proposeHeal({ flow: golden, payload })` (lexical default, no
    // network) against the identical evidence the live sweep above just
    // saw -- proves the encoder is what clears the gate, not some other
    // change in the payload between calls.
    const lexicalContrastDecision = proposeHeal({ flow: golden, payload: firstPayload });
    assert.equal(lexicalContrastDecision, null, 'expected the lexical default to reject this zero-token-overlap payload');

    // The encoder-backed ranker's own call (lib/flows/encoder.mjs) -- ONE
    // real, ISOLATED Voyage round trip (the browser session above has
    // already closed by this point -- see this leg's own doc comment on
    // why this call, unlike the live sweep's, is the reliable one):
    // `ranker(...)` is called directly here (not a second `proposeHeal`
    // pass with a fresh ranker instance) so its raw `[{index, score}]`
    // result can feed BOTH this contrast's decision AND the tuning-report
    // line below without a second network call for the same evidence.
    //
    // Review round 1 (Important 2): the encoder is resolved through the
    // REAL config chain -- `loadConfig(paths)` reads the harness dataDir's
    // own `config.json` this test wrote at the top (not a hand-built
    // `{ encoder: 'voyage' }` literal) -- so this leg's own config write
    // is genuinely load-bearing for the contrast too, not just for the
    // live sweep above: a no-op config write (or a bug that silently
    // wrote 'lexical') would fail the `encoder.kind` assertion immediately
    // below rather than passing unnoticed.
    const loadedConfig = await loadConfig(paths);
    const encoder = createEncoder({ config: loadedConfig, env: process.env });
    assert.equal(encoder.active, true, 'expected the harness dataDir config write to resolve to an ACTIVE encoder');
    assert.equal(encoder.kind, 'voyage', 'expected the harness dataDir config write to resolve to the voyage encoder specifically');
    const ranker = encoderRanker(encoder);
    const contrastTarget = targetForFailedStep(golden, firstPayload);
    const contrastRanked = await withOneVoyageRetry(
      () => ranker({ target: contrastTarget, candidates: firstPayload.candidates }),
    );
    t.diagnostic(`encoder leg: contrast ranked=${JSON.stringify(contrastRanked)}`);

    // A synchronous stub carrying `contrastRanked` plus the real ranker's
    // own thresholds -- `proposeHeal`'s `runRanker` treats a synchronous
    // return identically to a synchronous ranker call (see heal.mjs's own
    // doc comment), so this reaches the exact same acceptance/synthesis
    // code path `ranker: ranker` itself would, with zero extra network
    // traffic for a result already in hand.
    const encoderStub = () => contrastRanked;
    encoderStub.minScore = ranker.minScore;
    encoderStub.minMargin = ranker.minMargin;
    const encoderContrastDecision = proposeHeal({ flow: golden, payload: firstPayload, ranker: encoderStub });
    assert.ok(encoderContrastDecision, 'expected the encoder-backed ranker to find a decision on the SAME payload lexical rejected -- the rung-4 gate-clearing proof');
    assert.equal(encoderContrastDecision.locator.kind, 'other');
    // OBSERVED, pinned exactly (see this leg's own doc comment): the
    // fixture's OWN "Confirm order" button, not its intended "Checkout"
    // drift target.
    assert.equal(encoderContrastDecision.locator.selector, OBSERVED_HEALED_SELECTOR);

    // --- tuning-report emission: both rankers, this leg's own payload ---
    const lexicalContrastRanked = rankCandidates({ target: contrastTarget, candidates: firstPayload.candidates });
    await recordTuningLine(tuningLineFor({
      profile: 'text-rename-far',
      flowName: orderFlow.name,
      rankerName: 'lexical',
      ranked: lexicalContrastRanked,
      minScore: HEAL_MIN_SCORE,
      minMargin: HEAL_MIN_MARGIN,
      flow: golden,
      payload: firstPayload,
      expectedSelector: ENCODER_EXPECTED_SELECTOR,
    }));
    await recordTuningLine(tuningLineFor({
      profile: 'text-rename-far',
      flowName: orderFlow.name,
      rankerName: 'voyage',
      ranked: contrastRanked,
      minScore: ranker.minScore,
      minMargin: ranker.minMargin,
      flow: golden,
      payload: firstPayload,
      expectedSelector: ENCODER_EXPECTED_SELECTOR,
    }));

    t.after(() => rm(outputDir, { recursive: true, force: true }));
  },
);

// --- WS4a Task 6: the tuning-report aggregate -- always runs, regardless
// of gate state (the point: `npm run test:drift` prints whatever tuning
// data THIS run actually collected, keyless or keyed, never skipping the
// print itself). Declared LAST: `node:test` runs this file's top-level
// tests sequentially in declaration order, so every earlier test's own
// `recordTuningLine` calls have already landed in `TUNING_LINES` (and
// `TUNING_REPORT_PATH`) by the time this one starts. ---
test('drift-harness: tuning-report aggregate (prints whatever this run collected)', async () => {
  // Expected line-count RANGE given this run's own gate state -- see the
  // per-test comments above for the accounting. Required (always land
  // when their gate is open, never caught/skipped): the matrix test's 3
  // lexical-only lines (testid-rename, text-rename-near, the far-rename
  // control), always emitted when `releaseDirConfigured`; the encoder
  // leg's own 2 contrast lines (lexical + voyage), always emitted when
  // BOTH gates are open (that contrast is this leg's hard proof, not
  // optional -- see its own doc comment). Optional (additive, "voyage
  // only when keyed", caught-and-skipped on a transient failure per
  // `emitHealPathTuningLines`'s own try/catch): up to 2 more voyage rows
  // from the matrix's own testid-rename/text-rename-near legs. A count
  // outside this range means either a required line silently failed to
  // land, or MORE lines landed than this run's own env allows for --
  // either way, exactly the kind of silent under/over-collection Task 7
  // needs this pin to catch.
  const requiredLineCount = !releaseDirConfigured ? 0 : (voyageKeyConfigured ? 5 : 3);
  const optionalLineCount = releaseDirConfigured && voyageKeyConfigured ? 2 : 0;
  assert.ok(
    TUNING_LINES.length >= requiredLineCount && TUNING_LINES.length <= requiredLineCount + optionalLineCount,
    `expected between ${requiredLineCount} and ${requiredLineCount + optionalLineCount} tuning lines given `
    + `releaseDirConfigured=${releaseDirConfigured} voyageKeyConfigured=${voyageKeyConfigured}, `
    + `got ${TUNING_LINES.length}: ${JSON.stringify(TUNING_LINES)}`,
  );

  if (TUNING_LINES.length > 0) {
    const persistedRaw = await readFile(TUNING_REPORT_PATH, 'utf8');
    const persisted = persistedRaw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(persisted, TUNING_LINES, 'expected the scratch JSONL file to round-trip the exact lines collected in-process');
  }

  printTuningAggregate(TUNING_LINES);

  await rm(TUNING_SCRATCH_DIR, { recursive: true, force: true });
});
