<p align="center">
  <img src="https://raw.githubusercontent.com/m4ttstack/fast-browser/main/assets/logo-128.png" width="96" height="96" alt="Fast Browser">
</p>

<h1 align="center">Fast Browser</h1>

<p align="center">
  <strong>Let Claude Code and Codex drive the Chrome you already have open.</strong><br>
  Your profile, your logins, your tabs. Not a blank automated browser.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@mattstack/fast-browser"><img src="https://img.shields.io/npm/v/@mattstack/fast-browser?color=%23FFA51F&label=npm" alt="npm"></a>
  <img src="https://img.shields.io/badge/license-MIT-%23FFA51F" alt="MIT">
  <img src="https://img.shields.io/badge/platform-macOS-%232B3245" alt="macOS">
  <img src="https://img.shields.io/badge/node-%E2%89%A520-%232B3245" alt="Node 20+">
</p>

```bash
npx @mattstack/fast-browser setup --host both
```

## Why it exists

Most browser automation starts a fresh, empty browser. Every task then begins
with logging in, clearing consent banners, and rebuilding the state you already
had. Fast Browser skips all of that by attaching to your real Chrome through an
extension, so the agent starts from a browser that is already signed in to the
things you use.

The second problem is speed. A typical agent loop is snapshot, read, click,
snapshot, read, click, and every one of those steps is a round trip that costs
latency and tokens. Fast Browser is built to collapse that loop.

## What you get

**One call instead of many.** Multi-step flows go into a single script, so a
seven-step checkout runs in one tool call. The bundled test suite holds this to
a hard budget: the full order flow completes in **no more than three calls**
scripted, and in **exactly one** when replayed as a saved macro.

**A macro library that grows as you work.** Repeated flows get mined out of
your session logs, parameterised, and saved. Next time the agent recognises the
flow and replays it by name with arguments instead of rediscovering it.

**Small observations by default.** Snapshots are off unless asked for, and
lookups are narrow, so pages come back as the few facts you needed rather than
a full accessibility dump.

**Two hosts, one setup.** Claude Code and Codex get the same tools, the same
three skills, and the same macro library.

**It stays out of your way.** Fast Browser does not steal focus, so an agent
can work while you keep using the browser.

## Many agents, one browser

Run as many agents as you like against the same Chrome. They do not clobber
each other.

Each connection gets **its own tab group, labelled with that client's workspace
folder** — so a Claude session in `~/code/checkout` and a Codex session in
`~/code/billing` show up as clearly separate, named groups in your tab strip
and you can see at a glance who is doing what.

Isolation is per connection, not just cosmetic:

- **An agent only controls the tabs it attached.** It cannot see or drive
  another agent's tabs, or the ones you are using yourself.
- **A second agent connecting does not disconnect the first.** Single-tenant
  extensions drop the existing relay when a new client arrives; this one does
  not.
- **Killing one agent leaves the others working**, and it can reconnect later
  without disturbing anyone.

This is covered by the runtime's extension test suite, and verified live: a
Claude Code session and a Codex session drove the same real Chrome
concurrently through separate checkout flows, killing one left the other
functional, and both reconnected cleanly.

## Pinned, not "latest"

The runtime and extension are locked to
exact versions with SHA-256 checksums. Every install verifies the bytes on
disk, and the launcher refuses to run anything that does not match, so a
tampered or half-written artifact fails closed instead of running. `doctor`
runs 18 checks across the platform, both hosts, routing, the pinned artifacts,
what Chrome actually loaded, pairing, permissions, and the live MCP contract.

## Requirements

- macOS, Google Chrome, and Node.js 20 or newer
- Claude Code, Codex, or both already installed

Chrome is the only supported browser in this alpha. Other operating systems,
Chromium variants, Firefox, Safari, remote browsers, and unattended extension
loading are not supported.

## Install

```bash
npx @mattstack/fast-browser setup --host both
```

Use `--host claude`, `--host codex`, or `--host both`. Interactive setup with
no `--host` uses the hosts it detects; non-interactive setup always requires an
explicit `--host` so a second host is never changed silently.

Setup defaults to `--profile safe`. It verifies and installs the pinned runtime
and extension, installs the host plugin adapters, writes owned routing state,
and prints the unpacked extension directory. It does not load the extension
into Chrome for you.

Setup also installs a `fast-browser` command into `~/.local/bin`, so the bare
`fast-browser <command>` invocations used throughout this README work without
npx. If your shell cannot find it, add
`export PATH="$HOME/.local/bin:$PATH"` to your shell profile.

### Load the Chrome extension

1. Open `chrome://extensions` in Google Chrome
2. Enable **Developer mode**
3. Select **Load unpacked**
4. Choose the directory setup printed (`~/.fast-browser/extension/current/unpacked`)
5. Run `fast-browser doctor`

You only do this once. Setup installs into that fixed directory and swaps its
contents in place on every upgrade, so Chrome keeps pointing at the same path.

Chrome keeps developer-mode extensions per profile, so load it in each Chrome
profile where Fast Browser should operate.

### Upgrading

After a setup that installs a newer version, open `chrome://extensions` and
click the reload arrow on Fast Browser. **Do not remove and re-add it** —
removing an extension discards its stored data, including the reconnect token,
which forces you to pair again.

Until you reload, `doctor` reports `extension-loaded` as failing while
`extension-artifact` and `extension-installed` pass. That means the new bytes
are on disk and Chrome is still running the old ones. It is not drift, and
rerunning setup will not clear it. Chrome records the reload on a short delay,
so rerun `doctor` rather than reloading twice.

### Installing an unpublished local build

Setup installs from the published release by default. To install a local build
instead, put these three files in one directory, using the version you built:

- `fast-browser-release-<version>.json`
- `fast-browser-mcp-<version>.tar.gz`
- `fast-browser-extension-<version>.zip`

The release JSON is the URL-free local manifest. The other two must sit beside
it and match its locked SHA-256 values.

```bash
fast-browser setup \
  --runtime-lock /absolute/path/to/fast-browser-release-<version>.json \
  --host both \
  --profile safe
```

`--runtime-lock` is optional otherwise; the bundled lock resolves and verifies
both artifacts on its own. The override is accepted only when it contains no
URLs, and both checksums are verified either way.

## Safe and full profiles

The default `safe` profile disables session recording. It installs the Codex
browser-driver routing asset and keeps unsafe browser code behind an explicit
Codex approval prompt. It does not add the full automatic Claude/Codex routing
instructions.

The `full` profile installs the automatic routing instructions for both hosts,
approves the owned Fast Browser MCP policy in Codex, and enables session
recording with a 30-day retention default. Full mode increases convenience and
the amount of sensitive browser state that may be retained:

```bash
fast-browser configure --profile full
```

Return to the safer defaults with:

```bash
fast-browser configure --profile safe --no-record-sessions
```

The safe profile rejects session recording. In full mode, recording can be
controlled explicitly:

```bash
fast-browser configure --profile full --record-sessions --retention-days 14
fast-browser configure --profile full --no-record-sessions
```

Retention accepts 1 through 365 days. Recorded sessions can contain page text,
URLs, form values, screenshots, and other authenticated browsing context.
Review them as confidential data; disabling future recording does not make
previously recorded material non-sensitive.

## Extension connection and Keychain

Manual extension connection is the default. To pair automatically:

```bash
fast-browser configure --connection auto
```

The CLI asks you to copy the extension's reconnect token and paste it directly
into a macOS Keychain prompt. The token is stored as the
`dev.mattstack.fast-browser` / `chrome-extension` generic-password item. Fast
Browser checks and reads it through macOS Keychain and passes it only to the
MCP child process when automatic connection is active; normal CLI and JSON
output do not reveal it. Replacing an existing item requires explicit
interactive confirmation.

Do not paste the token into command-line flags, shell history, issue reports,
session notes, or macros.

## Diagnose

Human-readable checks:

```bash
fast-browser doctor
```

Machine-readable checks:

```bash
fast-browser doctor --json
```

The JSON result includes `schemaVersion`, `ok`, `profile`, and the ordered
checks with status, message, and remediation. Doctor checks the platform, host
CLIs and plugins, owned routing, pinned runtime and extension, Chrome extension,
pairing, private data permissions, MCP handshake, and tool contract. A failed
doctor exits nonzero; run the printed remediation and repeat the check. A check
that knows no specific fix reports a null remediation and names the underlying
cause in its message instead.

## Migrate and roll back

First inventory the recognized legacy installation without changing it:

```bash
fast-browser migrate --dry-run
```

Apply the migration only after reviewing the inventory:

```bash
fast-browser migrate --host both
```

A successful apply writes a private rollback manifest beneath
`~/.fast-browser/backups/` and reports an exact `rollbackCommand`. Copy that
command from the migration result rather than guessing its generated directory:

```bash
fast-browser migrate --rollback /exact/path/from/result/rollback.json
```

Rollback accepts only an exact `rollback.json` below the managed backup
directory. Keep the manifest and its adjacent backup files together.

## Uninstall and purge

Remove one host while retaining the other:

```bash
fast-browser uninstall --host claude
fast-browser uninstall --host codex
```

Remove all configured hosts:

```bash
fast-browser uninstall
```

Ordinary uninstall removes only owned host and routing state. It preserves the
Fast Browser data directory and macOS Keychain credential so the installation
can be recovered or reinstalled. A selective uninstall cannot purge while
another configured host remains.

To remove every configured host and permanently delete the exact
`~/.fast-browser` data directory:

```bash
fast-browser uninstall --host both --purge-data
```

Purge is interactive and proceeds only after you type `PURGE`. It refuses
aliases, symlinks, a changed directory identity, or an inexact data path. The
current purge still retains the Keychain item; remove that item separately in
Keychain Access if it is no longer needed.

## Security and third-party code

Fast Browser itself is [MIT licensed](./LICENSE); the Playwright-derived
runtime and extension artifacts it installs remain Apache-2.0. Read
[SECURITY.md](./SECURITY.md) before using Fast Browser with authenticated
sites. Third-party source, license, commit, artifacts, and checksums are listed
in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
