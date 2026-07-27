import { buildContentManifestDigest } from '../core/content-manifest.mjs';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

// Three possible outcomes when checking an installed runtime tree against
// its own marker:
// - 'verified': a well-formed digest is recorded and recomputing it over
//   the tree on disk produces an exact match.
// - 'unverifiable': no well-formed digest is recorded at all -- a marker
//   written before this check existed. This is deliberately NOT the same
//   as tampering: nothing here was ever proven wrong, but nothing was ever
//   proven right either. Refusing to replace unverifiable bytes would
//   leave those exact unverifiable bytes installed and in use forever,
//   which is strictly worse than replacing them with a fresh,
//   checksum-verified install.
// - 'tampered': a well-formed digest is recorded but does not match the
//   recomputed bytes. This IS evidence of active modification after the
//   marker was written, and must keep surfacing as a refusal.
export async function checkRuntimeContentDigest(cliDirectory, marker) {
  if (typeof marker?.contentDigest !== 'string' || !DIGEST_PATTERN.test(marker.contentDigest)) {
    return 'unverifiable';
  }
  const actualDigest = await buildContentManifestDigest(cliDirectory);
  return actualDigest === marker.contentDigest ? 'verified' : 'tampered';
}

// The single source of truth for "should this installed runtime's content
// be trusted as-is, right now". Callers that only ever choose between
// trusting the bytes or replacing/refusing them outright -- doctor's
// runtime-checksum check, installRuntime's existingInstall shortcut, and
// the launch-time validator that runs on every session start -- never need
// to tell 'unverifiable' and 'tampered' apart: both mean "do not trust
// this", so they share this boolean collapse of checkRuntimeContentDigest.
// Only the upgrade classifier needs the three-way distinction, to turn an
// unverifiable legacy install into a reinstall trigger instead of a
// permanent refusal, while still refusing a genuinely tampered one exactly
// as before.
export async function verifyRuntimeContentDigest(cliDirectory, marker) {
  return (await checkRuntimeContentDigest(cliDirectory, marker)) === 'verified';
}
