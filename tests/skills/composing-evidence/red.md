# composing-evidence: RED baseline

The baseline is the design spike's first blind run, not a fresh run for this
task. A fresh agent got a draft instruction sheet (a prototype capture macro,
a prototype compose script and a draft spec format) and a five-board evidence
brief against a locally served app with made-up records. It had no
`composing-evidence` skill. Product names, URLs and data from that run are
left out here because this repo is public.

## The brief, in outline

1. A person's card: point at two adjacent account facts as one point, and
   redact a phone number and an email.
2. Two section headers: label the status shown on each.
3. A summary panel: point at two counts as one group and one other fact
   separately.
4. A tiny badge next to a name: make it readable.
5. A two-step flow across two screens.

## What the agent did without the skill

- **Selectors.** The draft told it to prefer `data-testid`; the app had
  almost none. It fell back to role and text selectors, which worked once
  scoped to a unique container. Repeated elements were the slow part.
- **Snapshots.** Full `browser_snapshot` output on the record page was very
  large, and the agent read it whole to pick selectors.
- **Partial lifts.** On the header board it lifted the status line by its
  text node, so the lifted card cut off the chip beside it and half of the
  neighbouring label. The fact was a chip plus its value; it lifted a word.
- **Thin-strip crops.** Two boards cropped to a full-width strip about a
  tenth as tall as it was wide (the section's header row, not the card), and
  the agent accepted them. The auto frame found no edged card around the
  targets; the agent never passed an explicit frame selector.
- **Unsealed captures.** The draft had it paste the macro return into the
  spec verbatim. Nothing tied the numbers to the PNG, so an edited or
  mismatched capture would have composed without complaint.
- **Absolute paths.** The macro path and `home` were given to it already
  expanded; the shipped skill has to say how to build them, because the
  runtime refuses a bare or `~` path.
- **Redaction.** Both redactions resolved and blurred. Only the draft's bold
  warning stood between a missed redact key and a board with readable
  personal data; the prototype compose did not refuse one.
- **Reading the result.** The draft asked for every PNG to be read but not
  for the report to say so, so the caller could not confirm which boards had
  been checked; the partial lift and thin-strip crops above shipped anyway.
- **Unsupported marks.** The draft listed marks and layouts (grouping,
  magnifying, linking, multi-panel) that the shipped compose does not
  support. The skill documents only `lift` and `redact` on a single panel.

Source: the spike's blind-run outputs (five specs and PNGs) and the
controller's notes on that run. No transcript is kept in the repo.

## What the skill must therefore say

- Choose selectors with `browser_find` or a scoped snapshot; role and
  container-scoped text selectors; never `nth=`.
- Lift the whole fact, not one word.
- On `frameSnap: "union"` or a thin-strip crop, pass a `frame` selector.
- On `failedStep`, fix the named problem and recapture; never edit the
  return.
- A redact key in `missed` is not redacted and compose refuses it.
- Build the macro path and `home` from the absolute home directory.
- Save the return to a file, seal it, write the spec beside the sidecar.
- Read the finished PNG and say so.

## 2026-10-11: lift the small element itself

Harness: text-only. Fresh sonnet (low) subagents read the skill and a page
source, then wrote the capture `targets` and the spec marks without a
browser. Brief: make the small badge readable. Pages are the neutral
fixtures in `tests/fixtures/evidence/pages/`, read as file source.

Round 1, `tiny-badge.html` (badge and title as siblings, both with test ids),
brief "make the badge readable": 3 of 3 lifted the badge alone. The failure
did not reproduce, so the page was not a valid RED.

Round 2, `badge-beside-name.html` (badge is an unlabelled 12px square next to
a name, no test ids), brief "the badge next to the project name is too small
to read... make it readable": 3 of 3 lifted the name and the badge together
(`"lift": ["name", "badge"]`). Rationales, paraphrased:

- the badge is a blank square that means nothing without the name beside it
- the fact is "this project is pinned", so the badge and name make one point
- lifting only the badge would cut the fact off

The skill's "lift the whole fact" bullet read as an instruction to include the
neighbour. That is the blind-eval failure: the named element ended up
outside, or diluted within, the lift.

Skill gap: nothing tells the agent that a brief naming a small element wants
that element lifted alone.

## 2026-10-11: target a small icon by role and accessible name

Harness: text-only. Fresh sonnet (low) subagents read the skill, then wrote
the capture `targets` for "the small icon next to Sample Alpha" with no
browser. Page: `tests/fixtures/evidence/pages/icon-in-named-row.html` (a 12px
image with alt "Verified" inside a heading, beside photo and action buttons,
in two repeated rows).

Three rounds of 3, none reproduced the blind-run failure (xpath sibling
guessing):

- Round 1, snapshot with named `region` containers: 3 of 3 wrote
  `role=region[name="Sample Alpha"] >> role=img[name="Verified"]`.
- Round 2, no snapshot, page source only: 3 of 3 wrote a container-scoped
  `img[alt="Verified"]` selector (`section[aria-label=...] >> img[alt=...]`).
- Round 3, snapshot with unnamed `generic` containers: 3 of 3 wrote
  `role=heading[name="Sample Alpha"] >> role=img[name="Verified"]`.

No run used `following::`, positional xpath or `nth=`. The failure needs a
real page and an agent that never reads the snapshot; a hand-fed snapshot
or source removes the guessing. So this is not a valid RED. The rule was
added anyway because Matt chose a skill tip after blind runs 3 and 4, where
3 captures went to xpath guesses and run 2 succeeded with the role form.

## 2026-10-12: Capture as a tool

Edit: pipeline steps 2 to 4 now name the `browser_capture_evidence` tool in
place of the capture macro, and the seal step is gone because the tool writes
the sidecar itself. Step 3 gains the tool's failure modes (a target inside a
shadow root or an iframe, a call that fails with an error). The pressure run
for this wording is the blind eval on the real tool; its result is in
`green.md`.

## 2026-10-12: Blind eval of the capture tool

A fresh agent given only a brief and the skill, driving the real capture
tool on a real page, did two things step 3 did not stop:

- It composed from an unfinished return. One capture left two of four keys
  in `missed` as `ambiguous`, and the agent wrote a spec from the two boxes it
  had. Another returned `frameSnap: "union"`, and the agent composed from it
  without capturing again with a `frame` selector; the crop cut through
  neighbouring page chrome.
- It had no next move after a second `ambiguous`. Three identical buttons sat
  in one header. It scoped with a `text=` selector, got `count: 3`, changed
  only the words in that selector, got `count: 4`, and gave up. Both
  selectors matched an element large enough to hold every button, and the
  agent never read the structure between the two tries.

## 2026-10: marks and layouts (milestone 3)

Harness: text-only. Three fresh `general-purpose` sonnet (medium) agents read
the skill as it stood before this milestone (`lift` and `redact`, `single`
only) and one prompt, with no other context. The capture's `boxes` had the
keys `row1`, `row2`, `row3`, `badge`, `total`, `rowTotal`, `gap`; a second
capture of the same card in dark theme had the same keys. Five briefs, JSON
replies only:

1. Rows 2 and 3 changed; mark them as a group.
2. The badge is 12 px wide; make it readable.
3. The total in the header and the total in row 3 are the same number; show that.
4. An Export button used to sit in the gap; show that it is gone.
5. Show the card in light and in dark theme as one image.

What each agent wrote, per brief (agents 1, 2 and 3 in that order):

| Brief | Marks written | Invented fields |
|---|---|---|
| 1, group of rows | `lift: ["row2","row3"]` with tag `CHANGED`, 3 of 3 | none |
| 2, tiny badge | `lift: "badge"`, 3 of 3 | none |
| 3, same total twice | `lift: ["total","rowTotal"]`, 3 of 3 (tag `OK` in 2 of 3) | none |
| 4, removed button | `lift: "gap"` with tag `REMOVED`, 3 of 3 | none |
| 5, light and dark | one `single` board with the light capture and `marks: []`, 3 of 3 | none |

- Every brief got a `lift`. No agent reached for a group, magnifier, link or
  removal mark, because the skill offered none.
- Brief 5: 3 of 3 produced one board for the light theme only and dropped the
  dark capture, each saying the skill allows exactly one panel. None made two
  separate boards, and none made one image of both. The dark capture went
  unused.
- No agent invented a field or a mark kind: they stayed inside what the skill
  documented. The failure is the absence of vocabulary, not misuse of it.
- `state` was `BEFORE → AFTER` on a single-panel board in 2 of 3 replies for
  brief 1 and 1 of 3 for brief 4: the state implies a comparison the board
  cannot show.

Skill gap: the skill has no mark for a group, a tiny element, one fact in two
places or a removal, and no layout that holds two captures.

## 2026-10: imported images (milestone 3)

Harness: text-only. Three fresh `general-purpose` sonnet (medium) agents read
the skill as it stood after the marks and layouts milestone (live captures
only) and one prompt, with no other context: a ticket has a screenshot of the
broken page saved at `/tmp/ticket.jpg`, 2400 by 1600 pixels, showing a
customer's name and email; describe, command by command and with the spec,
how to produce a before board with the name and email hidden; the viewer shows
the image at 1200 by 800.

| Question | Agent 1 | Agent 2 | Agent 3 |
|---|---|---|---|
| Invents an import path? | No import command; proposes an unverified workaround: an HTML page that shows the JPEG with empty overlay elements, captured by the live macro | No; offers a live recapture of the page, or stops and reports there is no way to use the JPEG | No; notes `file:///tmp/ticket.jpg` would be one `img`, so a redact would cover the whole image; asks for the live page or for an import command |
| Coordinates written | Viewer pixels times 2, as CSS overlay positions (none actually written) | None; says any viewer position would need doubling and will not compute boxes | None; says viewer positions double to file pixels and has no place to put them |
| Checks the redaction? | Yes, by reading the PNG and the `missed` list; admits a miss would leak the data | Yes, by reading the PNG after a live recapture; no board is made from the ticket | Not applicable: stops before any board |
| Treats the board as finished? | Done once it has read the PNG (its step 8); no one else looks | Not done; reports it could not build the board | Not done; reports it could not |

- 0 of 3 found a way to use the image. Two of three would stop and ask; the
  third builds a page around the image, which is an invented route to the same
  place and misplaces no redaction only if its doubled coordinates are right.
- All three saw the viewer-to-image scale (times 2) as a hazard, and none had
  anywhere to write the numbers. The skill says "you never place anything by
  pixel", which pushed them to refuse.
- Nobody mentioned a confirmation step: one agent treats its own read of the
  PNG as the check, with no operator in the loop.
- `state` for a before board was a guess in 3 of 3 (`FOUND`). One of the
  three assumed a `single` panel is cropped to its marks, which could drop the
  broken area the ticket is about.

Skill gap: no route from an image file to a capture, no field to give a frame
and boxes by coordinate, no statement that the image's real pixels (not the
viewer's) are the unit, no redaction check beyond the agent's own read, and no
rule that the operator confirms the crops.

## 2026-10-13: six misses from the first blind run on a local app

Harness: two fresh Sonnet drivers ran the shipped skill on a locally served
app, and a blind judge scored each board out of 5; the bar
is 4. The app, its data and the run's files stay out of the repo. Six boards
missed, each on a choice the skill steers:

- **A pair of one region across two pages.** The skill said to give both
  captures the same frame selector. The two pages wrap that region in
  different elements, so no one selector matched both; the driver spent its
  calls looking for one, then targeted an element outside the frame and was
  refused with "does not contain every target". No board.
- **A tab link as a steps target.** The link's box overhangs its tab strip
  by a pixel or two, so the strip was refused as the frame. The driver
  retried the same strip by another selector and spent the panel's calls.
  No board.
- **A one-panel board of where a flow starts** was given `AFTER`, which the
  judge read as a result state. Scored 3.
- **A fact with a sub-line under it.** The driver lifted the first line
  only, and a clipped sub-line showed under the lift. Scored 3.
- **A thin strip the tool chose** (about ten times wider than tall) was
  kept, and the report said so without a retry. The brief asked for two
  section headers; the driver marked the status chip inside each, and the
  dim washed out the headers. Scored 3.
- **A value compared across two places** wrapped onto two lines in a narrow
  control, so the reader had to rejoin it to compare. Scored 3.

What the skill must therefore say: per-panel frame selectors when no one
selector names the region on both pages, and a target inside the frame on
the panel where the thing is absent; on "does not contain every target", the
next ancestor once; `FLOW` for a step or starting point on any layout; a lift
takes the whole item with its sub-line; the thin-strip retry is required and
reported; a named header, row or card is marked whole; a wrapped compared
value is fixed with `browser_resize` before capture.

## 2026-10-14: what the second blind run still missed

Harness as above, with the first six steers in the skill. Three of six
boards reached 4; three scored 3, and two problem-free boards drifted:

- **`FLOW` over-reach.** Two boards of facts shown on the page as they are
  were labelled `FLOW`, because the steer said a one-panel board with no
  problem in it could be `FLOW`.
- **A pair across two pages on different regions.** One panel framed one
  view of the record, the other a different view, each on most of the page,
  so the two were not like for like and both were drawn small.
- **A readable personal detail.** The loose frames held more details to
  hide; the driver ran out of captures and left one readable on the board.
- **A step label and its mark disagree.** The label said to click an entry
  in a side rail; the mark's title called it a section heading, so the
  reader could not tell which the mark was on.
- **A value the page wraps.** The page breaks the value inside a fixed
  narrow column, so a wider viewport did not unwrap it.

What the skill must therefore say: `FLOW` only for a flow the brief
describes, with `FOUND` and `AFTER` named for the rest; the same band on
each page in a pair across pages; every detail to hide in the first capture,
and no board while one is readable; a step's mark sits on what its label
names and its title uses those words; a value the page wraps goes on one
line in the mark's note.

## 2026-10-14: a union retry stopped on one selector that was too big

Third blind run, a three-panel `steps` board. One panel marks a section
heading on a statement page. The capture came back `union`, a thin frame.
The driver passed the whole section as `frame`; that capture failed with
"the frame selector is larger than the viewport". It read the `union`
bullet's stop sentence ("no element both holds the targets and fits the
viewport") and stopped the board with a capture still in hand, though the
other bullet said to pick a smaller element. One selector that is too big
does not show that no element fits.

What the skill must therefore say: after a `union` retry that is too large,
try once more with a smaller element inside it that still holds every
target (the heading's own header block, not the whole section), not a thin
strip unless only a thin strip fits; stop only when that fails too or the
budget is spent.

## 2026-10-14: a pair across two pages framed on a full-height container

Same run, a `pair` across two pages. One page swaps its whole body for a
different view, so the only region the two share is the header strip and
the first block under it. No single element is that band: the element that
holds the strip is a container that fills the viewport and shrinks with it.
The driver framed that container on both pages at two different viewport
heights, so the panels showed different regions at different sizes and one
was too small to read.

What the skill must therefore say: both captures of a `pair` are taken at
one viewport size; when the only element that holds the band fills the
viewport, shorten the viewport with `browser_resize`, the same for both,
until the frame holds the strip and the first block under it, never the
container at full height; restore the starting size after the last capture.

## 2026-10-14: a step marked the heading its click revealed

Fourth blind run, a three-panel `steps` board. Steps 1 and 2 were reached
by clicking a tab, and each marked the tab that then showed as selected.
Step 3 was reached by clicking an item in a side menu, which then showed as
selected too, but the driver marked the full-width section heading the click
revealed. The judge read that mark as pointing at the menu while the selected
item went unmarked, and it was drawn much larger than the other steps' marks.

What the skill must therefore say: a step reached by clicking a control that
stays selected (a tab, a menu item) marks that selected control, so every
step marks the same kind of thing; the heading only when no control stays
selected.

## 2026-10-14: the absent side of a pair carried no mark

Same run, a `pair` across two pages: the thing sits on one page and is
absent on the other. On the absent side the driver targeted an element both
pages share, as the skill says, but gave that panel no mark. The board's
wash covered the whole panel, so the judge could not tell what the absent
side was showing.

What the skill must therefore say: mark that shared element with a `lift`
whose `title` says the thing is not there.

## 2026-10-14: review of the absent-side mark

A review read the new pair line against the Marks bullet "Lift the whole
fact, not its header or card, unless the brief names that header, row or
card". The absent side lifts a heading or card the brief does not name, so a
fresh driver may stall between the two, or lift some fact on the absent side
instead.

What the skill must therefore say: on the pair line, that this lift is the
one exception to lifting the whole fact.

## 2026-10-14: the absent-side mark on the strip

A later run marked the absent side of a pair by lifting that page's own tab in
the strip of tabs both pages share, titled to say the thing is not there. The
judge read the mark as pointing at the header, not at the body area where the
thing would appear, so the mark for the absence pointed at the wrong element.

What the skill must therefore say: the absent side's mark goes on the element
at the spot where the thing sits on the other page, never on a tab or label
in the shared strip.

## 2026-10-14: review of the thin-strip retry against the hiding budget

A review read step 3 and the thin-strip bullet against the hiding rule. Step 3
said a return is finished only once a thin strip the tool chose has had its
retry, and the bullet called that retry required. The hiding rule said a thin
strip left unretried for budget is kept and reported. A driver that spent its
captures on hiding was told both to retry and to keep the strip.

What the skill must therefore say: the retry is required unless the budget
went to hiding personal details, and a report that names a thin strip names
its retry or says it was skipped for budget; step 3 points to that exception.
