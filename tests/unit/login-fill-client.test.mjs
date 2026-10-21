import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { LOGIN_FILL_MAX_RESPONSE_BYTES, requestLoginFill, requestSavedLogin, rtPaths } from '../../lib/rt/login-fill-client.mjs';

const ORIGIN = 'https://login.example.com';
const NAME = 'devlogin:login.example.com:password';

// Unix socket paths cap at 104 bytes on macOS, so these live under /tmp.
async function fakeHome(t, { token = 'tok-1\n' } = {}) {
  const homeDir = await mkdtemp('/tmp/fb-lfc-');
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const rtDir = path.join(homeDir, '.mattstack', 'rt');
  await mkdir(rtDir, { recursive: true });
  if (token !== null) await writeFile(path.join(rtDir, 'api-token'), token);
  return homeDir;
}

async function fakeDaemon(t, homeDir, handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: JSON.parse(body) });
      handler(req, res, seen.at(-1).body);
    });
  });
  const { socketPath } = rtPaths({ homeDir, env: {} });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return seen;
}

function reply(res, envelope) {
  res.setHeader('content-type', 'application/json');
  res.end(typeof envelope === 'string' ? envelope : JSON.stringify(envelope));
}

const call = (homeDir, extra = {}) => requestLoginFill({
  name: NAME, frameOrigin: ORIGIN, elementKind: 'password', homeDir, env: {}, pid: 4242, ...extra,
});

test('posts the contract body to /logins:fill with the trimmed token and returns data', async (t) => {
  const homeDir = await fakeHome(t);
  const seen = await fakeDaemon(t, homeDir, (req, res) => reply(res, {
    ok: true, data: { origin: ORIGIN, kind: 'password', value: 'v' },
  }));
  const data = await call(homeDir);
  assert.deepEqual(data, { origin: ORIGIN, kind: 'password', value: 'v' });
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].url, '/logins:fill');
  assert.deepEqual(seen[0].body, {
    token: 'tok-1', client: 'fast-browser', pid: 4242, name: NAME, frameOrigin: ORIGIN, elementKind: 'password',
  });
});

test('passes a daemon refusal through unchanged', async (t) => {
  const homeDir = await fakeHome(t);
  await fakeDaemon(t, homeDir, (req, res) => reply(res, { ok: true, data: { refused: 'limited', until: 1234 } }));
  assert.deepEqual(await call(homeDir), { refused: 'limited', until: 1234 });
});

test('no token file and no socket are unavailable', async (t) => {
  const noToken = await fakeHome(t, { token: null });
  assert.deepEqual(await call(noToken), { refused: 'unavailable' });

  const noSocket = await fakeHome(t);
  assert.deepEqual(await call(noSocket), { refused: 'unavailable' });
});

test('whitespace-only token is rejected without contacting the daemon', async (t) => {
  const homeDir = await fakeHome(t, { token: '  \n' });
  const seen = await fakeDaemon(t, homeDir, (req, res) => reply(res, {
    ok: true, data: { origin: ORIGIN, kind: 'password', value: 'v' },
  }));
  const result = await call(homeDir);
  assert.deepEqual(result, { refused: 'unavailable' });
  assert.equal(seen.length, 0);
});

test('ok:false response is rejected', async (t) => {
  const homeDir = await fakeHome(t);
  await fakeDaemon(t, homeDir, (req, res) => reply(res, {
    ok: false, error: 'bad token', data: { origin: ORIGIN, kind: 'password', value: 'v' },
  }));
  assert.deepEqual(await call(homeDir), { refused: 'unavailable' });
});

test('non-JSON response is unavailable', async (t) => {
  const homeDir = await fakeHome(t);
  await fakeDaemon(t, homeDir, (req, res) => reply(res, 'not json'));
  assert.deepEqual(await call(homeDir), { refused: 'unavailable' });
});

test('a daemon that never answers resolves unavailable within the timeout', async (t) => {
  const homeDir = await fakeHome(t);
  await fakeDaemon(t, homeDir, () => {});
  const started = Date.now();
  assert.deepEqual(await call(homeDir, { timeoutMs: 200 }), { refused: 'unavailable' });
  assert.ok(Date.now() - started < 2000);
});

test('a response larger than the cap is unavailable even when it is a valid success', async (t) => {
  const homeDir = await fakeHome(t);
  await fakeDaemon(t, homeDir, (req, res) => {
    res.on('error', () => {});
    res.setHeader('content-type', 'application/json');
    const head = `{"ok":true,"data":{"origin":"${ORIGIN}","kind":"password","value":"v","pad":"`;
    res.write(head);
    const piece = 'x'.repeat(16 * 1024);
    for (let sent = 0; sent <= LOGIN_FILL_MAX_RESPONSE_BYTES; sent += piece.length) res.write(piece);
    res.end('"}}');
  });
  assert.deepEqual(await call(homeDir), { refused: 'unavailable' });
});

test('RT_DAEMON_SOCK overrides the socket path', () => {
  const { socketPath, tokenFile } = rtPaths({ homeDir: '/h', env: { RT_DAEMON_SOCK: '/tmp/x.sock' } });
  assert.equal(socketPath, '/tmp/x.sock');
  assert.equal(tokenFile, '/h/.mattstack/rt/api-token');
});

const EMAIL_NAME = 'devlogin:login.example.com:email';
const has = (homeDir, extra = {}) => requestSavedLogin({ origin: ORIGIN, homeDir, env: {}, pid: 4242, ...extra });
const named = { ok: true, data: { origin: ORIGIN, fields: { email: EMAIL_NAME, password: NAME } } };

test('requestSavedLogin posts token, client, pid and origin to /logins:has', async (t) => {
  const homeDir = await fakeHome(t);
  const seen = await fakeDaemon(t, homeDir, (req, res) => reply(res, named));
  await has(homeDir);
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].url, '/logins:has');
  assert.deepEqual(seen[0].body, { token: 'tok-1', client: 'fast-browser', pid: 4242, origin: ORIGIN });
});

test('requestSavedLogin returns fields when the daemon names a login', async (t) => {
  const homeDir = await fakeHome(t);
  await fakeDaemon(t, homeDir, (req, res) => reply(res, named));
  assert.deepEqual(await has(homeDir), { fields: { email: EMAIL_NAME, password: NAME } });
});

test('requestSavedLogin returns none when the daemon says none', async (t) => {
  const homeDir = await fakeHome(t);
  await fakeDaemon(t, homeDir, (req, res) => reply(res, { ok: true, data: { none: true } }));
  assert.deepEqual(await has(homeDir), { none: true });
});

test('requestSavedLogin: a field name that is not devlogin: is unavailable', async (t) => {
  const homeDir = await fakeHome(t);
  await fakeDaemon(t, homeDir, (req, res) => reply(res, {
    ok: true, data: { origin: ORIGIN, fields: { email: 'x', password: NAME } },
  }));
  assert.deepEqual(await has(homeDir), { refused: 'unavailable' });
});

test('requestSavedLogin: missing token file is unavailable', async (t) => {
  assert.deepEqual(await has(await fakeHome(t, { token: null })), { refused: 'unavailable' });
});

test('requestSavedLogin: socket error is unavailable', async (t) => {
  assert.deepEqual(await has(await fakeHome(t)), { refused: 'unavailable' });
});

test('requestSavedLogin: a daemon that never answers is unavailable within the timeout', async (t) => {
  const homeDir = await fakeHome(t);
  await fakeDaemon(t, homeDir, () => {});
  const started = Date.now();
  assert.deepEqual(await has(homeDir, { timeoutMs: 200 }), { refused: 'unavailable' });
  assert.ok(Date.now() - started < 2000);
});

test('requestSavedLogin: ok:false is unavailable', async (t) => {
  const homeDir = await fakeHome(t);
  await fakeDaemon(t, homeDir, (req, res) => reply(res, { ok: false, error: 'unknown command' }));
  assert.deepEqual(await has(homeDir), { refused: 'unavailable' });
});

test('requestSavedLogin: unparseable body is unavailable', async (t) => {
  const homeDir = await fakeHome(t);
  await fakeDaemon(t, homeDir, (req, res) => reply(res, 'not json'));
  assert.deepEqual(await has(homeDir), { refused: 'unavailable' });
});

test('requestSavedLogin: oversize body is unavailable', async (t) => {
  const homeDir = await fakeHome(t);
  await fakeDaemon(t, homeDir, (req, res) => {
    res.on('error', () => {});
    res.setHeader('content-type', 'application/json');
    res.write(`{"ok":true,"data":{"origin":"${ORIGIN}","fields":{"email":"${EMAIL_NAME}","password":"${NAME}"},"pad":"`);
    const piece = 'x'.repeat(16 * 1024);
    for (let sent = 0; sent <= LOGIN_FILL_MAX_RESPONSE_BYTES; sent += piece.length) res.write(piece);
    res.end('"}}');
  });
  assert.deepEqual(await has(homeDir), { refused: 'unavailable' });
});
