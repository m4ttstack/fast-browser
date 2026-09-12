import assert from 'node:assert/strict';
import test from 'node:test';

import { startRuntime } from '../../lib/runtime/entry.mjs';

const paths = { dataDir: '/synthetic-home/.fast-browser' };
const lock = { extension: { id: 'abcdefghijklmnopabcdefghijklmnop' } };

const CLOUD_ENV = {
  FAST_BROWSER_ENGINE: 'cdp',
  FAST_BROWSER_CDP_ENDPOINT: 'http://127.0.0.1:9222',
};

function deps(overrides = {}) {
  return {
    loadConfig: async () => ({
      profile: 'safe',
      trace: false,
      connection: { mode: 'auto' },
      sessions: { enabled: false, retentionDays: 30 },
    }),
    cloudConfig: async () => ({
      profile: 'safe',
      trace: false,
      engine: 'cdp',
      cdpEndpoint: 'http://127.0.0.1:9222',
      connection: { mode: 'manual' },
    }),
    waitForSidecar: async () => ({ browser: 'HeadlessChrome/140', webSocketDebuggerUrl: 'ws://x' }),
    readToken: async () => 'token',
    launchRuntime: async () => 0,
    pruneSessions: async () => ({ removedPaths: [], removedBytes: 0 }),
    warn: () => {},
    ...overrides,
  };
}

test('a bare environment takes the local path and supplies a Keychain reader', async () => {
  let sawReadToken = false;
  let preflighted = false;

  const code = await startRuntime({
    env: {},
    paths,
    lock,
    deps: deps({
      waitForSidecar: async () => { preflighted = true; return {}; },
      launchRuntime: async ({ readToken }) => {
        sawReadToken = typeof readToken === 'function';
        return 0;
      },
    }),
  });

  assert.equal(code, 0);
  assert.equal(sawReadToken, true, 'the local path still pairs via Keychain');
  assert.equal(preflighted, false, 'preflight is a cloud-only concern');
});

test('the cloud path preflights and never hands launchRuntime a Keychain reader', async () => {
  let preflightedEndpoint = null;
  let observed = null;

  const code = await startRuntime({
    env: CLOUD_ENV,
    paths,
    lock,
    deps: deps({
      waitForSidecar: async ({ endpoint }) => { preflightedEndpoint = endpoint; return {}; },
      readToken: async () => { throw new Error('the cloud path must never reach the Keychain'); },
      launchRuntime: async (args) => { observed = args; return 0; },
    }),
  });

  assert.equal(code, 0);
  assert.equal(preflightedEndpoint, 'http://127.0.0.1:9222');
  assert.equal(observed.config.engine, 'cdp');
  assert.equal(observed.readToken, undefined, 'no Keychain reader on the cloud path');
});

test('preflight failure propagates its exit code and never launches the runtime', async () => {
  let launched = false;
  const failure = Object.assign(new Error('sidecar down'), { exitCode: 69 });

  await assert.rejects(
    () => startRuntime({
      env: CLOUD_ENV,
      paths,
      lock,
      deps: deps({
        waitForSidecar: async () => { throw failure; },
        launchRuntime: async () => { launched = true; return 0; },
      }),
    }),
    (error) => {
      assert.equal(error.exitCode, 69);
      return true;
    },
  );

  assert.equal(launched, false);
});

test('a bad env contract fails before preflight is attempted', async () => {
  let preflighted = false;
  const contractError = Object.assign(new Error('bad engine'), { exitCode: 78 });

  await assert.rejects(
    () => startRuntime({
      env: { FAST_BROWSER_ENGINE: 'nonsense' },
      paths,
      lock,
      deps: deps({
        cloudConfig: async () => { throw contractError; },
        waitForSidecar: async () => { preflighted = true; return {}; },
      }),
    }),
    (error) => {
      assert.equal(error.exitCode, 78);
      return true;
    },
  );

  assert.equal(preflighted, false);
});

// Retention used to run only from `setup` and `configure`, so the runtime's
// output dir grew unbounded between plugin upgrades. Launch is the natural
// cadence (every agent session starts one), but the MCP handshake is
// latency-sensitive: the prune runs alongside the launch, never ahead of it.
test('the local path prunes the output dir alongside the launch, on every profile', async () => {
  let pruneArgs = null;
  let launchedWhilePruning = false;
  let releasePrune;
  const pruning = new Promise((resolve) => { releasePrune = resolve; });

  const code = await startRuntime({
    env: {},
    paths,
    lock,
    deps: deps({
      pruneSessions: async (args) => {
        pruneArgs = args;
        await pruning;
        return { removedPaths: ['/x'], removedBytes: 1 };
      },
      launchRuntime: async () => {
        launchedWhilePruning = pruneArgs !== null;
        releasePrune();
        return 0;
      },
    }),
  });

  assert.equal(code, 0);
  assert.equal(launchedWhilePruning, true, 'launch must not wait for the prune');
  assert.equal(pruneArgs.paths, paths);
  assert.equal(pruneArgs.retentionDays, 30);
  assert.ok(pruneArgs.now instanceof Date);
});

test('a failing prune is one stderr line and never changes the exit code', async () => {
  const warnings = [];
  let launched = false;

  const code = await startRuntime({
    env: {},
    paths,
    lock,
    deps: deps({
      pruneSessions: async () => { throw new Error('output root changed during validation'); },
      warn: (line) => warnings.push(line),
      launchRuntime: async () => { launched = true; return 3; },
    }),
  });

  assert.equal(code, 3);
  assert.equal(launched, true);
  assert.deepEqual(warnings, [
    'fast-browser-mcp: output retention skipped: output root changed during validation',
  ]);
});

test('the cloud path never prunes: its output dir is a pod-lifetime tmpdir', async () => {
  let pruned = false;

  await startRuntime({
    env: CLOUD_ENV,
    paths,
    lock,
    deps: deps({ pruneSessions: async () => { pruned = true; } }),
  });

  assert.equal(pruned, false);
});
