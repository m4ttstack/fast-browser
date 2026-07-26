import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import crypto from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import test from 'node:test';

import { installRuntime } from '../../lib/runtime/install.mjs';

const execFile = promisify(execFileCallback);

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function pathsFor(home) {
  return {
    dataDir: path.join(home, '.fast-browser'),
    runtimeDir: path.join(home, '.fast-browser', 'runtime'),
  };
}

function lockFor(url, archive, overrides = {}) {
  return {
    schemaVersion: 1,
    productVersion: '0.1.0-alpha.1',
    sourceCommit: '0123456789abcdef',
    protocolVersion: 2,
    runtime: {
      url,
      file: 'fast-browser-mcp-0.1.0-alpha.1.tar.gz',
      sha256: sha256(archive),
      node: '>=20',
      ...overrides,
    },
    extension: {
      url: 'http://127.0.0.1:1/unused.zip',
      file: 'fast-browser-extension-0.1.0-alpha.1.zip',
      sha256: 'b'.repeat(64),
      id: 'abcdefghijklmnopabcdefghijklmnop',
      version: '0.2.1',
    },
  };
}

function lockIdentity(lock) {
  return {
    schemaVersion: 1,
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

async function validTar() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-tar-'));
  const payload = path.join(directory, 'payload');
  await mkdir(path.join(payload, 'fast-browser-mcp'), { recursive: true });
  await writeFile(
    path.join(payload, 'fast-browser-mcp', 'cli.cjs'),
    '#!/usr/bin/env node\nprocess.stdout.write("fixture");\n',
    { mode: 0o755 },
  );
  const archive = path.join(directory, 'runtime.tar.gz');
  await execFile(
    '/usr/bin/tar',
    ['--format', 'ustar', '-czf', archive, '-C', payload, 'fast-browser-mcp'],
  );
  return readFile(archive);
}

async function loopbackServer(body) {
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { 'content-type': 'application/gzip' });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/runtime.tar.gz`,
    requests: () => requests,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function writeOctal(header, start, length, value) {
  const text = value.toString(8).padStart(length - 1, '0');
  header.write(text, start, length - 1, 'ascii');
  header[start + length - 1] = 0;
}

function syntheticTar({ name, type = '0', body = Buffer.from('x'), afterNul = null }) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  if (afterNul) {
    const nul = header.indexOf(0, 0);
    header.write(afterNul, nul + 1, 'utf8');
  }
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, type === '0' ? body.length : 0);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  writeOctal(header, 148, 8, [...header].reduce((sum, byte) => sum + byte, 0));
  const padded = type === '0'
    ? Buffer.concat([body, Buffer.alloc((512 - (body.length % 512)) % 512)])
    : Buffer.alloc(0);
  return zlib.gzipSync(Buffer.concat([header, padded, Buffer.alloc(1024)]));
}

test('installs once from loopback, verifies identity, and writes a private marker', async (t) => {
  const archive = await validTar();
  const server = await loopbackServer(archive);
  t.after(server.close);
  const home = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-home-'));
  const paths = pathsFor(home);
  const lock = lockFor(server.url, archive);

  const first = await installRuntime({ lock, paths, fetch });
  const second = await installRuntime({ lock, paths, fetch });

  assert.equal(server.requests(), 1);
  assert.deepEqual(second, first);
  assert.equal(
    await readFile(first.cli, 'utf8'),
    '#!/usr/bin/env node\nprocess.stdout.write("fixture");\n',
  );
  assert.equal((await stat(first.marker)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(first.marker, 'utf8')), {
    schemaVersion: 1,
    lock: lockIdentity(lock),
  });
  assert.deepEqual(
    (await readdir(path.join(paths.runtimeDir, lock.productVersion))).sort(),
    ['fast-browser-mcp', 'installed.json'],
  );
});

test('checksum and interrupted downloads leave no remnants and preserve a prior install', async (t) => {
  const archive = await validTar();
  const server = await loopbackServer(archive);
  t.after(server.close);
  const home = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-home-'));
  const paths = pathsFor(home);
  const lock = lockFor(server.url, archive);
  const installed = await installRuntime({ lock, paths, fetch });
  const originalCli = await readFile(installed.cli, 'utf8');
  const originalMarker = await readFile(installed.marker, 'utf8');

  await assert.rejects(
    installRuntime({
      lock: lockFor(server.url, archive, { sha256: '0'.repeat(64) }),
      paths,
      fetch,
    }),
    /checksum/i,
  );
  assert.equal(await readFile(installed.cli, 'utf8'), originalCli);
  assert.equal(await readFile(installed.marker, 'utf8'), originalMarker);
  assert.equal(
    (await readdir(path.join(paths.runtimeDir, lock.productVersion)))
      .some((entry) => entry === '.download' || entry.startsWith('.staging-')),
    false,
  );

  const emptyHome = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-home-'));
  const interruptedFetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.error(new Error('interrupted fixture'));
    },
  }), { status: 200 });
  await assert.rejects(
    installRuntime({
      lock,
      paths: pathsFor(emptyHome),
      fetch: interruptedFetch,
    }),
    /download.*interrupted fixture/i,
  );
  const versionDir = path.join(pathsFor(emptyHome).runtimeDir, lock.productVersion);
  assert.deepEqual(await readdir(versionDir), []);
});

test('rejects traversal, absolute, backslash, ambiguous-NUL, and symlink tar entries', async () => {
  const maliciousArchives = [
    syntheticTar({ name: '../escape' }),
    syntheticTar({ name: '/absolute' }),
    syntheticTar({ name: '..\\escape' }),
    syntheticTar({ name: 'C:\\escape' }),
    syntheticTar({ name: 'safe', afterNul: 'ambiguous' }),
    syntheticTar({ name: 'fast-browser-mcp/link', type: '2' }),
  ];

  for (const archive of maliciousArchives) {
    const home = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-home-'));
    const paths = pathsFor(home);
    const lock = lockFor('http://127.0.0.1:1/runtime.tar.gz', archive);
    const fixtureFetch = async () => new Response(archive, { status: 200 });
    await assert.rejects(
      installRuntime({ lock, paths, fetch: fixtureFetch }),
      /unsafe tar entry|unsupported tar entry/i,
    );
    assert.deepEqual(
      await readdir(path.join(paths.runtimeDir, lock.productVersion)),
      [],
    );
  }
});

test('rejects an archive missing the expected runtime CLI before promotion', async () => {
  const archive = syntheticTar({ name: 'fast-browser-mcp/README.md' });
  const home = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-home-'));
  const paths = pathsFor(home);
  const lock = lockFor('http://127.0.0.1:1/runtime.tar.gz', archive);

  await assert.rejects(
    installRuntime({
      lock,
      paths,
      fetch: async () => new Response(archive, { status: 200 }),
    }),
    /expected runtime CLI/i,
  );
  assert.deepEqual(await readdir(path.join(paths.runtimeDir, lock.productVersion)), []);
});

test('defense-in-depth rejects a raw lock whose runtime version escapes its root', async () => {
  const archive = await validTar();
  const home = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-home-'));
  const paths = pathsFor(home);
  const lock = lockFor('http://127.0.0.1:1/runtime.tar.gz', archive);
  lock.productVersion = '..';
  let fetchCalls = 0;

  await assert.rejects(
    installRuntime({
      lock,
      paths,
      fetch: async () => {
        fetchCalls += 1;
        return new Response(archive, { status: 200 });
      },
    }),
    /confined|outside|descendant/i,
  );
  assert.equal(fetchCalls, 0);
});

test('refuses pre-existing symlinks that would move runtime writes outside dataDir', async () => {
  const archive = await validTar();
  for (const symlinkAt of ['data', 'root', 'version']) {
    const home = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-home-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-outside-'));
    const paths = pathsFor(home);
    await writeFile(path.join(outside, 'sentinel'), 'unchanged');
    if (symlinkAt === 'data') {
      await symlink(outside, paths.dataDir);
    } else {
      await mkdir(paths.dataDir, { recursive: true });
      if (symlinkAt === 'root') {
        await symlink(outside, paths.runtimeDir);
      } else {
        await mkdir(paths.runtimeDir);
        await symlink(outside, path.join(paths.runtimeDir, '0.1.0-alpha.1'));
      }
    }
    const before = (await readdir(outside)).sort();
    let fetchCalls = 0;
    await assert.rejects(
      installRuntime({
        lock: lockFor('http://127.0.0.1:1/runtime.tar.gz', archive),
        paths,
        fetch: async () => {
          fetchCalls += 1;
          return new Response(archive, { status: 200 });
        },
      }),
      /symlink|confined|outside/i,
      symlinkAt,
    );
    assert.equal(fetchCalls, 0);
    assert.deepEqual((await readdir(outside)).sort(), before);
    assert.equal(await readFile(path.join(outside, 'sentinel'), 'utf8'), 'unchanged');
  }
});
