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
//
// This will surprise the next author: it means the word "retry" cannot be
// used ANYWHERE in flow-runner.js, including in an unrelated explanatory
// comment that has nothing to do with step replay. That is intentional, not
// an accident of a loose regex -- see above.

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

// Loads the macro the same way the runtime does (a bare expression, no Node
// globals) and drives it with a page stub whose first action throws a given
// message, so the classification of that message can be asserted directly.
async function runWithFailingAction(message) {
  const source = await readSource();
  const macro = new Function(`"use strict"; return (${source});`)();
  const page = {
    url: () => 'https://example.test/start',
    on: () => {},
    off: () => {},
    goto: async () => {},
    locator: () => ({
      fill: async () => { throw new Error(message); },
      click: async () => { throw new Error(message); },
      waitFor: async () => {},
      frames: () => [],
    }),
    waitForLoadState: async () => {},
  };
  const flow = {
    schemaVersion: 1,
    name: 'probe',
    origin: 'https://example.test',
    steps: [
      { op: 'goto', url: 'https://example.test/start' },
      { op: 'fill', target: { locators: [{ kind: 'css', selector: '#username' }] }, value: 'someone' },
    ],
  };

  try {
    await macro(page, { flow });
  } catch (error) {
    return error.message;
  }
  throw new Error('expected the macro to throw');
}

test('a cdp disconnect is classified as SIDECAR_LOST, not an ordinary flow failure', async () => {
  for (const signature of [
    'Target closed',
    'Target crashed',
    'Browser has been closed',
    'WebSocket is not open',
    'Connection closed',
  ]) {
    const message = await runWithFailingAction(signature);
    assert.match(message, /^SIDECAR_LOST: /, `${signature} must classify as a lost sidecar`);
    const shape = JSON.parse(message.slice('SIDECAR_LOST: '.length));
    assert.match(shape.recovery, /restart the flow from navigation/i);
    assert.ok(Object.hasOwn(shape, 'failedStep'));
    assert.ok(Object.hasOwn(shape, 'stepsCompleted'));
  }
});

test('an ordinary step failure keeps the FLOW_RUNNER_FAILURE contract', async () => {
  const message = await runWithFailingAction('locator.fill: element is not visible');
  assert.match(message, /^FLOW_RUNNER_FAILURE: /);
  assert.doesNotMatch(message, /SIDECAR_LOST/);
});

test('the real prefixed cdp-disconnect message classifies as SIDECAR_LOST (fix round 1, review finding 2)', async () => {
  // Verified against the fork this plugin pins: on connection loss every
  // in-flight call rejects with `TargetClosedError`, whose message is
  // exactly `Target page, context or browser has been closed`, prefixed by
  // whichever API call was in flight -- never the `browserContext.newPage:`
  // -prefixed variant the original signature list pinned by mistake (a
  // prefix flow-runner never calls). This is the realistic message shape a
  // genuine disconnect actually produces; the bare 'Target closed' case in
  // the table above only proves the signature list contains that
  // substring, not that a real disconnect message is caught.
  const message = await runWithFailingAction(
    'locator.click: Target page, context or browser has been closed',
  );
  assert.match(message, /^SIDECAR_LOST: /);
});

test('a plain timeout whose call log happens to render "WebSocket API" page content stays FLOW_RUNNER_FAILURE (fix round 1, review finding 1)', async () => {
  // `formatCallLog` (see the doc comment above `isSidecarLost` in the
  // source, and `INTERCEPTION_SIGNATURE` further below) appends a `locator
  // resolved to <previewNode>` line to every channel error, and
  // `previewNode` renders the target element's own attributes/text
  // verbatim -- so a page with a link reading "WebSocket API" would, under
  // a whole-message substring match, turn an ordinary selector timeout into
  // a false SIDECAR_LOST. Anchoring classification to the message's FIRST
  // line only (Playwright's own thrown text, never page content) is what
  // keeps this negative; this call log is built the same way the
  // pre-existing previewNode-forgery tests below construct one.
  const callLogMessage = [
    'locator.click: Timeout 5000ms exceeded.',
    'Call log:',
    '  - waiting for locator(\'role=link[name="WebSocket API"]\')',
    '  -   locator resolved to <a href="/docs/ws">WebSocket API</a>',
    '  -   attempting click action',
  ].join('\n');
  const message = await runWithFailingAction(callLogMessage);
  assert.match(message, /^FLOW_RUNNER_FAILURE: /);
  assert.doesNotMatch(message, /SIDECAR_LOST/);
});

// Mirrors runWithFailingAction above, but the failure is raised by
// `waitFor` itself (target RESOLUTION) rather than by `click`/`fill` (the
// step's ACT) -- the exact distinction fix round 1's probeCandidates change
// exists to preserve. `click`/`fill` on the stub throw a message that could
// never pass as either contract, so if resolution's failure were ever
// masked and the walk pressed on into an ACT call that never should have
// happened, the assertions below would catch it via the wrong message
// rather than by accident going green.
async function runWithFailingResolution(message) {
  const source = await readSource();
  const macro = new Function(`"use strict"; return (${source});`)();
  let actCalls = 0;
  const page = {
    url: () => 'https://example.test/start',
    on: () => {},
    off: () => {},
    goto: async () => {},
    locator: () => ({
      waitFor: async () => { throw new Error(message); },
      click: async () => { actCalls += 1; throw new Error('act must never run: resolution already failed'); },
      fill: async () => { actCalls += 1; throw new Error('act must never run: resolution already failed'); },
      frames: () => [],
    }),
    waitForLoadState: async () => {},
  };
  const flow = {
    schemaVersion: 1,
    name: 'resolution-probe',
    origin: 'https://example.test',
    steps: [
      { op: 'goto', url: 'https://example.test/start' },
      { op: 'click', target: { locators: [{ kind: 'css', selector: '#missing' }] } },
    ],
  };

  try {
    await macro(page, { flow });
  } catch (error) {
    return { message: error.message, actCalls };
  }
  throw new Error('expected the macro to throw');
}

test('a cdp disconnect raised during target resolution is classified as SIDECAR_LOST (fix round 1, Finding 3)', async () => {
  // Before fix round 1, probeCandidates' bare `catch { continue; }`
  // discarded this exact signature and resolveTarget could only ever throw
  // the fixed literal 'no locator candidate matched' -- a resolution-phase
  // disconnect was structurally incapable of reaching isSidecarLost at all.
  const { message, actCalls } = await runWithFailingResolution(
    'locator.waitFor: Target page, context or browser has been closed',
  );
  assert.match(message, /^SIDECAR_LOST: /);
  const shape = JSON.parse(message.slice('SIDECAR_LOST: '.length));
  assert.match(shape.error, /Target page, context or browser has been closed/);
  assert.match(shape.recovery, /restart the flow from navigation/i);
  assert.equal(actCalls, 0, 'a resolution-phase loss must never reach the step\'s own action');
});

test('an ordinary resolution miss still reports FLOW_RUNNER_FAILURE with "no locator candidate matched" (fix round 1 regression guard)', async () => {
  // Same shape of failure (waitFor rejects on every candidate, every rung)
  // as the SIDECAR_LOST case above, but with a message matching no lost-
  // sidecar signature -- proving the fix is a re-throw gated on the actual
  // rejection text, not a re-throw of every resolution failure regardless
  // of cause. The byte-identical contract (including candidate enrichment
  // eligibility, gated on this exact literal) has to survive unchanged.
  const { message, actCalls } = await runWithFailingResolution('element not found');
  assert.match(message, /^FLOW_RUNNER_FAILURE: /);
  assert.doesNotMatch(message, /SIDECAR_LOST/);
  const payload = JSON.parse(message.slice('FLOW_RUNNER_FAILURE: '.length));
  assert.equal(payload.error, 'no locator candidate matched');
  assert.equal(actCalls, 0);
});

// `hasCompletedMutatingStep` (the qualification `fail` uses to choose
// between the two SIDECAR_LOST `recovery` strings) had zero coverage before
// this: the two `restart the flow from navigation` assertions above both use
// flows with no `mutating: true` step at all, so neither can tell the
// mutating branch apart from the plain one, and neither can catch the
// off-by-one this loop bound is exposed to (`i < stepsCompleted` vs
// `i <= stepsCompleted`, which would wrongly count the CURRENTLY FAILING
// step -- never actually completed -- as already having run).
//
// Reused by both tests below: a stub whose `click` always succeeds and
// whose `fill` always throws `message` (a sidecar-lost signature), driving
// a two-step flow whose first step completes and whose second step is the
// one that fails. Only the *placement* of `mutating: true` differs between
// the two call sites, which is exactly the variable under test.
async function runFlowExpectingSidecarLost(flow, message) {
  const source = await readSource();
  const macro = new Function(`"use strict"; return (${source});`)();
  const page = {
    url: () => 'https://example.test/start',
    on: () => {},
    off: () => {},
    goto: async () => {},
    locator: () => ({
      waitFor: async () => {},
      click: async () => {},
      fill: async () => { throw new Error(message); },
      frames: () => [],
    }),
    waitForLoadState: async () => {},
  };
  try {
    await macro(page, { flow });
  } catch (error) {
    return error.message;
  }
  throw new Error('expected the macro to throw');
}

test('SIDECAR_LOST after a completed mutating step tells the caller to verify, not restart (hasCompletedMutatingStep positive case)', async () => {
  // Step 0 is `mutating: true` and completes (click resolves and fires);
  // step 1 is the one that hits the sidecar-lost signature. `stepsCompleted`
  // is pinned to 1, documenting that "completed" means "index < stepsCompleted"
  // -- step 0 is in range, step 1 (the failing step itself) is not.
  const flow = {
    schemaVersion: 1,
    name: 'mutating-completed-probe',
    origin: 'https://example.test',
    steps: [
      { op: 'click', mutating: true, target: { locators: [{ kind: 'css', selector: '#submit' }] } },
      { op: 'fill', target: { locators: [{ kind: 'css', selector: '#username' }] }, value: 'someone' },
    ],
  };
  const message = await runFlowExpectingSidecarLost(
    flow,
    'locator.fill: Target page, context or browser has been closed',
  );
  assert.match(message, /^SIDECAR_LOST: /);
  const shape = JSON.parse(message.slice('SIDECAR_LOST: '.length));
  assert.equal(shape.stepsCompleted, 1, 'only step 0 (the click) had completed');
  // Exact text, read out of flow-runner.js's own `fail()` (source lines
  // ~172-176), not re-derived: a wrong flag name or a broken comparison
  // that still happened to produce SOME string would slip past a looser
  // assertion here.
  assert.equal(
    shape.recovery,
    'do not repeat this call; a completed step was mutating -- verify '
      + 'its effect on the site before deciding whether to continue; '
      + 'when in doubt, stop and report instead of re-running the flow',
  );
  // The negative half matters as much as the positive match above: without
  // it, this test would still pass if both branches of `fail()` happened to
  // emit the same "restart" string -- a regression that flattened the
  // qualification back to the single fixed string it replaced.
  assert.doesNotMatch(shape.recovery, /restart the flow from navigation/i);
});

test('SIDECAR_LOST on the step that is itself failing (never completed) still says restart, even when that step is mutating (hasCompletedMutatingStep boundary case)', async () => {
  // The ONLY mutating step is step 1 -- the one currently throwing the
  // sidecar-lost signature. It never "completed": `stepsCompleted` is 1, so
  // `hasCompletedMutatingStep`'s loop (`i < stepsCompleted`) never visits
  // index 1 at all. This is the case that would silently break if that
  // loop bound were ever widened from `<` to `<=`: a `<=` walk would visit
  // index 1, see `mutating: true`, and wrongly tell the caller to verify a
  // step that never actually ran instead of the correct, safe "restart".
  const flow = {
    schemaVersion: 1,
    name: 'mutating-boundary-probe',
    origin: 'https://example.test',
    steps: [
      { op: 'click', target: { locators: [{ kind: 'css', selector: '#submit' }] } },
      {
        op: 'fill',
        mutating: true,
        target: { locators: [{ kind: 'css', selector: '#username' }] },
        value: 'someone',
      },
    ],
  };
  const message = await runFlowExpectingSidecarLost(
    flow,
    'locator.fill: Target page, context or browser has been closed',
  );
  assert.match(message, /^SIDECAR_LOST: /);
  const shape = JSON.parse(message.slice('SIDECAR_LOST: '.length));
  assert.equal(shape.stepsCompleted, 1, 'only step 0 (the non-mutating click) had completed');
  assert.equal(shape.recovery, 'restart the flow from navigation; do not repeat this call');
  assert.match(shape.recovery, /restart the flow from navigation/i);
});

test('flow-runner.js never says "retry", including in comments', async () => {
  // Duplicated deliberately from the existing canary above: the recovery
  // wording added for SIDECAR_LOST is the most likely accidental
  // reintroduction of that vocabulary.
  const source = await readSource();
  assert.doesNotMatch(source, /retry/i);
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
  // `fail` always terminates by throwing: a SIDECAR_LOST classification
  // throws first when the failure's error text matches a lost-connection
  // signature, and every other case falls through to this exact
  // FLOW_RUNNER_FAILURE throw as `fail`'s last statement -- never a return.
  //
  // Sliced to `fail`'s own block (from its opening line up to the first
  // `\n  };` after it, i.e. a closing brace back at `fail`'s own 2-space
  // indent) before asserting, rather than a greedy `[\s\S]*` scan across the
  // rest of the file (fix round 1, review finding 3): a greedy scan stays
  // green even if the FLOW_RUNNER_FAILURE throw moved into an unrelated
  // LATER helper while `fail` itself regressed to `return shape;` -- exactly
  // the regression this test's own header above says it exists to catch.
  // The nested `if (isSidecarLost(text)) { ... }` block inside `fail` closes
  // at 4-space indent (`\n    }`), never 2-space, so the first `\n  };` this
  // finds is genuinely `fail`'s own close.
  const failStart = source.indexOf('const fail = (shape) => {');
  assert.ok(failStart >= 0, '`fail` must be defined');
  const failEnd = source.indexOf('\n  };', failStart);
  assert.ok(failEnd >= 0, "`fail`'s block must close with `\\n  };`");
  const failBody = source.slice(failStart, failEnd);
  assert.doesNotMatch(failBody, /return\s+shape/);
  assert.match(failBody, /throw new Error\(`FLOW_RUNNER_FAILURE: \$\{JSON\.stringify\(shape\)\}`\);\s*$/);
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
    // Carries an explicit `role` attribute above, so the derived value is
    // discarded -- but WS4a Task 8's flatten still dispatches `evaluate`
    // unconditionally (folded into the same `Promise.all`), so a stub is
    // required here regardless: this test's final failure IS a locator
    // miss, so `collectCandidates()` genuinely runs.
    evaluate: async () => ({ tagName: 'BUTTON', type: null, hasHref: false }),
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
  // A NON-empty compound-selector result: if the `finalMessage ===
  // 'no locator candidate matched'` gate ever regressed and let this
  // interception failure through to `collectCandidates()` anyway, this
  // element would produce a real candidate and the `candidates` key WOULD
  // appear -- an empty list here would let that regression pass silently
  // (candidates: [] never gets attached either way, so the absence
  // assertion below wouldn't discriminate between "the gate correctly
  // skipped enrichment" and "enrichment ran but found nothing").
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
  // 'element detached from DOM' does not match the interception signature
  // (and is not a lost-connection signature either) -- there is no proof
  // the action never fired, so rung 3 must stay ineligible: the quirk's own
  // locator must never even be probed.
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
          throw new Error('element detached from DOM');
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
      assert.equal(payload.error, 'element detached from DOM');
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
  // NON-empty, same rationale as the sibling test above: an empty
  // compound-selector result would let the `candidates` absence assertion
  // below pass even if the message gate that is SUPPOSED to prevent
  // enrichment here ever regressed.
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
        return {
          waitFor: async () => {},
          click: async () => {
            quirkClickCount += 1;
            dismissed = true;
          },
        };
      }
      if (typeof selector === 'string' && selector.indexOf(',') >= 0) {
        return { all: async () => [fakeElement] };
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

// --- WS3b Task 6, review fix round 1: anchor the interception signature ---
// The bare substring `/intercepts pointer events/` is forgeable: Playwright
// appends a call log to EVERY channel error, and that log's own `locator
// resolved to <previewNode>` line renders a page-controlled element's
// attributes/text verbatim -- a page author's `<button aria-label=
// "intercepts pointer events">` puts the phrase inside the call log of ANY
// failure on that element, even one whose action already dispatched. These
// two tests pin the anchored `INTERCEPTION_SIGNATURE` (line-end only, with
// an optional trailing ANSI reset) against exactly that forgery, and
// against a genuine call-log-shaped message carrying a real trailing reset
// code -- the bare, no-ANSI genuine case is already covered by every other
// WS3b Task 6 test above (their messages end the string immediately after
// the phrase, which is what the anchor is supposed to keep matching).

test('flow-runner.js does NOT recover an act failure whose call log merely mentions the interception phrase mid-line inside a previewNode-rendered attribute (WS3b Task 6, review fix round 1)', async () => {
  // The step's REAL failure is a plain timeout -- nothing to do with
  // interception (and not a lost-connection signature either). The call
  // log's `locator resolved to <previewNode>` line (a real Playwright
  // shape) happens to describe an element whose `aria-label` a page author
  // set to the exact phrase; on the OLD unanchored regex this substring
  // match would have (wrongly) treated a non-interception,
  // possibly-already-dispatched failure as recoverable. The quirk locator
  // must never even be probed.
  const source = await readSource();
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(`(${source})`);
  const macro = script.runInContext(sandbox);

  const stepSelector = 'role=button[name="Buy now"]';
  const quirkSelector = '#cookie-accept';
  let quirkLocatorCalls = 0;
  const forgedMessage = [
    'page.click: Timeout 5000ms exceeded',
    'Call log:',
    '  - waiting for locator(\'role=button[name="Buy now"]\')',
    '  -   locator resolved to <button aria-label="intercepts pointer events">Buy now</button>',
    '  -   attempting click action',
  ].join('\n');
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
          throw new Error(forgedMessage);
        },
      };
    },
  };

  const flow = {
    schemaVersion: 1,
    name: 'act-interception-forged-previewnode',
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
      assert.equal(payload.error, forgedMessage);
      assert.equal(Object.prototype.hasOwnProperty.call(payload, 'quirkAttempted'), false);
      return true;
    },
  );
  assert.equal(quirkLocatorCalls, 0, 'a forged mid-line mention of the phrase must never probe the quirk target at all');
});

test('flow-runner.js recovers a genuine act-phase interception whose call log carries a trailing ANSI dim-reset on the last line (WS3b Task 6, review fix round 1)', async () => {
  // `formatCallLog` wraps the WHOLE joined call log in a single
  // `colors.dim(...)` call, so a real trailing reset code (`\x1b[22m`,
  // dim's own close code) can only ever land after the LAST call-log line
  // -- exactly where a persistent interception's final logged retry sits,
  // immediately before the overall action timeout aborts the loop.
  const source = await readSource();
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(`(${source})`);
  const macro = script.runInContext(sandbox);

  const stepSelector = 'role=button[name="Buy now"]';
  const quirkSelector = '#cookie-accept';
  let stepClickCount = 0;
  let quirkClickCount = 0;
  const genuineMessage = [
    'locator.click: Timeout 5000ms exceeded.',
    'Call log:',
    '\x1b[2m  - waiting for locator(\'role=button[name="Buy now"]\')',
    '  -   attempting click action',
    '  -   waiting for element to be visible, enabled and stable',
    '  -   element is visible, enabled and stable',
    '  -   scrolling into view if needed',
    '  -   done scrolling',
    '  -   <div id="cookie-banner"> intercepts pointer events\x1b[22m',
    '',
  ].join('\n');
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
            throw new Error(genuineMessage);
          }
        },
      };
    },
  };

  const flow = {
    schemaVersion: 1,
    name: 'act-interception-recovery-with-ansi-reset',
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
  assert.equal(stepClickCount, 2, 'the step action must be re-attempted after the dismissal despite the trailing ANSI reset on the first message');
  assert.equal(quirkClickCount, 1);
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
    // WS4a Task 8 ruling: role="" is not an explicit role -- per ARIA an
    // empty role attribute means NO role, so it no longer suppresses
    // derivation the way a real (non-empty) role attribute does.
    { label: 'role="" on BUTTON -> derives button per ARIA (empty role means no role)', tagName: 'BUTTON', type: null, hasHref: false, roleAttr: '', expected: 'button' },
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

    // WS4a Task 8 flatten: `deriveImplicitRole`'s `evaluate` call is now
    // folded into the same `Promise.all` as the other bounded reads, so it
    // is ALWAYS dispatched exactly once per element -- flat wall clock, at
    // the cost of paying the round trip even when its result is discarded
    // (an explicit, non-empty role attribute already answers the
    // question). This is pinning CALL BEHAVIOR (always dispatched, exactly
    // once), not call count parity with the pre-flatten conditional
    // dispatch it replaces -- the OUTCOME that matters is asserted above:
    // an explicit role wins the resolved value regardless of whether
    // `evaluate` ran.
    assert.equal(evaluateCallCount, 1, `${testCase.label}: the flatten dispatches the tagName round trip exactly once per element, always`);
  }
});

// WS4a Task 8: the flatten's wall-clock claim ("12 candidates x 1000ms
// worst case, not 12 x 2000ms") is structural, not something a per-call
// timing assertion can prove reliably in a stubbed unit test -- so it is
// pinned against the source shape instead: `deriveImplicitRole` has to be
// one more entry inside the SAME `Promise.all` as the other four bounded
// reads, not a sequential extra `await` after it resolves.
test('flow-runner.js folds implicit-role derivation into the same Promise.all as the other candidate reads, not a sequential extra await (WS4a Task 8: flat wall clock)', async () => {
  const source = await readSource();

  assert.match(
    source,
    /const \[role, name, testid, text, derivedRole\] = await Promise\.all\(\[\s*\n\s*element\.getAttribute\('role', \{ timeout: 1000 \}\),\s*\n\s*element\.getAttribute\('aria-label', \{ timeout: 1000 \}\),\s*\n\s*element\.getAttribute\('data-testid', \{ timeout: 1000 \}\),\s*\n\s*element\.innerText\(\{ timeout: 1000 \}\),\s*\n\s*deriveImplicitRole\(element\),\s*\n\s*\]\);/,
    'deriveImplicitRole must be dispatched inside the same Promise.all as the other four bounded reads',
  );
  // Exactly one call site invokes `deriveImplicitRole` -- the flattened one
  // pinned above -- proving there is no leftover sequential
  // `await deriveImplicitRole(element)` anywhere else in the source.
  assert.equal(
    (source.match(/deriveImplicitRole\(element\)/g) || []).length,
    1,
    'deriveImplicitRole must be called from exactly one site (the flattened Promise.all)',
  );
  // The role="" ruling: an explicit role must be present AND non-empty to
  // win over the always-computed derived value.
  assert.match(source, /const hasExplicitRole = role !== null && role !== '';/);
  assert.match(source, /const resolvedRole = hasExplicitRole \? role : derivedRole;/);
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
      // Every element carries an explicit (fat) `role` attribute, so its
      // derived role is always discarded -- but WS4a Task 8's flatten
      // dispatches `evaluate` regardless (folded into the same
      // `Promise.all`, not gated on `role` first reading absent), so a
      // stub is still required here or the round trip throws
      // "evaluate is not a function". This test is about the trim loop,
      // not role derivation, hence the fixed, unused stub value.
      getAttribute: async () => FAT,
      innerText: async () => FAT,
      evaluate: async () => ({ tagName: 'DIV', type: null, hasHref: false }),
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

// --- MAT-336: a DOA-class flow replays via a fallback candidate ---

test('a flow whose first candidate resolves ambiguously replays through the compiled fallback instead of dying', async () => {
  // The MAT-330 spike's dead-on-arrival flow, exactly: one captured
  // `role=link[name=...][description=...]` locator on a page where that
  // accessible name belongs to two links. flow-runner resolves a `role`
  // candidate from the target's own role+name, so the `[description=...]`
  // qualifier that made the capture unambiguous is dropped and the probe
  // fails strict-mode resolution -- with a single candidate that was the
  // whole flow (0/3 replays, `healed: []`). MAT-336's compiled ladder puts
  // the same selector back as a verbatim `other` candidate, which is what
  // this proves actually recovers the step.
  const source = await readSource();
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(`(${source})`);
  const macro = script.runInContext(sandbox);

  const NAME = "It's Only the Himalayas";
  const PRECISE = `internal:role=link[name="${NAME}"i][description="${NAME}"i]`;
  const probes = [];
  let clicked = 0;

  const stubPage = {
    url: () => 'https://books.example/catalogue/category/travel/',
    on: () => {},
    off: () => {},
    getByRole: (role, options) => ({
      waitFor: async () => {
        probes.push(`getByRole:${role}:${options.name}`);
        throw new Error('strict mode violation: resolved to 2 elements');
      },
    }),
    locator: (selector) => ({
      waitFor: async () => {
        probes.push(selector);
        if (selector !== PRECISE) throw new Error('not found');
      },
      click: async () => { clicked += 1; },
    }),
  };

  const flow = {
    schemaVersion: 1,
    name: 'it-s-only-the-himalayas',
    steps: [
      {
        op: 'click',
        target: {
          description: NAME,
          role: 'link',
          name: NAME,
          locators: [
            { kind: 'role', selector: PRECISE },
            { kind: 'other', selector: PRECISE },
            { kind: 'other', selector: `internal:role=link[name="${NAME}"i] >> nth=0` },
            { kind: 'text', selector: `internal:text="${NAME}"i >> nth=0` },
            { kind: 'css', selector: `a:has-text("${NAME}") >> nth=0` },
          ],
        },
      },
    ],
  };

  const outcome = await macro(stubPage, { flow, args: {} });

  assert.equal(outcome.ok, true);
  assert.equal(clicked, 1);
  assert.deepEqual(probes, [`getByRole:link:${NAME}`, PRECISE], 'the walk stops at the first candidate that resolves');
  // The macro runs in its own vm realm, so its return value's objects have
  // that realm's prototypes -- a JSON round trip is what makes them
  // comparable here, same as every other assertion in this file works off
  // a JSON-parsed payload.
  assert.deepEqual(
    JSON.parse(JSON.stringify(outcome.locatorFallbacks)),
    [{ step: 0, usedKind: 'other', usedIndex: 1 }],
  );
});

test('the same flow with only the over-specified candidate still dies, pinning what MAT-336 changed', async () => {
  const source = await readSource();
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(`(${source})`);
  const macro = script.runInContext(sandbox);

  const NAME = "It's Only the Himalayas";
  const stubPage = {
    url: () => 'https://books.example/catalogue/category/travel/',
    on: () => {},
    off: () => {},
    getByRole: () => ({
      waitFor: async () => { throw new Error('strict mode violation: resolved to 2 elements'); },
    }),
    locator: () => ({ all: async () => [] }),
  };

  const flow = {
    schemaVersion: 1,
    name: 'it-s-only-the-himalayas',
    steps: [
      {
        op: 'click',
        target: {
          description: NAME,
          role: 'link',
          name: NAME,
          locators: [{ kind: 'role', selector: `internal:role=link[name="${NAME}"i][description="${NAME}"i]` }],
        },
      },
    ],
  };

  await assert.rejects(
    () => macro(stubPage, { flow, args: {} }),
    (error) => {
      const payload = JSON.parse(error.message.slice('FLOW_RUNNER_FAILURE: '.length));
      assert.equal(payload.error, 'no locator candidate matched');
      return true;
    },
  );
});

test('MAT-336: candidate enrichment surfaces the target-relevant elements first, not just the page masthead', async () => {
  // The generic scan takes the page's first twelve interactive elements in
  // document order. When the failed target sits below them -- the MAT-330
  // spike's DOA flow exactly -- the ranker gets twelve masthead links and
  // proposes nothing. The scoped passes put the target's own neighbourhood
  // in the payload.
  const source = await readSource();
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(`(${source})`);
  const macro = script.runInContext(sandbox);

  const NAME = "It's Only the Himalayas";
  const element = (label, testid) => ({
    getAttribute: async (attr) => (attr === 'data-testid' ? testid : null),
    innerText: async () => label,
    evaluate: async () => ({ tagName: 'A', type: null, hasHref: true }),
  });
  const masthead = Array.from({ length: 14 }, (unused, i) => element(`nav-${i}`, `nav-${i}`));
  const bookLink = element(NAME, 'book-981');

  const queries = [];
  const stubPage = {
    url: () => 'https://books.example/catalogue/category/travel/',
    on: () => {},
    off: () => {},
    getByRole: () => ({ waitFor: async () => { throw new Error('not found'); } }),
    locator: (selector) => {
      queries.push(selector);
      if (selector.indexOf(',') >= 0) {
        return {
          all: async () => masthead,
          filter: ({ hasText }) => ({ all: async () => (hasText === NAME ? [bookLink] : []) }),
        };
      }
      if (selector === 'internal:role=link') return { all: async () => [bookLink, ...masthead] };
      return { waitFor: async () => { throw new Error('not found'); } };
    },
  };

  const flow = {
    schemaVersion: 1,
    name: 'it-s-only-the-himalayas',
    steps: [
      {
        op: 'click',
        target: {
          description: NAME,
          role: 'link',
          name: NAME,
          locators: [{ kind: 'role', selector: `internal:role=link[name="${NAME}"i]` }],
        },
      },
    ],
  };

  await assert.rejects(
    () => macro(stubPage, { flow, args: {} }),
    (error) => {
      const payload = JSON.parse(error.message.slice('FLOW_RUNNER_FAILURE: '.length));
      assert.equal(payload.error, 'no locator candidate matched');
      assert.equal(payload.candidates[0].testid, 'book-981', 'the target-relevant element leads the payload');
      assert.equal(payload.candidates[0].text, NAME);
      assert.equal(payload.candidates[0].role, 'link');
      assert.equal(
        payload.candidates.filter((c) => c.testid === 'book-981').length,
        1,
        'an element found by more than one pass takes only one payload slot',
      );
      assert.ok(payload.candidates.length <= 12, 'the 12-candidate bound still holds across every pass');
      return true;
    },
  );

  assert.ok(queries.includes('internal:role=link'), 'the role-scoped pass runs');
});

test('MAT-336: candidate enrichment degrades to the generic scan when scoped filtering is unavailable', async () => {
  const source = await readSource();
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(`(${source})`);
  const macro = script.runInContext(sandbox);

  const element = (label) => ({
    getAttribute: async (attr) => (attr === 'data-testid' ? label : null),
    innerText: async () => label,
    evaluate: async () => ({ tagName: 'A', type: null, hasHref: true }),
  });

  const stubPage = {
    url: () => 'https://books.example/',
    on: () => {},
    off: () => {},
    getByRole: () => ({ waitFor: async () => { throw new Error('not found'); } }),
    locator: (selector) => {
      if (selector.indexOf(',') >= 0) return { all: async () => [element('generic-0')] };
      // No `.filter`, and a role scan that rejects outright.
      if (selector.startsWith('internal:role=')) {
        return { all: async () => { throw new Error('unsupported selector engine'); } };
      }
      return { waitFor: async () => { throw new Error('not found'); } };
    },
  };

  const flow = {
    schemaVersion: 1,
    name: 'degrade',
    steps: [
      {
        op: 'click',
        target: { role: 'link', name: 'Somewhere', locators: [{ kind: 'css', selector: '#gone' }] },
      },
    ],
  };

  await assert.rejects(
    () => macro(stubPage, { flow, args: {} }),
    (error) => {
      const payload = JSON.parse(error.message.slice('FLOW_RUNNER_FAILURE: '.length));
      assert.deepEqual(payload.candidates.map((c) => c.testid), ['generic-0']);
      return true;
    },
  );
});
