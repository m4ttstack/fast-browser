import assert from 'node:assert/strict';
import {
  mkdtemp, readFile, rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { startOrderFixture } from '../fixtures/order-flow/server.mjs';
import {
  classifyReplay, replayArgsFor, runHarness,
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
