import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { buildContentManifestDigest } from '../core/content-manifest.mjs';
import { runtimeLockIdentity } from '../runtime/lock.mjs';
import { verifyRuntimeContentDigest } from '../runtime/content.mjs';

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
// name as the lock's productVersion (not copied from another install), the
// runtime binary it claims to have verified is still present, AND the
// installed tree's recomputed content digest still matches what the marker
// recorded at install time. Symmetric with selfConsistentExtensionIdentity
// below: a marker copied onto a tampered directory can no longer pass by
// merely agreeing with itself on version and lock identity, since the bytes
// themselves are now re-verified too. A marker with no digest at all (one
// written before this check existed) is treated the same as one that fails
// to match: fail closed rather than silently trust a legacy install.
async function selfConsistentRuntimeIdentity(directory, name) {
  const marker = await readOwnMarker(path.join(directory, 'installed.json'));
  if (marker.lock.productVersion !== name) {
    throw new Error('runtime marker does not match its own directory');
  }
  const cliDirectory = path.join(directory, 'fast-browser-mcp');
  const cliState = await stat(path.join(cliDirectory, 'cli.cjs'));
  if (!cliState.isFile()) throw new Error('runtime CLI is missing');
  if (!(await verifyRuntimeContentDigest(cliDirectory, marker))) {
    throw new Error('runtime bytes do not match their recorded content digest');
  }
  return marker.lock;
}

// Extension tampering is independently verifiable: buildContentManifestDigest
// recomputes a byte-level hash over the unpacked tree, the same check
// extension-installed already uses to catch the focus-fix incident (content
// drift behind an unchanged version string). Reusing it here means a
// tampered OLD install is caught even though doctor never inspects it (it
// only ever checks the version the CURRENT lock names).
async function selfConsistentExtensionIdentity(directory, name) {
  const marker = await readOwnMarker(path.join(directory, 'installed.json'));
  if (marker.lock.extension?.version !== name) {
    throw new Error('extension marker does not match its own directory');
  }
  if (typeof marker.contentDigest !== 'string' || !/^[0-9a-f]{64}$/.test(marker.contentDigest)) {
    throw new Error('extension marker is missing its content digest');
  }
  const unpacked = path.join(directory, 'unpacked');
  const manifest = JSON.parse(await readFile(path.join(unpacked, 'manifest.json'), 'utf8'));
  if (manifest.version !== name) {
    throw new Error('extension manifest does not match its own directory');
  }
  const actualDigest = await buildContentManifestDigest(unpacked);
  if (actualDigest !== marker.contentDigest) {
    throw new Error('extension bytes do not match their recorded content digest');
  }
  return marker.lock;
}

// Every installed directory under rootDir must be internally consistent
// with its own marker before any of it counts as evidence of a pending
// upgrade. One inconsistent directory anywhere (bytes vs marker, a missing
// or malformed marker, wrong permissions) throws, and the caller treats
// that as tampering rather than picking around it.
async function priorLockIdentities(rootDir, resolve, names) {
  const identities = [];
  for (const name of names) {
    identities.push(await resolve(path.join(rootDir, name), name));
  }
  return identities;
}

// Tie the evidence to the SPECIFIC artifact responsible for the failing
// check, not to whatever else happens to be on disk. The directory that
// check actually inspects is the one named after the currently pinned lock
// (paths.runtimeDir/<lock.productVersion>, or the extension equivalent). If
// that directory already exists, "the version has not been installed yet"
// can never be the explanation for the failure, no matter how it looks:
// an unrelated, genuinely older directory must not be allowed to excuse it.
// Only when nothing exists under the current name yet does history -- some
// OTHER, self-consistent, differently-identified directory -- prove a real
// prior install existed and the pinned version has since moved forward.
async function explainedByUpgrade(rootDir, resolve, currentIdentity, currentName) {
  const names = await versionDirectoryNames(rootDir);
  if (names.includes(currentName)) return false;
  const identities = await priorLockIdentities(rootDir, resolve, names);
  return identities.some((identity) => !isDeepStrictEqual(identity, currentIdentity));
}

// True only when every failing check is one a lock-version bump alone
// explains, AND the installed artifacts responsible for those checks are
// self-consistent with their own markers and recorded a lock identity older
// than the one now pinned. Fails closed: any unexplained check, any read
// failure, or any inconsistency anywhere returns false, which setup.mjs
// treats identically to genuine tampering.
export async function isExplainedByLockUpgrade({ paths, lock, doctorReport }) {
  const failing = (doctorReport?.checks ?? [])
    .filter(({ status }) => status !== 'pass')
    .map(({ id }) => id);
  if (failing.length === 0 || failing.some((id) => !LOCK_UPGRADE_CHECK_IDS.has(id))) {
    return false;
  }
  const currentIdentity = runtimeLockIdentity(lock);
  try {
    if (
      failing.some((id) => RUNTIME_UPGRADE_CHECK_IDS.includes(id))
      && !(await explainedByUpgrade(
        paths.runtimeDir, selfConsistentRuntimeIdentity, currentIdentity, lock.productVersion,
      ))
    ) return false;
    if (
      failing.some((id) => EXTENSION_UPGRADE_CHECK_IDS.includes(id))
      && !(await explainedByUpgrade(
        paths.extensionDir, selfConsistentExtensionIdentity, currentIdentity, lock.extension.version,
      ))
    ) return false;
  } catch {
    return false;
  }
  return true;
}
