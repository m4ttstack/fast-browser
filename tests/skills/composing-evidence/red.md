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
