import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { buildContentManifestDigest } from '../extension/content-manifest.mjs';
import { runtimeLockIdentity } from '../runtime/lock.mjs';

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
// the runtime binary it claims to have verified is still present. This is
// the same evidence runtime/install.mjs relies on for its own idempotent
// existingInstall() check, generalized to any directory name rather than
// only the currently pinned one.
async function selfConsistentRuntimeIdentity(directory, name) {
  const marker = await readOwnMarker(path.join(directory, 'installed.json'));
  if (marker.lock.productVersion !== name) {
    throw new Error('runtime marker does not match its own directory');
  }
  const cliState = await stat(path.join(directory, 'fast-browser-mcp', 'cli.cjs'));
  if (!cliState.isFile()) throw new Error('runtime CLI is missing');
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
async function priorLockIdentities(rootDir, resolve) {
  const names = await versionDirectoryNames(rootDir);
  const identities = [];
  for (const name of names) {
    identities.push(await resolve(path.join(rootDir, name), name));
  }
  return identities;
}

async function explainedByUpgrade(rootDir, resolve, currentIdentity) {
  const identities = await priorLockIdentities(rootDir, resolve);
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
      && !(await explainedByUpgrade(paths.runtimeDir, selfConsistentRuntimeIdentity, currentIdentity))
    ) return false;
    if (
      failing.some((id) => EXTENSION_UPGRADE_CHECK_IDS.includes(id))
      && !(await explainedByUpgrade(paths.extensionDir, selfConsistentExtensionIdentity, currentIdentity))
    ) return false;
  } catch {
    return false;
  }
  return true;
}
