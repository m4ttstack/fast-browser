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
   the section you need, instead. Choose one for each thing the brief names
   and one for each personal detail the frame will hold, named in the brief
   or not, all in the first capture (see `redact`).
2. **Capture.** Call `browser_capture_evidence` with
   `{ targets: { <key>: "<selector>" }, frame: "auto", out: "<board>.c1" }`.
   `out` is a plain file name. The tool screenshots the viewport at 2x,
   measures each target, and writes `<board>.c1.png` and
   `<board>.c1.capture.json` (the sidecar) into `~/.fast-browser/screenshots/`.
   If the tool is not in your tool list, run `fast-browser setup`, ask the
   human to restart the Fast Browser session, and capture once it is back.
3. **Check the return.** Never edit the sidecar. A return is finished only
   when `missed` is empty, `frameSnap` is not `union` and there is no
   `failedStep`, and a thin strip the tool chose has had its retry or was
   left for the hiding budget (below);
   until then fix the cause, capture again, and write no spec.
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
   - `failedStep: "frame"` saying the frame selector does not contain every
     target: the frame is too tight. Pass, once, the next ancestor that holds
     each target's whole box (for a tab or link in a strip, the header region
     that holds the strip and the page title). Another selector for the same
     element is not a fix. If that fails too, report it and stop that board.
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
     If that capture fails at `frame` saying the frame selector is larger
     than the viewport, try once more with a smaller element inside it that
     still holds every target: for a section heading, the heading's own
     header block with what sits beside it, not the whole section. Pick one
     that is not a thin strip; if the only one that fits is a thin strip,
     pass it, and its frame is final as above. Stop that board, and say so
     in the report, when that capture fails too, at any step (do not go one
     ancestor up from it), or when the budget is spent.
   - `frame` is a thin strip (far wider than it is tall, or cutting through
     the card) when the tool chose the frame, that is `frameSnap` is neither
     `union` nor `selector`: try once with `frame: "<selector>"` for the
     element that holds the targets. If that capture succeeds and is no
     better, capture once more with `frame: "auto"` to get the tool's frame
     back, and say so in the report. If it fails, the earlier files are
     untouched: keep them and say so in the report. This retry is required,
     not optional, unless the budget went to hiding personal details (see
     the hiding rule): a report that names a thin strip names its retry, or
     says the retry was skipped for budget.
   - The capture PNG shows a value the board compares wrapped onto two
     lines: widen the viewport with `browser_resize` until it sits on one
     line, and capture again. If a wider viewport leaves it wrapped, the page
     wraps it: write the value on one line in the mark's `note` and say there
     that the page wraps it.
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
   panel shows too much to read at the size it is drawn. In a `pair`,
   capture that panel again with a tighter `frame` selector (in a `pair` of
   one region, capture both panels again on the same tighter region, with
   one selector where one names it on both pages; for a ticket image, shrink
   the panel's `frame` rectangle instead). A `steps` panel is already cropped to
   its marks, so there mark fewer things in the panel, or things closer
   together. The warning `a crop edge cuts through content` means a `steps`
   panel was cut at its marks' margin on a busy page: check that the cut
   hides nothing the step needs, and if it does, mark the element it cuts as
   well. If it says the renderer is not installed, run
   `fast-browser setup`.

   When a board has no clean way out for a leader (marks boxed in by
   content, two places far apart), compose draws a numbered pin on each mark
   and lists the labels in a numbered legend beside or below the board,
   numbered across all its panels. That is a layout, not a warning.
7. **Read the PNG** with your image-reading tool, and say in your report that
   you did. Check: the crop shows what the brief names, every lift holds its
   whole fact, its icon and any sub-line, labels sit outside the screenshot,
   a numbered pin sits on the thing its label describes, in a `pair` of one
   region, both panels show the same region, and nothing personal is
   readable anywhere on the board (addresses, phone numbers, emails, names
   that are not the point), including near its edges (compose can widen a
   frame edge up to 96px to avoid cutting text). Fix and re-render at most
   twice. If a personal detail is still readable when the budget is spent,
   report the case as not done and do not give that board's path as a
   result.

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
  a change. `FLOW` is a steps board, or one panel that shows a step or the
  starting point of a flow the brief describes. A board that shows a problem
  uses `FOUND`, and one that shows a fact on the page as it is uses `AFTER`.
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

In `steps`, each panel's mark sits on the thing its `label` names, and the
mark's `title` calls it by the label's words. A step reached by clicking a
control that stays selected, such as a tab or a menu item, marks that
selected control, so every step marks the same kind of thing. Mark a heading
the click revealed only when no control stays selected.

One capture per panel, named `<board>.c1`, `<board>.c2` and so on: run steps
2 to 4 once for each. Compose draws all panels at one height in a row, or at
one width when it stacks them, which it does for a `pair` or `steps` board
of wide, short panels. Panels share one wash and steps one zoom; none of that
needs anything from you.

A `pair` board shows each panel's frame whole, less any blank margin at
its edges: the frame selector is the region the two panels compare. A `single` board and each panel of a `steps`
board are cropped to their marks and some of the page around them, so there
the frame only bounds the crop. Every layout trims blank ground at a frame's
edges and takes a round-cornered card's outline off with it: a card shown
without its border is not a fault. Frame each panel on the smallest card or
section that holds its marks and enough around them to tell which screen it
is. Never the whole page, because a loose frame makes small panels (the
page's `main` region, or any container that holds most of the page, is the
whole page), and never a thin strip (a tab bar alone, one line of text). A
crop keeps a mark and what sits beside it, not everything in the frame: for
a `link`, give each place the element that holds the value together with the
label or heading that says what it is, so the name stays inside the lift. In
a `pair` of one region, give both captures the same frame selector. In a
`pair` across two pages, that region is the same band on each page: the
same place on screen at about the same size, such as the header strip and
the first block under it, where the thing sits on one page and would sit on
the other. If no one selector names that band on both pages, give each
capture its own frame selector for the element that holds that same visible
region. Take both captures of a `pair` at one viewport size: if step 3
resized the viewport for one panel, capture the other again at that size,
within the budget. When the only element that holds the band fills the
viewport, read where the first block under the strip ends from the first
capture's `boxes`, or its PNG divided by the sidecar's `scale`, and set the
viewport height a little more than it with one `browser_resize`, the same
for both captures. That shortened container is the one exception to never
the whole page; never frame it at full height. Restore the starting
viewport size after the last capture. On the panel where the thing is
absent, target the element inside that region at the spot where the thing
sits on the other page (the heading or block there, or the card the thing
would sit in), not a tab or label in the strip both pages share, and never
one outside the frame. Mark that element with a `lift` whose `title` says
the thing is not there, or the wash covers the whole panel and nothing says
what it shows; a heading, block or card lifted here is the one exception to
lifting the whole fact.

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
| a personal detail in the frame, named in the brief or not | `redact` |

- **One mark per point in the brief, and no others, redactions aside.** The
  board's `title` says what the board proves. A mark's label (its `title`
  and `note`) says what the mark shows that the board's title does not:
  where the page states it, the value, the state, what changed. A label
  never repeats the board's title or the lifted words, except a `steps`
  mark's `title` and a value the page wraps (see Layouts and step 3), and
  never uses an abbreviation the page does not explain. A `lift` whose fact the board's
  title already states may go without a label; `bracket` and `link` always
  take one.
- **Lift the whole fact, not its header or card, unless the brief names
  that header, row or card.** Then mark that thing with its status in it,
  not a chip inside it. Otherwise target the element that states the fact,
  with the icon or tick that belongs to it: the words "Deploy approved" and
  their tick, not the header or card they sit in, and not one word of the
  phrase. A fact with a sub-line under it is one item: target the element
  that holds the icon, the line and the sub-line, not the first line alone,
  and check in a scoped snapshot that the selector names that container. A
  row that holds only that fact is fine to select: compose tightens a lift
  to its words and takes in a tick or icon that leads the line. A heading
  or field name right beside the fact stays in the crop without a lift, so
  leave it out; only a `link` takes it in (see Layouts). When the brief
  names a small element (a badge, icon or chip), mark that element alone
  and leave its neighbours out. A `lift` is not a magnifier; for something
  too small to read, use `loupe`. Capture a small target with a `frame`
  selector for the card that holds it.
- Elements that make one point can share a `lift` as a key list. Compose
  lifts adjacent ones together and separated ones as separate lifts under
  one label. Use `link` when the point is that two places agree.
- **Hide every personal detail in the frame, listed in the brief or not.**
  A street address, a phone number, an email address, an account number or
  an id that identifies a person, and a person's name are each redacted or
  framed out. A brief that names one detail to hide has not cleared the
  others: hide them too. Never leave one readable and ask. Names or ids the
  board compares or points at (two people side by side, the record the brief
  is about) are the proof and stay. Before writing the spec, read the
  capture PNG (and a snapshot scoped to the frame if you need one) for these
  details. One with no key in `boxes` needs another capture with a target
  for it; that capture counts like any other. Spend captures on hiding
  first: the targets this rule needs, then any retry for looks; a thin strip
  left unretried for budget is kept and reported. A board that would still
  show a personal detail is not written: if the budget runs out before every
  detail is hidden, write no spec and report the case as not done for that
  reason.
- `redact` covers personal data you are not verifying with a solid fill, not
  a blur. Redact the element that holds the whole value: the fill covers that
  element's box only, drawn tight to the value's own pixels. A redact
  key that came back in `missed` is not redacted, and compose refuses it:
  fix the selector and capture again. For each value you hide, look
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
4. **Hide everything the brief says to hide, and every personal detail it
   does not list** (see `redact`), wherever it appears inside the frame, not
   only where you are pointing. Look for every place the
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

Report each board's PNG path and spec path, that you read each PNG, each
personal detail you hid that the brief did not name, each thin strip the tool
chose and the frame selector you retried it with, or that its retry was
skipped for budget, and anything you could not do. For a ticket image with a
redaction, also report
each crop's path, that you read each one, and that the board is unconfirmed.
