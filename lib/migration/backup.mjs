import crypto from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import {
  assertConfined,
  assertNoSymlinkPath,
  canonicalHome,
  LEGACY_TOKEN_POINTER,
  locateJsonPointer,
  readRegularFile,
} from './inventory.mjs';

const TOKEN_SENTINEL = '__FAST_BROWSER_MIGRATION_TOKEN_LITERAL__';

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

async function ensurePrivateDirectory(homeDir, target) {
  const pathname = assertConfined(homeDir, target);
  const relative = path.relative(homeDir, pathname);
  let current = homeDir;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const state = await lstatOrNull(current);
    if (!state) {
      await mkdir(current, { mode: 0o700 });
    } else if (state.isSymbolicLink() || !state.isDirectory()) {
      throw new Error(`refusing non-directory backup path: ${current}`);
    }
    await chmod(current, 0o700);
  }
}

function redactTokenTemplate(raw, edit) {
  if (!edit.tokenPointer) return { bytes: Buffer.from(raw), redactions: [], token: null };
  if (edit.tokenPointer !== LEGACY_TOKEN_POINTER) {
    throw new Error('unsupported migration token pointer');
  }
  const location = locateJsonPointer(raw, edit.tokenPointer);
  if (!location || location.node.type !== 'scalar') {
    throw new Error('legacy token must have one exact canonical token literal');
  }
  const literal = raw.slice(location.node.start, location.node.end);
  let token;
  try {
    token = JSON.parse(literal);
  } catch {
    throw new Error('legacy token must have one exact canonical token literal');
  }
  if (typeof token !== 'string' || JSON.stringify(token) !== literal) {
    throw new Error('legacy token must have one exact canonical token literal');
  }
  let occurrences = 0;
  let offset = 0;
  while ((offset = raw.indexOf(literal, offset)) !== -1) {
    occurrences += 1;
    offset += literal.length;
  }
  if (occurrences !== 1) throw new Error('ambiguous token literal in legacy JSON');
  const sentinelLiteral = JSON.stringify(TOKEN_SENTINEL);
  if (raw.includes(sentinelLiteral)) throw new Error('ambiguous migration token sentinel');
  const template = raw.slice(0, location.node.start)
    + sentinelLiteral
    + raw.slice(location.node.end);
  return {
    bytes: Buffer.from(template),
    redactions: [{
      pointer: edit.tokenPointer,
      sentinel: TOKEN_SENTINEL,
    }],
    token,
  };
}

function backupName(index, source) {
  return `${String(index).padStart(3, '0')}-${path.basename(source)}`;
}

export async function createMigrationBackup(inventory, paths = {}) {
  const homeDir = await canonicalHome(paths.homeDir ?? inventory?.homeDir);
  if (inventory?.schemaVersion !== 1 || inventory.homeDir !== homeDir) {
    throw new Error('invalid migration inventory home or schema');
  }
  const migrationId = paths.migrationId ?? crypto.randomUUID();
  if (!/^[A-Za-z0-9._-]+$/.test(migrationId)) throw new Error('invalid migration id');
  const backupsDir = assertConfined(
    homeDir,
    paths.backupsDir ?? path.join(homeDir, '.fast-browser', 'backups'),
  );
  const backupDir = path.join(backupsDir, `migration-${migrationId}`);
  const manifestPath = path.join(backupDir, 'manifest.json');
  if (await lstatOrNull(backupDir)) throw new Error('migration backup already exists');

  const prepared = [];
  let legacyToken = null;
  for (const [index, entry] of inventory.files.entries()) {
    const target = assertConfined(homeDir, entry.path);
    const { bytes, state } = await readRegularFile(
      homeDir,
      target,
      'migration backup source must be a regular file',
    );
    if (
      sha256(bytes) !== entry.sha256
      || (state.mode & 0o777) !== entry.mode
    ) {
      throw new Error(`migration inventory changed before backup: ${target}`);
    }
    const edit = inventory.jsonEdits.find((candidate) => candidate.path === target);
    const template = edit
      ? redactTokenTemplate(bytes.toString('utf8'), edit)
      : { bytes, redactions: [], token: null };
    if (template.token !== null) legacyToken = template.token;
    prepared.push({
      path: target,
      sha256: entry.sha256,
      backupPath: path.join(backupDir, backupName(index, target)),
      mode: entry.mode,
      backupSha256: sha256(template.bytes),
      redactions: template.redactions,
      bytes: template.bytes,
    });
  }
  if (
    legacyToken !== null
    && prepared.some(({ bytes }) => bytes.includes(legacyToken))
  ) {
    legacyToken = null;
    throw new Error('legacy token appears outside its canonical JSON literal');
  }
  legacyToken = null;

  await ensurePrivateDirectory(homeDir, backupsDir);
  await mkdir(backupDir, { mode: 0o700 });
  try {
    for (const entry of prepared) {
      await writeFile(entry.backupPath, entry.bytes, {
        flag: 'wx',
        mode: 0o600,
      });
      await chmod(entry.backupPath, 0o600);
    }
    const createdAt = (paths.now?.() ?? new Date()).toISOString();
    const manifest = {
      schemaVersion: 1,
      createdAt,
      homeDir,
      backupDir,
      manifestPath,
      files: prepared.map(({ bytes, ...entry }) => entry),
      jsonEdits: structuredClone(inventory.jsonEdits),
      symlinks: structuredClone(inventory.symlinks),
      cleanup: null,
    };
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(manifestPath, serialized, { flag: 'wx', mode: 0o600 });
    await chmod(manifestPath, 0o600);
    return manifest;
  } catch (error) {
    await rm(backupDir, { recursive: true, force: true });
    throw error;
  }
}
