#!/usr/bin/env node
/**
 * Publish the Fast Browser extension to the Chrome Web Store.
 *
 *   node scripts/publish-extension.mjs <store-zip> [--dry-run]
 *
 * Credentials come from the macOS keychain (three generic-password items,
 * see KEYCHAIN_SERVICES; mint them once with scripts/cws-mint-token.mjs).
 * The zip's manifest version must match runtime-lock.json's extension
 * version: that file's pin-runtime flow owns the lock, this script only
 * refuses to publish a package the lock does not describe.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export const KEYCHAIN_SERVICES = {
  clientId: 'fast-browser-cws-client-id',
  clientSecret: 'fast-browser-cws-client-secret',
  refreshToken: 'fast-browser-cws-refresh-token',
};
export const KEYCHAIN_ACCOUNT = 'mattstack';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com';

export async function refreshAccessToken(fetchFn, creds) {
  const res = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) {
    throw new Error(`token refresh failed: ${body.error ?? res.status}`);
  }
  return body.access_token;
}

export async function uploadPackage(fetchFn, accessToken, itemId, zipBytes) {
  const res = await fetchFn(`${API}/upload/chromewebstore/v1.1/items/${itemId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'x-goog-api-version': '2' },
    body: zipBytes,
  });
  const body = await res.json();
  if (!res.ok || body.uploadState !== 'SUCCESS') {
    const detail = (body.itemError ?? []).map((e) => e.error_detail).join('; ');
    throw new Error(`upload failed (${body.uploadState ?? res.status}): ${detail || 'no detail'}`);
  }
}

export async function publishItem(fetchFn, accessToken, itemId) {
  const res = await fetchFn(`${API}/chromewebstore/v1.1/items/${itemId}/publish`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'x-goog-api-version': '2' },
  });
  const body = await res.json();
  const status = body.status ?? [];
  if (!res.ok || !status.includes('OK')) {
    throw new Error(`publish failed: ${status.join(', ') || res.status}`);
  }
}

export async function manifestVersionFromZip(execFn, zipPath) {
  const result = await execFn(['unzip', '-p', zipPath, 'manifest.json']);
  if (result.code !== 0) throw new Error(`could not read manifest from ${zipPath}: ${result.stderr}`);
  const version = JSON.parse(result.stdout).version;
  if (typeof version !== 'string') throw new Error(`${zipPath} manifest has no version`);
  return version;
}

export function assertLockCoherence(lock, zipVersion) {
  const pinned = lock?.extension?.version;
  if (pinned !== zipVersion) {
    throw new Error(
      `zip manifest is ${zipVersion} but runtime-lock pins extension ${pinned}: run pin-runtime first so the lock, the release asset, and the store move together`
    );
  }
}

async function realExec(argv) {
  try {
    const { stdout, stderr } = await execFileP(argv[0], argv.slice(1), { maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? String(err) };
  }
}

async function realReadSecret(service) {
  const r = await realExec(['security', 'find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', service, '-w']);
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function runPublish(deps) {
  const {
    fetchFn, execFn, readSecret, readFile: readFileFn, readLock, zipPath, dryRun,
    out = console.log, err = console.error,
  } = deps;

  const creds = {
    clientId: await readSecret(KEYCHAIN_SERVICES.clientId),
    clientSecret: await readSecret(KEYCHAIN_SERVICES.clientSecret),
    refreshToken: await readSecret(KEYCHAIN_SERVICES.refreshToken),
  };
  const missing = Object.entries(KEYCHAIN_SERVICES).filter(([k]) => !creds[k]).map(([, s]) => s);
  if (missing.length) {
    err(`missing keychain credential(s): ${missing.join(', ')} — run scripts/cws-mint-token.mjs once to mint them`);
    return 1;
  }

  const lock = await readLock();
  const itemId = lock?.extension?.id;
  if (!itemId) {
    err('runtime-lock.json has no extension.id');
    return 1;
  }
  const zipVersion = await manifestVersionFromZip(execFn, zipPath);
  assertLockCoherence(lock, zipVersion);

  if (dryRun) {
    out(`dry run: would upload ${zipPath} (manifest ${zipVersion}) to item ${itemId} and publish; credentials present, lock coherent`);
    return 0;
  }

  const token = await refreshAccessToken(fetchFn, creds);
  const zipBytes = await readFileFn(zipPath);
  await uploadPackage(fetchFn, token, itemId, zipBytes);
  out(`uploaded ${zipVersion} to ${itemId}`);
  await publishItem(fetchFn, token, itemId);
  out('published: the store now reviews the new version; visibility is unchanged');
  return 0;
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const zipPath = args.find((a) => !a.startsWith('--'));
  if (!zipPath) {
    console.error('usage: node scripts/publish-extension.mjs <store-zip> [--dry-run]');
    process.exit(2);
  }
  const code = await runPublish({
    fetchFn: fetch,
    execFn: realExec,
    readSecret: realReadSecret,
    readFile,
    readLock: async () => JSON.parse(await readFile(new URL('../runtime-lock.json', import.meta.url), 'utf8')),
    zipPath,
    dryRun,
  }).catch((e) => {
    console.error(String(e.message ?? e));
    return 1;
  });
  process.exit(code);
}
