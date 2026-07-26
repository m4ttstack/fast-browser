import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;

function isDirectChild(root, candidate) {
  return path.dirname(candidate) === root;
}

async function existingRealRoot(root) {
  try {
    return await realpath(root);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function removableDirectory(root, name, cutoff) {
  if (!name.startsWith('session-')) return null;
  const candidate = path.join(root, name);
  const state = await lstat(candidate);
  if (state.isSymbolicLink() || !state.isDirectory() || state.mtimeMs >= cutoff) {
    return null;
  }

  const physical = await realpath(candidate);
  if (!isDirectChild(root, physical)) return null;

  const confirmed = await lstat(candidate);
  if (
    confirmed.isSymbolicLink()
    || !confirmed.isDirectory()
    || confirmed.mtimeMs >= cutoff
    || await realpath(candidate) !== physical
  ) {
    return null;
  }
  return candidate;
}

async function directoryBytes(directory) {
  let total = 0;
  for (const name of await readdir(directory)) {
    const entry = path.join(directory, name);
    const state = await lstat(entry);
    if (state.isSymbolicLink()) continue;
    if (state.isDirectory()) {
      total += await directoryBytes(entry);
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

  const roots = await Promise.all([
    existingRealRoot(paths.sessionsDir),
    existingRealRoot(paths.archiveDir),
  ]);
  const cutoff = nowMs - retentionDays * DAY_MS;
  const result = { removedPaths: [], removedBytes: 0 };

  for (const root of roots) {
    if (!root) continue;
    const names = (await readdir(root)).sort();
    for (const name of names) {
      const candidate = await removableDirectory(root, name, cutoff);
      if (!candidate) continue;
      const bytes = await directoryBytes(candidate);
      await rm(candidate, { recursive: true });
      result.removedPaths.push(candidate);
      result.removedBytes += bytes;
    }
  }

  return result;
}
