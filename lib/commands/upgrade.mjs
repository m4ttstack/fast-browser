import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { buildContentManifestDigest } from '../core/content-manifest.mjs';
import { runtimeLockIdentity } from '../runtime/lock.mjs';
import { checkRuntimeContentDigest } from '../runtime/content.mjs';

// Doctor checks a lock-version bump alone can legitimately fail: the pinned
// runtime/extension version moved, so the artifacts installed under the OLD
// lock necessarily mismatch the NEW one. Any other failing check (a plugin
// registration, routing ownership, pairing, permissions, and so on) is never
// explained by a version bump, so its presence must keep the tampering guard
// firing exactly as it does today.
export const RUNTIME_UPGRADE_CHECK_IDS = Object.freeze(['runtime-checksum', 'mcp-handshake', 'tool-contract']);
export const EXTENSION_UPGRADE_CHECK_IDS = Object.freeze(['extension-artifact', 'extension-installed']);
const LOCK_UPGRADE_CHECK_IDS = new Set([...RUNTIME_UPGRADE_CHECK_IDS, ...EXTENSION_UPGRADE_CHECK_IDS]);

async function versionDirectoryNames(rootDir) {
  try {
    return (await readdir(rootDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function readOwnMarker(markerPath) {
  const [markerState, marker] = await Promise.all([
    lstat(markerPath),
    readFile(markerPath, 'utf8').then(JSON.parse),
  ]);
  if (
    markerState.isSymbolicLink()
    || !markerState.isFile()
    || (markerState.mode & 0o777) !== 0o600
  ) throw new Error('installed.json has unsafe permissions');
  if (
    marker.schemaVersion !== 1
    || marker.lock === null
    || typeof marker.lock !== 'object'
  ) throw new Error('installed.json is malformed');
  return marker;
}

// A directory's marker is self-consistent only when it recorded its OWN
// name as the lock's productVersion (not copied from another install) and
// the runtime binary it claims to have verified is still present. Content
// is a separate, three-way question (see checkRuntimeContentDigest):
// 'tampered' (a digest is recorded but does not match) still throws here,
// exactly as before -- that is evidence of active modification. A marker
// with NO digest at all ('unverifiable': one written before this check
// existed) does NOT throw: it is uncertain, not accused. The caller
// receives `verified: false` and still gets to use this directory as proof
// a real prior install existed, but must treat any check it explains as
// requiring a real, checksum-verified reinstall rather than a silent pass.
async function selfConsistentRuntimeIdentity(directory, name) {
  const marker = await readOwnMarker(path.join(directory, 'installed.json'));
  if (marker.lock.productVersion !== name) {
    throw new Error('runtime marker does not match its own directory');
  }
  const cliDirectory = path.join(directory, 'fast-browser-mcp');
  const cliState = await stat(path.join(cliDirectory, 'cli.cjs'));
  if (!cliState.isFile()) throw new Error('runtime CLI is missing');
  const digestState = await checkRuntimeContentDigest(cliDirectory, marker);
  if (digestState === 'tampered') {
    throw new Error('runtime bytes do not match their recorded content digest');
  }
  return { identity: marker.lock, verified: digestState === 'verified' };
}

// Symmetric with selfConsistentRuntimeIdentity above, and independently
// verifiable the same way extension-installed already is: a mismatched
// digest ('tampered') still throws, unchanged. A missing digest
// ('unverifiable', a marker predating this check) does not: it returns
// verified: false rather than accusing a legacy install of tampering.
// The manifest-version check runs regardless of digest presence, so an
// unverifiable directory whose manifest does not even match its own name
// still throws -- unverifiable relaxes ONLY the content-digest question,
// nothing else.
async function selfConsistentExtensionIdentity(directory, name) {
  const marker = await readOwnMarker(path.join(directory, 'installed.json'));
  if (marker.lock.extension?.version !== name) {
    throw new Error('extension marker does not match its own directory');
  }
  const unpacked = path.join(directory, 'unpacked');
  const manifest = JSON.parse(await readFile(path.join(unpacked, 'manifest.json'), 'utf8'));
  if (manifest.version !== name) {
    throw new Error('extension manifest does not match its own directory');
  }
  if (typeof marker.contentDigest !== 'string' || !/^[0-9a-f]{64}$/.test(marker.contentDigest)) {
    return { identity: marker.lock, verified: false };
  }
  const actualDigest = await buildContentManifestDigest(unpacked);
  if (actualDigest !== marker.contentDigest) {
    throw new Error('extension bytes do not match their recorded content digest');
  }
  return { identity: marker.lock, verified: true };
}

// Every installed directory under rootDir must be internally consistent
// with its own marker before any of it counts as evidence of a pending
// upgrade. One inconsistent directory anywhere (bytes tampered against a
// PRESENT digest, a missing or malformed marker, wrong permissions) throws,
// and the caller treats that as tampering rather than picking around it.
// A directory that is merely unverifiable (self-consistent in every way
// except having no digest to check) does not throw; it is carried through
// as `{ identity, verified: false }` instead.
async function priorLockIdentities(rootDir, resolve, names) {
  const results = [];
  for (const name of names) {
    results.push(await resolve(path.join(rootDir, name), name));
  }
  return results;
}

// Tie the evidence to the SPECIFIC artifact responsible for the failing
// check, not to whatever else happens to be on disk. The directory that
// check actually inspects is the one named after the currently pinned lock
// (paths.runtimeDir/<lock.productVersion>, or the extension equivalent).
//
// If that directory already exists, its OWN resolution decides the
// outcome, without any help from an unrelated directory:
//   - resolve() throws (tampered, malformed, wrong permissions): propagates
//     up untouched and is treated as drift, exactly as before.
//   - resolve() succeeds fully VERIFIED: there is nothing left for a
//     version bump to explain -- the artifact already matches the current
//     lock's content, so whatever else is failing is unrelated. Not an
//     upgrade.
//   - resolve() succeeds but UNVERIFIABLE (a legacy marker with no digest
//     at all): the directory's own presence is enough to justify a real,
//     checksum-verified reinstall. It does not need an unrelated older
//     directory's help to explain itself, and an unrelated directory must
//     never be allowed to explain IT away either.
//
// Only when nothing exists under the current name yet does history -- some
// OTHER, self-consistent, differently-identified directory -- prove a real
// prior install existed and the pinned version has since moved forward.
// `unverifiable` is true whenever the accepted evidence included a legacy,
// digest-less marker: the upgrade is still explained, but the caller must
// actually replace the artifact through a real install rather than assume
// it is already fine, and should tell the user it did so.
async function explainedByUpgrade(rootDir, resolve, currentIdentity, currentName) {
  const names = await versionDirectoryNames(rootDir);
  if (names.includes(currentName)) {
    const { verified } = await resolve(path.join(rootDir, currentName), currentName);
    return { explained: !verified, unverifiable: !verified };
  }
  const results = await priorLockIdentities(rootDir, resolve, names);
  const evidence = results.filter(({ identity }) => !isDeepStrictEqual(identity, currentIdentity));
  return {
    explained: evidence.length > 0,
    unverifiable: evidence.some(({ verified }) => !verified),
  };
}

// The full classification: whether every failing check is one a lock-version
// bump alone explains, AND (if so) whether any of the evidence for that was
// unverifiable rather than digest-confirmed. Fails closed: any unexplained
// check, any read failure, or any TAMPERED inconsistency anywhere returns
// `{ explained: false }`, which setup.mjs treats identically to genuine
// tampering. An UNVERIFIABLE inconsistency never blocks explanation; it
// only sets `unverifiable: true` so the caller knows to reinstall for real
// and say so, rather than silently trust unverifiable bytes.
export async function classifyLockUpgrade({ paths, lock, doctorReport }) {
  const failing = (doctorReport?.checks ?? [])
    .filter(({ status }) => status !== 'pass')
    .map(({ id }) => id);
  if (failing.length === 0 || failing.some((id) => !LOCK_UPGRADE_CHECK_IDS.has(id))) {
    return { explained: false, unverifiable: false };
  }
  const currentIdentity = runtimeLockIdentity(lock);
  let unverifiable = false;
  try {
    if (failing.some((id) => RUNTIME_UPGRADE_CHECK_IDS.includes(id))) {
      const runtime = await explainedByUpgrade(
        paths.runtimeDir, selfConsistentRuntimeIdentity, currentIdentity, lock.productVersion,
      );
      if (!runtime.explained) return { explained: false, unverifiable: false };
      unverifiable = unverifiable || runtime.unverifiable;
    }
    if (failing.some((id) => EXTENSION_UPGRADE_CHECK_IDS.includes(id))) {
      const extension = await explainedByUpgrade(
        paths.extensionDir, selfConsistentExtensionIdentity, currentIdentity, lock.extension.version,
      );
      if (!extension.explained) return { explained: false, unverifiable: false };
      unverifiable = unverifiable || extension.unverifiable;
    }
  } catch {
    return { explained: false, unverifiable: false };
  }
  return { explained: true, unverifiable };
}

// Boolean-only view of classifyLockUpgrade, kept for callers (and existing
// tests) that only ever need the explained/not-explained verdict.
export async function isExplainedByLockUpgrade(args) {
  return (await classifyLockUpgrade(args)).explained;
}
