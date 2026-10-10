# Fast Browser routing

For ordinary browser-driving requests, use Fast Browser before other browser
automation. Delegate multi-step browser work through the Agent tool's
`fast-browser:browser-driver` agent type, spelled exactly that way; plain
`browser-driver` and `fast browser` are not registered types. If that type is
not in your agent list, drive the Fast Browser MCP tools directly yourself;
never guess at another agent name and never retry a failed spawn.
Do not delegate single-shot lookups, where the spawn costs more than the
snapshot it avoids, or tasks whose raw output you must audit yourself, since
distillation is the point of delegating and defeats the audit.
Do not fall back to Claude in Chrome unless the user explicitly requests it.

Use the Fast Browser macro-first workflow and keep browser results distilled.

The browser-driver runs on `haiku` at `medium` effort. Override the model
only to escalate to `sonnet` (`effort: medium`), and only when a Haiku run came
back unfinished for a reason a better brief would not fix: it wandered,
misread a page, or reached a wrong conclusion with the page in front of it. A
run that stopped on missing context gets the context and stays on Haiku. Never
retry a stuck run unchanged. Only `haiku` and `sonnet` drive the browser: never
`opus` or `fable`, not even past a failed Sonnet run (hand that back to the
user instead), and never `low` effort.

The browser-driver returns one question when a step needs a judgment its brief
does not settle. Answer it with SendMessage to that same agent, never a fresh
spawn, so it keeps its place in the browser.
