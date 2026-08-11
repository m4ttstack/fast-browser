import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  EnvContractError,
  cloudConfig,
  isCdpAutolaunchEnabled,
  isCloudInvocation,
} from '../../lib/core/env-config.mjs';

// Both filesystem calls are injected so these tests never touch a real disk.
// `mkdtemp` records the prefix it was handed, so the default-output-dir tests
// can assert where a pod's scratch directory would actually be created.
function fakeFs({ readable = [], mkdtempCalls = [] } = {}) {
  return {
    access: async (target) => {
      if (!readable.includes(target)) {
        const error = new Error(`ENOENT: ${target}`);
        error.code = 'ENOENT';
        throw error;
      }
    },
    mkdtemp: async (prefix) => {
      mkdtempCalls.push(prefix);
      return `${prefix}abc123`;
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
  // A present-but-empty value (an ordinary k8s `value: ""`, or an unset
  // variable expansion) is still presence, not absence -- it must fork into
  // the cloud path and fail loudly there, never fall through to local.
  assert.equal(isCloudInvocation({ FAST_BROWSER_ENGINE: '' }), true);
});

test('a minimal valid contract produces a cdp config with local-only machinery disabled', async () => {
  const config = await cloudConfig(MINIMAL, fakeFs());

  assert.equal(config.engine, 'cdp');
  assert.equal(config.cdpEndpoint, 'http://127.0.0.1:9222');
  assert.equal(config.secretsFile, null);
  // Never null, and never paths.dataDir: see the dedicated tests below.
  assert.ok(config.outputDir, 'an unset output dir must still resolve to a real path');
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

test('FAST_BROWSER_DEBUG_CAPTURE is recognized regardless of case or spelling', async () => {
  for (const value of ['1', 'true', 'TRUE', 'True', 'yes', 'YES', ' true ']) {
    const config = await cloudConfig({ ...MINIMAL, FAST_BROWSER_DEBUG_CAPTURE: value }, fakeFs());
    assert.equal(config.debugCapture, true, `expected ${JSON.stringify(value)} to enable capture`);
    assert.equal(config.trace, true);
    assert.equal(config.sessions.enabled, true);
  }

  // Anything else stays off, which is the safe direction: a pod that records
  // nothing beats a pod that writes customer data to disk unasked.
  for (const value of ['0', 'false', 'no', '']) {
    const config = await cloudConfig({ ...MINIMAL, FAST_BROWSER_DEBUG_CAPTURE: value }, fakeFs());
    assert.equal(config.debugCapture, false, `expected ${JSON.stringify(value)} to leave capture off`);
  }
});

test('a stale FAST_BROWSER_FLOWS_DIR exits 78 instead of being silently ignored', async () => {
  // The variable was carried by an early draft and removed before
  // implementation, so a manifest written against that draft would otherwise
  // run with a flow set nobody chose, silently.
  for (const value of ['/flows', '']) {
    await assert.rejects(
      () => cloudConfig({ ...MINIMAL, FAST_BROWSER_FLOWS_DIR: value }, fakeFs()),
      (error) => {
        assert.ok(error instanceof EnvContractError);
        assert.equal(error.exitCode, 78);
        assert.match(error.message, /FAST_BROWSER_FLOWS_DIR/);
        // The message has to say where flows actually come from, or the
        // operator just sets it somewhere else.
        assert.match(error.message, /macros/);
        return true;
      },
      `expected rejection for flows dir ${JSON.stringify(value)}`,
    );
  }
});

test('an unknown FAST_BROWSER_* variable exits 78 and names the variable', async () => {
  // The cloud contract is closed: a typo like this must never be silently
  // ignored, since ignoring it is indistinguishable from the manifest author
  // believing it took effect.
  await assert.rejects(
    () => cloudConfig({ ...MINIMAL, FAST_BROWSER_TYPO: 'anything' }, fakeFs()),
    (error) => {
      assert.ok(error instanceof EnvContractError);
      assert.equal(error.exitCode, 78);
      assert.match(error.message, /FAST_BROWSER_TYPO/);
      return true;
    },
  );
});

test('every allowlisted FAST_BROWSER_* variable is accepted', async () => {
  const readableSecrets = '/run/secrets/app.env';
  const allowlisted = {
    ...MINIMAL,
    FAST_BROWSER_CDP_AUTOLAUNCH: 'true',
    FAST_BROWSER_SECRETS: readableSecrets,
    FAST_BROWSER_OUTPUT_DIR: '/mnt/scratch',
    FAST_BROWSER_DEBUG_CAPTURE: 'true',
    FAST_BROWSER_VOYAGE_API_KEY: 'voyage-key',
    FAST_BROWSER_REGISTRY_TOKEN: 'registry-token',
  };

  const config = await cloudConfig(allowlisted, fakeFs({ readable: [readableSecrets] }));
  assert.equal(config.secretsFile, readableSecrets);
  assert.equal(config.outputDir, '/mnt/scratch');
  assert.equal(config.debugCapture, true);
});

test('an empty FAST_BROWSER_SECRETS exits 78 rather than reading as no secrets', async () => {
  // Presence is presence, exactly as for FAST_BROWSER_ENGINE. Treating it as
  // absence is the dangerous reading: with no secrets file resolved, a login
  // sequence fills the secret NAME into the password field literally.
  await assert.rejects(
    () => cloudConfig({ ...MINIMAL, FAST_BROWSER_SECRETS: '' }, fakeFs()),
    (error) => {
      assert.ok(error instanceof EnvContractError);
      assert.equal(error.exitCode, 78);
      assert.match(error.message, /FAST_BROWSER_SECRETS/);
      return true;
    },
  );

  // Unset still means no secrets, which is a legitimate configuration.
  const config = await cloudConfig(MINIMAL, fakeFs());
  assert.equal(config.secretsFile, null);
});

test('an unknown or empty engine value exits 78 rather than falling back to local', async () => {
  for (const engine of ['headless', '']) {
    await assert.rejects(
      () => cloudConfig({ ...MINIMAL, FAST_BROWSER_ENGINE: engine }, fakeFs()),
      (error) => {
        assert.ok(error instanceof EnvContractError);
        assert.equal(error.exitCode, 78);
        assert.match(error.message, /FAST_BROWSER_ENGINE/);
        return true;
      },
      `expected rejection for engine=${JSON.stringify(engine)}`,
    );
  }
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

test('an unset output dir becomes a fresh tmpdir, never the home data dir', async () => {
  const mkdtempCalls = [];
  const config = await cloudConfig(MINIMAL, fakeFs({ mkdtempCalls }));

  // The pod bake does not set FAST_BROWSER_OUTPUT_DIR, and a baked $HOME can
  // be read-only. Resolving to ~/.fast-browser would defer the failure to the
  // first write instead of failing at startup, which is exactly the silent
  // late failure this contract exists to prevent.
  assert.equal(mkdtempCalls.length, 1, 'exactly one scratch directory per launch');
  assert.equal(mkdtempCalls[0], path.join(os.tmpdir(), 'fast-browser-'));
  assert.equal(config.outputDir, `${path.join(os.tmpdir(), 'fast-browser-')}abc123`);
  assert.ok(config.outputDir.startsWith(os.tmpdir()), 'must live under the system tmpdir');
  assert.ok(!config.outputDir.includes('.fast-browser/'), 'must not be the home data dir');
});

test('an explicit output dir is forwarded verbatim and creates no tmpdir', async () => {
  const mkdtempCalls = [];
  const config = await cloudConfig(
    { ...MINIMAL, FAST_BROWSER_OUTPUT_DIR: '/mnt/scratch' },
    fakeFs({ mkdtempCalls }),
  );

  assert.equal(config.outputDir, '/mnt/scratch');
  assert.deepEqual(mkdtempCalls, [], 'no scratch directory when the operator named one');
});

test('isCdpAutolaunchEnabled is recognized regardless of case or spelling, off by default', () => {
  for (const value of ['1', 'true', 'TRUE', 'True', 'yes', 'YES', ' true ']) {
    assert.equal(isCdpAutolaunchEnabled({ FAST_BROWSER_CDP_AUTOLAUNCH: value }), true, `expected ${JSON.stringify(value)} to enable autolaunch`);
  }
  for (const value of ['0', 'false', 'no', '']) {
    assert.equal(isCdpAutolaunchEnabled({ FAST_BROWSER_CDP_AUTOLAUNCH: value }), false, `expected ${JSON.stringify(value)} to leave autolaunch off`);
  }
  // Unset is the mattcloud pod contract's default: never opts in.
  assert.equal(isCdpAutolaunchEnabled({}), false);
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
