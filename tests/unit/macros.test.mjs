import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import crypto from 'node:crypto';
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
import vm from 'node:vm';

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
    macroIndexFile: path.join(dataDir, 'macros', 'MACROS.md'),
    pluginRoot,
  };
}

async function macroFixture(t, prefix = 'fast-browser-macros-') {
  return { paths: await temporaryPaths(t, prefix) };
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// The real manifest currently records exactly the bytes this working tree
// packages, so the refresh branch is unreachable through the real plugin root
// and a test written against it would assert nothing. These fixtures build a
// throwaway plugin root whose packaged bytes, index template, and hash
// manifest are chosen per branch, so each of the three outcomes is exercised
// on its own terms rather than on whatever the current release happens to
// contain.
function syntheticSection(name, body) {
  return `## ${name}\n\n- Params: \`{ ${body} }\`\n- Status: built-in`;
}

async function syntheticPluginRoot(t, { macros, sections, macroHashes = {}, sectionHashes = {} }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-synthetic-plugin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'builtins', 'macros'), { recursive: true });
  await mkdir(path.join(root, 'skills', 'browser-macros'), { recursive: true });
  for (const [name, text] of Object.entries(macros)) {
    await writeFile(path.join(root, 'builtins', 'macros', name), text, 'utf8');
  }
  const index = ['# Macro Index', '', sections['page-recon'], '', sections['capture-annotated'], '']
    .join('\n');
  await writeFile(path.join(root, 'skills', 'browser-macros', 'MACROS.md'), index, 'utf8');
  await writeFile(
    path.join(root, 'builtins', 'macro-hashes.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      macros: {
        'page-recon.js': macroHashes['page-recon.js'] ?? [sha256(macros['page-recon.js'])],
        'capture-annotated.js': macroHashes['capture-annotated.js']
          ?? [sha256(macros['capture-annotated.js'])],
      },
      indexSections: {
        'page-recon': sectionHashes['page-recon'] ?? [sha256(sections['page-recon'])],
        'capture-annotated': sectionHashes['capture-annotated']
          ?? [sha256(sections['capture-annotated'])],
      },
    }, null, 2)}\n`,
    'utf8',
  );
  return { root };
}

const SHIPPED_RECON = '// shipped recon\n';
const CURRENT_RECON = '// current recon\n';
const CURRENT_CAPTURE = '// current capture\n';
const SHIPPED_RECON_SECTION = syntheticSection('page-recon', 'maxLinks?: number');
const CURRENT_RECON_SECTION = syntheticSection('page-recon', 'maxLinks?: number, home: string');
const CURRENT_CAPTURE_SECTION = syntheticSection('capture-annotated', 'targets: object');

// A plugin root whose packaged macro and index section have both moved on from
// a previous release, with that previous release's bytes recorded as shipped.
async function movedOnPluginRoot(t) {
  return syntheticPluginRoot(t, {
    macros: { 'page-recon.js': CURRENT_RECON, 'capture-annotated.js': CURRENT_CAPTURE },
    sections: { 'page-recon': CURRENT_RECON_SECTION, 'capture-annotated': CURRENT_CAPTURE_SECTION },
    macroHashes: { 'page-recon.js': [sha256(SHIPPED_RECON), sha256(CURRENT_RECON)] },
    sectionHashes: {
      'page-recon': [sha256(SHIPPED_RECON_SECTION), sha256(CURRENT_RECON_SECTION)],
    },
  });
}

function fakeCapturePage({
  locators = {},
  viewport = { inner: [1280, 800], client: [1280, 800] },
  onScreenshot,
  onEvaluateError,
} = {}) {
  const screenshots = [];
  return {
    screenshots,
    async screenshot(options) {
      if (onScreenshot) await onScreenshot(options);
      screenshots.push(options);
    },
    async evaluate() {
      if (onEvaluateError) throw onEvaluateError;
      return viewport;
    },
    locator(selector) {
      const entry = locators[selector];
      return {
        async count() {
          return entry ? (entry.count ?? 1) : 0;
        },
        async boundingBox() {
          return entry && entry.box !== undefined ? entry.box : null;
        },
      };
    },
    url() {
      return 'https://example.test/';
    },
  };
}

async function loadCaptureAnnotatedMacro() {
  const source = await readFile(
    path.join(pluginRoot, 'builtins/macros/capture-annotated.js'),
    'utf8',
  );
  return Function(`"use strict"; return (${source});`)();
}

// `Function(...)` (used by loadCaptureAnnotatedMacro above, and by every
// other test that only checks the macro's own logic) still runs inside this
// Node process, so a stray `process` reference inside the macro would
// resolve to this test's own `process` global and silently pass -- that is
// exactly how the ReferenceError shipped undetected the first time. The real
// `browser_run_code_unsafe` sandbox has no Node globals whatsoever (checked
// live: `process`, `require`, `module`, and `Buffer` are all undefined; the
// only sandbox-provided names are `page`, the harness's own `args`/`__fn__`/
// `__args__`/`__end__`, and the standard ECMAScript intrinsics). vm.createContext
// with an empty sandbox object reproduces that: it is a fresh realm with
// Object/Array/Math/JSON/Promise/RegExp/etc. but none of Node's
// host-specific globals, since those are only ever added to a vm context
// explicitly. A function defined inside that context keeps that context as
// its lexical global scope even when later invoked from this process, so
// calling the loaded macro here still throws ReferenceError for any bare
// `process`/`require`/`module`/`Buffer` reference exactly as the live tool
// would.
async function loadCaptureAnnotatedMacroWithoutNodeGlobals() {
  const source = await readFile(
    path.join(pluginRoot, 'builtins/macros/capture-annotated.js'),
    'utf8',
  );
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(`(${source})`);
  return script.runInContext(sandbox);
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

test('installBuiltinMacros preserves a user-authored page-recon index entry byte-for-byte and still adds the missing capture-annotated section', async (t) => {
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

  const merged = await readFile(liveIndex, 'utf8');
  // With two built-ins, an index that already has a (user-edited) page-recon
  // section is no longer left untouched: it still gains the section it is
  // missing (capture-annotated). The user's page-recon bytes must still
  // survive unchanged as a prefix of the merged file.
  assert.ok(
    merged.startsWith(customIndex),
    'the user-authored page-recon section is preserved byte-for-byte',
  );
  assert.equal((merged.match(/^## page-recon$/gm) || []).length, 1);
  assert.equal((merged.match(/^## capture-annotated$/gm) || []).length, 1);
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

test('both builtin macros install and appear in the index', async (t) => {
  const { installBuiltinMacros } = await import('../../lib/macros/install.mjs');
  const { paths } = await macroFixture(t, 'fast-browser-macros-both-');
  await installBuiltinMacros(paths);
  for (const name of ['page-recon.js', 'capture-annotated.js']) {
    const state = await lstat(path.join(paths.macrosDir, name));
    assert.equal(state.isFile(), true, name);
  }
  const index = await readFile(paths.macroIndexFile, 'utf8');
  assert.match(index, /^## page-recon$/m);
  assert.match(index, /^## capture-annotated$/m);
});

test('installing twice does not duplicate index sections or overwrite edits', async (t) => {
  const { installBuiltinMacros } = await import('../../lib/macros/install.mjs');
  const { paths } = await macroFixture(t, 'fast-browser-macros-twice-');
  await installBuiltinMacros(paths);
  await writeFile(path.join(paths.macrosDir, 'capture-annotated.js'), '// user edit\n');
  await installBuiltinMacros(paths);
  const index = await readFile(paths.macroIndexFile, 'utf8');
  assert.equal(index.match(/^## capture-annotated$/gm).length, 1);
  assert.equal(
    await readFile(path.join(paths.macrosDir, 'capture-annotated.js'), 'utf8'),
    '// user edit\n',
    'a user-edited macro is never overwritten',
  );
});

test('a macro index missing only one section gains just that section', async (t) => {
  const { installBuiltinMacros } = await import('../../lib/macros/install.mjs');
  const { paths } = await macroFixture(t, 'fast-browser-macros-partial-index-');
  await mkdir(paths.macrosDir, { recursive: true, mode: 0o700 });
  await writeFile(paths.macroIndexFile, '# Macro Index\n\n## page-recon\n\n- Status: built-in\n');
  await installBuiltinMacros(paths);
  const index = await readFile(paths.macroIndexFile, 'utf8');
  assert.equal(index.match(/^## page-recon$/gm).length, 1);
  assert.equal(index.match(/^## capture-annotated$/gm).length, 1);
});

// A shipped bug in a built-in used to be permanent: the installer copied
// without overwriting, so the first install won forever and rerunning setup
// repaired nothing. capture-annotated gaining a required `home` argument is
// the case that proved it, since existing machines kept both the old macro and
// an index entry documenting the old signature. Refresh is therefore gated on
// provenance, not on age: bytes the project itself shipped may be replaced,
// anything else is the user's.
test('a built-in macro still holding an earlier release\'s shipped bytes is refreshed', async (t) => {
  const { installBuiltinMacros } = await import('../../lib/macros/install.mjs');
  const paths = await temporaryPaths(t, 'fast-browser-macros-refresh-');
  const { root } = await movedOnPluginRoot(t);
  await mkdir(paths.macrosDir, { recursive: true, mode: 0o700 });
  const installed = path.join(paths.macrosDir, 'page-recon.js');
  await writeFile(installed, SHIPPED_RECON, 'utf8');

  const report = await installBuiltinMacros({ ...paths, pluginRoot: root });

  assert.equal(await readFile(installed, 'utf8'), CURRENT_RECON);
  assert.deepEqual(
    report.macros.find((entry) => entry.name === 'page-recon.js'),
    { name: 'page-recon.js', action: 'refreshed' },
  );
  assert.deepEqual(report.preserved, []);
});

test('a built-in macro that already matches the packaged bytes is left byte-identical and unwritten', async (t) => {
  const { installBuiltinMacros } = await import('../../lib/macros/install.mjs');
  const paths = await temporaryPaths(t, 'fast-browser-macros-current-');
  const { root } = await movedOnPluginRoot(t);
  const request = { ...paths, pluginRoot: root };
  await installBuiltinMacros(request);
  const installed = path.join(paths.macrosDir, 'page-recon.js');
  const beforeMacro = await lstat(installed);
  const beforeIndex = await lstat(paths.macroIndexFile);

  const report = await installBuiltinMacros(request);

  const afterMacro = await lstat(installed);
  const afterIndex = await lstat(paths.macroIndexFile);
  // Both write paths land a fresh inode over the destination, so an unchanged
  // inode is direct evidence that nothing was rewritten, which mtime
  // granularity alone would not give.
  assert.equal(afterMacro.ino, beforeMacro.ino, 'an up-to-date macro is not rewritten');
  assert.equal(afterMacro.mtimeMs, beforeMacro.mtimeMs);
  assert.equal(afterIndex.ino, beforeIndex.ino, 'an up-to-date index is not rewritten');
  assert.equal(afterIndex.mtimeMs, beforeIndex.mtimeMs);
  assert.equal(await readFile(installed, 'utf8'), CURRENT_RECON);
  assert.equal(
    report.macros.find((entry) => entry.name === 'page-recon.js').action,
    'current',
  );
  assert.equal(
    report.index.find((entry) => entry.name === 'page-recon').action,
    'current',
  );
});

test('a built-in macro matching neither the packaged nor any shipped bytes is preserved and reported', async (t) => {
  const { installBuiltinMacros } = await import('../../lib/macros/install.mjs');
  const paths = await temporaryPaths(t, 'fast-browser-macros-preserve-');
  const { root } = await movedOnPluginRoot(t);
  await mkdir(paths.macrosDir, { recursive: true, mode: 0o700 });
  const installed = path.join(paths.macrosDir, 'page-recon.js');
  await writeFile(installed, '// mine\n', 'utf8');

  const report = await installBuiltinMacros({ ...paths, pluginRoot: root });

  assert.equal(await readFile(installed, 'utf8'), '// mine\n');
  assert.equal(
    report.macros.find((entry) => entry.name === 'page-recon.js').action,
    'preserved',
  );
  // Silently keeping a stale macro is what made the original bug invisible, so
  // the caller has to be able to say so.
  assert.deepEqual(report.preserved, ['page-recon.js']);
});

test('a live index section still holding an earlier release\'s shipped text is refreshed', async (t) => {
  const { installBuiltinMacros } = await import('../../lib/macros/install.mjs');
  const paths = await temporaryPaths(t, 'fast-browser-index-refresh-');
  const { root } = await movedOnPluginRoot(t);
  await mkdir(paths.macrosDir, { recursive: true, mode: 0o700 });
  const custom = '## custom-export\n\n- Status: approved';
  await writeFile(
    paths.macroIndexFile,
    ['# Macro Index', '', SHIPPED_RECON_SECTION, '', custom, '', CURRENT_CAPTURE_SECTION, '']
      .join('\n'),
    'utf8',
  );

  const report = await installBuiltinMacros({ ...paths, pluginRoot: root });

  const merged = await readFile(paths.macroIndexFile, 'utf8');
  assert.ok(merged.includes(CURRENT_RECON_SECTION), 'the stale section is replaced');
  assert.ok(!merged.includes(SHIPPED_RECON_SECTION), 'the stale section does not survive');
  assert.equal(merged.match(/^## page-recon$/gm).length, 1);
  assert.ok(merged.includes(custom), 'a neighbouring user section is untouched');
  assert.equal(
    report.index.find((entry) => entry.name === 'page-recon').action,
    'refreshed',
  );
});

test('a user-edited index section is preserved and reported rather than refreshed', async (t) => {
  const { installBuiltinMacros } = await import('../../lib/macros/install.mjs');
  const paths = await temporaryPaths(t, 'fast-browser-index-preserve-');
  const { root } = await movedOnPluginRoot(t);
  await mkdir(paths.macrosDir, { recursive: true, mode: 0o700 });
  const mine = '## page-recon\n\n- Status: mine';
  await writeFile(
    paths.macroIndexFile,
    ['# Macro Index', '', mine, '', CURRENT_CAPTURE_SECTION, ''].join('\n'),
    'utf8',
  );

  const report = await installBuiltinMacros({ ...paths, pluginRoot: root });

  const merged = await readFile(paths.macroIndexFile, 'utf8');
  assert.ok(merged.includes(mine), 'the user-authored section survives');
  assert.ok(!merged.includes(CURRENT_RECON_SECTION));
  assert.equal(
    report.index.find((entry) => entry.name === 'page-recon').action,
    'preserved',
  );
  assert.deepEqual(report.preserved, ['MACROS.md#page-recon']);
});

test('the shipped hash manifest refuses the empty-string digest', async (t) => {
  const { installBuiltinMacros } = await import('../../lib/macros/install.mjs');
  const paths = await temporaryPaths(t, 'fast-browser-macros-empty-digest-');
  const { root } = await syntheticPluginRoot(t, {
    macros: { 'page-recon.js': CURRENT_RECON, 'capture-annotated.js': CURRENT_CAPTURE },
    sections: { 'page-recon': CURRENT_RECON_SECTION, 'capture-annotated': CURRENT_CAPTURE_SECTION },
    // The digest of no bytes at all. A generator that hashes whatever readFile
    // returned for an absent file writes exactly this, and it would make the
    // installer treat a truncated macro as project-shipped and overwrite it.
    macroHashes: {
      'page-recon.js': [sha256(''), sha256(CURRENT_RECON)],
    },
  });

  await assert.rejects(
    () => installBuiltinMacros({ ...paths, pluginRoot: root }),
    /empty/,
  );
});

test('capture-annotated requires at least one target', async () => {
  const macro = await loadCaptureAnnotatedMacro();
  const page = fakeCapturePage();
  assert.deepEqual(await macro(page, { targets: {} }), {
    failedStep: 'args',
    error: 'targets is required',
  });
  assert.deepEqual(await macro(page, {}), {
    failedStep: 'args',
    error: 'targets is required',
  });
  assert.equal(page.screenshots.length, 0, 'must not screenshot before validating args');
});

for (const out of ['../escape', '/etc/passwd', 'a'.repeat(65), '']) {
  test(`capture-annotated rejects an unsafe out name: ${JSON.stringify(out)}`, async () => {
    const macro = await loadCaptureAnnotatedMacro();
    const page = fakeCapturePage();
    assert.deepEqual(await macro(page, { targets: { a: '.a' }, out }), {
      failedStep: 'args',
      error: 'out must be a simple file name',
    });
    assert.equal(page.screenshots.length, 0, 'must not screenshot before validating args');
  });
}

test('capture-annotated requires home, since the sandbox has no way to read it itself', async () => {
  const macro = await loadCaptureAnnotatedMacro();
  const page = fakeCapturePage();
  const result = await macro(page, { targets: { a: '.a' } });
  assert.equal(result.failedStep, 'args');
  assert.match(result.error, /home/);
  assert.equal(page.screenshots.length, 0, 'must not screenshot before validating args');
});

for (const [label, home] of [
  ['missing', undefined],
  ['null', null],
  ['a number', 42],
  ['empty string', ''],
  ['relative path', 'Users/test'],
  ['bare traversal', '../etc'],
  ['traversal in the middle', '/Users/../etc'],
  ['trailing traversal', '/Users/test/..'],
  ['over the length cap', `/${'a'.repeat(4096)}`],
]) {
  test(`capture-annotated rejects an unsafe home: ${label}`, async () => {
    const macro = await loadCaptureAnnotatedMacro();
    const page = fakeCapturePage();
    const result = await macro(page, { targets: { a: '.a' }, home });
    assert.equal(result.failedStep, 'args');
    assert.match(result.error, /home/);
    assert.equal(page.screenshots.length, 0, 'must not screenshot before validating args');
  });
}

test('capture-annotated accepts a plain absolute home with no .. segments', async () => {
  const macro = await loadCaptureAnnotatedMacro();
  const page = fakeCapturePage({ locators: { '.a': { count: 1, box: { x: 0, y: 0, width: 1, height: 1 } } } });
  const result = await macro(page, { targets: { a: '.a' }, home: '/Users/test' });
  assert.equal(result.png, '/Users/test/.fast-browser/screenshots/capture.png');
});

test('capture-annotated resolves visible targets and reports every miss reason', async () => {
  const macro = await loadCaptureAnnotatedMacro();
  const page = fakeCapturePage({
    locators: {
      '.title': { count: 1, box: { x: 10, y: 20, width: 100, height: 30 } },
      '.missing': { count: 0 },
      '.duplicate': { count: 3 },
      '.hidden': { count: 1, box: { x: 5, y: 5, width: 0, height: 0 } },
      '.offscreen': { count: 1, box: { x: 1200, y: 5, width: 200, height: 30 } },
    },
  });
  const result = await macro(page, {
    targets: {
      title: '.title',
      missing: '.missing',
      duplicate: '.duplicate',
      hidden: '.hidden',
      offscreen: '.offscreen',
    },
    out: 'my-capture',
    home: '/Users/test',
  });

  assert.equal(page.screenshots.length, 1, 'must screenshot exactly once');
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.name, 'my-capture.png');
  assert.match(result.png, /\/\.fast-browser\/screenshots\/my-capture\.png$/);
  assert.deepEqual(result.viewport, { inner: [1280, 800], client: [1280, 800] });
  assert.deepEqual(result.resolved, { title: [10, 20, 100, 30] });
  assert.equal(result.missed.length, 4);
  const byKey = Object.fromEntries(result.missed.map((entry) => [entry.key, entry]));
  assert.deepEqual(byKey.missing, { key: 'missing', reason: 'no-match' });
  assert.deepEqual(byKey.duplicate, { key: 'duplicate', reason: 'ambiguous', count: 3 });
  assert.deepEqual(byKey.hidden, { key: 'hidden', reason: 'not-visible' });
  assert.deepEqual(byKey.offscreen, { key: 'offscreen', reason: 'out-of-view' });
});

test('capture-annotated never reports a resolved box with a zero-or-negative dimension', async () => {
  const macro = await loadCaptureAnnotatedMacro();
  const page = fakeCapturePage({
    locators: {
      '.zero-width': { count: 1, box: { x: 0, y: 0, width: 0, height: 40 } },
      '.zero-height': { count: 1, box: { x: 0, y: 0, width: 40, height: 0 } },
    },
  });
  const result = await macro(page, {
    targets: { zeroWidth: '.zero-width', zeroHeight: '.zero-height' },
    home: '/Users/test',
  });
  assert.deepEqual(result.resolved, {});
  assert.equal(result.missed.length, 2);
  assert.ok(result.missed.every((entry) => entry.reason === 'not-visible'));
});

// The pre-round guard above tests boundingBox()'s own floating-point width
// and height, but the resolved rect is rounded. A sub-pixel element clears
// that guard and still rounds to a zero dimension, which `annotate` refuses
// as a zero-area box -- rejecting the WHOLE config, with an error blaming an
// annotation the agent measured correctly and cannot act on. The cross-module
// invariant is that anything in `resolved` passes annotate's guards, so the
// check has to be made against the numbers actually returned.
test('capture-annotated never resolves a sub-pixel box that rounds to a zero dimension', async () => {
  const macro = await loadCaptureAnnotatedMacro();
  const page = fakeCapturePage({
    locators: {
      '.hairline-width': { count: 1, box: { x: 10, y: 10, width: 0.4, height: 40 } },
      '.hairline-height': { count: 1, box: { x: 10, y: 10, width: 40, height: 0.4 } },
    },
  });
  const result = await macro(page, {
    targets: { hairlineWidth: '.hairline-width', hairlineHeight: '.hairline-height' },
    home: '/Users/test',
  });

  assert.deepEqual(result.resolved, {});
  assert.equal(result.missed.length, 2);
  assert.ok(
    result.missed.every((entry) => entry.reason === 'not-visible'),
    'a box that rounds away is a miss the agent can act on, not a resolution',
  );
});

test('capture-annotated catches a screenshot failure without measuring', async () => {
  const macro = await loadCaptureAnnotatedMacro();
  let evaluated = false;
  const page = fakeCapturePage({
    onScreenshot: () => {
      throw new Error('boom');
    },
  });
  const originalEvaluate = page.evaluate.bind(page);
  page.evaluate = async (...arguments_) => {
    evaluated = true;
    return originalEvaluate(...arguments_);
  };
  const result = await macro(page, { targets: { a: '.a' }, home: '/Users/test' });
  assert.deepEqual(result, {
    failedStep: 'capture',
    error: 'boom',
    url: 'https://example.test/',
  });
  assert.equal(evaluated, false, 'must not measure after a failed screenshot');
});

test('capture-annotated defaults out to "capture" when omitted', async () => {
  const macro = await loadCaptureAnnotatedMacro();
  const page = fakeCapturePage({ locators: { '.a': { count: 1, box: { x: 0, y: 0, width: 1, height: 1 } } } });
  const result = await macro(page, { targets: { a: '.a' }, home: '/Users/test' });
  assert.equal(result.name, 'capture.png');
});

test('capture-annotated screenshots before it measures, with nothing between', async () => {
  // The screenshot-then-measure adjacency is the feature's entire integrity
  // guarantee: measuring first (or interleaving other awaits between the two)
  // would let the page reflow in the gap, so the returned boxes could describe
  // a layout the PNG never showed. Pin the call order directly rather than
  // only inferring it from output shape.
  const calls = [];
  const page = fakeCapturePage({
    locators: { a: { count: 1, box: { x: 0, y: 0, width: 1, height: 1 } } },
  });
  const originalScreenshot = page.screenshot.bind(page);
  const originalEvaluate = page.evaluate.bind(page);
  page.screenshot = async (...arguments_) => {
    calls.push('screenshot');
    return originalScreenshot(...arguments_);
  };
  page.evaluate = async (...arguments_) => {
    calls.push('evaluate');
    return originalEvaluate(...arguments_);
  };
  const macro = await loadCaptureAnnotatedMacro();
  await macro(page, { targets: { a: 'a' }, home: '/Users/test' });
  assert.deepEqual(calls, ['screenshot', 'evaluate']);
});

test('capture-annotated runs to completion with no Node globals in scope, matching the real sandbox', async () => {
  const macro = await loadCaptureAnnotatedMacroWithoutNodeGlobals();
  const page = fakeCapturePage({
    locators: { '.a': { count: 1, box: { x: 1, y: 2, width: 3, height: 4 } } },
  });
  const result = await macro(page, { targets: { a: '.a' }, out: 'iso', home: '/Users/test' });
  // The macro's returned object was built inside a different vm realm, so it
  // does not share this process's Object.prototype; round-trip it through
  // JSON (own enumerable data only, no prototype) before asserting on shape,
  // rather than risking a spurious cross-realm mismatch from deepEqual.
  const plain = JSON.parse(JSON.stringify(result));
  assert.equal(plain.schemaVersion, 1);
  assert.equal(plain.name, 'iso.png');
  assert.equal(plain.png, '/Users/test/.fast-browser/screenshots/iso.png');
  assert.deepEqual(plain.resolved, { a: [1, 2, 3, 4] });
  assert.deepEqual(plain.missed, []);
});
