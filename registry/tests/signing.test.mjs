import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import { serializeFlow } from '../../lib/flows/artifact.mjs';
import { sign, verify } from '../lib/signing.mjs';
import { baseFlow } from './helpers/fixtures.mjs';

function generateKeyPairPem() {
  return generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

test('sign -> verify round trip is green for the same bytes and keypair', () => {
  const { publicKey, privateKey } = generateKeyPairPem();
  const bytes = Buffer.from('the exact canonical bytes', 'utf8');
  const signature = sign(bytes, privateKey);
  assert.equal(verify(bytes, signature, publicKey), true);
});

test('verify is false when a single byte of the signed content is tampered', () => {
  const { publicKey, privateKey } = generateKeyPairPem();
  const bytes = Buffer.from('the exact canonical bytes', 'utf8');
  const signature = sign(bytes, privateKey);
  const tampered = Buffer.from(bytes);
  tampered[0] ^= 0xff;
  assert.equal(verify(tampered, signature, publicKey), false);
});

test('verify is false against a different keypair entirely', () => {
  const { privateKey } = generateKeyPairPem();
  const { publicKey: otherPublicKey } = generateKeyPairPem();
  const bytes = Buffer.from('the exact canonical bytes', 'utf8');
  const signature = sign(bytes, privateKey);
  assert.equal(verify(bytes, signature, otherPublicKey), false);
});

test('verify returns false for a garbage signature rather than throwing', () => {
  const { publicKey } = generateKeyPairPem();
  const bytes = Buffer.from('the exact canonical bytes', 'utf8');
  assert.doesNotThrow(() => {
    assert.equal(verify(bytes, 'not-a-real-signature', publicKey), false);
  });
});

test('sign accepts a string as canonicalBytes (serializeFlow returns a string, not a Buffer)', () => {
  const { publicKey, privateKey } = generateKeyPairPem();
  const canonical = serializeFlow(baseFlow());
  assert.equal(typeof canonical, 'string');
  const signature = sign(canonical, privateKey);
  assert.equal(verify(canonical, signature, publicKey), true);
});

test('a signature over one flow does not verify against the serialization of a different flow', () => {
  const { publicKey, privateKey } = generateKeyPairPem();
  const canonical = serializeFlow(baseFlow());
  const signature = sign(canonical, privateKey);
  const mutatedCanonical = serializeFlow(baseFlow({ description: 'a different description' }));
  assert.equal(verify(mutatedCanonical, signature, publicKey), false);
});
