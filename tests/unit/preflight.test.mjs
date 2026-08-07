import assert from 'node:assert/strict';
import test from 'node:test';

import { SidecarUnreachableError, waitForSidecar } from '../../lib/runtime/preflight.mjs';

const ENDPOINT = 'http://127.0.0.1:9222';

// A controllable clock: `now` advances only when `sleep` is called, so the
// deadline is exercised deterministically without any real waiting.
function fakeClock() {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms) => { current += ms; },
    advance: (ms) => { current += ms; },
  };
}

function okResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      Browser: 'HeadlessChrome/140.0.0.0',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
    }),
  };
}

test('a sidecar that answers immediately returns its build string', async () => {
  const clock = fakeClock();
  const calls = [];

  const result = await waitForSidecar({
    endpoint: ENDPOINT,
    fetchImpl: async (url) => { calls.push(url); return okResponse(); },
    ...clock,
  });

  assert.deepEqual(calls, ['http://127.0.0.1:9222/json/version']);
  assert.equal(result.browser, 'HeadlessChrome/140.0.0.0');
  assert.equal(result.webSocketDebuggerUrl, 'ws://127.0.0.1:9222/devtools/browser/abc');
});

test('a sidecar that starts late within the window is absorbed, not failed', async () => {
  const clock = fakeClock();
  let attempts = 0;

  const result = await waitForSidecar({
    endpoint: ENDPOINT,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 5) throw new Error('ECONNREFUSED');
      return okResponse();
    },
    ...clock,
  });

  assert.equal(attempts, 5);
  assert.equal(result.browser, 'HeadlessChrome/140.0.0.0');
});

test('exhausting the deadline throws SidecarUnreachableError with exit code 69', async () => {
  const clock = fakeClock();

  await assert.rejects(
    () => waitForSidecar({
      endpoint: ENDPOINT,
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
      ...clock,
    }),
    (error) => {
      assert.ok(error instanceof SidecarUnreachableError);
      assert.equal(error.exitCode, 69);
      assert.match(error.message, /127\.0\.0\.1:9222/, 'names the endpoint');
      assert.match(error.message, /30000ms|30s/, 'states the deadline');
      return true;
    },
  );
});

test('a 200 without a debugger url is not a ready sidecar', async () => {
  const clock = fakeClock();

  await assert.rejects(
    () => waitForSidecar({
      endpoint: ENDPOINT,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ Browser: 'x' }) }),
      ...clock,
    }),
    (error) => {
      assert.equal(error.exitCode, 69);
      return true;
    },
  );
});

test('the chrome build string is logged exactly once on success', async () => {
  const clock = fakeClock();
  const lines = [];

  await waitForSidecar({
    endpoint: ENDPOINT,
    fetchImpl: async () => okResponse(),
    log: (line) => lines.push(line),
    ...clock,
  });

  assert.equal(lines.length, 1);
  assert.match(lines[0], /HeadlessChrome\/140\.0\.0\.0/);
});
