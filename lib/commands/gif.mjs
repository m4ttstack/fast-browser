import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { assertConfinedPath } from '../core/containment.mjs';
import { resolvePaths } from '../core/paths.mjs';
import { convertToGif as defaultConvertToGif } from '../gif/render.mjs';
import { LifecycleError } from './shared.mjs';

const DEFAULT_FPS = 8;
const DEFAULT_WIDTH = 1200;

function fail(message, exitCode = 2) {
  return new LifecycleError(message, { stage: 'gif', exitCode });
}

// `video` and `out` are names inside the videos and screenshots directories,
// never paths, exactly like annotate's `base` and `out`: assertConfinedPath
// structurally requires its root to sit under dataDir, so honouring
// caller-chosen absolute paths and confining are mutually exclusive;
// containment wins.
async function confinedName(paths, rootDir, name, field) {
  if (typeof name !== 'string' || name.length === 0) throw fail(`${field} is required`);
  const candidate = path.resolve(rootDir, name);
  try {
    await assertConfinedPath({
      dataDir: paths.dataDir,
      rootDir,
      candidate,
    });
  } catch {
    // The name is user-supplied and a PathConfinementError's message can
    // embed the resolved path, so it is not safe to print verbatim. Name the
    // field -- always one of our own literals -- instead of the value.
    throw fail(`${field} must resolve inside the ${path.basename(rootDir)} directory`);
  }
  return candidate;
}

export async function gif(request, supplied = {}) {
  // Matches annotate: the CLI entrypoint invokes commands with no explicit
  // `paths`, so falling back to resolvePaths is what makes `fast-browser
  // gif` work outside tests.
  const paths = supplied.paths ?? resolvePaths({
    homeDir: supplied.homeDir,
    pluginRoot: supplied.pluginRoot,
  });
  const convertToGif = supplied.convertToGif ?? defaultConvertToGif;

  const fps = request.fps ?? DEFAULT_FPS;
  if (!Number.isInteger(fps) || fps < 1 || fps > 30) throw fail('fps must be 1 to 30');
  const width = request.width ?? DEFAULT_WIDTH;
  if (!Number.isInteger(width) || width < 100 || width > 1200) {
    throw fail('width must be 100 to 1200');
  }

  const videoPath = await confinedName(paths, paths.videosDir, request.video, 'video');
  // Derived from the video's basename, not its full name: the name has
  // already passed confinement, but the default output must be a bare name
  // in the screenshots directory either way.
  const outName = request.out
    ?? `${path.basename(request.video).replace(/\.webm$/, '')}.gif`;
  const outPath = await confinedName(paths, paths.screenshotsDir, outName, 'out');

  let source;
  try {
    source = await stat(videoPath);
  } catch {
    // Field, never value: the name is user-supplied and ENOENT is not in
    // main.mjs's safeFailure() allowlist, which would otherwise collapse
    // this to a diagnostics-free exit 1.
    throw fail('the video named by video was not found in the videos directory');
  }
  if (!source.isFile()) {
    throw fail('the video named by video was not found in the videos directory');
  }

  await mkdir(paths.screenshotsDir, { recursive: true, mode: 0o700 });
  await convertToGif({
    videoPath,
    outPath,
    fps,
    width,
    spawn: supplied.spawn,
  });

  return {
    source: videoPath,
    out: outPath,
    fps,
    width,
  };
}
