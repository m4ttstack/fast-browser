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
import test from 'node:test';

import { buildContentManifestDigest } from '../../lib/extension/content-manifest.mjs';
import { detectChromeExtension } from '../../lib/extension/detect.mjs';
import { installExtension } from '../../lib/extension/install.mjs';

const execFile = promisify(execFileCallback);

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function extensionId(publicKeyDer) {
  return [...crypto.createHash('sha256').update(publicKeyDer).digest().subarray(0, 16)]
    .flatMap((byte) => [byte >> 4, byte & 15])
    .map((nibble) => String.fromCharCode(97 + nibble))
    .join('');
}

function pathsFor(home) {
  return {
    dataDir: path.join(home, '.fast-browser'),
    extensionDir: path.join(home, '.fast-browser', 'extension'),
  };
}

function lockFor(url, archive, id, overrides = {}) {
  return {
    schemaVersion: 1,
    productVersion: '0.1.0-alpha.1',
    sourceCommit: '0123456789abcdef',
    protocolVersion: 2,
    runtime: {
      url: 'http://127.0.0.1:1/unused.tar.gz',
      file: 'fast-browser-mcp-0.1.0-alpha.1.tar.gz',
      sha256: 'a'.repeat(64),
      node: '>=20',
    },
    extension: {
      url,
      file: 'fast-browser-extension-0.1.0-alpha.1.zip',
      sha256: sha256(archive),
      id,
      version: '0.2.1',
      ...overrides,
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

async function extensionFixture(manifestOverrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-zip-'));
  const payload = path.join(directory, 'payload');
  await mkdir(payload);
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
  const manifest = {
    manifest_version: 3,
    name: 'Synthetic Fast Browser',
    version: '0.2.1',
    key: publicKeyDer.toString('base64'),
    ...manifestOverrides,
  };
  await writeFile(path.join(payload, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(payload, 'worker.js'), 'void 0;\n');
  const archivePath = path.join(directory, 'extension.zip');
  await execFile('/usr/bin/zip', ['-q', '-X', '-r', archivePath, '.'], { cwd: payload });
  return {
    archive: await readFile(archivePath),
    id: extensionId(publicKeyDer),
    manifest,
  };
}

async function loopbackServer(body) {
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { 'content-type': 'application/zip' });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/extension.zip`,
    requests: () => requests,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function rewriteZipName(archive, from, to) {
  assert.equal(Buffer.byteLength(from), Buffer.byteLength(to));
  const result = Buffer.from(archive);
  let offset = 0;
  let replacements = 0;
  while ((offset = result.indexOf(from, offset, 'utf8')) !== -1) {
    result.write(to, offset, Buffer.byteLength(to), 'utf8');
    offset += Buffer.byteLength(to);
    replacements += 1;
  }
  assert.ok(replacements >= 2);
  return result;
}

async function namedZip(name = 'aa/evil') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-zip-'));
  const payload = path.join(directory, 'payload');
  await mkdir(path.join(payload, 'aa'), { recursive: true });
  await writeFile(path.join(payload, 'aa', 'evil'), 'x');
  const archivePath = path.join(directory, 'named.zip');
  await execFile('/usr/bin/zip', ['-q', '-X', archivePath, name], { cwd: payload });
  return readFile(archivePath);
}

test('installs once, derives the exact manifest key ID, and writes a private marker', async (t) => {
  const fixture = await extensionFixture();
  const server = await loopbackServer(fixture.archive);
  t.after(server.close);
  const home = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-home-'));
  const paths = pathsFor(home);
  const lock = lockFor(server.url, fixture.archive, fixture.id);

  const first = await installExtension({ lock, paths, fetch });
  const second = await installExtension({ lock, paths, fetch });

  assert.equal(server.requests(), 1);
  assert.deepEqual(second, first);
  assert.deepEqual(
    JSON.parse(await readFile(first.manifest, 'utf8')),
    fixture.manifest,
  );
  assert.equal((await stat(first.marker)).mode & 0o777, 0o600);
  const marker = JSON.parse(await readFile(first.marker, 'utf8'));
  const expectedDigest = await buildContentManifestDigest(first.unpacked);
  assert.deepEqual(marker, {
    schemaVersion: 1,
    lock: lockIdentity(lock),
    contentDigest: expectedDigest,
  });
  assert.deepEqual(
    (await readdir(path.join(paths.extensionDir, lock.extension.version))).sort(),
    ['installed.json', 'unpacked'],
  );
});

test('rejects traversal, absolute, backslash, drive, NUL, and symlink zip entries', async () => {
  const base = await namedZip();
  const archives = [
    rewriteZipName(base, 'aa/evil', '../evil'),
    rewriteZipName(base, 'aa/evil', '/a/evil'),
    rewriteZipName(base, 'aa/evil', '..\\evil'),
    rewriteZipName(base, 'aa/evil', 'C:\\evil'),
    rewriteZipName(base, 'aa/evil', 'aa\0evil'),
  ];

  const symlinkDirectory = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-zip-'));
  await writeFile(path.join(symlinkDirectory, 'target'), 'x');
  await symlink('target', path.join(symlinkDirectory, 'link'));
  const symlinkArchivePath = path.join(symlinkDirectory, 'symlink.zip');
  await execFile('/usr/bin/zip', ['-q', '-X', '-y', symlinkArchivePath, 'link'], {
    cwd: symlinkDirectory,
  });
  archives.push(await readFile(symlinkArchivePath));

  for (const archive of archives) {
    const home = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-home-'));
    const paths = pathsFor(home);
    const lock = lockFor(
      'http://127.0.0.1:1/extension.zip',
      archive,
      'abcdefghijklmnopabcdefghijklmnop',
    );
    await assert.rejects(
      installExtension({
        lock,
        paths,
        fetch: async () => new Response(archive, { status: 200 }),
      }),
      /unsafe zip entry|unsupported zip entry/i,
    );
    assert.deepEqual(
      await readdir(path.join(paths.extensionDir, lock.extension.version)),
      [],
    );
  }
});

test('manifest ID or version mismatch never replaces a prior valid extension', async (t) => {
  const fixture = await extensionFixture();
  const server = await loopbackServer(fixture.archive);
  t.after(server.close);
  const home = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-home-'));
  const paths = pathsFor(home);
  const lock = lockFor(server.url, fixture.archive, fixture.id);
  const installed = await installExtension({ lock, paths, fetch });
  const originalManifest = await readFile(installed.manifest, 'utf8');
  const originalMarker = await readFile(installed.marker, 'utf8');

  await assert.rejects(
    installExtension({
      lock: lockFor(server.url, fixture.archive, 'a'.repeat(32)),
      paths,
      fetch,
    }),
    /manifest.*extension ID/i,
  );
  assert.equal(await readFile(installed.manifest, 'utf8'), originalManifest);
  assert.equal(await readFile(installed.marker, 'utf8'), originalMarker);

  const wrongVersion = await extensionFixture({ version: '9.9.9' });
  await assert.rejects(
    installExtension({
      lock: lockFor(
        'http://127.0.0.1:1/extension.zip',
        wrongVersion.archive,
        wrongVersion.id,
      ),
      paths: pathsFor(await mkdtemp(path.join(os.tmpdir(), 'fast-browser-home-'))),
      fetch: async () => new Response(wrongVersion.archive, { status: 200 }),
    }),
    /manifest.*version/i,
  );
});

test('detects exact IDs only in Default and Profile <N> without returning preferences or secrets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-chrome-'));
  const id = 'abcdefghijklmnopabcdefghijklmnop';
  const nearId = `${id.slice(0, -1)}a`;
  const defaultManifest = path.join(root, 'Default', 'Extensions', id, '0.2.1');
  await mkdir(defaultManifest, { recursive: true });
  await writeFile(path.join(defaultManifest, 'manifest.json'), JSON.stringify({ version: '0.2.1' }));
  await mkdir(path.join(root, 'Default', 'Local Extension Settings', id), { recursive: true });
  await writeFile(path.join(root, 'Default', 'Local Extension Settings', id, 'secret'), 'do-not-read');

  await mkdir(path.join(root, 'Profile 2'), { recursive: true });
  await writeFile(path.join(root, 'Profile 2', 'Preferences'), JSON.stringify({
    extensions: {
      settings: {
        [id]: { state: 1, manifest: { version: '0.2.2' }, token: 'do-not-return' },
      },
    },
  }));
  await mkdir(path.join(root, 'Profile 3', 'Extensions', nearId, '0.2.3'), { recursive: true });
  await writeFile(
    path.join(root, 'Profile 3', 'Extensions', nearId, '0.2.3', 'manifest.json'),
    JSON.stringify({ version: '0.2.3' }),
  );
  await mkdir(path.join(root, 'Profile Personal', 'Extensions', id, '0.2.4'), {
    recursive: true,
  });

  assert.deepEqual(await detectChromeExtension({
    extensionId: id,
    chromeUserDataDir: root,
  }), [
    { profile: 'Default', installed: true, manifestVersion: '0.2.1', path: defaultManifest },
    { profile: 'Profile 2', installed: true, manifestVersion: '0.2.2', path: null },
    { profile: 'Profile 3', installed: false, manifestVersion: null, path: null },
  ]);
});

test('defense-in-depth rejects a raw lock whose extension version escapes its root', async () => {
  const fixture = await extensionFixture();
  const home = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-home-'));
  const paths = pathsFor(home);
  const lock = lockFor(
    'http://127.0.0.1:1/extension.zip',
    fixture.archive,
    fixture.id,
  );
  lock.extension.version = '..';
  let fetchCalls = 0;

  await assert.rejects(
    installExtension({
      lock,
      paths,
      fetch: async () => {
        fetchCalls += 1;
        return new Response(fixture.archive, { status: 200 });
      },
    }),
    /confined|outside|descendant/i,
  );
  assert.equal(fetchCalls, 0);
});

test('refuses pre-existing symlinks that would move extension writes outside dataDir', async () => {
  const fixture = await extensionFixture();
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
        await symlink(outside, paths.extensionDir);
      } else {
        await mkdir(paths.extensionDir);
        await symlink(outside, path.join(paths.extensionDir, '0.2.1'));
      }
    }
    const before = (await readdir(outside)).sort();
    let fetchCalls = 0;
    await assert.rejects(
      installExtension({
        lock: lockFor(
          'http://127.0.0.1:1/extension.zip',
          fixture.archive,
          fixture.id,
        ),
        paths,
        fetch: async () => {
          fetchCalls += 1;
          return new Response(fixture.archive, { status: 200 });
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

test('rejects a pre-existing extension .download symlink before fetch or outside mutation', async () => {
  const fixture = await extensionFixture();
  const home = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-home-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-outside-'));
  const paths = pathsFor(home);
  const lock = lockFor(
    'http://127.0.0.1:1/extension.zip',
    fixture.archive,
    fixture.id,
  );
  const versionDirectory = path.join(paths.extensionDir, lock.extension.version);
  const outsideFile = path.join(outside, 'sentinel');
  await mkdir(versionDirectory, { recursive: true });
  await writeFile(outsideFile, 'unchanged');
  await symlink(outsideFile, path.join(versionDirectory, '.download'));
  const before = (await readdir(outside)).sort();
  let fetchCalls = 0;

  await assert.rejects(
    installExtension({
      lock,
      paths,
      fetch: async () => {
        fetchCalls += 1;
        return new Response(fixture.archive, { status: 200 });
      },
    }),
    /download|symlink|confined/i,
  );
  assert.equal(fetchCalls, 0);
  assert.deepEqual((await readdir(outside)).sort(), before);
  assert.equal(await readFile(outsideFile, 'utf8'), 'unchanged');
});

test('fails closed on a stale ordinary extension .download file before fetch', async () => {
  const fixture = await extensionFixture();
  const home = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-home-'));
  const paths = pathsFor(home);
  const lock = lockFor(
    'http://127.0.0.1:1/extension.zip',
    fixture.archive,
    fixture.id,
  );
  const versionDirectory = path.join(paths.extensionDir, lock.extension.version);
  const downloadPath = path.join(versionDirectory, '.download');
  await mkdir(versionDirectory, { recursive: true });
  await writeFile(downloadPath, 'stale-download');
  let fetchCalls = 0;

  await assert.rejects(
    installExtension({
      lock,
      paths,
      fetch: async () => {
        fetchCalls += 1;
        return new Response(fixture.archive, { status: 200 });
      },
    }),
    /download.*exists|download.*unavailable|EEXIST/i,
  );
  assert.equal(fetchCalls, 0);
  assert.equal(await readFile(downloadPath, 'utf8'), 'stale-download');
});
