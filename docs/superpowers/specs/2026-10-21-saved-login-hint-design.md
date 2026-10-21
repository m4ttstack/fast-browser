# Saved-login hint in tool results

## Why

An agent driving Fast Browser lands on a login page and does not know a
saved login exists, so it asks the developer to log in or stalls, even
though a saved-login fill would have worked. The saved-login procedure
lives in the fast-browsing skill and the browser-driver agent; an agent
that drives the tools without that skill loaded, or reads a pack's
instructions that point it at the wrong origin, never finds it.

The case that prompted this: a pipeline's evidence stage navigated to a
local adjuster (`http://localhost:5001`), was redirected to Auth0 at
`https://login.assuredclaims.net`, never ran the saved-login lookup, and
asked the developer to log in. The developer had to tell it to use the
saved login, and the fill then worked first time.

The fix is to put the fact into the tool result the agent is already
reading, so it does not depend on which skill is loaded.

## What it does

After any tool call whose result reports page state (navigate, click,
form submit, a redirect or session bounce mid-task), if the current page's
origin has a saved login, the result's `### Page` block carries one more
line naming that origin and its two `devlogin:` names:

```
### Page
- Page URL: https://login.assuredclaims.net/u/login?state=...
- Page Title: Log in | Assured
- Saved login for https://login.assuredclaims.net: fill with devlogin:login.assuredclaims.net:email / devlogin:login.assuredclaims.net:password
```

Exact wording is the builder's, within these rules: it names the origin
and both names, and reads as an instruction to fill with them.

## Decided

- **Content:** the origin plus both `devlogin:` names. Never a value,
  never the email.
- **Trigger:** any tool result while the current page is on a saved
  origin, not only navigate.
- **Detection:** origin match alone. The page's origin has a saved login,
  so the line appears; no check for a visible password or email field.
- **Repetition:** on every result while the page stays on that origin,
  not once per landing. The fork prints the `### Page` block only when the
  tab header changes (`_build()` in `response.ts`, the `changed` check
  from `Tab.headerSnapshot()`), a deliberate transcript saving that stays.
  When the block is printed, the line goes inside it; when the block is
  left out, the line is printed on its own (in a section of its own or
  as a bare line, the builder's call), so an unchanged login page still
  carries it. A lookup that answers late shows the line on the next
  result.
- **Failure:** when rt is missing, the daemon is down, the lookup errors
  or times out, the line is left out with no warning. The agent falls
  back to the skill's normal path.
- **The agent still fills and submits.** Nothing is filled
  automatically. Every existing refusal (recording, slow-typing,
  mismatch, limited, opaque origin, 2FA, captcha) is unchanged.
- **Lookup source:** a new rt daemon verb answers "is there a saved login
  for this origin?" and returns the two names. The launcher does not
  shell out to `rt logins list`, which reads every stored login in full.

## The three pieces

1. **rt (`m4ttstack/mattstack`, the repo-tools checkout).** A daemon verb
   beside `logins:fill` (`lib/daemon/handlers/logins.ts`), reached the
   same way: POST over `rt.sock`, carrying the api token, never over the
   HTTP api server (`lib/daemon/__tests__/no-logins-over-http.test.ts`
   guards that). Input: an origin. Output: the two `devlogin:` names when
   a login is saved for exactly that origin, or a plain "none". It never
   returns a value or the email, and is not rate limited like a password
   fill. Names come from `normalizeOrigin` and `placeholderName`
   (`lib/logins/origin.ts`). The rt release that ships it must reach the
   machine before the hint can work; until then the launcher sees an
   unknown verb and leaves the line out.
2. **This repo (launcher).** `lib/runtime/secrets-channel.mjs` gains a
   second request type on the existing channel, "saved login for origin",
   answered by a new client call in `lib/rt/` (beside
   `login-fill-client.mjs`) to the new verb. The launcher caches each
   origin's answer briefly so a run of actions on one page costs one
   daemon call, and so a login added mid-session shows up soon after.
   The fast-browsing skill and browser-driver agent get one sentence:
   the line, when present, is the saved-login lookup's answer for that
   origin, so the agent skips `rt logins list` and fills with those
   names.
3. **The fork (`m4ttheweric/playwright`, branch `fast-browser-runtime`).**
   `SecretsChannel` (`packages/playwright-core/src/tools/backend/secretsChannel.ts`)
   gains the matching request. `response.ts`
   (`packages/playwright-core/src/tools/backend/`) adds the line:
   `renderTabMarkdown` when the `### Page` block is printed, and `_build()`
   on its own when the header dedupe leaves the block out (see
   Repetition). Then a runtime release and a re-pin here with
   `npm run pin-runtime`, per this repo's CLAUDE.md.

Order: rt verb first, then the launcher (it tolerates an rt without the
verb), then the fork and its release, then the pin.

## Constraints

- No secret value or email ever crosses the new path, in either
  direction, or lands in a log.
- The hint must not slow a tool result noticeably. A result never waits
  longer than a short bound on the lookup; past it, the line is left out
  for that result.
- Fork work starts from the `fast-browser-runtime` branch. The fork's
  worktree at `.worktrees/fast-browser-runtime` was found checked out on
  `dev-logins-runtime`, which does not contain the commit the lock pins
  (`b2cc1e33`); check `git log HEAD..fast-browser-runtime` before
  building there.
- Existing gates stay as they are: the runtime-lock and notices gates are
  updated by the pin script, never loosened.
- Cloud mode (`FAST_BROWSER_ENGINE` cloud) runs with no secrets channel,
  so it gets no line. That is expected, not a bug.

## Non-goals

- Filling or submitting automatically.
- Detecting login screens by page content.
- Telling the agent when a lookup failed.
- Changing how a fill is authorised or refused.

## Anti-goals

- A hint on an ordinary page of a saved origin that nags the agent into
  filling where no form exists. Origin-only detection accepts this risk;
  if it shows up in practice, the visible-field check is the follow-up.
- Any path that lets an agent learn a stored value.

## Left to the builder

- The line's exact wording, within the rules above.
- The new verb's name and payload shape, and its error envelope (match
  `logins:fill`'s).
- How the daemon decides "saved for exactly this origin" (whether the
  stored-key list alone is enough, or the stored origin must be read),
  as long as no value leaves the daemon.
- The cache's lifetime and the lookup's time bound.
- Tests in each repo, and the runtime and plugin version numbers.
