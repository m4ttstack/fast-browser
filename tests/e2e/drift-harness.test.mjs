import assert from 'node:assert/strict';
import {
  mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { flows } from '../../lib/commands/flows.mjs';
import { sites } from '../../lib/commands/sites.mjs';
import { QUARANTINE_FAIL_STREAK_THRESHOLD } from '../../lib/flows/match.mjs';
import { startOrderFixture } from '../fixtures/order-flow/server.mjs';
import {
  classifyReplay, recordAndApprove, replayArgsFor, replayOneProfile, runHarness,
} from './helpers/drift-harness.mjs';
import { installFlowRunner, pathsForOutputDir } from './helpers/flow-fixtures.mjs';

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
    const confirmOrderStepIndex = golden.steps.findIndex(
      (step) => step.op === 'click' && step.target?.name === 'Confirm order',
    );
    const placeOrderStepIndex = golden.steps.findIndex(
      (step) => step.op === 'click' && step.target?.name === 'Place order',
    );
    assert.notEqual(confirmOrderStepIndex, -1, 'expected a click step targeting "Confirm order"');
    assert.notEqual(placeOrderStepIndex, -1, 'expected a click step targeting "Place order"');

    async function replayLeg(profileName) {
      const entry = await replayOneProfile({
        t, flow: matrixFlow, fixture, paths, recorded, profileName,
      });
      t.diagnostic(`${profileName}: rung=${entry.rung} evidence=${JSON.stringify(entry.evidence)} provenance=${JSON.stringify(entry.provenance)}`);
      return entry;
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

    // --- delayed-render: CORRECTED expectation (Task 3's review ledger,
    // constraint 3 -- reality governs over the plan's draft table).
    // profiles.mjs's own doc comment (WS4a Task 4 correction) has the full
    // write-up: rung 1's probe walks a step's candidates SEQUENTIALLY,
    // each with its OWN 1500ms `waitFor`, so a two-candidate step (role
    // index 0, css index 1 -- every plain button here) gets up to ~3000ms
    // of effective rung-1 budget before falling through to rung 2's
    // escalated pass at all. The 2000ms render lands inside that window,
    // via the non-primary css candidate -- 'fallback', a NON-escalated
    // recovery, never reaching rung 2.
    const delayedRender = await replayLeg('delayed-render');
    assert.equal(delayedRender.rung, 'fallback');
    assert.deepEqual(delayedRender.evidence.healed, []);
    assert.equal(delayedRender.evidence.dismissCount, 0);
    assert.deepEqual(delayedRender.evidence.escalatedFallbacks, [], 'expected the recovery to stay within rung 1, never reaching the escalated pass');
    assert.equal(delayedRender.evidence.fallbacks.length, 1);
    assert.equal(delayedRender.evidence.fallbacks[0].usedKind, 'css');
    assert.equal(delayedRender.evidence.fallbacks[0].usedIndex, 1);
    assert.equal(delayedRender.evidence.ok, true);

    // --- banner-hides: constraint 1's own fixture -- the fixture-side
    // `window.__consentDismissClicks__` counter (this task's own addition
    // to index.html) is what turns this leg's recovery into a countable
    // 'quirk', not the escalated-fallback-only 'escalated' the mechanism
    // would otherwise classify as (see index.html's and drift-harness.mjs's
    // own doc comments). The recovery still also leaves an escalated
    // fallback entry on the "Start order" step (the probe-miss path, per
    // healing.test.mjs's own overlay leg) -- both are true at once;
    // classifyReplay's own precedence (quirk beats escalated) is what
    // resolves that to a single rung.
    const bannerHides = await replayLeg('banner-hides');
    assert.equal(bannerHides.rung, 'quirk');
    assert.equal(bannerHides.evidence.dismissCount, 1);
    assert.deepEqual(bannerHides.evidence.healed, []);
    assert.equal(bannerHides.evidence.ok, true);
    assert.ok(bannerHides.evidence.escalatedFallbacks.length >= 1, 'expected the probe-miss recovery to also leave an escalated fallback entry');

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
