import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolvePaths } from '../../lib/core/paths.mjs';
import { captureDigest, loadCapture } from '../../lib/compose/capture.mjs';
import { writeSidecar } from '../e2e/helpers/capture-sidecar.mjs';

const fail = (message) => new Error(message);
// 1x1 PNG; only the bytes matter to the digest, and the IHDR to readPngSize.
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000'
  + '1f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), 'fb-cap-'));
  const paths = resolvePaths({ homeDir: home });
  await mkdir(paths.screenshotsDir, { recursive: true });
  const png = path.join(paths.screenshotsDir, 'run1-case-after.c1.png');
  await writeFile(png, PNG);
  const captureReturn = {
    schemaVersion: 'capture-evidence/1', name: 'run1-case-after.c1.png', png,
    frame: [0, 0, 1, 1], frameSnap: 'card', boxes: { a: [0, 0, 1, 1] }, missed: [],
    dark: false, viewport: { w: 1, h: 1 }, scale: 1,
  };
  return { home, paths, png, captureReturn };
}

test('load verifies the digest and resolves the image beside the sidecar', async () => {
  const { home, captureReturn } = await setup();
  try {
    const { sidecar } = await writeSidecar(captureReturn);
    const moved = path.join(home, 'elsewhere');
    await mkdir(moved);
    await rename(sidecar, path.join(moved, path.basename(sidecar)));
    await rename(captureReturn.png, path.join(moved, 'run1-case-after.c1.png'));
    const capture = await loadCapture({ sidecarPath: path.join(moved, path.basename(sidecar)), fail });
    assert.deepEqual(capture.size, [1, 1]);
    assert.deepEqual(capture.boxes, { a: [0, 0, 1, 1] });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('an edited box fails the digest', async () => {
  const { home, captureReturn } = await setup();
  try {
    const { sidecar } = await writeSidecar(captureReturn);
    const body = JSON.parse(await readFile(sidecar, 'utf8'));
    body.boxes.a = [0, 0, 2, 2];
    await writeFile(sidecar, JSON.stringify(body));
    await assert.rejects(() => loadCapture({ sidecarPath: sidecar, fail }),
      /a capture sidecar does not match its image/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a sidecar moved without its png is refused clearly', async () => {
  const { home, captureReturn } = await setup();
  try {
    const { sidecar } = await writeSidecar(captureReturn);
    await rm(captureReturn.png);
    await assert.rejects(() => loadCapture({ sidecarPath: sidecar, fail }),
      /a capture sidecar's image was not found beside it/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

for (const [label, body] of [['null', 'null'], ['an array', '[]'], ['a number', '7']]) {
  test(`a sidecar whose body is ${label} is refused as malformed`, async () => {
    const { home, paths } = await setup();
    try {
      const sidecar = path.join(paths.screenshotsDir, 'odd.capture.json');
      await writeFile(sidecar, body);
      await assert.rejects(() => loadCapture({ sidecarPath: sidecar, fail }), /^Error: a capture sidecar is malformed$/);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
}

test('a 2x capture loads with its frame and boxes in image pixels', async () => {
  const { home, captureReturn } = await setup();
  try {
    // The 1x1 test image holds a half-pixel CSS frame at 2x.
    const { sidecar } = await writeSidecar({ ...captureReturn, frame: [0, 0, 0.5, 0.5], boxes: { a: [0, 0, 0.5, 0.5] }, scale: 2 });
    const capture = await loadCapture({ sidecarPath: sidecar, fail });
    assert.equal(capture.scale, 2);
    assert.deepEqual(capture.frame, [0, 0, 1, 1]);
    assert.deepEqual(capture.boxes, { a: [0, 0, 1, 1] });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a sidecar that says scale 2 over a 1x image is refused', async () => {
  const { home, captureReturn } = await setup();
  try {
    const { sidecar } = await writeSidecar({ ...captureReturn, scale: 2 });
    await assert.rejects(() => loadCapture({ sidecarPath: sidecar, fail }), /a capture sidecar does not match its image/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

// A hand-edited sidecar with its digest recomputed: only the shape checks can refuse it.
async function editedSidecar(captureReturn, paths, edit) {
  const { sidecar } = await writeSidecar(captureReturn);
  const body = edit(JSON.parse(await readFile(sidecar, 'utf8')));
  body.digest = captureDigest(PNG, { frame: body.frame, boxes: body.boxes, scale: body.scale });
  await writeFile(sidecar, JSON.stringify(body));
  return sidecar;
}

for (const [label, edit] of [
  ['a null frame', (body) => ({ ...body, frame: null })],
  ['a frame with a null member', (body) => ({ ...body, frame: [0, 0, null, 1] })],
  ['a frame with a non-numeric member', (body) => ({ ...body, frame: [0, 0, 'wide', 1] })],
  ['a frame with no width', (body) => ({ ...body, frame: [0, 0, 0, 1] })],
  ['a box with a null width', (body) => ({ ...body, boxes: { a: [0, 0, null, 1] } })],
  ['a box with no height', (body) => ({ ...body, boxes: { a: [0, 0, 1, 0] } })],
  ['boxes as an array', (body) => ({ ...body, boxes: [[0, 0, 1, 1]] })],
  ['boxes as null', (body) => ({ ...body, boxes: null })],
  ['an image in a subdirectory', (body) => ({ ...body, image: 'sub/x.png' })],
  ['an image above the sidecar directory', (body) => ({ ...body, image: '../x.png' })],
  // `missed` sits outside the digest, so one edited field reaches the spec check.
  ['`missed` as a string', (body) => ({ ...body, missed: 'a' })],
  ['`missed` as an object', (body) => ({ ...body, missed: { key: 'a' } })],
  ['`missed` as a number', (body) => ({ ...body, missed: 7 })],
  ['`missed` holding null', (body) => ({ ...body, missed: [null] })],
  ['`missed` holding a number', (body) => ({ ...body, missed: [3] })],
  ['`missed` holding a string', (body) => ({ ...body, missed: ['x'] })],
  ['`missed` holding an entry with no key', (body) => ({ ...body, missed: [{}] })],
  ['`missed` holding an entry whose key is not a string', (body) => ({ ...body, missed: [{ key: 7, reason: 'no-match' }] })],
]) {
  test(`a sidecar with ${label} and a matching digest is refused as malformed`, async () => {
    const { home, paths, captureReturn } = await setup();
    try {
      const sidecar = await editedSidecar(captureReturn, paths, edit);
      await assert.rejects(() => loadCapture({ sidecarPath: sidecar, fail }), /^Error: a capture sidecar is malformed$/);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
}

test('a sidecar with tool-shaped `missed` entries loads them', async () => {
  const { home, paths, captureReturn } = await setup();
  try {
    const missed = [{ key: 'edit', reason: 'ambiguous', count: 3 }, { key: 'gone', reason: 'no-match' }];
    const sidecar = await editedSidecar(captureReturn, paths, (body) => ({ ...body, missed }));
    assert.deepEqual((await loadCapture({ sidecarPath: sidecar, fail })).missed, missed);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a sidecar with no `missed` loads with none missed', async () => {
  const { home, paths, captureReturn } = await setup();
  try {
    const sidecar = await editedSidecar(captureReturn, paths, ({ missed: _omitted, ...body }) => body);
    assert.deepEqual((await loadCapture({ sidecarPath: sidecar, fail })).missed, []);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a well-formed sidecar still loads at 1x after the edit helper recomputes its digest', async () => {
  const { home, paths, captureReturn } = await setup();
  try {
    const one = await editedSidecar(captureReturn, paths, (body) => body);
    assert.deepEqual((await loadCapture({ sidecarPath: one, fail })).frame, [0, 0, 1, 1]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

// The digest covers scale whenever it is not 1, so the scale cannot be edited to move the layout.
async function sidecarAtScale(paths, scale, { digest = 'new', half = scale === 2 ? 0.5 : 1 } = {}) {
  const frame = [0, 0, half, half]; const boxes = { a: [0, 0, half, half] };
  const body = {
    schemaVersion: 'capture-evidence/1', source: 'live', image: 'run1-case-after.c1.png', frame, frameSnap: 'card', boxes,
    missed: [], dark: false, scale,
    digest: captureDigest(PNG, digest === 'new' ? { frame, boxes, scale } : { frame, boxes }),
  };
  const sidecar = path.join(paths.screenshotsDir, `scale${scale}-${digest}.capture.json`);
  await writeFile(sidecar, JSON.stringify(body));
  return { sidecar, body };
}
const rewrite = async (sidecar, body) => { await writeFile(sidecar, JSON.stringify(body)); return sidecar; };
const NO_MATCH = /a capture sidecar does not match its image/;

test('a 2x sidecar with its scale deleted is refused', async () => {
  const { home, paths } = await setup();
  try {
    const { sidecar, body } = await sidecarAtScale(paths, 2);
    assert.equal((await loadCapture({ sidecarPath: sidecar, fail })).scale, 2);
    delete body.scale;
    await assert.rejects(async () => loadCapture({ sidecarPath: await rewrite(sidecar, body), fail }), NO_MATCH);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a 2x sidecar with its scale changed to 1 is refused', async () => {
  const { home, paths } = await setup();
  try {
    const { sidecar, body } = await sidecarAtScale(paths, 2);
    await assert.rejects(async () => loadCapture({ sidecarPath: await rewrite(sidecar, { ...body, scale: 1 }), fail }), NO_MATCH);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a 1x sidecar with its scale changed to 2 is refused', async () => {
  const { home, paths } = await setup();
  try {
    // A half-pixel 1x frame also fits the 1x1 image once doubled, so only the digest can refuse it.
    const { sidecar, body } = await sidecarAtScale(paths, 1, { half: 0.5 });
    await assert.rejects(async () => loadCapture({ sidecarPath: await rewrite(sidecar, { ...body, scale: 2 }), fail }), NO_MATCH);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a 2x sidecar whose digest was computed without scale is refused', async () => {
  const { home, paths } = await setup();
  try {
    const { sidecar } = await sidecarAtScale(paths, 2, { digest: 'old' });
    await assert.rejects(() => loadCapture({ sidecarPath: sidecar, fail }), NO_MATCH);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a 1x sidecar with no scale, null scale or scale 1 loads with the digest it always had', async () => {
  const { home, paths } = await setup();
  try {
    const { sidecar, body } = await sidecarAtScale(paths, 1);
    for (const edit of [(b) => { delete b.scale; return b; }, (b) => ({ ...b, scale: null }), (b) => b]) {
      const capture = await loadCapture({ sidecarPath: await rewrite(sidecar, edit({ ...body })), fail });
      assert.deepEqual(capture.frame, [0, 0, 1, 1]);
      assert.equal(capture.scale, 1);
    }
    assert.equal(body.digest, captureDigest(PNG, { frame: body.frame, boxes: body.boxes }));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a scale written as a string is never hashed as one thing and multiplied as another', async () => {
  const { home, paths } = await setup();
  try {
    const { sidecar, body } = await sidecarAtScale(paths, 2);
    const asString = { ...body, scale: '2' };
    asString.digest = captureDigest(PNG, { frame: body.frame, boxes: body.boxes, scale: '2' });
    const capture = await loadCapture({ sidecarPath: await rewrite(sidecar, asString), fail });
    assert.equal(capture.scale, '2');
    assert.deepEqual(capture.frame, [0, 0, 0.5, 0.5], 'a string scale is not multiplied; compose refuses it as an uncomposable scale');
  } finally { await rm(home, { recursive: true, force: true }); }
});
