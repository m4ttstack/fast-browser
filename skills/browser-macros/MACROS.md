# Macro Index

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
  match, matched more than once, or fell outside the viewport. Runs with no
  Node globals in scope, so it cannot read `$HOME` itself; pass your own
  absolute home directory as `home`.
- Params: `{ targets: Record<string, string>, out?: string (default "capture"), home: string (your absolute home directory path) }`
- Target: Current page (site-agnostic)
- Script: `~/.fast-browser/macros/capture-annotated.js`
- Status: built-in
