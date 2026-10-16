import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

import { main } from '../../lib/cli/main.mjs';
import { parseArgs } from '../../lib/cli/parse-args.mjs';
import { compose } from '../../lib/commands/compose.mjs';
import { CAPTURE_SCHEMA, captureDigest } from '../../lib/compose/capture.mjs';
import { confirmRedactions } from '../../lib/compose/redactions.mjs';
import { resolvePaths } from '../../lib/core/paths.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000'
  + '1f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');
const crop = (n) => Buffer.concat([PNG, Buffer.from([n])]);

// An imported panel carries its own frame and boxes; the redaction gate applies to it.
const specOf = (out, marks) => ({ state: 'AFTER', title: 'T', out,
  panels: [{ capture: 'b.c1.capture.json', frame: [0, 0, 1, 1], boxes: { a: [0, 0, 1, 1] }, marks }] });

async function world({ out = 'b.png' } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'fb-red-'));
  const paths = resolvePaths({ homeDir: home, pluginRoot: path.resolve('.') });
  const dir = paths.screenshotsDir;
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'b.c1.png'), PNG);
  await writeFile(path.join(dir, 'b.c1.capture.json'), JSON.stringify({ schemaVersion: CAPTURE_SCHEMA, source: 'import', image: 'b.c1.png',
    origin: 'https://tracker.example/issues/1', format: 'png', scale: 1, digest: captureDigest(PNG, {}) }));
  const specPath = path.join(dir, 'b.spec.json');
  await writeFile(specPath, JSON.stringify(specOf(out, [{ redact: 'a' }])));
  return { home, paths, dir, specPath };
}

// Stands in for the renderer: writes the board and hands back `count` crops.
const rendering = (count, gated = true) => ({
  rendererLocation: async () => ({ executablePath: '/x', playwrightCore: '/y' }),
  renderBoard: async ({ outPath }) => {
    await writeFile(outPath, PNG);
    const crops = Array.from({ length: count }, (_, i) => ({ panel: 0, rect: [0, 0, 1, 1], i }));
    return { report: { warnings: [], gated, crops }, pixels: { width: 2, height: 2 }, board: PNG, crops: crops.map((c) => crop(c.i)) };
  },
});
const render = (w, count, gated) => compose({ command: 'compose', spec: w.specPath }, { paths: w.paths, ...rendering(count, gated) });
const confirm = (w) => compose(parseArgs(['compose', '--confirm', w.specPath]), { paths: w.paths });
const record = async (w) => JSON.parse(await readFile(path.join(w.dir, 'b.redactions.json'), 'utf8'));

test('a gated render writes one crop per redaction and an unconfirmed record', async () => {
  const w = await world();
  try {
    const report = await render(w, 2);
    assert.deepEqual(report.redactions.crops.map((p) => path.basename(p)), ['b.redact-1.png', 'b.redact-2.png']);
    const body = await record(w);
    assert.deepEqual([body.schemaVersion, body.board, body.redactions.length], ['compose-redactions/1', 'b.png', 2]);
    assert.ok(body.redactions.every((r) => r.confirmed === false && /^[0-9a-f]{64}$/.test(r.sha256)));
    assert.deepEqual(await readFile(path.join(w.dir, 'b.redact-2.png')), crop(1));
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('the record hashes the bytes the render produced, not a later read of the board file', async () => {
  const w = await world();
  try {
    const stub = rendering(1);
    await compose({ command: 'compose', spec: w.specPath }, { paths: w.paths, ...stub, renderBoard: async (args) => {
      const result = await stub.renderBoard(args);
      await writeFile(args.outPath, crop(7));
      return result;
    } });
    assert.equal((await record(w)).boardSha256, crypto.createHash('sha256').update(PNG).digest('hex'));
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('a gated render whose renderer returns no board bytes is refused', async () => {
  const w = await world();
  try {
    const stub = rendering(1);
    await assert.rejects(() => compose({ command: 'compose', spec: w.specPath }, { paths: w.paths, ...stub, renderBoard: async (args) => {
      const { board, ...rest } = await stub.renderBoard(args);
      return rest;
    } }), (error) => error.exitCode === 2 && /the renderer returned no board/.test(error.message));
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('confirm marks every entry, and confirming twice changes nothing', async () => {
  const w = await world();
  try {
    await render(w, 2);
    assert.deepEqual([(await confirm(w)).mode, (await confirm(w)).confirmed], ['confirm', 2]);
    assert.ok((await record(w)).redactions.every((r) => r.confirmed === true));
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('confirm refuses a missing crop, a changed crop and a changed board', async () => {
  for (const [change, message] of [
    [(w) => rm(path.join(w.dir, 'b.redact-1.png')), /a redaction crop is missing/],
    [(w) => writeFile(path.join(w.dir, 'b.redact-2.png'), crop(9)), /a redaction crop changed/],
    [(w) => writeFile(path.join(w.dir, 'b.png'), crop(7)), /the board changed/],
  ]) {
    const w = await world();
    try {
      await render(w, 2);
      await change(w);
      await assert.rejects(() => confirm(w), (error) => error.exitCode === 2 && message.test(error.message));
      assert.ok((await record(w)).redactions.every((r) => r.confirmed === false), 'a refused confirm confirms nothing');
    } finally { await rm(w.home, { recursive: true, force: true }); }
  }
});

test('a re-render resets a confirmed record and leaves no crop from the earlier render', async () => {
  const w = await world();
  try {
    await render(w, 3);
    await confirm(w);
    await render(w, 1);
    assert.ok((await record(w)).redactions.every((r) => r.confirmed === false));
    assert.deepEqual((await readdir(w.dir)).filter((f) => f.includes('.redact-')), ['b.redact-1.png']);
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('a board with no imported redaction has no record, and loses a stale one', async () => {
  const w = await world();
  try {
    await render(w, 1);
    await writeFile(w.specPath, JSON.stringify(specOf('b.png', [])));
    const report = await render(w, 0, false);
    assert.equal(report.redactions, undefined);
    assert.deepEqual((await readdir(w.dir)).filter((f) => f.includes('redact')), []);
    await assert.rejects(() => confirm(w), /this board has no redaction record/);
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('a record that names a crop outside its own bundle is refused', async () => {
  const w = await world();
  try {
    await render(w, 1);
    const body = await record(w);
    body.redactions[0].crop = '../b.c1.png';
    await writeFile(path.join(w.dir, 'b.redactions.json'), JSON.stringify(body));
    await assert.rejects(() => confirm(w), /the redaction record is malformed/);
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

const sidecarFor = (image) => JSON.stringify({ schemaVersion: CAPTURE_SCHEMA, source: 'live', image, frame: [0, 0, 1, 1], frameSnap: 'card',
  boxes: {}, missed: [], dark: false, scale: 1, digest: captureDigest(PNG, { frame: [0, 0, 1, 1], boxes: {} }) });

for (const [label, out, prepare] of [
  ['a differently cased capture name', 'B.C1.png', async () => {}],
  ['a symlink to a capture', 'alias.png', async (w) => symlink(path.join(w.dir, 'b.c1.png'), path.join(w.dir, 'alias.png'))],
  // The board's first crop would be written as b.redact-1.png, which this spec reads as a capture.
  ['a name whose crops would land on a capture', 'b.png', async (w) => {
    await writeFile(path.join(w.dir, 'b.redact-1.png'), PNG);
    await writeFile(path.join(w.dir, 'b.redact-1.capture.json'), sidecarFor('b.redact-1.png'));
    await writeFile(w.specPath, JSON.stringify({ state: 'AFTER', title: 'T', out: 'b.png', panels: [{ capture: 'b.redact-1.capture.json', marks: [] }] }));
  }],
]) {
  test(`render refuses an out that is ${label}`, async () => {
    const w = await world({ out });
    try {
      await prepare(w);
      await assert.rejects(() => compose({ command: 'compose', spec: w.specPath }, { paths: w.paths, ...rendering(1), renderBoard: async () => { throw new Error('must not render'); } }),
        (error) => error.exitCode === 2 && /\bout\b/.test(error.message));
      assert.deepEqual(await readFile(path.join(w.dir, 'b.c1.png')), PNG, 'the capture is untouched');
    } finally { await rm(w.home, { recursive: true, force: true }); }
  });
}

test('the CLI parses --confirm as a mode of its own', () => {
  assert.equal(parseArgs(['compose', '--confirm', 'b.spec.json']).confirm, 'b.spec.json');
  assert.equal(parseArgs(['compose', 'b.spec.json']).confirm, null);
  assert.throws(() => parseArgs(['compose', 'b.spec.json', '--confirm', 'b.spec.json']), /compose takes one of a spec path, --import or --confirm/);
  assert.throws(() => parseArgs(['compose', '--confirm']), /--confirm requires a value/);
});

test('the CLI names the crops to read and says who confirms', async () => {
  const lines = [];
  const report = { mode: 'render', ok: true, out: '/s/b.png', warnings: [], width: 2, height: 2, redactions: { record: '/s/b.redactions.json', crops: ['/s/b.redact-1.png'] } };
  await main(parseArgs(['compose', 'b.spec.json']), { write: (t) => lines.push(t), commands: { compose: async () => report } });
  assert.match(lines.join(''), /Redaction crops to read, unconfirmed:\n- \/s\/b\.redact-1\.png\n/);
  assert.match(lines.join(''), /only after the operator has confirmed every crop/);
  lines.length = 0;
  await main(parseArgs(['compose', '--confirm', 'b.spec.json']), { write: (t) => lines.push(t), commands: { compose: async () => ({ mode: 'confirm', ok: true, record: '/s/b.redactions.json', confirmed: 2 }) } });
  assert.equal(lines.join(''), 'Confirmed 2 redactions: /s/b.redactions.json\n');
});

test('a crop is never written through a symlink planted at its name', async () => {
  const w = await world();
  const outside = path.join(w.home, 'outside.png');
  try {
    await writeFile(outside, PNG);
    await symlink(outside, path.join(w.dir, 'b.redact-1.png'));
    await render(w, 1);
    assert.deepEqual(await readFile(outside), PNG, 'the file the link pointed at is untouched');
    const written = await lstat(path.join(w.dir, 'b.redact-1.png'));
    assert.ok(written.isFile() && !written.isSymbolicLink(), 'the crop is a regular file beside the board');
    assert.deepEqual(await readFile(path.join(w.dir, 'b.redact-1.png')), crop(0));
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('a render that dies leaves no confirmed record beside the old board', async () => {
  const w = await world();
  try {
    await render(w, 2);
    await confirm(w);
    await assert.rejects(() => compose({ command: 'compose', spec: w.specPath }, { paths: w.paths, ...rendering(2), renderBoard: async () => { throw new Error('renderer died'); } }), /renderer died/);
    assert.deepEqual((await readdir(w.dir)).filter((f) => f.includes('redact')), []);
    await assert.rejects(() => confirm(w), /this board has no redaction record/);
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('the record is written after the board, so it hashes the board that was drawn', async () => {
  const w = await world();
  try {
    await render(w, 1);
    const { createHash } = await import('node:crypto');
    assert.equal((await record(w)).boardSha256, createHash('sha256').update(await readFile(path.join(w.dir, 'b.png'))).digest('hex'));
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('a file that cannot be removed or written is one line without a path', async () => {
  const w = await world();
  try {
    await mkdir(path.join(w.dir, 'b.redact-1.png'));
    await assert.rejects(() => render(w, 1), (error) => error.exitCode === 2 && !error.message.includes(w.home) && /redaction/.test(error.message));
    await rm(path.join(w.dir, 'b.redact-1.png'), { recursive: true });
    const locked = {
      ...rendering(1),
      renderBoard: async (args) => { const done = await rendering(1).renderBoard(args); await chmod(w.dir, 0o500); return done; },
    };
    await assert.rejects(() => compose({ command: 'compose', spec: w.specPath }, { paths: w.paths, ...locked }),
      (error) => error.exitCode === 2 && !error.message.includes(w.home) && /redaction/.test(error.message));
  } finally { await chmod(w.dir, 0o700); await rm(w.home, { recursive: true, force: true }); }
});

test('confirm refuses an empty value and a spec that names no board', async () => {
  const w = await world();
  try {
    await assert.rejects(() => compose({ command: 'compose', confirm: '' }, { paths: w.paths }), (error) => error.exitCode === 2 && /--confirm needs a spec path/.test(error.message));
    await writeFile(w.specPath, JSON.stringify({ panels: [] }));
    await assert.rejects(() => confirm(w), /the compose spec names no board to confirm/);
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('a gated board whose renderer hands back too few crops is refused', async () => {
  const w = await world();
  try {
    const short = { ...rendering(2), renderBoard: async (args) => { const done = await rendering(2).renderBoard(args); return { ...done, crops: done.crops.slice(1) }; } };
    await assert.rejects(() => compose({ command: 'compose', spec: w.specPath }, { paths: w.paths, ...short }), (error) => error.exitCode === 2 && /wrong number of redaction crops/.test(error.message));
    assert.deepEqual((await readdir(w.dir)).filter((f) => f.includes('redact')), []);
    await assert.rejects(() => stat(path.join(w.dir, 'b.png')), { code: 'ENOENT' }, 'a refused gated render leaves no board');
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('a gated render whose crop write fails leaves no board and no record', async () => {
  const w = await world();
  try {
    const blocked = { ...rendering(2), renderBoard: async (args) => {
      const done = await rendering(2).renderBoard(args);
      await mkdir(path.join(w.dir, 'b.redact-2.png'));
      return done;
    } };
    await assert.rejects(() => compose({ command: 'compose', spec: w.specPath }, { paths: w.paths, ...blocked }), (error) => error.exitCode === 2 && /redaction/.test(error.message));
    await assert.rejects(() => stat(path.join(w.dir, 'b.png')), { code: 'ENOENT' });
    await assert.rejects(() => stat(path.join(w.dir, 'b.redactions.json')), { code: 'ENOENT' });
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('a gated render whose record write fails leaves no board', async () => {
  const w = await world();
  try {
    const blocked = { ...rendering(1), renderBoard: async (args) => {
      const done = await rendering(1).renderBoard(args);
      await mkdir(path.join(w.dir, 'b.redactions.json'));
      return done;
    } };
    await assert.rejects(() => compose({ command: 'compose', spec: w.specPath }, { paths: w.paths, ...blocked }), (error) => error.exitCode === 2 && /redaction/.test(error.message));
    await assert.rejects(() => stat(path.join(w.dir, 'b.png')), { code: 'ENOENT' });
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('a gated render whose renderer throws after writing the board leaves no board', async () => {
  const w = await world();
  try {
    const dying = { ...rendering(1), renderBoard: async (args) => { await rendering(1).renderBoard(args); throw new Error('crop screenshot failed'); } };
    await assert.rejects(() => compose({ command: 'compose', spec: w.specPath }, { paths: w.paths, ...dying }), /crop screenshot failed/);
    await assert.rejects(() => stat(path.join(w.dir, 'b.png')), { code: 'ENOENT' });
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('a render that is not gated and fails is unchanged: the board stays', async () => {
  const w = await world();
  try {
    await writeFile(w.specPath, JSON.stringify(specOf('b.png', [])));
    const dying = { ...rendering(0, false), renderBoard: async (args) => { await rendering(0, false).renderBoard(args); throw new Error('late failure'); } };
    await assert.rejects(() => compose({ command: 'compose', spec: w.specPath }, { paths: w.paths, ...dying }), /late failure/);
    assert.deepEqual(await readFile(path.join(w.dir, 'b.png')), PNG);
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('crops are not written through a board folder swapped for a symlink during the render', async () => {
  const w = await world({ out: 'sub/b.png' });
  const elsewhere = path.join(w.home, 'elsewhere');
  try {
    await mkdir(path.join(w.dir, 'sub'));
    await mkdir(elsewhere);
    const swapping = {
      ...rendering(1),
      renderBoard: async (args) => {
        const done = await rendering(1).renderBoard(args);
        await rename(path.join(w.dir, 'sub'), path.join(w.dir, 'sub.real'));
        await writeFile(path.join(elsewhere, 'b.png'), PNG);
        await symlink(elsewhere, path.join(w.dir, 'sub'));
        return done;
      },
    };
    await assert.rejects(() => compose({ command: 'compose', spec: w.specPath }, { paths: w.paths, ...swapping }), (error) => error.exitCode === 2 && /\bout\b/.test(error.message));
    assert.deepEqual((await readdir(elsewhere)).sort(), ['b.png'], 'nothing was written outside the screenshots folder');
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('a record of another schema, or one about another board, is refused', async () => {
  for (const edit of [(body) => { body.schemaVersion = 'compose-redactions/2'; }, (body) => { body.board = 'b.c1.png'; }]) {
    const w = await world();
    try {
      await render(w, 1);
      const body = await record(w);
      edit(body);
      await writeFile(path.join(w.dir, 'b.redactions.json'), JSON.stringify(body));
      await assert.rejects(() => confirm(w), /the redaction record is malformed/);
    } finally { await rm(w.home, { recursive: true, force: true }); }
  }
});

test('a record that cannot be updated is one line without a path', async () => {
  const w = await world();
  try {
    await render(w, 1);
    await chmod(w.dir, 0o500);
    await assert.rejects(() => confirm(w), (error) => error.exitCode === 2 && !error.message.includes(w.home) && /redaction record/.test(error.message));
  } finally { await chmod(w.dir, 0o700); await rm(w.home, { recursive: true, force: true }); }
});

test('a differently cased leftover from an earlier render is cleared too', async () => {
  const w = await world();
  try {
    await writeFile(path.join(w.dir, 'B.Redact-9.png'), PNG);
    await render(w, 1);
    assert.deepEqual((await readdir(w.dir)).filter((f) => f.toLowerCase().startsWith('b.redact-')).map((f) => f.toLowerCase()), ['b.redact-1.png']);
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('a gated board with no crop still writes an empty record that names the board', async () => {
  const w = await world();
  try {
    const report = await render(w, 0);
    assert.deepEqual(report.redactions.crops, []);
    const body = await record(w);
    assert.deepEqual(body.redactions, []);
    assert.equal(body.boardSha256, crypto.createHash('sha256').update(await readFile(path.join(w.dir, 'b.png'))).digest('hex'));
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('confirm on an empty record is a no-op that leaves it byte for byte as it was', async () => {
  const w = await world();
  try {
    await render(w, 0);
    const before = await readFile(path.join(w.dir, 'b.redactions.json'), 'utf8');
    const report = await confirm(w);
    assert.equal(report.confirmed, 0);
    assert.equal(await readFile(path.join(w.dir, 'b.redactions.json'), 'utf8'), before);
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('confirm on an empty record still refuses a board that changed after it rendered', async () => {
  const w = await world();
  try {
    await render(w, 0);
    await writeFile(path.join(w.dir, 'b.png'), crop(7));
    await assert.rejects(() => confirm(w), (error) => error.exitCode === 2 && /the board changed since it was rendered/.test(error.message) && !/holds no redactions/.test(error.message));
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('the CLI says there is nothing to confirm, and lists no crops, for an empty record', async () => {
  const lines = [];
  const report = { mode: 'render', ok: true, out: '/s/b.png', warnings: [], width: 2, height: 2, redactions: { record: '/s/b.redactions.json', crops: [] } };
  await main(parseArgs(['compose', 'b.spec.json']), { write: (t) => lines.push(t), commands: { compose: async () => report } });
  assert.equal(lines.join(''), 'Composed board at 2x2: /s/b.png\n');
  lines.length = 0;
  await main(parseArgs(['compose', '--confirm', 'b.spec.json']), { write: (t) => lines.push(t), commands: { compose: async () => ({ mode: 'confirm', ok: true, record: '/s/b.redactions.json', confirmed: 0 }) } });
  assert.equal(lines.join(''), 'Nothing to confirm: /s/b.redactions.json holds no redactions\n');
});

test('a renderer that reports a gated spec as not gated is refused and leaves nothing', async () => {
  const w = await world();
  try {
    const stub = rendering(1);
    const lying = { ...stub, renderBoard: async (args) => {
      const done = await stub.renderBoard(args);
      return { ...done, report: { ...done.report, gated: false, crops: [] }, crops: [] };
    } };
    await assert.rejects(() => compose({ command: 'compose', spec: w.specPath }, { paths: w.paths, ...lying }),
      (error) => error.exitCode === 2 && /disagrees with compose about whether this board is gated/.test(error.message));
    assert.deepEqual((await readdir(w.dir)).filter((f) => f.startsWith('b.') && !f.startsWith('b.c1') && f !== 'b.spec.json'), []);
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('a renderer that reports an ungated spec as gated is refused and leaves nothing', async () => {
  const w = await world();
  try {
    await writeFile(w.specPath, JSON.stringify(specOf('b.png', [])));
    await assert.rejects(() => render(w, 1, true), (error) => error.exitCode === 2 && /disagrees with compose about whether this board is gated/.test(error.message));
    assert.deepEqual((await readdir(w.dir)).filter((f) => f.startsWith('b.') && !f.startsWith('b.c1') && f !== 'b.spec.json'), []);
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

async function renderedBundle(w) {
  await render(w, 1);
  const dir = w.dir;
  return { dir, stem: 'b', confine: async (name) => path.join(dir, name), fail: (message) => new Error(message) };
}
const recordFile = (dir) => path.join(dir, 'b.redactions.json');

test('a confirm removes its record when the board changed while it was writing', async () => {
  const w = await world();
  try {
    const { dir, stem, confine, fail } = await renderedBundle(w);
    await assert.rejects(
      confirmRedactions({ dir, stem, confine, fail, afterWrite: async () => { await writeFile(path.join(dir, 'b.png'), Buffer.from('another board')); } }),
      /the board changed since it was rendered; render it again/,
    );
    await assert.rejects(readFile(recordFile(dir)), { code: 'ENOENT' });
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('a confirm removes its record when a crop changed while it was writing', async () => {
  const w = await world();
  try {
    const { dir, stem, confine, fail } = await renderedBundle(w);
    await assert.rejects(
      confirmRedactions({ dir, stem, confine, fail, afterWrite: async () => { await writeFile(path.join(dir, 'b.redact-1.png'), Buffer.from('another crop')); } }),
      /a redaction crop changed since it was rendered; render the board again/,
    );
    await assert.rejects(readFile(recordFile(dir)), { code: 'ENOENT' });
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('a confirm that cannot remove its record after the board changed still refuses, and says the record was not removed', async () => {
  const w = await world();
  try {
    const { dir, stem, confine, fail } = await renderedBundle(w);
    await assert.rejects(
      confirmRedactions({ dir, stem, confine, fail, afterWrite: async () => {
        await writeFile(path.join(dir, 'b.png'), Buffer.from('another board'));
        await chmod(dir, 0o500);
      } }),
      /^Error: the board changed while confirming and its record could not be removed; render it again$/,
    );
  } finally { await chmod(w.dir, 0o700); await rm(w.home, { recursive: true, force: true }); }
});

test('a confirm with nothing changing still confirms', async () => {
  const w = await world();
  try {
    const { dir, stem, confine, fail } = await renderedBundle(w);
    const done = await confirmRedactions({ dir, stem, confine, fail, afterWrite: async () => {} });
    const body = JSON.parse(await readFile(done.record, 'utf8'));
    assert.ok(body.redactions.every((entry) => entry.confirmed === true));
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('a confirm does not remove a newer record a render wrote over its own', async () => {
  const w = await world();
  try {
    const { dir, stem, confine, fail } = await renderedBundle(w);
    const newer = { schemaVersion: 'compose-redactions/1', board: 'b.png', boardSha256: 'f'.repeat(64), redactions: [] };
    await assert.rejects(confirmRedactions({ dir, stem, confine, fail, afterWrite: async () => {
      await writeFile(path.join(dir, 'b.png'), Buffer.from('another board'));
      await writeFile(recordFile(dir), JSON.stringify(newer));
    } }));
    assert.equal(JSON.parse(await readFile(recordFile(dir), 'utf8')).boardSha256, 'f'.repeat(64), "the render's own record is left alone");
  } finally { await rm(w.home, { recursive: true, force: true }); }
});
