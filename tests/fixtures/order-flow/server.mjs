import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const pageTemplate = await readFile(new URL('./index.html', import.meta.url), 'utf8');

const VARIANTS = new Set(['base', 'drifted', 'overlay']);

const CONSENT_OVERLAY_HTML = `
    <div id="consent-overlay" style="position:fixed;inset:0;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;">
      <div style="background:#fff;padding:1.5rem;border-radius:8px;">
        <p>This demo uses cookies.</p>
        <button type="button" id="consent-accept">Accept</button>
      </div>
    </div>`;

// WS3a Task 9 (healing e2e) drift mechanism -- see tests/e2e/healing.test.mjs
// for the full scenario write-up. In short: a compiled flow's own `goto`
// step replays against the flow's RECORDED path ('/'), verbatim -- there is
// no way for a caller to vary that navigation with a query string after the
// fact, so `?variant=drifted` on the URL itself is a non-starter. `variant`
// is instead a server-side toggle: which markup this SAME path ('/') serves
// on the NEXT request is an in-process variable the test flips directly via
// `setVariant` below (no extra network round trip, no env var, no query
// string) -- entirely test-side, confined to this fixture module.
function renderPage(variant) {
  return pageTemplate
    .replace('<!--FIXTURE_VARIANT-->', `<script>window.__FIXTURE_VARIANT__ = ${JSON.stringify(variant)};</script>`)
    .replace('<!--FIXTURE_OVERLAY-->', variant === 'overlay' ? CONSENT_OVERLAY_HTML : '');
}

export async function startOrderFixture({ port = 0 } = {}) {
  let currentVariant = 'base';
  const server = http.createServer((request, response) => {
    if (request.url !== '/') {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(renderPage(currentVariant));
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
    // variant the NEXT request to '/' receives. Never touches a request
    // already in flight.
    setVariant: (variant) => {
      if (!VARIANTS.has(variant)) throw new Error(`unknown fixture variant: ${variant}`);
      currentVariant = variant;
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const portIndex = process.argv.indexOf('--port');
  const port = portIndex === -1 ? 0 : Number(process.argv[portIndex + 1]);
  const fixture = await startOrderFixture({ port });
  process.stdout.write(`${JSON.stringify({ origin: fixture.origin })}\n`);
}
