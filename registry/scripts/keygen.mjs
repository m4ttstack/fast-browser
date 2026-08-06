#!/usr/bin/env node
// Generates a fresh Ed25519 keypair for the registry service and prints
// both PEMs to stdout -- never writes a file, never commits anything. Run
// once by Matt when standing up (or rotating) a deployment; the private
// key becomes the Railway REGISTRY_SIGNING_KEY env var. The public key is
// printed for reference only -- there is no separate place it needs to be
// stored, since a running service already serves it back over GET
// /health once booted with the private key above.
//
// Tests never reuse a key printed by this script: registry/tests/helpers/
// server.mjs generates its own throwaway keypairs directly via
// node:crypto's generateKeyPairSync, per test run.

import { generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

console.log('# REGISTRY_SIGNING_KEY -- private key. Set this as the Railway env var; never commit it.');
console.log(privateKey);
console.log('# Public key -- reference only. GET /health serves this once the service boots with the key above.');
console.log(publicKey);
console.log('# Usage: run once; paste the private key PEM above into `railway variables set REGISTRY_SIGNING_KEY`.');
