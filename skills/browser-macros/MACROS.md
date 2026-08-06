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
  reported as a structured failure immediately rather than run again. Two
  candidates that would resolve to the identical locator are probed at most
  once per pass, not once each, before either pass runs. When that first
  probe pass (1500ms per deduped candidate) misses every candidate, one more
  probe-only pass over the same deduped candidates runs at an escalated
  3000ms each before the step is allowed to fail; the step's own action
  still only ever happens once, after whichever pass locates the target.
  When that escalated pass ALSO misses and the invocation supplies `quirks`
  (see Params), the macro tries dismissing a recorded page interrupt before
  giving up: the first embedded quirk whose `urlPattern` matches the
  current page and whose own target locator probes present (1500ms) is
  clicked once, and the step then gets exactly one more probe-then-act pass
  at the escalated 3000ms timeout -- still the step's one act overall, only
  reached because the walk above never acted. At most one quirk is
  attempted per step, a fresh budget every step; a quirk's `action` must be
  `click`, and its own click is never attempted a second time regardless of
  outcome. v1 quirks are exclusively human/agent-authored through `sites
  quirk add`; running one during replay is permitted only as this
  interrupt-recovery dismissal, since the human already performed the same
  click once by hand when recording the quirk -- that prior, manual
  dismissal is the consent basis for repeating it automatically here.
  Absent or empty `quirks` disables this pass entirely. A post-action
  network-settle wait never fails an action that already completed. `wait`
  steps are capped at 5s, a post-action network-settle wait is capped at
  5s, a flow is capped at 60 steps and 20 `extract` steps, and every
  extracted value and every supplied argument value is bounded to 4KB so a
  big page or a hostile arg can never blow up the return payload. If the
  current page's origin does not match the flow's own origin, the macro
  navigates there first before running any step.
- Params: `{ flow: <artifact object>, args: { <argName>: <string>, ... },
  quirks?: [{ name, urlPattern, target: { locators }, action }] }`. `flow`
  is the full parsed flow artifact (`schemaVersion`, `origin`, `steps`,
  ...) embedded whole, not a path -- this macro has no filesystem access to
  look one up. `args` supplies a string value for every argument the flow
  declares as `required`; a required argument missing from `args` fails
  before any page interaction. `quirks` (WS3a Task 3) is an optional list
  of recorded page-interrupt dismissals embedded whole by the caller (e.g.
  `flows find`, which caps it at 10 entries with a warning beyond that on
  the embedding side; this macro itself accepts however many it is given)
  -- absent or `[]` disables rung 3 above entirely. Every entry is advisory
  and re-validated here regardless of the embedder: `name` must be a
  string, `target.locators` an array, and `action` exactly `'click'`, or
  the entry is skipped silently rather than failing the replay over quirk
  data this runner never itself validated. On success the tool call
  returns `{ ok:
  true, result: { <extract keys> } | { completed: true }, stepsRun,
  locatorFallbacks: [{ step, usedKind, usedIndex, part?, escalated? }], ms
  }`; `escalated: true` marks an entry the second, 3000ms pass found
  (rung 2's own pass, or rung 3's post-quirk pass -- both use the same
  timeout and the same flag), absent otherwise. On
  failure the tool call itself errors rather than returning a value -- a
  successful return always reads as a successful replay to anything scoring
  flow health, so a failure has to fail the call, not merely describe one --
  and the thrown error's message is the literal prefix
  `FLOW_RUNNER_FAILURE: ` followed by the JSON-serialized failure shape `{
  failedStep: <step index or 'args'>, error, url, stepsCompleted,
  locatorFallbacks, quirkAttempted?, candidates? }`; parse that shape back
  out of the error text after the prefix. `stepsRun` always equals
  `steps.length`, including
  a step 0 the main replay loop itself never ran: when step 0 is a `goto`,
  the precondition above performs that exact navigation and the loop starts
  at step 1, but `stepsRun` still counts step 0 since the precondition
  performed it on the loop's behalf. `quirkAttempted` (WS3a Task 3) is an
  ADDITIVE, optional field naming the quirk rung 3 dismissed, present ONLY
  when a quirk was actually clicked and the step still failed afterward --
  never when rung 3 never fired (no matching or present quirk), and never
  on a success. `candidates` (WS3a Task 2) is an
  ADDITIVE, optional field present ONLY when the failed step is a
  locator-miss -- every deduped candidate missed both the base and the
  escalated probe pass above, including a rung-3 post-quirk pass when one
  ran -- and always the LAST key in the payload, with `quirkAttempted`
  (when present) immediately before it; every other failure (bad/missing
  args, a refused js step, a precondition
  navigation failure, or a step action that throws AFTER its target already
  resolved) carries no `candidates` key at all. When present it is a bounded
  scan of the page's interactive elements (`button, a, input, select,
  [role]`, one compound query rather than one `page.getByRole()` call per
  role, since the same evidence costs one round trip instead of up to
  eight), each entry `{ role, name, testid, text }` with every string
  clamped to 80 characters, capped at 12 entries, and further trimmed from
  the end if needed so the WHOLE payload stays under 8KB. `role` prefers the
  element's own attribute; absent that (WS3b Task 5), it is derived from the
  tag -- `button`; `a` only when it has `href`, as `link`; `select` as
  `combobox`; `input` by its `type` (`checkbox`/`radio` as themselves,
  `button`/`submit` as `button`, anything else as `textbox`) -- so a bare
  `<button>`/`<a href>` still carries role evidence instead of collecting
  text-only. Collection is
  fully try/caught: if it throws for any reason, the payload silently
  degrades to the pre-Task-2 shape and the original failure's `error` is
  never touched -- a host-side heal module (a later task) treats this as
  optional ranking evidence, never as something the failure contract
  depends on.
- Target: Any page; site-specific per invocation, driven entirely by
  `flow.origin`
- Script: `~/.fast-browser/macros/flow-runner.js`
- Status: built-in
