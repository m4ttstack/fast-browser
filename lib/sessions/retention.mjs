import { lstat, readdir, realpath, rm, unlink } from 'node:fs/promises';
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

// sessions/ and archive/ hold only session-* transcripts (imported by
// migrate), so only those names are candidates there. The runtime's
// --output-dir is wholly runtime-owned, so every direct entry is a candidate
// by age alone; videos/ inside it gets the same treatment one level down
// because its own mtime moves with each recording and would otherwise
// shelter old ones.
async function validateRoots(paths) {
  const logicalData = path.resolve(paths.dataDir);
  const expected = {
    sessions: path.join(logicalData, 'sessions'),
    archive: path.join(logicalData, 'archive'),
    output: path.join(logicalData, 'output'),
    videos: path.join(logicalData, 'output', 'videos'),
  };
  if (
    path.resolve(paths.sessionsDir) !== expected.sessions
    || path.resolve(paths.archiveDir) !== expected.archive
    || path.resolve(paths.outputDir) !== expected.output
    || path.resolve(paths.videosDir) !== expected.videos
  ) {
    throw new Error('session roots must be exact children of the Fast Browser data directory');
  }

  const data = await validateRealDirectory(logicalData, 'data');
  if (!data) throw new Error('data root must be a real directory');
  const [sessions, archive, output] = await Promise.all([
    validateRealDirectory(expected.sessions, 'sessions'),
    validateRealDirectory(expected.archive, 'archive'),
    validateRealDirectory(expected.output, 'output'),
  ]);
  const videos = output ? await validateRealDirectory(expected.videos, 'videos') : null;
  const roots = [
    sessions && { ...sessions, parent: data, sessionsOnly: true },
    archive && { ...archive, parent: data, sessionsOnly: true },
    output && { ...output, parent: data, sessionsOnly: false },
    videos && { ...videos, parent: output, sessionsOnly: false },
  ];
  for (const root of roots) {
    if (root && path.dirname(root.physical) !== root.parent.physical) {
      throw new Error(`${root.label} root must be an exact child of the physical ${root.parent.label} directory`);
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
  if (root.sessionsOnly && !name.startsWith('session-')) return null;
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

async function removableFile(root, name, cutoff) {
  if (root.sessionsOnly) return null;
  const logical = path.join(root.logical, name);
  const state = await lstatOrNull(logical);
  if (!state || state.isSymbolicLink() || !state.isFile() || state.mtimeMs >= cutoff) {
    return null;
  }
  const physical = await realpath(logical);
  if (path.dirname(physical) !== root.physical) return null;
  const confirmed = await lstat(logical);
  if (
    confirmed.isSymbolicLink()
    || !confirmed.isFile()
    || confirmed.mtimeMs >= cutoff
    || !sameIdentity(state, confirmed)
  ) {
    return null;
  }
  return { logical, physical, state: confirmed, label: 'file candidate' };
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

export async function pruneSessions({ paths, now, retentionDays, deps = {} }) {
  const confirmStat = deps.lstat ?? lstat;
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
      const directory = await removableDirectory(root, name, cutoff);
      const candidate = directory ?? await removableFile(root, name, cutoff);
      if (!candidate) continue;
      let bytes;
      try {
        bytes = directory
          ? await directoryBytes(candidate.logical, candidate.physical)
          : candidate.state.size;
        await revalidateDirectory(data);
        await revalidateDirectory(root);
        const confirmed = await confirmStat(candidate.logical);
        if (
          confirmed.isSymbolicLink()
          || (directory ? !confirmed.isDirectory() : !confirmed.isFile())
          || !sameIdentity(confirmed, candidate.state)
          || await realpath(candidate.logical) !== candidate.physical
        ) {
          throw new Error('session candidate changed before removal');
        }
        if (directory) await rm(candidate.logical, { recursive: true });
        else await unlink(candidate.logical);
      } catch (error) {
        // A concurrent pruner (a second MCP server launching) got there
        // first; nothing is left to remove or to count.
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      result.removedPaths.push(candidate.physical);
      result.removedBytes += bytes;
    }
  }
  return result;
}
