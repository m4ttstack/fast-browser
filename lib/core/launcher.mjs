import crypto from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

// The PATH launcher shim: a three-line /bin/sh script at
// <home>/.local/bin/fast-browser that execs the plugin's real entry point, so
// the bare `fast-browser <cmd>` the skills document works without npx's
// cold-cache fetch and approval prompt.
//
// The shim embeds an absolute plugin root, which goes stale whenever the
// plugin moves (a deleted worktree stranded exactly such a root during this
// feature's own development). Rewriting on every setup run is what makes an
// absolute-path shim safe to have at all: it is never more than one setup
// behind the installation it launches, and doctor's `launcher` check catches
// the window in between.

// One fixed marker line identifies a shim this project wrote. Classification
// hangs off it entirely: a file carrying the marker is ours to rewrite or
// remove, and a file without it is somebody's unrelated `fast-browser`
// binary that must never be touched, no matter how it got there.
export const LAUNCHER_MARKER =
  '# Managed by fast-browser setup; rewritten on every setup run. Do not edit.';

// /usr/bin/env resolves node from the caller's PATH at run time, so
// nvm-style setups that swap node per shell keep working; a hardcoded node
// path would freeze whichever install happened to be active when setup ran.
export function launcherShimText(pluginRoot) {
  const entry = path.join(path.resolve(pluginRoot), 'bin', 'fast-browser.mjs');
  // Refused, not escaped. A double quote breaks out of the exec line's own
  // quoting and a dollar sign expands at shim run time, and in both cases
  // doctor's stale-target check reads the literal parsed path and reports
  // PASS while the shim runs something else. Escaping correctly across /bin/sh
  // dialects buys support for paths nobody has, at the price of a quoting bug
  // nobody would see; a checkout at such a path gets a clear refusal instead.
  if (entry.includes('"') || entry.includes('$') || entry.includes('\\') || entry.includes('\n')) {
    throw new Error('the plugin path cannot be quoted safely in a shell launcher');
  }
  return `#!/bin/sh\n${LAUNCHER_MARKER}\nexec /usr/bin/env node "${entry}" "$@"\n`;
}

const EXEC_LINE = /^exec \/usr\/bin\/env node "(.+)" "\$@"$/m;

// mattstack.app owns the launcher path when it exposes its bundled copy there
// (`rt deps link fast-browser`): either rt's tagged wrapper, whose exec line
// single-quotes the bundled node and entry point, or a plain symlink. Setup
// leaves either alone and doctor passes it, so the two installers never
// fight over one file.
const MATTSTACK_LINK_TAG = '# mattstack-link: fast-browser';
const MATTSTACK_EXEC_LINE = /^exec ((?:'(?:[^']|'\\'')*' )+)"\$@"$/m;
const MATTSTACK_BUNDLE_SEGMENT = /\.app\/Contents\/Helpers\//;
const PRODUCT_NAME = '@mattstack/fast-browser';

function singleQuotedArguments(text) {
  return [...text.matchAll(/'((?:[^']|'\\'')*)'/g)].map((match) => match[1].replaceAll("'\\''", "'"));
}

async function isSameProductEntry(entry) {
  if (path.basename(entry) !== 'fast-browser.mjs' || path.basename(path.dirname(entry)) !== 'bin') {
    return false;
  }
  try {
    const manifest = JSON.parse(await readFile(path.join(entry, '..', '..', 'package.json'), 'utf8'));
    return manifest?.name === PRODUCT_NAME;
  } catch {
    return false;
  }
}

async function allExist(files) {
  try {
    await Promise.all(files.map((file) => access(file)));
    return true;
  } catch {
    return false;
  }
}

function managerOf(target) {
  return MATTSTACK_BUNDLE_SEGMENT.test(target) ? 'mattstack' : null;
}

// Returns { status: 'external' | 'external-stale', manager } for a launcher
// another installer of this same product put in place, else null.
async function classifyExternal(target, state, text) {
  if (state.isSymbolicLink()) {
    let resolved;
    try {
      resolved = await realpath(target);
    } catch {
      const pointsAt = await readlink(target);
      return managerOf(pointsAt) === 'mattstack' ? { status: 'external-stale', manager: 'mattstack' } : null;
    }
    return await isSameProductEntry(resolved) ? { status: 'external', manager: managerOf(resolved) } : null;
  }
  if (text.split('\n')[1] !== MATTSTACK_LINK_TAG) return null;
  const quoted = text.match(MATTSTACK_EXEC_LINE)?.[1];
  const argv = quoted ? singleQuotedArguments(quoted) : [];
  if (argv.length === 0) return null;
  if (!await allExist(argv)) return { status: 'external-stale', manager: 'mattstack' };
  return await isSameProductEntry(argv.at(-1)) ? { status: 'external', manager: 'mattstack' } : null;
}

function launcherLocation(paths) {
  const target = paths.launcherFile;
  if (typeof target !== 'string' || typeof paths.launcherDir !== 'string') {
    throw new Error('launcher paths are unavailable');
  }
  return { target, directory: paths.launcherDir };
}

async function lstatOrNull(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function isManagedShim(text) {
  return text.split('\n').includes(LAUNCHER_MARKER);
}

// Staged sibling plus rename so a shell resolving the shim mid-write never
// executes a half-written file.
async function writeShim(target, text) {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, text, { flag: 'wx', mode: 0o755 });
    await rename(temporary, target);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch (cleanupError) {
      if (cleanupError?.code !== 'ENOENT') error.cleanupError = cleanupError;
    }
    throw error;
  }
}

// Same vocabulary and same purpose as macrosWereWritten: `installed` and
// `refreshed` put bytes on disk, `current`, `preserved` and `external` touch
// nothing, and a caller computing `changed` must ask rather than assume a
// call wrote.
export function launcherWasWritten(report) {
  return report?.action === 'installed' || report?.action === 'refreshed';
}

export async function installLauncher(paths) {
  const { target, directory } = launcherLocation(paths);
  if (typeof paths.pluginRoot !== 'string') {
    throw new Error('launcher plugin root is unavailable');
  }
  const desired = launcherShimText(paths.pluginRoot);
  // ~/.local/bin is a shared user directory other tools install into, not one
  // of our private data dirs: create it world-traversable and never chmod an
  // existing one, since retightening a directory we do not own would break
  // its other occupants.
  await mkdir(directory, { recursive: true, mode: 0o755 });
  const state = await lstatOrNull(target);
  if (!state) {
    await writeShim(target, desired);
    return { action: 'installed', path: target };
  }
  // A symlink or non-file at this name was put there by something else and
  // is never written through.
  if (state.isSymbolicLink()) {
    return await classifyExternal(target, state, '')
      ? { action: 'external', path: target }
      : { action: 'preserved', path: target };
  }
  if (!state.isFile()) return { action: 'preserved', path: target };
  const text = await readFile(target, 'utf8');
  if (text === desired) return { action: 'current', path: target };
  if (!isManagedShim(text)) {
    return await classifyExternal(target, state, text)
      ? { action: 'external', path: target }
      : { action: 'preserved', path: target };
  }
  // Ours but different: an older shim shape, or a plugin root that has since
  // moved. This rewrite is the stale case the launcher design hinges on.
  await writeShim(target, desired);
  return { action: 'refreshed', path: target };
}

export async function uninstallLauncher(paths) {
  const { target } = launcherLocation(paths);
  const state = await lstatOrNull(target);
  if (!state || state.isSymbolicLink() || !state.isFile()) {
    return { removed: false };
  }
  const text = await readFile(target, 'utf8');
  if (!isManagedShim(text)) return { removed: false };
  await unlink(target);
  return { removed: true };
}

// Classifies the shim for doctor without surfacing any of its content:
// 'ok' (ours, and the entry point it execs exists), 'missing', 'foreign'
// (no marker: not ours to judge or repair), 'stale' (ours, but the
// embedded plugin root no longer holds the entry point), or 'external' /
// 'external-stale' (another installer of this product owns it, with
// `manager` naming mattstack.app when that is who).
export async function inspectLauncher(paths) {
  const { target } = launcherLocation(paths);
  const state = await lstatOrNull(target);
  if (!state) return { status: 'missing' };
  if (state.isSymbolicLink()) return await classifyExternal(target, state, '') ?? { status: 'foreign' };
  if (!state.isFile()) return { status: 'foreign' };
  const text = await readFile(target, 'utf8');
  if (!isManagedShim(text)) return await classifyExternal(target, state, text) ?? { status: 'foreign' };
  const entry = text.match(EXEC_LINE)?.[1];
  if (!entry) return { status: 'stale' };
  try {
    await access(entry);
  } catch {
    return { status: 'stale' };
  }
  return { status: 'ok' };
}

// PATH membership by resolved-string comparison. Empty segments are skipped
// rather than resolved: an empty PATH entry means the current directory,
// which must never be mistaken for the launcher directory.
export function isDirectoryOnPath(directory, pathValue) {
  if (typeof directory !== 'string' || typeof pathValue !== 'string') {
    return false;
  }
  const resolved = path.resolve(directory);
  return pathValue
    .split(':')
    .some((entry) => entry !== '' && path.resolve(entry) === resolved);
}
