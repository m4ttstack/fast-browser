import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
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

test('the local path hands launchRuntime a secrets channel', async () => {
  let channel;
  await startRuntime({
    env: {},
    paths: { ...paths, homeDir: '/synthetic-home' },
    lock,
    deps: deps({ launchRuntime: async (args) => { channel = args.secretsChannel; return 0; } }),
  });
  assert.equal(typeof channel?.attach, 'function');
});

test('the cloud path never gets a secrets channel', async () => {
  let sawKey = true;
  await startRuntime({
    env: CLOUD_ENV,
    paths,
    lock,
    deps: deps({ launchRuntime: async (args) => { sawKey = 'secretsChannel' in args; return 0; } }),
  });
  assert.equal(sawKey, false);
});

const LOGIN = 'https://login.example.com';
const PASSWORD_NAME = 'devlogin:login.example.com:password';

// A short root under /tmp keeps the daemon's unix socket path inside the
// platform's sun_path limit, which os.tmpdir() on macOS can exceed.
async function fakeRtHome(t, { daemonSocket } = {}) {
  const root = await mkdtemp('/tmp/fb-entry-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, 'home');
  const rtDir = path.join(homeDir, '.mattstack', 'rt');
  await mkdir(rtDir, { recursive: true });
  await writeFile(path.join(rtDir, 'api-token'), 'tok-entry\n');
  const seen = [];
  const daemon = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push(JSON.parse(body));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, data: { origin: LOGIN, kind: 'password', value: 'pw-from-fake-rt' } }));
    });
  });
  await new Promise((resolve) => daemon.listen(daemonSocket?.(root) ?? path.join(rtDir, 'rt.sock'), resolve));
  t.after(() => new Promise((resolve) => daemon.close(resolve)));
  return { root, homeDir, seen };
}

async function roundTripThroughDefaultChannel(t, { root, homeDir, env, lines }) {
  let channel;
  const warned = [];
  await startRuntime({
    env,
    paths: { ...paths, homeDir },
    lock,
    deps: deps({
      warn: (line) => warned.push(line),
      launchRuntime: async (args) => { channel = args.secretsChannel; return 0; },
    }),
  });
  const pairPath = path.join(root, 'pair.sock');
  const server = net.createServer((socket) => channel.attach(socket));
  await new Promise((resolve) => server.listen(pairPath, resolve));
  const runtime = net.connect(pairPath);
  t.after(() => { runtime.destroy(); server.close(); });
  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no reply from the default secrets channel')), 5000);
    let buffer = '';
    runtime.setEncoding('utf8');
    runtime.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      clearTimeout(timer);
      resolve(JSON.parse(buffer.slice(0, newline)));
    });
    for (const line of lines) runtime.write(`${line}\n`);
  });
  return { reply, warned };
}

const fillLine = JSON.stringify({ id: 'p', name: PASSWORD_NAME, frameOrigin: LOGIN, elementKind: 'password' });

test('the default secrets channel relays a fill to the rt daemon under paths.homeDir and logs through warn', async (t) => {
  const { root, homeDir, seen } = await fakeRtHome(t);
  const { reply, warned } = await roundTripThroughDefaultChannel(t, {
    root, homeDir, env: {}, lines: ['not json', fillLine],
  });
  assert.deepEqual(reply, { id: 'p', name: PASSWORD_NAME, origin: LOGIN, kind: 'password', value: 'pw-from-fake-rt' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].token, 'tok-entry');
  assert.deepEqual(warned, ['fast-browser-mcp: secrets channel ignored an unparseable frame']);
});

test('the default secrets channel reaches the daemon through RT_DAEMON_SOCK from the launch env', async (t) => {
  const { root, homeDir, seen } = await fakeRtHome(t, { daemonSocket: (dir) => path.join(dir, 'alt.sock') });
  const { reply } = await roundTripThroughDefaultChannel(t, {
    root, homeDir, env: { RT_DAEMON_SOCK: path.join(root, 'alt.sock') }, lines: [fillLine],
  });
  assert.equal(reply.value, 'pw-from-fake-rt');
  assert.equal(seen.length, 1);
});
