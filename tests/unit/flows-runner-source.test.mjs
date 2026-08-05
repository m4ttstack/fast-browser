import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// Static checks on builtins/macros/flow-runner.js (WS2a flywheel plan, Task
// 8). Behavioral coverage (does it actually replay a flow against a real
// page) lands in Task 10's e2e -- this file only proves properties readable
// from the source text and from loading it as a bare expression, the same
// way tests/unit/macros.test.mjs's `loadMacro`/`loadMacroWithoutNodeGlobals`
// load every other built-in.
//
// The `/retry/i` assertion below (in the "never retries a step internally"
// test) matches against the whole source text, comments included, and that
// is deliberate: it exists to catch a regression toward attempt-and-retry
// behavior, and a comment saying "retry" is exactly as strong a signal of
// that regression as code would be -- allowing the word in a comment would
// leave the canary able to be silenced by moving the vocabulary into prose
// instead of actually removing the behavior.

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const macroPath = path.join(pluginRoot, 'builtins/macros/flow-runner.js');

async function readSource() {
  return readFile(macroPath, 'utf8');
}

test('flow-runner.js parses as a bare async (page, args) => ... expression', async () => {
  const source = await readSource();
  // `new Function` only accepts a bare expression when it is the return
  // value of a function body -- a source file containing statements before
  // or after the arrow function (an import, a trailing semicolon plus
  // extra code, a second top-level expression) fails this exact
  // construction, matching how the runtime loads every macro file.
  const factory = new Function(`"use strict"; return (${source});`);
  const macro = factory();
  assert.equal(typeof macro, 'function');
  assert.equal(macro.constructor.name, 'AsyncFunction', 'must be declared async');
  assert.equal(macro.length, 2, 'must take exactly (page, args)');
  assert.match(source.trim(), /^async\s*\(\s*page\s*,\s*args\s*\)\s*=>/, 'must open as a bare arrow expression');
});

test('flow-runner.js runs with no Node globals in scope, matching the real sandbox', async () => {
  // Mirrors macros.test.mjs's loadMacroWithoutNodeGlobals: a fresh vm
  // context has the standard ECMAScript intrinsics (Object, Array, Math,
  // JSON, Promise, Date, RegExp, ...) but none of Node's host-specific
  // globals, since those are only ever added to a context explicitly. A
  // function defined inside that context keeps it as its lexical global
  // scope even when invoked later from this process, so a stray reference
  // to a Node-only global inside the macro throws ReferenceError here
  // exactly as it would live.
  //
  // Loading the function was not enough on its own (fix round 1, IMPORTANT
  // 4): only actually CALLING it executes the function body inside this
  // realm, which is the only way a smuggled bare `process`/`require`
  // reference anywhere in the prologue would ever surface as a
  // ReferenceError here. An invalid flow is enough to reach that body and
  // return (via a throw, post-ruling) without needing any real Playwright
  // API on the stub `page`.
  const source = await readSource();
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(`(${source})`);
  const macro = script.runInContext(sandbox);
  assert.equal(typeof macro, 'function');

  const stubPage = {
    url: () => 'http://x/',
    on: () => {},
    off: () => {},
  };
  await assert.rejects(
    () => macro(stubPage, { flow: { schemaVersion: 2 }, args: {} }),
    (error) => {
      // Not `instanceof Error`: `vm.createContext` is a genuinely separate
      // realm with its own `Error` constructor, so an error thrown from
      // code running inside it is an instance of THAT realm's `Error`,
      // never this file's. `message` is a plain string either way.
      assert.equal(typeof error.message, 'string');
      assert.match(error.message, /^FLOW_RUNNER_FAILURE: /);
      const payload = JSON.parse(error.message.slice('FLOW_RUNNER_FAILURE: '.length));
      assert.equal(payload.failedStep, 'args');
      assert.equal(payload.url, 'http://x/');
      return true;
    },
  );
});

test('flow-runner.js source has no require(, process., or console. -- no Node globals referenced at all', async () => {
  const source = await readSource();
  assert.doesNotMatch(source, /require\(/);
  assert.doesNotMatch(source, /process\./);
  assert.doesNotMatch(source, /console\./);
  assert.doesNotMatch(source, /\bmodule\./);
  assert.doesNotMatch(source, /\b__dirname\b/);
  assert.doesNotMatch(source, /\b__filename\b/);
});

test('flow-runner.js has no import/export statements', async () => {
  const source = await readSource();
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /^\s*export\s/m);
});

test('flow-runner.js refuses every js step with the exact documented message', async () => {
  const source = await readSource();
  assert.match(source, /flow contains an opaque js step; re-record or run manually/);
  // Refused up front: the js-step scan has to run before the replay loop
  // that performs page interaction, not interleaved with it -- otherwise a
  // flow with a js step past index 0 would already have half-run before
  // being refused.
  const refusalIndex = source.indexOf('flow contains an opaque js step');
  const loopIndex = source.indexOf('const result = Object.create(null);');
  assert.ok(loopIndex >= 0, 'the replay loop\'s result accumulator must exist');
  assert.ok(refusalIndex >= 0 && loopIndex > refusalIndex, 'refusal must be textually before the replay loop');
});

test('flow-runner.js never retries a step internally (at-most-once mutating)', async () => {
  const source = await readSource();
  // No retry vocabulary anywhere in the source: a step that fails returns a
  // structured failure immediately rather than being attempted again. This
  // is a textual canary, not a behavioral proof (that's Task 10's e2e), but
  // a regression that reintroduced an attempt-and-retry loop would almost
  // certainly reintroduce this vocabulary too.
  assert.doesNotMatch(source, /retry/i);
  assert.doesNotMatch(source, /\battempts?\s*(\+\+|\+=|--)/i);
  assert.doesNotMatch(source, /\bfor\s*\(\s*(?:let|var)\s+attempt/i);
  // Every step body is its own try/catch that returns on failure -- proven
  // textually by counting one `catch (error) {` (the per-step failure
  // handler that builds the `{ failedStep, error, url, stepsCompleted,
  // locatorFallbacks }` shape) against exactly one occurrence of the
  // `stepsCompleted: index` failure literal it must produce.
  assert.equal((source.match(/stepsCompleted: index,/g) || []).length, 1);
});

test('flow-runner.js declares the full failure and success shapes', async () => {
  const source = await readSource();
  assert.match(source, /failedStep: 'args'/);
  assert.match(source, /stepsCompleted: 0,/);
  assert.match(source, /locatorFallbacks,/);
  assert.match(source, /ok: true,/);
  assert.match(source, /stepsRun: steps\.length,/);
  assert.match(source, /extracted \? \{ \.\.\.result \} : \{ completed: true \}/);
});

// Fix round 1, controller ruling (IMPORTANT 3): a returned failure object
// is a SUCCESSFUL tool call as far as anything scoring replay health is
// concerned (Task 9's sweep counts `successRuns` off the call completing
// at all, never off inspecting the return value for an `error` field), so
// returning the documented failure shape made every failed replay look
// like a success. Every failure path has to throw instead -- pinned here
// both textually and, in the "no Node globals" test above, behaviorally.
test('flow-runner.js throws FLOW_RUNNER_FAILURE on every failure path rather than returning', async () => {
  const source = await readSource();
  assert.match(source, /const fail = \(shape\) => \{\s*\n\s*throw new Error\(`FLOW_RUNNER_FAILURE: \$\{JSON\.stringify\(shape\)\}`\);/);
  // No failure path returns its shape as a value: every one of the four
  // documented failure conditions (bad/missing args, a refused js step, a
  // precondition-navigation failure, a per-step action failure) calls
  // `fail(`/`failArgs(` rather than `return { failedStep`.
  assert.doesNotMatch(source, /return \{\s*\n?\s*failedStep/);
  assert.doesNotMatch(source, /return argFail/);
  // `fail`/`failArgs` are each used at least twice: `failArgs` alone covers
  // four validation conditions, and `fail` is called directly for the js
  // refusal, the precondition failure, and every per-step failure.
  assert.ok((source.match(/\bfailArgs\(/g) || []).length >= 4);
  assert.ok((source.match(/\bfail\(\{/g) || []).length >= 3);
});

// Fix round 1, IMPORTANT 1: `steps.find((step) => step.op === 'goto')`
// would happily pick a MID-FLOW goto in a compiled segment that legitimately
// doesn't start with one, navigating to it early and running every step
// before it against the wrong page -- and even in the common case it
// fetched the entry URL twice (once for the precondition, once again as
// step 0 in the main loop). Fixed by only ever consulting `steps[0]`.
test('flow-runner.js precondition only ever consults steps[0], never scans for a goto', async () => {
  const source = await readSource();
  assert.doesNotMatch(source, /steps\.find/);
  assert.match(source, /const first = steps\[0\];/);
  assert.match(source, /usesStepZero \? 1 : 0|startIndex = 1/);
});

// Fix round 1, IMPORTANT 2: a post-action settle stall must never fail a
// step whose action already completed -- doing so would report
// `stepsCompleted: index` (this step NOT done) for a mutating action that,
// in truth, already ran exactly once, inviting a caller to run it again
// and double-mutate. Pinned structurally: the settle wait sits in its own
// try/catch, textually after (never inside) the action's try/catch.
test("flow-runner.js isolates the post-action settle wait from the action's own try/catch", async () => {
  const source = await readSource();
  const actionCatch = source.indexOf('failedStep: index,');
  const settleTry = source.indexOf('await settleNetwork();');
  assert.ok(actionCatch >= 0 && settleTry > actionCatch, 'the settle wait must sit after the action failure handler');
  // The settle call is directly wrapped by its OWN try/catch -- not nested
  // inside the switch's try/catch above it, which already closed (proven
  // by the ordering check above) before this one opens.
  assert.match(source, /try \{\s*\n\s*await settleNetwork\(\);\s*\n\s*\} catch \{/);
});

test('flow-runner.js clamps every supplied arg value before templating (rule 8 / M2)', async () => {
  const source = await readSource();
  const suppliedArgsIndex = source.indexOf('const suppliedArgs = {};');
  const templateIndex = source.indexOf('const template = (text)');
  assert.ok(suppliedArgsIndex >= 0 && templateIndex > suppliedArgsIndex);
  assert.match(source, /suppliedArgs\[key\] = typeof value === 'string' \? boundString\(value\) : value;/);
});

test('flow-runner.js guards an extract step named __proto__ from vanishing (M3)', async () => {
  const source = await readSource();
  assert.match(source, /Object\.create\(null\)/);
});

test('flow-runner.js tags drag\'s two resolved targets with an optional part field (M6)', async () => {
  const source = await readSource();
  assert.match(source, /'source'/);
  assert.match(source, /'dest'/);
  assert.match(source, /if \(part\) entry\.part = part;/);
});

test('flow-runner.js probes an upload target as attached, not visible (M1)', async () => {
  const source = await readSource();
  assert.match(source, /resolveTarget\(step\.target, index, \{ state: 'attached' \}\);\s*\n\s*await locator\.setInputFiles/);
});

test('flow-runner.js settles network with a single bounded call, no dangling second timer (M8)', async () => {
  const source = await readSource();
  assert.match(source, /page\.waitForLoadState\('networkidle', \{ timeout: 5000 \}\)\.catch\(\(\) => \{\}\);/);
  assert.doesNotMatch(source, /Promise\.race/);
});
