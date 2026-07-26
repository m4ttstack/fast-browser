import assert from 'node:assert/strict';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const DAY_MS = 24 * 60 * 60 * 1000;

async function sessionDirectory(root, name, contents, mtime) {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'session.md'), contents, 'utf8');
  await utimes(directory, mtime, mtime);
  return directory;
}

test('pruneSessions removes only eligible direct session directories and reports paths and bytes', async (t) => {
  const { pruneSessions } = await import('../../lib/sessions/retention.mjs');
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-retention-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const dataDir = path.join(tempRoot, '.fast-browser');
  const sessionsDir = path.join(dataDir, 'sessions');
  const archiveDir = path.join(dataDir, 'archive');
  const outsideDir = path.join(tempRoot, 'outside');
  await Promise.all([
    mkdir(sessionsDir, { recursive: true }),
    mkdir(archiveDir, { recursive: true }),
    mkdir(outsideDir, { recursive: true }),
  ]);

  const now = new Date('2026-07-26T12:00:00.000Z');
  const old = new Date(now.getTime() - 31 * DAY_MS);
  const exactCutoff = new Date(now.getTime() - 30 * DAY_MS);
  const recent = new Date(now.getTime() - 29 * DAY_MS);
  const oldSession = await sessionDirectory(sessionsDir, 'session-old', '12345', old);
  const oldArchive = await sessionDirectory(archiveDir, 'session-archived', '1234567', old);
  const recentSession = await sessionDirectory(sessionsDir, 'session-recent', 'recent', recent);
  const cutoffSession = await sessionDirectory(sessionsDir, 'session-cutoff', 'cutoff', exactCutoff);
  const ignored = await sessionDirectory(sessionsDir, 'notes-old', 'ignored', old);
  const nested = await sessionDirectory(
    path.join(sessionsDir, 'container'),
    'session-nested',
    'nested',
    old,
  );
  const outsideFile = path.join(outsideDir, 'keep.txt');
  await writeFile(outsideFile, 'outside', 'utf8');
  await symlink(outsideDir, path.join(sessionsDir, 'session-escape'));
  const physicalOldSessions = await Promise.all([realpath(oldSession), realpath(oldArchive)]);

  const result = await pruneSessions({
    paths: { dataDir, sessionsDir, archiveDir },
    now,
    retentionDays: 30,
  });

  assert.deepEqual(
    new Set(result.removedPaths),
    new Set(physicalOldSessions),
  );
  assert.equal(result.removedBytes, 12);
  for (const kept of [recentSession, cutoffSession, ignored, nested]) {
    assert.equal((await lstat(kept)).isDirectory(), true, kept);
  }
  assert.equal(await readFile(outsideFile, 'utf8'), 'outside');
  assert.equal((await lstat(path.join(sessionsDir, 'session-escape'))).isSymbolicLink(), true);
});

test('pruneSessions does not follow symlinks inside an eligible directory', async (t) => {
  const { pruneSessions } = await import('../../lib/sessions/retention.mjs');
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-retention-link-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const dataDir = path.join(tempRoot, '.fast-browser');
  const sessionsDir = path.join(dataDir, 'sessions');
  const archiveDir = path.join(dataDir, 'archive');
  const outsideFile = path.join(tempRoot, 'outside.txt');
  const now = new Date('2026-07-26T12:00:00.000Z');
  const old = new Date(now.getTime() - 31 * DAY_MS);
  const candidate = await sessionDirectory(sessionsDir, 'session-old', 'owned', old);
  await mkdir(archiveDir, { recursive: true });
  await writeFile(outsideFile, 'outside', 'utf8');
  await symlink(outsideFile, path.join(candidate, 'outside-link'));
  await utimes(candidate, old, old);

  const physicalCandidate = await realpath(candidate);
  const result = await pruneSessions({
    paths: { dataDir, sessionsDir, archiveDir },
    now,
    retentionDays: 30,
  });

  assert.deepEqual(result, { removedPaths: [physicalCandidate], removedBytes: 5 });
  assert.equal(await readFile(outsideFile, 'utf8'), 'outside');
});

test('pruneSessions treats missing exact roots as empty', async (t) => {
  const { pruneSessions } = await import('../../lib/sessions/retention.mjs');
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-retention-empty-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const dataDir = path.join(tempRoot, '.fast-browser');
  await mkdir(dataDir);

  assert.deepEqual(
    await pruneSessions({
      paths: {
        dataDir,
        sessionsDir: path.join(dataDir, 'sessions'),
        archiveDir: path.join(dataDir, 'archive'),
      },
      now: new Date('2026-07-26T12:00:00.000Z'),
      retentionDays: 30,
    }),
    { removedPaths: [], removedBytes: 0 },
  );
});

for (const linkedRoot of ['sessions', 'archive']) {
  test(`pruneSessions rejects a symlinked ${linkedRoot} root without mutating its target`, async (t) => {
    const { pruneSessions } = await import('../../lib/sessions/retention.mjs');
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), `fast-browser-${linkedRoot}-root-`));
    t.after(() => rm(tempRoot, { recursive: true, force: true }));
    const dataDir = path.join(tempRoot, '.fast-browser');
    const externalRoot = path.join(tempRoot, 'external');
    const sessionsDir = path.join(dataDir, 'sessions');
    const archiveDir = path.join(dataDir, 'archive');
    await Promise.all([mkdir(dataDir), mkdir(externalRoot)]);
    const old = new Date('2026-06-01T12:00:00.000Z');
    const victim = await sessionDirectory(externalRoot, 'session-victim', 'keep', old);
    await mkdir(linkedRoot === 'sessions' ? archiveDir : sessionsDir);
    await symlink(externalRoot, linkedRoot === 'sessions' ? sessionsDir : archiveDir);

    await assert.rejects(
      () => pruneSessions({
        paths: { dataDir, sessionsDir, archiveDir },
        now: new Date('2026-07-26T12:00:00.000Z'),
        retentionDays: 30,
      }),
      /root must be a real directory/,
    );

    assert.equal(await readFile(path.join(victim, 'session.md'), 'utf8'), 'keep');
  });
}

for (const fileRoot of ['sessions', 'archive']) {
  test(`pruneSessions rejects a non-directory ${fileRoot} root`, async (t) => {
    const { pruneSessions } = await import('../../lib/sessions/retention.mjs');
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), `fast-browser-${fileRoot}-file-`));
    t.after(() => rm(tempRoot, { recursive: true, force: true }));
    const dataDir = path.join(tempRoot, '.fast-browser');
    const sessionsDir = path.join(dataDir, 'sessions');
    const archiveDir = path.join(dataDir, 'archive');
    await mkdir(dataDir);
    await mkdir(fileRoot === 'sessions' ? archiveDir : sessionsDir);
    await writeFile(fileRoot === 'sessions' ? sessionsDir : archiveDir, 'not a directory', 'utf8');

    await assert.rejects(
      () => pruneSessions({
        paths: { dataDir, sessionsDir, archiveDir },
        now: new Date('2026-07-26T12:00:00.000Z'),
        retentionDays: 30,
      }),
      /root must be a real directory/,
    );
  });
}

test('pruneSessions rejects roots that are not the exact data-directory children', async (t) => {
  const { pruneSessions } = await import('../../lib/sessions/retention.mjs');
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-root-shape-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const dataDir = path.join(tempRoot, '.fast-browser');
  const sessionsDir = path.join(dataDir, 'other-sessions');
  const archiveDir = path.join(dataDir, 'archive');
  await Promise.all([
    mkdir(sessionsDir, { recursive: true }),
    mkdir(archiveDir, { recursive: true }),
  ]);

  await assert.rejects(
    () => pruneSessions({
      paths: { dataDir, sessionsDir, archiveDir },
      now: new Date('2026-07-26T12:00:00.000Z'),
      retentionDays: 30,
    }),
    /exact child/,
  );
});
