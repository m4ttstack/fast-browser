---
name: composing-evidence
description: Use when a live page, or a screenshot attached to a ticket, needs to become polished evidence for an MR or ticket, such as proving a value changed, showing a fixed bug, or marking what a reviewer should look at, and the result should be a cropped, labelled image rather than a marked-up full screenshot
---

# Composing Evidence

You name page elements and write words. Fast Browser measures them, crops to
the card that holds them, and lays out every mark and label. On a live page
you never place anything by pixel.

## The pipeline

1. **Choose selectors.** On a large page a full `browser_snapshot` can run to
   tens of thousands of tokens; use `browser_find`, or a snapshot scoped to
   the section you need, instead.
2. **Capture.** Call `browser_capture_evidence` with
   `{ targets: { <key>: "<selector>" }, frame: "auto", out: "<board>.c1" }`.
   `out` is a plain file name. The tool screenshots the viewport at 2x,
   measures each target, and writes `<board>.c1.png` and
   `<board>.c1.capture.json` (the sidecar) into `~/.fast-browser/screenshots/`.
   If the tool is not in your tool list, run `fast-browser setup`, ask the
   human to restart the Fast Browser session, and capture once it is back.
3. **Check the return.** Never edit the sidecar. A return is finished only
   when `missed` is empty, `frameSnap` is not `union` and there is no
   `failedStep`; until then fix the cause, capture again, and write no spec.
   Remove a key the board does not need from `targets`. If the same key
   misses on the second capture, report it and stop that board; other boards
   in the same job continue. Do not compose around it.
   - It has `failedStep`: read `error`, then fix what that step names
     (`args`, `resolve`, `frame`, `measure`).
   - `failedStep: "frame"` with `frameSnap: "too-large"`: the targets cannot
     share one viewport-sized frame. Enlarge the viewport with
     `browser_resize`, or split them into separate boards.
   - `failedStep: "frame"` saying the frame selector is larger than the
     viewport: pick a smaller element, or enlarge the viewport with
     `browser_resize`.
   - A key is in `missed` as `no-match` or `ambiguous`: the selector is
     wrong. Fix it, scoping to a unique container. For `ambiguous`, `count`
     says how many elements matched; read the structure of that region
     (`browser_find`, or a `browser_snapshot` scoped to it) before the second
     capture, then scope to the smallest element that holds the wanted match
     and none of the others. Changing the words inside the same kind of
     selector is not a fix.
   - A key is in `missed` as `not-visible` (zero-size box): the element is
     collapsed or hidden. Open, expand or reveal it first.
   - A key is in `missed` as `out-of-view`: it fell outside the viewport once
     the frame was centred, so the targets are too far apart for one view.
     Pass a tighter `frame`, enlarge the viewport with `browser_resize`, or
     split into separate boards.
   - `failedStep: "resolve"` or `"frame"` saying the element is inside a
     shadow root or an iframe: it cannot be a target. Name the element
     that hosts it (the custom element, or the `iframe`) instead.
   - `frameSnap` is `union`: pass `frame: "<selector>"` for the element that
     holds the targets and capture again. The frame from that capture is
     final, thin strip or not; if it is a thin strip, say so in the report.
     If that capture fails at `frame` because no element both holds the
     targets and fits the viewport, say so in the report and stop that board.
   - `frame` is a thin strip (far wider than it is tall, or cutting through
     the card) when the tool chose the frame, that is `frameSnap` is neither
     `union` nor `selector`: try once with `frame: "<selector>"` for the
     element that holds the targets. If that capture succeeds and is no
     better, capture once more with `frame: "auto"` to get the tool's frame
     back, and say so in the report. If it fails, the earlier files are
     untouched: keep them and say so in the report.
   - The call fails with an error instead of a return (it timed out, the
     page moved while it was captured, the page lays out differently at
     2x, the page is pinch-zoomed): do what the message says, then
     capture again once. If it fails the same way, report it and stop that
     board; other boards in the same job continue.
4. **Keep the sidecar.** The return carries its path as `sidecar`; carry that
   path forward. Compose refuses a sidecar whose image, frame, boxes or
   scale were changed afterwards.
5. **Write the spec** beside the sidecar, in `~/.fast-browser/screenshots/`.
   `capture` names the sidecar by its file name only.
6. **Render.** `fast-browser compose <spec.json>`. If it lists problems, fix
   every one and run it again. Read any warnings it prints. Each warning names
   something compose could not lay out well; a tighter frame or a different
   mark usually clears it. The warning
   `a panel is drawn small; frame the card that holds its marks` means a
   panel shows too much to read at the size it is drawn. In a `pair`, capture that panel again with a
   tighter `frame` selector (in a `pair` of one region, capture both panels
   again with the same tighter selector; for a ticket image, shrink the
   panel's `frame` rectangle instead). A `steps` panel is already cropped to
   its marks, so there mark fewer things in the panel, or things closer
   together. The warning `a crop edge cuts through content` means a `steps`
   panel was cut at its marks' margin on a busy page: check that the cut
   hides nothing the step needs, and if it does, mark the element it cuts as
   well. If it says the renderer is not installed, run
   `fast-browser setup`.
7. **Read the PNG** with your image-reading tool, and say in your report that
   you did. Check: the crop shows what the brief names, each lift sits on the
   whole element it means, labels sit outside the screenshot, in a `pair` of
   one region, both panels show the same region, and nothing personal is readable
   that you did not mean to show, including near the board's edges (compose
   can widen a frame edge up to 96px to avoid cutting text). Fix and re-render
   at most twice.

   Check too that each mark sits on the element the brief describes, by look
   and position, not on a neighbour. If it is on a neighbour, fix the
   selector and capture again. If the budget is spent, report the case as not
   done rather than present a board that points at the wrong thing.

## Selectors

Each selector must match exactly one element.

| Situation | Selector |
|---|---|
| A heading, button, link, row | `role=heading[name="Example"]` |
| Text inside a known section | `<unique container> >> text=Status unknown` |
| A `data-testid` exists | `[data-testid=summary]` (often absent; do not wait for one) |
| The same element repeats | scope to the one container that is unique; never `nth=` |
| A small icon or badge | read its role and accessible name from `browser_find` or a scoped `browser_snapshot`, then `<unique container> >> role=<role>[name="<name>"]`; never count siblings with `following::` or positional xpath |

An icon's accessible name is often not what the brief calls it: a badge the
brief describes by colour and letter may be an `img` whose accessible name
is `Pinned`, selected as `role=img[name="Pinned"]`, while a different icon
beside it carries a name that sounds like the brief's words. The same icon also repeats down a page.
Match by what the element is and where it sits, and scope it to its unique
container. An element in a card's header or toolbar is often not inside the
container the card's body has: before capturing, take a `browser_snapshot`
scoped to the container you mean to scope to and find the element in it; if
it is not there, scope to the nearest container that does hold it. A capture
that comes back `no-match` is a capture spent.

## Spec

```json
{
  "state": "BEFORE → AFTER",
  "title": "One sentence: what this board proves",
  "layout": "pair",
  "out": "<board>.png",
  "panels": [
    { "label": "BEFORE", "capture": "<board>.c1.capture.json",
      "marks": [ { "empty": "chart", "text": "Nothing rendered here" } ] },
    { "label": "AFTER", "capture": "<board>.c2.capture.json",
      "marks": [
        { "lift": "status", "title": "Short label", "note": "One line", "tag": "CHANGED" },
        { "lift": ["owner", "role"], "title": "One point, two elements" },
        { "bracket": ["row2", "row3"], "title": "Two rows", "note": "One line" },
        { "loupe": "badge", "zoom": 4, "title": "Tiny badge" },
        { "link": ["total", "rowTotal"], "title": "Same number, two places" },
        { "ghost": "gap", "tag": "REMOVED", "title": "Export is gone" },
        { "redact": "email" }
      ] }
  ]
}
```

- `state`: `FOUND` is a problem found (it draws red). `AFTER` is how the page
  is now, working as intended (green). `BEFORE → AFTER` is a pair that shows
  a change. `FLOW` is a steps board.
- `out` is a file name; the board is written to `~/.fast-browser/screenshots/`.
- Every key a mark names must be in that panel's capture `boxes`.
- Every mark but `redact` takes an optional `title`, `note` (one line) and
  `tag`: `NEW`, `CHANGED`, `REMOVED`, `ISSUE`, `PENDING` or `OK`. `bracket`
  and `link` need a `title`.

### Layouts

| `layout` | Panels | Use it for |
|---|---|---|
| `single` | one, with no `label`: the board's `state` already says what it is | one screen |
| `pair` | two, each with a `label` (free text, up to 48 characters) naming what that panel is: `BEFORE` and `AFTER` for a change over time, `LIGHT` and `DARK` for themes, otherwise the two things compared (two people, two records, two environments) | one region in two states, or two things side by side |
| `steps` | two to four, in order, each `label` saying what the user does | a flow across screens |

One capture per panel, named `<board>.c1`, `<board>.c2` and so on: run steps
2 to 4 once for each. Compose draws all panels at one height.

A `pair` board shows each panel's frame whole, less any blank margin at
its edges: the frame selector is the region the two panels compare. A `single` board and each panel of a `steps`
board are cropped to their marks and some of the page around them, so there
the frame only bounds the crop. Frame each panel on the smallest card or
section that holds its marks and enough around them to tell which screen it
is. Never the whole page, because a loose frame makes small panels (the
page's `main` region, or any container that holds most of the page, is the
whole page), and never a thin strip (a tab bar alone, one line of text). A
crop keeps a mark and what sits beside it, not everything in the frame: for
a `link`, give each place the element that holds the value together with the
label or heading that says what it is, so the name stays inside the lift. In
a `pair` of one region, give both captures the same frame selector.

For `LIGHT` and `DARK`, capture, switch the app's own theme control, and
capture again with the same selectors and the same frame selector.

### Marks

| The brief says | Mark |
|---|---|
| point at an element | `lift` |
| a group of rows or lines | `bracket` over the rows' keys |
| something too small to read: an icon, a badge, a one-word chip | `loupe` (`zoom` 2 to 8; 4 unless told) |
| one fact shown in two places | `link` with exactly two keys |
| something was removed | `ghost` on the gap, or on the element now in its place |
| nothing rendered where something should | `empty` on the blank region; `text` says what is missing. If the region shows a message or placeholder text, `lift` that text instead: `empty` draws over whatever is in the box |
| hide personal data | `redact` |

- **Lift the whole fact.** Target the element that holds the chip and its
  value, the icon and its text, not one word of it. When the brief names a
  small element (a badge, icon or chip), mark that element alone and leave
  its neighbours out: `lift` enlarges it a little, `loupe` magnifies it.
  Capture a small target with a `frame` selector for the card that holds it.
- Elements that make one point can share a `lift` as a key list. Compose
  lifts adjacent ones together and separated ones as separate lifts under
  one label. Use `link` when the point is that two places agree.
- `redact` covers personal data you are not verifying with a solid fill, not
  a blur. Redact the element that holds the whole value: the fill covers that
  element's box only. A redact key that came back in `missed` is not
  redacted, and compose refuses it: fix the selector and capture again.
  When the brief names a value to hide (a name, an address, a number), look
  for every place that value, or a part of it, appears inside the frame
  (headings, titles, other rows), and redact each or frame them out; then
  check the board for it by eye. A box that cuts an icon or a word in half
  reads as a glitch: make each `redact` box cover whole elements, or stop
  short of them.

## A screenshot from a ticket

A ticket's screenshot has no page behind it, so nothing can be measured.
This is the one place you write coordinates.

1. **Import it.**
   `fast-browser compose --import <image> --out <board>.c1 --origin <ticket link>`.
   It prints the image's real size and the sidecar path.
2. **Read the image and place the frame and the boxes** in the image's real
   pixels. Your viewer may show it smaller; then multiply everything you
   read off it by real width over shown width. Pad each box 6 to 10 real
   pixels so it covers what it marks.
3. **Write the panel** with `frame` and `boxes` beside `capture`:

```json
{ "capture": "<board>.c1.capture.json",
  "frame": [x, y, w, h],
  "boxes": { "chart": [x, y, w, h], "email": [x, y, w, h] },
  "marks": [ { "empty": "chart", "text": "Nothing rendered here" }, { "redact": "email" } ] }
```

   The whole image is `[0, 0, width, height]`, and is almost never the right
   frame. Compose refuses a frame outside the image and a box outside the
   frame, and labels the panel as from the ticket.
4. **Hide everything the brief says to hide**, wherever it appears inside
   the frame, not only where you are pointing. Look for every place the
   value, or a part of it, appears (headings, titles, other rows), and
   redact each or crop it out. Make each box cover whole elements, or stop
   short of them. Crop first: what is outside the frame is not shown. On a
   ticket image compose never widens the frame you give; if it warns that a
   frame edge cuts through content, move that edge yourself.
5. **Render, then read every crop.** For a ticket image with a `redact`,
   compose writes `<board>.redact-<n>.png` beside the board, one per
   redaction on the board, live panels' included, at full resolution. Read
   every crop as well as the board: the crop is where a redaction is checked,
   because a shrunken board is how a readable sliver survives. If any letter
   shows, widen that box and render again.
6. **Stop there.** The board is not done until the operator has looked at
   each crop of the latest render and said yes. Report the crop paths and
   that the board is unconfirmed, and attach or post the board nowhere until
   then. `fast-browser compose --confirm <spec.json>` records that yes.
   Never run it yourself unless the operator confirmed the crops of the
   latest render in this conversation. A re-render renders it unconfirmed
   again: ask again after any re-render.

When a live after is paired with a ticket before, give each panel its
`label` and frame the after on the same region with an explicit frame
selector.

## Done means

Report each board's PNG path and spec path, that you read each PNG, and
anything you could not do. For a ticket image with a redaction, also report
each crop's path, that you read each one, and that the board is unconfirmed.
