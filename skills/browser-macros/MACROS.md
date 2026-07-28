# Macro Index

## page-recon

- Description: Return compact reconnaissance of the current page: URL, title,
  up to ten headings, and a bounded list of links with visible names and hrefs.
- Params: `{ maxLinks?: number (default 10) }`
- Target: Current page (site-agnostic)
- Script: `~/.fast-browser/macros/page-recon.js`
- Status: built-in

## capture-annotated

- Description: Capture the viewport to a PNG and measure named CSS selectors to
  pixel boxes in the same page state, for use with `fast-browser annotate`.
  Returns resolved boxes plus a `missed` list naming any selector that did not
  match, matched more than once, or fell outside the viewport.
- Params: `{ targets: Record<string, string>, out?: string (default "capture") }`
- Target: Current page (site-agnostic)
- Script: `~/.fast-browser/macros/capture-annotated.js`
- Status: built-in
