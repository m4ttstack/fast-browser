import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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

test('installBuiltinMacros copies an absent built-in and never overwrites a user edit', async () => {
  const { installBuiltinMacros } = await import('../../lib/macros/install.mjs');
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-macros-'));
  const macrosDir = path.join(tempRoot, '.fast-browser/macros');
  const paths = { pluginRoot, macrosDir };
  const installed = path.join(macrosDir, 'page-recon.js');
  const bundled = await readFile(path.join(pluginRoot, 'builtins/macros/page-recon.js'), 'utf8');

  await installBuiltinMacros(paths);
  assert.equal(await readFile(installed, 'utf8'), bundled);

  await writeFile(installed, '// user edit\n', 'utf8');
  await installBuiltinMacros(paths);
  assert.equal(await readFile(installed, 'utf8'), '// user edit\n');
});

test('installBuiltinMacros accepts an existing private macro directory', async () => {
  const { installBuiltinMacros } = await import('../../lib/macros/install.mjs');
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-macros-existing-'));
  const macrosDir = path.join(tempRoot, '.fast-browser/macros');
  await mkdir(macrosDir, { recursive: true, mode: 0o700 });

  await installBuiltinMacros({ pluginRoot, macrosDir });

  assert.equal(
    await readFile(path.join(macrosDir, 'page-recon.js'), 'utf8'),
    await readFile(path.join(pluginRoot, 'builtins/macros/page-recon.js'), 'utf8'),
  );
});
