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
import { createEmbedder } from './lib/embedder.mjs';
import { sign } from './lib/signing.mjs';

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

// Task 4 seam: the 'pg' driver is selected when DATABASE_URL is present;
// otherwise every boot uses the memory store.
function selectStoreDriver(env) {
  return env.DATABASE_URL ? 'pg' : 'memory';
}

// SECURITY: some pg connection/init failure paths can quote the
// connection string -- and therefore its embedded password -- verbatim in
// error.message. Before Task 4, boot()'s only failure handling was the
// isMain catch below printing `error.message` unconditionally, which
// would have leaked DATABASE_URL's password straight to the process's
// logs on a bad connection string. This strips both the whole
// connectionString and its password component (if the string is
// URL-parseable) out of `message` wherever they appear, so a caller can
// still see a useful diagnostic without ever seeing the secret.
export function redactConnectionString(message, connectionString) {
  if (!connectionString || typeof message !== 'string') return message;
  let redacted = message.split(connectionString).join('[DATABASE_URL redacted]');
  try {
    const { password } = new URL(connectionString);
    if (password) {
      const decoded = decodeURIComponent(password);
      redacted = redacted.split(password).join('***').split(decoded).join('***');
    }
  } catch {
    // connectionString did not parse as a URL -- nothing further to strip
    // beyond the whole-string replacement above.
  }
  return redacted;
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
//
// `embedder` is the Task 5 test-injection seam: when omitted (the
// `undefined` default), boot derives the real one from
// `env.VOYAGE_API_KEY` via registry/lib/embedder.mjs's createEmbedder --
// production behavior, and what every non-embedder-focused test already
// gets for free. Passing an explicit value (a stub `async (text) ->
// Float64Array | null` function, or `null` to force keyless behavior
// regardless of env) overrides that derivation entirely, so
// registry/tests/http.test.mjs can exercise real clustering through the
// full HTTP layer with deterministic vectors instead of a live Voyage call.
export async function boot({ env = process.env, embedder: embedderOverride } = {}) {
  const token = requireEnv(env, 'REGISTRY_TOKEN');
  const signingKeyPem = requireEnv(env, 'REGISTRY_SIGNING_KEY');
  const publicKeyPem = derivePublicKeyPem(signingKeyPem);
  const signer = { sign: (bytes) => sign(bytes, signingKeyPem) };
  const embedder = embedderOverride !== undefined ? embedderOverride : createEmbedder({ env });

  const driver = selectStoreDriver(env);
  let store;
  try {
    store = await createStore(driver, { connectionString: env.DATABASE_URL });
    await store.init();
  } catch (error) {
    if (driver !== 'pg') throw error;
    // See redactConnectionString above -- this is the one place a pg
    // connection/init failure's message is allowed to surface, and only
    // after it has had DATABASE_URL's value stripped out of it.
    throw new RegistryBootError(
      `failed to initialize the Postgres store from DATABASE_URL: ${redactConnectionString(error.message, env.DATABASE_URL)}`,
    );
  }

  const listener = createRequestListener({
    token,
    store,
    signer,
    embedder,
    publicKeyPem,
    version: REGISTRY_VERSION,
    // Reflects env.VOYAGE_API_KEY specifically (not whether `embedder` was
    // overridden for a test) -- /health's `clustering` flag documents the
    // service's real configuration, per the plan's Shared shapes.
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
    // Closes the HTTP server, then the store if it holds its own
    // resources to release (pg-store's connection pool; memory-store has
    // none and simply has no close method to call).
    close: async () => {
      await new Promise((resolveClose) => server.close(resolveClose));
      if (typeof store.close === 'function') await store.close();
    },
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
