import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';

import { attachSecretsChannel, replyTo } from '../../lib/runtime/secrets-channel.mjs';

const ORIGIN = 'https://login.example.com';
const PASSWORD = 'devlogin:login.example.com:password';
const EMAIL = 'devlogin:login.example.com:email';
const CANARY = 'c@n&ary+ 100%';

const request = (overrides = {}) => ({
  id: 'r1', name: PASSWORD, frameOrigin: ORIGIN, elementKind: 'password', ...overrides,
});
const granted = (kind = 'password', origin = ORIGIN) => async () => ({ origin, kind, value: CANARY });

test('a granted fill replies with id, name, origin, kind and value', async () => {
  assert.deepEqual(await replyTo(request(), granted()), {
    id: 'r1', name: PASSWORD, origin: ORIGIN, kind: 'password', value: CANARY,
  });
});

test('daemon refusals pass through with until; unknown refusal words become unavailable', async () => {
  assert.deepEqual(
    await replyTo(request(), async () => ({ refused: 'limited', until: 99 })),
    { id: 'r1', name: PASSWORD, refused: 'limited', until: 99 },
  );
  assert.deepEqual(
    await replyTo(request(), async () => ({ refused: 'surprise' })),
    { id: 'r1', name: PASSWORD, refused: 'unavailable' },
  );
});

test('the launcher refuses a value whose origin, kind or element does not match the request', async () => {
  const wrongOrigin = await replyTo(request(), granted('password', 'https://login.example.com.evil.test'));
  assert.deepEqual(wrongOrigin, { id: 'r1', name: PASSWORD, refused: 'mismatch' });

  const wrongKind = await replyTo(request(), granted('email'));
  assert.deepEqual(wrongKind, { id: 'r1', name: PASSWORD, refused: 'mismatch' });

  const passwordIntoText = await replyTo(request({ elementKind: 'text' }), granted('password'));
  assert.deepEqual(passwordIntoText, { id: 'r1', name: PASSWORD, refused: 'mismatch' });
});

test('a non-devlogin name is unknown and never reaches the daemon', async () => {
  let calls = 0;
  const reply = await replyTo(request({ name: 'APP_PASSWORD' }), async () => { calls += 1; return {}; });
  assert.deepEqual(reply, { id: 'r1', name: 'APP_PASSWORD', refused: 'unknown' });
  assert.equal(calls, 0);
});

test('malformed requests: no id is dropped, bad fields are unavailable, a throwing fetch is unavailable', async () => {
  assert.equal(await replyTo({ name: PASSWORD }, granted()), null);
  assert.deepEqual(
    await replyTo(request({ elementKind: 'checkbox' }), granted()),
    { id: 'r1', name: PASSWORD, refused: 'unavailable' },
  );
  assert.deepEqual(
    await replyTo(request({ frameOrigin: 'https://login.example.com/path' }), granted()),
    { id: 'r1', name: PASSWORD, refused: 'unavailable' },
  );
  assert.deepEqual(
    await replyTo(request(), async () => { throw new Error('boom'); }),
    { id: 'r1', name: PASSWORD, refused: 'unavailable' },
  );
});

// A real unix socket pair: `attachSecretsChannel` gets the server side, the
// test plays the runtime on the client side.
async function channelPair(t, { fetchFill, log }) {
  const dir = await mkdtemp('/tmp/fb-sc-');
  const socketPath = path.join(dir, 's.sock');
  const accepted = new Promise((resolve) => {
    const server = net.createServer((socket) => {
      attachSecretsChannel({ socket, fetchFill, log });
      resolve(socket);
    });
    server.listen(socketPath);
    t.after(async () => {
      server.close();
      await rm(dir, { recursive: true, force: true });
    });
  });
  const runtime = net.connect(socketPath);
  const relaySide = await accepted;
  const replies = [];
  let buffer = '';
  runtime.setEncoding('utf8');
  runtime.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      replies.push(JSON.parse(buffer.slice(0, newline)));
      buffer = buffer.slice(newline + 1);
    }
  });
  t.after(() => runtime.destroy());
  return { runtime, relaySide, replies };
}

const until = async (predicate) => {
  for (let i = 0; i < 200 && !predicate(); i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.ok(predicate(), 'condition not reached in time');
};

test('frames split across chunks and several frames in one chunk are each answered once', async (t) => {
  const { runtime, replies } = await channelPair(t, { fetchFill: granted('email') });
  const a = JSON.stringify(request({ id: 'a', name: EMAIL, elementKind: 'text' }));
  const b = JSON.stringify(request({ id: 'b', name: EMAIL, elementKind: 'text' }));
  runtime.write(a.slice(0, 10));
  runtime.write(`${a.slice(10)}\n${b}\n`);
  await until(() => replies.length === 2);
  assert.deepEqual(replies.map((r) => r.id).sort(), ['a', 'b']);
});

test('concurrent requests answered out of order keep their own id and name', async (t) => {
  const fetchFill = async (req) => {
    if (req.name === PASSWORD) await new Promise((r) => setTimeout(r, 100));
    return { origin: ORIGIN, kind: req.name.endsWith(':email') ? 'email' : 'password', value: `${req.name}-v` };
  };
  const { runtime, replies } = await channelPair(t, { fetchFill });
  runtime.write(`${JSON.stringify(request({ id: 'slow' }))}\n`);
  runtime.write(`${JSON.stringify(request({ id: 'fast', name: EMAIL, elementKind: 'text' }))}\n`);
  await until(() => replies.length === 2);
  assert.equal(replies[0].id, 'fast');
  assert.equal(replies[0].name, EMAIL);
  assert.equal(replies[1].id, 'slow');
  assert.equal(replies[1].name, PASSWORD);
});

test('a runtime that exits mid-call drops the late answer without throwing', async (t) => {
  let release;
  const fetchFill = () => new Promise((resolve) => { release = resolve; });
  const { runtime, relaySide } = await channelPair(t, { fetchFill });
  runtime.write(`${JSON.stringify(request())}\n`);
  await until(() => typeof release === 'function');
  runtime.destroy();
  await until(() => relaySide.destroyed);
  release({ origin: ORIGIN, kind: 'password', value: CANARY });
  await new Promise((r) => setTimeout(r, 50));
});

test('no log line ever carries a value, and unparseable frames are logged without their content', async (t) => {
  const lines = [];
  const { runtime, replies } = await channelPair(t, { fetchFill: granted(), log: (line) => lines.push(line) });
  runtime.write(`not json ${CANARY}\n`);
  runtime.write(`${JSON.stringify(request())}\n`);
  await until(() => replies.length === 1);
  assert.ok(lines.length >= 1);
  for (const line of lines) assert.ok(!line.includes(CANARY), `log leaked the canary: ${line}`);
});
