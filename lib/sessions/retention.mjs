import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

async function lstatOrNull(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function validateRealDirectory(target, label) {
  const state = await lstatOrNull(target);
  if (!state) return null;
  if (state.isSymbolicLink() || !state.isDirectory()) {
    throw new Error(`${label} root must be a real directory`);
  }
  const physical = await realpath(target);
  const confirmed = await lstat(target);
  if (!sameIdentity(state, confirmed) || confirmed.isSymbolicLink() || !confirmed.isDirectory()) {
    throw new Error(`${label} root changed during validation`);
  }
  return { logical: target, physical, state: confirmed, label };
}

async function validateRoots(paths) {
  const logicalData = path.resolve(paths.dataDir);
  const expected = {
    sessions: path.join(logicalData, 'sessions'),
    archive: path.join(logicalData, 'archive'),
  };
  if (
    path.resolve(paths.sessionsDir) !== expected.sessions
    || path.resolve(paths.archiveDir) !== expected.archive
  ) {
    throw new Error('session roots must be exact children of the Fast Browser data directory');
  }

  const data = await validateRealDirectory(logicalData, 'data');
  if (!data) throw new Error('data root must be a real directory');
  const roots = await Promise.all([
    validateRealDirectory(expected.sessions, 'sessions'),
    validateRealDirectory(expected.archive, 'archive'),
  ]);
  for (const root of roots) {
    if (root && path.dirname(root.physical) !== data.physical) {
      throw new Error(`${root.label} root must be an exact child of the physical data directory`);
    }
  }
  return { data, roots };
}

async function revalidateDirectory(directory) {
  const state = await lstat(directory.logical);
  if (
    state.isSymbolicLink()
    || !state.isDirectory()
    || !sameIdentity(state, directory.state)
    || await realpath(directory.logical) !== directory.physical
  ) {
    throw new Error(`${directory.label} root changed before session removal`);
  }
}

async function removableDirectory(root, name, cutoff) {
  if (!name.startsWith('session-')) return null;
  const logical = path.join(root.logical, name);
  const state = await lstatOrNull(logical);
  if (!state || state.isSymbolicLink() || !state.isDirectory() || state.mtimeMs >= cutoff) {
    return null;
  }
  const physical = await realpath(logical);
  if (path.dirname(physical) !== root.physical) return null;
  const confirmed = await lstat(logical);
  if (
    confirmed.isSymbolicLink()
    || !confirmed.isDirectory()
    || confirmed.mtimeMs >= cutoff
    || !sameIdentity(state, confirmed)
    || await realpath(logical) !== physical
  ) {
    return null;
  }
  return { logical, physical, state: confirmed, label: 'session candidate' };
}

async function directoryBytes(directory, candidateRoot) {
  let total = 0;
  for (const name of await readdir(directory)) {
    const entry = path.join(directory, name);
    const state = await lstat(entry);
    if (state.isSymbolicLink()) continue;
    if (state.isDirectory()) {
      const physical = await realpath(entry);
      if (!isWithin(candidateRoot, physical)) continue;
      const confirmed = await lstat(entry);
      if (!sameIdentity(state, confirmed) || confirmed.isSymbolicLink()) continue;
      total += await directoryBytes(entry, candidateRoot);
    } else if (state.isFile()) {
      total += state.size;
    }
  }
  return total;
}

export async function pruneSessions({ paths, now, retentionDays }) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) throw new TypeError('now must be a valid date or timestamp');
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new TypeError('retentionDays must be a positive integer');
  }

  const { data, roots } = await validateRoots(paths);
  const cutoff = nowMs - retentionDays * DAY_MS;
  const result = { removedPaths: [], removedBytes: 0 };

  for (const root of roots) {
    if (!root) continue;
    const names = (await readdir(root.logical)).sort();
    for (const name of names) {
      await revalidateDirectory(data);
      await revalidateDirectory(root);
      const candidate = await removableDirectory(root, name, cutoff);
      if (!candidate) continue;
      const bytes = await directoryBytes(candidate.logical, candidate.physical);
      await revalidateDirectory(data);
      await revalidateDirectory(root);
      const confirmed = await lstat(candidate.logical);
      if (
        confirmed.isSymbolicLink()
        || !confirmed.isDirectory()
        || !sameIdentity(confirmed, candidate.state)
        || await realpath(candidate.logical) !== candidate.physical
      ) {
        throw new Error('session candidate changed before removal');
      }
      await rm(candidate.logical, { recursive: true });
      result.removedPaths.push(candidate.physical);
      result.removedBytes += bytes;
    }
  }
  return result;
}
