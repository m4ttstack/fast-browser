import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { main } from '../../lib/cli/main.mjs';
import { parseArgs } from '../../lib/cli/parse-args.mjs';
import { compose } from '../../lib/commands/compose.mjs';
import { rendererPlatform } from '../../lib/compose/renderer.mjs';
import { resolvePaths } from '../../lib/core/paths.mjs';
import { loadRuntimeLock } from '../../lib/runtime/lock.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000'
  + '1f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');

async function world(scale = 1) {
  const home = await mkdtemp(path.join(tmpdir(), 'fb-cmd-'));
  const paths = resolvePaths({ homeDir: home, pluginRoot: path.resolve('.') });
  await mkdir(paths.screenshotsDir, { recursive: true });
  const png = path.join(paths.screenshotsDir, 'r-c-after.c1.png');
  await writeFile(png, PNG);
  const ret = path.join(home, 'return.json');
  await writeFile(ret, JSON.stringify({ schemaVersion: 'capture-evidence/1', name: 'r-c-after.c1.png', png,
    frame: [0, 0, 1, 1], frameSnap: 'card', boxes: { a: [0, 0, 1, 1] }, missed: [], dark: false, scale }));
  return { home, paths, ret };
}

test('seal writes the sidecar and reports it', async () => {
  const { home, paths, ret } = await world();
  try {
    const report = await compose({ command: 'compose', seal: ret, spec: null }, { paths });
    assert.equal(report.mode, 'seal');
    assert.equal(path.basename(report.sidecar), 'r-c-after.c1.capture.json');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('render refuses an invalid spec and lists every problem', async () => {
  const { home, paths, ret } = await world();
  try {
    const { sidecar } = await compose({ command: 'compose', seal: ret, spec: null }, { paths });
    const specPath = path.join(paths.screenshotsDir, 'spec.json');
    await writeFile(specPath, JSON.stringify({ state: 'NOPE', title: '', out: 'b.png',
      panels: [{ capture: path.basename(sidecar), marks: [{ lift: 'zzz' }] }] }));
    await assert.rejects(() => compose({ command: 'compose', spec: specPath, seal: null }, {
      paths, renderBoard: async () => { throw new Error('must not render'); },
    }), (error) => /state must be one of/.test(error.message) && /title is required/.test(error.message)
      && /names a key the capture did not measure/.test(error.message));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('render refuses a capture taken at a scale other than 1', async () => {
  const { home, paths, ret } = await world(2);
  try {
    const { sidecar } = await compose({ command: 'compose', seal: ret, spec: null }, { paths });
    const specPath = path.join(paths.screenshotsDir, 'spec.json');
    await writeFile(specPath, JSON.stringify({ state: 'AFTER', title: 'T', out: 'o.png',
      panels: [{ capture: path.basename(sidecar), marks: [] }] }));
    await assert.rejects(() => compose({ command: 'compose', spec: specPath, seal: null }, {
      paths, renderBoard: async () => { throw new Error('must not render'); },
    }), /panels\[0\]\.capture was taken at a scale this version cannot compose/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('render resolves the capture beside the spec, confines out, and reports warnings', async () => {
  const { home, paths, ret } = await world();
  try {
    const { sidecar } = await compose({ command: 'compose', seal: ret, spec: null }, { paths });
    const specPath = path.join(paths.screenshotsDir, 'spec.json');
    await writeFile(specPath, JSON.stringify({ state: 'AFTER', title: 'T', out: 'r-c-after.png',
      panels: [{ capture: path.basename(sidecar), marks: [{ lift: 'a', title: 'A' }] }] }));
    let rendered;
    const report = await compose({ command: 'compose', spec: specPath, seal: null }, {
      paths,
      rendererLocation: async () => ({ executablePath: '/x', playwrightCore: '/y' }),
      renderBoard: async (args) => { rendered = args; await writeFile(args.outPath, PNG);
        return { report: { warnings: ['a lift was clamped at the frame edge'] }, pixels: { width: 2, height: 2 } }; },
    });
    assert.equal(rendered.outPath, path.join(paths.screenshotsDir, 'r-c-after.png'));
    assert.equal(report.out, rendered.outPath);
    assert.deepEqual(report.warnings, ['a lift was clamped at the frame edge']);
    assert.ok((await readFile(rendered.outPath)).length > 0);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('render refuses an out that escapes the screenshots directory', async () => {
  const { home, paths, ret } = await world();
  try {
    const { sidecar } = await compose({ command: 'compose', seal: ret, spec: null }, { paths });
    const specPath = path.join(paths.screenshotsDir, 'spec.json');
    await writeFile(specPath, JSON.stringify({ state: 'AFTER', title: 'T', out: '../../x.png',
      panels: [{ capture: path.basename(sidecar), marks: [] }] }));
    await assert.rejects(() => compose({ command: 'compose', spec: specPath, seal: null }, { paths }),
      /out must resolve inside the screenshots directory/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('render explains a missing renderer with the setup remedy', async () => {
  const { home, paths, ret } = await world();
  try {
    const { sidecar } = await compose({ command: 'compose', seal: ret, spec: null }, { paths });
    const specPath = path.join(paths.screenshotsDir, 'spec.json');
    await writeFile(specPath, JSON.stringify({ state: 'AFTER', title: 'T', out: 'o.png',
      panels: [{ capture: path.basename(sidecar), marks: [] }] }));
    await assert.rejects(() => compose({ command: 'compose', spec: specPath, seal: null }, {
      paths, rendererLocation: async () => null,
    }), /run `fast-browser setup`/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

async function validSpec(paths, ret, extra = {}) {
  const { sidecar } = await compose({ command: 'compose', seal: ret, spec: null }, { paths });
  const specPath = path.join(paths.screenshotsDir, 'spec.json');
  await writeFile(specPath, JSON.stringify({ state: 'AFTER', title: 'T', out: 'o.png',
    panels: [{ capture: path.basename(sidecar), marks: [] }], ...extra }));
  return specPath;
}

const RENDERER_MISSING = 'the compose renderer is not installed; run `fast-browser setup`';
const RENDERER_UNPINNED = 'this fast-browser pins no compose renderer; upgrade fast-browser';
const RENDERER_UNSUPPORTED = 'compose is not available on this platform';

// The bundled lock decides which renderer message a fresh HOME sees, so the
// expectation follows it rather than freezing today's pin state.
test('the CLI composes with no injected plugin root and names the renderer remedy', async () => {
  const { home, paths, ret } = await world();
  try {
    const specPath = await validSpec(paths, ret);
    const lock = await loadRuntimeLock({ bundledPath: new URL('../../runtime-lock.json', import.meta.url) });
    const platform = rendererPlatform();
    let expected = RENDERER_UNPINNED;
    if (lock.renderer) expected = platform && lock.renderer.platforms[platform] ? RENDERER_MISSING : RENDERER_UNSUPPORTED;
    await assert.rejects(() => main(parseArgs(['compose', specPath]), { homeDir: home, write: () => {} }),
      (error) => error.name === 'LifecycleError' && error.exitCode === 2 && error.message === expected);
  } finally { await rm(home, { recursive: true, force: true }); }
});

for (const [status, renderer, message] of [
  ['unpinned', undefined, RENDERER_UNPINNED],
  ['unsupported', { revision: '1', platforms: {} }, RENDERER_UNSUPPORTED],
  ['missing', { revision: '1', platforms: { 'mac-arm64': { sha256: 'a'.repeat(64) } } }, RENDERER_MISSING],
]) {
  test(`render explains a ${status} renderer`, async () => {
    const { home, paths, ret } = await world();
    try {
      const specPath = await validSpec(paths, ret);
      await assert.rejects(() => compose({ command: 'compose', spec: specPath, seal: null }, {
        paths, runtimeLock: { productVersion: '0.0.0', renderer }, rendererPlatform: 'mac-arm64',
      }), (error) => error.exitCode === 2 && error.message === message);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
}

for (const [label, out] of [
  ['the capture png', 'r-c-after.c1.png'],
  ['the capture sidecar', 'r-c-after.c1.capture.json'],
  ['the spec file', 'spec.json'],
]) {
  test(`render refuses an out that would overwrite ${label}`, async () => {
    const { home, paths, ret } = await world();
    try {
      const before = await readFile(path.join(paths.screenshotsDir, 'r-c-after.c1.png'));
      const specPath = await validSpec(paths, ret, { out });
      await assert.rejects(() => compose({ command: 'compose', spec: specPath, seal: null }, {
        paths,
        rendererLocation: async () => ({ executablePath: '/x', playwrightCore: '/y' }),
        renderBoard: async () => { throw new Error('must not render'); },
      }), (error) => error.exitCode === 2 && /\bout\b/.test(error.message) && !error.message.includes(out));
      assert.deepEqual(await readFile(path.join(paths.screenshotsDir, 'r-c-after.c1.png')), before);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
}

for (const [label, body] of [['null', 'null'], ['an array', '[]']]) {
  test(`render refuses a spec that is ${label} with the problem list`, async () => {
    const { home, paths } = await world();
    try {
      const specPath = path.join(paths.screenshotsDir, 'spec.json');
      await writeFile(specPath, body);
      await assert.rejects(() => compose({ command: 'compose', spec: specPath, seal: null }, { paths }),
        (error) => error.name === 'LifecycleError' && error.exitCode === 2
          && /the compose spec has problems:\s+- the spec must be a JSON object/.test(error.message));
    } finally { await rm(home, { recursive: true, force: true }); }
  });
}

test('render turns a missing runtime playwright-core into the setup remedy', async () => {
  const { home, paths, ret } = await world();
  try {
    const specPath = await validSpec(paths, ret);
    await assert.rejects(() => compose({ command: 'compose', spec: specPath, seal: null }, {
      paths,
      rendererLocation: async () => ({ executablePath: '/x', playwrightCore: path.join(home, 'nope', 'index.mjs') }),
    }), (error) => error.name === 'LifecycleError' && error.exitCode === 2
      && error.message === 'the fast-browser runtime is not installed; run `fast-browser setup`');
  } finally { await rm(home, { recursive: true, force: true }); }
});
