import crypto from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  readlink,
  rename,
  symlink,
  unlink,
  writeFile,
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
    const state = await lstatOrNull(entry.path);
    if (entry.action === 'delete') {
      await assertNoSymlinkPath(homeDir, entry.path);
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
    if (await lstatOrNull(entry.path)) {
      throw new Error(`rollback collision from post-migration edit: ${entry.path}`);
    }
  }
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

async function createRestoredFile(entry, bytes) {
  const temporary = path.join(
    path.dirname(entry.path),
    `.${path.basename(entry.path)}.${crypto.randomUUID()}.rollback`,
  );
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: entry.mode });
    await chmod(temporary, entry.mode);
    await link(temporary, entry.path);
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
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: entry.mode });
    await chmod(temporary, entry.mode);
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
    await rename(temporary, entry.path);
  } finally {
    try {
      await unlink(temporary);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

async function restoreAll(manifest, restored) {
  const createdFiles = [];
  const createdLinks = [];
  try {
    for (const cleanup of manifest.cleanup.files.filter(({ action }) => action === 'delete')) {
      const entry = manifest.files.find(({ path: target }) => target === cleanup.path);
      await createRestoredFile(entry, restored.get(entry.path));
      createdFiles.push(entry.path);
    }
    for (const entry of manifest.symlinks) {
      await symlink(entry.target, entry.path);
      createdLinks.push(entry.path);
    }
    for (const cleanup of manifest.cleanup.files.filter(({ action }) => action === 'replace')) {
      const entry = manifest.files.find(({ path: target }) => target === cleanup.path);
      await replaceCurrent(manifest.homeDir, cleanup, restored.get(entry.path));
    }
  } catch (error) {
    for (const target of createdLinks.reverse()) {
      try {
        await unlink(target);
      } catch {}
    }
    for (const target of createdFiles.reverse()) {
      try {
        await unlink(target);
      } catch {}
    }
    throw error;
  }
}

export async function rollbackMigration(input, dependencies = {}) {
  const homeDir = await canonicalHome(dependencies.homeDir);
  const loaded = await loadManifest(input, homeDir);
  const manifest = validateManifest(loaded, homeDir);
  await preflightCurrent(manifest, homeDir);
  const restored = await reconstructBackups(
    manifest,
    homeDir,
    dependencies.readMigratedToken,
  );
  await restoreAll(manifest, restored);
}
