import assert from 'node:assert/strict';
import test from 'node:test';

import { EnvContractError, cloudConfig, isCloudInvocation } from '../../lib/core/env-config.mjs';

// The one filesystem probe is injected so these tests never touch a real disk.
function fakeFs({ readable = [] } = {}) {
  return {
    access: async (target) => {
      if (!readable.includes(target)) {
        const error = new Error(`ENOENT: ${target}`);
        error.code = 'ENOENT';
        throw error;
      }
    },
  };
}

const MINIMAL = {
  FAST_BROWSER_ENGINE: 'cdp',
  FAST_BROWSER_CDP_ENDPOINT: 'http://127.0.0.1:9222',
};

test('isCloudInvocation forks only on FAST_BROWSER_ENGINE being present', () => {
  assert.equal(isCloudInvocation({}), false);
  assert.equal(isCloudInvocation({ FAST_BROWSER_CDP_ENDPOINT: 'http://127.0.0.1:9222' }), false);
  assert.equal(isCloudInvocation({ FAST_BROWSER_ENGINE: 'cdp' }), true);
  assert.equal(isCloudInvocation({ FAST_BROWSER_ENGINE: 'nonsense' }), true);
});

test('a minimal valid contract produces a cdp config with local-only machinery disabled', async () => {
  const config = await cloudConfig(MINIMAL, fakeFs());

  assert.equal(config.engine, 'cdp');
  assert.equal(config.cdpEndpoint, 'http://127.0.0.1:9222');
  assert.equal(config.secretsFile, null);
  assert.equal(config.outputDir, null);
  assert.equal(config.debugCapture, false);
  // Trace and session recording are off in a pod unless debug capture asks
  // for them, inverting the local default.
  assert.equal(config.trace, false);
  assert.equal(config.sessions.enabled, false);
  // Defence in depth: 'manual' means launchRuntime never reaches for a
  // Keychain token even if the entrypoint branch were bypassed.
  assert.equal(config.connection.mode, 'manual');
  assert.equal(config.profile, 'safe');
});

test('FAST_BROWSER_DEBUG_CAPTURE turns traces and sessions on together', async () => {
  const config = await cloudConfig({ ...MINIMAL, FAST_BROWSER_DEBUG_CAPTURE: '1' }, fakeFs());

  assert.equal(config.debugCapture, true);
  assert.equal(config.trace, true);
  assert.equal(config.sessions.enabled, true);
});

test('an unknown engine value exits 78 rather than falling back to local', async () => {
  await assert.rejects(
    () => cloudConfig({ ...MINIMAL, FAST_BROWSER_ENGINE: 'headless' }, fakeFs()),
    (error) => {
      assert.ok(error instanceof EnvContractError);
      assert.equal(error.exitCode, 78);
      assert.match(error.message, /FAST_BROWSER_ENGINE/);
      return true;
    },
  );
});

test('a missing or unparseable cdp endpoint exits 78 and names the variable', async () => {
  for (const value of [undefined, '', 'not-a-url', 'ws://127.0.0.1:9222', 'file:///tmp']) {
    const env = { ...MINIMAL, FAST_BROWSER_CDP_ENDPOINT: value };
    if (value === undefined) delete env.FAST_BROWSER_CDP_ENDPOINT;
    await assert.rejects(
      () => cloudConfig(env, fakeFs()),
      (error) => {
        assert.equal(error.exitCode, 78);
        assert.match(error.message, /FAST_BROWSER_CDP_ENDPOINT/);
        return true;
      },
      `expected rejection for ${String(value)}`,
    );
  }
});

test('an unreadable secrets path exits 78, and a readable one is forwarded verbatim', async () => {
  await assert.rejects(
    () => cloudConfig({ ...MINIMAL, FAST_BROWSER_SECRETS: '/run/secrets/app.env' }, fakeFs()),
    (error) => {
      assert.equal(error.exitCode, 78);
      assert.match(error.message, /FAST_BROWSER_SECRETS/);
      return true;
    },
  );

  const config = await cloudConfig(
    { ...MINIMAL, FAST_BROWSER_SECRETS: '/run/secrets/app.env' },
    fakeFs({ readable: ['/run/secrets/app.env'] }),
  );
  assert.equal(config.secretsFile, '/run/secrets/app.env');
});

test('cloudConfig never reads the secrets file contents', async () => {
  let read = false;
  const fs = fakeFs({ readable: ['/run/secrets/app.env'] });
  await cloudConfig({ ...MINIMAL, FAST_BROWSER_SECRETS: '/run/secrets/app.env' }, {
    ...fs,
    readFile: async () => { read = true; return 'PASSWORD=hunter2'; },
  });
  assert.equal(read, false, 'secret values must never enter this process');
});
