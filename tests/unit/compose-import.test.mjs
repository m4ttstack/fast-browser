import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { main } from '../../lib/cli/main.mjs';
import { parseArgs } from '../../lib/cli/parse-args.mjs';
import { compose } from '../../lib/commands/compose.mjs';
import { loadCapture } from '../../lib/compose/capture.mjs';
import { sameFile, writeAtomic } from '../../lib/compose/files.mjs';
import { IMPORT_MAX_SIDE } from '../../lib/compose/engine.mjs';
import { IMPORT_MAX_BYTES, detectFormat, importCapture } from '../../lib/compose/import.mjs';
import { resolvePaths } from '../../lib/core/paths.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000'
  + '1f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');
const JPEG_HEAD = Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex');
const fail = (message) => Object.assign(new Error(message), { exitCode: 2 });
const rasterize = async () => PNG;

async function world() {
  const home = await mkdtemp(path.join(tmpdir(), 'fb-imp-'));
  const paths = resolvePaths({ homeDir: home, pluginRoot: path.resolve('.') });
  await mkdir(paths.screenshotsDir, { recursive: true });
  const source = path.join(home, 'ticket.jpg');
  await writeFile(source, JPEG_HEAD);
  return { home, paths, source };
}
const origin = 'https://tracker.example/issues/1';

test('formats are told apart by their first bytes, never by their name', () => {
  assert.equal(detectFormat(PNG), 'png');
  assert.equal(detectFormat(JPEG_HEAD), 'jpeg');
  assert.equal(detectFormat(Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1')), 'webp');
  assert.equal(detectFormat(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00', 'latin1')), 'gif');
  assert.equal(detectFormat(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(detectFormat(Buffer.from('<!doctype html><p>hi</p>')), null);
  assert.equal(detectFormat(Buffer.alloc(4)), null);
});

test('import writes a PNG and a sidecar with no measurements, and compose loads it', async () => {
  const { home, paths, source } = await world();
  try {
    const done = await importCapture({ paths, source, out: 'r-c-before.c1', origin, rasterize, fail });
    assert.equal(done.png, path.join(paths.screenshotsDir, 'r-c-before.c1.png'));
    assert.deepEqual([done.format, done.width, done.height], ['jpeg', 1, 1]);
    const body = JSON.parse(await readFile(done.sidecar, 'utf8'));
    assert.deepEqual(Object.keys(body).sort(), ['digest', 'format', 'image', 'origin', 'scale', 'schemaVersion', 'source']);
    assert.deepEqual([body.source, body.image, body.origin, body.format], ['import', 'r-c-before.c1.png', origin, 'jpeg']);
    assert.deepEqual(await readFile(done.png), PNG, 'the bundle holds the converted bytes');
    const loaded = await loadCapture({ sidecarPath: done.sidecar, fail });
    assert.deepEqual([loaded.source, loaded.frame, loaded.boxes, loaded.size, loaded.format, loaded.scale], ['import', null, {}, [1, 1], 'jpeg', 1]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('import creates the screenshots folder when it is not there yet, and only for a good import', async () => {
  const { home, paths, source } = await world();
  try {
    await rm(paths.screenshotsDir, { recursive: true });
    await writeFile(source, '<!doctype html><p>not an image</p>');
    await assert.rejects(() => importCapture({ paths, source, out: 'x.c1', origin, rasterize, fail }), /must be a PNG, JPEG, WebP or GIF/);
    await assert.rejects(() => readdir(paths.screenshotsDir), { code: 'ENOENT' });
    await writeFile(source, JPEG_HEAD);
    const done = await importCapture({ paths, source, out: 'x.c1', origin, rasterize, fail });
    assert.deepEqual((await readdir(paths.screenshotsDir)).sort(), ['x.c1.capture.json', 'x.c1.png']);
    assert.equal(done.png, path.join(paths.screenshotsDir, 'x.c1.png'));
  } finally { await rm(home, { recursive: true, force: true }); }
});

for (const [label, change, message] of [
  ['a file that is not an image', async ({ source }) => writeFile(source, '<!doctype html><p>not an image</p>'), /must be a PNG, JPEG, WebP or GIF/],
  ['an SVG', async ({ source }) => writeFile(source, '<svg xmlns="http://www.w3.org/2000/svg"/>'), /must be a PNG, JPEG, WebP or GIF/],
  ['a missing file', async ({ source }) => rm(source), /was not found/],
  ['a folder', async ({ source }) => { await rm(source); await mkdir(source); }, /was not found/],
  ['an image over 25 MB', async ({ source }) => writeFile(source, Buffer.concat([JPEG_HEAD, Buffer.alloc(25 * 1024 * 1024)])), /larger than 25 MB/],
]) {
  test(`import refuses ${label} and writes nothing`, async () => {
    const w = await world();
    try {
      await change(w);
      await assert.rejects(() => importCapture({ paths: w.paths, source: w.source, out: 'x.c1', origin, rasterize, fail }),
        (error) => message.test(error.message) && !error.message.includes('ticket'));
      assert.deepEqual(await readdir(w.paths.screenshotsDir), []);
    } finally { await rm(w.home, { recursive: true, force: true }); }
  });
}

test('import refuses an image the renderer cannot decode, a bad name, and a missing origin', async () => {
  const { home, paths, source } = await world();
  try {
    const args = { paths, source, out: 'x.c1', origin, rasterize, fail };
    await assert.rejects(() => importCapture({ ...args, rasterize: async () => { throw new Error('decode'); } }), /could not be decoded/);
    await assert.rejects(() => importCapture({ ...args, out: '../x' }), /out must be a simple file name/);
    await assert.rejects(() => importCapture({ ...args, out: 'a/b' }), /out must be a simple file name/);
    await assert.rejects(() => importCapture({ ...args, origin: '  ' }), /origin is required/);
    assert.deepEqual(await readdir(paths.screenshotsDir), []);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('import refuses an out shaped like a redaction crop and writes nothing', async () => {
  const { home, paths, source } = await world();
  try {
    for (const out of ['board.redact-1', 'Board.REDACT-7']) {
      await assert.rejects(() => importCapture({ paths, source, out, origin, rasterize, fail }),
        (error) => /^out must not be named like a redaction crop$/.test(error.message));
    }
    assert.deepEqual(await readdir(paths.screenshotsDir), []);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('the size limit in the message is the limit in force', async () => {
  const { home, paths, source } = await world();
  try {
    await writeFile(source, Buffer.concat([JPEG_HEAD, Buffer.alloc(IMPORT_MAX_BYTES)]));
    await assert.rejects(() => importCapture({ paths, source, out: 'x.c1', origin, rasterize, fail }),
      (error) => error.message === `the image to import is larger than ${IMPORT_MAX_BYTES / 1024 / 1024} MB`);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a write that fails is one line naming out, never a path', async () => {
  const { home, paths, source } = await world();
  try {
    await chmod(paths.screenshotsDir, 0o500);
    await assert.rejects(() => importCapture({ paths, source, out: 'x.c1', origin, rasterize, fail }),
      (error) => error.exitCode === 2 && error.message === 'out could not be written');
  } finally { await chmod(paths.screenshotsDir, 0o700); await rm(home, { recursive: true, force: true }); }
});

test('import refuses to write over the image it is reading, however the name is cased', async () => {
  const { home, paths } = await world();
  try {
    const source = path.join(paths.screenshotsDir, 'Ticket.c1.png');
    await writeFile(source, PNG);
    await assert.rejects(() => importCapture({ paths, source, out: 'ticket.c1', origin, rasterize, fail }), /out must not name the image being imported/);
    assert.deepEqual(await readFile(source), PNG);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('two spellings of one file are the same file, two files are not', async () => {
  const { home, paths, source } = await world();
  try {
    assert.equal(await sameFile(source, path.join(home, 'TICKET.JPG')), true);
    assert.equal(await sameFile(source, path.join(paths.screenshotsDir, 'ticket.jpg')), false);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('an import sidecar that carries measurements, or whose image changed, is refused', async () => {
  const { home, paths, source } = await world();
  try {
    const { sidecar, png } = await importCapture({ paths, source, out: 'x.c1', origin, rasterize, fail });
    const body = JSON.parse(await readFile(sidecar, 'utf8'));
    await writeFile(sidecar, JSON.stringify({ ...body, boxes: { a: [0, 0, 1, 1] } }));
    await assert.rejects(() => loadCapture({ sidecarPath: sidecar, fail }), /must not carry measurements/);
    await writeFile(sidecar, JSON.stringify(body));
    await writeFile(png, Buffer.concat([PNG, Buffer.from([0])]));
    await assert.rejects(() => loadCapture({ sidecarPath: sidecar, fail }), /does not match its image/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('the CLI parses --import with --out and --origin, and nothing else beside it', () => {
  const request = parseArgs(['compose', '--import', 'ticket.jpg', '--out', 'x.c1', '--origin', origin]);
  assert.deepEqual([request.import, request.out, request.origin, request.spec], ['ticket.jpg', 'x.c1', origin, null]);
  assert.throws(() => parseArgs(['compose', '--import', 'ticket.jpg']), /--import requires --out and --origin/);
  assert.throws(() => parseArgs(['compose', 'spec.json', '--import', 'ticket.jpg', '--out', 'x', '--origin', 'o']), /compose takes one of/);
  assert.throws(() => parseArgs(['compose', 'spec.json', '--out', 'x']), /--out and --origin go with --import/);
  assert.throws(() => parseArgs(['compose', '--import']), /--import requires a value/);
});

test('the command imports through the pinned renderer and the CLI reports the size', async () => {
  const { home, paths, source } = await world();
  try {
    let asked;
    const report = await compose(parseArgs(['compose', '--import', source, '--out', 'x.c1', '--origin', origin]), {
      paths, rendererLocation: async () => ({ executablePath: '/x', playwrightCore: '/y' }),
      rasterizeImage: async (image) => { asked = image; return PNG; },
    });
    assert.deepEqual([report.mode, report.width, report.height], ['import', 1, 1]);
    assert.deepEqual([asked.mime, asked.executablePath], ['image/jpeg', '/x']);
    const lines = [];
    await main(parseArgs(['compose', '--import', source, '--out', 'x.c1', '--origin', origin]), { write: (text) => lines.push(text), commands: { compose: async () => report } });
    assert.equal(lines.join(''), `Imported capture at 1x1: ${report.sidecar}\n`);
    await assert.rejects(() => compose(parseArgs(['compose', '--import', source, '--out', 'y.c1', '--origin', origin]), { paths, rendererLocation: async () => null }),
      /run `fast-browser setup`/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

const OTHER_PNG = Buffer.concat([PNG.subarray(0, 19), Buffer.from([2]), PNG.subarray(20)]);

for (const [label, existing] of [
  ['a PNG with a live sidecar', async (dir) => {
    await writeFile(path.join(dir, 'zebra-out.c1.png'), PNG);
    await writeFile(path.join(dir, 'zebra-out.c1.capture.json'), JSON.stringify({ source: 'live', frame: [0, 0, 1, 1], boxes: {} }));
  }],
  ['a PNG with no sidecar', async (dir) => writeFile(path.join(dir, 'zebra-out.c1.png'), PNG)],
  ['a sidecar with no PNG', async (dir) => writeFile(path.join(dir, 'zebra-out.c1.capture.json'), '{}')],
  ['a sidecar that cannot be read', async (dir) => writeFile(path.join(dir, 'zebra-out.c1.capture.json'), 'not json')],
]) {
  test(`import never replaces ${label}`, async () => {
    const { home, paths, source } = await world();
    try {
      await existing(paths.screenshotsDir);
      const before = new Map(await Promise.all((await readdir(paths.screenshotsDir)).map(async (name) => [name, await readFile(path.join(paths.screenshotsDir, name))])));
      await assert.rejects(() => importCapture({ paths, source, out: 'zebra-out.c1', origin, rasterize, fail }),
        (error) => /out names an existing capture/.test(error.message) && !error.message.includes('zebra'));
      const after = await readdir(paths.screenshotsDir);
      assert.deepEqual(after.sort(), [...before.keys()].sort());
      for (const [name, bytes] of before) assert.deepEqual(await readFile(path.join(paths.screenshotsDir, name)), bytes);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
}

test('import replaces an earlier import of the same name as a pair', async () => {
  const { home, paths, source } = await world();
  try {
    await importCapture({ paths, source, out: 'x.c1', origin, rasterize, fail });
    const again = await importCapture({ paths, source, out: 'x.c1', origin: `${origin}?v=2`, rasterize: async () => OTHER_PNG, fail });
    assert.deepEqual(await readFile(again.png), OTHER_PNG);
    const loaded = await loadCapture({ sidecarPath: again.sidecar, fail });
    assert.deepEqual([loaded.size, loaded.origin], [[2, 1], `${origin}?v=2`]);
    assert.deepEqual((await readdir(paths.screenshotsDir)).sort(), ['x.c1.capture.json', 'x.c1.png']);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a write that fails leaves no temp file behind', async () => {
  const { home, paths } = await world();
  try {
    const target = path.join(paths.screenshotsDir, 'taken');
    await mkdir(target);
    await assert.rejects(() => writeAtomic(target, 'data'));
    assert.deepEqual(await readdir(paths.screenshotsDir), ['taken']);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('an empty --import value is refused in one line', async () => {
  const { home, paths } = await world();
  try {
    await assert.rejects(
      () => main(parseArgs(['compose', '--import', '', '--out', 'x.c1', '--origin', origin]), { paths, write: () => {} }),
      (error) => error.name === 'LifecycleError' && error.exitCode === 2
        && !error.message.includes('\n') && /image to import/.test(error.message),
    );
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a decode that took too long is refused in one line', async () => {
  const { home, paths, source } = await world();
  try {
    const slow = async () => { throw Object.assign(new Error('timeout 30000ms'), { name: 'ImageDecodeTimeoutError' }); };
    await assert.rejects(() => importCapture({ paths, source, out: 'x.c1', origin, rasterize: slow, fail }), /took too long to decode/);
    assert.deepEqual(await readdir(paths.screenshotsDir), []);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('an image larger than the side limit is refused as too large, not as undecodable', async () => {
  const { home, paths, source } = await world();
  try {
    const huge = async () => { throw Object.assign(new Error('too large'), { name: 'ImageTooLargeError' }); };
    await assert.rejects(() => importCapture({ paths, source, out: 'x.c1', origin, rasterize: huge, fail }),
      (error) => error.message === `the image to import is larger than ${IMPORT_MAX_SIDE} px on a side`
        && !error.message.includes('ticket'));
    assert.deepEqual(await readdir(paths.screenshotsDir), []);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('an over-long origin and a multi-line origin each say why', async () => {
  const { home, paths, source } = await world();
  try {
    const args = { paths, source, out: 'x.c1', rasterize, fail };
    await assert.rejects(() => importCapture({ ...args, origin: 'o'.repeat(2001) }), /origin must be at most 2000 characters/);
    await assert.rejects(() => importCapture({ ...args, origin: 'first\nsecond' }), /origin must be one line without control characters/);
    await assert.rejects(() => importCapture({ ...args, origin: 'a\u0007b' }), /origin must be one line without control characters/);
    await assert.rejects(() => importCapture({ ...args, origin: '' }), /origin is required/);
    assert.deepEqual(await readdir(paths.screenshotsDir), []);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a re-import that fails while writing leaves no sidecar against the old image', async () => {
  const { home, paths, source } = await world();
  try {
    const first = await importCapture({ paths, source, out: 'x.c1', origin, rasterize, fail });
    await rm(first.png);
    await mkdir(first.png);
    await assert.rejects(() => importCapture({ paths, source, out: 'x.c1', origin, rasterize, fail }));
    assert.deepEqual((await readdir(paths.screenshotsDir)).sort(), ['x.c1.png']);
  } finally { await rm(home, { recursive: true, force: true }); }
});
