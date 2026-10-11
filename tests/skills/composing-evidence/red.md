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
