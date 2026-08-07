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
    loadConfig: async () => ({ profile: 'safe', trace: false, connection: { mode: 'auto' } }),
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
