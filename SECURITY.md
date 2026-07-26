# Fast Browser security

Fast Browser crosses the boundary of an authenticated Google Chrome profile.
The extension can expose pages, cookies' effects, account data, form contents,
and actions available to the signed-in user through the local MCP runtime.
Treat access to Fast Browser as access to that browser profile.

## Execution boundary

`browser_run_code_unsafe` intentionally runs arbitrary Playwright-side
JavaScript. Arbitrary page-derived or instruction-derived code passed to that
tool is remote-code-execution-equivalent in the MCP process: it can use the
process's permissions and interact with authenticated pages. A website, page
content, downloaded text, or model instruction is not a trusted code source.
Review code before execution and never turn untrusted page text directly into
executable JavaScript.

Use a dedicated Chrome profile where possible. Keep the default `safe` profile,
manual connection, explicit tool approvals, and session recording disabled
unless the task requires more access. Select only the host you use. Grant the
macOS account, Chrome profile, MCP process, and visited sites the least
privilege practical for the task.

## Pairing credentials

Automatic pairing stores the reconnect token in macOS Keychain as the
`dev.mattstack.fast-browser` service and `chrome-extension` account. The secure
Keychain prompt owns token input; Fast Browser does not accept a token flag or
print the value. When automatic connection is active, the CLI reads the item
and scopes the token to the launched MCP child process. Anyone who can control
that process or the signed-in macOS account may be able to use the paired
browser access.

Never disclose a reconnect token in logs, shell history, screenshots, macros,
session records, support requests, or vulnerability reports. Re-pair after any
suspected exposure. Ordinary uninstall and data purge currently retain the
Keychain item; remove it in Keychain Access when it should no longer exist.

## Sensitive retained data

Recorded sessions may retain page content, URLs, user inputs, screenshots, and
authenticated workflow details. Macros are executable JavaScript and can encode
private selectors, identifiers, values, and business logic. Store both as
sensitive local data, review macros before reuse, keep retention short, and
purge data when it is no longer required.

## Reporting a vulnerability

This repository's available reporting mechanism is GitHub Issues:
https://github.com/m4ttheweric/mattstack/issues/new

Open a minimal issue describing the affected Fast Browser version, impact, and
safe reproduction outline. Do not include tokens, credentials, private page
content, session recordings, or working exploit details in a public issue. If
sensitive coordination is needed, ask the maintainer in that issue to establish
a private channel; this repository does not publish a separate security contact
in the candidate.
