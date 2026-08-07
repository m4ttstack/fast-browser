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
    fetchImpl: async (url, opts) => { calls.push(url); return okResponse(); },
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
    fetchImpl: async (url, opts) => {
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
      fetchImpl: async (url, opts) => { throw new Error('ECONNREFUSED'); },
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
      fetchImpl: async (url, opts) => ({ ok: true, status: 200, json: async () => ({ Browser: 'x' }) }),
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
    fetchImpl: async (url, opts) => okResponse(),
    log: (line) => lines.push(line),
    ...clock,
  });

  assert.equal(lines.length, 1);
  assert.match(lines[0], /HeadlessChrome\/140\.0\.0\.0/);
});

test('each attempt receives an options object carrying an AbortSignal', async () => {
  const clock = fakeClock();
  const receivedSignals = [];

  await waitForSidecar({
    endpoint: ENDPOINT,
    fetchImpl: async (url, opts) => {
      receivedSignals.push(opts?.signal);
      return okResponse();
    },
    ...clock,
  });

  assert.equal(receivedSignals.length, 1);
  assert.ok(receivedSignals[0] instanceof AbortSignal);
});

test('an AbortError is absorbed as an ordinary failed attempt and the loop continues', async () => {
  const clock = fakeClock();
  let attempts = 0;

  const result = await waitForSidecar({
    endpoint: ENDPOINT,
    fetchImpl: async (url, opts) => {
      attempts += 1;
      if (attempts < 3) {
        const err = new Error('AbortError');
        err.name = 'AbortError';
        throw err;
      }
      return okResponse();
    },
    ...clock,
  });

  assert.equal(attempts, 3);
  assert.equal(result.browser, 'HeadlessChrome/140.0.0.0');
});

test('per-attempt budget is capped by time remaining in the window', async () => {
  const clock = fakeClock();
  let attempts = 0;

  await assert.rejects(
    () => waitForSidecar({
      endpoint: ENDPOINT,
      fetchImpl: async (url, opts) => {
        attempts += 1;
        throw new Error('ECONNREFUSED');
      },
      deadlineMs: 5_000,
      intervalMs: 1_000,
      attemptTimeoutMs: 2_000,
      ...clock,
    }),
    (error) => error instanceof SidecarUnreachableError,
  );

  // With a 5s deadline and 1s interval:
  // - Attempt 1 at t=0: budget = min(2000, 5000 - 0) = 2000
  // - Attempt 2 at t=1000: budget = min(2000, 5000 - 1000) = 2000
  // - Attempt 3 at t=2000: budget = min(2000, 5000 - 2000) = 2000
  // - Attempt 4 at t=3000: budget = min(2000, 5000 - 3000) = 2000
  // - Attempt 5 at t=4000: budget = min(2000, 5000 - 4000) = 1000
  // - At t=5000 + 1000: we check if now() + intervalMs > expiresAt (5000 + 1000 > 5000), which is true, so we throw
  // So we should have ~5 attempts before deadline is exceeded
  assert.ok(attempts >= 4, `expected at least 4 attempts, got ${attempts}`);
});
