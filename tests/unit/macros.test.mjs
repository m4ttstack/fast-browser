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
    macroIndexFile: path.join(dataDir, 'macros', 'MACROS.md'),
    pluginRoot,
  };
}

async function macroFixture(t, prefix = 'fast-browser-macros-') {
  return { paths: await temporaryPaths(t, prefix) };
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
  });
  assert.deepEqual(result.resolved, {});
  assert.equal(result.missed.length, 2);
  assert.ok(result.missed.every((entry) => entry.reason === 'not-visible'));
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
  const result = await macro(page, { targets: { a: '.a' } });
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
  const result = await macro(page, { targets: { a: '.a' } });
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
  await macro(page, { targets: { a: 'a' } });
  assert.deepEqual(calls, ['screenshot', 'evaluate']);
});
