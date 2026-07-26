import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export class RuntimeLockError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RuntimeLockError';
  }
}

function object(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RuntimeLockError(`${field} must be an object`);
  }
  return value;
}

function string(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuntimeLockError(`${field} must be a non-empty string`);
  }
  return value;
}

function checksum(value, field) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new RuntimeLockError(`${field} must be a 64-character hexadecimal checksum`);
  }
  return value;
}

function artifactFile(value, field, expected) {
  const file = string(value, field);
  if (file !== path.basename(file) || file !== expected) {
    throw new RuntimeLockError(`${field} must be exactly ${expected}`);
  }
  return file;
}

function artifactUrl(value, field, file, { allowFileUrls }) {
  const text = string(value, field);
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new RuntimeLockError(`${field} must be an immutable GitHub release or loopback fixture URL`);
  }
  if (allowFileUrls && url.protocol === 'file:') {
    if (path.posix.basename(url.pathname) !== file) {
      throw new RuntimeLockError(`${field} filename must match its artifact file`);
    }
    return url.href;
  }
  const loopback = url.protocol === 'http:'
    && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  const releaseParts = url.pathname.match(
    /^\/[^/]+\/[^/]+\/releases\/download\/([^/]+)\/[^/]+$/,
  );
  const immutableRelease = url.protocol === 'https:'
    && url.hostname === 'github.com'
    && releaseParts
    && releaseParts[1] !== 'latest';
  if (!loopback && !immutableRelease) {
    throw new RuntimeLockError(`${field} must be an immutable GitHub release or loopback fixture URL`);
  }
  if (immutableRelease && path.posix.basename(url.pathname) !== file) {
    throw new RuntimeLockError(`${field} filename must match its artifact file`);
  }
  return url.href;
}

export function parseRuntimeLock(value, options = {}) {
  const lock = object(value, 'runtime lock');
  if (lock.schemaVersion !== 1) {
    throw new RuntimeLockError(`unsupported runtime lock schema: ${lock.schemaVersion}`);
  }
  if (!Number.isInteger(lock.protocolVersion) || lock.protocolVersion < 1) {
    throw new RuntimeLockError('protocolVersion must be a positive integer');
  }
  const productVersion = string(lock.productVersion, 'productVersion');
  const sourceCommit = string(lock.sourceCommit, 'sourceCommit');
  if (!/^[0-9a-f]+$/.test(sourceCommit)) {
    throw new RuntimeLockError('sourceCommit must be lowercase hexadecimal');
  }
  const runtime = object(lock.runtime, 'runtime');
  const extension = object(lock.extension, 'extension');
  const runtimeFile = artifactFile(
    runtime.file,
    'runtime.file',
    `fast-browser-mcp-${productVersion}.tar.gz`,
  );
  const extensionFile = artifactFile(
    extension.file,
    'extension.file',
    `fast-browser-extension-${productVersion}.zip`,
  );
  if (runtime.node !== '>=20') {
    throw new RuntimeLockError('runtime.node must be >=20');
  }
  const extensionId = string(extension.id, 'extension.id');
  if (!/^[a-p]{32}$/.test(extensionId)) {
    throw new RuntimeLockError('extension.id must be a 32-character Chrome extension ID');
  }

  return {
    schemaVersion: 1,
    productVersion,
    sourceCommit,
    protocolVersion: lock.protocolVersion,
    runtime: {
      url: artifactUrl(runtime.url, 'runtime.url', runtimeFile, options),
      file: runtimeFile,
      sha256: checksum(runtime.sha256, 'runtime.sha256'),
      node: '>=20',
    },
    extension: {
      url: artifactUrl(extension.url, 'extension.url', extensionFile, options),
      file: extensionFile,
      sha256: checksum(extension.sha256, 'extension.sha256'),
      id: extensionId,
      version: string(extension.version, 'extension.version'),
    },
  };
}

export function runtimeLockIdentity(lock) {
  return {
    schemaVersion: lock.schemaVersion,
    productVersion: lock.productVersion,
    sourceCommit: lock.sourceCommit,
    protocolVersion: lock.protocolVersion,
    runtime: {
      file: lock.runtime.file,
      sha256: lock.runtime.sha256,
      node: lock.runtime.node,
    },
    extension: {
      file: lock.extension.file,
      sha256: lock.extension.sha256,
      id: lock.extension.id,
      version: lock.extension.version,
    },
  };
}

function filesystemPath(value) {
  return value instanceof URL ? fileURLToPath(value) : value;
}

export async function loadRuntimeLock({ bundledPath, overridePath } = {}) {
  const selectedPath = filesystemPath(overridePath ?? bundledPath);
  let value;
  try {
    value = JSON.parse(await readFile(selectedPath, 'utf8'));
  } catch (error) {
    throw new RuntimeLockError(`unable to read runtime lock: ${error.message}`);
  }
  if (!overridePath) return parseRuntimeLock(value);

  const runtime = object(value.runtime, 'runtime');
  const extension = object(value.extension, 'extension');
  if ('url' in runtime || 'url' in extension) {
    throw new RuntimeLockError('runtime lock override must not contain artifact URLs');
  }
  const directory = path.dirname(selectedPath);
  const resolved = {
    ...value,
    runtime: {
      ...runtime,
      url: pathToFileURL(path.join(directory, runtime.file)).href,
    },
    extension: {
      ...extension,
      url: pathToFileURL(path.join(directory, extension.file)).href,
    },
  };
  return parseRuntimeLock(resolved, { allowFileUrls: true });
}
