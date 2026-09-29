import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { buildContentManifestDigest } from '../../lib/core/content-manifest.mjs';
import { launchRuntime } from '../../lib/runtime/launch.mjs';
import { attachSecretsChannel } from '../../lib/runtime/secrets-channel.mjs';
import { requestLoginFill } from '../../lib/rt/login-fill-client.mjs';

const ORIGIN = 'https://login.example.com';
const CANARY = 'c@n&ary+ 100%';
const FAKE_RUNTIME_DEADLINE_MS = 5000;
const TEST_TIMEOUT_MS = 20000;

// The deadline makes an unanswered channel a bounded failure: the fake exits
// non-zero, so launchRuntime rejects instead of waiting on it forever.
const FAKE_RUNTIME = `
const net = require('node:net');
const fs = require('node:fs');
const out = process.env.FB_FAKE_RUNTIME_OUT;
const flag = process.argv.find((a) => a.startsWith('--secrets-channel-fd='));
if (!flag) { fs.writeFileSync(out, JSON.stringify({ noChannel: true })); process.exit(0); }
const socket = new net.Socket({ fd: Number(flag.split('=')[1]), readable: true, writable: true });
const requests = JSON.parse(process.env.FB_FAKE_RUNTIME_REQUESTS);
const replies = [];
setTimeout(() => {
  fs.writeFileSync(out, JSON.stringify({ timedOut: true, replies }));
  process.exit(3);
}, ${FAKE_RUNTIME_DEADLINE_MS});
let buffer = '';
socket.setEncoding('utf8');
socket.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\\n')) !== -1) {
    replies.push(JSON.parse(buffer.slice(0, i)));
    buffer = buffer.slice(i + 1);
  }
  if (replies.length === requests.length) {
    fs.writeFileSync(out, JSON.stringify({ replies }));
    process.exit(0);
  }
});
for (const r of requests) socket.write(JSON.stringify(r) + '\\n');
`;

function fixtureLock() {
  return {
    schemaVersion: 1,
    productVersion: '0.1.0-alpha.1',
    sourceCommit: '0123456789abcdef',
    protocolVersion: 2,
    runtime: { url: 'http://127.0.0.1:1/r.tgz', file: 'r.tgz', sha256: 'a'.repeat(64), node: '>=20' },
    extension: {
      url: 'http://127.0.0.1:1/e.zip', file: 'e.zip', sha256: 'b'.repeat(64),
      id: 'abcdefghijklmnopabcdefghijklmnop', version: '0.2.1',
    },
  };
}

function identity(lock) {
  return {
    schemaVersion: lock.schemaVersion,
    productVersion: lock.productVersion,
    sourceCommit: lock.sourceCommit,
    protocolVersion: lock.protocolVersion,
    runtime: { file: lock.runtime.file, sha256: lock.runtime.sha256, node: lock.runtime.node },
    extension: {
      file: lock.extension.file, sha256: lock.extension.sha256,
      id: lock.extension.id, version: lock.extension.version,
    },
  };
}

function withFakeRuntimeEnv(t, out, requests) {
  process.env.FB_FAKE_RUNTIME_OUT = out;
  process.env.FB_FAKE_RUNTIME_REQUESTS = JSON.stringify(requests);
  t.after(() => {
    delete process.env.FB_FAKE_RUNTIME_OUT;
    delete process.env.FB_FAKE_RUNTIME_REQUESTS;
  });
}

// A short root under /tmp keeps the daemon's unix socket path inside the
// platform's sun_path limit, which os.tmpdir() on macOS can exceed.
async function setup(t) {
  const root = await mkdtemp('/tmp/fb-sci-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, 'home');
  const dataDir = path.join(homeDir, '.fast-browser');
  const paths = { homeDir, dataDir, runtimeDir: path.join(dataDir, 'runtime'), outputDir: path.join(dataDir, 'output') };
  const lock = fixtureLock();
  const cli = path.join(paths.runtimeDir, lock.productVersion, 'fast-browser-mcp', 'cli.cjs');
  await mkdir(path.dirname(cli), { recursive: true });
  await writeFile(cli, FAKE_RUNTIME);
  const contentDigest = await buildContentManifestDigest(path.dirname(cli));
  await writeFile(
    path.join(paths.runtimeDir, lock.productVersion, 'installed.json'),
    JSON.stringify({ schemaVersion: 1, lock: identity(lock), contentDigest }),
  );
  const rtDir = path.join(homeDir, '.mattstack', 'rt');
  await mkdir(rtDir, { recursive: true });
  await writeFile(path.join(rtDir, 'api-token'), 'tok-1\n');

  const seen = [];
  const daemon = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const payload = JSON.parse(body);
      seen.push(payload);
      const data = payload.frameOrigin === ORIGIN
        ? { origin: ORIGIN, kind: payload.name.endsWith(':email') ? 'email' : 'password', value: CANARY }
        : { refused: 'mismatch' };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, data }));
    });
  });
  const socketPath = path.join(rtDir, 'rt.sock');
  await new Promise((resolve) => daemon.listen(socketPath, resolve));
  t.after(() => new Promise((resolve) => daemon.close(resolve)));

  const out = path.join(root, 'runtime-out.json');
  return { root, homeDir, paths, lock, out, seen };
}

async function filesUnder(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) found.push(path.join(entry.parentPath ?? entry.path, entry.name));
  }
  return found;
}

test('the real launcher relays runtime requests to the daemon and back, leaving no value on disk', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { homeDir, paths, lock, out, seen } = await setup(t);
  withFakeRuntimeEnv(t, out, [
    { id: 'e', name: 'devlogin:login.example.com:email', frameOrigin: ORIGIN, elementKind: 'text' },
    { id: 'p', name: 'devlogin:login.example.com:password', frameOrigin: ORIGIN, elementKind: 'password' },
    { id: 'x', name: 'devlogin:login.example.com:password', frameOrigin: 'https://login.example.com.evil.test', elementKind: 'password' },
  ]);
  const logged = [];
  const secretsChannel = {
    attach: (socket) => attachSecretsChannel({
      socket,
      fetchFill: (request) => requestLoginFill({ ...request, homeDir, env: {} }),
      log: (line) => logged.push(line),
    }),
  };

  const code = await launchRuntime({
    config: { profile: 'safe', connection: { mode: 'manual' }, sessions: { enabled: false } },
    paths,
    lock,
    secretsChannel,
  });

  assert.equal(code, 0);
  const { replies } = JSON.parse(await readFile(out, 'utf8'));
  const byId = Object.fromEntries(replies.map((r) => [r.id, r]));
  assert.equal(byId.e.value, CANARY);
  assert.equal(byId.p.value, CANARY);
  assert.equal(byId.x.refused, 'mismatch');
  assert.equal(seen.length, 3);
  assert.ok(seen.every((payload) => payload.token === 'tok-1' && payload.client === 'fast-browser'));
  for (const file of await filesUnder(homeDir)) {
    if (file.endsWith('rt.sock')) continue;
    assert.ok(!(await readFile(file, 'utf8')).includes(CANARY), `value written to ${file}`);
  }
  for (const line of logged) assert.ok(!line.includes(CANARY));
});

test('with no rt token every request is unavailable and the runtime still runs', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { homeDir, paths, lock, out } = await setup(t);
  await rm(path.join(homeDir, '.mattstack', 'rt', 'api-token'));
  withFakeRuntimeEnv(t, out, [
    { id: 'p', name: 'devlogin:login.example.com:password', frameOrigin: ORIGIN, elementKind: 'password' },
  ]);
  const code = await launchRuntime({
    config: { profile: 'safe', connection: { mode: 'manual' }, sessions: { enabled: false } },
    paths,
    lock,
    secretsChannel: {
      attach: (socket) => attachSecretsChannel({
        socket, fetchFill: (request) => requestLoginFill({ ...request, homeDir, env: {} }),
      }),
    },
  });
  assert.equal(code, 0);
  const { replies } = JSON.parse(await readFile(out, 'utf8'));
  assert.deepEqual(replies, [{ id: 'p', name: 'devlogin:login.example.com:password', refused: 'unavailable' }]);
});
