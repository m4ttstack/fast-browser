# Fast Browser plugin

This repo is the plugin: skills, agents, macros, the installer, and the
`runtime-lock.json` that pins which runtime and Chrome extension get installed.

**It does not contain the code that drives the browser.** That lives in a fork
of Playwright and ships as prebuilt artifacts. Most "Fast Browser is behaving
wrong" bugs cannot be fixed here.

## Where a change belongs

| Symptom | Repo |
|---|---|
| relay drops, CDP, tab groups, extension behavior, MCP tools | the fork (see below) |
| setup, doctor, uninstall, migrate, config, annotate, gif | here, `lib/` |
| skills, agents, macros, routing rules | here |
| which runtime version is installed | here, `runtime-lock.json` |

The fork is `m4ttheweric/playwright`, normally cloned as a sibling of this repo.
Browser-driving code is mostly `packages/extension/src/` and
`packages/playwright/src/mcp/`.

### Fork branch: use `fast-browser-runtime`

All Fast Browser work, including the packaging and release tooling, is on the
`fast-browser-runtime` branch. The fork usually keeps a worktree for it under
`.worktrees/fast-browser-runtime`, parked on the commit the current lock names.

`main` and `multi-connection-extension` are **behind** that branch and have none
of the release tooling. Landing a fix there produces a runtime that cannot be
built or released. Some files are byte-identical across the branches, so a clean
`git diff` proves nothing. Check `git log HEAD..fast-browser-runtime` before
picking a branch.

Verify with `runtime-lock.json`'s `sourceCommit`, which is the exact commit the
installed artifacts were built from.

## Releasing a new runtime

GitHub Actions is **disabled on the fork on purpose**: it is a Playwright fork,
so enabling it runs the entire upstream Playwright CI suite. Do not turn it on,
and do not "fix" `publish_fast_browser.yml` expecting it to run. Artifacts are
built locally.

From the fork worktree, with the fix committed:

```bash
node utils/build/build.js
npm run test-extension                       # real Chrome, ~40s
node utils/fast_browser/build_artifacts.mjs --version <v> --out-dir fast-browser-dist
gh release create fast-browser-v<v> --repo m4ttheweric/playwright \
  --target fast-browser-runtime --title "Fast Browser <v>" --notes-file <notes>
gh release upload fast-browser-v<v> fast-browser-dist/* --repo m4ttheweric/playwright
```

`--target` takes a branch name or a full 40-char SHA. An abbreviated SHA is
rejected with a confusing `tag_name is not a valid tag`.

Bump `packages/extension/manifest.json` **and**
`packages/extension/package.json` together when extension code changes; a
release gate asserts they agree. Never change the manifest `key`: it derives the
extension ID, and changing it orphans every existing install.

## Re-pinning this repo: use the script

```bash
npm run pin-runtime -- --runtime 0.1.0-alpha.9 --plugin 0.1.0-alpha.10
npm test
```

A pin writes the release into eight places: `runtime-lock.json`, five version
fields (`package.json`, `package-lock.json`, `.claude-plugin/plugin.json`,
`.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`), the provenance
values in `THIRD_PARTY_NOTICES.md`, and a deliberate literal in
`tests/unit/runtime-lock.test.mjs`.

Doing that by hand takes several rounds of run-the-suite-find-the-next-miss.
The script derives all of it from the published release manifest and refuses to
write unless the published bytes hash to what that manifest claims.

The runtime version and this plugin's version are separate sequences and are not
meant to match. Plugin `alpha.9` pinned runtime `alpha.8`, for instance.

### The gates are the guardrail

`tests/unit/runtime-lock.test.mjs` hardcodes the expected lock, and a release
gate asserts `THIRD_PARTY_NOTICES.md` reproduces every value in it. These fail
loudly on a partial pin, which is the point. Update them to the new values;
never loosen or delete them to get green.

## Before blaming your change for a test failure

This suite is green at 1670/1670 (33 skipped) and the fork's extension suite
has known pre-existing failures (`cli.spec.ts › attach <url> --extension`).
Baseline first: stash your change, rebuild if the artifact matters, re-run.
Slow browser tests also contaminate each other, so confirm a failure in
isolation before treating it as real.

## Local install

`fast-browser setup --host both` reinstalls artifacts to match the current lock;
a bare `setup` refuses when both hosts are present. There is no `upgrade`
command in the CLI. After an extension version change, Chrome must be reloaded
manually at `chrome://extensions` or `doctor` keeps failing `extension-loaded`.

Never run `claude`/`codex plugin remove` before `fast-browser uninstall`.
Removing the host plugin first strips the start marker but leaves the
`[mcp_servers.fast_browser]` table in Codex's `config.toml`, and the dangling
marker makes every `fast-browser` command throw at parse time.
