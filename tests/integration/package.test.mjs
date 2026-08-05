import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';

const execFileAsync = promisify(execFile);
const pluginRoot = fileURLToPath(new URL('../..', import.meta.url));

const requiredEntries = [
  'package/.claude-plugin/plugin.json',
  'package/.codex-plugin/plugin.json',
  'package/.mcp.json',
  'package/adapters/codex/mcp.json',
  'package/agents/browser-driver.md',
  'package/builtins/macros/page-recon.js',
  'package/builtins/macros/page-affordances.js',
  'package/lib/cli/main.mjs',
  'package/lib/cli/parse-args.mjs',
  'package/lib/commands/configure.mjs',
  'package/lib/commands/doctor.mjs',
  'package/lib/commands/flows.mjs',
  'package/lib/commands/migrate.mjs',
  'package/lib/commands/setup.mjs',
  'package/lib/commands/uninstall.mjs',
  'package/lib/doctor/checks.mjs',
  'package/lib/flows/artifact.mjs',
  'package/lib/flows/compile.mjs',
  'package/lib/flows/match.mjs',
  'package/lib/flows/sweep.mjs',
  'package/lib/flows/trace-reader.mjs',
  'package/lib/migration/apply.mjs',
  'package/lib/migration/inventory.mjs',
  'package/lib/migration/rollback.mjs',
  'package/lib/runtime/install.mjs',
  'package/lib/runtime/launch.mjs',
  'package/lib/runtime/lock.mjs',
  'package/skills/annotating-screenshots/agents/openai.yaml',
  'package/skills/browser-macros/agents/openai.yaml',
  'package/skills/fast-browsing/agents/openai.yaml',
  'package/skills/mine-macros/agents/openai.yaml',
  'package/templates/codex/browser_driver.toml',
  'package/templates/routing/claude/fast-browser-routing.md',
  'package/templates/routing/claude/fast-browser-verification-consent.md',
  'package/templates/routing/codex/fast-browser.md',
  'package/skills/annotating-screenshots/SKILL.md',
  'package/skills/browser-macros/SKILL.md',
  'package/skills/fast-browsing/SKILL.md',
  'package/skills/mine-macros/SKILL.md',
  'package/runtime-lock.json',
  'package/README.md',
  'package/SECURITY.md',
  'package/THIRD_PARTY_NOTICES.md',
];

function tarString(block, offset, length) {
  const bytes = block.subarray(offset, offset + length);
  const nul = bytes.indexOf(0);
  return bytes.subarray(0, nul < 0 ? bytes.length : nul).toString('utf8');
}

function tarSize(block) {
  const raw = tarString(block, 124, 12).trim();
  assert.match(raw, /^[0-7]+$/, 'tar entry has a non-octal size');
  return Number.parseInt(raw, 8);
}

function tarHeaders(compressed) {
  const archive = gunzipSync(compressed);
  const headers = [];
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const block = archive.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    const name = tarString(block, 0, 100);
    const prefix = tarString(block, 345, 155);
    const type = tarString(block, 156, 1) || '0';
    const linkTarget = tarString(block, 157, 100);
    const size = tarSize(block);
    headers.push({
      name: prefix ? `${prefix}/${name}` : name,
      type,
      linkTarget,
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(headers.length > 0, 'tarball has no headers');
  return headers;
}

function assertPortableArchivePath(value, label) {
  assert.notEqual(value, '', `empty ${label}`);
  assert.equal(path.posix.isAbsolute(value), false, `absolute ${label}: ${value}`);
  assert.doesNotMatch(value, /\\/, `backslash in ${label}: ${value}`);
  assert.doesNotMatch(value, /^[A-Za-z]:/, `drive-qualified ${label}: ${value}`);
  assert.equal(
    value.split('/').includes('..'),
    false,
    `parent segment in ${label}: ${value}`,
  );
}

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
  const headers = tarHeaders(await readFile(tarball));

  for (const required of requiredEntries) {
    assert.equal(entrySet.has(required), true, `package is missing ${required}`);
  }
  assert.equal(
    entries.filter((entry) => /\/skills\/[^/]+\/SKILL\.md$/.test(entry)).length,
    5,
    'package must contain exactly five real skills',
  );

  for (const entry of entries) {
    assertPortableArchivePath(entry, 'tar entry');
    assert.equal(
      entry === 'package' || entry.startsWith('package/'),
      true,
      `tar entry escaped the package root: ${entry}`,
    );
    assert.doesNotMatch(
      entry,
      /(?:^|\/)(?:tests?|fixtures?|\.superpowers|\.local-dev)(?:\/|$)/,
      `development-only package entry: ${entry}`,
    );
    assert.doesNotMatch(entry, /\/Users\/|\.playwright-mcp/, `non-portable package entry: ${entry}`);
  }

  for (const header of headers) {
    assertPortableArchivePath(header.name, 'tar header name');
    if (header.linkTarget) {
      assertPortableArchivePath(header.linkTarget, 'tar link target');
    }
    assert.equal(
      header.type === '0' || header.type === '5',
      true,
      `package contains a link or special tar header: ${header.type} ${header.name}`,
    );
    assert.equal(header.linkTarget, '', `package tar header links elsewhere: ${header.name}`);
  }

  await execFileAsync('tar', ['-xzf', tarball, '-C', temporary], {
    maxBuffer: 10 * 1024 * 1024,
  });
  const extractedRoot = path.join(temporary, 'package');
  const extracted = await walk(extractedRoot);
  const textParts = [];
  const textByPath = new Map();

  for (const entry of extracted) {
    assert.equal(
      entry.state.isFile() || entry.state.isDirectory(),
      true,
      `extracted package contains a link or special file: ${entry.relative}`,
    );
    if (entry.state.isDirectory()) continue;
    const contents = await readFile(entry.absolute);
    if (!contents.includes(0)) {
      const text = contents.toString('utf8');
      textByPath.set(entry.relative, text);
      textParts.push(`\n--- ${entry.relative} ---\n${text}`);
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

  const readme = textByPath.get('README.md');
  const normalizedReadme = readme.replace(/\s+/g, ' ');
  // Version-specific filenames stay placeholders: these assertions used to
  // name alpha.5 literally and kept vouching for a bundle the lock had moved
  // past several releases earlier.
  assert.match(normalizedReadme, /fast-browser-release-<version>\.json/);
  assert.match(normalizedReadme, /fast-browser-mcp-<version>\.tar\.gz/);
  assert.match(normalizedReadme, /fast-browser-extension-<version>\.zip/);
  assert.doesNotMatch(normalizedReadme, /not an installable candidate/i);
  // The package IS published, so the README must lead with the real install
  // command rather than describing npx as unavailable.
  assert.match(normalizedReadme, /npx @mattstack\/fast-browser setup --host both/);
  assert.doesNotMatch(normalizedReadme, /npx is not available/i);
  assert.match(
    readme,
    /setup[\s\S]*--runtime-lock \/absolute\/path\/to\/fast-browser-release-<version>\.json[\s\S]*--host both[\s\S]*--profile safe/,
  );
  // npm renders README images only from absolute URLs, so a relative logo path
  // silently shows as broken on the package page.
  const logo = normalizedReadme.match(/<img src="([^"]*logo[^"]*)"/)?.[1];
  assert.ok(logo, 'the README shows the logo');
  assert.match(logo, /^https:\/\/raw\.githubusercontent\.com\//, 'logo URL must be absolute');

  // Derived from the lock, never pinned literally. These assertions used to
  // name alpha.5 and its source commit, so after the lock moved to alpha.7
  // they were enforcing a provenance claim that no longer described the bytes
  // the installer fetches -- the test was holding the staleness in place
  // rather than catching it.
  const lock = JSON.parse(
    await readFile(new URL('../../runtime-lock.json', import.meta.url), 'utf8'),
  );
  const notices = textByPath.get('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /Apache License 2\.0/);
  for (const value of [lock.sourceCommit, lock.runtime.file, lock.extension.file]) {
    assert.ok(notices.includes(value), `notices must record ${value}`);
  }
});
