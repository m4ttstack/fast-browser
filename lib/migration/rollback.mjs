import crypto from 'node:crypto';
import { constants } from 'node:fs';
import {
  link,
  lstat,
  open,
  readlink,
  realpath,
  rename,
  symlink,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

import {
  assertConfined,
  assertNoSymlinkPath,
  canonicalHome,
  LEGACY_FILES,
  LEGACY_LINKS,
  LEGACY_MCP_POINTER,
  LEGACY_TOKEN_POINTER,
  readRegularFile,
} from './inventory.mjs';

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function lstatOrNull(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function assertCanonicalParent(homeDir, target) {
  const pathname = assertConfined(homeDir, target);
  const parent = path.dirname(pathname);
  await assertNoSymlinkPath(homeDir, parent, { allowMissing: false });
  if (await realpath(parent) !== parent) {
    throw new Error(`rollback parent is not canonical: ${parent}`);
  }
  return pathname;
}

async function writeNoFollowTemporary(homeDir, target, bytes, mode) {
  const pathname = await assertCanonicalParent(homeDir, target);
  if (await lstatOrNull(pathname)) {
    throw new Error(`rollback temporary collision: ${pathname}`);
  }
  let handle;
  try {
    handle = await open(
      pathname,
      constants.O_CREAT
        | constants.O_EXCL
        | constants.O_WRONLY
        | constants.O_NOFOLLOW,
      mode,
    );
    await handle.writeFile(bytes);
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle?.close();
  }
  const state = await lstat(pathname);
  if (state.isSymbolicLink() || !state.isFile()) {
    throw new Error(`rollback temporary is not regular: ${pathname}`);
  }
  return state;
}

function exactKeys(value, required, optional = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => allowed.has(key));
}

function validateHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function relativeRecognized(homeDir, target, recognized) {
  const confined = assertConfined(homeDir, target);
  const relative = path.relative(homeDir, confined);
  if (!recognized.has(relative)) {
    throw new Error(`rollback target is not recognized: ${target}`);
  }
  return confined;
}

async function loadManifest(input, homeDir) {
  if (typeof input !== 'string') return structuredClone(input);
  const pathname = assertConfined(homeDir, input);
  await assertNoSymlinkPath(homeDir, pathname, { allowMissing: false });
  const { bytes } = await readRegularFile(homeDir, pathname, 'rollback manifest must be regular');
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('rollback manifest is malformed');
  }
}

function validateManifest(value, homeDir) {
  if (
    !exactKeys(
      value,
      [
        'schemaVersion',
        'createdAt',
        'homeDir',
        'backupDir',
        'manifestPath',
        'files',
        'jsonEdits',
        'symlinks',
        'cleanup',
        'state',
      ],
    )
    || value.schemaVersion !== 1
    || value.state !== 'prepared'
    || value.homeDir !== homeDir
    || !Array.isArray(value.files)
    || !Array.isArray(value.jsonEdits)
    || !Array.isArray(value.symlinks)
    || !exactKeys(value.cleanup, ['files', 'symlinks'])
    || !Array.isArray(value.cleanup.files)
    || !Array.isArray(value.cleanup.symlinks)
  ) {
    throw new Error('invalid rollback schema or home');
  }
  const stableBackupRoot = path.join(homeDir, '.fast-browser', 'backups');
  const backupDir = assertConfined(stableBackupRoot, value.backupDir);
  if (path.dirname(backupDir) !== stableBackupRoot) {
    throw new Error('rollback backup directory is not confined');
  }
  assertConfined(backupDir, value.manifestPath);

  const recognizedFiles = new Set(LEGACY_FILES);
  const recognizedLinks = new Map(LEGACY_LINKS);
  const seenFiles = new Set();
  for (const entry of value.files) {
    if (!exactKeys(
      entry,
      ['path', 'sha256', 'backupPath', 'mode', 'backupSha256', 'redactions'],
    )) throw new Error('invalid rollback file schema');
    const target = relativeRecognized(homeDir, entry.path, recognizedFiles);
    if (seenFiles.has(target)) throw new Error('duplicate rollback file target');
    seenFiles.add(target);
    if (
      !validateHash(entry.sha256)
      || !validateHash(entry.backupSha256)
      || !Number.isInteger(entry.mode)
      || entry.mode < 0
      || entry.mode > 0o777
      || !Array.isArray(entry.redactions)
    ) throw new Error('invalid rollback file metadata');
    const backupPath = assertConfined(backupDir, entry.backupPath);
    if (path.dirname(backupPath) !== backupDir) {
      throw new Error('rollback backup path is not confined');
    }
    if (entry.redactions.length > 1) throw new Error('invalid rollback redaction count');
    if (entry.redactions.length === 1) {
      const [redaction] = entry.redactions;
      if (
        target !== path.join(homeDir, '.claude.json')
        || !exactKeys(redaction, ['pointer', 'sentinel'])
        || redaction.pointer !== LEGACY_TOKEN_POINTER
        || typeof redaction.sentinel !== 'string'
      ) throw new Error('invalid rollback token template metadata');
    }
  }

  if (value.cleanup.files.length !== value.files.length) {
    throw new Error('rollback cleanup file inventory mismatch');
  }
  const seenCleanupFiles = new Set();
  for (const entry of value.cleanup.files) {
    if (!exactKeys(entry, [
      'path',
      'action',
      'beforeSha256',
      'afterSha256',
      'mode',
    ])) throw new Error('invalid rollback cleanup schema');
    const target = relativeRecognized(homeDir, entry.path, recognizedFiles);
    if (seenCleanupFiles.has(target) || !seenFiles.has(target)) {
      throw new Error('rollback cleanup target mismatch');
    }
    seenCleanupFiles.add(target);
    if (
      !validateHash(entry.beforeSha256)
      || !Number.isInteger(entry.mode)
      || !['delete', 'replace'].includes(entry.action)
      || (entry.action === 'replace' && !validateHash(entry.afterSha256))
      || (entry.action === 'delete' && entry.afterSha256 !== null)
    ) throw new Error('invalid rollback cleanup metadata');
    if (
      target === path.join(homeDir, '.claude.json')
        ? entry.action !== 'replace'
        : entry.action !== 'delete'
    ) throw new Error('rollback cleanup action does not match recognized target');
    const backup = value.files.find(({ path: source }) => source === target);
    if (backup.sha256 !== entry.beforeSha256 || backup.mode !== entry.mode) {
      throw new Error('rollback cleanup does not match backup');
    }
  }

  const seenLinks = new Set();
  for (const entry of value.symlinks) {
    if (!exactKeys(entry, ['path', 'target'])) throw new Error('invalid rollback symlink schema');
    const targetPath = assertConfined(homeDir, entry.path);
    const relative = path.relative(homeDir, targetPath);
    const expectedSuffix = recognizedLinks.get(relative);
    if (
      !expectedSuffix
      || seenLinks.has(targetPath)
      || typeof entry.target !== 'string'
      || !entry.target.replaceAll(path.sep, '/').endsWith(expectedSuffix)
    ) throw new Error('rollback symlink target is not recognized');
    seenLinks.add(targetPath);
  }
  if (
    value.cleanup.symlinks.length !== value.symlinks.length
    || value.cleanup.symlinks.some((entry) => {
      if (!exactKeys(entry, ['path', 'target', 'action']) || entry.action !== 'delete') return true;
      return !value.symlinks.some(
        (source) => source.path === entry.path && source.target === entry.target,
      );
    })
  ) throw new Error('invalid rollback symlink cleanup inventory');

  if (
    value.jsonEdits.length > 1
    || value.jsonEdits.some((entry) => (
      !exactKeys(entry, ['path', 'pointer', 'before', 'tokenPointer'])
      || entry.path !== path.join(homeDir, '.claude.json')
      || entry.pointer !== LEGACY_MCP_POINTER
      || ![null, LEGACY_TOKEN_POINTER].includes(entry.tokenPointer)
      || JSON.stringify(entry.before).includes('PLAYWRIGHT_MCP_EXTENSION_TOKEN')
    ))
  ) throw new Error('invalid rollback JSON edit schema');
  return value;
}

async function preflightCurrent(manifest, homeDir) {
  for (const entry of manifest.cleanup.files) {
    if (entry.action === 'delete') {
      await assertNoSymlinkPath(homeDir, entry.path);
      await assertCanonicalParent(homeDir, entry.path);
      const state = await lstatOrNull(entry.path);
      if (state) throw new Error(`rollback collision from post-migration edit: ${entry.path}`);
      continue;
    }
    const { bytes, state: opened } = await readRegularFile(
      homeDir,
      entry.path,
      'rollback current target must be regular',
    );
    if (
      sha256(bytes) !== entry.afterSha256
      || (opened.mode & 0o777) !== entry.mode
    ) throw new Error(`rollback refused post-migration edit or hash mismatch: ${entry.path}`);
  }
  for (const entry of manifest.cleanup.symlinks) {
    await assertNoSymlinkPath(homeDir, entry.path);
    await assertCanonicalParent(homeDir, entry.path);
    if (await lstatOrNull(entry.path)) {
      throw new Error(`rollback collision from post-migration edit: ${entry.path}`);
    }
  }
}

async function preflightBackups(manifest, homeDir, restored) {
  for (const entry of manifest.files) {
    const { bytes, state } = await readRegularFile(
      homeDir,
      entry.backupPath,
      'rollback backup must remain a regular file',
    );
    if (
      sha256(bytes) !== entry.backupSha256
      || (state.mode & 0o777) !== 0o600
      || sha256(restored.get(entry.path) ?? Buffer.alloc(0)) !== entry.sha256
    ) {
      throw new Error(`rollback backup changed before restore: ${entry.backupPath}`);
    }
  }
}

async function finalPreflight({
  input,
  initialManifest,
  homeDir,
  restored,
  suppliedHome,
}) {
  const currentHome = await canonicalHome(suppliedHome);
  if (currentHome !== homeDir) throw new Error('rollback home changed before restore');
  const reloaded = validateManifest(await loadManifest(input, homeDir), homeDir);
  if (JSON.stringify(reloaded) !== JSON.stringify(initialManifest)) {
    throw new Error('rollback manifest changed before restore');
  }
  await preflightBackups(reloaded, homeDir, restored);
  await preflightCurrent(reloaded, homeDir);
  return reloaded;
}

async function reconstructBackups(manifest, homeDir, readMigratedToken) {
  let token = null;
  const needsToken = manifest.files.some(({ redactions }) => redactions.length === 1);
  if (needsToken) {
    if (typeof readMigratedToken !== 'function') {
      throw new Error('rollback requires an injected migrated-token reader');
    }
    try {
      token = await readMigratedToken();
    } catch {
      throw new Error('unable to read migrated token for rollback');
    }
    if (typeof token !== 'string') throw new Error('migrated token is unavailable for rollback');
    if (JSON.stringify(manifest).includes(token)) {
      throw new Error('rollback manifest contains forbidden token data');
    }
  }
  const restored = new Map();
  try {
    for (const entry of manifest.files) {
      const { bytes, state } = await readRegularFile(
        homeDir,
        entry.backupPath,
        'rollback backup must be a regular file',
      );
      if (sha256(bytes) !== entry.backupSha256 || (state.mode & 0o777) !== 0o600) {
        throw new Error(`rollback backup hash or mode mismatch: ${entry.backupPath}`);
      }
      let output = bytes;
      if (entry.redactions.length === 1) {
        const sentinel = JSON.stringify(entry.redactions[0].sentinel);
        const template = bytes.toString('utf8');
        if (template.indexOf(sentinel) < 0 || template.indexOf(sentinel) !== template.lastIndexOf(sentinel)) {
          throw new Error('rollback token template sentinel is ambiguous');
        }
        output = Buffer.from(template.replace(sentinel, JSON.stringify(token)));
      }
      if (sha256(output) !== entry.sha256) {
        throw new Error(`rollback reconstructed backup hash mismatch: ${entry.path}`);
      }
      restored.set(entry.path, output);
    }
  } finally {
    token = null;
  }
  return restored;
}

async function createRestoredFile(homeDir, entry, bytes) {
  const temporary = path.join(
    path.dirname(entry.path),
    `.${path.basename(entry.path)}.${crypto.randomUUID()}.rollback`,
  );
  let temporaryState = null;
  let linked = false;
  try {
    await assertNoSymlinkPath(homeDir, entry.path);
    await assertCanonicalParent(homeDir, entry.path);
    if (await lstatOrNull(entry.path)) {
      throw new Error(`rollback target changed before restore: ${entry.path}`);
    }
    temporaryState = await writeNoFollowTemporary(
      homeDir,
      temporary,
      bytes,
      entry.mode,
    );
    await assertNoSymlinkPath(homeDir, entry.path);
    await assertCanonicalParent(homeDir, entry.path);
    if (await lstatOrNull(entry.path)) {
      throw new Error(`rollback target changed during restore: ${entry.path}`);
    }
    await link(temporary, entry.path);
    linked = true;
    const installed = await lstat(entry.path);
    if (
      installed.isSymbolicLink()
      || !installed.isFile()
      || !sameIdentity(temporaryState, installed)
      || (installed.mode & 0o777) !== entry.mode
    ) throw new Error(`rollback restored-file identity mismatch: ${entry.path}`);
    return {
      kind: 'file',
      path: entry.path,
      dev: installed.dev,
      ino: installed.ino,
    };
  } catch (error) {
    if (linked) {
      const installed = await lstatOrNull(entry.path);
      if (
        installed?.isFile()
        && !installed.isSymbolicLink()
        && sameIdentity(temporaryState, installed)
      ) await unlink(entry.path);
    }
    throw error;
  } finally {
    try {
      await unlink(temporary);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

async function replaceCurrent(homeDir, entry, bytes) {
  const temporary = path.join(
    path.dirname(entry.path),
    `.${path.basename(entry.path)}.${crypto.randomUUID()}.rollback`,
  );
  let promoted = false;
  try {
    await assertCanonicalParent(homeDir, entry.path);
    await writeNoFollowTemporary(homeDir, temporary, bytes, entry.mode);
    const { bytes: current, state } = await readRegularFile(
      homeDir,
      entry.path,
      'rollback target changed during restore',
    );
    if (
      state.isSymbolicLink()
      || !state.isFile()
      || sha256(current) !== entry.afterSha256
      || (state.mode & 0o777) !== entry.mode
    ) {
      throw new Error(`rollback target changed during restore: ${entry.path}`);
    }
    await assertCanonicalParent(homeDir, entry.path);
    const latest = await readRegularFile(
      homeDir,
      entry.path,
      'rollback target changed before promotion',
    );
    if (
      !sameIdentity(state, latest.state)
      || sha256(latest.bytes) !== entry.afterSha256
      || (latest.state.mode & 0o777) !== entry.mode
    ) throw new Error(`rollback target changed before promotion: ${entry.path}`);
    await rename(temporary, entry.path);
    promoted = true;
  } finally {
    if (!promoted) {
      try {
        await unlink(temporary);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
}

async function createRestoredSymlink(homeDir, entry) {
  await assertNoSymlinkPath(homeDir, entry.path);
  await assertCanonicalParent(homeDir, entry.path);
  if (await lstatOrNull(entry.path)) {
    throw new Error(`rollback symlink target changed before restore: ${entry.path}`);
  }
  await symlink(entry.target, entry.path);
  const installed = await lstat(entry.path);
  if (!installed.isSymbolicLink() || await readlink(entry.path) !== entry.target) {
    if (installed.isSymbolicLink()) await unlink(entry.path);
    throw new Error(`rollback restored-symlink identity mismatch: ${entry.path}`);
  }
  return { kind: 'symlink', path: entry.path, target: entry.target };
}

async function undoCreated(homeDir, records) {
  const failures = [];
  for (const record of [...records].reverse()) {
    try {
      await assertCanonicalParent(homeDir, record.path);
      const state = await lstatOrNull(record.path);
      if (record.kind === 'file') {
        if (
          !state?.isFile()
          || state.isSymbolicLink()
          || state.dev !== record.dev
          || state.ino !== record.ino
        ) throw new Error('created rollback file identity changed');
      } else if (
        !state?.isSymbolicLink()
        || await readlink(record.path) !== record.target
      ) {
        throw new Error('created rollback symlink identity changed');
      }
      await unlink(record.path);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new Error('rollback failed and its undo journal could not restore pre-rollback state');
  }
}

async function restoreAll(manifest, restored) {
  const journal = [];
  try {
    for (const cleanup of manifest.cleanup.files.filter(({ action }) => action === 'delete')) {
      const entry = manifest.files.find(({ path: target }) => target === cleanup.path);
      journal.push(await createRestoredFile(
        manifest.homeDir,
        entry,
        restored.get(entry.path),
      ));
    }
    for (const entry of manifest.symlinks) {
      journal.push(await createRestoredSymlink(manifest.homeDir, entry));
    }
    for (const cleanup of manifest.cleanup.files.filter(({ action }) => action === 'replace')) {
      const entry = manifest.files.find(({ path: target }) => target === cleanup.path);
      await replaceCurrent(manifest.homeDir, cleanup, restored.get(entry.path));
    }
  } catch (error) {
    try {
      await undoCreated(manifest.homeDir, journal);
    } catch (undoError) {
      undoError.cause = error;
      throw undoError;
    }
    throw error;
  }
}

export async function rollbackMigration(input, dependencies = {}) {
  const homeDir = await canonicalHome(dependencies.homeDir);
  const loaded = await loadManifest(input, homeDir);
  const initialManifest = validateManifest(loaded, homeDir);
  const restored = await reconstructBackups(
    initialManifest,
    homeDir,
    dependencies.readMigratedToken,
  );
  const manifest = await finalPreflight({
    input,
    initialManifest,
    homeDir,
    restored,
    suppliedHome: dependencies.homeDir,
  });
  await restoreAll(manifest, restored);
  // Returned so the CLI has something to format. Returning undefined made
  // `migrate --rollback` throw while rendering its output -- after every file
  // had already been restored -- so a fully successful rollback reported as a
  // crash, which invites the user to "fix" a state that was already correct.
  return {
    rollback: true,
    manifestPath: manifest.manifestPath ?? null,
    restoredPaths: [
      ...manifest.files,
      ...manifest.symlinks,
      ...manifest.jsonEdits,
    ].map((entry) => entry?.path).filter((value) => typeof value === 'string'),
  };
}
