import assert from 'node:assert/strict';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repositoryRoot = path.resolve(pluginRoot, '../..');
const skillNames = ['fast-browsing', 'browser-macros', 'mine-macros'];

const deployTextExtensions = new Set([
  '.json',
  '.js',
  '.md',
  '.mjs',
  '.toml',
  '.yaml',
  '.yml',
]);

async function packagedTextFiles(directory, relative = '') {
  const files = [];
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'tests') continue;
      files.push(...await packagedTextFiles(directory, child));
    } else if (entry.isFile() && deployTextExtensions.has(path.extname(entry.name))) {
      files.push(child);
    }
  }
  return files.sort();
}

test('packages portable skill and macro files without host-specific remnants', async () => {
  const packagedFiles = await packagedTextFiles(pluginRoot);
  assert.ok(packagedFiles.includes('package.json'));
  assert.ok(packagedFiles.includes('templates/codex/browser_driver.toml'));
  assert.ok(packagedFiles.includes('lib/macros/install.mjs'));
  assert.equal(packagedFiles.some((file) => file.startsWith('tests/')), false);

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

test('macro index exposes only the portable built-in macros', async () => {
  const text = await readFile(path.join(pluginRoot, 'skills/browser-macros/MACROS.md'), 'utf8');

  assert.equal((text.match(/^## /gm) || []).length, 2);
  assert.match(text, /^## page-recon$/m);
  assert.match(text, /maxLinks\?: number \(default 10\)/);
  assert.match(text, /~\/\.fast-browser\/macros\/page-recon\.js/);
  assert.match(text, /^## capture-annotated$/m);
  assert.match(text, /targets: Record<string, string>, out\?: string \(default "capture"\)/);
  assert.match(text, /~\/\.fast-browser\/macros\/capture-annotated\.js/);
  assert.equal((text.match(/Status: built-in/g) || []).length, 2);
});

test('skills and delegated browser guidance use authoritative live ledgers', async () => {
  const browserMacros = await readFile(
    path.join(pluginRoot, 'skills/browser-macros/SKILL.md'),
    'utf8',
  );
  const mineMacros = await readFile(path.join(pluginRoot, 'skills/mine-macros/SKILL.md'), 'utf8');
  const guidanceFiles = [
    'agents/browser-driver.md',
    'templates/codex/browser_driver.toml',
    'skills/fast-browsing/SKILL.md',
    'skills/browser-macros/SKILL.md',
    'skills/mine-macros/SKILL.md',
  ];

  for (const relativeFile of guidanceFiles) {
    assert.match(
      await readFile(path.join(pluginRoot, relativeFile), 'utf8'),
      /~\/\.fast-browser\/macros\/MACROS\.md/,
      relativeFile,
    );
  }
  assert.doesNotMatch(browserMacros, /\[MACROS\.md\]\(MACROS\.md\)/);
  assert.match(mineMacros, /~\/\.fast-browser\/macro-failures\.md/);
  assert.match(mineMacros, /~\/\.fast-browser\/rejected-macros\.md/);
  assert.doesNotMatch(mineMacros, /\[rejected\.md\]\(rejected\.md\)/);
});
