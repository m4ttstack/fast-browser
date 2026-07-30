import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { LifecycleError } from '../commands/shared.mjs';

export const GIF_RENDERER_BINARY = 'ffmpeg';
const DEFAULT_TIMEOUT_MS = 120_000;
const MISSING = `${GIF_RENDERER_BINARY} is not installed; run \`brew install ffmpeg\``;

function runFfmpeg({ args, spawn, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(GIF_RENDERER_BINARY, args, {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch (error) {
      reject(error?.code === 'ENOENT'
        ? new LifecycleError(MISSING, { stage: 'gif', exitCode: 2 })
        : new LifecycleError(`${GIF_RENDERER_BINARY} could not be started`, { stage: 'gif' }));
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new LifecycleError(`${GIF_RENDERER_BINARY} timed out`, { stage: 'gif' }));
    }, timeoutMs);
    timer.unref?.();

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error?.code === 'ENOENT'
        ? new LifecycleError(MISSING, { stage: 'gif', exitCode: 2 })
        : new LifecycleError(`${GIF_RENDERER_BINARY} could not be started`, { stage: 'gif' }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new LifecycleError(`${GIF_RENDERER_BINARY} failed`, { stage: 'gif' }));
    });
  });
}

// Two passes over the same frames: palettegen distils one 256-colour palette
// from the whole clip, paletteuse then maps every frame through it. A single
// pass leaves ffmpeg quantising per-frame against a generic palette, which
// visibly bands the flat UI colours these recordings are full of. The comma
// inside min() is escaped because a bare comma separates filters in a
// filtergraph; min(iw, width) caps the output width without ever upscaling.
export async function convertToGif({
  videoPath,
  outPath,
  fps,
  width,
  spawn = nodeSpawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const frames = `fps=${fps},scale=min(iw\\,${width}):-1:flags=lanczos`;
  // The palette is derived data nobody should ever find later: a mkdtemp
  // scratch directory keeps it out of the confined data directory entirely
  // and the finally below removes it on every outcome.
  const scratchDir = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-gif-'));
  const palettePath = path.join(scratchDir, 'palette.png');
  try {
    await runFfmpeg({
      args: ['-y', '-i', videoPath, '-vf', `${frames},palettegen`, palettePath],
      spawn,
      timeoutMs,
    });
    await runFfmpeg({
      args: [
        '-y',
        '-i', videoPath,
        '-i', palettePath,
        '-lavfi', `${frames}[x];[x][1:v]paletteuse`,
        outPath,
      ],
      spawn,
      timeoutMs,
    });
  } catch (error) {
    // A failed or killed ffmpeg can leave a zero-length or half-written GIF.
    await rm(outPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function gifRendererVersion({ spawn = nodeSpawn } = {}) {
  return new Promise((resolve) => {
    let output = '';
    let child;
    try {
      child = spawn(GIF_RENDERER_BINARY, ['-version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    child.stdout?.on('data', (chunk) => { output += String(chunk); });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? output.trim().split('\n')[0] : null));
  });
}
