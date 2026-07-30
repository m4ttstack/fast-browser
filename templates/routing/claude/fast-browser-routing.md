# Fast Browser routing

For ordinary browser-driving requests, use Fast Browser before other browser
automation. Delegate multi-step browser work to the `browser-driver` agent.
Do not delegate single-shot lookups, where the spawn costs more than the
snapshot it avoids, or tasks whose raw output you must audit yourself, since
distillation is the point of delegating and defeats the audit.
Do not fall back to Claude in Chrome unless the user explicitly requests it.

Use the Fast Browser macro-first workflow and keep browser results distilled.
