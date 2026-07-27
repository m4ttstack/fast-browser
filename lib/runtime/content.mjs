import { buildContentManifestDigest } from '../core/content-manifest.mjs';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

// The single source of truth for "does this installed runtime tree's
// content match what its own marker recorded at install time". A marker
// with no digest, or a malformed one, is never verified: fail closed
// rather than trust a legacy install (one written before this check
// existed) or a marker that was rewritten without a matching digest.
// Every caller that decides whether an installed runtime can be trusted --
// doctor's runtime-checksum check, installRuntime's existingInstall
// shortcut, the upgrade classifier's self-consistency check, and the
// launch-time validator that runs on every session start -- shares this
// exact function, so there is only ever one place that decides what
// "verified" means for the runtime artifact's bytes.
export async function verifyRuntimeContentDigest(cliDirectory, marker) {
  if (typeof marker?.contentDigest !== 'string' || !DIGEST_PATTERN.test(marker.contentDigest)) {
    return false;
  }
  const actualDigest = await buildContentManifestDigest(cliDirectory);
  return actualDigest === marker.contentDigest;
}
