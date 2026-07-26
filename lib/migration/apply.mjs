import crypto from 'node:crypto';
import {
  chmod,
  lstat,
  readlink,
  rename,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { createMigrationBackup } from './backup.mjs';
import { importLegacyData } from './import-data.mjs';
import {
  assertConfined,
  LEGACY_TOKEN_POINTER,
  locateJsonPointer,
  inventoryLegacy,
  readRegularFile,
  removeJsonPointer,
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

export class MigrationError extends Error {
  constructor(message, { stage, partialState = null } = {}) {
    super(message);
    this.name = 'MigrationError';
    this.stage = stage;
    this.partialState = partialState;
  }
}

async function readLegacyToken(inventory) {
  const edit = inventory.jsonEdits.find(({ tokenPointer }) => tokenPointer);
  if (!edit) return null;
  if (edit.tokenPointer !== LEGACY_TOKEN_POINTER) {
    throw new Error('unsupported legacy token pointer');
  }
  const { bytes } = await readRegularFile(inventory.homeDir, edit.path);
  const raw = bytes.toString('utf8');
  const location = locateJsonPointer(raw, edit.tokenPointer);
  if (!location) throw new Error('legacy token disappeared before migration');
  const literal = raw.slice(location.node.start, location.node.end);
  const value = JSON.parse(literal);
  if (typeof value !== 'string' || JSON.stringify(value) !== literal) {
    throw new Error('legacy token is not one canonical JSON literal');
  }
  return value;
}

async function preflightCleanup(inventory) {
  const filePlans = [];
  for (const entry of inventory.files) {
    const { bytes, state } = await readRegularFile(
      inventory.homeDir,
      entry.path,
      'cleanup preflight requires an unchanged regular file',
    );
    if (
      sha256(bytes) !== entry.sha256
      || (state.mode & 0o777) !== entry.mode
    ) {
      throw new Error(`cleanup preflight hash or mode mismatch: ${entry.path}`);
    }
    const edit = inventory.jsonEdits.find(({ path: target }) => target === entry.path);
    if (edit) {
      const cleaned = Buffer.from(removeJsonPointer(bytes.toString('utf8'), edit.pointer));
      filePlans.push({
        path: entry.path,
        action: 'replace',
        beforeSha256: entry.sha256,
        afterSha256: sha256(cleaned),
        mode: entry.mode,
        bytes: cleaned,
      });
    } else {
      filePlans.push({
        path: entry.path,
        action: 'delete',
        beforeSha256: entry.sha256,
        afterSha256: null,
        mode: entry.mode,
      });
    }
  }
  const symlinkPlans = [];
  for (const entry of inventory.symlinks) {
    const state = await lstatOrNull(entry.path);
    if (!state?.isSymbolicLink() || await readlink(entry.path) !== entry.target) {
      throw new Error(`cleanup preflight symlink mismatch: ${entry.path}`);
    }
    symlinkPlans.push({ ...entry, action: 'delete' });
  }
  return { files: filePlans, symlinks: symlinkPlans };
}

async function writePrivateJson(target, value, { createOnly = false } = {}) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  if (createOnly) {
    await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    await chmod(target, 0o600);
    return;
  }
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
    await chmod(target, 0o600);
  } finally {
    try {
      await unlink(temporary);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

async function replaceUnchanged(homeDir, plan) {
  const { bytes: current, state } = await readRegularFile(
    homeDir,
    plan.path,
    'cleanup target changed after preflight',
  );
  if (sha256(current) !== plan.beforeSha256 || (state.mode & 0o777) !== plan.mode) {
    throw new Error(`cleanup target changed after preflight: ${plan.path}`);
  }
  const temporary = path.join(
    path.dirname(plan.path),
    `.${path.basename(plan.path)}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, plan.bytes, { flag: 'wx', mode: plan.mode });
    await chmod(temporary, plan.mode);
    const { bytes: latest, state: latestState } = await readRegularFile(
      homeDir,
      plan.path,
      'cleanup target changed during replacement',
    );
    if (sha256(latest) !== plan.beforeSha256) {
      throw new Error(`cleanup target changed during replacement: ${plan.path}`);
    }
    if ((latestState.mode & 0o777) !== plan.mode) {
      throw new Error(`cleanup target mode changed during replacement: ${plan.path}`);
    }
    await rename(temporary, plan.path);
  } finally {
    try {
      await unlink(temporary);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

async function restoreDeleted(homeDir, plan, backup) {
  if (await lstatOrNull(plan.path)) return;
  const { bytes } = await readRegularFile(homeDir, backup.backupPath);
  if (sha256(bytes) !== backup.sha256) {
    throw new Error('unable to restore cleanup after backup mismatch');
  }
  await writeFile(plan.path, bytes, { flag: 'wx', mode: plan.mode });
  await chmod(plan.path, plan.mode);
}

async function performCleanup(cleanup, backup) {
  const deletedFiles = [];
  const deletedLinks = [];
  try {
    for (const plan of cleanup.files.filter(({ action }) => action === 'delete')) {
      const { bytes, state } = await readRegularFile(
        backup.homeDir,
        plan.path,
        'cleanup target changed after preflight',
      );
      if (sha256(bytes) !== plan.beforeSha256 || (state.mode & 0o777) !== plan.mode) {
        throw new Error(`cleanup target changed after preflight: ${plan.path}`);
      }
      await unlink(plan.path);
      deletedFiles.push(plan);
    }
    for (const plan of cleanup.symlinks) {
      const state = await lstatOrNull(plan.path);
      if (!state?.isSymbolicLink() || await readlink(plan.path) !== plan.target) {
        throw new Error(`cleanup symlink changed after preflight: ${plan.path}`);
      }
      await unlink(plan.path);
      deletedLinks.push(plan);
    }
    for (const plan of cleanup.files.filter(({ action }) => action === 'replace')) {
      await replaceUnchanged(backup.homeDir, plan);
    }
  } catch (error) {
    for (const plan of deletedFiles.reverse()) {
      const stored = backup.files.find(({ path: target }) => target === plan.path);
      await restoreDeleted(backup.homeDir, plan, stored);
    }
    for (const plan of deletedLinks.reverse()) {
      if (!await lstatOrNull(plan.path)) await symlink(plan.target, plan.path);
    }
    throw error;
  }
}

function publicCleanup(cleanup) {
  return {
    files: cleanup.files.map(({ bytes, ...entry }) => entry),
    symlinks: cleanup.symlinks,
  };
}

function partialImports(importResult) {
  if (!importResult) return null;
  return {
    importedPaths: [
      ...importResult.macros.map(({ path: target }) => target),
      ...(importResult.macroIndex ? [importResult.macroIndex] : []),
      ...(importResult.failureRecord ? [importResult.failureRecord] : []),
      ...importResult.sessions.map(({ path: target }) => target),
      ...importResult.archive.map(({ path: target }) => target),
    ],
  };
}

export async function applyMigration({
  paths,
  now,
  migrationId,
  writeMigratedToken,
  installAdaptersAndRouting,
  cleanupInstalled,
  verify,
}) {
  let stage = 'inventory';
  let importResult = null;
  let installedState = null;
  let adapterAttempted = false;
  try {
    const inventory = await inventoryLegacy(paths);
    stage = 'backup';
    const backup = await createMigrationBackup(inventory, {
      ...paths,
      now,
      migrationId,
    });
    stage = 'import';
    importResult = await importLegacyData({ inventory, paths });

    stage = 'token';
    let legacyToken = await readLegacyToken(inventory);
    if (legacyToken !== null) {
      if (typeof writeMigratedToken !== 'function') {
        throw new Error('secure migrated-token writer is required');
      }
      try {
        await writeMigratedToken(legacyToken);
      } finally {
        legacyToken = null;
      }
    }

    stage = 'install';
    adapterAttempted = true;
    installedState = await installAdaptersAndRouting();
    stage = 'verify';
    await verify();

    stage = 'cleanup-preflight';
    const cleanup = await preflightCleanup(inventory);
    const rollbackManifestPath = assertConfined(
      inventory.homeDir,
      path.join(backup.backupDir, 'rollback.json'),
    );
    const rollbackManifest = {
      ...backup,
      manifestPath: rollbackManifestPath,
      state: 'prepared',
      cleanup: publicCleanup(cleanup),
    };
    await writePrivateJson(rollbackManifestPath, rollbackManifest, { createOnly: true });

    stage = 'cleanup';
    await performCleanup(cleanup, backup);
    return {
      changed: cleanup.files.length > 0 || cleanup.symlinks.length > 0,
      imported: importResult,
      backupManifestPath: backup.manifestPath,
      rollbackManifestPath,
      rollbackCommand: `fast-browser migrate --rollback ${rollbackManifestPath}`,
    };
  } catch (cause) {
    let cleanupFailed = false;
    if (adapterAttempted && typeof cleanupInstalled === 'function') {
      try {
        const cleanupState = installedState === null
          ? cause?.partialState ?? null
          : installedState;
        await cleanupInstalled(cleanupState);
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) {
      throw new MigrationError('migration recovery required after installed-state cleanup failed', {
        stage: 'recovery',
      });
    }
    const message = stage === 'cleanup-preflight'
      ? 'migration cleanup preflight failed; legacy setup remains active'
      : stage === 'cleanup'
        ? 'migration cleanup failed; rollback data remains available'
        : 'legacy migration failed before cleanup; legacy setup remains active';
    throw new MigrationError(message, {
      stage,
      partialState: partialImports(importResult),
    });
  }
}
