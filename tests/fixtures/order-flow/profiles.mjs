// Mutation-profile registry (WS4a Task 1): the order-flow fixture's
// ad-hoc variant mechanism -- WS3a Task 9 introduced 'base'/'drifted'/
// 'overlay', WS3b Task 10 added 'role-drifted'/'intercept' -- re-expressed
// as named, pure string -> string transforms over the fixture's BASE
// rendered markup (server.mjs's `renderBase()`: variant global "base",
// no overlay). This is a REFACTOR ONLY: every profile below reproduces
// its predecessor variant's served bytes exactly (see
// tests/e2e/healing.test.mjs's own doc comments for what each variant
// proves; this file only renames and generalizes selection, it does not
// change what any of them serve). Later WS4a tasks add more profiles to
// this same map -- Task 1 ships only the ones the existing e2e suites
// already exercise.
//
// old variant name -> new profile name:
//   'drifted'      -> 'testid-rename'      (WS3a Task 9: id-based css +
//                                            role locators miss; testid
//                                            survives)
//   'overlay'      -> 'banner-hides'        (WS3a Task 9: consent banner,
//                                            #app held visibility:hidden --
//                                            fails the locator PROBE)
//   'role-drifted' -> 'text-rename-near'    (WS3b Task 10: "Confirm order"
//                                            -> "Confirm your order",
//                                            lexically near -- role+text
//                                            heal path)
//   'intercept'    -> 'banner-intercepts'   (WS3b Task 10: pointer-event-
//                                            blocking overlay, #app stays
//                                            CSS-visible -- fails only the
//                                            act-phase hit-target check)
//
// 'base' itself is not a PROFILES entry (Shared shapes: "base = no
// transform") -- server.mjs special-cases it as the identity transform.

// Byte-for-byte the same markup WS3a Task 9's `INTERCEPT_OVERLAY_HTML`/
// `CONSENT_OVERLAY_HTML` constants produced, minus the leading
// `\n    ` every profile's insertion point (immediately before
// `<main id="app">`) already supplies from the base template's own
// (now-empty) `<!--FIXTURE_OVERLAY-->` placeholder line.
const CONSENT_OVERLAY_BODY = `<div id="consent-overlay" style="position:fixed;inset:0;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;">
      <div style="background:#fff;padding:1.5rem;border-radius:8px;">
        <p>This demo uses cookies.</p>
        <button type="button" id="consent-accept">Accept</button>
      </div>
    </div>`;

const INTERCEPT_OVERLAY_BODY = `<div id="intercept-overlay" style="position:fixed;inset:0;z-index:999;background:rgba(15,23,42,.05);">
      <button type="button" id="intercept-dismiss" style="position:fixed;top:1rem;right:1rem;">Dismiss overlay</button>
    </div>`;

// Swaps the baked-in `window.__FIXTURE_VARIANT__ = "base";` global for the
// named variant string index.html's own client script still branches on
// at runtime (that branching is untouched by this refactor -- only WHICH
// string reaches it, and how a caller selects that string, changes).
function withVariantGlobal(html, variantName) {
  return html.replace(
    'window.__FIXTURE_VARIANT__ = "base";',
    `window.__FIXTURE_VARIANT__ = ${JSON.stringify(variantName)};`,
  );
}

// Inserts an overlay's markup at the exact spot server.mjs's old
// `overlayHtmlFor`/template substitution used to put it: immediately
// before `<main id="app">`.
function withOverlay(html, overlayBody) {
  return html.replace('<main id="app">', `${overlayBody}\n    <main id="app">`);
}

// --- WS4a Task 2: the four new v1 profiles ---
//
// Every carried profile above (Task 1) drives its drift through
// `withVariantGlobal` -- a NEW named branch inside index.html's own
// `<script>` that the client re-evaluates at runtime. That mechanism is the
// only viable one for an element the recording script never sees as static
// markup at all: `showReview()`'s "Confirm order"/"Place order" buttons
// (and everything before them) are built by `app.insertAdjacentHTML`/
// `app.innerHTML` INSIDE that same script, not present in the page's
// initial bytes.
//
// The four transforms below take the OTHER option carry-forward 1 (Task 1's
// review) names: pure-markup, no NEW client-script cooperation -- no new
// `VARIANT` branch, no new global. Since `transform` receives the FULL
// rendered page (the `<script>` block included, as ordinary text), a
// literal, exact-substring `String#replace` against that already-existing
// `else` branch's own source text achieves the same drift with zero
// index.html edits: the mutated text becomes the code that actually runs
// (VARIANT stays "base", so the untouched `if` conditions above stay false
// and these `else` branches are exactly what executes), while every OTHER
// branch's literal text (the 'drifted'/'role-drifted' branches, this
// file's own doc comments) is left completely alone, inert exactly as it
// already was. Each of the four exact substrings below is grep-verified
// unique in index.html, so every `.replace()` call targets precisely the
// one occurrence it names -- no ambiguity, no risk of touching a sibling
// branch's markup.
const PLACE_ORDER_TAG = '<button type="button" id="place-order">Place order</button>';
const PLACE_ORDER_INSERT_CALL = `app.insertAdjacentHTML('beforeend', '${PLACE_ORDER_TAG}');`;
const PLACE_ORDER_LISTENER_CALL = "document.querySelector('#place-order').addEventListener('click', showComplete);";
const CONFIRM_ORDER_TAG = '<button type="button" id="confirm-order">Confirm order</button>';

// class-rename: the ONE css hook this element carries (its id) becomes a
// class instead; the element stays a native <button> (role button, implicit
// via tag -- untouched) and its visible text ("Place order") is byte-
// identical. Only the recorded CSS-kind locator (`#place-order`) can
// possibly miss; a role or testid-kind candidate (if the recording captured
// one) is completely unaffected, so this profile is declared 'clean': the
// harness's own record-once step is expected to have already ranked a
// structure-independent candidate ahead of the css one (WS3a/WS3b e2e
// evidence: a plain button's FIRST recorded locator is role-kind -- see
// tests/e2e/healing.test.mjs's intercept leg, which pins
// `locators[0].kind === 'role'` for an equivalent plain button). Task 4
// pins the actually-observed rung; if the recording ever ranks css first
// instead, the truthful observed rung is 'fallback' (still WITHOUT heal),
// which is the plan's own explicitly "acceptable, not required" outcome.
const CLASS_RENAME_TAG = '<button type="button" class="place-order-btn">Place order</button>';
const CLASS_RENAME_LISTENER_CALL = "document.querySelector('.place-order-btn').addEventListener('click', showComplete);";

// dom-reshuffle: "Confirm order" and "Place order" are reparented from
// direct children of #app into a wrapping `<section class="actions">` --
// a genuine structural move "around the targets" -- while every attribute
// (id, text, absence of testid) on both buttons stays byte-identical.
// `page.getByRole()`/a css id selector are both structure-independent (they
// query the whole document, not a fixed ancestor path), so this is expected
// to resolve on the very first probe exactly like the unreshuffled base --
// declared 'clean'.
//
// FIX (review round 1, Critical): the base script emits the two buttons via
// TWO SEPARATE `insertAdjacentHTML` calls (one per if/else block -- see
// index.html's `showReview`), each parsed by the browser as its OWN,
// independent HTML fragment. An earlier version of this transform split
// `<section class="actions">` and `</section>` across those two calls --
// each fragment parses standalone, so the dangling open tag in the FIRST
// fragment auto-closes at that fragment's own end (spec-compliant fragment
// parsing), and the unmatched `</section>` in the SECOND fragment is simply
// dropped. Net effect: "Confirm order" landed in an orphaned, self-closed
// section and "Place order" -- the element the recorded flow actually
// targets -- was never reparented at all, a silent no-op this profile
// exists to NOT be. Fixed by folding both buttons into the FIRST call's own
// fragment string (one well-formed `<section>...</section>`, one insertion,
// one parse) and removing the second call entirely -- the listener-
// attachment line right after it is untouched and still finds `#place-order`
// via `document.querySelector`, since by execution order the first call has
// already inserted it (ids survive reparenting; `querySelector` searches the
// whole document, not a fixed ancestor).
const CONFIRM_ORDER_INSERT_CALL = `app.insertAdjacentHTML('beforeend', '${CONFIRM_ORDER_TAG}');`;
const RESHUFFLE_INSERT_CALL = `app.insertAdjacentHTML('beforeend', '<section class="actions">${CONFIRM_ORDER_TAG}${PLACE_ORDER_TAG}</section>');`;

// text-rename-far: the accessible text becomes "Checkout" -- zero tokens
// shared with the recorded name "Place order" (heal.mjs's lexical jaccard
// scores this exactly 0, which can never clear HEAL_MIN_SCORE) -- and the
// id is dropped so the recorded css candidate also misses. No data-testid
// is ever added to this element (this profile's whole point is that
// NOTHING keyless can heal it; a stray testid would trivially defeat that).
// The listener attaches via `app.lastElementChild` (the button just
// inserted) rather than a selector, since the element now carries no
// stable hook of its own. Declared 'fail': the keyless expectation this
// profile exists to pin (Task 6 adds the WITH-encoder-key leg separately;
// that outcome is not representable in this single-value `expected.rung`).
const CHECKOUT_TAG = '<button type="button">Checkout</button>';
const CHECKOUT_LISTENER_CALL = 'app.lastElementChild.addEventListener(\'click\', showComplete);';

// delayed-render: the SAME insert-then-listen pair the base branch runs
// synchronously, deferred behind a `setTimeout`. No id/text/testid changes
// at all -- the only drift is timing -- so no heal is ever in play here:
// the SAME locator that always resolved this element still resolves it,
// just late.
//
// RETIMED (WS4a Task 4 review round 2, Critical): a first cut of this
// profile used a 2000ms delay, which this file's own comment (at the time)
// worked out resolves within rung 1's own multi-candidate walk -- true,
// but it left NO profile anywhere in this repo exercising `resolveTarget`'s
// own natural "rung 1 fully exhausted on every candidate, fall through to
// `resolveEscalated`" path: `banner-hides`/`banner-intercepts` recover via
// the quirk mechanism (a different code path), and
// tests/e2e/healing.test.mjs's own escalated `locatorFallbacks` entry is
// produced by the POST-QUIRK forced-escalated pass (`forcedEscalatedOnly`),
// not this one. The plan assigned exactly that natural-exhaustion coverage
// to THIS profile, so the DELAY is what gets retimed here, not the
// expectation that gets weakened to match a delay that was simply too
// short.
//
// The arithmetic has to be aware of an unmeasured, host-dependent
// quantity, call it `g`: the `setTimeout` is armed the moment `showReview()`
// runs (right when "Review order" is clicked), but the Place-order step's
// OWN rung-1 probe does not start until AFTER the intervening "Confirm
// order" step has already resolved and acted -- `g` is that real (never
// negative, never exactly zero) wall-clock gap. This file's OWN prior
// version of this comment did not account for `g` at all (implicitly
// assumed it away as ~0), which is exactly why its "stable ~1000ms margin"
// claim for the old 2000ms delay was wrong: the true binding edge was
// `500ms - g`, and the one real run that produced a `usedIndex: 1` (css)
// recovery only proves `g` stayed under ~500ms on THAT run, not that it
// always will (a sufficiently loaded host pushing `g` past ~2000ms would
// have flipped that same leg all the way to 'clean' instead -- the button
// already existing before the probe even starts).
//
// 4500ms is chosen so the outcome no longer depends on `g`'s exact value,
// only on `g` staying under a wide, realistic band (one click's own
// resolve-and-act round trip, empirically well under 500ms per the old
// leg's own observed recovery above):
//   - rung 1's own two-candidate walk, measured from the Place-order
//     step's own probe start, spans a 3000ms window (1500ms each,
//     sequential -- flow-runner.js's `probeCandidates`). The insert
//     deadline, in that SAME probe-start-relative frame, is `4500 - g`.
//     Even at `g` up to ~1000ms (double the observed bound), `4500 - g`
//     stays comfortably above 3000: rung 1 exhausts BOTH candidates and
//     genuinely misses, regardless of host speed.
//   - `resolveEscalated` then gets its own fresh, PER-CANDIDATE 3000ms
//     budget, candidate 0 (role) first -- its window, same relative frame,
//     is `[3000, 6000]`. `4500 - g` lands inside that window for any `g`
//     from 0ms up to ~1500ms (again, well past the realistic bound). The
//     margin from the lower edge is `1500 - g`; at the empirically
//     observed `g < 500ms` that margin exceeds 1000ms, and the upper
//     edge is never the binding constraint. So this profile now
//     resolves ONLY via rung 2's escalated pass, hitting candidate 0
//     (role): `usedKind: 'role', usedIndex: 0, escalated: true` -- the
//     natural-exhaustion coverage the plan assigned it, pinned exactly
//     (not just `>= 1`) in
//     tests/e2e/drift-harness.test.mjs.
const DELAYED_INSERT_CALL = `setTimeout(() => { ${PLACE_ORDER_INSERT_CALL} }, 4500);`;
const DELAYED_LISTENER_CALL = `setTimeout(() => { ${PLACE_ORDER_LISTENER_CALL} }, 4500);`;

export const PROFILES = {
  'testid-rename': {
    description: 'The "Place order" button becomes an <a data-testid> with no id and no native button role; visible text unchanged. Breaks the recorded css and role locators, survives via testid.',
    transform: (html) => withVariantGlobal(html, 'drifted'),
    expected: { rung: 'heal', healSelector: 'internal:testid=[data-testid="submit-v2"]' },
  },
  'text-rename-near': {
    description: 'The "Confirm order" button loses its id and its text becomes "Confirm your order" (lexically near, both tokens survive). Breaks the recorded css and role+name locators, healable via role+text.',
    transform: (html) => withVariantGlobal(html, 'role-drifted'),
    expected: { rung: 'heal', healSelector: 'internal:role=button[name="Confirm your order"i]' },
  },
  'banner-hides': {
    description: 'A consent banner covers the page and #app is held visibility:hidden until #consent-accept is clicked. Fails the locator PROBE (bounding-box/CSS visibility), not just the click.',
    transform: (html) => withOverlay(withVariantGlobal(html, 'overlay'), CONSENT_OVERLAY_BODY),
    expected: { rung: 'quirk' },
  },
  'banner-intercepts': {
    description: 'A transparent, top-stacked overlay leaves #app CSS-visible but blocks pointer events until #intercept-dismiss is clicked. Fails only the act-phase hit-target check, not the probe.',
    transform: (html) => withOverlay(withVariantGlobal(html, 'intercept'), INTERCEPT_OVERLAY_BODY),
    expected: { rung: 'quirk' },
  },
  'class-rename': {
    description: 'The "Place order" button\'s css hook moves from id="place-order" to class="place-order-btn"; role, visible text, and (absent) testid are all untouched. Expected to survive without a heal.',
    transform: (html) => html
      .replace(PLACE_ORDER_TAG, CLASS_RENAME_TAG)
      .replace(PLACE_ORDER_LISTENER_CALL, CLASS_RENAME_LISTENER_CALL),
    expected: { rung: 'clean' },
  },
  'dom-reshuffle': {
    description: 'The "Confirm order"/"Place order" buttons are reparented into a wrapping <section class="actions"> instead of being direct children of #app -- both inserted in ONE fragment so the section is never orphaned or auto-closed; every attribute on both is untouched. Expected to survive without a heal (locators are not structural).',
    transform: (html) => html
      .replace(CONFIRM_ORDER_INSERT_CALL, RESHUFFLE_INSERT_CALL)
      .replace(PLACE_ORDER_INSERT_CALL, ''),
    expected: { rung: 'clean' },
  },
  'text-rename-far': {
    description: 'The "Place order" button loses its id and its text becomes "Checkout" -- zero token overlap with the recorded name, no testid anywhere on the element. Keyless: lexical ranking cannot clear HEAL_MIN_SCORE, so no heal fires and failStreak climbs toward quarantine.',
    transform: (html) => html
      .replace(PLACE_ORDER_TAG, CHECKOUT_TAG)
      .replace(PLACE_ORDER_LISTENER_CALL, CHECKOUT_LISTENER_CALL),
    expected: { rung: 'fail' },
  },
  'delayed-render': {
    description: 'The "Place order" button renders and wires up 4500ms after showReview() would normally run it synchronously. No markup changes at all; the drift is purely timing. Retimed (WS4a Task 4 review round 2) so rung 1\'s own two-candidate walk (3000ms total from the step\'s own probe start) is exhausted regardless of host speed, landing the recovery in rung 2\'s escalated pass via candidate 0 (role) -- see this file\'s own doc comment above for the full g-aware margin arithmetic.',
    transform: (html) => html
      .replace(PLACE_ORDER_INSERT_CALL, DELAYED_INSERT_CALL)
      .replace(PLACE_ORDER_LISTENER_CALL, DELAYED_LISTENER_CALL),
    expected: { rung: 'escalated' },
  },
};
