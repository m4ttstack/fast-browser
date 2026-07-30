import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { gif } from '../../lib/commands/gif.mjs';
import { convertToGif, gifRendererVersion } from '../../lib/gif/render.mjs';
import { resolvePaths } from '../../lib/core/paths.mjs';

// Every test resolves a real temp home through resolvePaths, never the real
// one, matching the repo-wide rule for anything that touches ~/.fast-browser.
async function tempPaths(t) {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-gif-unit-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }).catch(() => {}));
  const paths = resolvePaths({ homeDir, pluginRoot: '/plugin' });
  await mkdir(paths.videosDir, { recursive: true });
  return paths;
}

function succeedingSpawn(captured) {
  return (command, args, options) => {
    captured.push({ command, args, options });
    const child = new EventEmitter();
    process.nextTick(() => child.emit('close', 0));
    return child;
  };
}

function missingBinarySpawn() {
  return () => {
    const child = new EventEmitter();
    process.nextTick(() => {
      const error = new Error('spawn ffmpeg ENOENT');
      error.code = 'ENOENT';
      child.emit('error', error);
    });
    return child;
  };
}

test('gif validates fps and width bounds before touching anything', async (t) => {
  const paths = await tempPaths(t);
  for (const [request, pattern] of [
    [{ video: 'flow.webm', fps: 0 }, /fps must be 1 to 30/],
    [{ video: 'flow.webm', fps: 31 }, /fps must be 1 to 30/],
    [{ video: 'flow.webm', fps: 2.5 }, /fps must be 1 to 30/],
    [{ video: 'flow.webm', width: 99 }, /width must be 100 to 1200/],
    [{ video: 'flow.webm', width: 1201 }, /width must be 100 to 1200/],
  ]) {
    await assert.rejects(
      gif(request, { paths, convertToGif: async () => assert.fail('must not convert') }),
      pattern,
    );
  }
});

test('gif refuses an escaping video or out name by field, never value', async (t) => {
  const paths = await tempPaths(t);
  await writeFile(path.join(paths.videosDir, 'flow.webm'), 'x');

  await assert.rejects(
    gif(
      { video: '../secret-place/flow.webm' },
      { paths, convertToGif: async () => assert.fail('must not convert') },
    ),
    (error) => {
      assert.doesNotMatch(error.message, /secret-place/);
      assert.match(error.message, /video must resolve inside the videos directory/);
      return true;
    },
  );
  await assert.rejects(
    gif(
      { video: 'flow.webm', out: '../secret-place/out.gif' },
      { paths, convertToGif: async () => assert.fail('must not convert') },
    ),
    (error) => {
      assert.doesNotMatch(error.message, /secret-place/);
      assert.match(error.message, /out must resolve inside the screenshots directory/);
      return true;
    },
  );
  await assert.rejects(
    gif({ video: '' }, { paths, convertToGif: async () => assert.fail('must not convert') }),
    /video is required/,
  );
});

test('gif refuses a symlinked video name instead of following it out', async (t) => {
  const paths = await tempPaths(t);
  const outside = path.join(paths.homeDir, 'outside.webm');
  await writeFile(outside, 'x');
  await symlink(outside, path.join(paths.videosDir, 'link.webm'));

  await assert.rejects(
    gif(
      { video: 'link.webm' },
      { paths, convertToGif: async () => assert.fail('must not convert') },
    ),
    /video must resolve inside the videos directory/,
  );
});

test('gif names the video field when the recording is absent', async (t) => {
  const paths = await tempPaths(t);
  await assert.rejects(
    gif(
      { video: 'missing.webm' },
      { paths, convertToGif: async () => assert.fail('must not convert') },
    ),
    /the video named by video was not found in the videos directory/,
  );
});

test('gif runs the two-pass palette conversion with defaults and derived out name', async (t) => {
  const paths = await tempPaths(t);
  await writeFile(path.join(paths.videosDir, 'flow.webm'), 'x');
  const captured = [];

  const report = await gif(
    { video: 'flow.webm' },
    { paths, spawn: succeedingSpawn(captured) },
  );

  assert.equal(captured.length, 2, 'palettegen then paletteuse');
  const [palettegen, paletteuse] = captured;
  assert.equal(palettegen.command, 'ffmpeg');
  assert.equal(paletteuse.command, 'ffmpeg');
  const filters = `fps=8,scale=min(iw\\,1200):-1:flags=lanczos`;
  assert.deepEqual(palettegen.args.slice(0, 5), [
    '-y', '-i', path.join(paths.videosDir, 'flow.webm'), '-vf', `${filters},palettegen`,
  ]);
  const palettePath = palettegen.args[5];
  // The palette intermediate lives in a scratch directory outside the data
  // directory, and the scratch directory is gone by the time gif returns.
  assert.equal(palettePath.startsWith(paths.dataDir), false);
  await assert.rejects(access(path.dirname(palettePath)));
  assert.deepEqual(paletteuse.args, [
    '-y',
    '-i', path.join(paths.videosDir, 'flow.webm'),
    '-i', palettePath,
    '-lavfi', `${filters}[x];[x][1:v]paletteuse`,
    path.join(paths.screenshotsDir, 'flow.gif'),
  ]);
  assert.deepEqual(report, {
    source: path.join(paths.videosDir, 'flow.webm'),
    out: path.join(paths.screenshotsDir, 'flow.gif'),
    fps: 8,
    width: 1200,
  });
});

test('gif honours out, fps, and width when given', async (t) => {
  const paths = await tempPaths(t);
  await writeFile(path.join(paths.videosDir, 'flow.webm'), 'x');
  const captured = [];

  const report = await gif(
    {
      video: 'flow.webm', out: 'evidence.gif', fps: 12, width: 640,
    },
    { paths, spawn: succeedingSpawn(captured) },
  );

  assert.equal(report.out, path.join(paths.screenshotsDir, 'evidence.gif'));
  assert.equal(report.fps, 12);
  assert.equal(report.width, 640);
  assert.match(captured[0].args[4], /fps=12,scale=min\(iw\\,640\)/);
});

test('gif reports a missing ffmpeg with the brew remediation and exit code 2', async (t) => {
  const paths = await tempPaths(t);
  await writeFile(path.join(paths.videosDir, 'flow.webm'), 'x');

  await assert.rejects(
    gif({ video: 'flow.webm' }, { paths, spawn: missingBinarySpawn() }),
    (error) => {
      assert.equal(error.name, 'LifecycleError');
      assert.equal(error.exitCode, 2);
      assert.match(error.message, /ffmpeg is not installed.*brew install ffmpeg/);
      return true;
    },
  );
});

test('convertToGif removes a half-written output and its scratch dir when a pass fails', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-gif-render-'));
  t.after(() => rm(directory, { recursive: true, force: true }).catch(() => {}));
  const outPath = path.join(directory, 'out.gif');
  let scratchPalette = null;
  let calls = 0;
  const failingSecondPass = (command, args) => {
    calls += 1;
    const child = new EventEmitter();
    if (calls === 1) scratchPalette = args[5];
    process.nextTick(async () => {
      if (calls === 2) await writeFile(outPath, 'partial');
      child.emit('close', calls === 1 ? 0 : 1);
    });
    return child;
  };

  await assert.rejects(
    convertToGif({
      videoPath: path.join(directory, 'in.webm'),
      outPath,
      fps: 8,
      width: 1200,
      spawn: failingSecondPass,
    }),
    /ffmpeg failed/,
  );
  await assert.rejects(access(outPath), 'the partial output is removed');
  await assert.rejects(access(path.dirname(scratchPalette)), 'the scratch dir is removed');
});

test('gifRendererVersion resolves the first -version line and null when absent', async () => {
  const okSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    process.nextTick(() => {
      child.stdout.emit('data', 'ffmpeg version 8.1.1 Copyright\nbuilt with clang\n');
      child.emit('close', 0);
    });
    return child;
  };
  assert.equal(await gifRendererVersion({ spawn: okSpawn }), 'ffmpeg version 8.1.1 Copyright');
  assert.equal(await gifRendererVersion({ spawn: missingBinarySpawn() }), null);
});
