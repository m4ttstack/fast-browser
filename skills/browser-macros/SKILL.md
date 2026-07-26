---
name: browser-macros
description: Use when a browser task resembles a repeated flow or a reusable browser script may already cover the requested result
---

# Browser Macros

Use indexed Playwright macros instead of re-deriving known browser flows.

## Run a macro

1. Read `~/.fast-browser/macros/MACROS.md`.
2. Match the task to an entry's description and target.
3. Call `browser_run_code_unsafe` with the entry's `filename` and `args`
   exactly. Do not open the script and do not substitute inline `code`.
4. Return the macro's distilled result.

If the macro fails, use its `{ failedStep, error, url }` result to retry
materially. After the same macro fails twice, append:

```text
<macro-name> | <date> | <failedStep or reason>
```

to `~/.fast-browser/macro-failures.md`, then switch to fast-browsing recovery.
Do not keep repeating the macro.

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
| Exact index match | Run filename plus args |
| Success | Return the distilled value |
| First failure | Retry materially using failure context |
| Second failure | Log it and use fast-browsing |
| New mined macro | Wait for explicit per-macro approval |
