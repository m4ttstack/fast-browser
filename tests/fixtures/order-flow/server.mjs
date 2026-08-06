import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import { PROFILES } from './profiles.mjs';

const pageTemplate = await readFile(new URL('./index.html', import.meta.url), 'utf8');

// WS4a Task 1: the WS3a Task 9 / WS3b Task 10 ad-hoc variant toggle
// ('base'/'drifted'/'overlay'/'role-drifted'/'intercept') generalizes to
// named mutation-PROFILE selection (./profiles.mjs). This refactor changes
// nothing about what gets served for any of the four still-selectable
// variants -- see profiles.mjs's own header comment for the old-name ->
// new-name mapping and tests/e2e/healing.test.mjs for what each proves.
//
// 'base' renders the fixture's own unmodified base markup (the identity
// transform) and is not itself a PROFILES entry -- see profiles.mjs.
// Any other name not present in PROFILES is unknown: the request handler
// answers 400 rather than serving mismatched or absent markup.

// WS3a Task 9 (healing e2e) drift mechanism -- see tests/e2e/healing.test.mjs
// for the full scenario write-up. In short: a compiled flow's own `goto`
// step replays against the flow's RECORDED path ('/'), verbatim -- there is
// no way for a caller to vary that navigation with a query string after the
// fact, so `?profile=testid-rename` on the URL itself is a non-starter for
// a FLOW REPLAY. Profile selection is instead a server-side toggle: which
// markup this SAME path ('/') serves on the NEXT request is an in-process
// variable the test flips directly via `setProfile` below (no extra
// network round trip, no env var, no query string) -- entirely test-side,
// confined to this fixture module. WS4a Task 2 adds a SEPARATE, additive
// entry point (the `?profile=` query param read below) purely so a unit
// test can hit the unknown-profile 400 path directly over real HTTP without
// a browser; no flow replay ever sends a query string, so this changes
// nothing about the toggle-driven behavior above.
export function renderBase() {
  return pageTemplate
    .replace('<!--FIXTURE_VARIANT-->', '<script>window.__FIXTURE_VARIANT__ = "base";</script>')
    .replace('<!--FIXTURE_OVERLAY-->', '');
}

// Renders `profileName`'s markup, or returns `null` for an unrecognized
// name (the caller turns that into an HTTP 400 -- see the request handler
// below). 'base' is the identity transform; every other name must resolve
// through PROFILES.
export function renderProfile(profileName) {
  if (profileName === 'base') return renderBase();
  const profile = PROFILES[profileName];
  if (!profile) return null;
  return profile.transform(renderBase());
}

// WS4a Task 5 (at-most-once kill test): a per-token counter of real
// mutating POSTs to '/order', plus a '/order/count' read endpoint -- both
// plain HTTP, deliberately independent of any browser session, so a caller
// can observe "did the mutation fire" (and re-observe it after a kill)
// without needing the (possibly-killed) browser connection to still be
// usable. `submissionCounts` lives per fixture instance (a fresh
// `startOrderFixture()` call -- every e2e test's own pattern -- starts
// empty), and within one instance is keyed per TOKEN (the brief's own
// chosen semantics): an unseen token reads 0 with no explicit reset step
// needed, and two different tokens never interfere with each other's
// count -- see tests/unit/fixture-profiles.test.mjs for the direct proof.
// `killTest` (null | { token, stall }) is the orthogonal SERVER-MODE toggle
// (not a mutation PROFILE -- see index.html's own doc comment) that decides
// what the NEXT '/' request embeds: `setKillTest(null)` (the default)
// injects nothing into the `<!--FIXTURE_KILLTEST-->` placeholder. This is
// BEHAVIORALLY identical to before this task for every other suite -- not
// byte-for-byte: index.html itself gained real script lines (the
// KILL_TEST_TOKEN/KILL_TEST_STALL consts, the delegated listener, the
// conditional in showComplete) that are served on every request regardless
// of `killTest` state, all of them dead code (guarded on a token that is
// always null/undefined) unless a test explicitly calls `setKillTest`.
//
// Stall mechanism choice: the brief names two options -- "the server holds
// the response" or "the client script never renders the next element."
// This fixture uses the SECOND. Holding an HTTP response open on this
// server would only stall whatever THAT ONE in-flight request is (there is
// nothing for the client to keep waiting ON unless it deliberately issues a
// second, held-open fetch of its own); it says nothing about whether the
// NEXT interactive element the replay's own following step targets ever
// exists on the page. Withholding the render directly (index.html's
// `showComplete`, gated on `KILL_TEST_STALL`) makes that next step's own
// locator walk genuinely, honestly miss -- the actual mechanism
// `flow-runner.js`'s `resolveTarget` is built to handle, and the one this
// task's kill leg needs to exercise for real.
export async function startOrderFixture({ port = 0 } = {}) {
  let currentProfile = 'base';
  let killTest = null;
  const submissionCounts = new Map();

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');

    if (url.pathname === '/order' && request.method === 'POST') {
      let raw = '';
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        let token = null;
        try {
          const parsed = JSON.parse(raw || '{}');
          if (typeof parsed.token === 'string' && parsed.token.length > 0) token = parsed.token;
        } catch {
          token = null;
        }
        if (!token) {
          response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('missing or invalid token');
          return;
        }
        const nextCount = (submissionCounts.get(token) ?? 0) + 1;
        submissionCounts.set(token, nextCount);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, count: nextCount }));
      });
      return;
    }

    if (url.pathname === '/order/count' && request.method === 'GET') {
      const token = url.searchParams.get('token');
      const count = token ? (submissionCounts.get(token) ?? 0) : 0;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ count }));
      return;
    }

    if (url.pathname !== '/') {
      response.writeHead(404);
      response.end();
      return;
    }
    // `?profile=` (present) wins over the toggle; absent falls back to
    // `currentProfile` exactly as before this query-param entry point
    // existed -- see the doc comment above `renderBase`.
    const requestedProfile = url.searchParams.has('profile')
      ? url.searchParams.get('profile')
      : currentProfile;
    const body = renderProfile(requestedProfile);
    if (body === null) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(`unknown fixture profile: ${requestedProfile}`);
      return;
    }
    // `renderProfile`/`renderBase` stay pure and kill-test-unaware (their
    // own direct callers -- tests/unit/fixture-profiles.test.mjs's purity
    // checks -- see the placeholder left untouched, a harmless HTML
    // comment). The substitution happens here, at the one real HTTP
    // boundary, mirroring the OVERLAY placeholder's own unconditional
    // replace-with-empty-string default.
    const killTestScript = killTest
      ? `<script>window.__KILL_TEST_TOKEN__ = ${JSON.stringify(killTest.token)}; window.__KILL_TEST_STALL__ = ${killTest.stall === true};</script>`
      : '';
    const finalBody = body.replace('<!--FIXTURE_KILLTEST-->', killTestScript);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(finalBody);
  });
  // A real browser tab can leave a connected-but-idle socket open (Chrome
  // keep-alive) that server.close() would otherwise wait on indefinitely.
  // Track every open socket and destroy them ourselves so close() resolves
  // promptly with tabs still open.
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const { port: boundPort } = server.address();
  return {
    origin: `http://127.0.0.1:${boundPort}`,
    close: () => new Promise((resolve, reject) => {
      for (const socket of sockets) socket.destroy();
      server.close((error) => error ? reject(error) : resolve());
    }),
    // Test-side toggle (see the module doc comment above): flips which
    // profile the NEXT request to '/' receives. Never touches a request
    // already in flight. Fails fast on an unrecognized name here too (test
    // misuse) -- the request handler's own 400 covers any other path that
    // could reach `renderProfile` with a bad name.
    setProfile: (profileName) => {
      if (profileName !== 'base' && !PROFILES[profileName]) {
        throw new Error(`unknown fixture profile: ${profileName}`);
      }
      currentProfile = profileName;
    },
    // WS4a Task 5: flips what the NEXT '/' request embeds (same
    // never-touches-an-in-flight-request contract as `setProfile` above).
    // `config` is `null` (the default -- see the module doc comment) or
    // `{ token: string, stall: boolean }`. Deliberately no shape-checking
    // here (unlike `setProfile`'s unknown-name guard): this is a test-only
    // toggle with exactly one real caller, not a value that ever crosses an
    // HTTP boundary the way a profile name does.
    setKillTest: (config) => { killTest = config; },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const portIndex = process.argv.indexOf('--port');
  const port = portIndex === -1 ? 0 : Number(process.argv[portIndex + 1]);
  const fixture = await startOrderFixture({ port });
  process.stdout.write(`${JSON.stringify({ origin: fixture.origin })}\n`);
}
