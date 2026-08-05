import assert from 'node:assert/strict';
import {
  copyFile, mkdir, mkdtemp, readFile, rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { flows } from '../../lib/commands/flows.mjs';
import { flowFileName } from '../../lib/flows/artifact.mjs';
import { startOrderFixture } from '../fixtures/order-flow/server.mjs';
import { startMcpClient } from './helpers/mcp-client.mjs';

// The flywheel e2e (WS2a plan, Task 10): the program's signature acceptance
// test. Record a flow through a traced session, gate it on the mutating
// consent tier, approve it with an injected (no-TTY) confirm, then replay
// the returned invocation VERBATIM -- the flow-runner artifact untouched --
// in a brand-new session and prove it completes in exactly one tool call
// with zero snapshots, AND that the page actually reached the state the
// replayed args imply (fix round 1, F1: a macro call completing without
// throwing is not proof it reproduced the recorded outcome -- see step 5).
// A controller-added step 7 then sabotages that same invocation's locators
// and proves a failed replay is recorded as a failure against the same
// stored flow, closing the last unverified link: the runtime writes
// `record.error` when a macro throws, and sweep.mjs's replay-provenance
// scan keys off exactly that.

const pluginRoot = fileURLToPath(new URL('../../', import.meta.url));

// The recording and replay runs deliberately use DIFFERENT customer/plan
// values (never the compiled flow's own recorded literals played back) so
// that verifying each run's own order-id independently (step 1, step 5)
// proves the replayed args actually flowed through to the page, not that a
// stale/cached value happened to match a hardcoded expectation. `seats`
// stays '7' in both: it's a single-character literal, and compile.mjs's own
// lift filter (`liftLiteral`) never lifts literals under 2 characters, so
// it is never parameterized -- both runs fill the same literal regardless
// of `customerName`/`plan`.
const RECORDED_ORDER_ID = 'ADA-TEAM-7';
const REPLAY_ORDER_ID = 'GRACE-SCALE-7';

// Hand-built paths object matching lib/core/paths.mjs's key shape (Task 1),
// but rooted at `outputDir` itself rather than at `homeDir/.fast-browser`:
// lib/runtime/launch.mjs's real wiring is `--output-dir=${paths.dataDir}`
// (runtimeArgs), and mcp-client.mjs's startMcpClient passes `outputDir` as
// `--output-dir` verbatim -- so in this test `paths.dataDir` IS `outputDir`,
// never a nested subdirectory of it. This is where `TraceLog.create` writes
// `trace-<epochMs>/` (TRACE.md's "Directory layout"), which is exactly what
// sweep.mjs's `listTraceSessions` scans -- resolvePaths({ homeDir: outputDir
// }) would instead compute `outputDir/.fast-browser`, one level too deep.
function pathsForOutputDir(outputDir) {
  return {
    dataDir: outputDir,
    flowsDir: path.join(outputDir, 'flows'),
    flowsPendingDir: path.join(outputDir, 'flows-pending'),
    flowsStateFile: path.join(outputDir, 'flows-state.json'),
    macrosDir: path.join(outputDir, 'macros'),
    rejectedFlowsFile: path.join(outputDir, 'rejected-flows.md'),
  };
}

// flows.mjs's `buildInvocation` embeds an absolute `<macrosDir>/
// flow-runner.js` filename (never inline code -- a macro sandboxed by
// browser_run_code_unsafe has no fs access to look itself up any other way).
// The physical file has to exist under this traced session's own output dir
// for that filename to resolve at replay time -- production's setup.mjs
// does this via installBuiltinMacros (which also writes MACROS.md and a
// hashes ledger this test has no use for); a plain copy of the one file the
// invocation ever names is sufficient here.
async function installFlowRunner(paths) {
  await mkdir(paths.macrosDir, { recursive: true });
  await copyFile(
    path.join(pluginRoot, 'builtins/macros/flow-runner.js'),
    path.join(paths.macrosDir, 'flow-runner.js'),
  );
}

// Wraps startMcpClient with an idempotent close registered via t.after as a
// safety net -- this test closes each session explicitly and early (sweep
// defers compilation entirely until `meta.endedAt` exists, so a session
// MUST be closed before the next `flows compile` call can see it), but an
// assertion throwing between session creation and that explicit close must
// still not leak the spawned runtime process.
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

// Runs two `browser_find` text searches (completion heading, then the
// specific order id) and asserts each matched exactly once -- the page-state
// check both the recording (step 1) and the replay (step 5) run through
// `browser_find` specifically because it has no TOOL_OPS entry in
// compile.mjs: it can never compile into a step, so calling it never
// perturbs the artifact either run produces, and (for the replay) it is
// issued only AFTER the one-call budget has already been measured.
//
// `mcp-client.mjs`'s `textResult` extracts the "### Result" section via a
// multiline (`m`-flagged) regex whose `$` matches end-of-LINE, not
// end-of-string -- for a multi-line snapshot-tree response like
// `browser_find`'s, that collapses the returned value to just its first
// line (verified against the real runtime; this is existing, uneditable
// helper behavior, not a bug introduced here). `Found 1 match for "<text>":`
// is that first line and is exact-equality-checkable on its own.
async function assertOrderComplete(session, orderId) {
  const headingFind = await session.callTool('browser_find', { text: 'Order complete' });
  assert.equal(headingFind, 'Found 1 match for "Order complete":');
  const orderIdFind = await session.callTool('browser_find', { text: orderId });
  assert.equal(orderIdFind, `Found 1 match for "${orderId}":`);
}

test('flywheel: record scripted, compile gated, approve, replay in one call', async (t) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-flywheel-'));
  const paths = pathsForOutputDir(outputDir);
  await installFlowRunner(paths);

  const fixture = await startOrderFixture();
  t.after(fixture.close);

  // --- 1. record: drive the order flow through a TRACED session, verify
  // the RECORDED outcome against the page itself (not just that the tool
  // calls didn't throw), then close so meta.json gets endedAt. ---
  //
  // Deliberately NOT direct-mcp.test.mjs's single `browser_run_code_unsafe`
  // call, despite driving the exact same fixture actions/values that script
  // does: compile.mjs's TOOL_OPS maps `browser_run_code_unsafe` to an
  // opaque 'js' step unconditionally (it never reads the trace record's
  // `script.actions` telemetry -- that field exists for provenance/
  // verification, not for step decomposition). A flow containing a js step
  // is refused by flow-runner.js at replay no matter what ("v1 refuses ALL
  // js steps", Task 8), so a session recorded as one opaque script call can
  // never produce anything this test's own step 5 could replay
  // successfully, and would compile with sideEffects 'read-only' (no
  // MUTATING_BY_IDENTITY tool identity in play), not 'mutating'. Driving
  // the same actions through the equivalent discrete MCP tools instead is
  // what makes them individually compilable AND what earns the mutating
  // classification (browser_type/browser_select_option are both in
  // compile.mjs's MUTATING_BY_IDENTITY) -- verified empirically before this
  // test was written; see task-10-report.md. This also means there is no
  // meaningful "recording stayed under N calls" assertion to add here even
  // in principle: `--save-trace` is a launch-time, server-side
  // instrumentation flag with no client-visible round trips (TRACE.md), so
  // the recording's call count is simply however many actions this script
  // chose to issue, traced or not -- direct-mcp.test.mjs's own untraced
  // budget tests are what actually establish "capture costs no extra
  // calls" (same script, same count, tracing on vs. off is invisible to the
  // client); pinning a second number here would prove nothing new.
  const recorder = await tracedSession(t, outputDir);
  await recorder.callTool('browser_navigate', { url: fixture.origin });
  await recorder.callTool('browser_click', { target: 'role=button[name="Start order"]' });
  await recorder.callTool('browser_type', { target: 'role=textbox[name="Customer name"]', text: 'Ada' });
  await recorder.callTool('browser_click', { target: 'role=button[name="Continue"]' });
  await recorder.callTool('browser_select_option', { target: 'role=combobox[name="Plan"]', values: ['team'] });
  await recorder.callTool('browser_type', { target: 'role=spinbutton[name="Seats"]', text: '7' });
  await recorder.callTool('browser_click', { target: 'role=button[name="Review order"]' });
  await recorder.callTool('browser_click', { target: 'role=button[name="Place order"]' });
  await recorder.callTool('browser_wait_for', { text: 'Order complete' });
  // browser_find has no TOOL_OPS entry (compile.mjs) -- it cannot compile
  // into a step, so these observations never touch the artifact the
  // recording below produces.
  await assertOrderComplete(recorder, RECORDED_ORDER_ID);
  t.diagnostic(`recording metrics: ${JSON.stringify(recorder.metrics())}`);
  await recorder.close();

  // --- 2. compile: exactly one flow compiled, mutating, pending. ---
  const compileReport = await flows({ sub: 'compile', json: true }, { paths });
  assert.equal(compileReport.compiled.length, 1);
  const { name: flowName, tier: compiledTier } = compileReport.compiled[0];
  assert.equal(compiledTier, 'pending');

  const compiledFlowPath = path.join(paths.flowsPendingDir, flowFileName({ name: flowName }));
  const compiledFlow = JSON.parse(await readFile(compiledFlowPath, 'utf8'));
  assert.equal(compiledFlow.sideEffects, 'mutating');
  assert.equal(compiledFlow.origin, fixture.origin);

  // --- 3. find: the pending candidate is present but not runnable, and the
  // reason names the approval gate. ---
  const findRequest = {
    sub: 'find', intent: 'place an order', origin: fixture.origin, url: null, json: true,
  };
  const pendingReport = await flows(findRequest, { paths });
  assert.equal(pendingReport.candidates.length, 1);
  const pendingCandidate = pendingReport.candidates[0];
  assert.equal(pendingCandidate.name, flowName);
  assert.equal(pendingCandidate.sideEffects, 'mutating');
  assert.equal(pendingCandidate.runnable, false);
  assert.equal(pendingCandidate.reasons.length, 1);
  assert.match(pendingCandidate.reasons[0], /pending approval/);
  assert.match(pendingCandidate.reasons[0], new RegExp(`flows approve ${flowName}`));

  // --- 4. approve: injected confirm, no TTY (dependency injection, mirrors
  // tests/unit/flows-command.test.mjs's approve coverage) -- then re-find
  // to see it flip to runnable with the invocation embedded. `json: false`
  // is load-bearing here: dependencies() forces `interactive: false`
  // whenever `request.json === true`, regardless of what `supplied.
  // interactive` says (the same --json-forces-non-interactive gate
  // uninstall.mjs uses), so approving through the JSON-mode request shape
  // used everywhere else in this test would refuse before ever reaching the
  // injected confirm. ---
  const approveReport = await flows(
    { sub: 'approve', name: flowName, json: false },
    {
      paths, interactive: true, confirmApprove: async () => true, print: () => {},
    },
  );
  assert.deepEqual(approveReport, {
    command: 'flows', sub: 'approve', name: flowName, moved: true,
  });

  const runnableReport = await flows(findRequest, { paths });
  assert.equal(runnableReport.candidates.length, 1);
  const runnableCandidate = runnableReport.candidates[0];
  assert.equal(runnableCandidate.runnable, true);
  assert.deepEqual(runnableCandidate.reasons, []);
  const invocation = runnableCandidate.invocation;
  assert.equal(invocation.tool, 'browser_run_code_unsafe');
  assert.equal(invocation.arguments.filename, path.join(paths.macrosDir, 'flow-runner.js'));

  // Full-artifact embedding (fix round 1, F3): the invocation must embed
  // EXACTLY the artifact now sitting in the ready tier -- content unchanged
  // by approval (flows.mjs's own "tier is directory location" contract, a
  // plain rename) -- not merely the same `id`.
  const approvedFlowPath = path.join(paths.flowsDir, flowFileName({ name: flowName }));
  const approvedFlow = JSON.parse(await readFile(approvedFlowPath, 'utf8'));
  assert.deepEqual(invocation.arguments.args.flow, approvedFlow);

  // Placeholder shape (fix round 1, F4): pinned before either arg is filled
  // in, so a future change to `argPlaceholder`'s literal text fails here
  // rather than silently at replay time.
  assert.deepEqual(invocation.arguments.args.args, {
    customerName: '<REQUIRED: string>',
    plan: '<REQUIRED: string>',
  });

  // --- 5. replay: a NEW traced session issues the invocation in exactly
  // one call, zero snapshots -- AND the replayed page actually reaches the
  // state those (different-from-recording) args imply, not merely a macro
  // call that returned without throwing. ---
  //
  // Fix round 1, F1: `deepEqual(replayResult.result, { completed: true })`
  // alone proves no step threw -- it says nothing about whether the page
  // ended up in the state the supplied args imply (e.g. a `fill()` that
  // failed to clear the Seats input's shipped `value="1"` before typing
  // would silently produce a wrong order code without failing any assertion
  // that only inspects the macro's return value). `browser_find` is issued
  // AFTER `metricsAfterReplay` is captured, so it never touches the 1-call
  // budget assertion below, and it cannot compile into a step for the same
  // reason as the recording's own use of it (no TOOL_OPS entry).
  //
  // The invocation's placeholder arg values (`<REQUIRED: string>`) are
  // swapped for real ones before the call; the embedded flow artifact --
  // `invocation.arguments.args.flow`, i.e. every step and locator this test
  // is actually proving replays correctly -- is passed through untouched,
  // exactly as `find` returned it. Issuing the placeholders completely
  // verbatim was tried first and does NOT satisfy `ok: true`: the `select`
  // step's `locator.selectOption('<REQUIRED: string>')` has no matching
  // `<option>` on the fixture's Plan dropdown, so Playwright retries for
  // its full 30s action timeout before failing -- a placeholder is a slot
  // for the caller to fill in, never a literal safe to submit as-is. See
  // task-10-report.md.
  const replayArgs = {
    ...invocation.arguments,
    args: {
      ...invocation.arguments.args,
      args: { customerName: 'Grace', plan: 'scale' },
    },
  };
  const replaySession = await tracedSession(t, outputDir);
  const callsBefore = replaySession.metrics().calls;
  const replayResult = await replaySession.callTool(invocation.tool, replayArgs);
  const metricsAfterReplay = replaySession.metrics();
  t.diagnostic(`replay metrics: ${JSON.stringify(metricsAfterReplay)}`);
  assert.equal(metricsAfterReplay.calls - callsBefore, 1);
  assert.equal(metricsAfterReplay.byTool.browser_snapshot ?? 0, 0);
  assert.equal(replayResult.ok, true);
  // v1 never compiles an `extract` step (compile.mjs's own rule 8 comment:
  // "v1 never compiles an extract step (ruling e)"), so a compiled flow's
  // `result.kind` is always 'completion' -- flow-runner's `{ completed:
  // true }` is the only outcome shape this flow (or any v1-compiled flow)
  // can produce.
  assert.deepEqual(replayResult.result, { completed: true });
  assert.deepEqual(replayResult.locatorFallbacks, []);

  await assertOrderComplete(replaySession, REPLAY_ORDER_ID);
  await replaySession.close();

  // --- 6. second sweep: the stored, now-approved flow shows one success,
  // and neither the replay call nor the verification browser_find above
  // compiled into a new flow (fix round 1, F5's gap: replay/verification
  // records must never be mistaken for fresh recordable actions). ---
  const secondSweep = await flows({ sub: 'compile', json: true }, { paths });
  assert.deepEqual(secondSweep.compiled, []);
  assert.deepEqual(secondSweep.updated, [{ name: flowName, successRuns: 1, failStreak: 0 }]);

  const listAfterSuccess = await flows({ sub: 'list', json: true }, { paths });
  const listedFlow = listAfterSuccess.flows.find((entry) => entry.name === flowName);
  assert.equal(listedFlow.tier, 'ready');
  assert.deepEqual(listedFlow.health, { successRuns: 1, failStreak: 0 });

  // --- 7. (controller-added, binding) sabotaged replay: deep-copy the
  // approved invocation's embedded artifact, replace every non-goto step's
  // target.locators with a selector that can never resolve (keeping
  // id/name/steps count exactly as-is, so sweep's replay-provenance match
  // still attributes the failure to THIS stored flow), open a THIRD traced
  // session, and issue it. This is the last unverified link: the runtime
  // must write `record.error` when the macro throws, and sweep.mjs's
  // replay scan must turn that into `failStreak` on the SAME flow whose
  // `successRuns` step 6 just proved. ---
  const sabotagedFlow = JSON.parse(JSON.stringify(invocation.arguments.args.flow));
  for (const step of sabotagedFlow.steps) {
    if (step.op === 'goto') continue;
    if (step.target) step.target.locators = [{ kind: 'css', selector: '#does-not-exist-xyz' }];
    if (step.to) step.to.locators = [{ kind: 'css', selector: '#does-not-exist-xyz' }];
  }
  assert.equal(sabotagedFlow.id, invocation.arguments.args.flow.id);
  assert.equal(sabotagedFlow.name, invocation.arguments.args.flow.name);
  assert.equal(sabotagedFlow.steps.length, invocation.arguments.args.flow.steps.length);
  const sabotagedArgs = {
    ...invocation.arguments,
    args: { flow: sabotagedFlow, args: { customerName: 'Grace', plan: 'scale' } },
  };

  // Fix round 1, F2: a bare `/FLOW_RUNNER_FAILURE/.test(message)` also
  // passes for the WRONG failure class -- `failedStep: 'args'` (a missing/
  // malformed required arg) throws the identical prefix. Anchoring on the
  // literal prefix, parsing the JSON payload after it, and asserting the
  // SPECIFIC failure shape (`failedStep` a step INDEX, not `'args'`, and
  // flow-runner's exact "no locator candidate matched" resolveTarget
  // message) is what actually proves this failure came from the sabotaged
  // locators, not from some unrelated args regression.
  const sabotageSession = await tracedSession(t, outputDir);
  await assert.rejects(
    sabotageSession.callTool(invocation.tool, sabotagedArgs),
    (error) => {
      const prefix = 'FLOW_RUNNER_FAILURE: ';
      const markerIndex = error.message.indexOf(prefix);
      assert.notEqual(markerIndex, -1, `expected "${prefix}" in error message: ${error.message}`);
      const payload = JSON.parse(error.message.slice(markerIndex + prefix.length));
      assert.equal(typeof payload.failedStep, 'number');
      assert.equal(payload.error, 'no locator candidate matched');
      return true;
    },
  );
  await sabotageSession.close();

  const thirdSweep = await flows({ sub: 'compile', json: true }, { paths });
  assert.deepEqual(thirdSweep.compiled, []);
  assert.deepEqual(thirdSweep.updated, [{ name: flowName, successRuns: 1, failStreak: 1 }]);

  const listAfterFailure = await flows({ sub: 'list', json: true }, { paths });
  const flowAfterFailure = listAfterFailure.flows.find((entry) => entry.name === flowName);
  assert.deepEqual(flowAfterFailure.health, { successRuns: 1, failStreak: 1 });

  // --- hygiene (fix round 1, F6): best-effort outputDir cleanup, registered
  // LAST so it runs LAST -- node:test runs `t.after` hooks in registration
  // (FIFO) order, and every session's own close() was registered earlier,
  // above -- on the success path this only ever removes a directory every
  // runtime/fixture process has already released. `force: true` means an
  // already-partially-missing outputDir (a failure path that threw before
  // some subdirectory was ever created) is tolerated rather than raising a
  // second, unrelated error on top of the real one. ---
  t.after(() => rm(outputDir, { recursive: true, force: true }));
});
