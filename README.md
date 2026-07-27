# Fast Browser

Fast Browser is a macOS-only alpha that installs a pinned Playwright MCP
runtime and Chrome extension for Claude Code, Codex, or both. It includes the
same three browser skills for both hosts, plus host-specific routing and a
delegated browser driver.

This package is MIT licensed (see LICENSE); the Playwright-derived runtime and
extension artifacts it installs remain Apache-2.0. The bundled lock points at a
published release, so a source checkout installs on its own without a local
artifact bundle.

## Requirements and limits

- macOS, Google Chrome, and Node.js 20 or newer.
- Claude Code, Codex, or both already installed.
- Chrome is the only supported browser in this alpha.
- Runtime and extension identity is pinned by `runtime-lock.json`.

Other operating systems, Chromium variants, Firefox, Safari, remote browsers,
and unattended extension loading are not supported by this candidate.

## Install

`npx` is not available yet: the package has not been published to npm. The
license is MIT and the locked runtime release is public, so publication is the
only remaining gate. Once published, the intended setup form is:

```bash
npx @mattstack/fast-browser setup --host both
```

### Local build bundle (optional)

Setup installs from the published release by default. To install an
unpublished local build instead, put these three files in one directory, using
the version you built:

- `fast-browser-release-<version>.json`
- `fast-browser-mcp-<version>.tar.gz`
- `fast-browser-extension-<version>.zip`

The release JSON is the URL-free local manifest. The runtime and extension
files must be adjacent to it and must match its locked SHA-256 values. They are
produced separately and are not included in the source checkout or npm
tarball.

To use that local bundle, run the bundled CLI from a source checkout with
absolute paths:

```bash
cd /path/to/mattstack
node plugins/fast-browser/bin/fast-browser.mjs setup \
  --source /path/to/mattstack \
  --runtime-lock /absolute/path/to/fast-browser-release-0.1.0-alpha.7.json \
  --host both \
  --profile safe
```

The remaining examples use the installed command name `fast-browser`. For an
unpublished source checkout, replace it with
`node /path/to/mattstack/plugins/fast-browser/bin/fast-browser.mjs`.

`--runtime-lock` is optional now that the pinned release is public; the bundled
lock resolves and verifies both artifacts on its own. Use the override only to
install an unpublished local build. It is accepted only when it contains no
URLs; the CLI resolves the two exact adjacent artifacts locally and verifies
both hashes either way.

Use `--host claude`, `--host codex`, or `--host both`. Interactive setup with
no `--host` uses the installed hosts it detects. Non-interactive setup always
requires an explicit `--host`; this avoids silently changing a second host.
Setup defaults to `--profile safe`. A matching repeat setup is a mutation
no-op only when all doctor checks still pass. If external files or installation
state drifted, setup reports the drift instead of claiming success.

Setup reads and verifies the locally locked runtime and extension, installs the
selected host plugin adapters, writes owned routing state, and prints the
unpacked extension directory. It does not install a public license, publish the
package or runtime release, or load the extension into Chrome for you.

## Load the Chrome extension

1. Open `chrome://extensions` in Google Chrome.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose the exact unpacked extension directory printed by setup.
5. Run `fast-browser doctor` again.

Chrome keeps developer-mode extensions per Chrome profile. Load the extension
in each profile where Fast Browser should operate.

You only do this once. Setup installs into a fixed directory
(`~/.fast-browser/extension/current/unpacked`) and swaps its contents in place
on every upgrade, so Chrome keeps pointing at the same path.

## Upgrading

After a setup that installs a newer pinned version, open `chrome://extensions`
and click the reload arrow on Fast Browser. Do not remove and re-add the
extension: removing it discards the extension's stored data, including the
reconnect token, which forces you to pair again with
`fast-browser configure --connection auto`.

Until you reload, `fast-browser doctor` reports `extension-loaded` as failing
while `extension-artifact` and `extension-installed` pass. That combination
means the pinned bytes are on disk and Chrome is still running the previous
ones. It is not drift, and rerunning setup will not clear it.

Chrome records the reload on a short delay, so `extension-loaded` can still
report stale for a moment after you have already reloaded. Rerun doctor rather
than reloading again.

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
