---
name: reviewing-flows
description: Use when the pending flow queue needs triage before approval, such as deciding which recorded flows are worth keeping, clearing out ones that can never replay, or reading a flow's real steps before consenting to it
---

# Reviewing Flows

`fast-browser flows approve` shows a step count, not steps. A human is asked to
trust actions they cannot read. This skill reads the queue, clears what can
never work, and puts what is left in front of them with its steps rendered.

## What this skill may and may not do

This skill may reject. It may never approve.

Approval needs a TTY this skill does not have, and that is the gate working as
designed, not an obstacle to route around. Never wrap, pipe, script, or
otherwise automate the confirm prompt, and never simulate the human's
keystrokes with a terminal-automation tool. Print the command for the human to
run themselves; do not run it yourself.

Everything here moves flows toward less runnable, never more. That is what
makes acting without asking safe.

## Phase 1: survey

Get the inventory:

```
fast-browser flows list --json
```

That gives tier, name, description, origin, health, `lastHealed`, and
`warnings`. It does not carry steps, side effects, or args, so read each
artifact directly for those:

```
~/.fast-browser/flows-pending/<name>.flow.json
```

Sort every pending flow into exactly one bucket, first match wins:

1. `unapprovable` ... any step has `op: "js"`. Approval can never make it
   runnable; it needs re-recording.
2. `dead-origin` ... the origin host is `localhost`, `127.0.0.1`, or `::1`, and
   the origin is not on the user's keep-list.
3. `superseded` ... a sibling in the same name family, on the same origin,
   whose steps are a superset of this one's. A name family is a set of flows
   whose names are identical up to a trailing `-<number>` suffix, so `login`,
   `login-2`, and `login-3` are one family. One flow's steps are a superset
   of another's when the other's ordered sequence of `(op, target role,
   target name)` triples appears as a subsequence of the first flow's own
   sequence.
4. `reviewable` ... everything else.

The `dead-origin` rule deliberately catches every loopback origin, not only the
ones that look ephemeral. `localhost:6001` and `127.0.0.1:18990` are
indistinguishable by shape and opposite in value, so the rule is blunt on
purpose and safe only because this bucket is never rejected automatically.

Report bucket counts, origins by frequency, and name families. Ask for a
keep-list if loopback origins dominate.

The keep-list is user-supplied and empty by default. An empty keep-list means
every loopback origin is only ever proposed for rejection under `dead-origin`,
never rejected outright, so a missing keep-list can never by itself cause a
deletion.

## Phase 2: clean

Only `unapprovable` is rejected automatically. It is a fact about the file's
content, checkable by reading it.

`dead-origin` and `superseded` are inferences. Propose, never act. An inference
that is wrong deletes a recording someone wanted, and rejection cannot be
undone.

Show every name in the batch, take one confirmation, then reject one at a time:

```
fast-browser flows reject <name>
```

If one fails, report that flow and keep going. A concurrent compile can remove
a file between the survey and the batch.

Every rejection is recorded by the CLI in its rejected ledger with the date, so
cleaning stays auditable after the fact. Say so before asking for the
confirmation; it is the reason a large batch is reasonable to accept.

## Phase 3: review

This phase needs a real terminal. If stdin and stdout are not a TTY, stop here
and tell the human approval needs their terminal. Do not attempt approvals that
will silently decline.

For each `reviewable` flow, render what the prompt cannot show: origin, side
effects, arg names, and every step with its op, its target role and name, and
its redacted value. Then print this command for the human to run themselves;
do not run it yourself:

```
fast-browser flows approve <name>
```

They type APPROVE, exact case. Anything else declines and exits 2. Ctrl-D
currently raises an uncaught `AbortError` rather than declining cleanly, so
suggest Ctrl-C to back out.

If approve fails because a ready-tier flow already holds that name, say which
name collided. The fix is to rename or reject one of the two, and the raw
error does not make that obvious.

Print the `dead-origin` and `superseded` proposals here too, as reject commands
the human can run or ignore.

## Phase 4: drift

From the same `flows list --json`, report ready-tier flows whose `lastHealed`
is not null.

A heal rewrites an approved artifact without re-entering the gate, so consent
covered content that has since changed. Naming those flows is the whole
deliverable; there is no re-approval path to offer.

## Corrupt artifacts

A `.flow.json` that will not parse shows up in `warnings` from
`flows list --json`. Report it and leave it alone.
Unparseable means unjudgeable, and a parse failure is not evidence a flow is
junk. A corrupt artifact is excluded from bucketing entirely: it never lands
in `unapprovable`, `dead-origin`, `superseded`, or `reviewable`, since none of
those judgments can be made about a file that cannot be read.
