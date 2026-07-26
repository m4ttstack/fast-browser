import assert from 'node:assert/strict';
import { lstat, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repositoryRoot = path.resolve(pluginRoot, '../..');
const skillNames = ['fast-browsing', 'browser-macros', 'mine-macros'];

const packagedFiles = [
  'skills/fast-browsing/SKILL.md',
  'skills/browser-macros/SKILL.md',
  'skills/browser-macros/MACROS.md',
  'skills/mine-macros/SKILL.md',
  'skills/mine-macros/rejected.md',
  'builtins/macros/page-recon.js',
];

test('packages portable skill and macro files without host-specific remnants', async () => {
  for (const relativeFile of packagedFiles) {
    const text = await readFile(path.join(pluginRoot, relativeFile), 'utf8');

    assert.doesNotMatch(
      text,
      /\/Users\/matt|~\/\.claude|~\/\.codex|~\/\.playwright-mcp/,
      relativeFile,
    );
    assert.doesNotMatch(text, /order-wizard|pw-bench/, relativeFile);
  }
});

test('skill frontmatter contains only portable discovery fields', async () => {
  for (const name of skillNames) {
    const skillFile = path.join(pluginRoot, 'skills', name, 'SKILL.md');
    const text = await readFile(skillFile, 'utf8');
    const match = text.match(/^---\n([\s\S]*?)\n---\n/);

    assert.ok(match, `${name} has YAML frontmatter`);
    const fields = match[1]
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(0, line.indexOf(':')));

    assert.deepEqual(fields, ['name', 'description'], `${name} frontmatter fields`);
    assert.match(match[1], new RegExp(`^name: ${name}$`, 'm'));
    assert.match(match[1], /^description: Use when\b.+$/m);
  }
});

test('old skill locations are repository-relative transition links to real packaged files', async () => {
  for (const name of skillNames) {
    const oldDirectory = path.join(repositoryRoot, 'skills', 'browser', name);
    const packagedDirectory = path.join(pluginRoot, 'skills', name);

    assert.equal((await lstat(oldDirectory)).isSymbolicLink(), true, name);
    const target = await readlink(oldDirectory);
    assert.equal(path.isAbsolute(target), false, `${name} link is relative`);
    assert.equal(
      path.resolve(path.dirname(oldDirectory), target),
      packagedDirectory,
      `${name} link target`,
    );
    assert.equal((await lstat(packagedDirectory)).isSymbolicLink(), false, name);
    assert.equal((await lstat(path.join(packagedDirectory, 'SKILL.md'))).isFile(), true, name);
  }
});

test('macro index exposes only the portable built-in page reconnaissance macro', async () => {
  const text = await readFile(path.join(pluginRoot, 'skills/browser-macros/MACROS.md'), 'utf8');

  assert.equal((text.match(/^## /gm) || []).length, 1);
  assert.match(text, /^## page-recon$/m);
  assert.match(text, /maxLinks\?: number \(default 10\)/);
  assert.match(text, /~\/\.fast-browser\/macros\/page-recon\.js/);
  assert.match(text, /Status: built-in/);
});
