import assert from 'node:assert/strict';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { doctor } from '../../lib/commands/doctor.mjs';
import {
  LAUNCHER_MARKER,
  inspectLauncher,
  installLauncher,
  isDirectoryOnPath,
  launcherShimText,
  launcherWasWritten,
  uninstallLauncher,
} from '../../lib/core/launcher.mjs';
import { resolvePaths } from '../../lib/core/paths.mjs';
import { DOCTOR_CHECK_IDS } from '../../lib/doctor/checks.mjs';

const REAL_PLUGIN_ROOT = path.resolve(import.meta.dirname, '../..');

async function tempPaths(t, { pluginRoot = REAL_PLUGIN_ROOT } = {}) {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'fast-browser-launcher-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  return resolvePaths({ homeDir, pluginRoot });
}

test('install writes the exact three-line executable shim into an empty home', async (t) => {
  const paths = await tempPaths(t);

  const report = await installLauncher(paths);

  assert.deepEqual(report, { action: 'installed', path: paths.launcherFile });
  const text = await readFile(paths.launcherFile, 'utf8');
  assert.equal(text, launcherShimText(REAL_PLUGIN_ROOT));
  const lines = text.split('\n');
  assert.equal(lines.length, 4, 'three lines plus the trailing newline');
  assert.equal(lines[0], '#!/bin/sh');
  assert.equal(lines[1], LAUNCHER_MARKER);
  assert.equal(
    lines[2],
    `exec /usr/bin/env node "${path.join(REAL_PLUGIN_ROOT, 'bin', 'fast-browser.mjs')}" "$@"`,
  );
  assert.equal(lines[3], '');
  const state = await lstat(paths.launcherFile);
  assert.equal(state.mode & 0o777, 0o755);
});

// Refused, not escaped: a double quote in the path breaks out of the exec
// line's own quoting and a dollar sign expands at shim run time, while
// doctor's stale-target check reads the literal parsed path and passes. The
// empirical break: a root containing 'x"; rm -rf $HOME; "' produced a shim
// whose exec line escaped its own quoting.
test('shim text refuses a plugin root no shell quoting can carry safely', () => {
  for (const hostile of ['x"; rm -rf $HOME; "', 'a$HOME', 'back\\slash', 'new\nline']) {
    assert.throws(
      () => launcherShimText(path.join('/tmp', hostile)),
      /cannot be quoted safely/,
      hostile,
    );
  }
  assert.match(
    launcherShimText('/tmp/with spaces and (parens)'),
    /"\/tmp\/with spaces and \(parens\)\/bin\/fast-browser\.mjs"/,
    'spaces and parentheses stay supported; only unquotable characters refuse',
  );
});

test('a second install of the identical shim is current and writes nothing', async (t) => {
  const paths = await tempPaths(t);
  await installLauncher(paths);
  const before = await lstat(paths.launcherFile);

  const report = await installLauncher(paths);

  assert.deepEqual(report, { action: 'current', path: paths.launcherFile });
  const after = await lstat(paths.launcherFile);
  // Every write path lands a fresh inode over the destination, so an
  // unchanged inode is direct evidence nothing was rewritten.
  assert.equal(after.ino, before.ino);
});

// The stale case is the point of rewriting at all: a shim whose embedded
// plugin root moved (a deleted worktree) still carries our marker, so setup
// may and must replace it.
test('install refreshes a marked shim whose plugin root has moved', async (t) => {
  const paths = await tempPaths(t);
  await installLauncher({ ...paths, pluginRoot: '/somewhere/deleted-worktree' });

  const report = await installLauncher(paths);

  assert.deepEqual(report, { action: 'refreshed', path: paths.launcherFile });
  assert.equal(
    await readFile(paths.launcherFile, 'utf8'),
    launcherShimText(REAL_PLUGIN_ROOT),
  );
});

test('install preserves a foreign fast-browser file byte for byte', async (t) => {
  const paths = await tempPaths(t);
  const foreign = '#!/bin/sh\necho somebody elses fast-browser\n';
  await mkdir(paths.launcherDir, { recursive: true });
  await writeFile(paths.launcherFile, foreign, { mode: 0o755 });

  const report = await installLauncher(paths);

  assert.deepEqual(report, { action: 'preserved', path: paths.launcherFile });
  assert.equal(await readFile(paths.launcherFile, 'utf8'), foreign);
});

test('install preserves a symlink at the launcher path without following it', async (t) => {
  const paths = await tempPaths(t);
  await mkdir(paths.launcherDir, { recursive: true });
  const elsewhere = path.join(paths.homeDir, 'real-binary');
  await writeFile(elsewhere, '#!/bin/sh\n', { mode: 0o755 });
  await symlink(elsewhere, paths.launcherFile);

  const report = await installLauncher(paths);

  assert.deepEqual(report, { action: 'preserved', path: paths.launcherFile });
  assert.equal((await lstat(paths.launcherFile)).isSymbolicLink(), true);
  assert.equal(await readFile(elsewhere, 'utf8'), '#!/bin/sh\n');
});

// ~/.local/bin is shared with other tools, so install may create it but must
// never retighten one that already exists the way the private data dirs are.
test('install never chmods an existing launcher directory', async (t) => {
  const paths = await tempPaths(t);
  await mkdir(paths.launcherDir, { recursive: true });
  await chmod(paths.launcherDir, 0o711);

  await installLauncher(paths);

  assert.equal((await lstat(paths.launcherDir)).mode & 0o777, 0o711);
});

test('launcherWasWritten counts exactly the actions that put bytes on disk', () => {
  assert.equal(launcherWasWritten({ action: 'installed' }), true);
  assert.equal(launcherWasWritten({ action: 'refreshed' }), true);
  assert.equal(launcherWasWritten({ action: 'current' }), false);
  assert.equal(launcherWasWritten({ action: 'preserved' }), false);
  assert.equal(launcherWasWritten(undefined), false);
});

test('uninstall removes only a marked shim and reports what it did', async (t) => {
  const paths = await tempPaths(t);
  await installLauncher(paths);

  assert.deepEqual(await uninstallLauncher(paths), { removed: true });
  await assert.rejects(lstat(paths.launcherFile), { code: 'ENOENT' });
  assert.deepEqual(await uninstallLauncher(paths), { removed: false });
});

test('uninstall leaves a foreign fast-browser file alone', async (t) => {
  const paths = await tempPaths(t);
  const foreign = '#!/bin/sh\necho somebody elses fast-browser\n';
  await mkdir(paths.launcherDir, { recursive: true });
  await writeFile(paths.launcherFile, foreign, { mode: 0o755 });

  assert.deepEqual(await uninstallLauncher(paths), { removed: false });
  assert.equal(await readFile(paths.launcherFile, 'utf8'), foreign);
});

test('inspect classifies missing, foreign, stale, and ok shims', async (t) => {
  const missing = await tempPaths(t);
  assert.deepEqual(await inspectLauncher(missing), { status: 'missing' });

  const foreign = await tempPaths(t);
  await mkdir(foreign.launcherDir, { recursive: true });
  await writeFile(foreign.launcherFile, '#!/bin/sh\necho hi\n', { mode: 0o755 });
  assert.deepEqual(await inspectLauncher(foreign), { status: 'foreign' });

  // Ours, but the plugin root the exec line names no longer exists: the
  // deleted-worktree scenario the doctor check exists to catch.
  const stale = await tempPaths(t, { pluginRoot: '/somewhere/deleted-worktree' });
  await installLauncher(stale);
  assert.deepEqual(await inspectLauncher(stale), { status: 'stale' });

  const ok = await tempPaths(t);
  await installLauncher(ok);
  assert.deepEqual(await inspectLauncher(ok), { status: 'ok' });
});

test('isDirectoryOnPath compares resolved segments and skips empty ones', () => {
  assert.equal(isDirectoryOnPath('/home/u/.local/bin', '/usr/bin:/home/u/.local/bin'), true);
  assert.equal(isDirectoryOnPath('/home/u/.local/bin', '/usr/bin:/home/u/.local/bin/'), true);
  assert.equal(isDirectoryOnPath('/home/u/.local/bin', '/home/u/.local/./bin'), true);
  assert.equal(isDirectoryOnPath('/home/u/.local/bin', '/usr/bin:/bin'), false);
  assert.equal(isDirectoryOnPath('/home/u/.local/bin', ''), false);
  assert.equal(isDirectoryOnPath('/home/u/.local/bin', '::'), false);
  assert.equal(isDirectoryOnPath(undefined, '/usr/bin'), false);
});

function passingChecksExcept(id) {
  return Object.fromEntries(DOCTOR_CHECK_IDS
    .filter((checkId) => checkId !== id)
    .map((checkId) => [checkId, async () => ({
      status: 'pass',
      message: `${checkId} passed.`,
      remediation: null,
    })]));
}

async function launcherCheck(paths, env) {
  const report = await doctor(
    { profile: 'safe' },
    { checks: passingChecksExcept('launcher'), paths, env },
  );
  return report.checks.find(({ id }) => id === 'launcher');
}

test('doctor launcher check fails with the setup remediation for missing, foreign, and stale shims', async (t) => {
  const remediation = 'Run `fast-browser setup` to reinstall the launcher.';

  const missing = await tempPaths(t);
  assert.deepEqual(await launcherCheck(missing, { PATH: '/usr/bin' }), {
    id: 'launcher',
    status: 'fail',
    message: 'The fast-browser launcher is not installed.',
    remediation,
  });

  const foreign = await tempPaths(t);
  await mkdir(foreign.launcherDir, { recursive: true });
  await writeFile(foreign.launcherFile, '#!/bin/sh\necho hi\n', { mode: 0o755 });
  const foreignCheck = await launcherCheck(foreign, { PATH: '/usr/bin' });
  assert.equal(foreignCheck.status, 'fail');
  assert.equal(foreignCheck.remediation, remediation);
  // Never echoes the foreign file's content or path.
  assert.doesNotMatch(JSON.stringify(foreignCheck), /echo hi/);
  assert.equal(foreignCheck.message.includes(foreign.launcherFile), false);

  const stale = await tempPaths(t, { pluginRoot: '/somewhere/deleted-worktree' });
  await installLauncher(stale);
  const staleCheck = await launcherCheck(stale, { PATH: '/usr/bin' });
  assert.equal(staleCheck.status, 'fail');
  assert.match(staleCheck.message, /no longer exists/);
  assert.equal(staleCheck.remediation, remediation);
  assert.doesNotMatch(JSON.stringify(staleCheck), /deleted-worktree/);
});

// PATH membership must never fail the check: the shim works by absolute path
// and setup cannot edit the user's shell profile, so the missing directory
// only rides along in the pass message.
test('doctor launcher check passes either way on PATH and surfaces the export line when absent', async (t) => {
  const paths = await tempPaths(t);
  await installLauncher(paths);

  const onPath = await launcherCheck(paths, { PATH: `/usr/bin:${paths.launcherDir}` });
  assert.deepEqual(onPath, {
    id: 'launcher',
    status: 'pass',
    message: 'The fast-browser launcher is installed.',
    remediation: null,
  });

  const offPath = await launcherCheck(paths, { PATH: '/usr/bin:/bin' });
  assert.equal(offPath.status, 'pass');
  assert.match(offPath.message, /export PATH="\$HOME\/\.local\/bin:\$PATH"/);
  // The literal $HOME, never the expanded temp home.
  assert.equal(offPath.message.includes(paths.homeDir), false);
});
