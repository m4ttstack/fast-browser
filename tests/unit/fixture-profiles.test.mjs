import assert from 'node:assert/strict';
import test from 'node:test';

import { PROFILES } from '../fixtures/order-flow/profiles.mjs';
import { renderBase, startOrderFixture } from '../fixtures/order-flow/server.mjs';

// WS4a Task 2: the mutation profiles (profiles.mjs) are pure string ->
// string transforms -- every claim they make (a renamed class, a
// far-renamed accessible name, a removed testid, a deferred render, a
// reparented DOM) is provable by string inspection alone, no browser
// required. This file covers three things:
//   1. per-profile targeted diffs (Step 1's own list): what changed,
//      exactly where declared, and nowhere else that matters.
//   2. purity + `expected` metadata shape, across EVERY profile (new and
//      carried from Task 1) -- the harness (Task 3+) consumes this
//      metadata as-is, so its shape is pinned here.
//   3. the HTTP-layer unknown-profile 400 path (Task 1's carry-forward 2):
//      a real request against a running fixture server, not a unit call
//      into `renderProfile` -- the whole point is exercising the request
//      handler's own branch, not just the pure function underneath it.

const VOCABULARY = new Set(['clean', 'fallback', 'escalated', 'quirk', 'heal', 'fail']);

// --- metadata shape: every profile, new and carried ---

test('fixture profiles: expected metadata is well-formed for every profile', () => {
  const names = Object.keys(PROFILES);
  // Sanity on the roster itself: Task 1's four carries plus Task 2's four
  // new profiles, nothing missing, nothing stray.
  assert.deepEqual(
    names.sort(),
    [
      'banner-hides', 'banner-intercepts', 'class-rename', 'delayed-render',
      'dom-reshuffle', 'testid-rename', 'text-rename-far', 'text-rename-near',
    ],
  );

  for (const name of names) {
    const profile = PROFILES[name];
    assert.equal(typeof profile.description, 'string', `${name}: description must be a string`);
    assert.ok(profile.description.length > 0, `${name}: description must be non-empty`);
    assert.equal(typeof profile.transform, 'function', `${name}: transform must be a function`);

    const { expected } = profile;
    assert.ok(expected && typeof expected === 'object', `${name}: expected metadata must be present`);
    assert.ok(VOCABULARY.has(expected.rung), `${name}: expected.rung "${expected.rung}" not in the rung vocabulary`);

    if (expected.rung === 'heal') {
      assert.equal(typeof expected.healSelector, 'string', `${name}: heal-rung profile must carry a healSelector`);
      assert.ok(expected.healSelector.length > 0, `${name}: healSelector must be non-empty`);
    } else {
      assert.equal(expected.healSelector, undefined, `${name}: non-heal rung must not carry a healSelector`);
    }
  }
});

// The two heal-rung profiles' selectors are pinned verbatim to what
// tests/e2e/healing.test.mjs's own e2e legs already proved sweep synthesizes
// (see that file's `appendedLocator` assertions) -- not re-derived here,
// just carried forward as declared expectations for the harness to assert
// against later.
test('fixture profiles: heal-rung healSelectors match the proven WS3a/WS3b synthesis', () => {
  assert.equal(PROFILES['testid-rename'].expected.healSelector, 'internal:testid=[data-testid="submit-v2"]');
  assert.equal(PROFILES['text-rename-near'].expected.healSelector, 'internal:role=button[name="Confirm your order"i]');
});

// --- purity: every profile's transform never mutates the input, and
// calling it twice never mutates `renderBase()`'s own output either ---

test('fixture profiles: every transform is pure (base untouched, output differs)', () => {
  const beforeBase = renderBase();
  for (const [name, profile] of Object.entries(PROFILES)) {
    const base = renderBase();
    const output = profile.transform(base);
    assert.notEqual(output, base, `${name}: transform must produce different markup than base`);
    // Strings are immutable in JS, so `base` itself cannot have changed --
    // the purity claim that matters is that renderBase() keeps producing
    // the SAME bytes after every transform has run, i.e. no transform
    // reached into shared module state (the cached page template).
  }
  assert.equal(renderBase(), beforeBase, 'renderBase() must be stable across every transform call above');
});

// --- Step 1: per-profile targeted diffs, new profiles ---

test('class-rename: css hook moves from id to class; role/text/testid untouched', () => {
  const base = renderBase();
  const output = PROFILES['class-rename'].transform(base);

  assert.ok(output.includes('<button type="button" class="place-order-btn">Place order</button>'), 'expected the renamed class on an otherwise-identical button');
  assert.ok(!output.includes('id="place-order"'), 'expected the id to be gone');
  assert.ok(output.includes("document.querySelector('.place-order-btn').addEventListener('click', showComplete);"), 'expected the click wiring retargeted to the new class hook');
  assert.ok(!output.includes("document.querySelector('#place-order')"), 'expected the old id-based wiring gone');
  // No testid introduced: the count of testid attributes must match base's
  // own (the one unrelated, always-present "submit-v2" testid from the
  // dead 'drifted' branch's source text -- see profiles.mjs's own doc
  // comment on why that text is present but inert).
  const testidCount = (string) => (string.match(/data-testid=/g) || []).length;
  assert.equal(testidCount(output), testidCount(base));
});

test('dom-reshuffle: confirm/place-order buttons reparent into ONE well-formed wrapping section, not split across two fragment parses; every attribute is untouched', () => {
  const base = renderBase();
  const output = PROFILES['dom-reshuffle'].transform(base);

  // The critical, DOM-shape-provable assertion (review round 1 fix): the
  // base script emits these two buttons via TWO SEPARATE
  // `insertAdjacentHTML` calls (one per if/else block in showReview), each
  // parsed by the browser as its OWN, independent HTML fragment. Splitting
  // `<section class="actions">`/`</section>` across those two calls -- what
  // an earlier version of this transform did -- auto-closes the dangling
  // open tag at the end of the FIRST fragment and silently drops the
  // unmatched close tag in the SECOND, so "Place order" (the element the
  // recorded flow actually targets) was never reparented at all, only
  // "Confirm order" was, into an orphaned section. Asserting the WHOLE
  // insertAdjacentHTML call -- open tag through close tag, both buttons,
  // one literal argument string -- as ONE contiguous substring is what
  // makes "both buttons genuinely share one fragment" provable without a
  // browser or jsdom: if they were still split across two calls, this
  // exact substring could never appear (unrelated source text -- the
  // 'drifted' if/else branch -- sits between them in that case).
  assert.ok(
    output.includes(
      "app.insertAdjacentHTML('beforeend', '<section class=\"actions\">"
      + '<button type="button" id="confirm-order">Confirm order</button>'
      + '<button type="button" id="place-order">Place order</button>'
      + "</section>');",
    ),
    'expected both buttons inside ONE well-formed <section> fragment, inserted by a single call',
  );
  // The old, separate place-order insertion call must be gone entirely --
  // not duplicated, not left behind as inert dead code.
  assert.ok(
    !output.includes("app.insertAdjacentHTML('beforeend', '<button type=\"button\" id=\"place-order\">Place order</button>');"),
    'expected the old standalone place-order insertion call removed',
  );

  // Every attribute both buttons carried in base is still present verbatim
  // -- only their PARENT changed.
  assert.ok(output.includes('id="confirm-order"'));
  assert.ok(output.includes('id="place-order"'));
  assert.ok(output.includes('>Confirm order<'));
  assert.ok(output.includes('>Place order<'));
  // The click wiring is untouched -- id-based, and ids survive reparenting
  // (querySelector searches the whole document, not a fixed ancestor).
  assert.ok(output.includes("document.querySelector('#place-order').addEventListener('click', showComplete);"));
  const testidCount = (string) => (string.match(/data-testid=/g) || []).length;
  assert.equal(testidCount(output), testidCount(base));
});

test('text-rename-far: accessible text changes to zero-overlap "Checkout"; id and testid both gone', () => {
  const base = renderBase();
  const output = PROFILES['text-rename-far'].transform(base);

  assert.ok(output.includes('<button type="button">Checkout</button>'), 'expected a bare button reading "Checkout"');
  assert.ok(!output.includes('id="place-order"'), 'expected the id to be gone');
  assert.ok(!output.includes('Place order</button>'), 'expected the OLD "Place order" button tag gone (its own recorded name)');
  assert.ok(output.includes('app.lastElementChild.addEventListener(\'click\', showComplete);'), 'expected the click wiring retargeted off the removed id');
  assert.ok(!output.includes("document.querySelector('#place-order')"), 'expected the old id-based wiring gone');
  // No testid on this element specifically: the mutated tag itself carries
  // none, and the overall testid count is unchanged from base (the one
  // unrelated "submit-v2" testid, from the dead 'drifted' branch, is still
  // the only one present).
  const testidCount = (string) => (string.match(/data-testid=/g) || []).length;
  assert.equal(testidCount(output), testidCount(base));
});

test('delayed-render: the place-order insert and its listener both defer behind a 2000ms setTimeout', () => {
  const base = renderBase();
  const output = PROFILES['delayed-render'].transform(base);

  assert.ok(!base.includes('setTimeout'), 'sanity: base must not already use setTimeout anywhere');
  assert.ok(output.includes('setTimeout'), 'expected the delay mechanism present');
  assert.ok(
    output.includes("setTimeout(() => { app.insertAdjacentHTML('beforeend', '<button type=\"button\" id=\"place-order\">Place order</button>'); }, 2000);"),
    'expected the exact insert call deferred by 2000ms',
  );
  assert.ok(
    output.includes("setTimeout(() => { document.querySelector('#place-order').addEventListener('click', showComplete); }, 2000);"),
    'expected the exact listener call deferred by 2000ms',
  );
  // No markup change at all -- the button itself, once it renders, is
  // byte-identical to base's.
  assert.ok(output.includes('<button type="button" id="place-order">Place order</button>'));
});

// --- WS4a Task 4 (ledger ruling, constraint 1): banner-hides' dismissal
// must be fixture-side countable, mirroring banner-intercepts' own
// `__interceptDismissClicks__`, so the harness can classify a successful
// recovery as 'quirk' rather than 'escalated'. Provable by string
// inspection alone (same discipline as every other targeted diff above):
// the counter's init and increment are both present verbatim in the
// banner-hides transform's output, since profiles.mjs never edits
// index.html's script text -- it only swaps the VARIANT global and inserts
// the overlay markup, so the (always-present, runtime-gated) counter logic
// simply becomes reachable this time.
test('banner-hides: the consent-accept dismissal is fixture-side countable, mirroring window.__interceptDismissClicks__', () => {
  const base = renderBase();
  const output = PROFILES['banner-hides'].transform(base);

  assert.ok(output.includes('window.__consentDismissClicks__ = 0;'), 'expected the counter initialized in the overlay variant branch');
  assert.ok(output.includes('window.__consentDismissClicks__ += 1;'), 'expected the #consent-accept click handler to increment the counter');
  // The base (unmutated) markup still has this counter logic present too
  // (it's part of index.html's always-shipped script, just runtime-gated
  // behind `VARIANT === 'overlay'`) -- pinned here so a future edit can't
  // accidentally make the counter banner-hides-transform-specific instead
  // of a property of the fixture's own source.
  assert.ok(base.includes('window.__consentDismissClicks__ = 0;'));
  assert.ok(base.includes('window.__consentDismissClicks__ += 1;'));
});

// --- carry-forward 2: the HTTP-layer unknown-profile 400, exercised for
// real (a running server, a real request), not just the pure function ---

test('fixture server: an unrecognized ?profile= is a real HTTP 400, not just a renderProfile() null', async () => {
  const fixture = await startOrderFixture();
  try {
    const response = await fetch(`${fixture.origin}/?profile=not-a-real-profile`);
    assert.equal(response.status, 400);
    const body = await response.text();
    assert.equal(body, 'unknown fixture profile: not-a-real-profile');
  } finally {
    await fixture.close();
  }
});

// The query param is purely additive: omitting it keeps serving whatever
// the existing toggle (`setProfile`) selected, unchanged from before this
// task -- pinned here so a future edit can't silently make `?profile=`
// override the toggle instead of falling back to it.
test('fixture server: omitting ?profile= still serves the toggled profile', async () => {
  const fixture = await startOrderFixture();
  try {
    fixture.setProfile('class-rename');
    const response = await fetch(fixture.origin);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(body.includes('class="place-order-btn"'));
  } finally {
    await fixture.close();
  }
});

// A recognized `?profile=` DOES serve that profile's markup directly, one
// more proof the query param reaches the same `renderProfile` the toggle
// does (not a parallel, divergent code path).
test('fixture server: a recognized ?profile= serves that profile directly', async () => {
  const fixture = await startOrderFixture();
  try {
    const response = await fetch(`${fixture.origin}/?profile=text-rename-far`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(body.includes('<button type="button">Checkout</button>'));
  } finally {
    await fixture.close();
  }
});
