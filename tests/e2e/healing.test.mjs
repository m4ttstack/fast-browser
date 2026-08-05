import assert from 'node:assert/strict';
import {
  copyFile, mkdir, mkdtemp, readFile, rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { flows } from '../../lib/commands/flows.mjs';
import { sites } from '../../lib/commands/sites.mjs';
import { flowFileName, flowId } from '../../lib/flows/artifact.mjs';
import { startOrderFixture } from '../fixtures/order-flow/server.mjs';
import { startMcpClient } from './helpers/mcp-client.mjs';

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

const pluginRoot = fileURLToPath(new URL('../../', import.meta.url));

// Hand-built paths object matching lib/core/paths.mjs's key shape, rooted at
// `outputDir` itself -- copied from flows.test.mjs's own `pathsForOutputDir`
// (see that file's doc comment for why `dataDir` IS `outputDir`, never a
// nested subdirectory of it, and why `sitesDir` must still be a string even
// though this test's `sites quirk add` call is the only thing that ever
// writes under it before replay reads it back).
function pathsForOutputDir(outputDir) {
  return {
    dataDir: outputDir,
    flowsDir: path.join(outputDir, 'flows'),
    flowsPendingDir: path.join(outputDir, 'flows-pending'),
    flowsStateFile: path.join(outputDir, 'flows-state.json'),
    macrosDir: path.join(outputDir, 'macros'),
    rejectedFlowsFile: path.join(outputDir, 'rejected-flows.md'),
    sitesDir: path.join(outputDir, 'sites'),
  };
}

// flows.mjs's `buildInvocation` embeds an absolute `<macrosDir>/
// flow-runner.js` filename -- the physical file has to exist under this
// traced session's own output dir for that filename to resolve at replay
// time. Copied verbatim from flows.test.mjs's own `installFlowRunner`.
async function installFlowRunner(paths) {
  await mkdir(paths.macrosDir, { recursive: true });
  await copyFile(
    path.join(pluginRoot, 'builtins/macros/flow-runner.js'),
    path.join(paths.macrosDir, 'flow-runner.js'),
  );
}

// Wraps startMcpClient with an idempotent close registered via t.after as a
// safety net -- copied verbatim from flows.test.mjs's own `tracedSession`.
async function tracedSession(t, outputDir) {
  const session = await startMcpClient({ outputDir, extraArgs: ['--save-trace'] });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await session.close();
  };
  t.after(close);
  return { callTool: session.callTool, metrics: session.metrics, close };
}

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
