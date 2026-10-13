import { execFile as execFileCallback, spawn as nodeSpawn } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { assertConfinedPath } from '../core/containment.mjs';

const execFile = promisify(execFileCallback);

export class RendererInstallError extends Error {
  constructor(message) { super(message); this.name = 'RendererInstallError'; }
}

export function rendererPlatform(nodePlatform = process.platform, arch = process.arch) {
  if (nodePlatform !== 'darwin') return null;
  if (arch === 'arm64') return 'mac-arm64';
  if (arch === 'x64') return 'mac-x64';
  return null;
}

function platformDir(paths, lock, platform) {
  return path.join(paths.rendererDir, lock.renderer.revision, platform);
}

export function rendererExecutable(paths, lock, platform) {
  return path.join(platformDir(paths, lock, platform), `chrome-headless-shell-${platform}`, 'chrome-headless-shell');
}

function markerPath(paths, lock, platform) {
  return path.join(platformDir(paths, lock, platform), 'installed.json');
}

// A symlinked revision or platform directory could make a planted tree read
// as an install, so every path a 'ready' verdict rests on is confined first.
async function assertInstallConfined({ lock, paths, platform }) {
  await Promise.all([
    platformDir(paths, lock, platform),
    markerPath(paths, lock, platform),
    rendererExecutable(paths, lock, platform),
  ].map((candidate) => assertConfinedPath({ dataDir: paths.dataDir, rootDir: paths.rendererDir, candidate })));
}

export async function rendererStatus({ lock, paths, platform }) {
  if (!lock?.renderer) return 'unpinned';
  if (!platform || !lock.renderer.platforms?.[platform]) return 'unsupported';
  try {
    await assertInstallConfined({ lock, paths, platform });
    const marker = JSON.parse(await readFile(markerPath(paths, lock, platform), 'utf8'));
    const exe = await stat(rendererExecutable(paths, lock, platform));
    return marker.sha256 === lock.renderer.platforms[platform].sha256 && exe.isFile() ? 'ready' : 'missing';
  } catch {
    return 'missing';
  }
}

async function fetchBytes(url, fetchImplementation) {
  if (url.startsWith('file:')) return readFile(fileURLToPath(url));
  if (typeof fetchImplementation !== 'function') throw new RendererInstallError('a Fetch-compatible fetch is required');
  const response = await fetchImplementation(url, { redirect: 'follow' });
  if (!response.ok) throw new RendererInstallError(`renderer download failed (HTTP ${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

const LEFTOVER_GRACE_MS = 60 * 60 * 1000;

// A crash mid-swap leaves a set-aside or staging tree beside the install; nothing
// reads them. A young one may belong to another setup still running, and that
// setup may need its set-aside tree back, so only aged ones go. A rename keeps a
// directory's mtime, so a set-aside tree carries its creation time in its name
// and a name without one counts as old; a staging tree is created fresh and is
// judged by mtime. Best-effort: the install is already in place.
async function sweepLeftovers(target) {
  try {
    const parent = path.dirname(target);
    const prefix = `${path.basename(target)}.`;
    for (const name of await readdir(parent)) {
      const leftover = path.join(parent, name);
      try {
        if (name.startsWith(`${prefix}old-`)) {
          const madeAt = Number(/^old-(\d+)-/.exec(name.slice(prefix.length))?.[1]);
          if (!(Date.now() - madeAt <= LEFTOVER_GRACE_MS)) await rm(leftover, { recursive: true, force: true });
        } else if (name.startsWith(`${prefix}staging-`)) {
          if (Date.now() - (await stat(leftover)).mtimeMs > LEFTOVER_GRACE_MS) await rm(leftover, { recursive: true, force: true });
        }
      } catch { /* another setup may have removed it */ }
    }
  } catch { /* leftovers wait for the next install */ }
}

export async function installRenderer({ lock, paths, fetch: fetchImplementation = globalThis.fetch, platform = rendererPlatform(), force = false, rename: renameFile = rename }) {
  if (!lock?.renderer) throw new RendererInstallError('the runtime lock pins no renderer');
  if (!platform || !lock.renderer.platforms?.[platform]) {
    throw new RendererInstallError('the renderer is not available for this platform');
  }
  await assertInstallConfined({ lock, paths, platform });
  const status = await rendererStatus({ lock, paths, platform });
  const executable = rendererExecutable(paths, lock, platform);
  if (status === 'ready' && !force) return { executable, revision: lock.renderer.revision, installed: false };

  const artifact = lock.renderer.platforms[platform];
  const target = platformDir(paths, lock, platform);
  await assertConfinedPath({ dataDir: paths.dataDir, rootDir: paths.rendererDir, candidate: target });
  const bytes = await fetchBytes(artifact.url, fetchImplementation);
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(artifact.sha256, 'hex'))) {
    throw new RendererInstallError('renderer checksum did not match the runtime lock');
  }
  const staging = `${target}.staging-${crypto.randomUUID()}`;
  const zipPath = `${staging}.zip`;
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    await writeFile(zipPath, bytes, { mode: 0o600 });
    await execFile('/usr/bin/unzip', ['-qq', zipPath, '-d', staging]);
    // The marker travels inside the staged tree, so "ready" flips at one rename.
    await writeFile(path.join(staging, path.basename(markerPath(paths, lock, platform))),
      `${JSON.stringify({ schemaVersion: 1, revision: lock.renderer.revision, sha256: artifact.sha256 })}\n`, { mode: 0o600 });
    const aside = `${target}.old-${Date.now()}-${crypto.randomUUID()}`;
    let setAside = false;
    try { await renameFile(target, aside); setAside = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try {
      await renameFile(staging, target);
    } catch (error) {
      if (setAside) await renameFile(aside, target).catch(() => {});
      throw error;
    }
    if (setAside) await rm(aside, { recursive: true, force: true }).catch(() => {});
    await sweepLeftovers(target);
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(zipPath, { force: true });
  }
  return { executable, revision: lock.renderer.revision, installed: true };
}

export function rendererLaunches({ executable, spawn = nodeSpawn, timeoutMs = 15000 }) {
  return new Promise((resolve) => {
    let settled = false;
    let out = '';
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child?.kill('SIGKILL'); } catch { /* already gone */ }
      finish({ ok: false, reason: 'timeout' });
    }, timeoutMs);
    try {
      child = spawn(executable, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      finish({ ok: false, reason: 'spawn' });
      return;
    }
    child.stdout?.on('data', (chunk) => { if (out.length <= 4096) out += chunk; });
    child.on('error', () => finish({ ok: false, reason: 'spawn' }));
    child.on('close', (code) => {
      const version = out.trim().split('\n')[0];
      finish(code === 0 && version ? { ok: true, version } : { ok: false, reason: 'exit' });
    });
  });
}
