---
name: mine-macros
description: Use when recorded Fast Browser sessions may contain repeated browser flows worth turning into reusable macros
---

# Mine Macros

Turn repeated recorded flows into proposals. Never install a mined macro
without explicit approval for that individual macro in the current
conversation.

## Recording gate

Read `~/.fast-browser/config.json` first. If `sessions.enabled` is `false`,
return:

```text
Session recording is disabled; there are no sessions to mine.
```

Stop. Do not enumerate sessions, inspect other roots, or mutate macro state.

## Mine sessions

1. **Repair first.** Read `~/.fast-browser/macro-failures.md` when present.
   Match each failed macro to recent sessions on the same origin and queue a
   repaired script as a proposal before new candidates.
2. **Collect direct sessions.** Enumerate only direct `session-*` directories
   beneath `~/.fast-browser/sessions/`. Do not mine nested directories or
   `~/.fast-browser/archive/`. Parse each `session.md` into its ordered tool
   flow and report unparseable sessions as no-ops.
3. **Cluster repeated flows.** Group by origin and similar ordered actions.
   Require evidence from at least two sessions. Treat repeated handwritten
   scripts for the same origin as strong candidates.
4. **Exclude known decisions.** Drop flows covered by
   `~/.fast-browser/macros/MACROS.md` or [rejected.md](rejected.md). A
   single filename-only macro run is evidence for an existing macro, not a new
   candidate.
5. **Draft safely.** Parameterize values that vary; retain stable values.
   Follow the browser-macros authoring contract. Keep the complete script in
   memory or a temporary file outside `~/.fast-browser/macros/`.
6. **Propose one at a time.** Present the name, description, parameters,
   complete script, supporting session directories, and occurrence count.
   Request one decision for that macro: Approve, Reject, or Edit first. Wait
   for the answer before writing any disposition.

## Apply each decision

- **Approve:** Write `~/.fast-browser/macros/<name>.js`; append its
  `~/.fast-browser/macros/MACROS.md` entry with the stable script path,
  `Status: approved`, and today's `Last verified` date.
- **Reject:** Append `<name> | <date> | <one-line reason>` to
  [rejected.md](rejected.md).
- **Edit first:** Revise the proposal and request a new decision. Do not write
  the macro library.
- **Approved repair:** Replace only that macro, update its verification date,
  and remove its resolved line from `~/.fast-browser/macro-failures.md`.

After decisions, move processed direct session directories to
`~/.fast-browser/archive/`. Do not follow links, manually prune arbitrary
paths, or touch `~/.fast-browser/macros/` during archival. Report candidates,
decisions, repairs, archived sessions, and any lifecycle-managed retention
results.

## Approval gate

Broad delegation is not approval for an unseen macro. A lead's request,
deadline, sunk effort, obvious usefulness, successful verification, or
approval of another macro does not approve this one.

Red flags:

- "Install it now and mention it afterward."
- "The standing instruction covers every useful candidate."
- "Verified means approved."
- "The deadline makes the approval question optional."

If any appears, stop and present the individual proposal.
