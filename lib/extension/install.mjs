import { execFile as execFileCallback } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';

import { assertConfinedPath } from '../core/containment.mjs';
import { runtimeLockIdentity } from '../runtime/lock.mjs';

const execFile = promisify(execFileCallback);
const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_END = 0x06054b50;

export class ExtensionInstallError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExtensionInstallError';
  }
}

function resultFor(lock, paths) {
  const directory = path.join(paths.extensionDir, lock.extension.version);
  return {
    version: lock.extension.version,
    directory,
    unpacked: path.join(directory, 'unpacked'),
    manifest: path.join(directory, 'unpacked', 'manifest.json'),
    marker: path.join(directory, 'installed.json'),
  };
}

function checksumBytes(value, field) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new ExtensionInstallError(`${field} must be a 64-character hexadecimal checksum`);
  }
  return Buffer.from(value, 'hex');
}

function checksumMatches(actual, expected) {
  return crypto.timingSafeEqual(
    checksumBytes(actual, 'download checksum'),
    checksumBytes(expected, 'extension.sha256'),
  );
}

function deriveExtensionId(key) {
  if (
    typeof key !== 'string'
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(key)
    || key.length % 4 !== 0
  ) {
    throw new ExtensionInstallError('extension manifest has an invalid key');
  }
  const publicKey = Buffer.from(key, 'base64');
  try {
    crypto.createPublicKey({ key: publicKey, format: 'der', type: 'spki' });
  } catch {
    throw new ExtensionInstallError('extension manifest has an invalid key');
  }
  return [...crypto.createHash('sha256').update(publicKey).digest().subarray(0, 16)]
    .flatMap((byte) => [byte >> 4, byte & 15])
    .map((nibble) => String.fromCharCode(97 + nibble))
    .join('');
}

async function validateManifest(manifestPath, lock) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new ExtensionInstallError(`unable to read extension manifest: ${error.message}`);
  }
  const id = deriveExtensionId(manifest.key);
  if (id !== lock.extension.id) {
    throw new ExtensionInstallError('extension manifest extension ID does not match the lock');
  }
  if (manifest.version !== lock.extension.version) {
    throw new ExtensionInstallError('extension manifest version does not match the lock');
  }
  return manifest;
}

async function existingInstall(lock, paths) {
  const result = resultFor(lock, paths);
  try {
    const [marker, markerState] = await Promise.all([
      readFile(result.marker, 'utf8').then(JSON.parse),
      stat(result.marker),
      validateManifest(result.manifest, lock),
    ]);
    return marker.schemaVersion === 1
      && isDeepStrictEqual(marker.lock, runtimeLockIdentity(lock))
      && markerState.isFile()
      && (markerState.mode & 0o777) === 0o600
      ? result
      : null;
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
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
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
    throw new ExtensionInstallError(`extension download failed: ${error.message}`);
  }
  if (!checksumMatches(hash.digest('hex'), expectedSha256)) {
    throw new ExtensionInstallError('extension checksum mismatch');
  }
}

function safeZipPath(name, directory) {
  if (
    name.length === 0
    || name.includes('\0')
    || name.startsWith('/')
    || name.startsWith('\\')
    || /^[A-Za-z]:[\\/]/.test(name)
  ) {
    throw new ExtensionInstallError(`unsafe zip entry ${JSON.stringify(name)}`);
  }
  const unified = name.replaceAll('\\', '/');
  const withoutDirectorySlash = directory && unified.endsWith('/')
    ? unified.slice(0, -1)
    : unified;
  if (
    withoutDirectorySlash.split('/').some(
      (segment) => segment === '' || segment === '.' || segment === '..',
    )
    || (!directory && unified.endsWith('/'))
  ) {
    throw new ExtensionInstallError(`unsafe zip entry ${JSON.stringify(name)}`);
  }
  return withoutDirectorySlash;
}

function endOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_END) return offset;
  }
  throw new ExtensionInstallError('invalid zip archive: missing central directory');
}

function decodeName(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ExtensionInstallError('unsafe zip entry: invalid UTF-8 filename');
  }
}

function validateZip(buffer) {
  const endOffset = endOfCentralDirectory(buffer);
  const disk = buffer.readUInt16LE(endOffset + 4);
  const centralDisk = buffer.readUInt16LE(endOffset + 6);
  const diskEntries = buffer.readUInt16LE(endOffset + 8);
  const totalEntries = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  const commentLength = buffer.readUInt16LE(endOffset + 20);
  if (
    disk !== 0
    || centralDisk !== 0
    || diskEntries !== totalEntries
    || endOffset + 22 + commentLength !== buffer.length
    || centralOffset + centralSize !== endOffset
  ) {
    throw new ExtensionInstallError('invalid zip archive: ambiguous central directory');
  }

  const names = new Set();
  let offset = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > endOffset || buffer.readUInt32LE(offset) !== ZIP_CENTRAL_HEADER) {
      throw new ExtensionInstallError('invalid zip archive: malformed central entry');
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const entryCommentLength = buffer.readUInt16LE(offset + 32);
    const startDisk = buffer.readUInt16LE(offset + 34);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd + extraLength + entryCommentLength > endOffset) {
      throw new ExtensionInstallError('invalid zip archive: truncated central entry');
    }
    const nameBytes = buffer.subarray(nameStart, nameEnd);
    const name = decodeName(nameBytes);
    const unixMode = externalAttributes >>> 16;
    const unixType = unixMode & 0o170000;
    const directory = name.endsWith('/') || (externalAttributes & 0x10) !== 0;
    if (flags & 1 || startDisk !== 0 || unixType === 0o120000) {
      throw new ExtensionInstallError(`unsupported zip entry ${JSON.stringify(name)}`);
    }
    if (![0, 8].includes(method)) {
      throw new ExtensionInstallError(`unsupported zip entry ${JSON.stringify(name)}`);
    }
    const safeName = safeZipPath(name, directory);
    if (names.has(safeName)) {
      throw new ExtensionInstallError(`unsafe zip entry ${JSON.stringify(name)}: duplicate path`);
    }
    names.add(safeName);

    if (localOffset + 30 > centralOffset || buffer.readUInt32LE(localOffset) !== ZIP_LOCAL_HEADER) {
      throw new ExtensionInstallError(`unsafe zip entry ${JSON.stringify(name)}: missing local header`);
    }
    const localFlags = buffer.readUInt16LE(localOffset + 6);
    const localMethod = buffer.readUInt16LE(localOffset + 8);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const localName = buffer.subarray(
      localOffset + 30,
      localOffset + 30 + localNameLength,
    );
    if (
      localFlags !== flags
      || localMethod !== method
      || !localName.equals(nameBytes)
      || localOffset + 30 + localNameLength + localExtraLength > centralOffset
    ) {
      throw new ExtensionInstallError(`unsafe zip entry ${JSON.stringify(name)}: ambiguous header`);
    }
    offset = nameEnd + extraLength + entryCommentLength;
  }
  if (offset !== endOffset) {
    throw new ExtensionInstallError('invalid zip archive: central directory size mismatch');
  }
}

async function safeRemove(target) {
  try {
    await rm(target, { recursive: true, force: true });
  } catch {
    // Preserve the original failure when best-effort cleanup also fails.
  }
}

async function safeUnlink(target) {
  try {
    await unlink(target);
  } catch {
    // Never recurse through or follow a replacement download path during cleanup.
  }
}

async function writeMarker(markerPath, lock) {
  const temporary = `${markerPath}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({ schemaVersion: 1, lock: runtimeLockIdentity(lock) }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await chmod(temporary, 0o600);
    await rename(temporary, markerPath);
  } catch (error) {
    await safeRemove(temporary);
    throw error;
  }
}

export async function installExtension({ lock, paths, fetch: fetchImplementation }) {
  const result = resultFor(lock, paths);
  await Promise.all([
    assertConfinedPath({
      dataDir: paths.dataDir,
      rootDir: paths.extensionDir,
      candidate: result.manifest,
    }),
    assertConfinedPath({
      dataDir: paths.dataDir,
      rootDir: paths.extensionDir,
      candidate: result.marker,
    }),
    assertConfinedPath({
      dataDir: paths.dataDir,
      rootDir: paths.extensionDir,
      candidate: path.join(result.directory, '.download'),
    }),
  ]);
  const existing = await existingInstall(lock, paths);
  if (existing) return existing;
  if (typeof fetchImplementation !== 'function' && !lock.extension.url.startsWith('file:')) {
    throw new ExtensionInstallError('a Fetch-compatible fetch is required');
  }

  const downloadPath = path.join(result.directory, '.download');
  const staging = path.join(result.directory, `.staging-${crypto.randomUUID()}`);
  const backup = path.join(result.directory, `.backup-${crypto.randomUUID()}`);
  let backedUp = false;
  let promoted = false;
  await mkdir(result.directory, { recursive: true, mode: 0o700 });
  let downloadHandle;
  try {
    downloadHandle = await open(downloadPath, 'wx', 0o600);
    await downloadHandle.chmod(0o600);
  } catch (error) {
    throw new ExtensionInstallError(
      `extension download staging path unavailable (${error.code ?? error.message}); `
      + 'remove the stale .download file and run fast-browser doctor',
    );
  }
  try {
    await download(
      lock.extension.url,
      downloadHandle,
      lock.extension.sha256,
      fetchImplementation,
    );
    await downloadHandle.close();
    downloadHandle = null;
    validateZip(await readFile(downloadPath));
    await mkdir(staging, { mode: 0o700 });
    await execFile('/usr/bin/unzip', ['-qq', downloadPath, '-d', staging]);
    await validateManifest(path.join(staging, 'manifest.json'), lock);

    try {
      await rename(result.unpacked, backup);
      backedUp = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await rename(staging, result.unpacked);
    promoted = true;
    try {
      await writeMarker(result.marker, lock);
    } catch (error) {
      await safeRemove(result.unpacked);
      promoted = false;
      if (backedUp) {
        await rename(backup, result.unpacked);
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
      await safeRemove(result.unpacked);
      try {
        await rename(backup, result.unpacked);
        backedUp = false;
      } catch {
        // Keep the backup rather than deleting the prior extension.
      }
    }
    if (error instanceof ExtensionInstallError) throw error;
    throw new ExtensionInstallError(`extension installation failed: ${error.message}`);
  } finally {
    if (downloadHandle) {
      try {
        await downloadHandle.close();
      } catch {
        // Cleanup continues with an unlink that never follows the path.
      }
    }
    await safeUnlink(downloadPath);
    await safeRemove(staging);
    if (!backedUp) await safeRemove(backup);
  }
}
