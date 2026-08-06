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

test('flow-runner.js dedupes byte-identical probe candidates and escalates once before failing a locator walk (rung 1 + rung 2)', async () => {
  // A stub `page` whose `locator()` returns a locator recording every
  // `waitFor` call it receives (selector + timeout), and whose `waitFor`
  // always rejects -- the walk can never find the target, so this proves
  // how many times, and at what timeouts, it probed rather than whether it
  // eventually succeeded (that's Task 10's e2e coverage for the happy
  // path). Two of `target.locators` are byte-identical (same `kind`, same
  // `selector`) -- rung 1 must collapse them to a single probe per pass,
  // and rung 2 must add exactly one escalated pass (3000ms) once the first
  // pass (1500ms) comes up empty across every deduped candidate: two
  // probes total, never four (two candidates x two passes, the shape a
  // rung-2-without-dedupe implementation would produce).
  const source = await readSource();
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(`(${source})`);
  const macro = script.runInContext(sandbox);

  const waitForCalls = [];
  const duplicateSelector = 'role=button[name="Submit"]';
  const stubPage = {
    url: () => 'http://x/cart',
    on: () => {},
    off: () => {},
    locator: (selector) => ({
      waitFor: async ({ timeout }) => {
        waitForCalls.push({ selector, timeout });
        throw new Error('not found');
      },
    }),
  };

  const flow = {
    schemaVersion: 1,
    name: 'dupe-probe',
    steps: [
      {
        op: 'click',
        target: {
          locators: [
            { kind: 'role', selector: duplicateSelector },
            { kind: 'role', selector: duplicateSelector },
          ],
        },
      },
    ],
  };

  await assert.rejects(
    () => macro(stubPage, { flow, args: {} }),
    (error) => {
      assert.match(error.message, /^FLOW_RUNNER_FAILURE: /);
      const payload = JSON.parse(error.message.slice('FLOW_RUNNER_FAILURE: '.length));
      assert.equal(payload.failedStep, 0);
      assert.deepEqual(payload.locatorFallbacks, []);
      return true;
    },
  );

  assert.deepEqual(waitForCalls, [
    { selector: duplicateSelector, timeout: 1500 },
    { selector: duplicateSelector, timeout: 3000 },
  ]);
});

test('flow-runner.js tags a locatorFallbacks entry the escalated pass found with escalated: true', async () => {
  // A single candidate that only clears the probe at the escalated 3000ms
  // timeout, never at the base 1500ms one -- the first pass misses
  // outright (nothing to fall back to within it), rung 2 is what finds it,
  // and that is exactly the case the entry's `escalated: true` flag exists
  // to record.
  const source = await readSource();
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(`(${source})`);
  const macro = script.runInContext(sandbox);

  const selector = 'role=button[name="Place order"]';
  const stubPage = {
    url: () => 'http://x/cart',
    on: () => {},
    off: () => {},
    locator: () => ({
      waitFor: async ({ timeout }) => {
        if (timeout !== 3000) throw new Error('not found');
      },
      click: async () => {},
    }),
  };

  const flow = {
    schemaVersion: 1,
    name: 'escalated-hit',
    steps: [
      {
        op: 'click',
        target: { locators: [{ kind: 'role', selector }] },
      },
    ],
  };

  const result = await macro(stubPage, { flow, args: {} });
  assert.equal(result.ok, true);
  // `result` is an object from the vm sandbox's own realm, not this file's
  // -- `assert/strict`'s deepEqual also compares prototypes, which differ
  // by realm even for structurally identical plain objects. Round-tripping
  // through JSON (as the FLOW_RUNNER_FAILURE payload already does for the
  // failure path above) reconstructs plain objects in THIS realm so the
  // comparison is about content, not which realm built it.
  const locatorFallbacks = JSON.parse(JSON.stringify(result.locatorFallbacks));
  assert.deepEqual(locatorFallbacks, [
    { step: 0, usedKind: 'role', usedIndex: 0, escalated: true },
  ]);
});

test('flow-runner.js omits the escalated key entirely on a fallback the first pass already found', async () => {
  // Two distinct (non-duplicate) candidates: index 0 never clears the
  // probe at any timeout, index 1 clears it at the base 1500ms timeout --
  // an ordinary rung-1 fallback, no escalation involved. The resulting
  // entry must have NO `escalated` property at all, not merely a falsy
  // one -- `hasOwnProperty` is checked directly rather than relying on
  // `deepEqual`'s own key-set comparison, so a regression that started
  // emitting `escalated: false` here would be caught on its own terms.
  const source = await readSource();
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(`(${source})`);
  const macro = script.runInContext(sandbox);

  const missingSelector = 'role=button[name="Missing"]';
  const hitSelector = 'role=button[name="Place order"]';
  const stubPage = {
    url: () => 'http://x/cart',
    on: () => {},
    off: () => {},
    locator: (selector) => ({
      waitFor: async ({ timeout }) => {
        if (selector === hitSelector && timeout === 1500) return;
        throw new Error('not found');
      },
      click: async () => {},
    }),
  };

  const flow = {
    schemaVersion: 1,
    name: 'first-pass-fallback',
    steps: [
      {
        op: 'click',
        target: {
          locators: [
            { kind: 'role', selector: missingSelector },
            { kind: 'role', selector: hitSelector },
          ],
        },
      },
    ],
  };

  const result = await macro(stubPage, { flow, args: {} });
  assert.equal(result.ok, true);
  assert.equal(result.locatorFallbacks.length, 1);
  // See the sibling escalated-pass test above for why `entry` (a sandbox-
  // realm object) has to go through this file's own JSON round-trip before
  // `hasOwnProperty` is a meaningful check on it here.
  const [entry] = JSON.parse(JSON.stringify(result.locatorFallbacks));
  assert.deepEqual(entry, { step: 0, usedKind: 'role', usedIndex: 1 });
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'escalated'), false);
});

test('flow-runner.js collects up to 12 bounded, clamped candidates on a locator-miss failure, as the payload\'s last key (WS3a Task 2)', async () => {
  // A locator-miss step failure (both probe passes exhaust every deduped
  // candidate -- the exact case Task 1's tests above cover) is the one
  // failure a host-side heal module can act on: this proves the enrichment
  // that failure now carries. The stub `page.locator()` below plays two
  // roles depending on the selector it receives, matching how the real
  // macro calls it: the target's own candidate selector (no comma) always
  // misses both probe passes, forcing the failure; the bounded interactive-
  // element scan selector (a comma-joined compound CSS selector -- see
  // MACROS.md/the code comment for why a single compound scan beats
  // enumerating each role separately) resolves via `.all()` to 13 fake
  // elements, one more than the 12-candidate cap, so dropping the 13th
  // proves the bound is enforced rather than merely documented.
  const source = await readSource();
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(`(${source})`);
  const macro = script.runInContext(sandbox);

  const LONG_LABEL = 'x'.repeat(120);
  const LONG_TEXT = 'y'.repeat(90);
  const fakeElements = [];
  for (let i = 0; i < 13; i += 1) {
    fakeElements.push({
      getAttribute: async (attr) => {
        if (attr === 'role') return i === 0 ? 'button' : null;
        if (attr === 'aria-label') return i === 0 ? LONG_LABEL : null;
        if (attr === 'data-testid') return `cand-${i}`;
        return null;
      },
      innerText: async () => (i === 0 ? LONG_TEXT : `text-${i}`),
      // WS3b Task 5: element 0 carries an explicit `role` attribute above,
      // so implicit-role derivation never reads this element's tag (an
      // explicit attribute always wins -- see the derivation tests below).
      // Elements 1+ have no `role` attribute, so derivation DOES run for
      // them; `DIV` is not in the Scope ruling's tag map, so it derives no
      // role, keeping this test's existing `role: ''` assertion on element 1
      // intact.
      evaluate: async () => ({ tagName: 'DIV', type: null, hasHref: false }),
    });
  }

  const stubPage = {
    url: () => 'http://x/cart',
    on: () => {},
    off: () => {},
    locator: (selector) => {
      if (selector.indexOf(',') >= 0) {
        return { all: async () => fakeElements };
      }
      return {
        waitFor: async () => {
          throw new Error('not found');
        },
      };
    },
  };

  const flow = {
    schemaVersion: 1,
    name: 'candidate-enrichment',
    steps: [
      {
        op: 'click',
        target: { locators: [{ kind: 'role', selector: 'role=button[name="Go"]' }] },
      },
    ],
  };

  await assert.rejects(
    () => macro(stubPage, { flow, args: {} }),
    (error) => {
      assert.match(error.message, /^FLOW_RUNNER_FAILURE: /);
      const payload = JSON.parse(error.message.slice('FLOW_RUNNER_FAILURE: '.length));
      assert.equal(payload.failedStep, 0);
      assert.equal(payload.error, 'no locator candidate matched');
      // `candidates` must be the payload's LAST key -- every existing key
      // stays exactly where it was (additive-only contract).
      assert.deepEqual(Object.keys(payload), [
        'failedStep', 'error', 'url', 'stepsCompleted', 'locatorFallbacks', 'candidates',
      ]);
      assert.equal(payload.candidates.length, 12, 'the 13th offered candidate must be dropped by the 12-candidate bound');
      assert.deepEqual(
        payload.candidates.map((c) => c.testid),
        Array.from({ length: 12 }, (_, i) => `cand-${i}`),
        'must keep the first 12 in order and drop cand-12 (the 13th)',
      );
      assert.equal(payload.candidates[0].role, 'button');
      assert.equal(payload.candidates[0].name.length, 80, 'every extracted string is clamped to 80 chars');
      assert.equal(payload.candidates[0].name, 'x'.repeat(80));
      assert.equal(payload.candidates[0].text.length, 80);
      assert.equal(payload.candidates[0].text, 'y'.repeat(80));
      assert.equal(payload.candidates[1].role, '', 'a missing attribute reads as an empty string, not null/undefined');
      return true;
    },
  );
});

test('flow-runner.js never adds a candidates key to an args-validation failure payload (WS3a Task 2)', async () => {
  const source = await readSource();
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(`(${source})`);
  const macro = script.runInContext(sandbox);

  const stubPage = { url: () => 'http://x/', on: () => {}, off: () => {} };
  await assert.rejects(
    () => macro(stubPage, { flow: { schemaVersion: 2 }, args: {} }),
    (error) => {
      const payload = JSON.parse(error.message.slice('FLOW_RUNNER_FAILURE: '.length));
      assert.equal(payload.failedStep, 'args');
      assert.equal(Object.prototype.hasOwnProperty.call(payload, 'candidates'), false);
      return true;
    },
  );
});

test('flow-runner.js degrades to the plain failure payload, original error intact, when candidate collection itself throws (WS3a Task 2)', async () => {
  // Enrichment is fully try/caught around the WHOLE collection, not
  // per-element: a collection failure must never mask or replace the
  // original step failure it is trying to enrich. `page.locator()` throws
  // synchronously (not merely rejects) for the compound scan selector here,
  // proving the guard catches a sync throw inside the async collector too.
  const source = await readSource();
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(`(${source})`);
  const macro = script.runInContext(sandbox);

  const stubPage = {
    url: () => 'http://x/cart',
    on: () => {},
    off: () => {},
    locator: (selector) => {
      if (selector.indexOf(',') >= 0) {
        throw new Error('scan blew up');
      }
      return {
        waitFor: async () => {
          throw new Error('not found');
        },
      };
    },
  };

  const flow = {
    schemaVersion: 1,
    name: 'enrichment-throws',
    steps: [
      {
        op: 'click',
        target: { locators: [{ kind: 'role', selector: 'role=button[name="Go"]' }] },
      },
    ],
  };

  await assert.rejects(
    () => macro(stubPage, { flow, args: {} }),
    (error) => {
      const payload = JSON.parse(error.message.slice('FLOW_RUNNER_FAILURE: '.length));
      assert.equal(payload.failedStep, 0);
      assert.equal(payload.error, 'no locator candidate matched', 'the original error must survive an enrichment failure untouched');
      assert.deepEqual(Object.keys(payload), ['failedStep', 'error', 'url', 'stepsCompleted', 'locatorFallbacks']);
      return true;
    },
  );
});

test('flow-runner.js never adds a candidates key to a step failure that is not a locator miss (WS3a Task 2)', async () => {
  // Same catch site as the locator-miss case above (a step's action throws
  // after its target already resolved), but a different error message --
  // proving enrichment is gated on the exact 'no locator candidate matched'
  // message resolveTarget's own rung-2 miss throws, not on "any step
  // failure".
  const source = await readSource();
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(`(${source})`);
  const macro = script.runInContext(sandbox);

  const stubPage = {
    url: () => 'http://x/cart',
    on: () => {},
    off: () => {},
    locator: () => ({
      waitFor: async ({ timeout }) => {
        if (timeout === 1500) return;
        throw new Error('not found');
      },
      click: async () => {
        throw new Error('boom');
      },
    }),
  };

  const flow = {
    schemaVersion: 1,
    name: 'action-failure-not-a-miss',
    steps: [
      {
        op: 'click',
        target: { locators: [{ kind: 'role', selector: 'role=button[name="Go"]' }] },
      },
    ],
  };

  await assert.rejects(
    () => macro(stubPage, { flow, args: {} }),
    (error) => {
      const payload = JSON.parse(error.message.slice('FLOW_RUNNER_FAILURE: '.length));
      assert.equal(payload.error, 'boom');
      assert.equal(Object.prototype.hasOwnProperty.call(payload, 'candidates'), false);
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

// --- WS3a Task 3: rung 3, quirk-based interrupt recovery ---
// Every test below embeds `quirks` alongside `flow`/`args` in the same
// invocation object the macro receives, per Shared shapes. A stub
// `page.locator()` distinguishes the quirk's own selector from the step's
// target selector (and, where candidate enrichment also fires, from the
// bounded compound scan selector Task 2's collector uses) so each test can
// pin exactly which locator was probed, and how many times.

test('flow-runner.js dismisses a matching quirk once and gives the step one more probe-then-act pass on a locator miss (WS3a Task 3)', async () => {
  // The step's own target only clears its probe once the quirk has been
  // clicked (simulating an interrupt covering it beforehand) -- proving
  // the runner actually dismissed the quirk BEFORE the step's post-quirk
  // pass, not merely that both happened to succeed independently.
  const source = await readSource();
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(`(${source})`);
  const macro = script.runInContext(sandbox);

  const stepSelector = 'role=button[name="Buy now"]';
  const quirkSelector = '#cookie-accept';
  let quirkClickCount = 0;
  let dismissed = false;
  const stubPage = {
    url: () => 'http://x/checkout',
    on: () => {},
    off: () => {},
    locator: (selector) => {
      if (selector === quirkSelector) {
        return {
          waitFor: async () => {},
          click: async () => {
            quirkClickCount += 1;
            dismissed = true;
          },
        };
      }
      return {
        waitFor: async () => {
          if (!dismissed) throw new Error('not found');
        },
        click: async () => {},
      };
    },
  };

  const flow = {
    schemaVersion: 1,
    name: 'quirk-recovery-success',
    steps: [
      { op: 'click', target: { locators: [{ kind: 'role', selector: stepSelector }] } },
    ],
  };
  const quirks = [
    {
      name: 'cookie-banner',
      urlPattern: null,
      target: { locators: [{ kind: 'css', selector: quirkSelector }] },
      action: 'click',
    },
  ];

  const result = await macro(stubPage, { flow, args: {}, quirks });
  assert.equal(result.ok, true);
  assert.equal(quirkClickCount, 1, 'the quirk must be clicked exactly once');
  // See the escalated-pass test above for why a sandbox-realm value needs
  // this file's own JSON round-trip before deepEqual is meaningful.
  const locatorFallbacks = JSON.parse(JSON.stringify(result.locatorFallbacks));
  assert.deepEqual(locatorFallbacks, [
    { step: 0, usedKind: 'role', usedIndex: 0, escalated: true },
  ]);
});

test('flow-runner.js records quirkAttempted alongside candidates when the post-quirk pass still misses (WS3a Task 3)', async () => {
  // The quirk itself is present and gets clicked, but dismissing it never
  // actually reveals the step's own target -- the post-quirk pass misses
  // too, so the step still fails, and the failure payload must show BOTH
  // that a quirk was tried and (since the final miss is again a locator
  // miss) the usual candidate evidence, with `quirkAttempted` ordered
  // before `candidates` (additive-only, candidates stays last).
  const source = await readSource();
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(`(${source})`);
  const macro = script.runInContext(sandbox);

  const stepSelector = 'role=button[name="Buy now"]';
  const quirkSelector = '#cookie-accept';
  const fakeElement = {
    getAttribute: async (attr) => (attr === 'role' ? 'button' : null),
    innerText: async () => 'Buy now',
  };
  const stubPage = {
    url: () => 'http://x/checkout',
    on: () => {},
    off: () => {},
    locator: (selector) => {
      if (selector === quirkSelector) {
        return { waitFor: async () => {}, click: async () => {} };
      }
      if (typeof selector === 'string' && selector.indexOf(',') >= 0) {
        return { all: async () => [fakeElement] };
      }
      return {
        waitFor: async () => {
          throw new Error('not found');
        },
      };
    },
  };

  const flow = {
    schemaVersion: 1,
    name: 'quirk-recovery-still-misses',
    steps: [
      { op: 'click', target: { locators: [{ kind: 'role', selector: stepSelector }] } },
    ],
  };
  const quirks = [
    {
      name: 'cookie-banner',
      urlPattern: null,
      target: { locators: [{ kind: 'css', selector: quirkSelector }] },
      action: 'click',
    },
  ];

  await assert.rejects(
    () => macro(stubPage, { flow, args: {}, quirks }),
    (error) => {
      assert.match(error.message, /^FLOW_RUNNER_FAILURE: /);
      const payload = JSON.parse(error.message.slice('FLOW_RUNNER_FAILURE: '.length));
      assert.equal(payload.failedStep, 0);
      assert.equal(payload.error, 'no locator candidate matched');
      assert.equal(payload.quirkAttempted, 'cookie-banner');
      assert.equal(payload.candidates.length, 1);
      assert.deepEqual(Object.keys(payload), [
        'failedStep', 'error', 'url', 'stepsCompleted', 'locatorFallbacks', 'quirkAttempted', 'candidates',
      ]);
      return true;
    },
  );
});

test('flow-runner.js never probes a quirk whose urlPattern does not match the current page (WS3a Task 3)', async () => {
  const source = await readSource();
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(`(${source})`);
  const macro = script.runInContext(sandbox);

  const stepSelector = 'role=button[name="Buy now"]';
  const quirkSelector = '#cookie-accept';
  let quirkLocatorCalls = 0;
  const stubPage = {
    url: () => 'http://x/checkout',
    on: () => {},
    off: () => {},
    locator: (selector) => {
      if (selector === quirkSelector) {
        quirkLocatorCalls += 1;
        return { waitFor: async () => {}, click: async () => {} };
      }
      if (typeof selector === 'string' && selector.indexOf(',') >= 0) {
        return { all: async () => [] };
      }
      return {
        waitFor: async () => {
          throw new Error('not found');
        },
      };
    },
  };

  const flow = {
    schemaVersion: 1,
    name: 'quirk-url-mismatch',
    steps: [
      { op: 'click', target: { locators: [{ kind: 'role', selector: stepSelector }] } },
    ],
  };
  const quirks = [
    {
      name: 'cookie-banner',
      urlPattern: '/other-page',
      target: { locators: [{ kind: 'css', selector: quirkSelector }] },
      action: 'click',
    },
  ];

  await assert.rejects(
    () => macro(stubPage, { flow, args: {}, quirks }),
    (error) => {
      const payload = JSON.parse(error.message.slice('FLOW_RUNNER_FAILURE: '.length));
      assert.equal(Object.prototype.hasOwnProperty.call(payload, 'quirkAttempted'), false);
      return true;
    },
  );
  assert.equal(quirkLocatorCalls, 0, 'a non-matching urlPattern must never probe the quirk target');
});

test("flow-runner.js matches a quirk's non-null urlPattern by path only, ignoring query and hash (WS3a Task 3)", async () => {
  const source = await readSource();
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(`(${source})`);
  const macro = script.runInContext(sandbox);

  const stepSelector = 'role=button[name="Buy now"]';
  const quirkSelector = '#cookie-accept';
  let dismissed = false;
  const stubPage = {
    url: () => 'http://x/checkout?ref=email#top',
    on: () => {},
    off: () => {},
    locator: (selector) => {
      if (selector === quirkSelector) {
        return { waitFor: async () => {}, click: async () => { dismissed = true; } };
      }
      return {
        waitFor: async () => {
          if (!dismissed) throw new Error('not found');
        },
        click: async () => {},
      };
    },
  };

  const flow = {
    schemaVersion: 1,
    name: 'quirk-url-exact-path-match',
    steps: [
      { op: 'click', target: { locators: [{ kind: 'role', selector: stepSelector }] } },
    ],
  };
  const quirks = [
    {
      name: 'cookie-banner',
      urlPattern: '/checkout',
      target: { locators: [{ kind: 'css', selector: quirkSelector }] },
      action: 'click',
    },
  ];

  const result = await macro(stubPage, { flow, args: {}, quirks });
  assert.equal(result.ok, true, 'a urlPattern matching the path alone must fire despite query/hash on the live URL');
});

test("flow-runner.js skips a quirk entry whose action is not 'click' (WS3a Task 3)", async () => {
  const source = await readSource();
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(`(${source})`);
  const macro = script.runInContext(sandbox);

  const stepSelector = 'role=button[name="Buy now"]';
  const quirkSelector = '#cookie-accept';
  let quirkLocatorCalls = 0;
  const stubPage = {
    url: () => 'http://x/checkout',
    on: () => {},
    off: () => {},
    locator: (selector) => {
      if (selector === quirkSelector) {
        quirkLocatorCalls += 1;
        return { waitFor: async () => {}, click: async () => {} };
      }
      if (typeof selector === 'string' && selector.indexOf(',') >= 0) {
        return { all: async () => [] };
      }
      return {
        waitFor: async () => {
          throw new Error('not found');
        },
      };
    },
  };

  const flow = {
    schemaVersion: 1,
    name: 'quirk-non-click-action',
    steps: [
      { op: 'click', target: { locators: [{ kind: 'role', selector: stepSelector }] } },
    ],
  };
  const quirks = [
    {
      name: 'cookie-banner',
      urlPattern: null,
      target: { locators: [{ kind: 'css', selector: quirkSelector }] },
      action: 'hover',
    },
  ];

  await assert.rejects(
    () => macro(stubPage, { flow, args: {}, quirks }),
    (error) => {
      const payload = JSON.parse(error.message.slice('FLOW_RUNNER_FAILURE: '.length));
      assert.equal(Object.prototype.hasOwnProperty.call(payload, 'quirkAttempted'), false);
      return true;
    },
  );
  assert.equal(quirkLocatorCalls, 0, 'a non-click quirk entry must be skipped before ever probing its target');
});

test('flow-runner.js silently skips a quirk entry with a non-string name or non-array target.locators (WS3a Task 3)', async () => {
  const source = await readSource();
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(`(${source})`);
  const macro = script.runInContext(sandbox);

  const stepSelector = 'role=button[name="Buy now"]';
  const stubPage = {
    url: () => 'http://x/checkout',
    on: () => {},
    off: () => {},
    locator: (selector) => {
      if (typeof selector === 'string' && selector.indexOf(',') >= 0) {
        return { all: async () => [] };
      }
      return {
        waitFor: async () => {
          throw new Error('not found');
        },
      };
    },
  };

  const flow = {
    schemaVersion: 1,
    name: 'quirk-malformed-entries',
    steps: [
      { op: 'click', target: { locators: [{ kind: 'role', selector: stepSelector }] } },
    ],
  };
  const quirks = [
    { name: 42, urlPattern: null, target: { locators: [{ kind: 'css', selector: '#a' }] }, action: 'click' },
    { name: 'no-locators-array', urlPattern: null, target: { locators: 'nope' }, action: 'click' },
  ];

  await assert.rejects(
    () => macro(stubPage, { flow, args: {}, quirks }),
    (error) => {
      const payload = JSON.parse(error.message.slice('FLOW_RUNNER_FAILURE: '.length));
      assert.equal(Object.prototype.hasOwnProperty.call(payload, 'quirkAttempted'), false);
      return true;
    },
  );
});

test('flow-runner.js never attempts a quirk when args.quirks is absent or empty -- rung disabled (WS3a Task 3)', async () => {
  const source = await readSource();
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(`(${source})`);
  const macro = script.runInContext(sandbox);

  const stepSelector = 'role=button[name="Buy now"]';
  const stubPage = {
    url: () => 'http://x/checkout',
    on: () => {},
    off: () => {},
    locator: (selector) => {
      if (typeof selector === 'string' && selector.indexOf(',') >= 0) {
        return { all: async () => [] };
      }
      return {
        waitFor: async () => {
          throw new Error('not found');
        },
      };
    },
  };

  const flow = {
    schemaVersion: 1,
    name: 'quirk-rung-disabled',
    steps: [
      { op: 'click', target: { locators: [{ kind: 'role', selector: stepSelector }] } },
    ],
  };

  // Absent entirely.
  await assert.rejects(
    () => macro(stubPage, { flow, args: {} }),
    (error) => {
      const payload = JSON.parse(error.message.slice('FLOW_RUNNER_FAILURE: '.length));
      assert.equal(Object.prototype.hasOwnProperty.call(payload, 'quirkAttempted'), false);
      return true;
    },
  );

  // Present but empty.
  await assert.rejects(
    () => macro(stubPage, { flow, args: {}, quirks: [] }),
    (error) => {
      const payload = JSON.parse(error.message.slice('FLOW_RUNNER_FAILURE: '.length));
      assert.equal(Object.prototype.hasOwnProperty.call(payload, 'quirkAttempted'), false);
      return true;
    },
  );
});

test('flow-runner.js gives every step its own fresh quirk budget, never reusing an earlier step\'s attempt (WS3a Task 3)', async () => {
  // Step A's target only clears once the quirk has been clicked at least
  // once; step B's target only clears once the quirk has been clicked at
  // least TWICE -- forcing step B to make its OWN quirk attempt rather
  // than free-riding on step A's. If a single run-wide flag ever gated
  // this instead of a per-step check, step B's post-quirk pass would
  // still see the target missing and the whole replay would fail here.
  const source = await readSource();
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(`(${source})`);
  const macro = script.runInContext(sandbox);

  const quirkSelector = '#cookie-accept';
  const stepASelector = 'role=button[name="Step A"]';
  const stepBSelector = 'role=button[name="Step B"]';
  let dismissCount = 0;
  const stubPage = {
    url: () => 'http://x/checkout',
    on: () => {},
    off: () => {},
    locator: (selector) => {
      if (selector === quirkSelector) {
        return { waitFor: async () => {}, click: async () => { dismissCount += 1; } };
      }
      if (selector === stepASelector) {
        return {
          waitFor: async () => {
            if (dismissCount < 1) throw new Error('not found');
          },
          click: async () => {},
        };
      }
      if (selector === stepBSelector) {
        return {
          waitFor: async () => {
            if (dismissCount < 2) throw new Error('not found');
          },
          click: async () => {},
        };
      }
      throw new Error(`unexpected selector: ${selector}`);
    },
  };

  const flow = {
    schemaVersion: 1,
    name: 'quirk-per-step-budget',
    steps: [
      { op: 'click', target: { locators: [{ kind: 'role', selector: stepASelector }] } },
      { op: 'click', target: { locators: [{ kind: 'role', selector: stepBSelector }] } },
    ],
  };
  const quirks = [
    {
      name: 'cookie-banner',
      urlPattern: null,
      target: { locators: [{ kind: 'css', selector: quirkSelector }] },
      action: 'click',
    },
  ];

  const result = await macro(stubPage, { flow, args: {}, quirks });
  assert.equal(result.ok, true);
  assert.equal(dismissCount, 2, 'each step must get its own fresh quirk attempt rather than sharing one budget');
});

test('flow-runner.js treats a quirk click failure as best-effort: never attempted again, the step still gets its post-quirk pass (WS3a Task 3)', async () => {
  const source = await readSource();
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(`(${source})`);
  const macro = script.runInContext(sandbox);

  const stepSelector = 'role=button[name="Buy now"]';
  const quirkSelector = '#cookie-accept';
  let quirkClickCount = 0;
  const stubPage = {
    url: () => 'http://x/checkout',
    on: () => {},
    off: () => {},
    locator: (selector) => {
      if (selector === quirkSelector) {
        return {
          waitFor: async () => {},
          click: async () => {
            quirkClickCount += 1;
            throw new Error('element detached mid-click');
          },
        };
      }
      // The step's own target still never resolves -- the click failure
      // above must not stop the runner from giving it its one more pass.
      return {
        waitFor: async () => {
          throw new Error('not found');
        },
      };
    },
  };

  const flow = {
    schemaVersion: 1,
    name: 'quirk-click-throws',
    steps: [
      { op: 'click', target: { locators: [{ kind: 'role', selector: stepSelector }] } },
    ],
  };
  const quirks = [
    {
      name: 'cookie-banner',
      urlPattern: null,
      target: { locators: [{ kind: 'css', selector: quirkSelector }] },
      action: 'click',
    },
  ];

  await assert.rejects(
    () => macro(stubPage, { flow, args: {}, quirks }),
    (error) => {
      const payload = JSON.parse(error.message.slice('FLOW_RUNNER_FAILURE: '.length));
      assert.equal(payload.quirkAttempted, 'cookie-banner', 'the attempt still counts even though the click itself threw');
      return true;
    },
  );
  assert.equal(quirkClickCount, 1, 'a failed click must never be attempted a second time');
});

test('flow-runner.js degrades a quirk with a malformed locator element to no dismissal, never masking the original failure (WS3a Task 3, fix round 1)', async () => {
  // `target.locators` passes the shape check (it IS an array), but the one
  // element in it is `null` -- a quirk is advisory data this runner does
  // not otherwise trust, so a malformed ELEMENT inside an otherwise
  // shape-valid quirk must degrade to "this quirk doesn't work, no
  // dismissal happened" rather than throwing a raw TypeError out of the
  // step's catch block and losing the FLOW_RUNNER_FAILURE contract
  // entirely (reviewer finding, fix round 1).
  const source = await readSource();
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(`(${source})`);
  const macro = script.runInContext(sandbox);

  const stepSelector = 'role=button[name="Buy now"]';
  const stubPage = {
    url: () => 'http://x/checkout',
    on: () => {},
    off: () => {},
    locator: (selector) => {
      if (typeof selector === 'string' && selector.indexOf(',') >= 0) {
        return { all: async () => [] };
      }
      return {
        waitFor: async () => {
          throw new Error('not found');
        },
      };
    },
  };

  const flow = {
    schemaVersion: 1,
    name: 'quirk-malformed-locator-element',
    steps: [
      { op: 'click', target: { locators: [{ kind: 'role', selector: stepSelector }] } },
    ],
  };
  const quirks = [
    {
      name: 'cookie-banner',
      urlPattern: null,
      target: { locators: [null] },
      action: 'click',
    },
  ];

  await assert.rejects(
    () => macro(stubPage, { flow, args: {}, quirks }),
    (error) => {
      assert.match(error.message, /^FLOW_RUNNER_FAILURE: /);
      const payload = JSON.parse(error.message.slice('FLOW_RUNNER_FAILURE: '.length));
      assert.equal(payload.failedStep, 0);
      assert.equal(payload.error, 'no locator candidate matched', 'the ORIGINAL error, not a raw TypeError from the malformed quirk element');
      assert.equal(Object.prototype.hasOwnProperty.call(payload, 'quirkAttempted'), false);
      return true;
    },
  );
});

// --- WS3b Task 6: rung 3 extends to act-phase interception ---
// WS3a's rung 3 (above) only fires on a LOCATOR miss -- an overlay that
// merely intercepts pointer events, never affecting the target's own
// 'visible' state, lets both probe passes hit, so `resolveTarget` never
// throws and the step's ACT throws instead, after resolution already
// succeeded. These tests pin the extension: the step's ACT throwing a
// message matching Playwright's own pointer-interception signature
// (`/intercepts pointer events/`, verified against the vendored
// playwright-core actionability implementation -- see the flow-runner doc
// comment) is eligible for the identical one-quirk-per-step budget, with
// the post-quirk pass re-attempting ONLY the action against the
// already-resolved target rather than re-walking locators.

test("flow-runner.js recovers a click that throws Playwright's pointer-interception timeout via the matching quirk, succeeding on the second act attempt with no quirkAttempted key on success (WS3b Task 6)", async () => {
  // The step's own locator probe succeeds on the FIRST try (the target is
  // visible -- only the click itself is blocked), proving this is genuinely
  // an act-phase recovery, not a repeat of the WS3a locator-miss path. The
  // step's `click` throws the interception message on its first call only;
  // its second call (the post-quirk pass) must land on the SAME resolved
  // Locator object, not a freshly re-resolved one -- `stepClickCount`
  // reaching exactly 2 on ONE stub object proves the reuse.
  const source = await readSource();
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(`(${source})`);
  const macro = script.runInContext(sandbox);

  const stepSelector = 'role=button[name="Buy now"]';
  const quirkSelector = '#cookie-accept';
  let stepClickCount = 0;
  let quirkClickCount = 0;
  const stubPage = {
    url: () => 'http://x/checkout',
    on: () => {},
    off: () => {},
    locator: (selector) => {
      if (selector === quirkSelector) {
        return {
          waitFor: async () => {},
          click: async () => { quirkClickCount += 1; },
        };
      }
      return {
        waitFor: async () => {},
        click: async () => {
          stepClickCount += 1;
          if (stepClickCount === 1) {
            throw new Error('<div id="cookie-banner"> intercepts pointer events');
          }
        },
      };
    },
  };

  const flow = {
    schemaVersion: 1,
    name: 'act-interception-recovery-success',
    steps: [
      { op: 'click', target: { locators: [{ kind: 'role', selector: stepSelector }] } },
    ],
  };
  const quirks = [
    {
      name: 'cookie-banner',
      urlPattern: null,
      target: { locators: [{ kind: 'css', selector: quirkSelector }] },
      action: 'click',
    },
  ];

  const result = await macro(stubPage, { flow, args: {}, quirks });
  assert.equal(result.ok, true);
  assert.equal(stepClickCount, 2, 'the step action must be re-attempted exactly once, on the same resolved target, after the dismissal');
  assert.equal(quirkClickCount, 1, 'the quirk must be clicked exactly once');
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'quirkAttempted'), false, 'quirkAttempted must never appear on a success payload');
  // No locatorFallbacks entry either: the post-quirk act reuses the already
  // -resolved Locator rather than running a second, escalated probe pass.
  const locatorFallbacks = JSON.parse(JSON.stringify(result.locatorFallbacks));
  assert.deepEqual(locatorFallbacks, []);
});

test("flow-runner.js keeps the step's ORIGINAL interception error (not the second act's) when the post-quirk act attempt fails too, still recording quirkAttempted and no candidates (WS3b Task 6)", async () => {
  // The second act attempt throws a DIFFERENT message ('Target closed')
  // than the first (the interception signature) -- proving the payload
  // reports the FIRST, most-legible diagnosis, not whatever the second act
  // attempt happened to throw. This is the documented divergence from the
  // WS3a probe-miss branch, which reports the post-quirk PASS's own fresh
  // throw.
  const source = await readSource();
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(`(${source})`);
  const macro = script.runInContext(sandbox);

  const stepSelector = 'role=button[name="Buy now"]';
  const quirkSelector = '#cookie-accept';
  let stepClickCount = 0;
  const stubPage = {
    url: () => 'http://x/checkout',
    on: () => {},
    off: () => {},
    locator: (selector) => {
      if (selector === quirkSelector) {
        return { waitFor: async () => {}, click: async () => {} };
      }
      if (typeof selector === 'string' && selector.indexOf(',') >= 0) {
        return { all: async () => [] };
      }
      return {
        waitFor: async () => {},
        click: async () => {
          stepClickCount += 1;
          if (stepClickCount === 1) {
            throw new Error('<div id="cookie-banner"> intercepts pointer events');
          }
          throw new Error('Target closed');
        },
      };
    },
  };

  const flow = {
    schemaVersion: 1,
    name: 'act-interception-recovery-second-act-fails',
    steps: [
      { op: 'click', target: { locators: [{ kind: 'role', selector: stepSelector }] } },
    ],
  };
  const quirks = [
    {
      name: 'cookie-banner',
      urlPattern: null,
      target: { locators: [{ kind: 'css', selector: quirkSelector }] },
      action: 'click',
    },
  ];

  await assert.rejects(
    () => macro(stubPage, { flow, args: {}, quirks }),
    (error) => {
      const payload = JSON.parse(error.message.slice('FLOW_RUNNER_FAILURE: '.length));
      assert.equal(payload.failedStep, 0);
      assert.equal(
        payload.error,
        '<div id="cookie-banner"> intercepts pointer events',
        "must keep the ORIGINAL interception message, not the second act's \"Target closed\"",
      );
      assert.equal(payload.quirkAttempted, 'cookie-banner');
      assert.equal(Object.prototype.hasOwnProperty.call(payload, 'candidates'), false, 'an interception failure never carries candidates -- it never matches the locator-miss message that gates enrichment');
      return true;
    },
  );
  assert.equal(stepClickCount, 2, 'exactly one post-quirk act attempt, no more');
});

test("flow-runner.js never probes a quirk for a NON-interception act failure, failing immediately with the original error (WS3b Task 6)", async () => {
  // 'Target closed' does not match the interception signature -- there is
  // no proof the action never fired, so rung 3 must stay ineligible: the
  // quirk's own locator must never even be probed.
  const source = await readSource();
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(`(${source})`);
  const macro = script.runInContext(sandbox);

  const stepSelector = 'role=button[name="Buy now"]';
  const quirkSelector = '#cookie-accept';
  let quirkLocatorCalls = 0;
  const stubPage = {
    url: () => 'http://x/checkout',
    on: () => {},
    off: () => {},
    locator: (selector) => {
      if (selector === quirkSelector) {
        quirkLocatorCalls += 1;
        return { waitFor: async () => {}, click: async () => {} };
      }
      return {
        waitFor: async () => {},
        click: async () => {
          throw new Error('Target closed');
        },
      };
    },
  };

  const flow = {
    schemaVersion: 1,
    name: 'act-non-interception-failure',
    steps: [
      { op: 'click', target: { locators: [{ kind: 'role', selector: stepSelector }] } },
    ],
  };
  const quirks = [
    {
      name: 'cookie-banner',
      urlPattern: null,
      target: { locators: [{ kind: 'css', selector: quirkSelector }] },
      action: 'click',
    },
  ];

  await assert.rejects(
    () => macro(stubPage, { flow, args: {}, quirks }),
    (error) => {
      const payload = JSON.parse(error.message.slice('FLOW_RUNNER_FAILURE: '.length));
      assert.equal(payload.error, 'Target closed');
      assert.equal(Object.prototype.hasOwnProperty.call(payload, 'quirkAttempted'), false);
      return true;
    },
  );
  assert.equal(quirkLocatorCalls, 0, 'a non-interception act failure must never probe the quirk target at all');
});

test('flow-runner.js does not attempt a second quirk dismissal at act time when the step already spent its budget dismissing during the probe phase (WS3b Task 6, shared budget)', async () => {
  // Construct: the step's locator MISSES until the quirk is dismissed
  // (WS3a's existing probe-miss recovery fires first), the post-quirk PROBE
  // then succeeds, but the post-quirk ACT itself throws the interception
  // signature. The shared per-step budget means this must NOT trigger a
  // second, independent quirk-dismissal attempt -- the step simply fails
  // with the interception message and the ONE quirkAttempted already spent.
  const source = await readSource();
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(`(${source})`);
  const macro = script.runInContext(sandbox);

  const stepSelector = 'role=button[name="Buy now"]';
  const quirkSelector = '#cookie-accept';
  let dismissed = false;
  let quirkClickCount = 0;
  let stepClickCount = 0;
  const stubPage = {
    url: () => 'http://x/checkout',
    on: () => {},
    off: () => {},
    locator: (selector) => {
      if (selector === quirkSelector) {
        return {
          waitFor: async () => {},
          click: async () => {
            quirkClickCount += 1;
            dismissed = true;
          },
        };
      }
      if (typeof selector === 'string' && selector.indexOf(',') >= 0) {
        return { all: async () => [] };
      }
      return {
        waitFor: async () => {
          if (!dismissed) throw new Error('not found');
        },
        click: async () => {
          stepClickCount += 1;
          throw new Error('<div id="cookie-banner"> intercepts pointer events');
        },
      };
    },
  };

  const flow = {
    schemaVersion: 1,
    name: 'budget-shared-probe-then-act',
    steps: [
      { op: 'click', target: { locators: [{ kind: 'role', selector: stepSelector }] } },
    ],
  };
  const quirks = [
    {
      name: 'cookie-banner',
      urlPattern: null,
      target: { locators: [{ kind: 'css', selector: quirkSelector }] },
      action: 'click',
    },
  ];

  await assert.rejects(
    () => macro(stubPage, { flow, args: {}, quirks }),
    (error) => {
      const payload = JSON.parse(error.message.slice('FLOW_RUNNER_FAILURE: '.length));
      assert.equal(payload.quirkAttempted, 'cookie-banner');
      assert.equal(payload.error, '<div id="cookie-banner"> intercepts pointer events');
      assert.equal(Object.prototype.hasOwnProperty.call(payload, 'candidates'), false);
      return true;
    },
  );
  assert.equal(quirkClickCount, 1, 'the quirk must be dismissed only once total -- the shared budget, not attempted again at act time');
  assert.equal(stepClickCount, 1, "the step's act only runs once, during the post-quirk pass -- no independent second attempt follows its own failure");
});

test("flow-runner.js recovers a fill step's act-phase interception the same way as click -- the recovery gate is the error message, not step.op (WS3b Task 6)", async () => {
  // Playwright's own actionability implementation only performs the
  // hit-target/interception check for pointer-dispatching actions (click,
  // dblclick, hover, tap, check/uncheck, drag); `fill` waits on
  // visible/enabled/editable only and cannot organically throw this exact
  // message in real Playwright (verified against the vendored
  // playwright-core actionability source -- see the flow-runner doc
  // comment). This test still stubs `fill` throwing it, because the
  // requirement under test is that THIS RUNNER's own eligibility gate is
  // the error message alone, never `step.op` -- so it recovers correctly
  // regardless of which op a message like this is ever observed from.
  const source = await readSource();
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(`(${source})`);
  const macro = script.runInContext(sandbox);

  const stepSelector = 'role=textbox[name="Promo code"]';
  const quirkSelector = '#cookie-accept';
  let stepFillCount = 0;
  let fillValueSeen = null;
  const stubPage = {
    url: () => 'http://x/checkout',
    on: () => {},
    off: () => {},
    locator: (selector) => {
      if (selector === quirkSelector) {
        return { waitFor: async () => {}, click: async () => {} };
      }
      return {
        waitFor: async () => {},
        fill: async (value) => {
          stepFillCount += 1;
          fillValueSeen = value;
          if (stepFillCount === 1) {
            throw new Error('<div id="cookie-banner"> intercepts pointer events');
          }
        },
      };
    },
  };

  const flow = {
    schemaVersion: 1,
    name: 'act-interception-recovery-fill',
    steps: [
      { op: 'fill', target: { locators: [{ kind: 'role', selector: stepSelector }] }, value: 'SAVE10' },
    ],
  };
  const quirks = [
    {
      name: 'cookie-banner',
      urlPattern: null,
      target: { locators: [{ kind: 'css', selector: quirkSelector }] },
      action: 'click',
    },
  ];

  const result = await macro(stubPage, { flow, args: {}, quirks });
  assert.equal(result.ok, true);
  assert.equal(stepFillCount, 2, 'the fill action must be re-attempted exactly once after the dismissal');
  assert.equal(fillValueSeen, 'SAVE10');
});

// --- WS3b Task 5: implicit-role derivation (candidate collection) ---
// Today `role` on a collected candidate comes only from the raw `role`
// ATTRIBUTE, so a plain `<button>Place order</button>` (no `role`, no
// `aria-label`) collects as bare-text-only and heal synthesis (which skips
// text-only candidates) can never use it. This derives a role from the tag
// when the attribute is absent, using the Scope ruling's exact tag map and
// nothing else. Table-driven (one `test()`, several stub/assert cycles
// inside it, each with its own fresh vm sandbox) rather than one `test()`
// per tag/type combination -- the setup and assertion shape are identical
// across every case; only the stubbed tag/type/href and the expected
// derived role differ.
test("flow-runner.js derives an implicit role from tag/type/href when the role attribute is absent -- the Scope ruling's exact tag map, nothing more (WS3b Task 5)", async () => {
  const source = await readSource();

  const cases = [
    { label: 'button, no role attr -> button', tagName: 'BUTTON', type: null, hasHref: false, roleAttr: null, expected: 'button' },
    { label: 'a WITH href, no role attr -> link', tagName: 'A', type: null, hasHref: true, roleAttr: null, expected: 'link' },
    { label: 'a WITHOUT href, no role attr -> no derived role', tagName: 'A', type: null, hasHref: false, roleAttr: null, expected: '' },
    { label: 'select, no role attr -> combobox', tagName: 'SELECT', type: null, hasHref: false, roleAttr: null, expected: 'combobox' },
    { label: 'input type=checkbox, no role attr -> checkbox', tagName: 'INPUT', type: 'checkbox', hasHref: false, roleAttr: null, expected: 'checkbox' },
    { label: 'input type=radio, no role attr -> radio', tagName: 'INPUT', type: 'radio', hasHref: false, roleAttr: null, expected: 'radio' },
    { label: 'input type=submit, no role attr -> button', tagName: 'INPUT', type: 'submit', hasHref: false, roleAttr: null, expected: 'button' },
    { label: 'input type=button, no role attr -> button', tagName: 'INPUT', type: 'button', hasHref: false, roleAttr: null, expected: 'button' },
    { label: 'input type=text, no role attr -> textbox', tagName: 'INPUT', type: 'text', hasHref: false, roleAttr: null, expected: 'textbox' },
    { label: 'input with no type attribute at all, no role attr -> textbox', tagName: 'INPUT', type: null, hasHref: false, roleAttr: null, expected: 'textbox' },
    { label: 'a tag outside the map (div), no role attr -> no derived role', tagName: 'DIV', type: null, hasHref: false, roleAttr: null, expected: '' },
    { label: 'explicit role attribute wins over tag derivation', tagName: 'BUTTON', type: null, hasHref: false, roleAttr: 'tab', expected: 'tab' },
  ];

  for (const testCase of cases) {
    const sandbox = {};
    vm.createContext(sandbox);
    const script = new vm.Script(`(${source})`);
    const macro = script.runInContext(sandbox);

    let evaluateCallCount = 0;
    const fakeElement = {
      getAttribute: async (attr) => (attr === 'role' ? testCase.roleAttr : null),
      innerText: async () => '',
      evaluate: async () => {
        evaluateCallCount += 1;
        return { tagName: testCase.tagName, type: testCase.type, hasHref: testCase.hasHref };
      },
    };

    const stubPage = {
      url: () => 'http://x/cart',
      on: () => {},
      off: () => {},
      locator: (selector) => {
        if (typeof selector === 'string' && selector.indexOf(',') >= 0) {
          return { all: async () => [fakeElement] };
        }
        return {
          waitFor: async () => {
            throw new Error('not found');
          },
        };
      },
    };

    const flow = {
      schemaVersion: 1,
      name: 'implicit-role',
      steps: [
        { op: 'click', target: { locators: [{ kind: 'role', selector: 'role=button[name="Go"]' }] } },
      ],
    };

    await assert.rejects(
      () => macro(stubPage, { flow, args: {} }),
      (error) => {
        const payload = JSON.parse(error.message.slice('FLOW_RUNNER_FAILURE: '.length));
        assert.equal(payload.candidates[0].role, testCase.expected, testCase.label);
        return true;
      },
    );

    // An explicit `role` attribute must short-circuit derivation entirely,
    // not merely win the value: the tagName reads costs a page round trip
    // that has no reason to happen at all once the attribute already
    // answers the question (see the derivation comment in the macro source).
    if (testCase.roleAttr !== null) {
      assert.equal(evaluateCallCount, 0, `${testCase.label}: an explicit role attribute must skip the tagName round trip entirely`);
    }
  }
});

// --- WS3b Task 5: ledgered macro minors deferred from WS3a ---

test("flow-runner.js treats a dismissed quirk named '' as a real dismissal, not a truthiness no-op (WS3b Task 5 ledger: dismissedQuirk !== null)", async () => {
  // A quirk named '' passes the shape check (`typeof quirk.name === 'string'`
  // requires only a string, not a non-empty one) even though the store's own
  // `sites quirk add` kebab-case validation would never persist one -- a
  // caller that embeds `quirks` directly, bypassing the store, still can.
  // `dismissInterrupt` returns the clicked quirk's `name` on a hit, so a
  // click against THIS quirk returns '' -- falsy, but not null. The old `if
  // (dismissedQuirk)` truthiness check treated that exactly like "nothing
  // was dismissed" and skipped the step's post-quirk pass entirely, silently
  // dropping a click that DID happen. `dismissedQuirk !== null` fixes it.
  const source = await readSource();
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(`(${source})`);
  const macro = script.runInContext(sandbox);

  const stepSelector = 'role=button[name="Buy now"]';
  const quirkSelector = '#cookie-accept';
  let quirkClickCount = 0;
  const stubPage = {
    url: () => 'http://x/checkout',
    on: () => {},
    off: () => {},
    locator: (selector) => {
      if (selector === quirkSelector) {
        return {
          waitFor: async () => {},
          click: async () => {
            quirkClickCount += 1;
          },
        };
      }
      if (typeof selector === 'string' && selector.indexOf(',') >= 0) {
        return { all: async () => [] };
      }
      return {
        waitFor: async () => {
          throw new Error('not found');
        },
      };
    },
  };

  const flow = {
    schemaVersion: 1,
    name: 'quirk-empty-name',
    steps: [
      { op: 'click', target: { locators: [{ kind: 'role', selector: stepSelector }] } },
    ],
  };
  const quirks = [
    { name: '', urlPattern: null, target: { locators: [{ kind: 'css', selector: quirkSelector }] }, action: 'click' },
  ];

  await assert.rejects(
    () => macro(stubPage, { flow, args: {}, quirks }),
    (error) => {
      const payload = JSON.parse(error.message.slice('FLOW_RUNNER_FAILURE: '.length));
      assert.equal(payload.quirkAttempted, '', "a dismissal with an empty name must still be reported, not dropped by a truthiness check");
      return true;
    },
  );
  assert.equal(quirkClickCount, 1, 'the empty-named quirk must still be clicked exactly once');
});

test("flow-runner.js probes a quirk at 1500ms and gives the post-quirk pass exactly 3000ms, no other timeout (WS3b Task 5 ledger: rung 3 timeout pins)", async () => {
  // Records every `waitFor` call's selector+timeout using the same
  // recording-stub pattern as the rung 1/2 dedupe test above. Order proves
  // the sequence, not just the set: the step's own rung 1 (1500) then rung 2
  // (3000) both miss first (the quirk has not been dismissed yet), THEN the
  // quirk itself is probed once at 1500ms (dismissInterrupt's own pass never
  // escalates -- it is a dismissal check, not the step's walk), and only
  // after a successful dismissal does the post-quirk pass run, at a single
  // escalated 3000ms (forcedEscalatedOnly skips straight past rung 1).
  const source = await readSource();
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(`(${source})`);
  const macro = script.runInContext(sandbox);

  const stepSelector = 'role=button[name="Buy now"]';
  const quirkSelector = '#cookie-accept';
  const waitForCalls = [];
  let dismissed = false;
  const stubPage = {
    url: () => 'http://x/checkout',
    on: () => {},
    off: () => {},
    locator: (selector) => {
      if (selector === quirkSelector) {
        return {
          waitFor: async ({ timeout }) => {
            waitForCalls.push({ selector, timeout });
          },
          click: async () => {
            dismissed = true;
          },
        };
      }
      return {
        waitFor: async ({ timeout }) => {
          waitForCalls.push({ selector, timeout });
          if (!dismissed) throw new Error('not found');
        },
        click: async () => {},
      };
    },
  };

  const flow = {
    schemaVersion: 1,
    name: 'quirk-timeout-pins',
    steps: [
      { op: 'click', target: { locators: [{ kind: 'role', selector: stepSelector }] } },
    ],
  };
  const quirks = [
    {
      name: 'cookie-banner',
      urlPattern: null,
      target: { locators: [{ kind: 'css', selector: quirkSelector }] },
      action: 'click',
    },
  ];

  const result = await macro(stubPage, { flow, args: {}, quirks });
  assert.equal(result.ok, true);
  assert.deepEqual(waitForCalls, [
    { selector: stepSelector, timeout: 1500 },
    { selector: stepSelector, timeout: 3000 },
    { selector: quirkSelector, timeout: 1500 },
    { selector: stepSelector, timeout: 3000 },
  ]);
});

test('flow-runner.js drops fat candidates from the end until the whole payload is <= 8KB (WS3b Task 5 ledger: boundCandidatesToPayload trim loop)', async () => {
  // Every clamped candidate string field maxes out at 80 characters
  // (CANDIDATE_STRING_CAP); plain ASCII text at that cap across 12
  // candidates never reaches 8KB on its own (~4.4KB), so the trim loop's
  // drop-from-end branch would go untested by accident. Using a double-quote
  // character for all 80 -- each one costs 2 bytes once JSON-escaped (`\"`)
  // -- makes even the 12-candidate (post-MAX_CANDIDATES-cap) payload exceed
  // 8192 bytes (verified: 8341 bytes for this exact shape), forcing the
  // drop-from-end loop to fire for real rather than merely being reachable
  // in principle. 13 elements are offered so the MAX_CANDIDATES cap (Task
  // 2) is exercised first, same as the sibling 12-candidate test above --
  // this test is about what happens to the payload AFTER that cap, not the
  // cap itself.
  const source = await readSource();
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(`(${source})`);
  const macro = script.runInContext(sandbox);

  const FAT = '"'.repeat(200); // clamped to 80 chars, still all quotes
  const fakeElements = [];
  for (let i = 0; i < 13; i += 1) {
    fakeElements.push({
      // Every element carries an explicit (fat) `role` attribute, so
      // implicit-role derivation's `evaluate` round trip is never reached
      // here -- this test is about the trim loop, not role derivation.
      getAttribute: async () => FAT,
      innerText: async () => FAT,
    });
  }

  const stubPage = {
    url: () => 'http://x/cart',
    on: () => {},
    off: () => {},
    locator: (selector) => {
      if (typeof selector === 'string' && selector.indexOf(',') >= 0) {
        return { all: async () => fakeElements };
      }
      return {
        waitFor: async () => {
          throw new Error('not found');
        },
      };
    },
  };

  const flow = {
    schemaVersion: 1,
    name: 'trim-loop',
    steps: [
      { op: 'click', target: { locators: [{ kind: 'role', selector: 'role=button[name="Go"]' }] } },
    ],
  };

  await assert.rejects(
    () => macro(stubPage, { flow, args: {} }),
    (error) => {
      const payload = JSON.parse(error.message.slice('FLOW_RUNNER_FAILURE: '.length));
      assert.ok(
        payload.candidates.length > 0 && payload.candidates.length < 12,
        `expected fewer than 12 (but more than 0) survivors, got ${payload.candidates.length}`,
      );
      const serialized = JSON.stringify(payload);
      assert.ok(serialized.length <= 8192, `expected the full payload to be <= 8192 bytes, got ${serialized.length}`);
      return true;
    },
  );
});

// --- MAT-149: digit-leading arg names sanitized at mint ---
//
// This runner's own `{arg}` substitution regex (`TOKEN`, above) is
// deliberately untouched by MAT-149's fix -- the fix is on the compile
// side (lib/flows/compile.mjs mints only names the regex can match) and
// the parse side (lib/flows/artifact.mjs rejects any that slip through).
// This proves the two ends actually connect: a flow whose arg is already
// sanitized (`arg2faToken`, never `2faToken`) round-trips through this
// runner's real substitution path end to end, with the supplied arg value
// landing in the `goto` step's url exactly where the template placeholder
// was -- the replayability the compile-side fix exists to preserve.
test('flow-runner.js substitutes a sanitized digit-leading arg name ("arg2faToken") into a goto step url end-to-end (MAT-149)', async () => {
  const source = await readSource();
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(`(${source})`);
  const macro = script.runInContext(sandbox);

  const gotoCalls = [];
  const stubPage = {
    url: () => 'https://example.com/',
    on: () => {},
    off: () => {},
    goto: async (url) => { gotoCalls.push(url); },
    waitForLoadState: async () => {},
  };

  const flow = {
    schemaVersion: 1,
    name: 'verify-2fa',
    origin: 'https://example.com',
    args: { arg2faToken: { type: 'string', required: true } },
    steps: [
      { op: 'goto', url: '/verify?2fa_token={arg2faToken}' },
    ],
  };

  const result = await macro(stubPage, { flow, args: { arg2faToken: 'live-otp-value' } });
  assert.equal(result.ok, true);
  assert.deepEqual(gotoCalls, ['https://example.com/verify?2fa_token=live-otp-value']);
});
