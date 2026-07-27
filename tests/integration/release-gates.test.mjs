import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const pluginRoot = fileURLToPath(new URL('../../', import.meta.url));
const repoRoot = path.resolve(pluginRoot, '../..');

async function json(relative, root = pluginRoot) {
  return JSON.parse(await readFile(path.join(root, relative), 'utf8'));
}

test('the package is publishable and MIT licensed', async () => {
  const packageJson = await json('package.json');

  assert.equal(packageJson.license, 'MIT');
  assert.equal(packageJson.private, false);
});

test('both plugin manifests carry the same SPDX license and version as the package', async () => {
  const [packageJson, claude, codex] = await Promise.all([
    json('package.json'),
    json('.claude-plugin/plugin.json'),
    json('.codex-plugin/plugin.json'),
  ]);

  assert.equal(claude.license, packageJson.license);
  assert.equal(codex.license, packageJson.license);
  assert.equal(claude.version, packageJson.version);
  assert.equal(codex.version, packageJson.version);
});

test('the marketplace entry matches the plugin version', async () => {
  const [packageJson, marketplace] = await Promise.all([
    json('package.json'),
    json('.claude-plugin/marketplace.json', repoRoot),
  ]);
  const entry = marketplace.plugins.find(({ name }) => name === 'fast-browser');

  assert.ok(entry, 'fast-browser is listed in the marketplace');
  assert.equal(entry.version, packageJson.version);
});

test('the declared license file exists and states that license', async () => {
  const [packageJson, license] = await Promise.all([
    json('package.json'),
    readFile(path.join(pluginRoot, 'LICENSE'), 'utf8'),
  ]);

  assert.match(license, new RegExp(`^${packageJson.license} License`));
  assert.match(license, /Copyright \(c\) \d{4}/);
  assert.match(license, /WITHOUT WARRANTY OF ANY KIND/);
});

// The plugin is MIT but ships artifacts built from Apache-2.0 Playwright, so
// the notice has to survive publication and stay attached to the exact commit
// and checksums the installer will actually fetch.
test('Playwright notices exist and agree with the runtime lock', async () => {
  const [notices, lock] = await Promise.all([
    readFile(path.join(pluginRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8'),
    json('runtime-lock.json'),
  ]);

  assert.match(notices, /Apache License 2\.0/);
  assert.match(notices, /microsoft\/playwright/);
  // Derived, never hand-copied: the notice went stale at alpha.5 while the
  // lock moved to alpha.7, which is a provenance claim that no longer matched
  // the bytes being installed.
  for (const value of [
    lock.sourceCommit,
    lock.runtime.file,
    lock.runtime.sha256,
    lock.extension.file,
    lock.extension.sha256,
    lock.extension.id,
  ]) {
    assert.ok(notices.includes(value), `notices must record ${value}`);
  }
});

test('runtime lock artifact URLs are immutable and checksummed', async () => {
  const lock = await json('runtime-lock.json');

  for (const artifact of [lock.runtime, lock.extension]) {
    const url = new URL(artifact.url);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.hostname, 'github.com');
    assert.match(url.pathname, /\/releases\/download\/[^/]+\//);
    // A "latest" coordinate is mutable and would let the installed bytes
    // change without the lock changing.
    assert.doesNotMatch(url.pathname, /\/releases\/download\/latest\//);
    assert.equal(path.posix.basename(url.pathname), artifact.file);
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
  }
});

async function packedFiles() {
  const { stdout } = await execFile(
    'npm',
    ['pack', '--dry-run', '--json'],
    { cwd: pluginRoot, maxBuffer: 32 * 1024 * 1024 },
  );
  return JSON.parse(stdout)[0].files.map(({ path: entry }) => entry);
}

test('npm pack ships no tests, sessions, macros, or local state', async () => {
  const files = await packedFiles();

  for (const entry of files) {
    assert.doesNotMatch(entry, /(^|\/)tests?\//, `packed test file: ${entry}`);
    assert.doesNotMatch(entry, /\.test\.mjs$/, `packed test file: ${entry}`);
    assert.doesNotMatch(entry, /(^|\/)session-/, `packed session: ${entry}`);
    // Macro DATA, not the code that installs it: lib/macros/*.mjs is source,
    // and builtins/macros/ is the shipped library. Anything else that looks
    // like a macro file would be imported personal work.
    const macroData = /(^|\/)macros\/.+\.(js|md)$/.test(entry);
    if (macroData && !entry.startsWith('builtins/')) {
      assert.fail(`packed personal macro: ${entry}`);
    }
    assert.doesNotMatch(entry, /(^|\/)\.local-dev\//, `packed local state: ${entry}`);
    assert.doesNotMatch(entry, /(^|\/)node_modules\//, `packed dependency: ${entry}`);
  }
  assert.ok(files.includes('LICENSE'), 'LICENSE is published');
  assert.ok(files.includes('THIRD_PARTY_NOTICES.md'), 'notices are published');
});

// A maintainer's absolute home path in a published file both leaks the
// machine layout and bakes in a path that cannot exist for any installer.
test('no published file contains a maintainer absolute path or a token', async () => {
  const files = await packedFiles();
  const offenders = [];

  for (const entry of files) {
    let contents;
    try {
      contents = await readFile(path.join(pluginRoot, entry), 'utf8');
    } catch {
      continue;
    }
    if (/\/Users\/[a-z]/i.test(contents)) offenders.push(`${entry}: absolute home path`);
    if (/(PLAYWRIGHT_MCP_EXTENSION_TOKEN|auth-token)\s*[:=]\s*["'][A-Za-z0-9_-]{16,}/.test(contents)) {
      offenders.push(`${entry}: literal token`);
    }
  }

  assert.deepEqual(offenders, []);
});

test('the published tree exposes both host plugin manifests', async () => {
  const files = await packedFiles();

  assert.ok(files.includes('.claude-plugin/plugin.json'));
  assert.ok(files.includes('.codex-plugin/plugin.json'));
  await Promise.all([
    access(path.join(pluginRoot, '.claude-plugin/plugin.json')),
    access(path.join(pluginRoot, '.codex-plugin/plugin.json')),
  ]);
});
