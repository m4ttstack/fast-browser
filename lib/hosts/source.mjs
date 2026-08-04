import { realpath } from 'node:fs/promises';
import path from 'node:path';

const GITHUB_SOURCE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:@\S+)?$/;
const HTTPS_GIT_SOURCE = /^https:\/\/\S+$/;
const SSH_GIT_SOURCE = /^(?:ssh:\/\/|git@)\S+$/;

function localInput(source) {
  return (
    source === '.'
    || source === '..'
    || source.startsWith('./')
    || source.startsWith('../')
    || path.isAbsolute(source)
  );
}

export async function normalizeMarketplaceSource(source) {
  if (typeof source !== 'string' || source.length === 0) {
    throw new Error('unsupported marketplace source');
  }
  if (localInput(source)) {
    try {
      return {
        sourceType: 'local',
        source: await realpath(path.resolve(source)),
      };
    } catch {
      throw new Error('local marketplace source is not accessible');
    }
  }
  if (
    GITHUB_SOURCE.test(source)
    || HTTPS_GIT_SOURCE.test(source)
    || SSH_GIT_SOURCE.test(source)
  ) {
    return { sourceType: 'git', source };
  }
  throw new Error('unsupported marketplace source');
}

export async function marketplaceSourceMatches(expected, actualType, actualSource) {
  if (actualType !== expected.sourceType || typeof actualSource !== 'string') return false;
  if (expected.sourceType === 'git') return actualSource === expected.source;
  if (!path.isAbsolute(actualSource)) return false;
  try {
    return await realpath(actualSource) === expected.source;
  } catch {
    return false;
  }
}

export async function localPluginPathMatches(expected, actualPath) {
  if (
    expected.sourceType !== 'local'
    || typeof actualPath !== 'string'
    || !path.isAbsolute(actualPath)
  ) {
    return false;
  }
  // The plugin sits either at the marketplace root (the standalone
  // m4ttstack/fast-browser repo, whose marketplace.json lists it with source
  // ".") or nested at <root>/plugins/fast-browser (the older monorepo layout).
  // Accept those two exact locations; reject anything else, including a path
  // that escapes the marketplace root through a symlink.
  const candidates = [
    expected.source,
    path.join(expected.source, 'plugins', 'fast-browser'),
  ];
  if (!candidates.includes(actualPath)) return false;
  try {
    const canonical = await realpath(actualPath);
    const relative = path.relative(expected.source, canonical);
    return (
      relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    );
  } catch {
    return false;
  }
}
