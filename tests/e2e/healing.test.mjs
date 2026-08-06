import assert from 'node:assert/strict';
import {
  mkdtemp, readFile, rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { flows } from '../../lib/commands/flows.mjs';
import { sites } from '../../lib/commands/sites.mjs';
import { flowFileName, flowId } from '../../lib/flows/artifact.mjs';
import { startOrderFixture } from '../fixtures/order-flow/server.mjs';
import {
  installFlowRunner, pathsForOutputDir, tracedSession,
} from './helpers/flow-fixtures.mjs';

// The healing e2e (WS3a plan, Task 9): the workstream's acceptance test.
// Proves the whole rung 1-3 + host-side heal loop end to end against a real
// browser and a real replay: record -> approve -> drift -> fail with
// evidence -> sweep heals -> replay succeeds -> quirks dismiss interrupts.
//
// --- drift mechanism (documented per the task brief's instruction) ---
//
// A compiled flow's `goto` step replays against the flow's RECORDED path
// ('/'), verbatim -- flow-runner.js's precondition/goto navigation has no
// way to carry a caller-supplied query string, so `?variant=drifted` on the
// URL is a non-starter (the brief's own note). Drift and the consent
// overlay are instead driven by tests/fixtures/order-flow/server.mjs's
// `setVariant`, an in-process toggle: which markup the SAME path ('/')
// serves on the next request. This is a plain function call, not an admin
// HTTP endpoint or an env var -- there is no extra network round trip, and
// the toggle lives entirely in the fixture module (test-side only).
//
// Only ONE element's markup differs between the 'base' and 'drifted'
// variants: the "Place order" button. Every other interactive element (and
// the 'overlay' variant, which is 'base' markup plus a consent banner) is
// byte-identical to today's fixture -- deliberately, so
// tests/e2e/sites.test.mjs's pinned locator-kind assertions (mined from a
// 'base'-variant recording) are never at risk from this change. 'drifted'
// swaps that one button from a native <button id="place-order"> to an
// <a class="order-action" data-testid="submit-v2"> with no id: this breaks
// BOTH locator kinds a plain button records (its native "button" ARIA role,
// and its id-based css selector) while leaving the element's visible text
// ("Place order") untouched, which is what keeps heal.mjs's lexical
// candidate ranking (token overlap against the target's recorded NAME)
// scoring it highly. Per Task 5's binding review note, a heal only fires
// reliably through `data-testid` -- candidate collection reads the raw
// `role`/`aria-label` ATTRIBUTES only, never Playwright's own computed
// role/accessible-name -- so the drifted element's `data-testid` is what
// actually drives the heal; the healed alternate is expected to be kind
// 'testid', selector `internal:testid=[data-testid="submit-v2"]`.
//
// The 'overlay' variant adds a full-page consent banner (`#consent-accept`)
// that must be dismissed before the FIRST step ("Start order") can proceed.
// It genuinely fails flow-runner's locator PROBE (not just the click
// action): the underlying #app is held `visibility: hidden` while the
// banner is up, and only made `visibility: visible` again once
// `#consent-accept` is clicked. This -- not just stacking the banner on top
// with a higher z-index -- is what's required to make flow-runner's probe
// actually MISS: `Locator#waitFor({state: 'visible'})` (what
// `resolveTarget`/`resolveEscalated` call at every rung) checks bounding-box
// and CSS visibility only; it does not perform Playwright's separate
// "receives pointer events" hit-target check (that's an action-specific
// actionability condition, only ever applied inside `.click()` itself, and
// even there it fires only for the exact element the locator already
// resolved to -- it never demotes a covered-but-CSS-visible element back
// into "not found"). A purely visual overlay would leave the underlying
// button "visible" by Playwright's own definition, the probe would resolve
// it on the very first pass, and rung 3 (quirk dismissal) would never have
// anything to recover from.

// `pathsForOutputDir`/`installFlowRunner`/`tracedSession` are the shared
// e2e flow-fixture trio (Task 10, WS3b) -- see
// tests/e2e/helpers/flow-fixtures.mjs's own doc comment for the shape/
// rationale; this file, flows.test.mjs, and sites.test.mjs all import the
// same implementation now, no per-file copies.

// Runs the order-flow recording script (flows.test.mjs/sites.test.mjs's
// script, verbatim) against whatever variant the fixture is currently
// serving. Only ever used against the 'base' variant here (the recording
// itself must capture the ORIGINAL, undrifted markup) -- kept as a function
// rather than inlined once because it's this file's own step 1.
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

// Mirrors flows.test.mjs's `assertOrderComplete`: two `browser_find` text
// searches (never compiled into a step -- no TOOL_OPS entry for
// browser_find), each asserted to match exactly once.
async function assertOrderComplete(session, orderId) {
  const headingFind = await session.callTool('browser_find', { text: 'Order complete' });
  assert.ok(headingFind.startsWith('Found 1 match for "Order complete":'), headingFind);
  const orderIdFind = await session.callTool('browser_find', { text: orderId });
  assert.ok(orderIdFind.startsWith(`Found 1 match for "${orderId}":`), orderIdFind);
}

function orderId({ customerName, plan, seats }) {
  return `${customerName.trim().toUpperCase()}-${plan.toUpperCase()}-${seats}`;
}

// Builds a replay call's arguments from a `flows find` invocation, swapping
// in real arg values for the invocation's `<REQUIRED: string>` placeholders
// -- same shape flows.test.mjs's own replay step builds by hand.
function replayArgsFor(invocation, argValues) {
  return {
    ...invocation.arguments,
    args: { ...invocation.arguments.args, args: argValues },
  };
}

// Parses the `FLOW_RUNNER_FAILURE: <json>` payload out of a rejected
// callTool's error message -- mirrors flows.test.mjs's own inline parsing
// (step 7 there), factored out here since this file parses it twice (the
// drifted-locator-miss leg, and to prove nothing analogous happens on the
// quirk-recovered leg).
function parseFlowRunnerFailure(error) {
  const prefix = 'FLOW_RUNNER_FAILURE: ';
  const markerIndex = error.message.indexOf(prefix);
  assert.notEqual(markerIndex, -1, `expected "${prefix}" in error message: ${error.message}`);
  return JSON.parse(error.message.slice(markerIndex + prefix.length));
}

// `seats` stays '7' in every leg: it's a single-character literal, and
// compile.mjs's own lift filter (`liftLiteral`) never lifts literals under
// 2 characters, so it's never parameterized into the flow's `args` -- the
// runtime always fills the same literal regardless of what's passed here.
// It's still carried on each of these objects (harmless as an extra,
// runtime-ignored key in `replayArgsFor`'s `args` payload) purely so this
// file's own local `orderId()` helper can compute the expected order id
// for each leg's `assertOrderComplete` check.
const RECORDED = { customerName: 'Ada', plan: 'team', seats: '7' };
const DRIFT_FAIL_ARGS = { customerName: 'Grace', plan: 'scale', seats: '7' };
const HEALED_REPLAY = { customerName: 'Nora', plan: 'scale', seats: '7' };
const QUIRK_REPLAY = { customerName: 'Milo', plan: 'starter', seats: '7' };

test('healing: drift heals from failure evidence and quirks dismiss interrupts', async (t) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-healing-'));
  const paths = pathsForOutputDir(outputDir);
  await installFlowRunner(paths);

  const fixture = await startOrderFixture();
  t.after(fixture.close);

  // --- 1. record (BASE variant), compile, approve ---
  const recorder = await tracedSession(t, outputDir);
  await recordOrderFlow(recorder, fixture.origin, RECORDED);
  await assertOrderComplete(recorder, orderId(RECORDED));
  await recorder.close();

  const compileReport = await flows({ sub: 'compile', json: true }, { paths });
  assert.equal(compileReport.compiled.length, 1);
  const { name: flowName, tier: compiledTier } = compileReport.compiled[0];
  assert.equal(compiledTier, 'pending');

  const approveReport = await flows(
    { sub: 'approve', name: flowName, json: false },
    {
      paths, interactive: true, confirmApprove: async () => true, print: () => {},
    },
  );
  assert.deepEqual(approveReport, {
    command: 'flows', sub: 'approve', name: flowName, moved: true,
  });

  const findRequest = {
    sub: 'find', intent: 'place an order', origin: fixture.origin, url: null, json: true,
  };
  const firstFind = await flows(findRequest, { paths });
  assert.equal(firstFind.candidates.length, 1);
  const firstCandidate = firstFind.candidates[0];
  assert.equal(firstCandidate.runnable, true);
  assert.deepEqual(firstCandidate.invocation.arguments.args.quirks, []);
  const approvedInvocation = firstCandidate.invocation;
  const approvedFlow = approvedInvocation.arguments.args.flow;

  const placeOrderStepIndex = approvedFlow.steps.findIndex(
    (step) => step.op === 'click' && step.target?.name === 'Place order',
  );
  assert.notEqual(placeOrderStepIndex, -1, 'expected a click step targeting "Place order"');
  const startOrderStepIndex = approvedFlow.steps.findIndex(
    (step) => step.op === 'click' && step.target?.name === 'Start order',
  );
  assert.notEqual(startOrderStepIndex, -1, 'expected a click step targeting "Start order"');

  // --- 2. replay against the DRIFTED variant -> FLOW_RUNNER_FAILURE, whose
  // payload carries candidate evidence including the renamed testid. ---
  fixture.setVariant('drifted');
  const failSession = await tracedSession(t, outputDir);
  let failurePayload;
  await assert.rejects(
    failSession.callTool(
      approvedInvocation.tool,
      replayArgsFor(approvedInvocation, DRIFT_FAIL_ARGS),
    ),
    (error) => {
      failurePayload = parseFlowRunnerFailure(error);
      return true;
    },
  );
  await failSession.close();
  t.diagnostic(`drifted-replay failure payload: ${JSON.stringify(failurePayload)}`);

  assert.equal(failurePayload.failedStep, placeOrderStepIndex);
  assert.equal(failurePayload.error, 'no locator candidate matched');
  assert.equal(failurePayload.stepsCompleted, placeOrderStepIndex);
  assert.ok(Array.isArray(failurePayload.candidates), 'expected candidate evidence on a locator-miss failure');
  const testidCandidate = failurePayload.candidates.find((candidate) => candidate.testid === 'submit-v2');
  assert.ok(testidCandidate, `expected a candidate carrying testid "submit-v2": ${JSON.stringify(failurePayload.candidates)}`);
  assert.equal(testidCandidate.text, 'Place order');

  // --- 3. sweep -> heal: report.healed names the flow and step; the
  // on-disk artifact (still in the ready tier) has the appended testid
  // alternate LAST, a recomputed id matching its own content, and
  // provenance.lastHealed set. ---
  const healSweep = await flows({ sub: 'compile', json: true }, { paths });
  assert.deepEqual(healSweep.compiled, []);
  assert.deepEqual(healSweep.updated, [{ name: flowName, successRuns: 0, failStreak: 1 }]);
  assert.deepEqual(healSweep.healed, [{ name: flowName, stepIndex: placeOrderStepIndex, kind: 'testid' }]);
  assert.deepEqual(healSweep.healErrors, []);

  const healedFlowPath = path.join(paths.flowsDir, flowFileName({ name: flowName }));
  const healedFlow = JSON.parse(await readFile(healedFlowPath, 'utf8'));
  const healedLocators = healedFlow.steps[placeOrderStepIndex].target.locators;
  const appendedLocator = healedLocators[healedLocators.length - 1];
  assert.deepEqual(appendedLocator, { kind: 'testid', selector: 'internal:testid=[data-testid="submit-v2"]' });
  // The heal is purely additive: every locator the base recording captured
  // is still present, ahead of the appended alternate.
  assert.deepEqual(healedLocators.slice(0, -1), approvedFlow.steps[placeOrderStepIndex].target.locators);

  assert.equal(healedFlow.id, flowId(healedFlow));
  assert.notEqual(healedFlow.id, approvedFlow.id);
  assert.equal(typeof healedFlow.provenance.lastHealed, 'string');
  assert.ok(!Number.isNaN(Date.parse(healedFlow.provenance.lastHealed)), 'lastHealed must be a valid ISO string');

  const listAfterHeal = await flows({ sub: 'list', json: true }, { paths });
  const listedAfterHeal = listAfterHeal.flows.find((entry) => entry.name === flowName);
  assert.equal(listedAfterHeal.tier, 'ready');
  assert.equal(listedAfterHeal.lastHealed, healedFlow.provenance.lastHealed);

  // --- 4. replay again against the DRIFTED variant -> ok: true, the healed
  // alternate is what found it (a fresh `find` picks up the just-healed
  // on-disk artifact, exactly as a real agent's next call would). ---
  const secondFind = await flows(findRequest, { paths });
  const healedInvocation = secondFind.candidates[0].invocation;
  assert.equal(healedInvocation.arguments.args.flow.id, healedFlow.id);

  const healedSession = await tracedSession(t, outputDir);
  const healedReplayResult = await healedSession.callTool(
    healedInvocation.tool,
    replayArgsFor(healedInvocation, HEALED_REPLAY),
  );
  t.diagnostic(`healed-replay result: ${JSON.stringify(healedReplayResult)}`);
  assert.equal(healedReplayResult.ok, true);
  assert.deepEqual(healedReplayResult.result, { completed: true });
  assert.equal(healedReplayResult.locatorFallbacks.length, 1);
  const healedFallback = healedReplayResult.locatorFallbacks[0];
  assert.equal(healedFallback.step, placeOrderStepIndex);
  assert.equal(healedFallback.usedKind, 'testid');
  assert.equal(healedFallback.usedIndex, healedLocators.length - 1);
  await assertOrderComplete(healedSession, orderId(HEALED_REPLAY));
  await healedSession.close();

  // --- 5. sweep -> successRuns incremented, failStreak reset. ---
  const secondSweep = await flows({ sub: 'compile', json: true }, { paths });
  assert.deepEqual(secondSweep.compiled, []);
  assert.deepEqual(secondSweep.healed, []);
  assert.deepEqual(secondSweep.updated, [{ name: flowName, successRuns: 1, failStreak: 0 }]);

  // --- 6. quirk leg: `sites quirk add` records a dismissal for the consent
  // overlay's own accept button; replaying the SAME (already-healed) flow
  // against the OVERLAY variant succeeds, with the runner's own recovery
  // observable via `locatorFallbacks` (an `escalated: true` entry for the
  // interrupted step) -- pinned per the brief's step 6 note: on a
  // successful quirk recovery the tool call returns the ordinary SUCCESS
  // shape (`{ ok, result, stepsRun, locatorFallbacks, ms }`); `
  // quirkAttempted` only ever appears inside the FAILURE payload
  // (flow-runner.js's own `fail()` call sites), so it is asserted ABSENT
  // here, not merely unread. ---
  const quirkAdded = await sites(
    {
      sub: 'quirk',
      verb: 'add',
      name: 'consent-accept',
      origin: fixture.origin,
      selector: '#consent-accept',
      description: 'Dismiss the consent overlay',
      urlPattern: null,
      json: true,
    },
    { paths, now: () => new Date('2026-08-05T00:00:00.000Z') },
  );
  assert.equal(quirkAdded.quirk.name, 'consent-accept');
  assert.equal(quirkAdded.quirk.action, 'click');

  const quirkFind = await flows(findRequest, { paths });
  const quirkCandidate = quirkFind.candidates[0];
  assert.deepEqual(quirkCandidate.invocation.arguments.args.quirks, [{
    name: 'consent-accept',
    urlPattern: null,
    target: { locators: [{ kind: 'css', selector: '#consent-accept' }] },
    action: 'click',
  }]);

  fixture.setVariant('overlay');
  const overlaySession = await tracedSession(t, outputDir);
  const overlayResult = await overlaySession.callTool(
    quirkCandidate.invocation.tool,
    replayArgsFor(quirkCandidate.invocation, QUIRK_REPLAY),
  );
  t.diagnostic(`overlay-replay result: ${JSON.stringify(overlayResult)}`);
  assert.equal(overlayResult.ok, true);
  assert.deepEqual(overlayResult.result, { completed: true });
  assert.equal(Object.hasOwn(overlayResult, 'quirkAttempted'), false);
  assert.deepEqual(overlayResult.locatorFallbacks, [
    {
      step: startOrderStepIndex, usedKind: 'role', usedIndex: 0, escalated: true,
    },
  ]);
  await assertOrderComplete(overlaySession, orderId(QUIRK_REPLAY));
  await overlaySession.close();

  // Bonus (not a separate scenario step, but cheap and closes the loop
  // fully): a final sweep proves THIS replay counted too -- the same flow,
  // now with two successful replays behind it.
  const thirdSweep = await flows({ sub: 'compile', json: true }, { paths });
  assert.deepEqual(thirdSweep.updated, [{ name: flowName, successRuns: 2, failStreak: 0 }]);

  // --- hygiene: best-effort outputDir cleanup, registered LAST so it runs
  // LAST (node:test runs t.after hooks FIFO; every session/fixture close is
  // registered earlier, above). ---
  t.after(() => rm(outputDir, { recursive: true, force: true }));
});

// --- WS3b Task 10: role-heal leg ---
//
// Closes the WS3a carry-forward the module doc comment (and heal.mjs's own
// Task 5/8 comments) name: a heal that only ever fires through
// `data-testid` is not the healing efficacy Tasks 5/8 shipped. This leg
// proves the OTHER path end to end: a plain `<button>` with NO
// `data-testid` -- collectCandidates derives its role from the tag alone
// (`deriveImplicitRole`), and heal.mjs's `synthesizeLocator` mints a
// `kind: 'other'` `internal:role=...[name="..."i]` alternate from that
// derived role plus the candidate's visible text, per Task 8's `name ??
// text` widening.
//
// Deliberately a SEPARATE recorded flow (own fixture instance, own
// outputDir) from the test above, not a second scenario grafted onto it:
// this keeps the two heal paths' evidence independent (this leg's
// candidates must show NO `testid`, proving the kind:'testid' path never
// even entered the running) and keeps every assertion above completely
// unmodified.
//
// --- drift mechanism ---
//
// tests/fixtures/order-flow/index.html's own doc comment (above
// `showReview`) has the full write-up, including why hiding the element
// (e.g. `aria-hidden`) does NOT work here (it defeats the healed locator
// exactly as it defeats the original one -- both resolve through the same
// role+accessible-name query engine). In short: the 'role-drifted' variant
// changes ONLY the "Confirm order" button (present, byte-identical, in
// every OTHER variant including 'base') -- it drops the button's `id` (its
// recorded css locator misses) and rewords its text from "Confirm order"
// to "Confirm your order" (inserting a word mid-string defeats
// `getByRole`'s default substring name matching against the ORIGINALLY
// recorded name, while still leaving both words as distinct tokens for
// heal.mjs's lexical ranker). The button stays a bare native `<button>`
// (no `role`/`aria-label` attribute), so `collectCandidates` still derives
// its role as 'button' from the tag alone and reads its CURRENT text
// ("Confirm your order") raw -- exactly the evidence
// `synthesizeLocator` needs to mint a role+text alternate that resolves
// against the CURRENT page, unlike the stale, now-mismatched original.

// Runs the order-flow recording script WITH one extra step recordOrderFlow
// above never takes: a click on the plain "Confirm order" button, right
// before "Place order". Only ever used against the 'base' variant (the
// recording itself must capture the ORIGINAL, undrifted "Confirm order"
// markup).
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

const ROLE_HEAL_RECORDED = {
  customerName: 'Priya', plan: 'team', seats: '7',
};
const ROLE_HEAL_FAIL_ARGS = {
  customerName: 'Sam', plan: 'scale', seats: '7',
};
const ROLE_HEAL_REPLAY = {
  customerName: 'Talia', plan: 'starter', seats: '7',
};

test('healing: a plain button with no data-testid heals from derived role and text', async (t) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-role-heal-'));
  const paths = pathsForOutputDir(outputDir);
  await installFlowRunner(paths);

  const fixture = await startOrderFixture();
  t.after(fixture.close);

  // --- 1. record (BASE variant), compile, approve ---
  const recorder = await tracedSession(t, outputDir);
  await recordOrderFlowWithConfirmation(recorder, fixture.origin, ROLE_HEAL_RECORDED);
  await assertOrderComplete(recorder, orderId(ROLE_HEAL_RECORDED));
  await recorder.close();

  const compileReport = await flows({ sub: 'compile', json: true }, { paths });
  assert.equal(compileReport.compiled.length, 1);
  const { name: flowName, tier: compiledTier } = compileReport.compiled[0];
  assert.equal(compiledTier, 'pending');

  const approveReport = await flows(
    { sub: 'approve', name: flowName, json: false },
    {
      paths, interactive: true, confirmApprove: async () => true, print: () => {},
    },
  );
  assert.deepEqual(approveReport, {
    command: 'flows', sub: 'approve', name: flowName, moved: true,
  });

  const findRequest = {
    sub: 'find', intent: 'place an order', origin: fixture.origin, url: null, json: true,
  };
  const firstFind = await flows(findRequest, { paths });
  assert.equal(firstFind.candidates.length, 1);
  const firstCandidate = firstFind.candidates[0];
  assert.equal(firstCandidate.runnable, true);
  const approvedInvocation = firstCandidate.invocation;
  const approvedFlow = approvedInvocation.arguments.args.flow;

  const confirmOrderStepIndex = approvedFlow.steps.findIndex(
    (step) => step.op === 'click' && step.target?.name === 'Confirm order',
  );
  assert.notEqual(confirmOrderStepIndex, -1, 'expected a click step targeting "Confirm order"');

  // --- 2. replay against the ROLE-DRIFTED variant -> FLOW_RUNNER_FAILURE,
  // whose payload carries a candidate with the DERIVED role ('button') and
  // the button's CURRENT visible text ("Confirm your order" -- the
  // reworded drift, per this file's own drift-mechanism doc comment above
  // -- not the base recording's "Confirm order"), no testid, no explicit
  // name. ---
  fixture.setVariant('role-drifted');
  const failSession = await tracedSession(t, outputDir);
  let failurePayload;
  await assert.rejects(
    failSession.callTool(
      approvedInvocation.tool,
      replayArgsFor(approvedInvocation, ROLE_HEAL_FAIL_ARGS),
    ),
    (error) => {
      failurePayload = parseFlowRunnerFailure(error);
      return true;
    },
  );
  await failSession.close();
  t.diagnostic(`role-drifted-replay failure payload: ${JSON.stringify(failurePayload)}`);

  assert.equal(failurePayload.failedStep, confirmOrderStepIndex);
  assert.equal(failurePayload.error, 'no locator candidate matched');
  assert.equal(failurePayload.stepsCompleted, confirmOrderStepIndex);
  assert.ok(Array.isArray(failurePayload.candidates), 'expected candidate evidence on a locator-miss failure');
  const roleCandidate = failurePayload.candidates.find((candidate) => candidate.text === 'Confirm your order');
  assert.ok(roleCandidate, `expected a candidate carrying text "Confirm your order": ${JSON.stringify(failurePayload.candidates)}`);
  assert.equal(roleCandidate.role, 'button');
  assert.equal(roleCandidate.name, '');
  assert.equal(roleCandidate.testid, '');
  // Every candidate in this payload, not just the winner: proves the
  // kind:'testid' path genuinely never entered the running for this leg
  // (this file's own doc comment above claims exactly that; this makes it
  // a real assertion rather than an inferred property of one candidate).
  assert.ok(
    failurePayload.candidates.every((candidate) => candidate.testid === ''),
    `expected no candidate on this leg to carry a testid: ${JSON.stringify(failurePayload.candidates)}`,
  );

  // WS3b Task 7 review, fix round 2 (folded minor): the heal below clears
  // HEAL_MIN_MARGIN against this leg's real candidate set because the
  // step's stored `target.description` is empty here (this fixture's
  // recorded button carries no description, only a derived role/name) --
  // heal.mjs's lexical `rankCandidates` corpus is built from
  // description+name, so an empty description means the winning margin
  // comes entirely from the name/text overlap and role bonus computed
  // above. This is a LATENT SENSITIVITY, not a bug: if a future recorder
  // starts populating `target.description` for a plain button (e.g. from
  // an aria-description or a nearby label), the corpus grows and the
  // lexical jaccard denominator changes, which could shift the winning
  // margin below HEAL_MIN_MARGIN and fail this pin. That is intentional --
  // this e2e leg is meant to fail loudly the moment the real margin math
  // it exercises actually changes, rather than silently keep asserting
  // stale expectations against a scorer that no longer computes what this
  // test assumes it does.
  //
  // --- 3. sweep -> heal: report.healed names the flow and step, kind
  // 'other' (heal.mjs's DEVIATION note: a role+name/text heal is always
  // synthesized as kind 'other', never kind 'role' -- see that module's
  // own doc comment for why). The on-disk artifact (still in the ready
  // tier) has the appended role alternate LAST. ---
  const healSweep = await flows({ sub: 'compile', json: true }, { paths });
  assert.deepEqual(healSweep.compiled, []);
  assert.deepEqual(healSweep.updated, [{ name: flowName, successRuns: 0, failStreak: 1 }]);
  assert.deepEqual(healSweep.healed, [{ name: flowName, stepIndex: confirmOrderStepIndex, kind: 'other' }]);
  assert.deepEqual(healSweep.healErrors, []);

  const healedFlowPath = path.join(paths.flowsDir, flowFileName({ name: flowName }));
  const healedFlow = JSON.parse(await readFile(healedFlowPath, 'utf8'));
  const healedLocators = healedFlow.steps[confirmOrderStepIndex].target.locators;
  const appendedLocator = healedLocators[healedLocators.length - 1];
  assert.deepEqual(appendedLocator, { kind: 'other', selector: 'internal:role=button[name="Confirm your order"i]' });
  // The heal is purely additive: every locator the base recording captured
  // is still present, ahead of the appended alternate.
  assert.deepEqual(healedLocators.slice(0, -1), approvedFlow.steps[confirmOrderStepIndex].target.locators);

  assert.equal(healedFlow.id, flowId(healedFlow));
  assert.notEqual(healedFlow.id, approvedFlow.id);
  assert.equal(typeof healedFlow.provenance.lastHealed, 'string');
  assert.ok(!Number.isNaN(Date.parse(healedFlow.provenance.lastHealed)), 'lastHealed must be a valid ISO string');

  // --- 4. replay again against the ROLE-DRIFTED variant -> ok: true, the
  // healed role+text alternate is what found it. ---
  const secondFind = await flows(findRequest, { paths });
  const healedInvocation = secondFind.candidates[0].invocation;
  assert.equal(healedInvocation.arguments.args.flow.id, healedFlow.id);

  const healedSession = await tracedSession(t, outputDir);
  const healedReplayResult = await healedSession.callTool(
    healedInvocation.tool,
    replayArgsFor(healedInvocation, ROLE_HEAL_REPLAY),
  );
  t.diagnostic(`role-healed-replay result: ${JSON.stringify(healedReplayResult)}`);
  assert.equal(healedReplayResult.ok, true);
  assert.deepEqual(healedReplayResult.result, { completed: true });
  assert.equal(healedReplayResult.locatorFallbacks.length, 1);
  const healedFallback = healedReplayResult.locatorFallbacks[0];
  assert.equal(healedFallback.step, confirmOrderStepIndex);
  assert.equal(healedFallback.usedKind, 'other');
  assert.equal(healedFallback.usedIndex, healedLocators.length - 1);
  await assertOrderComplete(healedSession, orderId(ROLE_HEAL_REPLAY));
  await healedSession.close();

  // --- 5. sweep -> successRuns incremented, failStreak reset. ---
  const secondSweep = await flows({ sub: 'compile', json: true }, { paths });
  assert.deepEqual(secondSweep.compiled, []);
  assert.deepEqual(secondSweep.healed, []);
  assert.deepEqual(secondSweep.updated, [{ name: flowName, successRuns: 1, failStreak: 0 }]);

  // --- hygiene: best-effort outputDir cleanup, registered LAST. ---
  t.after(() => rm(outputDir, { recursive: true, force: true }));
});

// --- WS3b Task 6 / Task 10: act-phase interception recovery leg ---
//
// Closes the OTHER WS3a acceptance gap the module doc comment names: WS3a's
// own overlay leg (above) only ever proved rung 3 recovering a PROBE miss
// (the target itself never resolves -- `resolveTarget` throws before any
// action is attempted). This leg proves the genuinely different failure
// class Task 6 added rung-3 eligibility for: the target resolves and
// PASSES its probe (it is CSS-`visible`, has a real bounding box), but the
// act itself (`.click()`) times out because a covering element wins
// Playwright's separate hit-target check -- the "intercepts pointer
// events" signature `INTERCEPTION_SIGNATURE` in flow-runner.js anchors on.
//
// How this leg PROVES it is genuinely act-phase, not a relabeled
// probe-miss: `locatorFallbacks` is asserted EMPTY. A probe-miss recovery
// (this file's WS3a overlay leg, above) always records a `locatorFallbacks`
// entry -- `resolveTarget` never resolves the target on its first (rung 1)
// pass at all, so recovery only ever happens via `resolveEscalated`, which
// UNCONDITIONALLY appends an `escalated: true` entry on a hit (flow-
// runner.js's own doc comment on `resolveEscalated`). Here, the recorded
// target's own FIRST (index 0) locator is a 'role' kind -- resolveTarget's
// very first probe pass hits it immediately (the intercept overlay never
// touches #app's/the button's own CSS visibility), and `resolveTarget`
// only ever pushes a `locatorFallbacks` entry when the winning candidate's
// index is > 0 (flow-runner.js: `if (firstHit.candidateEntry.index > 0)`)
// -- so a clean first-pass hit on index 0 leaves `locatorFallbacks` as `[]`
// even though recovery still happened, because what needed recovering was
// the ACT, not the resolution. An unanchored/probe-miss recovery could
// never produce this shape.
//
// Separate recorded flow, own fixture instance, same reasoning as the
// role-heal leg above: this leg's own assertions (a completely empty
// `locatorFallbacks`) must never be able to pick up a stray fallback entry
// left behind by an earlier scenario step run against the same flow.
//
// --- interception mechanism ---
//
// tests/fixtures/order-flow/server.mjs's own doc comment (above
// `INTERCEPT_OVERLAY_HTML`) has the full write-up: the 'intercept' variant
// stacks a transparent, explicitly z-indexed, full-viewport overlay ABOVE
// #app without ever touching #app's own visibility/display -- so
// flow-runner's locator PROBE (bounding-box/CSS visibility only) succeeds
// immediately, and only the actual `.click()` -- which alone performs
// Playwright's separate hit-target check -- gets intercepted. Playwright's
// own default 30s action timeout applies to that `.click()` (flow-runner.js
// never overrides it), so THIS scenario step -- and only this one --
// necessarily takes on the order of 30s to reach its first failure before
// the quirk recovers it; this is inherent to the shipped behavior being
// proven (Consent ruling: a timeout DURING the actionability wait is the
// proof the action never dispatched), not a test inefficiency.

const INTERCEPT_RECORDED = {
  customerName: 'Owen', plan: 'team', seats: '7',
};
const INTERCEPT_REPLAY = {
  customerName: 'Ines', plan: 'scale', seats: '7',
};

test('healing: an overlay that intercepts pointer events recovers on the act, not the probe', { timeout: 90_000 }, async (t) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-intercept-'));
  const paths = pathsForOutputDir(outputDir);
  await installFlowRunner(paths);

  const fixture = await startOrderFixture();
  t.after(fixture.close);

  // --- 1. record (BASE variant), compile, approve ---
  const recorder = await tracedSession(t, outputDir);
  await recordOrderFlow(recorder, fixture.origin, INTERCEPT_RECORDED);
  await assertOrderComplete(recorder, orderId(INTERCEPT_RECORDED));
  await recorder.close();

  const compileReport = await flows({ sub: 'compile', json: true }, { paths });
  assert.equal(compileReport.compiled.length, 1);
  const { name: flowName, tier: compiledTier } = compileReport.compiled[0];
  assert.equal(compiledTier, 'pending');

  const approveReport = await flows(
    { sub: 'approve', name: flowName, json: false },
    {
      paths, interactive: true, confirmApprove: async () => true, print: () => {},
    },
  );
  assert.deepEqual(approveReport, {
    command: 'flows', sub: 'approve', name: flowName, moved: true,
  });

  const findRequest = {
    sub: 'find', intent: 'place an order', origin: fixture.origin, url: null, json: true,
  };
  const beforeQuirkFind = await flows(findRequest, { paths });
  const approvedFlow = beforeQuirkFind.candidates[0].invocation.arguments.args.flow;
  const startOrderStepIndex = approvedFlow.steps.findIndex(
    (step) => step.op === 'click' && step.target?.name === 'Start order',
  );
  assert.notEqual(startOrderStepIndex, -1, 'expected a click step targeting "Start order"');
  assert.equal(approvedFlow.steps[startOrderStepIndex].target.locators[0].kind, 'role');

  // --- 2. record the dismissal quirk via the real `sites quirk add` CLI,
  // then re-find so the invocation embeds it. ---
  const quirkAdded = await sites(
    {
      sub: 'quirk',
      verb: 'add',
      name: 'intercept-dismiss',
      origin: fixture.origin,
      selector: '#intercept-dismiss',
      description: 'Dismiss the pointer-event-intercepting overlay',
      urlPattern: null,
      json: true,
    },
    { paths, now: () => new Date('2026-08-05T00:00:00.000Z') },
  );
  assert.equal(quirkAdded.quirk.name, 'intercept-dismiss');
  assert.equal(quirkAdded.quirk.action, 'click');

  const quirkFind = await flows(findRequest, { paths });
  const quirkCandidate = quirkFind.candidates[0];
  assert.deepEqual(quirkCandidate.invocation.arguments.args.quirks, [{
    name: 'intercept-dismiss',
    urlPattern: null,
    target: { locators: [{ kind: 'css', selector: '#intercept-dismiss' }] },
    action: 'click',
  }]);

  // --- 3. replay against the INTERCEPT variant -> ok: true. The probe
  // never fails (locatorFallbacks stays empty -- see this test's own doc
  // comment above for why that specifically proves the act-phase path, not
  // the probe-miss path, is what fired), and the ordinary SUCCESS shape
  // carries no `quirkAttempted` key (that key only ever appears inside the
  // FAILURE payload -- flow-runner.js's own `fail()` call sites). ---
  fixture.setVariant('intercept');
  const interceptSession = await tracedSession(t, outputDir);
  const interceptResult = await interceptSession.callTool(
    quirkCandidate.invocation.tool,
    replayArgsFor(quirkCandidate.invocation, INTERCEPT_REPLAY),
  );
  t.diagnostic(`intercept-replay result: ${JSON.stringify(interceptResult)}`);
  assert.equal(interceptResult.ok, true);
  assert.deepEqual(interceptResult.result, { completed: true });
  assert.equal(Object.hasOwn(interceptResult, 'quirkAttempted'), false);
  assert.deepEqual(interceptResult.locatorFallbacks, []);
  await assertOrderComplete(interceptSession, orderId(INTERCEPT_REPLAY));

  // Direct, observable proof the dismiss quirk fired EXACTLY once (not
  // merely an inference from the runner's own "never attempted a second
  // time" doc comment): the fixture's own click-count instrumentation,
  // read back through a plain `browser_evaluate` call -- never compiled
  // into a step (no TOOL_OPS entry), so it cannot perturb the flow this
  // test is actually proving replays correctly.
  const dismissClickCount = await interceptSession.callTool('browser_evaluate', {
    function: '() => window.__interceptDismissClicks__',
  });
  assert.equal(dismissClickCount, 1);
  await interceptSession.close();

  // --- 4. sweep -> this replay counted as a success against the same
  // stored flow, and the `browser_evaluate` observation call above (in
  // compile.mjs's own `UNSUPPORTED_TOOLS` -- present in a segment, it
  // skips that whole segment rather than compiling a corrupted one) never
  // produced a stray compiled flow of its own. ---
  const sweepAfterIntercept = await flows({ sub: 'compile', json: true }, { paths });
  assert.deepEqual(sweepAfterIntercept.compiled, []);
  assert.deepEqual(sweepAfterIntercept.updated, [{ name: flowName, successRuns: 1, failStreak: 0 }]);

  // --- hygiene: best-effort outputDir cleanup, registered LAST. ---
  t.after(() => rm(outputDir, { recursive: true, force: true }));
});
