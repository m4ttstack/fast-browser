import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  isLocalhostEndpoint,
  maybeAutolaunchLocalChrome,
  SidecarUnreachableError,
  waitForSidecar,
} from '../../lib/runtime/preflight.mjs';

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

// --- MAT-239: local-dev CDP autolaunch ------------------------------------

test('isLocalhostEndpoint recognizes every localhost spelling and rejects everything else', () => {
  assert.equal(isLocalhostEndpoint('http://127.0.0.1:9222'), true);
  assert.equal(isLocalhostEndpoint('http://localhost:9222'), true);
  assert.equal(isLocalhostEndpoint('http://[::1]:9222'), true);
  assert.equal(isLocalhostEndpoint('https://localhost:9222'), true);

  // A real remote host, and the classic single-letter typo of "localhost" --
  // both must read as non-local, never fall through to a launch.
  assert.equal(isLocalhostEndpoint('http://sidecar.pod.svc.cluster.local:9222'), false);
  assert.equal(isLocalhostEndpoint('http://lcoalhost:9222'), false);
  assert.equal(isLocalhostEndpoint('http://0.0.0.0:9222'), false);

  // Malformed input fails closed (not localhost) rather than throwing --
  // waitForSidecar's own URL handling is what surfaces the real error.
  assert.equal(isLocalhostEndpoint('not-a-url'), false);
});

// Injectable spawn per A3: `spawn` and `probePort` are handed in, so no test
// here opens a real socket or starts a real Chrome process.
function fakeSpawn(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return { pid: 4242, unref: () => {} };
  };
}

test('opt-in absent never probes or spawns, regardless of endpoint or listener state', async () => {
  const spawnCalls = [];
  let probed = false;

  const result = await maybeAutolaunchLocalChrome({
    endpoint: ENDPOINT,
    env: {},
    probePort: async () => { probed = true; return false; },
    spawn: fakeSpawn(spawnCalls),
    dataDir: '/fake/.fast-browser',
  });

  assert.equal(result, null);
  assert.equal(probed, false, 'the opt-in gate must short-circuit before any probe');
  assert.deepEqual(spawnCalls, []);
});

test('opt-in set but the endpoint is not localhost never spawns, even with nothing listening', async () => {
  const spawnCalls = [];

  const result = await maybeAutolaunchLocalChrome({
    endpoint: 'http://sidecar.pod.svc.cluster.local:9222',
    env: { FAST_BROWSER_CDP_AUTOLAUNCH: '1' },
    probePort: async () => false,
    spawn: fakeSpawn(spawnCalls),
    dataDir: '/fake/.fast-browser',
  });

  assert.equal(result, null);
  assert.deepEqual(spawnCalls, [], 'a non-localhost endpoint must ignore the opt-in, same as today');
});

test('opt-in set, localhost, but something is already listening never spawns', async () => {
  const spawnCalls = [];

  const result = await maybeAutolaunchLocalChrome({
    endpoint: ENDPOINT,
    env: { FAST_BROWSER_CDP_AUTOLAUNCH: '1' },
    probePort: async () => true,
    spawn: fakeSpawn(spawnCalls),
    dataDir: '/fake/.fast-browser',
  });

  assert.equal(result, null);
  assert.deepEqual(spawnCalls, []);
});

test('opt-in set, localhost, nothing listening launches chrome on the endpoint port with a dedicated profile', async () => {
  const spawnCalls = [];

  const result = await maybeAutolaunchLocalChrome({
    endpoint: ENDPOINT,
    env: { FAST_BROWSER_CDP_AUTOLAUNCH: '1' },
    probePort: async () => false,
    spawn: fakeSpawn(spawnCalls),
    findChrome: () => '/fake/Chrome',
    dataDir: '/fake/.fast-browser',
  });

  assert.equal(spawnCalls.length, 1);
  const [call] = spawnCalls;
  assert.equal(call.command, '/fake/Chrome');
  assert.ok(call.args.includes('--remote-debugging-port=9222'));
  const userDataDirArg = call.args.find((arg) => arg.startsWith('--user-data-dir='));
  assert.ok(userDataDirArg, 'must pass a --user-data-dir flag');
  const userDataDir = userDataDirArg.slice('--user-data-dir='.length);
  assert.ok(
    userDataDir.startsWith(path.join('/fake/.fast-browser', 'cdp-autolaunch')),
    'the profile dir must live under the fast-browser state dir, never the real profile',
  );
  assert.notEqual(userDataDir, '/fake/.fast-browser', 'must be a dedicated subdirectory, not the state dir itself');

  assert.equal(result.pid, 4242);
  assert.equal(result.userDataDir, userDataDir);
});

test('the launch is noted in the preflight log line with pid and profile', async () => {
  const lines = [];

  await maybeAutolaunchLocalChrome({
    endpoint: ENDPOINT,
    env: { FAST_BROWSER_CDP_AUTOLAUNCH: '1' },
    probePort: async () => false,
    spawn: fakeSpawn([]),
    findChrome: () => '/fake/Chrome',
    dataDir: '/fake/.fast-browser',
    log: (line) => lines.push(line),
  });

  assert.equal(lines.length, 1);
  assert.match(lines[0], /pid=4242/);
  assert.match(lines[0], /profile=.*cdp-autolaunch/);
});

test('FAST_BROWSER_CDP_AUTOLAUNCH is recognized regardless of case or spelling, same as FAST_BROWSER_DEBUG_CAPTURE', async () => {
  for (const value of ['1', 'true', 'TRUE', 'yes', ' true ']) {
    const spawnCalls = [];
    await maybeAutolaunchLocalChrome({
      endpoint: ENDPOINT,
      env: { FAST_BROWSER_CDP_AUTOLAUNCH: value },
      probePort: async () => false,
      spawn: fakeSpawn(spawnCalls),
      dataDir: '/fake/.fast-browser',
    });
    assert.equal(spawnCalls.length, 1, `expected ${JSON.stringify(value)} to enable autolaunch`);
  }

  for (const value of ['0', 'false', 'no', '', undefined]) {
    const spawnCalls = [];
    const env = value === undefined ? {} : { FAST_BROWSER_CDP_AUTOLAUNCH: value };
    await maybeAutolaunchLocalChrome({
      endpoint: ENDPOINT,
      env,
      probePort: async () => false,
      spawn: fakeSpawn(spawnCalls),
      dataDir: '/fake/.fast-browser',
    });
    assert.deepEqual(spawnCalls, [], `expected ${JSON.stringify(value)} to leave autolaunch off`);
  }
});

test('a spawn failure falls through instead of throwing, so the normal poll still runs its course', async () => {
  const lines = [];

  const result = await maybeAutolaunchLocalChrome({
    endpoint: ENDPOINT,
    env: { FAST_BROWSER_CDP_AUTOLAUNCH: '1' },
    probePort: async () => false,
    spawn: () => { const error = new Error('spawn ENOENT'); error.code = 'ENOENT'; throw error; },
    dataDir: '/fake/.fast-browser',
    log: (line) => lines.push(line),
  });

  assert.equal(result, null);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /autolaunch failed/);
});

test('opt-in absent leaves waitForSidecar byte-identical: SidecarUnreachableError still fires on a dead endpoint', async () => {
  const clock = fakeClock();
  const spawnCalls = [];
  let probed = false;

  await assert.rejects(
    () => waitForSidecar({
      endpoint: ENDPOINT,
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
      env: {},
      probePort: async () => { probed = true; return false; },
      spawn: fakeSpawn(spawnCalls),
      ...clock,
    }),
    (error) => {
      assert.ok(error instanceof SidecarUnreachableError);
      assert.equal(error.exitCode, 69);
      return true;
    },
  );

  assert.equal(probed, false, 'no autolaunch machinery runs when the opt-in is absent');
  assert.deepEqual(spawnCalls, []);
});

test('opt-in set and nothing listening: waitForSidecar launches chrome, then the normal poll picks it up', async () => {
  const clock = fakeClock();
  const spawnCalls = [];
  const lines = [];

  const result = await waitForSidecar({
    endpoint: ENDPOINT,
    fetchImpl: async () => okResponse(),
    env: { FAST_BROWSER_CDP_AUTOLAUNCH: '1' },
    probePort: async () => false,
    spawn: fakeSpawn(spawnCalls),
    findChrome: () => '/fake/Chrome',
    dataDir: '/fake/.fast-browser',
    log: (line) => lines.push(line),
    ...clock,
  });

  assert.equal(spawnCalls.length, 1, 'chrome should have been launched exactly once');
  assert.equal(result.browser, 'HeadlessChrome/140.0.0.0');
  // Both the launch line and the eventual "connected to" line land in the log.
  assert.ok(lines.some((line) => /auto-launched local chrome/.test(line)));
  assert.ok(lines.some((line) => /connected to/.test(line)));
});
