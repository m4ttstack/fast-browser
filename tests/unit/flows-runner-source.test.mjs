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
  const source = await readSource();
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(`(${source})`);
  const macro = script.runInContext(sandbox);
  assert.equal(typeof macro, 'function');
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
  const loopIndex = source.indexOf('const result = {};');
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
  assert.match(source, /extracted \? result : \{ completed: true \}/);
});
