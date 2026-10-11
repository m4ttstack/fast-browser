import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolvePaths } from '../../lib/core/paths.mjs';
import { captureDigest, loadCapture, sealCapture } from '../../lib/compose/capture.mjs';

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

test('seal writes a sidecar beside the png that names it by basename', async () => {
  const { home, paths, captureReturn } = await setup();
  try {
    const { sidecar } = await sealCapture({ paths, captureReturn, fail });
    assert.equal(sidecar, path.join(paths.screenshotsDir, 'run1-case-after.c1.capture.json'));
    const body = JSON.parse(await readFile(sidecar, 'utf8'));
    assert.equal(body.image, 'run1-case-after.c1.png');
    assert.equal(body.digest, captureDigest(PNG, { frame: [0, 0, 1, 1], boxes: { a: [0, 0, 1, 1] } }));
    assert.equal('png' in body, false);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('load verifies the digest and resolves the image beside the sidecar', async () => {
  const { home, paths, captureReturn } = await setup();
  try {
    const { sidecar } = await sealCapture({ paths, captureReturn, fail });
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
  const { home, paths, captureReturn } = await setup();
  try {
    const { sidecar } = await sealCapture({ paths, captureReturn, fail });
    const body = JSON.parse(await readFile(sidecar, 'utf8'));
    body.boxes.a = [0, 0, 2, 2];
    await writeFile(sidecar, JSON.stringify(body));
    await assert.rejects(() => loadCapture({ sidecarPath: sidecar, fail }),
      /a capture sidecar does not match its image/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a sidecar moved without its png is refused clearly', async () => {
  const { home, paths, captureReturn } = await setup();
  try {
    const { sidecar } = await sealCapture({ paths, captureReturn, fail });
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

test('seal refuses a capture name with directory parts, even one that stays confined', async () => {
  const { home, paths, captureReturn } = await setup();
  try {
    const nested = path.join(paths.screenshotsDir, 'sub', 'run1-case-after.c1.png');
    await mkdir(path.dirname(nested), { recursive: true });
    await writeFile(nested, PNG);
    await assert.rejects(
      () => sealCapture({ paths, captureReturn: { ...captureReturn, name: 'sub/run1-case-after.c1.png', png: nested }, fail }),
      /^Error: capture png must be a bare file name$/,
    );
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('seal refuses a return whose png is outside the screenshots directory', async () => {
  const { home, paths, captureReturn } = await setup();
  try {
    await assert.rejects(
      () => sealCapture({ paths, captureReturn: { ...captureReturn, png: '/tmp/elsewhere.png', name: 'x.png' }, fail }),
      /capture png must be inside the screenshots directory/,
    );
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('seal refuses a return that is not a capture-evidence return', async () => {
  const { home, paths, captureReturn } = await setup();
  try {
    await assert.rejects(
      () => sealCapture({ paths, captureReturn: { ...captureReturn, schemaVersion: 1 }, fail }),
      /not a capture-evidence return/,
    );
  } finally { await rm(home, { recursive: true, force: true }); }
});
