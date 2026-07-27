import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildContentManifestDigest } from '../../lib/extension/content-manifest.mjs';

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'fast-browser-content-manifest-'));
}

async function writeTree(root, files) {
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
}

test('produces the same digest for two independently built, byte-identical trees', async () => {
  const first = await tempDir();
  const second = await tempDir();
  await writeTree(first, {
    'manifest.json': '{"version":"0.2.2"}',
    'lib/background.mjs': 'export const x = 1;\n',
  });
  await writeTree(second, {
    'manifest.json': '{"version":"0.2.2"}',
    'lib/background.mjs': 'export const x = 1;\n',
  });

  assert.equal(
    await buildContentManifestDigest(first),
    await buildContentManifestDigest(second),
  );
});

test('a single byte difference in one nested file changes the digest', async () => {
  const first = await tempDir();
  const second = await tempDir();
  await writeTree(first, {
    'manifest.json': '{"version":"0.2.2"}',
    'lib/background.mjs': 'export const x = 1;\n',
  });
  await writeTree(second, {
    'manifest.json': '{"version":"0.2.2"}',
    'lib/background.mjs': 'export const x = 2;\n',
  });

  assert.notEqual(
    await buildContentManifestDigest(first),
    await buildContentManifestDigest(second),
  );
});

test('an added file changes the digest even when the byte total is unchanged', async () => {
  const first = await tempDir();
  const second = await tempDir();
  await writeTree(first, { 'a.txt': 'xx' });
  await writeTree(second, { 'a.txt': 'x', 'b.txt': 'x' });

  assert.notEqual(
    await buildContentManifestDigest(first),
    await buildContentManifestDigest(second),
  );
});

test('a differing file mode changes the digest even with identical bytes', async () => {
  const first = await tempDir();
  const second = await tempDir();
  await writeTree(first, { 'run.sh': '#!/bin/sh\n' });
  await writeTree(second, { 'run.sh': '#!/bin/sh\n' });
  await chmod(path.join(first, 'run.sh'), 0o644);
  await chmod(path.join(second, 'run.sh'), 0o755);

  assert.notEqual(
    await buildContentManifestDigest(first),
    await buildContentManifestDigest(second),
  );
});

test('directory listing order never affects the digest', async () => {
  const first = await tempDir();
  const second = await tempDir();
  await writeFile(path.join(first, 'b.txt'), 'b');
  await writeFile(path.join(first, 'a.txt'), 'a');
  await writeFile(path.join(second, 'a.txt'), 'a');
  await writeFile(path.join(second, 'b.txt'), 'b');

  assert.equal(
    await buildContentManifestDigest(first),
    await buildContentManifestDigest(second),
  );
});

test('refuses a tree containing a symlink rather than silently ignoring it', async () => {
  const root = await tempDir();
  await writeFile(path.join(root, 'real.txt'), 'x');
  await symlink('real.txt', path.join(root, 'link.txt'));

  await assert.rejects(buildContentManifestDigest(root));
});

test('rejects a root that does not exist', async () => {
  const root = await tempDir();
  await assert.rejects(buildContentManifestDigest(path.join(root, 'missing')));
});

test('rejects a root that is itself a symlink', async () => {
  const root = await tempDir();
  const real = path.join(root, 'real');
  await mkdir(real);
  await symlink(real, path.join(root, 'link'));

  await assert.rejects(buildContentManifestDigest(path.join(root, 'link')));
});
