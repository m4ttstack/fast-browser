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

A failed `flow-runner` call errors with one of two distinct prefixes; check
which one fired before deciding what to do next.

If the call errors with a message starting `FLOW_RUNNER_FAILURE: `, parse
the JSON payload after that prefix (`failedStep`, `error`, `url`,
`stepsCompleted`, `locatorFallbacks`, and on a locator-miss failure,
`candidates`, showing what the page actually offered at that step). Do not
retry the flow: fall through to macros, then the fast loop below. Never
hand-edit the flow artifact to fix a failure: the next `flows compile`
sweep reads this same evidence and heals the artifact automatically when
it is unambiguous. If the flow keeps failing, it quarantines on its own;
re-record it instead.

If the call errors with a message starting `SIDECAR_LOST: ` instead, do not
treat it like the case above: it is not a step failure and does not fall
through to macros. See "When a tool call fails with SIDECAR_LOST" below
before doing anything else.

## Scripts vs. discrete steps

`flows find` first stays the rule no matter what runs next. Scripts
(`browser_run_code_unsafe`) remain right for exploration and one-off tasks;
the fast loop below is built around them.

When the task is a repeatable multi-step journey on a site with no matching
flow, drive it with discrete tool calls (`browser_click`, `browser_type`,
`browser_navigate`, and so on) instead of one script. The flywheel only
compiles discrete-call sessions into replayable steps. A scripted run
compiles to a single opaque `js` step instead, the same "contains js step:
not replayable in v1" case already covered above, so it never becomes a
runnable candidate on its own. Driving the journey with discrete calls now is
what lets the next `flows compile` sweep turn it into something a later
session can run directly.

## Distill the session after an ad hoc solve

You do not have to wait for a later session. The compiler only reads
finished recordings -- a live session never compiles -- but `browser_close`
finishes the current recording without ending your MCP session, and the
next browser tool call starts a fresh recording on its own. That closes
the loop immediately, while the intent and the known-good selectors are
still in context.

Right after you complete a repeatable task ad hoc -- 3 or more discrete
tool calls, no runnable flow or macro carried it, and the task
succeeded -- distill the session:

1. Call `browser_close`. If the user still needs the page open, do not
   close it; instead note that the session will compile on the first
   sweep after this session ends, and stop here.
2. Run `fast-browser flows compile --json` via the shell. The
   just-finished session compiles in one shot.
3. Run `fast-browser flows find --intent "<the task>" --origin <origin>
   --json` and locate the new candidate.
4. Offer the flow, one flow at a time: its name, origin, `sideEffects`,
   step count, and its `args` map as the parameterization, using this
   run's own values as the example invocation.

A read-only flow lands in the ready tier already runnable, so the offer
is informational: future sessions replay it in one call, and no decision
is needed. A mutating flow lands pending: present the exact
`fast-browser flows approve <name>` command for the human to run in
their own terminal, and never run it yourself, in any form -- broad
delegation to the task is not approval of the flow. If the user
explicitly declines the flow, record that decision with
`fast-browser flows reject <name>`.

Parameterization is compiler-owned: surface what `flows compile` lifted
into `args`. If a value the user would want parameterized was not
lifted, say so in one line; never hand-edit the artifact to add it.

If nothing compiled, read `skippedBySession` in the compile JSON for
your session's one-line reason (an unsupported tool skips its whole
segment; a too-short segment never qualifies) and report it. If the
journey already existed, the sweep dedups it and `find` surfaces the
existing flow; say it already exists instead of claiming a new one.

Distill at most once per completed task. Never loop back to re-close or
re-compile, and never distill mid-task.

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

## Report flywheel health

When asked to report on flow health, healing, or drift, run `fast-browser
stats --json` and read `replays`, `outcomes`, `healRate`, `cleanRate`,
`quarantined`, and `flowsHealed` from its output rather than guessing.

## Registry

A registry exists for sharing compiled flows across machines, but sync with
it is human-invoked: `registry init`, `registry push`, and `registry pull`
are commands the human runs by hand, and an agent must never push or pull on
its own.

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
| Just solved a repeatable journey ad hoc | `browser_close`, `flows compile`, offer the flow |
| `SIDECAR_LOST` from flow-runner | Follow its `recovery` field; never repeat the call |
| Task complete | Return only the distilled result |

## When a tool call fails with SIDECAR_LOST

`SIDECAR_LOST` means the browser connection dropped mid-flow. It is not an
ordinary step failure.

Do not repeat the call that failed. The browser has no page state left, so
repeating it produces output that looks successful and is wrong.

Whether it is then safe to resume from the start depends on whether a
completed step already mutated something -- a flow that submitted an order
at step 2 and lost the sidecar at step 4, restarted blindly, submits the
order again. Parse `stepsCompleted` and `recovery` out of the error payload
and follow `recovery` exactly as written: it reads `restart the flow from
navigation; do not repeat this call` when no completed step was mutating,
and instead reads a verify-first instruction ("a completed step was
mutating -- verify its effect on the site before deciding whether to
continue; when in doubt, stop and report instead of re-running the flow")
when one was. Never assume the restart form applies without checking.

When `recovery` calls for a restart and the second attempt also raises
`SIDECAR_LOST`, stop and report it: the sidecar is restarting or gone, and
that is the pod's problem to fix, not something more attempts will resolve.

## Logging in with credentials

This section applies only when the runtime was started with a secrets file
(`FAST_BROWSER_SECRETS`, forwarded as `--secrets=`) -- in practice, cloud or
sandbox mode. A normal local install has no secrets file and no secret name
ever resolves; there, the boundary above governs and logging in is never
yours to perform.

Secrets resolve inside the runtime, and only in `browser_fill_form` (textbox
and slider fields) and `browser_type`. Nothing else reaches them. That means
login cannot be a macro and cannot be a replayed flow: `flow-runner` fills
through the page directly, so a placeholder would be typed in literally.

The secret's NAME comes from the user or the sandbox operator for that
specific site. Never guess it: an unmatched name is filled in literally
rather than raising, so a guessed `APP_PASSWORD` types that literal string
into the password field and submits it -- a failed, possibly
lockout-triggering, login attempt instead of a caught error.

Log in with real tool calls, passing the secret's NAME as the field value:

1. `browser_navigate` to the login URL.
2. `browser_fill_form` with the secret names as values, for example
   `APP_USERNAME` and `APP_PASSWORD`. Never the values themselves.
3. `browser_click` on the submit control.
4. Assert an element that only renders once authenticated.

Step 4 is required, not a nicety: the same unmatched-name behavior means a
mistyped or misremembered name reaches the submit button and the flow
proceeds into a logged-out session that looks like it worked. The assertion
is what turns that into a visible failure before anything is captured.

Never put a credential value in a tool argument, a macro argument, or a flow
artifact. Only the name.
