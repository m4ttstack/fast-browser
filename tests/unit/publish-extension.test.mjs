import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  refreshAccessToken,
  uploadPackage,
  publishItem,
  manifestVersionFromZip,
  assertLockCoherence,
  runPublish,
  KEYCHAIN_SERVICES,
} from '../../scripts/publish-extension.mjs';

const CREDS = { clientId: 'id-1', clientSecret: 'sec-1', refreshToken: 'ref-1' };
const ITEM_ID = 'fnfikoifhimpdedpdepehibjjkcfbacm';

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    for (const [match, reply] of routes) {
      if (url.includes(match)) return reply(url, init);
    }
    throw new Error(`unrouted fetch: ${url}`);
  };
  fn.calls = calls;
  return fn;
}

const okJson = (body) => () => ({ ok: true, status: 200, json: async () => body });

test('refreshAccessToken posts the refresh grant and returns the access token', async () => {
  const fetchFn = fakeFetch([['oauth2.googleapis.com/token', okJson({ access_token: 'at-9', expires_in: 3599 })]]);
  const token = await refreshAccessToken(fetchFn, CREDS);
  assert.equal(token, 'at-9');
  const call = fetchFn.calls[0];
  assert.equal(call.init.method, 'POST');
  const params = new URLSearchParams(call.init.body);
  assert.equal(params.get('grant_type'), 'refresh_token');
  assert.equal(params.get('client_id'), 'id-1');
  assert.equal(params.get('refresh_token'), 'ref-1');
});

test('refreshAccessToken surfaces an OAuth denial as a named error', async () => {
  const fetchFn = fakeFetch([
    ['oauth2.googleapis.com/token', () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) })],
  ]);
  await assert.rejects(() => refreshAccessToken(fetchFn, CREDS), /invalid_grant/);
});

test('uploadPackage PUTs the zip bytes with the bearer token and accepts SUCCESS', async () => {
  const fetchFn = fakeFetch([
    [`upload/chromewebstore/v1.1/items/${ITEM_ID}`, okJson({ uploadState: 'SUCCESS' })],
  ]);
  await uploadPackage(fetchFn, 'at-9', ITEM_ID, Buffer.from('zipbytes'));
  const call = fetchFn.calls[0];
  assert.equal(call.init.method, 'PUT');
  assert.equal(call.init.headers.Authorization, 'Bearer at-9');
  assert.ok(Buffer.isBuffer(call.init.body));
});

test('uploadPackage rejects on FAILURE, quoting the item error verbatim', async () => {
  const fetchFn = fakeFetch([
    [
      `upload/chromewebstore/v1.1/items/${ITEM_ID}`,
      okJson({ uploadState: 'FAILURE', itemError: [{ error_detail: 'manifest version downgrade' }] }),
    ],
  ]);
  await assert.rejects(() => uploadPackage(fetchFn, 'at-9', ITEM_ID, Buffer.from('z')), /manifest version downgrade/);
});

test('publishItem POSTs publish and accepts OK, and never runs under dryRun via runPublish', async () => {
  const fetchFn = fakeFetch([[`items/${ITEM_ID}/publish`, okJson({ status: ['OK'] })]]);
  await publishItem(fetchFn, 'at-9', ITEM_ID);
  assert.equal(fetchFn.calls[0].init.method, 'POST');
});

test('manifestVersionFromZip reads the manifest through the injected exec seam', async () => {
  const execCalls = [];
  const execFn = async (argv) => {
    execCalls.push(argv);
    return { code: 0, stdout: JSON.stringify({ version: '0.2.12' }), stderr: '' };
  };
  const v = await manifestVersionFromZip(execFn, '/tmp/ext.zip');
  assert.equal(v, '0.2.12');
  assert.deepEqual(execCalls[0].slice(0, 2), ['unzip', '-p']);
});

test('assertLockCoherence refuses a zip whose manifest version differs from runtime-lock', () => {
  const lock = { extension: { id: ITEM_ID, version: '0.2.12' } };
  assertLockCoherence(lock, '0.2.12');
  assert.throws(() => assertLockCoherence(lock, '0.2.13'), /runtime-lock/);
});

test('runPublish dry run: uploads nothing, publishes nothing, reports the plan', async () => {
  const fetchFn = fakeFetch([['oauth2.googleapis.com/token', okJson({ access_token: 'at-9' })]]);
  const out = [];
  const res = await runPublish({
    fetchFn,
    execFn: async () => ({ code: 0, stdout: JSON.stringify({ version: '0.2.12' }), stderr: '' }),
    readSecret: async (service) => ({ [KEYCHAIN_SERVICES.clientId]: 'id-1', [KEYCHAIN_SERVICES.clientSecret]: 'sec-1', [KEYCHAIN_SERVICES.refreshToken]: 'ref-1' })[service],
    readFile: async () => Buffer.from('zipbytes'),
    readLock: async () => ({ extension: { id: ITEM_ID, version: '0.2.12' } }),
    zipPath: '/tmp/ext.zip',
    dryRun: true,
    out: (s) => out.push(s),
  });
  assert.equal(res, 0);
  assert.equal(fetchFn.calls.filter((c) => c.url.includes('items/')).length, 0);
  assert.ok(out.join('\n').includes('0.2.12'));
});

test('runPublish full run: token, upload, publish, in that order', async () => {
  const fetchFn = fakeFetch([
    ['oauth2.googleapis.com/token', okJson({ access_token: 'at-9' })],
    [`upload/chromewebstore/v1.1/items/${ITEM_ID}`, okJson({ uploadState: 'SUCCESS' })],
    [`items/${ITEM_ID}/publish`, okJson({ status: ['OK'] })],
  ]);
  const res = await runPublish({
    fetchFn,
    execFn: async () => ({ code: 0, stdout: JSON.stringify({ version: '0.2.12' }), stderr: '' }),
    readSecret: async (service) => ({ [KEYCHAIN_SERVICES.clientId]: 'id-1', [KEYCHAIN_SERVICES.clientSecret]: 'sec-1', [KEYCHAIN_SERVICES.refreshToken]: 'ref-1' })[service],
    readFile: async () => Buffer.from('zipbytes'),
    readLock: async () => ({ extension: { id: ITEM_ID, version: '0.2.12' } }),
    zipPath: '/tmp/ext.zip',
    dryRun: false,
    out: () => {},
  });
  assert.equal(res, 0);
  const urls = fetchFn.calls.map((c) => c.url);
  assert.ok(urls[0].includes('oauth2'));
  assert.ok(urls[1].includes('upload/chromewebstore'));
  assert.ok(urls[2].includes('/publish'));
});

test('runPublish refuses to publish when a keychain credential is missing', async () => {
  const res = await runPublish({
    fetchFn: fakeFetch([]),
    execFn: async () => ({ code: 0, stdout: JSON.stringify({ version: '0.2.12' }), stderr: '' }),
    readSecret: async () => null,
    readFile: async () => Buffer.from('z'),
    readLock: async () => ({ extension: { id: ITEM_ID, version: '0.2.12' } }),
    zipPath: '/tmp/ext.zip',
    dryRun: false,
    out: () => {},
    err: () => {},
  });
  assert.equal(res, 1);
});

// ── cws-mint-token ──────────────────────────────────────────────────────────

test('buildAuthUrl asks for the chromewebstore scope with offline consent on the loopback redirect', async () => {
  const { buildAuthUrl } = await import('../../scripts/cws-mint-token.mjs');
  const url = new URL(buildAuthUrl('id-1', 41739));
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('client_id'), 'id-1');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:41739');
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/chromewebstore');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
});

test('exchangeCode posts the authorization grant and returns the refresh token', async () => {
  const { exchangeCode } = await import('../../scripts/cws-mint-token.mjs');
  const fetchFn = fakeFetch([['oauth2.googleapis.com/token', okJson({ refresh_token: 'ref-9', access_token: 'at' })]]);
  const refresh = await exchangeCode(fetchFn, { clientId: 'id-1', clientSecret: 'sec-1' }, 'code-7', 41739);
  assert.equal(refresh, 'ref-9');
  const params = new URLSearchParams(fetchFn.calls[0].init.body);
  assert.equal(params.get('grant_type'), 'authorization_code');
  assert.equal(params.get('code'), 'code-7');
  assert.equal(params.get('redirect_uri'), 'http://127.0.0.1:41739');
});
