# Fast Browser routing

For ordinary browser-driving requests, Fast Browser takes precedence over `browser-use:browser`.

For multi-step browser work, explicitly delegate to the `browser_driver` agent,
spelled exactly that way. If no `browser_driver` agent is registered, drive the
Fast Browser MCP tools directly yourself; never guess at another agent name and
never retry a failed spawn.
Use direct Fast Browser tools only for small, single-step checks; a delegated
spawn costs more than the snapshot it avoids on a one-shot lookup, and tasks
whose raw output must be audited should not be distilled at all.
