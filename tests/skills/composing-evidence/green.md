# composing-evidence: GREEN

Not yet recorded. GREEN is the milestone exit blind eval (Task 14): a fresh
agent, given this skill and the same kind of brief as the RED baseline,
composes the boards with the shipped `fast-browser compose`. Its results, and
any skill edits they force, are recorded here at milestone exit.

## 2026-10-11: lift the small element itself

Edit: one bullet added to the spec rules, "When the brief names a small
element (a badge, icon or chip), lift that element itself and leave its
neighbours out of the lift; compose enlarges it to a readable size." The
"lift the whole fact" bullet stays, minus its claim that a word-level lift cuts
the fact off (compose grows lifts to clean edges itself). No frame-tightening
or crop-fixing chore existed in the skill to drop: the `frame` guidance covers
capture-time framing only.

Same harness, page and brief as the 2026-10-11 RED round 2
(`badge-beside-name.html`): 3 of 3 lifted the badge alone
(`"lift": "badge"`). All three cited the new rule as the reason. One also
captured the name as a spare anchor but left it out of the lift.

## 2026-10-11: sync with what compose now does (final fix wave 2)

Edit: step 7 now says nothing personal may be readable that was not meant to
show, including near the board's edges (a frame edge can widen up to 96px).
Key lists: elements that make one point can share a mark; adjacent ones lift
together, separated ones lift separately under one label. "Lift the whole
fact" and the small-element rule are one bullet (whole fact by default; the
named small element alone when the brief names one). The Selectors icon row
reads role and name from `browser_find` or a scoped `browser_snapshot`.

Check: one sonnet-low subagent read the edited skill and answered from it
alone: 3 of 3 questions correct (badge lifted alone with neighbours left out;
one key-list mark that lifts adjacent elements together and far-apart ones
separately under one label; check for personal data including near the board's
edges because a frame edge can widen 96px), and the icon role and name come
from `browser_find` or a scoped `browser_snapshot`.

## 2026-10-11: target a small icon by role and accessible name

Edit: one row in the Selectors table, "A small icon or badge": read its
role and accessible name from `browser_snapshot`, then
`<unique container> >> role=<role>[name="<name>"]`; never count siblings with
`following::` or positional xpath. The existing no-`nth=` rule is untouched.

Same harness, page and snapshot as the RED round 3: 3 of 3 wrote
`role=heading[name="Sample Alpha"] >> role=img[name="Verified"]`, and two
cited the new row as the reason. No regression; the rule is untested against
the real-page failure, which only the blind eval can show.

## 2026-10: marks and layouts (milestone 3)

Edit: the spec section now documents all seven marks (`lift`, `redact`,
`empty`, `ghost`, `bracket`, `loupe`, `link`) with a brief-to-mark table, and
the `single`, `pair` and `steps` layouts with a rule that a pair frames both
captures on the same region. Pipeline steps 2 to 4 are unchanged.

Same harness, card, keys and five briefs as the RED round of the same name:
three fresh `general-purpose` sonnet (medium) agents read the edited skill,
JSON replies only. Each reply's five specs went through `validateSpec` with a
fake capture carrying the seven keys; all 15 validated with no problems.

- Brief 1 (rows 2 and 3 as a group): 3 of 3 `bracket: ["row2","row3"]` with a
  `title` and tag `CHANGED`.
- Brief 2 (12 px badge): 3 of 3 `loupe: "badge"` with `zoom: 4` and a `title`.
- Brief 3 (same total twice): 3 of 3 `link: ["total","rowTotal"]` with a
  `title`.
- Brief 4 (removed button): 3 of 3 `ghost: "gap"` with tag `REMOVED` and a
  `title`.
- Brief 5 (light and dark as one image): 3 of 3 one `pair` board, panels
  labelled `LIGHT` and `DARK`, naming two different captures (`c1`, `c2`).
  RED produced a light-only board in all three.
- No invented fields; no `bracket` or `link` without a `title`.

Residue: in 1 of 3 replies the brief 4 board carried `state: "BEFORE →
AFTER"` on a single panel, which validates but implies a comparison the board
does not show (RED had the same habit in 3 of 15 boards). The brief named no
mark that this affects, so the skill is unchanged; the milestone exit blind
eval is where it would show on a real board.

## 2026-10: imported images (milestone 3)

Edit: a section for a ticket's screenshot (`--import`, a frame and boxes in
the image's real pixels, the redaction crops, the unconfirmed rule), plus five
wording fixes from the first blind evaluation: pair labels name each panel,
`pair` and `steps` show frames whole, an icon's accessible name and the
wrong-neighbour check, what each `state` means, `empty` against `lift`.
Pipeline steps 2 to 4 are unchanged.

Harness: text-only. Three fresh `general-purpose` sonnet (medium) agents per
round read the edited skill and one prompt, with no other context. Part A is
the RED prompt (a 2400 by 1600 ticket screenshot shown at 1200 by 800, name
and email to hide). Part B is seven briefs against a project-tracker card
(keys `row1`, `row2`, `row3`, `badge`, `total`, `rowTotal`, `gap`, `notice`),
with a second capture of the same card for a second project; JSON replies.
Every Part B spec went through `validateSpec` with a fake capture carrying the
eight keys.

### Round 1

Part A, 3 of 3: `--import` with `--out` and `--origin`; frame and boxes in
2400-wide pixels (viewer numbers times 2), boxes padded 6 to 10 pixels, a
frame short of the whole image; both fields redacted, and any other place
they appear inside the frame; every crop read; the board reported unconfirmed;
`--confirm` not run. No invented flag, field or file name.

Part B, 3 of 3: `bracket`, `loupe`, `link` and `ghost` for the first four
briefs, each `bracket` and `link` with a `title`; the pair of two projects
labelled `Borealis` and `Atlas`; `AFTER` for the board of a page that works
and `FOUND` only for a problem; the "No activity yet" text lifted rather than
`empty`. All 24 specs validated.

Miss, 3 of 3: every `single` panel carried a `label` repeating its `state`
(`"label": "AFTER"` under `state: "AFTER"`, `"label": "FOUND"` likewise,
`"label": "BEFORE"` under `FOUND` in the ticket spec), which draws the same
word twice. The skill's only panel examples were a pair and the ticket panel,
and the ticket panel carried a label itself.

Fix: the `single` row says `one, with no label: the board's state already says
what it is`; the ticket example panel lost its label; the pair-with-a-live-
after sentence says to give each panel its label.

### Round 2

Part A, 3 of 3: unchanged from round 1, and each now says a `single` board
takes one panel with no label. Scale and padding checked by hand in the two
replies that worked numbers (viewer 2x, 8 pixels of padding); every box sits
inside its frame.

Part B, 3 of 3: no `single` panel carries a `label` (round 1: all of them);
the pair is labelled `Borealis` and `Atlas`; every `bracket` and `link` has a
`title`; no invented field; `AFTER` for the neutral board; the placeholder
text lifted. All 24 specs validated.

Still not settled: for the brief "an Export button used to sit in the gap;
show that it is gone", 2 of 3 chose `state: "FOUND"` and 1 of 3 `AFTER`. The
brief does not say whether the removal is a defect, and the skill defines
`FOUND` as a problem found, so the choice follows the reading of the brief and
is not a wording fault.

Wording change after review, 2026-10-12: the confirm rule now ties the
operator's yes to the crops of the latest render and says to ask again after
any re-render. No new round: it only tightens what all six agents already did
(none ran `--confirm`).

Wording change, 2026-10-12: the page-level frame is named and a link's frame
must show what each place is; hiding a value hides every copy of it (and a
redact box covers whole elements); the "drawn small" warning is named in the
Render step; a selector's container is confirmed with a scoped snapshot. The
live eval's rerun is their test.

Wording change, 2026-10-13: a `pair` shows each panel's frame whole; a
`single` board and each panel of a `steps` board are cropped to their marks;
a `link` gives each place the element that holds the value together with its
label or heading. Paper test, five fresh agents, one exercise (a `steps`
board whose only frame is a 1200 by 800 card around one small button; a
`link` between a header chip and a table cell). With the new text, 3 of 3
said a `steps` panel is cropped and the card is an acceptable frame, picked
the heading with its chip and the cell with its row or column label, and
quoted the sentence that says the board does not show everything in the
frame. With the text before the change, 2 of 2 said a `steps` panel shows the
whole card and went looking for a smaller container, and both picked the
bare chip. The live eval's rerun is the application test.

Wording change after review, 2026-10-13: a `pair` shows each frame whole
less any blank margin at its edges; the "drawn small" warning's remedy is a
tighter frame in a `pair` and fewer or closer marks in a `steps` panel; the
new warning `a crop edge cuts through content` is named. No new round: each
sentence states what compose does and what its warning means.
