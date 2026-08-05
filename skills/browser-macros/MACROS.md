# Macro Index

Every `Script:` path below is written with `~` for brevity, but the runtime
expands nothing: pass `filename` as the absolute path with your home directory
written out in full. A bare or `~` name resolves against the browser server's
own working directory and is then refused by its allowed-roots containment
check (`ENOENT` or "outside allowed roots").

## page-recon

- Description: Return compact reconnaissance of the current page: URL, title,
  up to ten headings, and a bounded list of links with visible names and hrefs.
- Params: `{ maxLinks?: number (default 10) }`
- Target: Current page (site-agnostic)
- Script: `~/.fast-browser/macros/page-recon.js`
- Status: built-in

## page-affordances

- Description: Return what can be DONE to the current page, as bounded lists a
  `browser_run_code_unsafe` script can act on: visible form fields with label,
  type and selector; visible buttons with label and selector; visible links
  with label and href; and the page's landmarks. Selectors are Playwright
  `page.locator()` strings, preferring role plus accessible name, then
  `data-testid`, `name`, `aria-label`, and last a real author-written `id`.
  Auto-generated ids (React `_R_eqd5_`, `:r0:`, framework counters) are never
  emitted, and nothing appears that could not be both labelled and addressed.
  Everything refused is counted in `skipped` as `{ list, reason, count }`, so
  the digest is known to be partial rather than assumed complete. Reach for
  this instead of `browser_snapshot`: a full accessibility tree costs 5k to 35k
  tokens and stays in context for the rest of the session.
- Params: `{ maxFields?: number (default 30), maxButtons?: number (default 30), maxLinks?: number (default 40), maxLandmarks?: number (default 12), maxScan?: number (default 2000) }`
- Target: Current page (site-agnostic)
- Script: `~/.fast-browser/macros/page-affordances.js`
- Status: built-in

## capture-annotated

- Description: Capture the viewport to a PNG and measure named CSS selectors to
  pixel boxes in the same page state, for use with `fast-browser annotate`.
  Returns resolved boxes plus a `missed` list naming any selector that did not
  match, matched more than once, or fell outside the viewport, and a `space`
  map giving each resolved key up to four measured empty bands
  (`{ side: "above"|"below"|"left"|"right", box: [x, y, w, h] }`, in the same
  pixel space as `resolved`) for placing labels where no addressable element
  exists. Emptiness is judged by geometry, not hit-testing: every element's
  text lines, visual and interactive elements (iframes included), background
  images (html and body included), and pseudo-element content refuse any
  band they touch, whether or not a pointer could ever reach them. The
  judgment has stated blind spots -- closed shadow roots, and decoration
  painted only by borders, box shadows, or background colours -- and a page
  with more elements than the scan cap returns no bands at all, so a band is
  measured evidence, not a substitute for reviewing the annotated output. A
  side with no empty room of useful size is omitted, and a key with no
  usable side at all is absent from `space`; absence is the honest answer,
  never a license to eyeball a spot. A resolved target whose element is a
  `canvas`, `iframe`, `img`, `video`, `embed`, or `object` is listed in
  `opaque` with its tag: its box is measured but its interior is beyond any
  selector, so escalate to arithmetic on the measured box instead of retrying
  selectors that cannot exist. Runs without the Node host globals that could
  reach the filesystem or the environment (`console` exists; `process` and
  `require` do not), so it cannot read `$HOME` itself; pass your own absolute
  home directory as `home`.
- Params: `{ targets: Record<string, string>, out?: string (default "capture"), home: string (your absolute home directory path), space?: boolean (default true; false skips the empty-band measurement) }`
- Target: Current page (site-agnostic)
- Script: `~/.fast-browser/macros/capture-annotated.js`
- Status: built-in

## flow-runner

- Description: Replay a compiled flow artifact (the flywheel's `.flow.json`
  shape) in exactly one browser call. Refuses every `js` step up front rather
  than half-running a flow it cannot finish, resolves each step's target by
  walking its locator candidates in order and recording which candidate won
  as a fallback, and never retries a step internally -- a step that throws is
  reported as a structured failure immediately rather than run again. `wait`
  steps are capped at 5s, a post-action network-settle wait is capped at 5s,
  a flow is capped at 60 steps and 20 `extract` steps, and every extracted
  value is bounded to 4KB so a big page can never blow up the return payload.
  If the current page's origin does not match the flow's own origin, the
  macro navigates there first before running any step.
- Params: `{ flow: <artifact object>, args: { <argName>: <string>, ... } }`.
  `flow` is the full parsed flow artifact (`schemaVersion`, `origin`,
  `steps`, ...) embedded whole, not a path -- this macro has no filesystem
  access to look one up. `args` supplies a string value for every argument
  the flow declares as `required`; a required argument missing from `args`
  fails before any page interaction. Returns one of two shapes:
  - Success: `{ ok: true, result: { <extract keys> } | { completed: true },
    stepsRun, locatorFallbacks: [{ step, usedKind, usedIndex }], ms }`.
  - Failure: `{ failedStep: <step index or 'args'>, error, url,
    stepsCompleted, locatorFallbacks }`.
- Target: Any page; site-specific per invocation, driven entirely by
  `flow.origin`
- Script: `~/.fast-browser/macros/flow-runner.js`
- Status: built-in
