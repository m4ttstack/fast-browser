#!/usr/bin/env node
/**
 * One-time Chrome Web Store credential mint.
 *
 *   node scripts/cws-mint-token.mjs
 *
 * Prompts for the OAuth desktop client's id and secret (from the GCP
 * console, Chrome Web Store API enabled), walks the consent flow on a
 * loopback redirect, and stores all three values as keychain items that
 * scripts/publish-extension.mjs reads. The secret and token never print.
 */
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';

import { KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICES } from './publish-extension.mjs';

const execFileP = promisify(execFile);

export function buildAuthUrl(clientId, port) {
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', `http://127.0.0.1:${port}`);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'https://www.googleapis.com/auth/chromewebstore');
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  return u.toString();
}

export async function exchangeCode(fetchFn, creds, code, port) {
  const res = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: `http://127.0.0.1:${port}`,
    }).toString(),
  });
  const body = await res.json();
  if (!res.ok || !body.refresh_token) {
    throw new Error(`code exchange failed: ${body.error ?? res.status} (no refresh_token; the consent screen must run with prompt=consent)`);
  }
  return body.refresh_token;
}

async function storeSecret(service, value) {
  await execFileP('security', ['add-generic-password', '-U', '-a', KEYCHAIN_ACCOUNT, '-s', service, '-w', value]);
}

function waitForCode(server) {
  return new Promise((resolve, reject) => {
    server.on('request', (req, res) => {
      const code = new URL(req.url, 'http://127.0.0.1').searchParams.get('code');
      res.end(code ? 'Credentials minted. You can close this tab.' : 'No code in redirect.');
      if (code) resolve(code);
      else reject(new Error('redirect carried no code'));
    });
  });
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const clientId = (await rl.question('OAuth client id: ')).trim();
  const clientSecret = (await rl.question('OAuth client secret: ')).trim();
  rl.close();
  if (!clientId || !clientSecret) {
    console.error('both values are required');
    process.exit(2);
  }
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  console.log('\nOpen this URL, sign in as the store publisher, and approve:\n');
  console.log(buildAuthUrl(clientId, port) + '\n');
  const code = await waitForCode(server);
  server.close();
  const refreshToken = await exchangeCode(fetch, { clientId, clientSecret }, code, port);
  await storeSecret(KEYCHAIN_SERVICES.clientId, clientId);
  await storeSecret(KEYCHAIN_SERVICES.clientSecret, clientSecret);
  await storeSecret(KEYCHAIN_SERVICES.refreshToken, refreshToken);
  console.log('stored all three keychain items; publish-extension.mjs is ready');
}
