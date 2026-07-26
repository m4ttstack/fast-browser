import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const pluginRoot = fileURLToPath(new URL('../..', import.meta.url));

const requiredEntries = [
  'package/.claude-plugin/plugin.json',
  'package/.codex-plugin/plugin.json',
  'package/.mcp.json',
  'package/adapters/codex/mcp.json',
  'package/agents/browser-driver.md',
  'package/templates/codex/browser_driver.toml',
  'package/templates/routing/claude/fast-browser-routing.md',
  'package/templates/routing/claude/fast-browser-verification-consent.md',
  'package/templates/routing/codex/fast-browser.md',
  'package/skills/browser-macros/SKILL.md',
  'package/skills/fast-browsing/SKILL.md',
  'package/skills/mine-macros/SKILL.md',
  'package/runtime-lock.json',
  'package/README.md',
  'package/SECURITY.md',
  'package/THIRD_PARTY_NOTICES.md',
];

async function walk(root, directory = root) {
  const entries = [];
  for (const name of await readdir(directory)) {
    const absolute = path.join(directory, name);
    const state = await lstat(absolute);
    entries.push({ absolute, relative: path.relative(root, absolute), state });
    if (state.isDirectory()) entries.push(...await walk(root, absolute));
  }
  return entries;
}

test('npm package contains only portable deployable Fast Browser assets', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-package-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));

  const { stdout } = await execFileAsync(
    'npm',
    ['pack', '--json', '--pack-destination', temporary],
    {
      cwd: pluginRoot,
      env: {
        ...process.env,
        npm_config_cache: path.join(temporary, 'npm-cache'),
      },
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  const [packed] = JSON.parse(stdout);
  assert.equal(typeof packed?.filename, 'string', 'npm pack did not report a tarball');

  const tarball = path.join(temporary, packed.filename);
  const { stdout: listing } = await execFileAsync('tar', ['-tzf', tarball], {
    maxBuffer: 10 * 1024 * 1024,
  });
  const entries = listing.split('\n').filter(Boolean);
  const entrySet = new Set(entries.map((entry) => entry.replace(/\/$/, '')));

  for (const required of requiredEntries) {
    assert.equal(entrySet.has(required), true, `package is missing ${required}`);
  }
  assert.equal(
    entries.filter((entry) => /\/skills\/[^/]+\/SKILL\.md$/.test(entry)).length,
    3,
    'package must contain exactly three real skills',
  );

  for (const entry of entries) {
    assert.equal(path.posix.isAbsolute(entry), false, `absolute tar entry: ${entry}`);
    assert.equal(
      entry === 'package' || entry.startsWith('package/'),
      true,
      `tar entry escaped the package root: ${entry}`,
    );
    assert.equal(
      path.posix.normalize(entry).startsWith('package/../'),
      false,
      `tar entry traverses outside the package root: ${entry}`,
    );
    assert.doesNotMatch(
      entry,
      /(?:^|\/)(?:tests?|fixtures?|\.superpowers|\.local-dev)(?:\/|$)/,
      `development-only package entry: ${entry}`,
    );
    assert.doesNotMatch(entry, /\/Users\/|\.playwright-mcp/, `non-portable package entry: ${entry}`);
  }

  await execFileAsync('tar', ['-xzf', tarball, '-C', temporary], {
    maxBuffer: 10 * 1024 * 1024,
  });
  const extractedRoot = path.join(temporary, 'package');
  const canonicalRoot = await realpath(extractedRoot);
  const extracted = await walk(extractedRoot);
  const textParts = [];

  for (const entry of extracted) {
    if (entry.state.isSymbolicLink()) {
      const target = await readlink(entry.absolute);
      const resolved = path.resolve(path.dirname(entry.absolute), target);
      const canonicalTarget = await realpath(entry.absolute);
      const relativeTarget = path.relative(canonicalRoot, canonicalTarget);
      assert.equal(
        relativeTarget === '..'
          || relativeTarget.startsWith(`..${path.sep}`)
          || path.isAbsolute(relativeTarget),
        false,
        `package symlink escapes its root: ${entry.relative} -> ${target}`,
      );
      assert.equal(
        resolved === canonicalRoot || resolved.startsWith(`${canonicalRoot}${path.sep}`),
        true,
        `package symlink has an outside lexical target: ${entry.relative} -> ${target}`,
      );
      continue;
    }
    if (!entry.state.isFile()) continue;
    const contents = await readFile(entry.absolute);
    if (!contents.includes(0)) {
      textParts.push(`\n--- ${entry.relative} ---\n${contents.toString('utf8')}`);
    }
  }

  const deployableText = textParts.join('');
  for (const prohibited of [
    '/Users/matt',
    'PLAYWRIGHT_MCP_EXTENSION_TOKEN=',
    'order-wizard',
    'pw-bench',
  ]) {
    assert.equal(
      deployableText.includes(prohibited),
      false,
      `package text contains prohibited value: ${prohibited}`,
    );
  }
  assert.doesNotMatch(deployableText, /\/Users\/[^\s"'`]+/, 'package text contains a personal path');
  assert.doesNotMatch(
    deployableText,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:ghp|github_pat|sk)-[A-Za-z0-9_-]{12,}/,
    'package text contains a secret-like value',
  );
  assert.doesNotMatch(
    deployableText,
    /\b[A-Z][A-Z0-9_]*(?:_TOKEN|_SECRET|_PASSWORD|_API_KEY)\s*=\s*[^\s"'`]+/,
    'package text contains a token or secret assignment',
  );
});
