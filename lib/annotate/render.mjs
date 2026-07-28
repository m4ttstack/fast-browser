import { spawn as nodeSpawn } from 'node:child_process';
import { rm } from 'node:fs/promises';

import { LifecycleError } from '../commands/shared.mjs';

export const RENDERER_BINARY = 'rsvg-convert';
const DEFAULT_TIMEOUT_MS = 20_000;
const MISSING = `${RENDERER_BINARY} is not installed; run \`brew install librsvg\``;

// The SVG embeds the full, unredacted base screenshot as base64. The source
// annotator wrote it beside its output and unlinked it only on success, so a
// crash between write and rasterise left an un-redacted copy on disk. Piping
// through stdin means it never exists as a file.
export async function rasterise({
  svg,
  outPath,
  spawn = nodeSpawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  await new Promise((resolve, reject) => {
    const child = spawn(RENDERER_BINARY, ['--output', outPath, '--format', 'png', '-'], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    // EPIPE is expected whenever the child exits (including our own SIGKILL on
    // timeout below) before it has consumed stdin; a large SVG write is often
    // still in flight when that happens. Rejection is already driven by the
    // 'error' and 'close' handlers on `child` itself, so this stream's own
    // error carries no information we need. Without a listener here, Node
    // treats it as an unhandled exception that kills the whole host process.
    child.stdin.on('error', () => {});
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new LifecycleError(`${RENDERER_BINARY} timed out`, { stage: 'render' }));
    }, timeoutMs);
    timer.unref?.();

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error?.code === 'ENOENT'
        ? new LifecycleError(MISSING, { stage: 'render', exitCode: 2 })
        : new LifecycleError(`${RENDERER_BINARY} could not be started`, { stage: 'render' }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new LifecycleError(`${RENDERER_BINARY} failed`, { stage: 'render' }));
    });
    child.stdin.write(svg);
    child.stdin.end();
  }).catch(async (error) => {
    // A failed or killed rsvg can leave a zero-length or half-written PNG.
    await rm(outPath, { force: true }).catch(() => {});
    throw error;
  });
}

export async function rendererVersion({ spawn = nodeSpawn } = {}) {
  return new Promise((resolve) => {
    let output = '';
    let child;
    try {
      child = spawn(RENDERER_BINARY, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    child.stdout?.on('data', (chunk) => { output += String(chunk); });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? output.trim().split('\n')[0] : null));
  });
}
