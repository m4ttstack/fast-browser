---
name: composing-evidence
description: Use when a live page needs to become polished evidence for an MR or ticket, such as proving a value changed, showing a fixed bug, or marking what a reviewer should look at, and the result should be a cropped, labelled image rather than a marked-up full screenshot
---

# Composing Evidence

You name page elements and write words. Fast Browser measures them, crops to
the card that holds them, and lays out every mark and label. You never place
anything by pixel, and you never type a number into a spec.

## The pipeline

1. **Choose selectors.** On a large page a full `browser_snapshot` can run to
   tens of thousands of tokens; use `browser_find`, or a snapshot scoped to
   the section you need, instead.
2. **Capture.** `browser_run_code_unsafe` with
   `filename: "<your absolute home directory>/.fast-browser/macros/capture-evidence.js"`,
   the `~/.fast-browser/macros/capture-evidence.js` path with `~` written out
   (a bare or `~` path is refused as outside allowed roots), and
   `args: { targets: { <key>: "<selector>" }, frame: "auto", out: "<board>.c1", home: "<your absolute home directory>" }`.
   `out` is a plain file name; the PNG lands in `~/.fast-browser/screenshots/`.
   If the call reports the macro file is missing (ENOENT), run
   `fast-browser setup`, then capture.
3. **Check the return.** Never edit the return. Fix the cause and capture
   again:
   - It has `failedStep`: fix what that step names (`args`, `resolve`,
     `frame`, `measure`).
   - `failedStep: "frame"` with `frameSnap: "too-large"`: the targets cannot
     share one viewport-sized frame. Enlarge the viewport with
     `browser_resize`, or split them into separate boards.
   - A key is in `missed` as `no-match` or `ambiguous`: the selector is
     wrong. Fix it, scoping to a unique container.
   - A key is in `missed` as `not-visible` (zero-size box): the element is
     collapsed or hidden. Open, expand or reveal it first.
   - A key is in `missed` as `out-of-view`: it fell outside the viewport once
     the frame was centred, so the targets are too far apart for one view.
     Pass a tighter `frame`, enlarge the viewport with `browser_resize`, or
     split into separate boards.
   - `frameSnap` is `union`, or `frame` is a thin strip (far wider than it is
     tall, or cutting through the card): pass `frame: "<selector>"` for the
     card that holds the targets.
4. **Seal.** Save the return, verbatim, to a file (for example
   `~/.fast-browser/screenshots/<board>.c1.return.json`) and run
   `fast-browser compose --seal <file>`. It prints the sidecar path,
   `~/.fast-browser/screenshots/<board>.c1.capture.json`.
5. **Write the spec** beside the sidecar, in `~/.fast-browser/screenshots/`.
   `capture` names the sidecar by its file name only.
6. **Render.** `fast-browser compose <spec.json>`. If it lists problems, fix
   every one and run it again. Read any warnings it prints. If it says the
   renderer is not installed, run `fast-browser setup`.
7. **Read the PNG** with your image-reading tool, and say in your report that
   you did. Check: the crop shows what the brief names, each lift sits on the
   whole element it means, labels sit outside the screenshot, and nothing
   personal is readable that you did not mean to show, including near the
   board's edges (compose can widen a frame edge up to 96px to avoid cutting
   text). Fix and re-render at most twice.

## Selectors

Each selector must match exactly one element.

| Situation | Selector |
|---|---|
| A heading, button, link, row | `role=heading[name="Example"]` |
| Text inside a known section | `<unique container> >> text=Status unknown` |
| A `data-testid` exists | `[data-testid=summary]` (often absent; do not wait for one) |
| The same element repeats | scope to the one container that is unique; never `nth=` |
| A small icon or badge | read its role and accessible name from `browser_find` or a scoped `browser_snapshot`, then `<unique container> >> role=<role>[name="<name>"]`; never count siblings with `following::` or positional xpath |

## Spec

```json
{
  "state": "AFTER",
  "title": "One sentence: what this board proves",
  "layout": "single",
  "out": "<board>.png",
  "panels": [{
    "capture": "<board>.c1.capture.json",
    "marks": [
      { "lift": "status", "title": "Short label", "note": "One line", "tag": "CHANGED" },
      { "lift": ["owner", "role"], "title": "One point, two elements" },
      { "redact": "email" }
    ]
  }]
}
```

- `state`: `AFTER`, `BEFORE → AFTER`, `FLOW` or `FOUND`.
- `layout` is `single`, with exactly one panel. `out` is a file name; the
  board is written to `~/.fast-browser/screenshots/`.
- Two marks exist: `lift` and `redact`. Every key a mark names must be in the
  capture's `boxes`.
- `lift` raises an element and connects its label. Optional `title`, `note`
  (one line), and `tag`: `NEW`, `CHANGED`, `REMOVED`, `ISSUE`, `PENDING` or
  `OK`.
- **Lift the whole fact.** Target the element that holds the chip and its
  value, the icon and its text, not one word of it. When the brief names a
  small element (a badge, icon or chip), lift that element alone and leave
  its neighbours out; compose enlarges it to a readable size.
- Elements that make one point can share a mark as a key list. Compose lifts
  adjacent ones together and separated ones as separate lifts under one
  label.
- `redact` covers personal data you are not verifying with a solid fill, not
  a blur. Redact the element that holds the whole value: the fill covers that
  element's box only. A redact key that came back in `missed` is not
  redacted, and compose refuses it: fix the selector and capture again.

## Done means

Report each board's PNG path and spec path, that you read each PNG, and
anything you could not do.
