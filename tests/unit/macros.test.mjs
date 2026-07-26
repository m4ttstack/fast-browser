import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const execFile = promisify(execFileCallback);

async function temporaryPaths(t, prefix = 'fast-browser-macros-', base = os.tmpdir()) {
  const tempRoot = await mkdtemp(path.join(base, prefix));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const dataDir = path.join(tempRoot, '.fast-browser');
  return {
    tempRoot,
    dataDir,
    macrosDir: path.join(dataDir, 'macros'),
    pluginRoot,
  };
}

test('page-recon returns only bounded headings and links', async () => {
  const source = await readFile(path.join(pluginRoot, 'builtins/macros/page-recon.js'), 'utf8');
  const macro = Function(`"use strict"; return (${source});`)();
  const linkNodes = [
    {
      textContent: ' Continue ',
      getAttribute(name) {
        return name === 'href' ? '/next' : null;
      },
    },
    {
      textContent: 'Ignored',
      getAttribute() {
        return '/ignored';
      },
    },
  ];
  const fakePage = {
    getByRole(role) {
      if (role === 'heading') {
        return {
          async allTextContents() {
            return ['Welcome'];
          },
        };
      }
      assert.equal(role, 'link');
      return {
        async evaluateAll(callback, limit) {
          return callback(linkNodes, limit);
        },
      };
    },
    url() {
      return 'https://example.test/';
    },
    async title() {
      return 'Example';
    },
  };

  assert.deepEqual(await macro(fakePage, { maxLinks: 1 }), {
    url: 'https://example.test/',
    title: 'Example',
    headings: ['Welcome'],
    links: [{ name: 'Continue', href: '/next' }],
  });
});

test('installBuiltinMacros seeds the live index and never overwrites a user-edited macro', async (t) => {
  const { installBuiltinMacros } = await import('../../lib/macros/install.mjs');
  const paths = await temporaryPaths(t);
  const installed = path.join(paths.macrosDir, 'page-recon.js');
  const liveIndex = path.join(paths.macrosDir, 'MACROS.md');
  const bundled = await readFile(path.join(pluginRoot, 'builtins/macros/page-recon.js'), 'utf8');
  const indexTemplate = await readFile(
    path.join(pluginRoot, 'skills/browser-macros/MACROS.md'),
    'utf8',
  );

  await installBuiltinMacros(paths);
  assert.equal(await readFile(installed, 'utf8'), bundled);
  assert.equal(await readFile(liveIndex, 'utf8'), indexTemplate);

  await writeFile(installed, '// user edit\n', 'utf8');
  await installBuiltinMacros(paths);
  assert.equal(await readFile(installed, 'utf8'), '// user edit\n');
  assert.equal(await readFile(liveIndex, 'utf8'), indexTemplate);
});

test('installBuiltinMacros merges the built-in into a custom live index once', async (t) => {
  const { installBuiltinMacros } = await import('../../lib/macros/install.mjs');
  const paths = await temporaryPaths(t, 'fast-browser-macros-custom-');
  await mkdir(paths.macrosDir, { recursive: true, mode: 0o700 });
  const liveIndex = path.join(paths.macrosDir, 'MACROS.md');
  const customEntry = [
    '# Macro Index',
    '',
    '## custom-export',
    '',
    '- Script: `~/.fast-browser/macros/custom-export.js`',
    '- Status: approved',
    '',
  ].join('\n');
  await writeFile(liveIndex, customEntry, 'utf8');

  await installBuiltinMacros(paths);
  await installBuiltinMacros(paths);

  const merged = await readFile(liveIndex, 'utf8');
  assert.match(merged, /^## custom-export$/m);
  assert.equal((merged.match(/^## page-recon$/gm) || []).length, 1);
});

test('installBuiltinMacros preserves a user-authored page-recon index entry byte-for-byte', async (t) => {
  const { installBuiltinMacros } = await import('../../lib/macros/install.mjs');
  const paths = await temporaryPaths(t, 'fast-browser-macros-custom-recon-');
  await mkdir(paths.macrosDir, { recursive: true });
  const liveIndex = path.join(paths.macrosDir, 'MACROS.md');
  const customIndex = [
    '# My macros',
    '',
    '## page-recon',
    '',
    '- Script: `/synthetic/custom-recon.js`',
    '- Status: user-edited',
    '',
  ].join('\n');
  await writeFile(liveIndex, customIndex, 'utf8');

  await installBuiltinMacros(paths);

  assert.equal(await readFile(liveIndex, 'utf8'), customIndex);
});

for (const collision of ['directory', 'symlink', 'socket', 'fifo']) {
  test(`installBuiltinMacros rejects an existing page-recon ${collision}`, async (t) => {
    const { installBuiltinMacros } = await import('../../lib/macros/install.mjs');
    const paths = await temporaryPaths(
      t,
      `fast-browser-macro-${collision}-`,
      collision === 'socket' ? '/tmp' : os.tmpdir(),
    );
    await mkdir(paths.macrosDir, { recursive: true });
    const installed = path.join(paths.macrosDir, 'page-recon.js');
    const victim = path.join(paths.tempRoot, 'victim.js');
    let server;
    if (collision === 'directory') {
      await mkdir(installed);
    } else if (collision === 'symlink') {
      await writeFile(victim, '// keep\n', 'utf8');
      await symlink(victim, installed);
    } else if (collision === 'socket') {
      server = net.createServer();
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(installed, resolve);
        });
      } catch (error) {
        if (error?.code === 'EPERM') {
          t.skip('sandbox does not permit Unix-domain socket creation');
          return;
        }
        throw error;
      }
      t.after(() => new Promise((resolve) => server.close(resolve)));
      assert.equal((await lstat(installed)).isSocket(), true);
    } else {
      await execFile('mkfifo', [installed]);
    }

    await assert.rejects(() => installBuiltinMacros(paths), /regular file|symlink/);
    if (collision === 'symlink') {
      assert.equal(await readFile(victim, 'utf8'), '// keep\n');
      assert.equal((await lstat(installed)).isSymbolicLink(), true);
    }
  });
}

for (const collision of ['directory', 'symlink']) {
  test(`installBuiltinMacros rejects a live-index ${collision} collision safely`, async (t) => {
    const { installBuiltinMacros } = await import('../../lib/macros/install.mjs');
    const paths = await temporaryPaths(t, `fast-browser-index-${collision}-`);
    await mkdir(paths.macrosDir, { recursive: true });
    const liveIndex = path.join(paths.macrosDir, 'MACROS.md');
    const victim = path.join(paths.tempRoot, 'index-victim.md');
    if (collision === 'directory') {
      await mkdir(liveIndex);
    } else {
      await writeFile(victim, '# keep\n', 'utf8');
      await symlink(victim, liveIndex);
    }

    await assert.rejects(
      () => installBuiltinMacros(paths),
      /live macro index must be a regular file|symlink/,
    );
    if (collision === 'symlink') assert.equal(await readFile(victim, 'utf8'), '# keep\n');
  });
}

test('installBuiltinMacros rejects a symlinked macros parent without external writes', async (t) => {
  const { installBuiltinMacros } = await import('../../lib/macros/install.mjs');
  const paths = await temporaryPaths(t, 'fast-browser-macros-parent-link-');
  const external = path.join(paths.tempRoot, 'external');
  await Promise.all([mkdir(paths.dataDir), mkdir(external)]);
  await symlink(external, paths.macrosDir);

  await assert.rejects(() => installBuiltinMacros(paths), /symlink/);
  await assert.rejects(() => lstat(path.join(external, 'page-recon.js')), { code: 'ENOENT' });
  await assert.rejects(() => lstat(path.join(external, 'MACROS.md')), { code: 'ENOENT' });
});

test('an index merge failure preserves the original live index', async (t) => {
  const { installBuiltinMacros } = await import('../../lib/macros/install.mjs');
  const paths = await temporaryPaths(t, 'fast-browser-index-atomic-');
  await mkdir(paths.macrosDir, { recursive: true });
  const liveIndex = path.join(paths.macrosDir, 'MACROS.md');
  const original = '# Macro Index\n\n## custom\n\n- Status: approved\n';
  await writeFile(liveIndex, original, 'utf8');
  await chmod(paths.macrosDir, 0o500);
  try {
    await assert.rejects(() => installBuiltinMacros(paths));
    assert.equal(await readFile(liveIndex, 'utf8'), original);
  } finally {
    await chmod(paths.macrosDir, 0o700);
  }
});
