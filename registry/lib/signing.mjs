// Ed25519 signing over canonical artifact bytes (WS4b plan, Task 3). This
// module knows nothing about flow artifacts -- it signs and verifies
// whatever bytes it is handed. The canonical bytes it is meant to be used
// with are lib/flows/artifact.mjs's serializeFlow(flow) output (the same
// string both the service and a client compute independently), but
// coupling this module to artifact parsing would make it impossible to
// unit-test signing in isolation from the flow schema -- so it stays
// byte-agnostic by design, per the task brief.
//
// Ed25519 (via node:crypto sign/verify with a null algorithm -- Ed25519
// signs the message directly; it does not take a separate digest
// algorithm the way RSA/ECDSA do) needs no IV, no padding choice, and a
// fixed-size signature: crypto.sign(null, message, privateKey) and
// crypto.verify(null, message, publicKey, signature) are the whole API.

import { createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';

function toBuffer(bytes) {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
}

// privateKeyPem: PKCS8 PEM (the shape registry/scripts/keygen.mjs prints
// and REGISTRY_SIGNING_KEY carries). Returns the signature as base64 --
// the wire shape the plan's envelope carries ("signature": "<base64
// Ed25519 ...>").
export function sign(canonicalBytes, privateKeyPem) {
  const key = createPrivateKey(privateKeyPem);
  const signature = cryptoSign(null, toBuffer(canonicalBytes), key);
  return signature.toString('base64');
}

// publicKeyPem: SPKI PEM (the shape GET /health serves). Returns a plain
// boolean -- never throws on a mismatched or malformed signature, so a
// caller can treat "false" and "garbage input" identically as "not
// verified" rather than needing its own try/catch around every call. A
// malformed publicKeyPem is treated differently: that is a configuration
// bug (the caller handed this function a key that isn't a key at all), not
// a verification outcome, so createPublicKey is left free to throw.
export function verify(canonicalBytes, signatureBase64, publicKeyPem) {
  const key = createPublicKey(publicKeyPem);
  try {
    const signature = Buffer.from(signatureBase64, 'base64');
    return cryptoVerify(null, toBuffer(canonicalBytes), key, signature);
  } catch {
    return false;
  }
}
