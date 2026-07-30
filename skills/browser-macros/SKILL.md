---
name: browser-macros
description: Use when a browser task resembles a repeated flow or a reusable browser script may already cover the requested result
---

# Browser Macros

Use indexed Playwright macros instead of re-deriving known browser flows.

## Run a macro

1. Read `~/.fast-browser/macros/MACROS.md`.
2. Match the task to an entry's description and target.
3. Call `browser_run_code_unsafe` with `filename` set to the entry's `Script:`
   path as an absolute path, your home directory written out in full, and the
   entry's `args` exactly. The runtime expands nothing: a bare or `~` name
   resolves against the browser server's own working directory and is refused
   by its containment check (`ENOENT` or "outside allowed roots"). Do not open
   the script and do not substitute inline `code`.
4. Return the macro's distilled result.

If the macro fails, use its `{ failedStep, error, url }` result to retry
materially. After the same macro fails twice, append:

```text
<macro-name> | <date> | <failedStep or reason>
```

to `~/.fast-browser/macro-failures.md`, then switch to fast-browsing recovery.
Do not keep repeating the macro.

## Prefer the affordances digest to a snapshot

On an unfamiliar page the matching entry is usually `page-affordances`. It
returns the page's visible fields, buttons, links and landmarks with a selector
for each, which is enough to act on, where `page-recon` only says what the page
is. Reach for `browser_snapshot` only after the digest comes back without the
control you need: a full accessibility tree costs roughly 5k to 35k tokens and
stays in context for the rest of the session.

The digest is partial on purpose. Nothing appears in it that could not be both
labelled and addressed, and everything refused is counted in `skipped` as
`{ list, reason, count }`. Read those counts before concluding a control is
absent, and never invent a selector for something the macro declined to
address.

## Authoring contract

- Store scripts in `~/.fast-browser/macros/` and use that stable path in the
  index.
- Export an expression with signature `async (page, args) => result`.
- Merge optional arguments with defaults and return
  `{ failedStep: 'args', error: '<missing input>' }` for missing required
  arguments.
- Wait for observable conditions inside the script.
- Catch each logical step and return `{ failedStep, error, url: page.url() }`
  on failure.
- Return a small value that proves completion.

Built-ins use `Status: built-in`. A mined user macro requires the user's
explicit approval for that individual macro before writing its script or index
entry. Never infer approval from usefulness, prior approval of another macro,
or successful verification.

## Quick reference

| Result | Next action |
|---|---|
| Exact index match | Run its script path (home written out in full) plus args |
| Unfamiliar page | `page-affordances`, not `browser_snapshot` |
| Control missing from the digest | Read `skipped`, then snapshot |
| Success | Return the distilled value |
| First failure | Retry materially using failure context |
| Second failure | Log it and use fast-browsing |
| New mined macro | Wait for explicit per-macro approval |
