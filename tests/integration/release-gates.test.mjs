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

// One `npm pack` for the whole file. Every gate here asks the same question of
// the same immutable working tree, and each spawn is a full npm process
// competing with the host-install integration tests node --test runs in
// parallel; those shell out to real host CLIs under a timeout, and enough
// concurrent npm processes make them time out. Adding a gate should not cost
// another subprocess.
let packedFilesPromise = null;

async function packedFiles() {
  packedFilesPromise ??= execFile(
    'npm',
    ['pack', '--dry-run', '--json'],
    { cwd: pluginRoot, maxBuffer: 32 * 1024 * 1024 },
  ).then(({ stdout }) => JSON.parse(stdout)[0].files.map(({ path: entry }) => entry));
  return packedFilesPromise;
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

// Attribution was inconsistent before publication: both plugin manifests and
// the marketplace named a different person than the git identity that
// authored the commits, and the LICENSE copyright line is a legal claim that
// has to name the actual holder. Cross-check them rather than trusting any
// one file, since these drifted apart silently.
test('attribution is consistent across manifests, marketplace, and LICENSE', async () => {
  const [claude, codex, marketplace, license] = await Promise.all([
    json('.claude-plugin/plugin.json'),
    json('.codex-plugin/plugin.json'),
    json('.claude-plugin/marketplace.json', repoRoot),
    readFile(path.join(pluginRoot, 'LICENSE'), 'utf8'),
  ]);
  const holder = license.match(/Copyright \(c\) \d{4} (.+)/)?.[1]?.trim();

  assert.ok(holder, 'LICENSE names a copyright holder');
  assert.equal(claude.author.name, holder);
  assert.equal(codex.author.name, holder);
  assert.equal(codex.interface.developerName, holder);
  assert.equal(marketplace.owner.name, holder);
});

test('the annotation skill ships for both hosts', async () => {
  const files = await packedFiles();

  assert.ok(files.includes('skills/annotating-screenshots/SKILL.md'));
  assert.ok(files.includes('skills/annotating-screenshots/agents/openai.yaml'));
  assert.ok(files.includes('builtins/macros/capture-annotated.js'));
});

// The installer refreshes a built-in only when the installed bytes match a
// hash this project is recorded as having shipped. A release that changes a
// macro without recording the outgoing hash therefore does not just miss an
// entry: every existing install now holds bytes the manifest has never heard
// of, so the next setup classifies all of them as user-edited and refuses to
// refresh them forever. Recording the packaged bytes has to be a release gate
// for that reason, not a chore.
test('the shipped macro hash manifest covers every built-in and its packaged bytes', async () => {
  const {
    BUILTIN_NAMES,
    INDEX_NAME,
    MACRO_HASHES_NAME,
    digestText,
    indexSectionBody,
    macroIndexName,
  } = await import('../../lib/macros/install.mjs');
  const [manifest, template] = await Promise.all([
    json(path.join('builtins', MACRO_HASHES_NAME)),
    readFile(path.join(pluginRoot, 'skills', 'browser-macros', INDEX_NAME), 'utf8'),
  ]);

  assert.deepEqual(Object.keys(manifest.macros).sort(), [...BUILTIN_NAMES].sort());
  assert.deepEqual(
    Object.keys(manifest.indexSections).sort(),
    BUILTIN_NAMES.map(macroIndexName).sort(),
  );

  for (const name of BUILTIN_NAMES) {
    const sectionName = macroIndexName(name);
    const packaged = await readFile(path.join(pluginRoot, 'builtins', 'macros', name), 'utf8');
    const section = indexSectionBody(template, sectionName);
    assert.ok(section, `the packaged index documents ${sectionName}`);

    for (const [label, hashes] of [
      [name, manifest.macros[name]],
      [sectionName, manifest.indexSections[sectionName]],
    ]) {
      assert.ok(Array.isArray(hashes) && hashes.length > 0, `${label} has recorded hashes`);
      for (const hash of hashes) {
        assert.match(hash, /^[0-9a-f]{64}$/, `${label} records a sha256`);
        // A generator that reads published tarballs and hashes whatever it got
        // back for an absent file records this, which is a claim that a
        // release shipped an empty macro. None ever did.
        assert.notEqual(hash, digestText(''), `${label} must not record the empty-file digest`);
      }
    }
    assert.ok(
      manifest.macros[name].includes(digestText(packaged)),
      `${name} packaged bytes are recorded; regenerate with scripts/generate-macro-hashes.mjs`,
    );
    assert.ok(
      manifest.indexSections[sectionName].includes(digestText(section)),
      `${sectionName} packaged index section is recorded;`
        + ' regenerate with scripts/generate-macro-hashes.mjs',
    );
  }
});

// Losing a hash the manifest already recorded is the one way to break refresh
// that leaves no symptom: every install still holding those bytes is then
// classified as the user's and preserved forever, and "preserved" is a
// legitimate outcome, so no test fails and nothing looks wrong. The gate above
// only covers the CURRENT packaged bytes, so a historical entry can be deleted
// by hand and every check still passes.
//
// The invariant is not plain append-only. `scripts/generate-macro-hashes.mjs`
// rebuilds from published tarballs plus the working tree, so a hash recorded
// for an unreleased working-tree state legitimately disappears when that state
// is superseded before it ever ships. page-affordances.js did exactly that
// between 073b3ce and 51cd598. What must never disappear is a hash that was
// not merely the working tree of its own commit, because the only other way
// one gets into the manifest is a published tarball.
async function gitLines(args) {
  const { stdout } = await execFile('git', ['-C', pluginRoot, ...args], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

async function gitShowOrNull(revision, repoPath) {
  try {
    return await gitLines(['show', `${revision}:${repoPath}`]);
  } catch {
    return null;
  }
}

test('the macro hash manifest never drops a hash it did not mint itself', async (t) => {
  const {
    BUILTIN_NAMES,
    INDEX_NAME,
    MACRO_HASHES_NAME,
    digestText,
    indexSectionBody,
    macroIndexName,
  } = await import('../../lib/macros/install.mjs');

  let prefix;
  try {
    prefix = (await gitLines(['rev-parse', '--show-prefix'])).trim();
  } catch {
    t.skip('not a git work tree, so there is no manifest history to read');
    return;
  }
  const manifestPath = `${prefix}builtins/${MACRO_HASHES_NAME}`;
  const indexPath = `${prefix}skills/browser-macros/${INDEX_NAME}`;
  const macroPath = (name) => `${prefix}builtins/macros/${name}`;

  const current = await json(path.join('builtins', MACRO_HASHES_NAME));
  // Pathspecs are resolved against the working directory, which `-C` has set to
  // the plugin root; only the `git show` paths above need the repo-root prefix.
  const revisions = (await gitLines([
    'log', '--format=%H', '--', `builtins/${MACRO_HASHES_NAME}`,
  ]))
    .split('\n')
    .filter(Boolean);
  assert.ok(revisions.length > 0, 'the manifest has a history to check against');

  for (const revision of revisions) {
    const raw = await gitShowOrNull(revision, manifestPath);
    if (raw === null) continue;
    const past = JSON.parse(raw);
    const index = await gitShowOrNull(revision, indexPath);

    for (const name of BUILTIN_NAMES) {
      const sectionName = macroIndexName(name);
      const macroText = await gitShowOrNull(revision, macroPath(name));
      const section = index === null ? null : indexSectionBody(index, sectionName);
      for (const [recorded, live, minted, label] of [
        [
          past.macros?.[name],
          current.macros?.[name],
          macroText === null ? null : digestText(macroText),
          name,
        ],
        [
          past.indexSections?.[sectionName],
          current.indexSections?.[sectionName],
          section === null ? null : digestText(section),
          sectionName,
        ],
      ]) {
        // A built-in the project has since dropped from BUILTIN_NAMES has no
        // current entry to keep anything in, and that removal is deliberate.
        if (!Array.isArray(recorded) || !Array.isArray(live)) continue;
        for (const hash of recorded) {
          if (live.includes(hash)) continue;
          assert.equal(
            hash,
            minted,
            `${revision.slice(0, 7)} recorded a hash for ${label} that is gone from`
              + ` builtins/${MACRO_HASHES_NAME} and was not that commit's own working-tree`
              + ' bytes, so it can only have come from a published tarball;'
              + ' restore it or every install holding those bytes is stranded',
          );
        }
      }
    }
  }
});

// The generator's `--check` mode existed and ran nowhere, which is the same
// class of nothing as a manifest nobody verifies. It needs the network to fetch
// published tarballs so it cannot live in `npm test`; publish is the moment it
// is both affordable and load-bearing, because that is when a release that
// forgot to record the outgoing bytes would otherwise ship.
test('the macro hash check runs before publish', async () => {
  const packageJson = await json('package.json');

  assert.match(
    packageJson.scripts?.prepublishOnly ?? '',
    /generate-macro-hashes\.mjs --check/,
    'publishing must verify the manifest against the published tarballs first',
  );
});

test('the shipped macro hash manifest is published', async () => {
  const { MACRO_HASHES_NAME } = await import('../../lib/macros/install.mjs');
  const files = await packedFiles();

  assert.ok(
    files.includes(`builtins/${MACRO_HASHES_NAME}`),
    'the installer cannot classify installed bytes without the manifest',
  );
});

test('the vendored Radix palette carries its licence notice', async () => {
  const notices = await readFile(path.join(pluginRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8');

  assert.match(notices, /Radix Colors/);
  assert.match(notices, /MIT License/);
});
