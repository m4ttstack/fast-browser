import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';

import {
  attachSecretsChannel,
  createSavedLoginLookup,
  replyTo,
  SAVED_LOGIN_TTL_MS,
} from '../../lib/runtime/secrets-channel.mjs';

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

const FIELDS = { email: 'devlogin:login.example.com:email', password: 'devlogin:login.example.com:password' };
const savedLoginRequest = (overrides = {}) => ({ id: 's1', type: 'saved-login', origin: ORIGIN, ...overrides });
const noFill = async () => { throw new Error('the fill path must not run'); };
const lookupOver = (fetchSavedLogin, options = {}) => createSavedLoginLookup({ fetchSavedLogin, ...options });

test('a saved-login request with fields replies { id, type, origin, fields }', async () => {
  const lookup = lookupOver(async () => ({ fields: FIELDS }));
  assert.deepEqual(await replyTo(savedLoginRequest(), noFill, lookup), {
    id: 's1', type: 'saved-login', origin: ORIGIN, fields: FIELDS,
  });
});

test('none and unavailable both reply { id, type, origin, none: true }', async () => {
  const expected = { id: 's1', type: 'saved-login', origin: ORIGIN, none: true };
  assert.deepEqual(await replyTo(savedLoginRequest(), noFill, lookupOver(async () => ({ none: true }))), expected);
  assert.deepEqual(
    await replyTo(savedLoginRequest(), noFill, lookupOver(async () => ({ refused: 'unavailable' }))),
    expected,
  );
  assert.deepEqual(
    await replyTo(savedLoginRequest(), noFill, lookupOver(async () => { throw new Error('boom'); })),
    expected,
  );
});

test('a saved-login request with a non-origin is none and never calls fetch', async () => {
  let calls = 0;
  const lookup = lookupOver(async () => { calls += 1; return { fields: FIELDS }; });
  for (const origin of ['https://a.example.com/x', 'about:blank', 'ftp://a.example.com', 42, undefined]) {
    assert.deepEqual(
      await replyTo(savedLoginRequest({ origin }), noFill, lookup),
      { id: 's1', type: 'saved-login', origin, none: true },
    );
  }
  assert.equal(calls, 0);
});

test('a saved-login request with no id is dropped', async () => {
  assert.equal(await replyTo({ type: 'saved-login', origin: ORIGIN }, noFill, lookupOver(async () => ({ none: true }))), null);
});

test('lookup caches fields and none for ttlMs, and refetches after', async () => {
  let clock = 1000;
  const answers = [{ fields: FIELDS }, { none: true }, { fields: FIELDS }];
  const seen = [];
  const lookup = lookupOver(async (origin) => { seen.push(origin); return answers.shift(); }, {
    now: () => clock, ttlMs: 500,
  });
  assert.deepEqual(await lookup(ORIGIN), { fields: FIELDS });
  clock += 499;
  assert.deepEqual(await lookup(ORIGIN), { fields: FIELDS });
  assert.equal(seen.length, 1);
  clock += 1;
  assert.deepEqual(await lookup(ORIGIN), { none: true });
  assert.equal(seen.length, 2);
  clock += 499;
  assert.deepEqual(await lookup(ORIGIN), { none: true });
  assert.equal(seen.length, 2);
  clock += 1;
  assert.deepEqual(await lookup(ORIGIN), { fields: FIELDS });
  assert.equal(seen.length, 3);
});

test('lookup keeps one cache entry per origin', async () => {
  const seen = [];
  const lookup = lookupOver(async (origin) => { seen.push(origin); return { none: true }; });
  await lookup(ORIGIN);
  await lookup('https://other.example.com');
  await lookup(ORIGIN);
  assert.deepEqual(seen, [ORIGIN, 'https://other.example.com']);
});

test('the default ttl is thirty seconds', () => {
  assert.equal(SAVED_LOGIN_TTL_MS, 30_000);
});

test('lookup never caches unavailable', async () => {
  const answers = [{ refused: 'unavailable' }, { fields: FIELDS }];
  let calls = 0;
  const lookup = lookupOver(async () => { calls += 1; return answers.shift(); });
  assert.deepEqual(await lookup(ORIGIN), { none: true });
  assert.deepEqual(await lookup(ORIGIN), { fields: FIELDS });
  assert.equal(calls, 2);
});

test('lookup never caches a malformed answer', async () => {
  const answers = [{ fields: { email: 'x' } }, null, { fields: FIELDS }];
  let calls = 0;
  const lookup = lookupOver(async () => { calls += 1; return answers.shift(); });
  assert.deepEqual(await lookup(ORIGIN), { none: true });
  assert.deepEqual(await lookup(ORIGIN), { none: true });
  assert.deepEqual(await lookup(ORIGIN), { fields: FIELDS });
  assert.equal(calls, 3);
});

test('concurrent lookups of one origin share one fetch, and its answer lands in the cache even when the caller stopped waiting', async () => {
  let release;
  let calls = 0;
  const lookup = lookupOver(() => {
    calls += 1;
    return new Promise((resolve) => { release = resolve; });
  });
  const first = lookup(ORIGIN);
  const second = lookup(ORIGIN);
  assert.equal(calls, 1);
  const abandoned = await Promise.race([first, new Promise((r) => setTimeout(() => r('gave up'), 20))]);
  assert.equal(abandoned, 'gave up');
  release({ fields: FIELDS });
  assert.deepEqual(await second, { fields: FIELDS });
  assert.deepEqual(await first, { fields: FIELDS });
  assert.deepEqual(await lookup(ORIGIN), { fields: FIELDS });
  assert.equal(calls, 1);
});

test('a fetch that never settles frees the origin after the deadline', async () => {
  const timers = [];
  const cleared = [];
  const setTimer = (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; };
  const clearTimer = (timer) => { cleared.push(timer); };
  let calls = 0;
  const lookup = lookupOver(() => {
    calls += 1;
    return calls === 1 ? new Promise(() => {}) : Promise.resolve({ fields: FIELDS });
  }, { setTimer, clearTimer, deadlineMs: 1600 });

  const stuck = lookup(ORIGIN);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 1600);
  assert.equal(calls, 1);
  void lookup(ORIGIN);
  assert.equal(calls, 1, 'a second caller still shares the stuck fetch');

  timers[0].fn();
  assert.deepEqual(await stuck, { none: true });

  assert.deepEqual(await lookup(ORIGIN), { fields: FIELDS });
  assert.equal(calls, 2);
  assert.ok(cleared.includes(timers[1]), 'a fetch that settles clears its deadline timer');
});

test('an answer that arrives after the deadline is not cached', async () => {
  const timers = [];
  let release;
  let calls = 0;
  const lookup = lookupOver(() => {
    calls += 1;
    return new Promise((resolve) => { release = resolve; });
  }, { setTimer: (fn) => { timers.push(fn); return {}; }, clearTimer: () => {} });
  const stuck = lookup(ORIGIN);
  timers[0]();
  await stuck;
  release({ fields: FIELDS });
  const again = lookup(ORIGIN);
  assert.equal(calls, 2);
  release({ none: true });
  assert.deepEqual(await again, { none: true });
});

test('the deadline timer is unreffed so it cannot keep the process alive', async () => {
  let unrefs = 0;
  const lookup = lookupOver(async () => ({ none: true }), {
    setTimer: () => ({ unref: () => { unrefs += 1; } }),
    clearTimer: () => {},
  });
  await lookup(ORIGIN);
  assert.equal(unrefs, 1);
});

test('a fill request without type still takes the fill path', async () => {
  let lookups = 0;
  const lookup = async () => { lookups += 1; return { none: true }; };
  assert.deepEqual(await replyTo(request(), granted(), lookup), {
    id: 'r1', name: PASSWORD, origin: ORIGIN, kind: 'password', value: CANARY,
  });
  assert.equal(lookups, 0);
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
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(replies.length, 2);
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

test('a runtime that exits mid-call drops the late answer without an uncaught error', async (t) => {
  const dir = await mkdtemp('/tmp/fb-sc-');
  const socketPath = path.join(dir, 's.sock');
  let release;
  const fetchFill = () => new Promise((resolve) => { release = resolve; });
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    attachSecretsChannel({ socket, fetchFill });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const uncaught = [];
  const capture = (error) => uncaught.push(error);
  process.on('uncaughtException', capture);
  t.after(async () => {
    process.off('uncaughtException', capture);
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const runtime = net.connect(socketPath);
  await new Promise((resolve) => runtime.once('connect', resolve));
  runtime.write(`${JSON.stringify(request())}\n`);
  await until(() => typeof release === 'function');
  runtime.destroy();
  await new Promise((r) => setTimeout(r, 30));
  release({ origin: ORIGIN, kind: 'password', value: CANARY });
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(uncaught.map((e) => e.code ?? e.message), []);
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
