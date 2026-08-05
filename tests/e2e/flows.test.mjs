import assert from 'node:assert/strict';
import {
  copyFile, mkdir, mkdtemp, readFile,
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
// with zero snapshots. A controller-added step 7 then sabotages that same
// invocation's locators and proves a failed replay is recorded as a failure
// against the same stored flow, closing the last unverified link: the
// runtime writes `record.error` when a macro throws, and sweep.mjs's
// replay-provenance scan keys off exactly that.

const pluginRoot = fileURLToPath(new URL('../../', import.meta.url));

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

test('flywheel: record scripted, compile gated, approve, replay in one call', async (t) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-flywheel-'));
  const paths = pathsForOutputDir(outputDir);
  await installFlowRunner(paths);

  const fixture = await startOrderFixture();
  t.after(fixture.close);

  // --- 1. record: drive the order flow through a TRACED session, then
  // close it so meta.json gets endedAt. ---
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
  // test was written; see task-10-report.md.
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
  assert.equal(invocation.arguments.args.flow.id, compiledFlow.id);
  assert.deepEqual(Object.keys(invocation.arguments.args.args).sort(), ['customerName', 'plan']);

  // --- 5. replay: a NEW traced session issues the invocation in exactly
  // one call, zero snapshots, matching the scripted run's outcome. ---
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
  // can produce, and it is what the scripted run itself reached (the
  // recording's own `browser_wait_for` on "Order complete" would have
  // thrown had the fixture not gotten there).
  assert.deepEqual(replayResult.result, { completed: true });
  assert.deepEqual(replayResult.locatorFallbacks, []);
  await replaySession.close();

  // --- 6. second sweep: the stored, now-approved flow shows one success. ---
  const secondSweep = await flows({ sub: 'compile', json: true }, { paths });
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

  const sabotageSession = await tracedSession(t, outputDir);
  await assert.rejects(
    sabotageSession.callTool(invocation.tool, sabotagedArgs),
    (error) => /FLOW_RUNNER_FAILURE/.test(error.message),
  );
  await sabotageSession.close();

  const thirdSweep = await flows({ sub: 'compile', json: true }, { paths });
  assert.deepEqual(thirdSweep.updated, [{ name: flowName, successRuns: 1, failStreak: 1 }]);

  const listAfterFailure = await flows({ sub: 'list', json: true }, { paths });
  const flowAfterFailure = listAfterFailure.flows.find((entry) => entry.name === flowName);
  assert.deepEqual(flowAfterFailure.health, { successRuns: 1, failStreak: 1 });
});
