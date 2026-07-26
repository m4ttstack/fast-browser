import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export class PathConfinementError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PathConfinementError';
  }
}

function isDescendant(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

async function physicalLocation(target) {
  const missing = [];
  let current = target;
  while (true) {
    try {
      const physical = await realpath(current);
      return path.join(physical, ...missing.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new PathConfinementError(`unable to resolve confinement root ${target}`);
    }
    missing.push(path.basename(current));
    current = parent;
  }
}

async function existingState(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function assertConfinedPath({ dataDir, rootDir, candidate }) {
  const logicalData = path.resolve(dataDir);
  const logicalRoot = path.resolve(rootDir);
  const logicalCandidate = path.resolve(candidate);
  if (!isDescendant(logicalData, logicalRoot)) {
    throw new PathConfinementError('artifact root must be a descendant confined within dataDir');
  }
  if (!isDescendant(logicalRoot, logicalCandidate)) {
    throw new PathConfinementError('artifact path must be a descendant confined within its root');
  }

  const physicalData = await physicalLocation(logicalData);
  const relative = path.relative(logicalData, logicalCandidate);
  const components = relative.split(path.sep);
  let current = logicalData;
  for (const component of ['', ...components]) {
    if (component) current = path.join(current, component);
    const state = await existingState(current);
    if (!state) continue;
    if (state.isSymbolicLink()) {
      throw new PathConfinementError(`refusing symlink in confined artifact path: ${current}`);
    }
    const physical = await realpath(current);
    if (physical !== physicalData && !isDescendant(physicalData, physical)) {
      throw new PathConfinementError(`artifact path resolves outside physical dataDir: ${current}`);
    }
  }

  return logicalCandidate;
}
