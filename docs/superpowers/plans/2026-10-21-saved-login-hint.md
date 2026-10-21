# Saved-login Hint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Fast Browser tool result taken while the page sits on an origin with a saved login carries one line naming that origin and its two `devlogin:` names.

**Architecture:** rt's daemon gains `logins:has`, a value-free existence check beside `logins:fill`. This repo's launcher answers a new `saved-login` request on the existing secrets channel by calling that verb, caching per origin. The fork asks over the channel while building each result and prints the line inside the `### Page` block when that block prints, or as its own `### Saved login` section when the header dedupe leaves the block out.

**Tech Stack:** rt: Bun + TypeScript (`bun test`). This repo: Node ESM (`node --test`). Fork: TypeScript Playwright, MCP tests via `npm run ctest-mcp`.

**Spec:** `docs/superpowers/specs/2026-10-21-saved-login-hint-design.md`

## Global Constraints

- No secret value or email crosses the new path in either direction or lands in a log.
- The line names the origin and both `devlogin:` names, and nothing else: `- Saved login for <origin>: fill with <email name> / <password name>`.
- Origin match alone triggers it; no page-content check.
- Any lookup failure (no rt, daemon down, unknown verb, bad token, timeout) leaves the line out with no warning.
- Nothing is filled automatically; existing fill refusals are unchanged.
- A result waits at most 1000 ms on the lookup; past it the line is left out for that result.
- Fork work branches from `fast-browser-runtime` (check `git log HEAD..fast-browser-runtime` in any fork worktree before building; `.worktrees/fast-browser-runtime` was found on `dev-logins-runtime`).
- The runtime-lock and notices gates are updated only by `npm run pin-runtime`, never loosened.
- `logins:has` is reached over `rt.sock` only; `lib/daemon/__tests__/no-logins-over-http.test.ts` stays green.
- rt work runs targeted tests only (the files touched); the full suite is CI's.

## Wire protocol (decided here)

Launcher to rt daemon, POST `/logins:has` on `rt.sock`:
`{ token, client: "fast-browser", pid, origin }` → `{ ok: true, data: { origin, fields: { email, password } } }` or `{ ok: true, data: { none: true } }`; bad token is `ok: false` as in `logins:fill`.

Fork to launcher, on the secrets channel (fill requests keep their current shape, with no `type`):
`{ id, type: "saved-login", origin }` → `{ id, type: "saved-login", origin, fields: { email, password } }` or `{ id, type: "saved-login", origin, none: true }`.

## Review Focus

- A page on `about:blank`, `data:`, `file:` or `chrome-extension:`: no request is sent and no line appears (Task 4 test).
- An http localhost origin with a port (`http://localhost:5001`): the names come from the daemon (`devlogin:localhost_5001_http:*`), never recomputed in the fork or launcher (Task 1 test).
- An origin rt cannot hold (an IPv6 host, a host with `_`): `none`, not an error (Task 1 test).
- A daemon that never answers: the tool result returns within the 1000 ms bound without the line, and the next result shows it once the launcher's cached answer lands (Tasks 3 and 4 tests).
- Two tabs open: the line uses the current tab's origin only (Task 4 test).

---

### Task 1: rt `logins:has` daemon verb

Repo: `m4ttstack/mattstack` (repo-tools), in an rt worktree. Lands as its own PR, before the launcher PR merges.

**Files:**
- Modify: `packages/rt-client/src/commands.ts` (the `"logins:fill"` entry near line 795; `COMMAND_NAMES` near line 1213)
- Modify: `lib/daemon/handlers/logins.ts`
- Test: `lib/daemon/__tests__/logins-handler.test.ts`

**Interfaces:**
- Produces: command `"logins:has"`, payload `{ token?: string; client?: string; pid?: number; origin?: string }`, data `{ origin: string; fields: { email: string; password: string } } | { none: true }`.
- `createLoginsHandlers(ctx, overrides)` also returns `"logins:has"`; `LoginsHandlerOverrides` gains `listKeys?: () => Promise<string[]>` (default: the secrets backend's `names()`).

- [ ] **Step 1: Write the failing tests** in a `describe("logins:has")` block, using a `setup` that passes `listKeys`:
  - `missing or wrong token is ok:false and lists nothing`: `{ ok: false, error: "missing-token" }` / `"bad-token"`; `listKeys` call count 0.
  - `a saved origin returns its two names`: keys `["login.example.com"]`, origin `https://login.example.com` → `{ ok: true, data: { origin: "https://login.example.com", fields: { email: "devlogin:login.example.com:email", password: "devlogin:login.example.com:password" } } }`.
  - `http localhost with a port uses rt's key`: keys `["localhost_5001_http"]`, origin `http://localhost:5001` → fields `devlogin:localhost_5001_http:email` / `:password`.
  - `an unsaved origin is none`: keys `[]` → `{ ok: true, data: { none: true } }`.
  - `an origin rt cannot hold is none` (test.each): `http://[::1]:3000`, `https://a_b.example.com`, `not a url`, `https://login.example.com/path` → `{ none: true }`.
  - `never reads a login value`: `readLogin` override throws if called; a saved-origin call still succeeds.
- [ ] **Step 2: Run** `bun test lib/daemon/__tests__/logins-handler.test.ts` from the repo-tools root. Expected: the new tests FAIL (no `"logins:has"` handler).
- [ ] **Step 3: Implement.** Add the `Commands` entry and the `COMMAND_NAMES` row. In the handler: token check identical to `logins:fill`; `normalizeOrigin(p.origin)` inside try (any throw → `none`); `none` unless `(await listKeys()).includes(key)`; fields from `placeholderName(key, "email" | "password")`. Log at debug with origin and outcome only; never read a login.
- [ ] **Step 4: Run** the same file plus `bun test lib/daemon/__tests__/no-logins-over-http.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `add logins:has daemon verb for the saved-login hint`, push with `git_push`, open the PR (CodeRabbit, CI green, Matt confirms merge).

### Task 2: launcher client for `logins:has`

Repo: this one, branch `saved-login-hint`.

**Files:**
- Modify: `lib/rt/login-fill-client.mjs`
- Test: `tests/unit/login-fill-client.test.mjs`

**Interfaces:**
- Produces: `export const SAVED_LOGIN_TIMEOUT_MS = 1500;` and `export async function requestSavedLogin({ origin, homeDir, env = process.env, pid = process.pid, timeoutMs = SAVED_LOGIN_TIMEOUT_MS }): Promise<{ fields: { email: string, password: string } } | { none: true } | { refused: 'unavailable' }>`.
- `postJson` takes the request path as a parameter; `requestLoginFill` passes `/logins:fill`.

- [ ] **Step 1: Write the failing tests**, following the file's existing socket-server fixture:
  - `requestSavedLogin posts token, client, pid and origin to /logins:has`.
  - `returns fields when the daemon names a login` and `returns none when it says none`.
  - `a field name that is not devlogin: is unavailable` (daemon returns `fields.email: "x"`).
  - `missing token file, socket error, timeout, ok:false, unparseable body and oversize body are unavailable` (one case each).
- [ ] **Step 2: Run** `node --test tests/unit/login-fill-client.test.mjs`. Expected: new tests FAIL.
- [ ] **Step 3: Implement** `requestSavedLogin`; validate both names against `DEVLOGIN_NAME` from `lib/runtime/secrets-channel.mjs`.
- [ ] **Step 4: Run** the same command. Expected: PASS, existing fill tests included.
- [ ] **Step 5: Commit** `rt client: add requestSavedLogin for logins:has`.

### Task 3: secrets channel answers `saved-login`

**Files:**
- Modify: `lib/runtime/secrets-channel.mjs`, `lib/runtime/entry.mjs:29-38`
- Test: `tests/unit/secrets-channel.test.mjs`, `tests/integration/secrets-channel.test.mjs`

**Interfaces:**
- Consumes: `requestSavedLogin` (Task 2).
- Produces: `export const SAVED_LOGIN_TTL_MS = 30_000;` `export function createSavedLoginLookup({ fetchSavedLogin, now = Date.now, ttlMs = SAVED_LOGIN_TTL_MS }): (origin: string) => Promise<{ fields } | { none: true }>`. `attachSecretsChannel({ socket, fetchFill, lookupSavedLogin, log })`; `replyTo(request, fetchFill, lookupSavedLogin)` routes `type: "saved-login"` there, every other frame to the fill path unchanged.

- [ ] **Step 1: Write the failing unit tests:**
  - `a saved-login request with fields replies { id, type, origin, fields }`.
  - `none and unavailable both reply { id, type, origin, none: true }`.
  - `a saved-login request with a non-origin is none and never calls fetch` (`https://a.example.com/x`, `about:blank`).
  - `lookup caches fields and none for ttlMs, and refetches after` (fake `now`).
  - `lookup never caches unavailable`.
  - `concurrent lookups of one origin share one fetch, and its answer lands in the cache even when the caller stopped waiting` (the late-answer case).
  - `a fill request without type still takes the fill path` (existing tests stay green).
- [ ] **Step 2: Run** `node --test tests/unit/secrets-channel.test.mjs`. Expected: new tests FAIL.
- [ ] **Step 3: Implement** the lookup (one in-flight promise per origin; store `fields` or `none` with an expiry; drop `unavailable`), the `replyTo` branch, and the `entry.mjs` wiring with `requestSavedLogin({ origin, homeDir, env })`.
- [ ] **Step 4: Add an integration test** in `tests/integration/secrets-channel.test.mjs`: over a real socket pair, a `saved-login` frame and a fill frame interleaved each get their own reply by id.
- [ ] **Step 5: Run** `npm run test:unit && npm run test:integration`. Expected: PASS.
- [ ] **Step 6: Commit** `secrets channel: answer saved-login requests with a per-origin cache`.

### Task 4: fork prints the line

Repo: `m4ttheweric/playwright`, a branch `saved-login-hint` off `fast-browser-runtime`.

**Files:**
- Modify: `packages/playwright-core/src/tools/backend/secretsChannel.ts`
- Modify: `packages/playwright-core/src/tools/backend/response.ts` (`_build()` near line 293; `renderTabMarkdown` near line 362)
- Modify: `tests/mcp/devlogin-channel-host.mjs` (answer `type: "saved-login"` from `fixture.savedLogins`, a list of `{ origin, fields }`; an origin listed in `fixture.silentOrigins` gets no reply; log every request as today)
- Create: `tests/mcp/devlogin-hint.spec.ts`

**Interfaces:**
- Consumes: the channel wire protocol above.
- Produces: `SecretsChannel.savedLogin(origin: string, timeoutMs = 1000): Promise<{ email: string, password: string } | undefined>`; `renderTabMarkdown(tab: TabHeader, savedLogin?: { origin: string, email: string, password: string }): string[]`.

- [ ] **Step 1: Write the failing spec** `devlogin-hint.spec.ts` (served pages on the test server's origin, which the fixture lists as saved):
  - `navigate to a saved origin shows the line in the Page block`: text contains `- Saved login for <origin>: fill with devlogin:<key>:email / devlogin:<key>:password`.
  - `a second action on the unchanged page shows it as its own section`: a `browser_click` on the same page has no `### Page` block and has `### Saved login` with the same line.
  - `an unsaved origin shows no line`.
  - `about:blank shows no line and sends no saved-login request` (request log).
  - `a silent origin returns within the bound without the line`: elapsed under 3000 ms for the call.
  - `two tabs: the line follows the current tab`.
  - `no secrets channel: no line, no error` (launched without the host).
  - `no value or email appears in any result` (assert the fixture's fill values never occur).
- [ ] **Step 2: Build and run** `node utils/build/build.js && npm run ctest-mcp -- devlogin-hint`. Expected: FAIL.
- [ ] **Step 3: Implement.** `SecretsChannel`: pending entries match a reply by id plus a per-request predicate (fill keeps the `name` check; saved-login checks `type` and `origin`); `savedLogin` resolves `undefined` on `none`, timeout, no channel or a malformed reply. `_build()`: for the current tab, when its URL protocol is `http:` or `https:` and `config.secretsChannelFd` is set, await `savedLogin(origin)`; pass the result to `renderTabMarkdown` when the Page block prints, else `addSection('Saved login', [line])`.
- [ ] **Step 4: Run** the spec plus `npm run ctest-mcp -- devlogin` (every existing devlogin spec). Expected: PASS; the known pre-existing `cli.spec.ts › attach <url> --extension` failure is not in scope.
- [ ] **Step 5: Commit** `mcp: print the saved-login line when the page is on a saved origin` and push the branch.

### Task 5: runtime release and re-pin

- [ ] **Step 1: Gate.** Ask Matt before merging the fork branch into `fast-browser-runtime` and before `gh release create`; both are outward-facing.
- [ ] **Step 2: Release** from the fork worktree on `fast-browser-runtime`, with the next runtime version `<v>`: the five commands in this repo's CLAUDE.md "Releasing a new runtime". No extension code changes, so the manifest and extension `package.json` stay as they are.
- [ ] **Step 3: Pin** in this repo: `npm run pin-runtime -- --runtime <v> --plugin <next plugin version>`, then `npm test`. Expected: PASS at the suite's baseline (1669 passing plus the new tests, 33 skipped).
- [ ] **Step 4: Commit** `pin runtime <v> (saved-login hint)`.

### Task 6: skill and agent note

**Files:**
- Modify: `skills/fast-browsing/SKILL.md` (section `### Saved login for this origin?`), `agents/browser-driver.md:137-139`, `templates/codex/browser_driver.toml` (the matching sentence)
- Test: `tests/unit/skills.test.mjs`

- [ ] **Step 1: RED baseline** per superpowers:writing-skills: a fresh agent with the current skill, shown a result carrying the line, still runs `rt logins list` first or asks the human. Record what it does.
- [ ] **Step 2: Add one sentence** to each file: a `Saved login for <origin>` line in a result is the saved-login lookup's answer for that origin, so fill with the names it gives and skip `rt logins list`; with no such line, the lookup runs as before.
- [ ] **Step 3: GREEN** with a fresh agent on the same scenario; it fills with the line's names. Add a `skills.test.mjs` assertion that all three files carry the sentence's key phrase `Saved login for`.
- [ ] **Step 4: Run** `node --test tests/unit/skills.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `fast-browsing: read the saved-login line before looking logins up`, push, open the fast-browser PR with Tasks 2, 3, 5 and 6.
