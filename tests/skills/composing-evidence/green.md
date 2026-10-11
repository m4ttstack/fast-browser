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
