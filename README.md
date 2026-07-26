# Fast Browser

Fast Browser is a macOS-only alpha that installs a pinned Playwright MCP
runtime and Chrome extension for Claude Code, Codex, or both. It includes the
same three browser skills for both hosts, plus host-specific routing and a
delegated browser driver.

This package is still `private: true` and `UNLICENSED`. It has not been
published to npm, so the `npx` path below is a post-publication example, not a
currently available install method. Source installs are the supported candidate
workflow.

## Requirements and limits

- macOS, Google Chrome, and Node.js 20 or newer.
- Claude Code, Codex, or both already installed.
- Chrome is the only supported browser in this alpha.
- Runtime and extension downloads are pinned by `runtime-lock.json`.

Other operating systems, Chromium variants, Firefox, Safari, remote browsers,
and unattended extension loading are not supported by this candidate.

## Install

After a future npm publication, setup will be:

```bash
npx @mattstack/fast-browser setup --host both
```

For the current local candidate, clone or check out the repository, then run
the bundled CLI and give it the repository root as its marketplace source:

```bash
cd /path/to/mattstack
node plugins/fast-browser/bin/fast-browser.mjs setup \
  --source /path/to/mattstack \
  --host both
```

The remaining examples use the installed command name `fast-browser`. For an
unpublished source checkout, replace it with
`node /path/to/mattstack/plugins/fast-browser/bin/fast-browser.mjs`.

Use `--host claude`, `--host codex`, or `--host both`. Interactive setup with
no `--host` uses the installed hosts it detects. Non-interactive setup always
requires an explicit `--host`; this avoids silently changing a second host.
Setup defaults to `--profile safe`. A matching repeat setup is a mutation
no-op only when all doctor checks still pass. If external files or installation
state drifted, setup reports the drift instead of claiming success.

Setup downloads and verifies the locked runtime and extension, installs the
selected host plugin adapters, writes owned routing state, and prints the
unpacked extension directory. It does not install a public license, publish the
package, or load the extension into Chrome for you.

## Load the Chrome extension

1. Open `chrome://extensions` in Google Chrome.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose the exact unpacked extension directory printed by setup.
5. Run `fast-browser doctor` again.

Chrome keeps developer-mode extensions per Chrome profile. Load the extension
in each profile where Fast Browser should operate.

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
doctor exits nonzero; run the printed remediation and repeat the check.

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

Read [SECURITY.md](./SECURITY.md) before using Fast Browser with authenticated
sites. Third-party source, license, commit, artifacts, and checksums are listed
in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
