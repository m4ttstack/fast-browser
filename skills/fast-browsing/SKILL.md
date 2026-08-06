---
name: fast-browsing
description: Use when browser automation spans multiple interactions or page reads and latency, token use, or observation size matters
---

# Fast Browsing

Minimize browser round trips and observation size. Prefer one informed batch
over repeated inspect-and-click cycles.

## Start with flows

Before macros, run `fast-browser flows find --intent "<task>" --origin
<origin> --json` via the shell and read the `candidates` array in its JSON
output.

If a candidate has `runnable: true`, make exactly one `browser_run_code_unsafe`
call using its `invocation` field verbatim: `invocation.arguments.filename`
and `invocation.arguments.args`, unedited.

Never run a candidate with `runnable: false`. Its `reasons` say why:
`pending approval: fast-browser flows approve <name>` means ask the human to
run that command; `contains js step: not replayable in v1` means the flow
needs re-recording. Do not attempt either yourself.

If the call errors with a message starting `FLOW_RUNNER_FAILURE: `, parse
the JSON payload after that prefix (`failedStep`, `error`, `url`,
`stepsCompleted`, `locatorFallbacks`, and on a locator-miss failure,
`candidates`, showing what the page actually offered at that step). Do not
retry the flow: fall through to macros, then the fast loop below. Never
hand-edit the flow artifact to fix a failure: the next `flows compile`
sweep reads this same evidence and heals the artifact automatically when
it is unambiguous. If the flow keeps failing, it quarantines on its own;
re-record it instead.

## Know the site

Before scouting an unfamiliar page on a known origin, run `fast-browser
sites affordances --url <url> --json`.

If `found` is true or `inventory` is non-empty, use the returned `digest`
(or `inventory` targets) as the first recon snapshot instead of running
`page-affordances` cold. Check `stale` and `savedAt` before trusting it
without verification.

For a multi-page plan, run `fast-browser sites show <origin> --json` and
read `edges` for the route graph between patterns.

If `found` is false and `inventory` is empty, the origin is unknown: scout
normally.

## Start with macros

Read `~/.fast-browser/macros/MACROS.md` before any browser action. When one
entry matches, make one `browser_run_code_unsafe` call with exactly its
`filename` and `args`. Do not open the script or send inline `code`.

If the macro fails twice, record the failure as directed by browser-macros,
then use the loop below.

## Use the fast loop

1. **Scout cheaply.** On an unfamiliar page, run the `page-affordances`
   built-in. It returns the page's fields, buttons, links and landmarks with a
   selector for each, which is what you need in order to act, and it lists in
   `skipped` whatever it could not both label and address. Use `browser_find`
   instead when the desired text or control is already known. Reach for
   `browser_snapshot` only when `page-affordances` skipped the thing you need
   or the page is genuinely unlike its digest: a full accessibility tree costs
   roughly 5k to 35k tokens, stays in context for the rest of the session, and
   is re-read on every later turn.
2. **Batch the known remainder.** Put every predictable navigation,
   interaction, assertion, and wait into one `browser_run_code_unsafe` call.
   Split only when the next action depends on information the script cannot
   determine internally.
3. **Read narrowly.** Use `browser_find` for known text and a targeted
   `browser_snapshot` for one region. Take another full snapshot only when
   genuinely lost. A `page-affordances` digest is partial by design, so read
   its `skipped` counts before concluding a control does not exist.
4. **Recover materially.** If the same scripted step fails twice, perform that
   step with a single-step tool, then resume batching.
5. **Return distilled data.** Return only the requested string, small object,
   URL, or short list.

## Script contract

- Derive resilient locators inside the script with `getByRole`, `getByLabel`,
  or `getByText`; do not reuse stale snapshot references after DOM changes.
- Wait for observable conditions inside the script.
- Catch each logical step. On failure, return completed work, the failing step,
  its error, and `page.url()` so recovery is informed.
- Never return page dumps, element handles, or click-by-click narration.

## Browser boundaries

Fast Browser drives the real Chrome instance connected through its extension.
Do not claim access to arbitrary existing windows, Incognito windows, other
profiles, non-Chrome browsers, or a separate isolated browser.

Never enter credentials or log in for the user. When authentication is needed,
ask the user to complete it in the real Chrome window, then continue.

## Quick reference

| Situation | Action |
|---|---|
| Replayable flow exists | flows find, then run flow-runner once |
| Matching macro | Run its filename and args once |
| Unfamiliar page | Run `page-affordances`, not `browser_snapshot` |
| Digest lacks the control you need | Check `skipped`, then snapshot |
| Predictable multi-step flow | Batch it |
| Known text or region | Read it narrowly |
| Same step failed twice | Change to single-step recovery |
| Task complete | Return only the distilled result |
