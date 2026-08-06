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

export const PROFILES = {
  'testid-rename': {
    description: 'The "Place order" button becomes an <a data-testid> with no id and no native button role; visible text unchanged. Breaks the recorded css and role locators, survives via testid.',
    transform: (html) => withVariantGlobal(html, 'drifted'),
  },
  'text-rename-near': {
    description: 'The "Confirm order" button loses its id and its text becomes "Confirm your order" (lexically near, both tokens survive). Breaks the recorded css and role+name locators, healable via role+text.',
    transform: (html) => withVariantGlobal(html, 'role-drifted'),
  },
  'banner-hides': {
    description: 'A consent banner covers the page and #app is held visibility:hidden until #consent-accept is clicked. Fails the locator PROBE (bounding-box/CSS visibility), not just the click.',
    transform: (html) => withOverlay(withVariantGlobal(html, 'overlay'), CONSENT_OVERLAY_BODY),
  },
  'banner-intercepts': {
    description: 'A transparent, top-stacked overlay leaves #app CSS-visible but blocks pointer events until #intercept-dismiss is clicked. Fails only the act-phase hit-target check, not the probe.',
    transform: (html) => withOverlay(withVariantGlobal(html, 'intercept'), INTERCEPT_OVERLAY_BODY),
  },
};
