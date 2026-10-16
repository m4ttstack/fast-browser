---
name: composing-evidence
description: Use when a live page, or a screenshot attached to a ticket, needs to become polished evidence for an MR or ticket, such as proving a value changed, showing a fixed bug, or marking what a reviewer should look at, and the result should be a cropped, labelled image rather than a marked-up full screenshot
---

# Composing Evidence

You name page elements and write words. Fast Browser measures them, crops to
the card that holds them, and lays out every mark and label. On a live page
you never place anything by pixel.

## The pipeline

1. **Choose selectors.** A full `browser_snapshot` of a large page is huge;
   use `browser_find`, or a snapshot scoped to the section you need. Before
   the first capture of any frame, take a snapshot scoped to the frame
   element; with `frame: "auto"`, snapshot the card that holds the targets.
   Choose one selector for each thing the brief names and one for each
   personal detail that snapshot shows, named in the brief or not, all in
   the first capture (see `redact`).
2. **Capture.** Call `browser_capture_evidence` with
   `{ targets: { <key>: "<selector>" }, frame: "auto", out: "<board>.c1" }`.
   Pass `frame: "<css selector>"` instead when a rule below names the frame
   (a `pair` of one region, a small target, two places far apart, a live
   after beside a ticket before; see Selectors for how to write one).
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
   - `frameSnap` is `union`: pass `frame: "<css selector>"` for the element that
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
     `union` nor `selector`: try once with `frame: "<css selector>"` for the
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
   every one and run it again. If it says the renderer is not installed, run
   `fast-browser setup`. Read any warnings it prints; each names something
   compose could not lay out well:

   | Warning | What to do |
   |---|---|
   | `a panel is drawn small; frame the card that holds its marks` | The panel shows too much to read at its size. In a `pair`, capture that panel again with a tighter `frame` selector (in a `pair` of one region, capture both panels again on the same tighter region, with one selector where one names it on both pages; for a ticket image, shrink the panel's `frame` rectangle instead). A `steps` panel is already cropped to its marks, so there mark fewer things in the panel, or things closer together. |
   | `a lift hides content beside it` | The lifted card covers content beside its target. Read the board for what is hidden. If the fact needs it, target the element that holds both; if not, target an element that stands clear of it. |
   | `a crop edge cuts through content` | A `steps` panel was cut at its marks' margin on a busy page. Check that the cut hides nothing the step needs; if it does, mark the element it cuts as well. |
   | `a label repeats the board's title` | A label copies the board title. Reword the label so it says what the title does not. Never delete a mark's callout, and never weaken the board title: it keeps stating the fact. |
   | `a panel label repeats where the image came from` | Rename that panel's `label` (see step 7). |
   | `a redact mark on panel <n> lies outside the board, so it hides nothing` | That value is already cropped out; drop the mark. |

   When a board has no clean way out for a leader (marks boxed in by
   content, two places far apart), compose draws a numbered pin on each mark
   and lists the labels in a numbered legend beside or below the board,
   numbered across all its panels. That is a layout, not a warning.
7. **Read the PNG** with your image-reading tool, and say in your report that
   you did. Check: the crop shows what the brief names, every lift holds its
   whole fact, its icon and any sub-line (unless cut short or meaningless
   alone; see below), labels sit outside the screenshot, a numbered pin sits
   on the thing its label describes, in a `pair` of one region, both panels
   show the same region, and nothing personal is readable anywhere on the
   board (addresses, phone numbers, emails, names that are not the point),
   including near its edges. Fix and re-render at most twice. If a personal
   detail is still readable when the budget is spent, report the case as not
   done and do not give that board's path as a result.

   Check too that each mark sits on the element the brief describes, by look
   and position, not on a neighbour. If it is on a neighbour, fix the
   selector and capture again. If the budget is spent, report the case as not
   done rather than present a board that points at the wrong thing.

   Then check the words:
   - Reword a label that copies the board title, the tag or the lifted
     words (see Marks for the exceptions), or that describes the board's
     layout, so it adds what the title does not; outside `steps`, never
     leave a mark without its callout.
   - The board title states the fact the board proves, as a short sentence:
     "Sprint 4 is Ready for review", never the record and the section that
     holds it ("Sprint 4, Release panel") or how an element looks. When the
     board proves more than one fact, the title states each of them
     ("Sprint 4 is Ready for review and due Mar 4"), and so does a board of
     two or more records' statuses (see Marks). The board title uses the
     page's own words for the field it proves: "Ready for review", not a
     paraphrase such as "awaiting review".
   - A pair's panel `label` says what the panel shows, never where the image
     came from. Compose labels a ticket image itself.
   - A fact whose sub-line is cut short or means nothing alone is lifted
     without it: target the line's own element, with its icon, so the lift
     leaves the sub-line out. No label quotes that sub-line. The lift's
     `note` mentions it only when it can say in plain words what it means
     ("week to date").
     Then check the PNG for a part of that sub-line peeking out under the
     lift's card. If any of it shows, target the whole item instead.

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
beside it carries a name that sounds like the brief's words.
Match by what the element is and where it sits, and scope it to its unique
container. An element in a card's header or toolbar is often not inside the
container the card's body has: before capturing, take a `browser_snapshot`
scoped to the container you mean to scope to and find the element in it; if
it is not there, scope to the nearest container that does hold it. A capture
that comes back `no-match` is a capture spent.

A `frame` selector is CSS: `#id`, `[data-testid=x]`, `section.release`, or
an attribute such as `[aria-labelledby=release-title]`. The capture refuses
`role=` and `text=` frames. To write one, read the element's attributes from
a scoped `browser_snapshot` or a `browser_find` result, then build the
selector from an id, a data attribute or an aria attribute.

## Spec

```json
{
  "state": "BEFORE → AFTER",
  "title": "One sentence: what this board proves",
  "layout": "pair",
  "out": "<board>.png",
  "panels": [
    { "label": "BEFORE", "capture": "<board>.c1.capture.json",
      "marks": [ { "empty": "chart", "text": "Nothing rendered here", "title": "Sales chart", "note": "One line" } ] },
    { "label": "AFTER", "capture": "<board>.c2.capture.json",
      "marks": [
        { "lift": "status", "title": "Short label", "note": "One line", "tag": "CHANGED" },
        { "lift": ["owner", "role"], "title": "One point, two elements", "note": "One line" },
        { "bracket": ["row2", "row3"], "title": "Two rows", "note": "One line" },
        { "loupe": "badge", "zoom": 4, "title": "Tiny badge", "note": "One line" },
        { "link": ["total", "rowTotal"], "title": "Same number, two places" },
        { "ghost": "gap", "tag": "REMOVED", "title": "Export button", "note": "Gone from the toolbar" },
        { "redact": "email" }
      ] }
  ]
}
```

- `state` says what kind of board it is:

  | `state` | Use it for |
  |---|---|
  | `AFTER` | a fact on the page as it is now, in one panel or two, including a neutral comparison of two things (two owners, two records). It draws green |
  | `FOUND` | a problem on the page. It draws red |
  | `BEFORE → AFTER` | only a `pair` that shows one thing before and after a change |
  | `FLOW` | only a `steps` board, or a single panel the brief calls the start of a flow |
- `out` is a file name; the board is written to `~/.fast-browser/screenshots/`.
- Every key a mark names must be in that panel's capture `boxes`.
- Any mark but `redact` and `context` may take a `title`, `note` (one
  line) and `tag`: `NEW`, `CHANGED`, `REMOVED`, `ISSUE`, `PENDING` or
  `OK`. Outside `steps`, `lift`, `loupe`, `ghost` and `empty` need a `title`
  and a `note`; `bracket` and `link` always need a `title`. `ISSUE` goes
  only on a problem; a neutral fact gets no tag, or `OK`.
- Any panel may take a `tag` (one of the same tags) and a `note` (one line),
  drawn in its head after its `label`.

### Layouts

| `layout` | Panels | Use it for |
|---|---|---|
| `single` | one, with no `label`: the board's `state` already says what it is | one screen |
| `pair` | two, each with a `label` (free text, up to 48 characters) naming what that panel is: `BEFORE` and `AFTER` for a change over time, `LIGHT` and `DARK` for themes, otherwise the two things compared (two people, two records, two environments) | one region in two states, or two things side by side |
| `steps` | two to four, in order, each `label` saying what the user does | a flow across screens |

In `steps`, each panel's mark sits on the thing its `label` names. The tag
and the outcome description sit on the step: its panel `label` (the step's
title), its panel `tag` and its panel `note`. So a mark inside a step may go
without text (a `bracket` or `link` still takes its `title`). Give the mark
a `title` only when it adds a value or state the step does not say. A step
reached by clicking a control that stays selected, such as a tab or a menu
item, marks that selected control, so every step marks the same kind of
thing. Mark a heading the click revealed only when no control stays
selected.

When the mark does not show the record, name it in the step's `label`. If
what identifies it (its name, the selected tab) sits about one card from the
mark, also add `{ "context": "<key>" }`; the `label` still names the record,
because `context` draws no words. Never add context for anything farther: a
`context` far from the mark makes the crop large and the marked element
small.

One capture per panel, named `<board>.c1`, `<board>.c2` and so on: run steps
2 to 4 once for each. Compose draws all panels at one height in a row, or at
one width when it stacks them, which it does for a `pair` or `steps` board
of wide, short panels. Panels share one wash. Steps share one zoom only when
compose can: when their zooms spread too far it evens them out, unless that
would draw a panel below about 0.55. So frame each step on a comparable
region (the same kind of card at about the same size), and the zooms match.

A `pair` board shows each panel's frame whole, less any blank margin at
its edges: the frame selector is the region the two panels compare. A
`single` board and each panel of a `steps` board are cropped to their marks
and some of the page around them, so there the frame only bounds the crop.
Every layout trims blank ground at a frame's edges and takes a round-cornered
card's outline off with it: a card shown without its border is not a fault.
Frame each panel on the smallest card or section that holds its marks and
enough around them to tell which screen it is; a small target is framed on
its row or column instead (see Marks). Never the whole page, because a loose
frame makes small panels (the page's `main` region, or any container that
holds most of the page, is the whole page), and never a thin strip (a tab
bar alone, one line of text). A crop keeps a mark and what sits beside it,
not everything in the frame: for a `link`, give each place the element that
holds the value together with the label or heading that says what it is, so
the name stays inside the lift. In a `pair` of one region, give both
captures the same frame selector. In a `pair` across two pages, that region
is the same band on each page: the same place on screen at about the same
size, such as the header strip and the first block under it, where the thing
sits on one page and would sit on the other. If no one selector names that
band on both pages, give each capture its own frame selector for the element
that holds that same visible region. Take both captures of a `pair` at one
viewport size: if step 3 resized the viewport for one panel, capture the
other again at that size, within the budget. When the only element that
holds the band fills the viewport, read where the first block under the
strip ends from the first capture's `boxes`, or its PNG divided by the
sidecar's `scale`, and set the viewport height a little more than it with
one `browser_resize`, the same for both captures. That shortened container
is the one exception to never the whole page; never frame it at full height.
Restore the starting viewport size after the last capture. On the panel
where the thing is absent, target the element inside that region at the spot
where the thing sits on the other page (the heading or block there, or the
card the thing would sit in), not a tab or label in the strip both pages
share, and never one outside the frame. Mark that element with a `lift`
whose callout says the thing is not there and where it would sit, or the
wash covers the whole panel and nothing says what it shows; a heading,
block or card lifted here
is the one exception to lifting the whole fact. In a pair that shows a thing
absent on one side and present on the other, both sides carry a mark: the
absence (`empty`, `ghost`, or that `lift`) and the presence (a `lift`).

Lifts in one row of panels target the same kind of element on each panel,
so they frame the same parts: both the card row that holds the record's
name and its status, or both the line that states the fact. A part only one
panel has does not change which element you lift.

For `LIGHT` and `DARK`, capture, switch the app's own theme control, and
capture again with the same selectors and the same frame selector.

### Marks

| The brief says | Mark |
|---|---|
| point at an element | `lift` |
| a group of rows or lines | `bracket` over the rows' keys |
| something too small to read: an icon, a badge, a one-word chip | `loupe` (`zoom` 2 to 8; 4 unless told) |
| one fact shown in two places | `link` with exactly two keys |
| something was removed | `ghost` on the gap, or on the element now in its place; compose grows a small `ghost` to a readable size |
| nothing rendered where something should | `empty` on the blank region; `text` says what is missing. If the region shows a message or placeholder text, `lift` that text instead: `empty` draws over whatever is in the box |
| a personal detail in the frame, named in the brief or not | `redact` |
| keep an element in a `steps` crop without drawing on it: what identifies the record, when it sits about one card from the step's mark; or a line a redaction's refusal names that is the board's own, not the value's | `context` (keys only, no words) |

- **One mark per point in the brief, and no others, redactions and
  `context` aside.** The board's `title` says what the board proves. Every
  `lift`, `loupe`, `ghost` and `empty` outside `steps` gets a callout: a
  `title` naming the record, field or control in a few words ("Delivery
  van", "Ada's invoice"), and a `note` giving what that title does not: the
  value, the state, or where on the page it is ("On the fleet plan", "Open
  tab under Invoices"). An `empty` keeps its `text`, drawn inside the blank
  to say what is missing; compose drops it when it does not fit, so then say
  it in the `note`. A label may name the record or fact the board's title
  names, but never copies its sentence or the tag, never quotes the lifted
  words (except a value the page wraps, see step 3, or a status a header or
  card shows, see the next rule), never uses an abbreviation the page does
  not explain, and never describes the board's layout ("separate point").
- **Lift the whole fact, not its header or card, unless the brief names
  that header, row or card itself, or a status it shows.** Then mark that
  thing with its status in it, not a chip inside it. For a status ("the
  card shows it is overdue"), lift the smallest header or card row that
  holds the record's name, tag or picture and the status with its icon,
  never the status line alone, so the board shows whose status it is. Its
  `title` names the record ("Atlas project"), never by its tag or code
  alone, and its `note` gives the status in the page's words ("Budget
  approved"). With two or more such records, the board title states each
  fact ("Atlas has its budget approved; Borealis's budget is pending"), not
  just the field. Otherwise target the element that states the fact, with
  its own icon or tick: the words "Due Mar 4" and their clock icon, not the
  header or card they sit in, and not one word of it.
  A fact with a sub-line under it is one item: target the element that
  holds the icon, the line and the sub-line, not the first line alone (a
  sub-line cut short or meaningless alone is the exception; see step 7), and
  check in a scoped snapshot that the selector names that container. A row
  that holds only that fact is fine to select: compose tightens a lift to
  its words and takes in a tick or icon that leads the line. A heading or
  field name right beside the fact stays in the crop without a lift, so
  leave it out; only a `link` takes it in (see Layouts). When the brief
  names a small element (a badge, icon or chip), mark that element alone and
  leave its neighbours out. A `lift` is not a magnifier; for something too
  small to read, use `loupe`. Capture a small target with a `frame` selector
  for the smallest row, column or card that holds it. The frame is the region
  round the target, so the marks and their context fill most of it. A tiny
  target at the edge of a wide card gets a frame on its row or column, not
  the card.
- Elements that make one point can share a `lift` as a key list. Compose
  lifts adjacent ones together and separated ones as separate lifts under
  one label. Use `link` when the point is that two places agree. Two places
  far apart are fine: frame the smallest element that holds both. That
  frame also holds everything between them, so its snapshot (step 1) needs
  a `redact` target for each personal detail in it.
- **Hide every personal detail in the frame, listed in the brief or not.**
  A street address, a phone number, an email address, an account number or
  an id that identifies a person, and a person's name are each redacted or
  framed out. A brief that names one detail to hide has not cleared the
  others: hide them too. Never leave one readable and ask. Names or ids the
  board compares or points at (two people side by side, the record the brief
  is about) are the proof and stay. Before writing the spec, read the
  capture PNG for these details. One with no key in `boxes` needs another
  capture with a target for it; that capture counts like any other. Spend
  captures on hiding first: the targets this rule needs, then any retry for
  looks; a thin strip left unretried for budget is kept and reported. A
  board that would still show a personal detail is not written: if the
  budget runs out before every detail is hidden, write no spec and report
  the case as not done for that reason.
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
   pixels so it covers what it marks, except a `ghost` box over a gap: draw
   that over the empty gap only, unpadded, clear of any glyph, icon or text
   beside it.
3. **Write the panel** with `frame` and `boxes` beside `capture`:

```json
{ "capture": "<board>.c1.capture.json",
  "frame": [x, y, w, h],
  "boxes": { "chart": [x, y, w, h], "email": [x, y, w, h] },
  "marks": [ { "empty": "chart", "text": "Nothing rendered here", "title": "Sales chart", "note": "One line" }, { "redact": "email" } ] }
```

   The whole image is `[0, 0, width, height]`, and is almost never the right
   frame: draw the frame round the target's own region. Compose refuses a
   frame outside the image and a box outside the frame.
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
   because a shrunken board is how a readable sliver survives. Each crop
   shows a margin of what lies just past its fill, so you can check that
   nothing of the value continues beyond it. If any letter shows, widen that
   box and render again. Compose grows an imported
   redaction over ink that reaches its edge, and says so in a message that
   starts `a redaction on panel <n> (<mark>)`. A written board never shows
   ink that may be the value's: where the fill could not cover it, compose
   refuses the board instead, and the message ends with what to do.

   | Rest of the message | Kind |
   |---|---|
   | `grew to cover ink beside it` | warning |
   | `covered a line beside it to that line's end, past its <side> edge` | warning |
   | `covered ink past a gap at its <side> edge` | warning |
   | `stopped at a gap with more ink just past its <side> edge` | warning: that ink lies off the value's columns, or past another line |
   | `met another mark's box with ink still at its <side> edge` | warning; a refusal on the value's own line |
   | `reached the frame with ink still at its <side> edge` | warning; a refusal on the value's own line |
   | `reached its growth limit with ink still at its <side> edge` | refusal |
   | `stopped at a rule past its <side> edge with a line of text just past it, at [x, y, w, h] in the image` | refusal: a row's border with text past it that may be the value's other line |
   | `left a line past its <side> edge uncovered, at [x, y, w, h] in the image, as another row of its list` | refusal: a row of an icon-led list that may hold a second value |
   | `met an empty slot at its <side> edge with text inside the slot's box, at [x, y, w, h] in the image` | refusal: the `empty` box was drawn over text |

   A redact box the crop leaves out is a stray: `a redact mark on panel <n>
   lies outside the board, so it hides nothing` is a warning, and `... but
   the value's ink runs into the board past its <side> edge` is a refusal.

   - On a warning, read that redaction's crop and check that nothing of the
     value shows. A covered neighbouring line is expected, because hiding
     comes first.
   - On a refusal, no board was written. Do what the message says, then
     render again: when the line it names is the value's, draw the redact
     box over the whole value including that line; when it is the board's
     own (another row, a neighbour's line), add a `context` mark on it, and
     the fill stops at that box; otherwise move the frame edge so it is out
     of the board, or move the `empty` box off the text.

   Either way, do not shrink the box to clear a neighbour.
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
