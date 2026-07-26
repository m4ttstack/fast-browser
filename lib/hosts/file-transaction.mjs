import crypto from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import path from 'node:path';

const PREFLIGHT_FAILED = 'routing transaction preflight failed';
const APPLY_FAILED = 'routing transaction apply failed';
const RECOVERY_REQUIRED = 'routing transaction recovery required';
const ALREADY_CONSUMED = 'routing transaction already consumed';
const changeHomes = new WeakMap();

function transactionError(message) {
  return new Error(message);
}

function stateAtSync(target) {
  try {
    return lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function stateAt(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function relativeTarget(home, target) {
  const relative = path.relative(home, target);
  if (
    relative === ''
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error('unconfined target');
  }
  return relative;
}

function assertSafeTargetSync(home, target) {
  const relative = relativeTarget(home, target);
  const components = relative.split(path.sep);
  let current = home;
  for (let index = 0; index <= components.length; index += 1) {
    const state = stateAtSync(current);
    if (!state) return;
    if (state.isSymbolicLink()) throw new Error('symlink target');
    const leaf = index === components.length;
    if (leaf ? !state.isFile() : !state.isDirectory()) {
      throw new Error('non-regular target');
    }
    if (leaf) return;
    current = path.join(current, components[index]);
  }
}

async function assertSafeTarget(home, target) {
  const relative = relativeTarget(home, target);
  const components = relative.split(path.sep);
  let current = home;
  for (let index = 0; index <= components.length; index += 1) {
    const state = await stateAt(current);
    if (!state) return;
    if (state.isSymbolicLink()) throw new Error('symlink target');
    const leaf = index === components.length;
    if (leaf ? !state.isFile() : !state.isDirectory()) {
      throw new Error('non-regular target');
    }
    if (leaf) return;
    current = path.join(current, components[index]);
  }
}

function cloneSnapshot(snapshot) {
  if (
    !snapshot
    || typeof snapshot !== 'object'
    || typeof snapshot.exists !== 'boolean'
    || (snapshot.exists && !Buffer.isBuffer(snapshot.bytes))
    || (!snapshot.exists && snapshot.bytes !== null)
  ) {
    throw new Error('invalid snapshot');
  }
  return Object.freeze({
    exists: snapshot.exists,
    bytes: snapshot.exists ? Buffer.from(snapshot.bytes) : null,
  });
}

function snapshotsEqual(left, right) {
  return left.exists === right.exists
    && (left.exists ? left.bytes.equals(right.bytes) : left.bytes === null);
}

function registerChange(home, change) {
  changeHomes.set(change, home);
  return change;
}

function inverseChange(change) {
  const home = changeHomes.get(change);
  return registerChange(home, Object.freeze({
    path: change.path,
    before: change.after,
    after: change.before,
  }));
}

async function ensureParentDirectories(home, target) {
  const parent = path.dirname(target);
  const missing = [];
  let current = parent;
  while (current !== home) {
    const state = await stateAt(current);
    if (state) break;
    missing.push(current);
    current = path.dirname(current);
  }
  await mkdir(parent, { recursive: true, mode: 0o700 });
  for (const directory of missing) await chmod(directory, 0o700);
}

async function atomicWrite(change) {
  const home = changeHomes.get(change);
  await assertSafeTarget(home, change.path);
  await ensureParentDirectories(home, change.path);
  await assertSafeTarget(home, change.path);
  const temporary = path.join(
    path.dirname(change.path),
    `.${path.basename(change.path)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, change.after.bytes, {
      flag: 'wx',
      mode: 0o600,
    });
    await chmod(temporary, 0o600);
    await rename(temporary, change.path);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') throw cleanupError;
    }
    throw error;
  }
}

export const nodeFileTransactionIo = Object.freeze({
  async snapshot(change) {
    const home = changeHomes.get(change);
    await assertSafeTarget(home, change.path);
    const state = await stateAt(change.path);
    if (!state) return { exists: false, bytes: null };
    return { exists: true, bytes: await readFile(change.path) };
  },

  async mutate(change) {
    if (change.after.exists) {
      await atomicWrite(change);
      return;
    }
    const home = changeHomes.get(change);
    await assertSafeTarget(home, change.path);
    const state = await stateAt(change.path);
    if (!state?.isFile() || state.isSymbolicLink()) {
      throw new Error('target is not an exact regular-file leaf');
    }
    await unlink(change.path);
  },
});

async function matchesCurrent(io, change, expected) {
  const current = await io.snapshot(change);
  return snapshotsEqual(current, expected);
}

async function preflight(io, changes) {
  for (const change of changes) {
    if (!await matchesCurrent(io, change, change.before)) {
      throw new Error('snapshot changed');
    }
  }
}

async function recover(io, applied, failedChange) {
  const changed = [...applied];
  if (failedChange) {
    const current = await io.snapshot(failedChange);
    if (snapshotsEqual(current, failedChange.after)) changed.push(failedChange);
    else if (!snapshotsEqual(current, failedChange.before)) return false;
  }
  const inverse = changed.reverse().map(inverseChange);
  await preflight(io, inverse);
  for (const change of inverse) {
    if (!await matchesCurrent(io, change, change.before)) return false;
    await io.mutate(change);
  }
  return true;
}

function reciprocalReceipt(home, changes, io) {
  const inverse = changes.map(inverseChange);
  return Object.freeze({
    rollback: singleUseApply(home, inverse, io),
  });
}

async function execute(home, changes, io) {
  try {
    await preflight(io, changes);
  } catch {
    throw transactionError(PREFLIGHT_FAILED);
  }

  const applied = [];
  for (const change of changes) {
    let mutationStarted = false;
    try {
      if (!await matchesCurrent(io, change, change.before)) {
        throw new Error('snapshot changed');
      }
      mutationStarted = true;
      await io.mutate(change);
      applied.push(change);
    } catch {
      try {
        if (!await recover(io, applied, mutationStarted ? change : null)) {
          throw new Error('recovery validation failed');
        }
      } catch {
        throw transactionError(RECOVERY_REQUIRED);
      }
      throw transactionError(APPLY_FAILED);
    }
  }
  return reciprocalReceipt(home, changes, io);
}

function singleUseApply(home, changes, io) {
  let consumed = false;
  return async function apply() {
    if (consumed) throw transactionError(ALREADY_CONSUMED);
    consumed = true;
    return execute(home, changes, io);
  };
}

export function prepareFileTransaction({
  home,
  changes,
  io = nodeFileTransactionIo,
}) {
  try {
    if (
      typeof home !== 'string'
      || !path.isAbsolute(home)
      || !Array.isArray(changes)
      || !io
      || typeof io.snapshot !== 'function'
      || typeof io.mutate !== 'function'
    ) {
      throw new Error('invalid transaction');
    }
    const resolvedHome = path.resolve(home);
    const seen = new Set();
    const prepared = changes.map((change) => {
      if (
        !change
        || typeof change !== 'object'
        || typeof change.path !== 'string'
        || !path.isAbsolute(change.path)
        || path.resolve(change.path) !== change.path
        || seen.has(change.path)
      ) {
        throw new Error('invalid change');
      }
      seen.add(change.path);
      assertSafeTargetSync(resolvedHome, change.path);
      return registerChange(resolvedHome, Object.freeze({
        path: change.path,
        before: cloneSnapshot(change.before),
        after: cloneSnapshot(change.after),
      }));
    });
    prepared.sort((left, right) => (
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    ));
    return Object.freeze({
      apply: singleUseApply(resolvedHome, prepared, io),
    });
  } catch {
    throw transactionError(PREFLIGHT_FAILED);
  }
}
