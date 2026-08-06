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
// fact, so `?profile=testid-rename` on the URL itself is a non-starter.
// Profile selection is instead a server-side toggle: which markup this SAME
// path ('/') serves on the NEXT request is an in-process variable the test
// flips directly via `setProfile` below (no extra network round trip, no
// env var, no query string) -- entirely test-side, confined to this
// fixture module.
function renderBase() {
  return pageTemplate
    .replace('<!--FIXTURE_VARIANT-->', '<script>window.__FIXTURE_VARIANT__ = "base";</script>')
    .replace('<!--FIXTURE_OVERLAY-->', '');
}

// Renders `profileName`'s markup, or returns `null` for an unrecognized
// name (the caller turns that into an HTTP 400 -- see the request handler
// below). 'base' is the identity transform; every other name must resolve
// through PROFILES.
function renderProfile(profileName) {
  if (profileName === 'base') return renderBase();
  const profile = PROFILES[profileName];
  if (!profile) return null;
  return profile.transform(renderBase());
}

export async function startOrderFixture({ port = 0 } = {}) {
  let currentProfile = 'base';
  const server = http.createServer((request, response) => {
    if (request.url !== '/') {
      response.writeHead(404);
      response.end();
      return;
    }
    const body = renderProfile(currentProfile);
    if (body === null) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(`unknown fixture profile: ${currentProfile}`);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body);
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
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const portIndex = process.argv.indexOf('--port');
  const port = portIndex === -1 ? 0 : Number(process.argv[portIndex + 1]);
  const fixture = await startOrderFixture({ port });
  process.stdout.write(`${JSON.stringify({ origin: fixture.origin })}\n`);
}
