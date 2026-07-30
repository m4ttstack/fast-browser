# Fast Browser routing

For ordinary browser-driving requests, Fast Browser takes precedence over `browser-use:browser`.

For multi-step browser work, explicitly delegate to the `browser-driver` agent.
Use direct Fast Browser tools only for small, single-step checks; a delegated
spawn costs more than the snapshot it avoids on a one-shot lookup, and tasks
whose raw output must be audited should not be distilled at all.
