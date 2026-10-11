import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import crypto from 'node:crypto';
import { chmod, mkdir, symlink, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { resolvePaths } from '../../lib/core/paths.mjs';
import {
  installRenderer, rendererExecutable, rendererLaunches, rendererPlatform, rendererStatus,
} from '../../lib/compose/renderer.mjs';

const execFile = promisify(execFileCallback);

async function fakeShellZip(dir, platform) {
  const tree = path.join(dir, 'tree');
  const exeDir = path.join(tree, `chrome-headless-shell-${platform}`);
  await mkdir(exeDir, { recursive: true });
  await writeFile(path.join(exeDir, 'chrome-headless-shell'), '#!/bin/sh\necho fake\n');
  await chmod(path.join(exeDir, 'chrome-headless-shell'), 0o755);
  const zip = path.join(dir, `chromium-headless-shell-1243-${platform}.zip`);
  await execFile('/usr/bin/zip', ['-qr', zip, `chrome-headless-shell-${platform}`], { cwd: tree });
  const sha256 = crypto.createHash('sha256').update(await readFile(zip)).digest('hex');
  return { url: pathToFileURL(zip).href, file: path.basename(zip), sha256 };
}

test('platform mapping covers macOS only', () => {
  assert.equal(rendererPlatform('darwin', 'arm64'), 'mac-arm64');
  assert.equal(rendererPlatform('darwin', 'x64'), 'mac-x64');
  assert.equal(rendererPlatform('linux', 'x64'), null);
});

test('install verifies the checksum, unzips, and is idempotent', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'fb-rend-'));
  try {
    const paths = resolvePaths({ homeDir: home });
    const artifact = await fakeShellZip(home, 'mac-arm64');
    const lock = { renderer: { revision: '1243', platforms: { 'mac-arm64': artifact } } };
    assert.equal(await rendererStatus({ lock, paths, platform: 'mac-arm64' }), 'missing');
    const first = await installRenderer({ lock, paths, platform: 'mac-arm64' });
    assert.equal(first.installed, true);
    assert.equal(first.executable, rendererExecutable(paths, lock, 'mac-arm64'));
    assert.equal(await rendererStatus({ lock, paths, platform: 'mac-arm64' }), 'ready');
    const second = await installRenderer({ lock, paths, platform: 'mac-arm64' });
    assert.equal(second.installed, false);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a checksum mismatch installs nothing', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'fb-rend-'));
  try {
    const paths = resolvePaths({ homeDir: home });
    const artifact = { ...(await fakeShellZip(home, 'mac-arm64')), sha256: 'b'.repeat(64) };
    const lock = { renderer: { revision: '1243', platforms: { 'mac-arm64': artifact } } };
    await assert.rejects(() => installRenderer({ lock, paths, platform: 'mac-arm64' }), /renderer checksum did not match/);
    assert.equal(await rendererStatus({ lock, paths, platform: 'mac-arm64' }), 'missing');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('status reports unpinned and unsupported', async () => {
  const paths = resolvePaths({ homeDir: '/nonexistent' });
  assert.equal(await rendererStatus({ lock: {}, paths, platform: 'mac-arm64' }), 'unpinned');
  assert.equal(await rendererStatus({ lock: { renderer: { revision: '1', platforms: {} } }, paths, platform: null }), 'unsupported');
});

test('a symlinked revision directory outside dataDir is never ready and never installed from', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'fb-rend-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'fb-rend-out-'));
  try {
    const paths = resolvePaths({ homeDir: home });
    const artifact = await fakeShellZip(home, 'mac-arm64');
    const lock = { renderer: { revision: '1243', platforms: { 'mac-arm64': artifact } } };
    const exeDir = path.join(outside, 'mac-arm64', 'chrome-headless-shell-mac-arm64');
    await mkdir(exeDir, { recursive: true });
    await writeFile(path.join(exeDir, 'chrome-headless-shell'), 'planted');
    await writeFile(path.join(outside, 'mac-arm64', 'installed.json'), JSON.stringify({ sha256: artifact.sha256 }));
    await mkdir(paths.rendererDir, { recursive: true });
    await symlink(outside, path.join(paths.rendererDir, '1243'));
    assert.notEqual(await rendererStatus({ lock, paths, platform: 'mac-arm64' }), 'ready');
    await assert.rejects(() => installRenderer({ lock, paths, platform: 'mac-arm64' }), /symlink|outside/);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

function launchSpawn({ code = 0, out = '', error = null, neverClose = false, capture = {} } = {}) {
  return (command, args) => {
    capture.command = command; capture.args = args;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = (signal) => { capture.killed = signal; };
    if (!neverClose) {
      queueMicrotask(() => {
        if (error) { child.emit('error', error); return; }
        if (out) child.stdout.emit('data', Buffer.from(out));
        child.emit('close', code);
      });
    }
    return child;
  };
}

test('rendererLaunches reports the version the renderer prints', async () => {
  const capture = {};
  const result = await rendererLaunches({ executable: '/x/shell', spawn: launchSpawn({ out: 'Chrome 1.2.3\n', capture }) });
  assert.deepEqual(result, { ok: true, version: 'Chrome 1.2.3' });
  assert.equal(capture.command, '/x/shell');
  assert.deepEqual(capture.args, ['--version']);
});

test('rendererLaunches reports a non-zero exit', async () => {
  assert.deepEqual(await rendererLaunches({ executable: '/x', spawn: launchSpawn({ code: 1 }) }), { ok: false, reason: 'exit' });
});

test('rendererLaunches reports an exit 0 with empty stdout', async () => {
  assert.deepEqual(await rendererLaunches({ executable: '/x', spawn: launchSpawn({ code: 0, out: '' }) }), { ok: false, reason: 'exit' });
});

test('rendererLaunches keeps the first line when stdout is huge', async () => {
  const out = `Chrome 1.2.3\n${'x'.repeat(1_000_000)}`;
  assert.deepEqual(
    await rendererLaunches({ executable: '/x', spawn: launchSpawn({ out }) }),
    { ok: true, version: 'Chrome 1.2.3' },
  );
});

test('rendererLaunches reports a spawn error', async () => {
  assert.deepEqual(
    await rendererLaunches({ executable: '/x', spawn: launchSpawn({ error: new Error('boom') }) }),
    { ok: false, reason: 'spawn' },
  );
});

test('rendererLaunches kills a child that never closes', async () => {
  const capture = {};
  const result = await rendererLaunches({ executable: '/x', timeoutMs: 20, spawn: launchSpawn({ neverClose: true, capture }) });
  assert.deepEqual(result, { ok: false, reason: 'timeout' });
  assert.equal(capture.killed, 'SIGKILL');
});

test('force reinstalls a ready install', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'fb-rend-'));
  try {
    const paths = resolvePaths({ homeDir: home });
    const artifact = await fakeShellZip(home, 'mac-arm64');
    const lock = { renderer: { revision: '1243', platforms: { 'mac-arm64': artifact } } };
    await installRenderer({ lock, paths, platform: 'mac-arm64' });
    const forced = await installRenderer({ lock, paths, platform: 'mac-arm64', force: true });
    assert.equal(forced.installed, true);
    assert.equal(await rendererStatus({ lock, paths, platform: 'mac-arm64' }), 'ready');
  } finally { await rm(home, { recursive: true, force: true }); }
});
