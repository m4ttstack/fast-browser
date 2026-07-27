import { execFile as execFileCallback } from 'node:child_process';
import crypto from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { promisify, isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import { assertConfinedPath } from '../core/containment.mjs';
import { buildContentManifestDigest } from '../core/content-manifest.mjs';
import {
  cleanupDownloadReservation,
  reserveDownload,
} from '../core/download-reservation.mjs';
import { verifyRuntimeContentDigest } from './content.mjs';
import { runtimeLockIdentity } from './lock.mjs';

const execFile = promisify(execFileCallback);

export class RuntimeInstallError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RuntimeInstallError';
  }
}

function resultFor(lock, paths) {
  const directory = path.join(paths.runtimeDir, lock.productVersion);
  return {
    version: lock.productVersion,
    directory,
    cli: path.join(directory, 'fast-browser-mcp', 'cli.cjs'),
    marker: path.join(directory, 'installed.json'),
  };
}

function validChecksum(value, field) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new RuntimeInstallError(`${field} must be a 64-character hexadecimal checksum`);
  }
  return Buffer.from(value, 'hex');
}

function checksumMatches(actual, expected) {
  const actualBytes = validChecksum(actual, 'download checksum');
  const expectedBytes = validChecksum(expected, 'runtime.sha256');
  return crypto.timingSafeEqual(actualBytes, expectedBytes);
}

async function existingInstall(lock, paths) {
  const result = resultFor(lock, paths);
  try {
    const [marker, cliState, markerState] = await Promise.all([
      readFile(result.marker, 'utf8').then(JSON.parse),
      stat(result.cli),
      stat(result.marker),
    ]);
    if (
      marker.schemaVersion !== 1
      || !isDeepStrictEqual(marker.lock, runtimeLockIdentity(lock))
      || !cliState.isFile()
      || !markerState.isFile()
      || (markerState.mode & 0o777) !== 0o600
    ) return null;
    // Marker/lock equality alone proves nothing about the bytes actually on
    // disk: recompute the digest over the installed tree (the same shared
    // check doctor's runtime-checksum, the upgrade classifier, and the
    // launch-time validator all use) so a directory whose marker was
    // rewritten -- or simply never had a digest, i.e. a pre-upgrade legacy
    // install -- can never be accepted without a real, checksum-verified
    // reinstall.
    return (await verifyRuntimeContentDigest(path.dirname(result.cli), marker)) ? result : null;
  } catch {
    return null;
  }
}

async function download(urlText, downloadHandle, expectedSha256, fetchImplementation) {
  const hash = crypto.createHash('sha256');
  try {
    const url = new URL(urlText);
    let source;
    if (url.protocol === 'file:') {
      source = fs.createReadStream(fileURLToPath(url));
    } else {
      const response = await fetchImplementation(url);
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }
      source = response.body;
    }
    for await (const chunk of source) {
      const buffer = Buffer.from(chunk);
      hash.update(buffer);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesWritten } = await downloadHandle.write(
          buffer,
          offset,
          buffer.length - offset,
        );
        offset += bytesWritten;
      }
    }
  } catch (error) {
    throw new RuntimeInstallError(`runtime download failed: ${error.message}`);
  }
  const actual = hash.digest('hex');
  if (!checksumMatches(actual, expectedSha256)) {
    throw new RuntimeInstallError('runtime checksum mismatch');
  }
}

function parseOctal(field, name) {
  const text = field.toString('ascii').replace(/\0.*$/, '').trim();
  if (!/^[0-7]+$/.test(text)) throw new RuntimeInstallError(`unsafe tar entry ${name}`);
  return Number.parseInt(text, 8);
}

function tarString(field, name) {
  const nul = field.indexOf(0);
  if (nul === -1) return field.toString('utf8');
  if (field.subarray(nul + 1).some((byte) => byte !== 0)) {
    throw new RuntimeInstallError(`unsafe tar entry ${name}: ambiguous NUL`);
  }
  return field.subarray(0, nul).toString('utf8');
}

function safeArchivePath(name, type) {
  if (
    name.length === 0
    || name.includes('\0')
    || name.startsWith('/')
    || name.startsWith('\\')
    || /^[A-Za-z]:[\\/]/.test(name)
  ) {
    throw new RuntimeInstallError(`unsafe tar entry ${name}`);
  }
  const unified = name.replaceAll('\\', '/');
  const withoutDirectorySlash = type === '5' && unified.endsWith('/')
    ? unified.slice(0, -1)
    : unified;
  const segments = withoutDirectorySlash.split('/');
  if (
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
    || (type !== '5' && unified.endsWith('/'))
  ) {
    throw new RuntimeInstallError(`unsafe tar entry ${name}`);
  }
  return withoutDirectorySlash;
}

function validateTar(buffer) {
  let tar;
  try {
    tar = zlib.gunzipSync(buffer);
  } catch (error) {
    throw new RuntimeInstallError(`invalid tar archive: ${error.message}`);
  }
  const entries = new Set();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return;
    const storedChecksum = parseOctal(header.subarray(148, 156), '<header>');
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const calculatedChecksum = [...checksumHeader].reduce((sum, byte) => sum + byte, 0);
    if (storedChecksum !== calculatedChecksum) {
      throw new RuntimeInstallError('unsafe tar entry: invalid header checksum');
    }
    const rawName = tarString(header.subarray(0, 100), '<name>');
    const prefix = tarString(header.subarray(345, 500), rawName);
    const name = prefix ? `${prefix}/${rawName}` : rawName;
    const typeByte = header[156];
    const type = typeByte === 0 ? '0' : String.fromCharCode(typeByte);
    if (type !== '0' && type !== '5') {
      throw new RuntimeInstallError(`unsupported tar entry type for ${name}`);
    }
    const safeName = safeArchivePath(name, type);
    if (entries.has(safeName)) {
      throw new RuntimeInstallError(`unsafe tar entry ${name}: duplicate path`);
    }
    entries.add(safeName);
    const size = parseOctal(header.subarray(124, 136), name);
    const blocks = Math.ceil(size / 512);
    offset += 512 + blocks * 512;
    if (offset > tar.length) {
      throw new RuntimeInstallError(`unsafe tar entry ${name}: truncated body`);
    }
  }
  throw new RuntimeInstallError('invalid tar archive: missing end marker');
}

async function safeRemove(target) {
  try {
    await rm(target, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup must not replace the installation failure.
  }
}

async function writeMarker(markerPath, lock, contentDigest) {
  const temporary = `${markerPath}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({
        schemaVersion: 1,
        lock: runtimeLockIdentity(lock),
        contentDigest,
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await chmod(temporary, 0o600);
    await rename(temporary, markerPath);
  } catch (error) {
    await safeRemove(temporary);
    throw error;
  }
}

export async function installRuntime({ lock, paths, fetch: fetchImplementation }) {
  const result = resultFor(lock, paths);
  await Promise.all([
    assertConfinedPath({
      dataDir: paths.dataDir,
      rootDir: paths.runtimeDir,
      candidate: result.cli,
    }),
    assertConfinedPath({
      dataDir: paths.dataDir,
      rootDir: paths.runtimeDir,
      candidate: result.marker,
    }),
    assertConfinedPath({
      dataDir: paths.dataDir,
      rootDir: paths.runtimeDir,
      candidate: path.join(result.directory, '.download'),
    }),
  ]);
  const existing = await existingInstall(lock, paths);
  if (existing) return existing;
  if (typeof fetchImplementation !== 'function' && !lock.runtime.url.startsWith('file:')) {
    throw new RuntimeInstallError('a Fetch-compatible fetch is required');
  }

  const versionDirectory = result.directory;
  const downloadPath = path.join(versionDirectory, '.download');
  const staging = path.join(versionDirectory, `.staging-${crypto.randomUUID()}`);
  const target = path.join(versionDirectory, 'fast-browser-mcp');
  const backup = path.join(versionDirectory, `.backup-${crypto.randomUUID()}`);
  let backedUp = false;
  let promoted = false;

  await mkdir(versionDirectory, { recursive: true, mode: 0o700 });
  let downloadHandle;
  try {
    downloadHandle = await reserveDownload(downloadPath);
  } catch (error) {
    throw new RuntimeInstallError(
      `runtime download staging path unavailable (${error.code ?? error.message}); `
      + 'remove the stale .download file and run fast-browser doctor',
    );
  }
  try {
    await download(
      lock.runtime.url,
      downloadHandle,
      lock.runtime.sha256,
      fetchImplementation,
    );
    await downloadHandle.close();
    downloadHandle = null;
    validateTar(await readFile(downloadPath));
    await mkdir(staging, { mode: 0o700 });
    await execFile('/usr/bin/tar', ['-xzf', downloadPath, '-C', staging]);
    const stagedCli = path.join(staging, 'fast-browser-mcp', 'cli.cjs');
    const cliState = await stat(stagedCli).catch(() => null);
    if (!cliState?.isFile()) {
      throw new RuntimeInstallError('archive does not contain the expected runtime CLI');
    }

    try {
      await rename(target, backup);
      backedUp = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await rename(path.join(staging, 'fast-browser-mcp'), target);
    promoted = true;
    try {
      const contentDigest = await buildContentManifestDigest(target);
      await writeMarker(result.marker, lock, contentDigest);
    } catch (error) {
      await safeRemove(target);
      promoted = false;
      if (backedUp) {
        await rename(backup, target);
        backedUp = false;
      }
      throw error;
    }
    if (backedUp) {
      await safeRemove(backup);
      backedUp = false;
    }
    return result;
  } catch (error) {
    if (!promoted && backedUp) {
      await safeRemove(target);
      try {
        await rename(backup, target);
        backedUp = false;
      } catch {
        // Keep the backup rather than deleting the prior install.
      }
    }
    if (error instanceof RuntimeInstallError) throw error;
    throw new RuntimeInstallError(`runtime installation failed: ${error.message}`);
  } finally {
    await cleanupDownloadReservation(downloadPath, downloadHandle);
    await safeRemove(staging);
    if (!backedUp) await safeRemove(backup);
  }
}
