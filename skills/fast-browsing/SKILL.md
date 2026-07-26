---
name: fast-browsing
description: Use when browser automation spans multiple interactions or page reads and latency, token use, or observation size matters
---

# Fast Browsing

Minimize browser round trips and observation size. Prefer one informed batch
over repeated inspect-and-click cycles.

## Start with macros

Read `~/.fast-browser/macros/MACROS.md` before any browser action. When one
entry matches, make one `browser_run_code_unsafe` call with exactly its
`filename` and `args`. Do not open the script or send inline `code`.

If the macro fails twice, record the failure as directed by browser-macros,
then use the loop below.

## Use the fast loop

1. **Scout once.** On an unfamiliar page, call `browser_snapshot` once. Use
   `browser_find` instead when the desired text or control is already known.
2. **Batch the known remainder.** Put every predictable navigation,
   interaction, assertion, and wait into one `browser_run_code_unsafe` call.
   Split only when the next action depends on information the script cannot
   determine internally.
3. **Read narrowly.** Use `browser_find` for known text and a targeted
   `browser_snapshot` for one region. Take another full snapshot only when
   genuinely lost.
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
| Matching macro | Run its filename and args once |
| Unfamiliar page | Scout once |
| Predictable multi-step flow | Batch it |
| Known text or region | Read it narrowly |
| Same step failed twice | Change to single-step recovery |
| Task complete | Return only the distilled result |
