# Drift harness

`tests/e2e/drift-harness.test.mjs` proves that healing keeps working as the
order-flow fixture's markup drifts out from under a recorded flow. It is one
suite among the other `tests/e2e/*.test.mjs` files, run the same way they are
(`npm run test:<name>`), not a separate framework.

## Running it

```bash
FAST_BROWSER_RELEASE_DIR=/path/to/fast-browser-dist npm run test:drift
```

Every browser-driving leg needs a local runtime the same way every other e2e
suite in this repo does: `tests/e2e/helpers/mcp-client.mjs`'s
`resolveReleaseDir` walks up from the plugin looking for a sibling
`fast-browser-dist` checkout when `FAST_BROWSER_RELEASE_DIR` is unset, but the
drift harness itself skips its browser-driving tests outright, with a named
reason, rather than falling through to that auto-discovery -- it wants a
runtime explicitly configured, not "one that happened to be nearby". A subset
of the suite (`classifyReplay`'s own unit-style cases) is pure and runs with
no runtime and no env var at all.

## The keyed leg

One leg proves the encoder-backed (Voyage) healing path, on top of the same
matrix fixture the lexical legs use. It needs a live Voyage API key:

```bash
source ~/.fast-browser/voyage.env
FAST_BROWSER_RELEASE_DIR=/path/to/fast-browser-dist npm run test:drift
```

Without a key, this leg (and the matrix test's optional voyage tuning line)
skips cleanly with a reason naming the missing env var
(`FAST_BROWSER_VOYAGE_API_KEY`, `lib/flows/encoder.mjs`'s `VOYAGE_API_KEY_ENV`)
-- the rest of the suite still runs. Never write the key's value anywhere:
not into a flag, not into a fixture, not into this file, not into a commit
or a session log. The env var is the only place it belongs.

## The profiles

Each mutation profile is a named, pure transform over the order-flow
fixture's rendered markup (`tests/fixtures/order-flow/profiles.mjs`). One
line each, from that file's own descriptions:

- **testid-rename** -- The "Place order" button becomes an `<a data-testid>`
  with no id and no native button role; visible text unchanged. Breaks the
  recorded css and role locators, survives via testid.
- **text-rename-near** -- The "Confirm order" button loses its id and its
  text becomes "Confirm your order" (lexically near, both tokens survive).
  Breaks the recorded css and role+name locators, healable via role+text.
- **banner-hides** -- A consent banner covers the page and `#app` is held
  `visibility:hidden` until `#consent-accept` is clicked. Fails the locator
  PROBE (bounding-box/CSS visibility), not just the click.
- **banner-intercepts** -- A transparent, top-stacked overlay leaves `#app`
  CSS-visible but blocks pointer events until `#intercept-dismiss` is
  clicked. Fails only the act-phase hit-target check, not the probe.
- **class-rename** -- The "Place order" button's css hook moves from
  `id="place-order"` to `class="place-order-btn"`; role, visible text, and
  (absent) testid are all untouched. Expected to survive without a heal.
- **dom-reshuffle** -- The "Confirm order"/"Place order" buttons are
  reparented into a wrapping `<section class="actions">` instead of being
  direct children of `#app`, both inserted in one fragment so the section is
  never orphaned or auto-closed; every attribute on both is untouched.
  Expected to survive without a heal (locators are not structural).
- **text-rename-far** -- The "Place order" button loses its id and its text
  becomes "Checkout" -- zero token overlap with the recorded name, no testid
  anywhere on the element. Keyless: lexical ranking cannot clear
  `HEAL_MIN_SCORE`, so no heal fires and `failStreak` climbs toward
  quarantine.
- **delayed-render** -- The "Place order" button renders and wires up
  4500ms after `showReview()` would normally run it synchronously. No markup
  changes at all; the drift is purely timing.

`base` (no transform) is not a `PROFILES` entry; it is the identity case
every profile mutates away from.

## What a rung-distribution failure means

The matrix test (`drift-harness: rung distribution pinned across every
mutation profile`) replays every profile above and asserts each one lands on
its expected rung (`clean`, `fallback`, `escalated`, `quirk`, `heal`, or
`fail`). Every one of those assertions is a hardcoded expectation, not a
loop over declared metadata -- the matrix itself is the regression baseline.

A failure here means a durability regression: some code path that used to
resolve a drifted target (a locator rank, a quirk dismissal, an escalated
probe) no longer does, or one that used to fail now silently heals wrong.
Read the failing assertion to find which profile moved, and to which rung it
landed on instead of the expected one -- that pairing (profile, old rung ->
new rung) is the actual bug report. It is not "the harness is flaky"; every
profile's transform is a deterministic, pure string rewrite, and the fixture
serves the same bytes every run.

## The tuning aggregate

Two legs (the matrix test and the encoder leg) each emit tuning lines while
they run: one record per (ranker, profile) pair, capturing the top score,
runner-up score, margin, whether that would have healed, and whether it
would have healed to the *correct* target. The lexical ranker's line is
always computable, since it needs no network call; the voyage ranker's line
is additive, only emitted when a Voyage key is configured.

Those lines accumulate in an in-process array for the whole test file's run,
get appended to a scratch JSONL file under a `mkdtemp` directory (never
committed, cleaned up by the aggregate test itself once it has read the file
back), and the very last test in the file
(`printTuningAggregate`) prints the grouped aggregate via `console.table` to
`npm run test:drift`'s own stdout. That table -- min/median top score,
min/median margin, `healed` and `correct` as `<count>/<n>` per (ranker,
profile) -- lives only in that run's output. It is not persisted anywhere
else.

The standing verdict those numbers produced is not re-derived on every run;
it is cited, with its measurements, in `lib/flows/encoder.mjs` right above
`ENCODER_MIN_SCORE`/`ENCODER_MIN_MARGIN` (search that file for "THRESHOLD
VERDICT"). Read that comment for the full citation, including the
counterexample below.

## Known realities

**The encoder can prefer a semantic sibling over the true target.** The
`text-rename-far` profile's encoder leg proves the Voyage-backed ranker
clears its gate where the lexical ranker cannot (lexical scores 0.433,
below `HEAL_MIN_SCORE`) -- but the winning candidate is "Confirm order"
(cosine 0.8508), not the fixture's actual intended target, "Checkout"
(cosine 0.7554). The margin between them, 0.0954, is above
`ENCODER_MIN_MARGIN` (0.05), so the production gate legitimately passed a
wrong bind. This is a ranking-quality problem (the scorer has no signal
beyond text similarity: no DOM proximity, no prior-locator distance), not a
threshold-position problem -- raising the margin would only suppress this
specific mis-bind, not fix the underlying preference, and is explicitly
deferred to WS4b as a local-encoder-era fix.

**Aborting the MCP call does not cancel server-side execution (MAT-153).**
The kill leg (`drift-harness: mid-flow kill never double-submits; abandoned
sessions sweep clean`) proves at-most-once holds: the mutating action never
fires twice. But the mechanism is not what "kill" suggests. A
`notifications/cancelled` is sent and the local promise rejects
near-instantly, while the runtime keeps running the in-flight
`browser_run_code_unsafe` macro to its own natural conclusion regardless --
measured directly at roughly 9.5-10s of real server-side execution after the
abort. A client-side abandon is not a mid-execution truncation; true
mid-execution kill coverage (the host process dying partway through) and
whether runtime cancellation ever actually propagates into flow-runner.js's
execution are tracked separately as MAT-153.

**`fallback`, `escalated`, and `quirk-recovered` are structurally zero in
the runs ledger, today.** `fast-browser stats`'s `outcomes` object always
carries all six outcome keys, but sweep.mjs (the only writer of
`runs.jsonl`) can only ever emit `clean`, `healed`, or `failed`: the
runtime's trace record for a successful `browser_run_code_unsafe` call
carries no field for the macro's own return value (`locatorFallbacks`,
quirk evidence), only an `error` field set on a thrown/rejected call. Every
success looks identical to the sweep, whether it resolved on the first
candidate or needed a fallback, an escalated probe, or a quirk dismissal.
This is a deliberate, honest omission (the record shape already reserves
the richer outcome values for when runtime capture of replay return values
lands), not a bug -- do not read a `0` for those three outcomes as "never
happened"; read it as "not yet observable".
