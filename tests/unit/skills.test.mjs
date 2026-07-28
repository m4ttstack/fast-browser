import assert from 'node:assert/strict';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { OFFERED_PALETTES } from '../../lib/annotate/palette.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repositoryRoot = path.resolve(pluginRoot, '../..');
const skillNames = ['fast-browsing', 'browser-macros', 'mine-macros', 'annotating-screenshots'];

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

// Each assertion here pins one instruction that a baseline run without the
// skill got wrong. Agents already measure rather than eyeball the PNG, so the
// failures worth guarding are provenance ones: a PNG and a measurement taken
// from different page loads, a hand-authored `measured` block that satisfies
// the base-image check by lying to it, and geometry the agent could only find
// by reading lib/annotate/svg.mjs. Losing any of these lines is a silent
// regression to boxes that look right and are not.
test('the annotation skill states the rules the baseline runs violated', async () => {
  const text = await readFile(
    path.join(pluginRoot, 'skills/annotating-screenshots/SKILL.md'),
    'utf8',
  );

  // Atomicity: one macro call is the source of both the PNG and the boxes.
  assert.match(text, /capture-annotated\.js/);
  assert.match(text, /same return value of the same call/);
  assert.match(text, /Annotate a PNG captured by an earlier call/);
  assert.match(text, /Measure with your own `boundingBox\(\)`/);
  // The macro was absent in one baseline environment and went uninstalled.
  assert.match(text, /fast-browser setup/);

  // Corroboration must be copied, never authored.
  assert.match(text, /Copy `schemaVersion` and\n\s*`viewport` verbatim/);

  // A missed key never becomes an annotation, and never resolves by first hit.
  assert.match(text, /Never take the first of N matches/);
  assert.match(text, /has not been redacted/);

  // Chip geometry, and the fact that `annotate` cannot catch a clipped label.
  assert.match(text, /`chip\.xy` is its \*\*top left\*\* corner/);
  assert.match(text, /bounds-checks only the anchor point/);

  // Padding and blur strength were improvised in every baseline sample.
  assert.match(text, /Pad every measured box by 6 px/);
  assert.match(text, /`blur\.amount` is half the box height/);

  // Spec requirements: composition, palette, approval prompt, purge.
  assert.match(text, /Never blur the value the screenshot exists to prove/);
  assert.match(text, /never over card content/);
  for (const palette of OFFERED_PALETTES) {
    assert.match(text, new RegExp(`\`${palette}\``), palette);
  }
  assert.match(text, /configure --palette/);
  assert.match(text, /it is not a failure/);
  assert.match(text, /uninstall --purge-data/);
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
