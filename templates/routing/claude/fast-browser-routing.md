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
