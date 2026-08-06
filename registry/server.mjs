#!/usr/bin/env node
// Boot for the registry HTTP service (WS4b plan, Task 3). Owns exactly:
// required-env validation (fail fast, name the missing var, never echo a
// value), deriving the service's Ed25519 public key from its private
// signing key, selecting a store driver, and starting node:http's server.
// All request/auth/body-limit/routing logic lives in lib/http.mjs -- this
// file is boot plumbing only.

import { createServer } from 'node:http';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from './lib/store.mjs';
import { createRequestListener } from './lib/http.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const { version: REGISTRY_VERSION } = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'));

const DEFAULT_PORT = 8787;

export class RegistryBootError extends Error {}

// Reads `name` off `env`, throwing a RegistryBootError that names the
// variable -- never its value, never even a hint of its shape -- if it is
// missing or empty. The one place both required env vars (REGISTRY_TOKEN,
// REGISTRY_SIGNING_KEY) are checked.
function requireEnv(env, name) {
  const value = env[name];
  if (!value) {
    throw new RegistryBootError(`missing required environment variable: ${name}`);
  }
  return value;
}

// Task 4 seam: the 'pg' driver arrives when DATABASE_URL is present; until
// then every boot uses the memory store. Keeping this selection in its own
// function (rather than inlining the check in boot()) is the whole seam --
// Task 4 only needs createStore('pg', ...) to become real; this function
// does not change.
function selectStoreDriver(env) {
  return env.DATABASE_URL ? 'pg' : 'memory';
}

// Ed25519 only -- signing.mjs's sign()/verify() work with any key
// node:crypto's sign/verify accept, so nothing downstream would fail loudly
// if REGISTRY_SIGNING_KEY were, say, an RSA or EC key: it would just boot,
// derive an RSA/EC public key, and serve THAT from /health, silently
// producing signatures no Ed25519-verifying client could ever check
// against the key it pinned. Reject any other algorithm here, at the one
// place the key is first read, rather than downstream.
function derivePublicKeyPem(signingKeyPem) {
  let privateKey;
  try {
    privateKey = createPrivateKey(signingKeyPem);
  } catch {
    throw new RegistryBootError(
      'REGISTRY_SIGNING_KEY is not a valid PEM private key (expected an Ed25519 PKCS8 PEM -- see registry/scripts/keygen.mjs)',
    );
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new RegistryBootError(
      `REGISTRY_SIGNING_KEY is the wrong key type (expected an Ed25519 PKCS8 PEM -- see registry/scripts/keygen.mjs)`,
    );
  }
  return createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
}

// Boots the service against `env` (defaults to process.env) and starts
// listening. Never calls process.exit -- that is the CLI entrypoint's job,
// below -- so tests can call boot() directly with a synthetic env and get
// a rejected Promise (naming the missing var) instead of losing the test
// process.
export async function boot({ env = process.env } = {}) {
  const token = requireEnv(env, 'REGISTRY_TOKEN');
  const signingKeyPem = requireEnv(env, 'REGISTRY_SIGNING_KEY');
  const publicKeyPem = derivePublicKeyPem(signingKeyPem);

  const store = await createStore(selectStoreDriver(env));
  await store.init();

  const listener = createRequestListener({
    token,
    store,
    publicKeyPem,
    version: REGISTRY_VERSION,
    clustering: Boolean(env.VOYAGE_API_KEY),
  });

  const server = createServer(listener);
  const port = Number(env.PORT ?? DEFAULT_PORT);

  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, resolvePromise);
  });

  return {
    server,
    store,
    port: server.address().port,
    publicKeyPem,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  boot()
    .then(({ port }) => {
      console.log(`fast-browser-registry listening on port ${port}`);
    })
    .catch((error) => {
      console.error(`fast-browser-registry: ${error.message}`);
      process.exit(1);
    });
}
