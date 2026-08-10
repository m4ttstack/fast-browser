import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseFlow } from '../../lib/flows/artifact.mjs';
import { replayPayload } from '../../lib/flows/replay.mjs';

// MAT-338. A successful one-call replay is the flywheel's whole payoff, and
// the MAT-330 spike measured the agent paying ~20,000 characters to collect
// a ~100-character answer. Three things made up that bill:
//
//   1. the runner SOURCE, echoed by `browser_run_code_unsafe`'s own
//      `response.addCode(...)` (packages/playwright-core/src/tools/backend/
//      runCode.ts in the pinned fork). Suppressed at launch by
//      `--codegen=none`, pinned in tests/unit/runtime-lock.test.mjs's exact
//      argument snapshot -- there is no per-call switch, so that flag is the
//      whole mechanism and losing it silently reopens this ticket;
//   2. the ARGUMENTS, echoed by the same call as `JSON.stringify(args)` --
//      the projection below is the fix;
//   3. the runner's own RETURN value, which was already compact.
//
// Measured end to end against the pinned runtime, headless, replaying a
// three-step flow: 65,236 -> 167 result characters. The echo template below
// is copied from that fork file verbatim so term 2 stays measurable here
// even though term 1 no longer ships.
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function echoedChars(runnerSource, args) {
  return `await (${runnerSource})(page, ${JSON.stringify(args)});`.length;
}

// The `next` flow the spike replayed 3/3, verbatim from its compiled
// artifact (job scratch `fbhome/.fast-browser/flows/next.flow.json`), with
// MAT-336's ladder left off deliberately: this is the BEFORE side of the
// measurement, so it has to be the bytes that were actually measured.
const SPIKE_FLOW = parseFlow({
  schemaVersion: 1,
  id: '966c6149c3463d58b0a2b3654aa7e3efff4c603829d74b331189c7a36cdc0830',
  name: 'next',
  description: 'On https://books.toscrape.com, this flow navigates to /catalogue/page-1.html, clicks "next", clicks "next".',
  origin: 'https://books.toscrape.com',
  urlPattern: '/catalogue/page-1.html',
  sideEffects: 'read-only',
  args: {},
  result: { kind: 'completion', keys: [] },
  steps: [
    { op: 'goto', url: '/catalogue/page-1.html' },
    {
      op: 'click',
      target: {
        locators: [{ kind: 'role', selector: 'internal:role=link[name="next"i]' }],
        description: 'next',
        role: 'link',
        name: 'next',
      },
      waitAfter: { networkSettled: true },
      mutating: false,
    },
    {
      op: 'click',
      target: {
        locators: [{ kind: 'role', selector: 'internal:role=link[name="next"i]' }],
        description: 'next',
        role: 'link',
        name: 'next',
      },
      waitAfter: { networkSettled: true },
      mutating: false,
    },
  ],
  provenance: {
    compiledAt: '2026-08-10T14:13:51.641Z',
    traceDir: 'trace-1786371119773',
    seqRange: [46, 55],
    productVersion: '0.1.0-alpha.10',
    successRuns: 0,
    failStreak: 0,
    lastHealed: null,
  },
});

test('MAT-338: the replay payload carries only what the runner reads, plus the id provenance matches on', () => {
  const payload = replayPayload(SPIKE_FLOW);

  assert.deepEqual(Object.keys(payload).sort(), ['args', 'id', 'name', 'origin', 'schemaVersion', 'steps']);
  assert.equal(payload.id, SPIKE_FLOW.id, 'sweep resolveReplayTarget matches a replay record back by this');
  for (const step of payload.steps) {
    if (step.target) assert.ok(!('description' in step.target), 'the runner never reads target.description');
  }
});

test('MAT-338: projecting the payload cuts the echoed argument bill', () => {
  const before = JSON.stringify({ flow: SPIKE_FLOW, args: {}, quirks: [] }).length;
  const after = JSON.stringify({ flow: replayPayload(SPIKE_FLOW), args: {}, quirks: [] }).length;

  assert.ok(after < before, `expected a reduction, got ${before} -> ${after}`);
  assert.ok(
    after <= before * 0.7,
    `the projection must cut at least 30% of the argument echo (${before} -> ${after})`,
  );
});

test('MAT-338: the runner returns compact fields, never the flow or its own source', async () => {
  // `browser_run_code_unsafe` serializes whatever the macro returns, so the
  // return shape IS the result contract. Read off the source rather than
  // from a live replay: the point is that no other shape can ship.
  const source = await readFile(path.join(pluginRoot, 'builtins/macros/flow-runner.js'), 'utf8');
  const successReturn = source.slice(source.lastIndexOf('return {'));

  assert.match(successReturn, /ok: true/);
  assert.match(successReturn, /stepsRun: steps\.length/);
  assert.match(successReturn, /locatorFallbacks,/);
  assert.match(successReturn, /ms: Date\.now\(\) - started/);
  assert.match(successReturn, /result: extracted \? \{ \.\.\.result \} : \{ completed: true \}/);
  assert.ok(!/return \{[^}]*\bflow\b/s.test(successReturn), 'the flow itself is never returned');
});

test('MAT-338: the launch flag that suppresses the code echo is the only thing standing between the payload and a 65k result', async () => {
  // Guards the pairing rather than either half: `--codegen=none` is what
  // makes the projection worth anything (65,236 -> 167 measured), and this
  // repo is the only place that flag is set. A future edit that drops it
  // from `runtimeArgs` would leave every replay echoing the whole runner
  // again with nothing failing except the argument-list snapshot, so this
  // spells out what that snapshot is protecting.
  const { runtimeArgs } = await import('../../lib/runtime/launch.mjs');
  const args = runtimeArgs({
    config: { profile: 'safe', connection: { mode: 'manual' }, sessions: { enabled: false } },
    paths: { dataDir: '/synthetic/.fast-browser', runtimeDir: '/synthetic/.fast-browser/runtime' },
    lock: { extension: { id: 'abcdefghijklmnopabcdefghijklmnop' } },
  });
  assert.ok(args.includes('--codegen=none'));

  const runnerSource = await readFile(path.join(pluginRoot, 'builtins/macros/flow-runner.js'), 'utf8');
  const projected = { flow: replayPayload(SPIKE_FLOW), args: {}, quirks: [] };
  assert.ok(
    echoedChars(runnerSource, projected) > 50_000,
    'the runner source is what that flag suppresses; if it ever got small this test is measuring nothing',
  );
});
