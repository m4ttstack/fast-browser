import crypto from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  readFile,
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
// `refreshed` put bytes on disk, `current` and `preserved` touch nothing, and
// a caller computing `changed` must ask rather than assume a call wrote.
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
  // A symlink or non-file at this name was put there by something else;
  // classify without following it rather than read through it.
  if (state.isSymbolicLink() || !state.isFile()) {
    return { action: 'preserved', path: target };
  }
  const text = await readFile(target, 'utf8');
  if (text === desired) return { action: 'current', path: target };
  if (!isManagedShim(text)) return { action: 'preserved', path: target };
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
// (no marker: not ours to judge or repair), or 'stale' (ours, but the
// embedded plugin root no longer holds the entry point).
export async function inspectLauncher(paths) {
  const { target } = launcherLocation(paths);
  const state = await lstatOrNull(target);
  if (!state) return { status: 'missing' };
  if (state.isSymbolicLink() || !state.isFile()) return { status: 'foreign' };
  const text = await readFile(target, 'utf8');
  if (!isManagedShim(text)) return { status: 'foreign' };
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
