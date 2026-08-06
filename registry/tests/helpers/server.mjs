// Shared test harness for the registry HTTP service (WS4b plan, Task 3).
// Boots the real server (registry/server.mjs's boot()) in-process on an
// ephemeral port (PORT '0', OS-assigned -- read back off the bound
// server), against the memory store, with a throwaway Ed25519 signing key
// generated fresh per call (never a committed key). Callers MUST call the
// returned close() in a teardown so each test/suite starts clean and
// nothing leaks a listening socket across test files.

import { generateKeyPairSync } from 'node:crypto';

import { boot } from '../../server.mjs';

export const TEST_TOKEN = 'registry-test-token';

export function generateSigningKeyPem() {
  const { privateKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return privateKey;
}

// envOverrides layers on top of a working default env (token, a fresh
// signing key, ephemeral port) -- e.g. pass { VOYAGE_API_KEY: 'x' } to
// flip health's clustering flag, or { REGISTRY_TOKEN: 'other' } to test a
// different configured token, without repeating the rest.
export async function startTestServer(envOverrides = {}) {
  const env = {
    REGISTRY_TOKEN: TEST_TOKEN,
    REGISTRY_SIGNING_KEY: generateSigningKeyPem(),
    PORT: '0',
    ...envOverrides,
  };
  const instance = await boot({ env });
  return {
    ...instance,
    baseUrl: `http://127.0.0.1:${instance.port}`,
    token: env.REGISTRY_TOKEN,
  };
}
