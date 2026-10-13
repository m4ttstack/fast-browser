import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { rendererLaunches } from '../../lib/compose/renderer.mjs';
import { IMPORT_MAX_SIDE, rasterizeImage, renderBoard } from '../../lib/compose/engine.mjs';
import { readPngSize } from '../../lib/annotate/png.mjs';
import { buildBoardHtml, REDACT_FILL } from '../../lib/compose/page.mjs';
import { assertInvariants, assertPanel, intersects, pathsCross, rectDistance, segmentHitsRect } from './helpers/invariants.mjs';
import { countOffColor } from './helpers/png-diff.mjs';
import { rendererForTests } from './helpers/renderer.mjs';

const renderer = await rendererForTests();
const skip = renderer ? false : 'skipped by FAST_BROWSER_SKIP_COMPOSE_E2E=1';
const font = await readFile(new URL('../../assets/fonts/InterVariable.woff2', import.meta.url));
const geometrySource = await readFile(new URL('../../lib/compose/page-geometry.js', import.meta.url), 'utf8');
const layoutSource = await readFile(new URL('../../lib/compose/page-layout.js', import.meta.url), 'utf8');

// A synthetic 600x300 capture: white card, three grey text bars. `size`, `bars` and `boxes` are in CSS pixels;
// at a device scale the image has `scale` times as many pixels and the frame and boxes are in those.
async function syntheticCapture({ dark = false, size = [600, 300], bars, boxes, tints = [], scale = 1 } = {}) {
  const { chromium } = await import(renderer.playwrightCore);
  const browser = await chromium.launch({ headless: true, executablePath: renderer.executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: scale });
    const bg = dark ? '#111827' : '#ffffff'; const fg = dark ? '#e5e7eb' : '#334155';
    const list = bars ?? [[40, 40, 200, 20], [40, 80, 300, 20], [560, 260, 40, 40]];
    await page.setContent(`<body style="margin:0;background:${bg}">${list.map(([x, y, w, h]) =>
      `<div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;background:${fg}"></div>`).join('')}${tints.map(([x, y, w, h, colour]) =>
      `<div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;background:${colour}"></div>`).join('')}</body>`);
    const named = boxes ?? { a: list[0], b: list[1], edge: list[2] };
    return { png: await page.screenshot({ scale: 'device' }), size: size.map((n) => n * scale), frame: [0, 0, size[0] * scale, size[1] * scale], dark, scale,
      boxes: Object.fromEntries(Object.entries(named).map(([key, box]) => [key, box.map((n) => n * scale)])) };
  } finally { await browser.close(); }
}

async function render(spec, capture) {
  const captures = Array.isArray(capture) ? capture : [capture];
  const dir = await mkdtemp(path.join(tmpdir(), 'fb-compose-'));
  const outPath = path.join(dir, 'board.png');
  const html = buildBoardHtml({ spec, captures, fontBytes: font, geometrySource, layoutSource });
  const result = await renderBoard({ html, outPath, ...renderer });
  return { ...result, dir, outPath };
}

const spec = (marks, title = 'Board') => ({ state: 'AFTER', title, layout: 'single', out: 'o.png', panels: [{ capture: 'c.json', marks }] });
const p0 = (report) => report.panels[0];
const LENS_BOARD_PX = 110;
// A copy of BASE_K in lib/compose/page-layout.js, kept apart so the check does not read the code it checks.
const BASE_K = 1.06;

test('two adjacent lifts with labels hold every invariant', { skip }, async () => {
  const { report, dir } = await render(spec([
    { lift: 'a', title: 'First', note: 'One line' }, { lift: 'b', title: 'Second', tag: 'NEW' },
  ]), await syntheticCapture());
  try { assertInvariants(report); assert.equal(p0(report).labels.length, 2); } finally { await rm(dir, { recursive: true, force: true }); }
});

test('very long titles and notes wrap and still never overlap', { skip }, async () => {
  const long = 'A note that runs well past any sensible label width so it must wrap across several lines cleanly';
  const { report, dir } = await render(spec([
    { lift: 'a', title: 'A fairly long label title for a lifted element', note: long },
    { lift: 'b', title: 'Another long label title that keeps going', note: long },
  ]), await syntheticCapture());
  try { assertInvariants(report); } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a lift on a target touching the frame edge stays inside the frame and is reported', { skip }, async () => {
  const { report, dir } = await render(spec([{ lift: 'edge', title: 'Edge' }]), await syntheticCapture());
  try {
    assert.equal(p0(report).lifts[0].clamped, true, 'the edge lift is reported as clamped');
    assert.ok(report.warnings.includes('a lift was clamped at the frame edge'), 'an edge lift reports the clamp warning');
    assertInvariants(report);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a warning that applies to several lifts is listed once', { skip }, async () => {
  const bars = [[560, 40, 40, 40], [560, 200, 40, 40]];
  const { report, dir } = await render(spec([
    { lift: 'a', title: 'Upper edge' }, { lift: 'b', title: 'Lower edge' },
  ]), await syntheticCapture({ bars, boxes: { a: bars[0], b: bars[1] } }));
  try {
    assert.equal(p0(report).lifts.filter((l) => l.clamped).length, 2, 'both lifts are clamped');
    assert.deepEqual(report.warnings, [...new Set(report.warnings)], 'no warning is repeated');
    assert.equal(report.warnings.filter((w) => w === 'a lift was clamped at the frame edge').length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('two lifts side by side on one row keep leaders and labels apart', { skip }, async () => {
  const bars = [[40, 40, 100, 20], [300, 40, 100, 20]];
  const { report, dir } = await render(spec([
    { lift: 'a', title: 'Left target' }, { lift: 'b', title: 'Right target' },
  ]), await syntheticCapture({ bars, boxes: { a: bars[0], b: bars[1] } }));
  try { assertInvariants(report); assert.equal(p0(report).lifts.length, 2); } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a short title on a wide frame keeps labels apart', { skip }, async () => {
  const bars = [[300, 100, 100, 20], [400, 100, 100, 20]];
  const { report, dir } = await render(spec([
    { lift: 'a', title: 'First' }, { lift: 'b', title: 'Second' },
  ], 'X'), await syntheticCapture({ size: [1200, 300], bars, boxes: { a: bars[0], b: bars[1] } }));
  try { assertInvariants(report); assert.equal(p0(report).labels.length, 2); } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a lift over a redacted key shows the fill, never the original pixels', { skip }, async () => {
  const { report, dir, outPath } = await render(spec([{ redact: 'a' }, { lift: 'a', title: 'Covered' }]), await syntheticCapture());
  try {
    const { chromium } = await import(renderer.playwrightCore);
    const browser = await chromium.launch({ headless: true, executablePath: renderer.executablePath });
    try {
      const page = await browser.newPage();
      const png = (await readFile(outPath)).toString('base64');
      const lift = p0(report).lifts[0].rect;
      const [r, g, b] = await page.evaluate(async ({ png, x, y }) => {
        const img = new Image(); img.src = `data:image/png;base64,${png}`; await img.decode();
        const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
        return Array.from(ctx.getImageData(x, y, 1, 1).data);
      }, { png, x: Math.round((lift[0] + lift[2] / 2) * 2), y: Math.round((lift[1] + lift[3] / 2) * 2) });
      const fill = [0xCB, 0xD5, 0xE1];
      assert.ok(Math.abs(r - fill[0]) + Math.abs(g - fill[1]) + Math.abs(b - fill[2]) < 24, `pixel ${r},${g},${b} is not the redaction fill ${REDACT_FILL}`);
    } finally { await browser.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a redaction is drawn as its fill alone, with no pill', { skip }, async () => {
  const { report, dir } = await render(spec([{ redact: 'a' }]), await syntheticCapture());
  try {
    assert.equal(p0(report).redactions.length, 1);
    assert.deepEqual(Object.keys(p0(report).redactions[0]).sort(), ['fill', 'rect']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a lift edge never grows into a neighbouring lift: it stays put and warns', { skip }, async () => {
  const bars = [[40, 40, 102, 10]];
  const boxes = { a: [30, 35, 60, 20], b: [150, 35, 40, 20] };
  const { report, dir } = await render(spec([{ lift: 'a', title: 'First' }, { lift: 'b', title: 'Second' }]), await syntheticCapture({ bars, boxes }));
  try {
    assertInvariants(report);
    assert.deepEqual(p0(report).lifts[0].grown, [0, 0, 0, 0], 'the walled-in edge reverted');
    assert.ok(report.warnings.includes('a lift edge cuts through content'), 'the cut is reported');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a lift that cuts through content grows to the clean edge past it', { skip }, async () => {
  const bars = [[40, 40, 120, 10]];
  const boxes = { a: [30, 35, 60, 20] };
  const { report, dir } = await render(spec([{ lift: 'a', title: 'First' }]), await syntheticCapture({ bars, boxes }));
  try {
    assertInvariants(report);
    const [left, , right] = p0(report).lifts[0].grown;
    assert.equal(left, 0, 'a clean edge stays put');
    assert.ok(right >= 70, 'the cut edge grew past the bar');
    assert.equal(report.warnings.includes('a lift edge cuts through content'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('overlapping lifts may grow into each other, and a tiny lift is raised to a readable height', { skip }, async () => {
  const bars = [[40, 40, 120, 10], [300, 150, 8, 8]];
  const boxes = { a: [40, 35, 50, 20], b: [60, 35, 50, 20], tiny: [300, 150, 8, 8] };
  const { report, dir } = await render(spec([{ lift: ['a', 'b'], title: 'Pair' }, { lift: 'tiny', title: 'Small' }]), await syntheticCapture({ bars, boxes }));
  try {
    assertInvariants(report);
    assert.ok(p0(report).lifts[0].grown[2] > 20, 'the pair grew past its overlapping boxes');
    const tiny = p0(report).lifts[1];
    assert.ok(tiny.rect[3] >= 27.5, 'the tiny lift renders near 28px tall');
    assert.ok(tiny.k > 1.06 && tiny.k <= 3, 'the tiny lift reports the raised scale');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a minimum-size raise capped by the frame width is not reported as scaled down', { skip }, async () => {
  const bars = [[100, 100, 400, 10]];
  const { report, dir } = await render(spec([{ lift: 'a', title: 'Wide' }]), await syntheticCapture({ bars, boxes: { a: bars[0] } }));
  try {
    assertInvariants(report);
    assert.ok(p0(report).lifts[0].k >= 1.06 && p0(report).lifts[0].k < 1.6, 'the raise was capped by the width');
    assert.equal(report.warnings.includes('a lift was scaled down to fit the frame'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a dark capture gets the dark wash and lift border', { skip }, async () => {
  const { report, dir } = await render(spec([{ lift: 'a', title: 'Dark' }]), await syntheticCapture({ dark: true }));
  try { assert.equal(p0(report).dark, true); } finally { await rm(dir, { recursive: true, force: true }); }
});

test('two renders of the same out at once both finish and leave one valid png', { skip }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fb-compose-'));
  try {
    const outPath = path.join(dir, 'same.png');
    const capture = await syntheticCapture();
    const html = buildBoardHtml({ spec: spec([{ lift: 'a', title: 'Race' }]), captures: [capture], fontBytes: font, geometrySource, layoutSource });
    await Promise.all([renderBoard({ html, outPath, ...renderer }), renderBoard({ html, outPath, ...renderer })]);
    const bytes = await readFile(outPath);
    assert.equal(bytes.subarray(1, 4).toString('latin1'), 'PNG');
    const leftovers = (await readdir(dir)).filter((f) => f.includes('.tmp'));
    assert.deepEqual(leftovers, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the board renders at 2x', { skip }, async () => {
  const { report, pixels, dir } = await render(spec([{ lift: 'a', title: 'Scale' }]), await syntheticCapture());
  try {
    assert.equal(pixels.width, Math.round(report.stage[2] * 2));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a panel with no lift or redaction keeps its frame', { skip }, async () => {
  const { report, dir } = await render(spec([]), await syntheticCapture());
  try {
    assert.deepEqual(p0(report).frame, [0, 0, 600, 300]);
    assert.equal(p0(report).cropped, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a crop tightens around its marks and a redaction outside it is not drawn', { skip }, async () => {
  const bars = [[300, 120, 60, 20], [900, 500, 40, 30]];
  const capture = await syntheticCapture({ size: [1000, 600], bars, boxes: { a: bars[0], far: bars[1] } });
  const marks = [{ lift: 'a', title: 'Small' }, { redact: 'far' }];
  const both = await render(spec(marks), { ...capture, frame: [0, 0, 1000, 600] });
  try {
    assert.equal(p0(both.report).cropped, false, 'the redaction is a mark, so the crop spans both');
    assert.equal(p0(both.report).redactions.length, 1);
  } finally { await rm(both.dir, { recursive: true, force: true }); }
  const left = await render(spec(marks), { ...capture, frame: [0, 0, 600, 600] });
  try {
    assert.equal(p0(left.report).cropped, true);
    assert.ok(p0(left.report).frame[2] * p0(left.report).frame[3] < 0.5 * 600 * 600);
    assert.equal(p0(left.report).redactions.length, 0, 'a redaction outside the frame is not drawn');
    assertInvariants(left.report);
  } finally { await rm(left.dir, { recursive: true, force: true }); }
});

test('a point over two apart elements gets two lifts, one label and a connector that goes around a lift in its way', { skip }, async () => {
  const bars = [[40, 40, 60, 20], [200, 40, 60, 20], [360, 40, 60, 20], [360, 260, 60, 20]];
  const boxes = { a: bars[0], b: bars[1], c: bars[2], z: bars[3] };
  const { report, dir } = await render(spec([
    { lift: ['a', 'c'], title: 'Both ends' }, { lift: 'b', title: 'Middle' }, { lift: 'z', title: 'Below' },
  ]), await syntheticCapture({ size: [600, 400], bars, boxes }));
  try {
    assertInvariants(report);
    assert.deepEqual(p0(report).lifts.map((l) => l.mark), [0, 0, 1, 2], 'the first point has one lift per element');
    assert.equal(p0(report).labels.length, 3, 'one label per point');
    assert.deepEqual(p0(report).leaders[0].targets.length, 2, 'the leader serves both lifts');
    assert.equal(p0(report).connectors.length, 1);
    assert.equal(p0(report).connectors[0].points.length, 4, 'the connector left by the lift\'s other side and ran along the lane');
    assert.equal(p0(report).connectors[0].target, p0(report).leaders[0].targets[1], 'the connector belongs to the lift the leader does not start from');
    assert.equal(report.warnings.includes('a connector crosses another lift'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('with no clean spot for a dot on any open side it stays at the middle and the board warns once', { skip }, async () => {
  const bars = [[100, 100, 40, 20], [146, 40, 80, 160], [40, 126, 200, 60]];
  const { report, dir } = await render(spec([{ lift: 'a', title: 'Boxed in' }]), await syntheticCapture({ bars, boxes: { a: bars[0] } }));
  try {
    assertInvariants(report);
    assert.deepEqual(p0(report).dots.map((d) => d.slid), [0], 'the dot kept its place');
    assert.equal(report.warnings.filter((w) => w === 'a leader dot sits on page content').length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a connector dot slides off page content like a leader dot', { skip }, async () => {
  const bars = [[40, 40, 60, 20], [360, 40, 100, 20], [390, 76, 30, 14]];
  const { report, dir } = await render(spec([{ lift: ['a', 'c'], title: 'Both ends' }]), await syntheticCapture({ size: [600, 400], bars, boxes: { a: bars[0], c: bars[1] } }));
  try {
    assertInvariants(report);
    assert.equal(p0(report).connectors.length, 1);
    const dot = p0(report).dots.find((d) => d.target === p0(report).connectors[0].target && d.center[0] === p0(report).connectors[0].points[0][0]);
    assert.ok(dot, 'the connector has its own dot');
    assert.notEqual(dot.slid, 0, 'the connector dot slid off the block under its middle');
    assert.equal(report.warnings.includes('a leader dot sits on page content'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const board = async (marks, options) => {
  const { report, dir } = await render(spec(marks), await syntheticCapture(options));
  await rm(dir, { recursive: true, force: true });
  return report;
};

test('lifts that cannot be kept apart at their smallest scale are reported', { skip }, async () => {
  const bars = [[100, 100, 60, 20], [100, 121, 60, 20]];
  const report = await board([{ lift: 'a', title: 'Upper' }, { lift: 'b', title: 'Lower' }], { bars, boxes: { a: bars[0], b: bars[1] } });
  assert.ok(report.warnings.includes('two lifts overlap'));
});

test('a later lift gives way, down toward the base scale, when moving apart is not enough', { skip }, async () => {
  const bars = [[100, 100, 40, 8], [100, 120, 40, 8]];
  const report = await board([{ lift: 'a' }, { lift: 'b' }], { bars, boxes: { a: bars[0], b: bars[1] } });
  assertInvariants(report);
  const [first, later] = p0(report).lifts;
  assert.equal(intersects(first.rect, later.rect), false, 'the two cards do not overlap');
  assert.ok(later.k < first.k, `the later lift (k ${later.k}) gave way to the earlier (k ${first.k})`);
  assert.ok(later.k >= BASE_K - 1e-9, 'and did not go below the base scale');
  assert.equal(report.warnings.includes('a lift was scaled down to fit the frame'), false);
  assert.equal(report.warnings.includes('two lifts overlap'), false);
});

test('lifts with room between them report no overlap', { skip }, async () => {
  const bars = [[100, 100, 60, 20], [100, 180, 60, 20]];
  const report = await board([{ lift: 'a', title: 'Upper' }, { lift: 'b', title: 'Lower' }], { bars, boxes: { a: bars[0], b: bars[1] } });
  assertInvariants(report);
  assert.equal(report.warnings.includes('two lifts overlap'), false);
});

test('a dot that slides past a neighbour keeps its leader track clear of the neighbour', { skip }, async () => {
  // Ink beside the tall lift runs from its top to just above the middle of its right side, and the small lift
  // sits below that middle, so the dot slides down past the small lift to the first spot clear of both.
  const bars = [[40, 20, 60, 200], [200, 135, 60, 20], [108, 20, 10, 97]];
  const report = await board([{ lift: 'a', title: 'Tall' }, { lift: 'b', title: 'Small' }], { size: [600, 300], bars, boxes: { a: bars[0], b: bars[1] } });
  assertInvariants(report);
  const tall = p0(report).dots.find((d) => d.target === 0);
  assert.ok(tall.slid > 40, `the tall lift's dot slid ${tall.slid}px down its side`);
});

test('a leader with no clear side is reported', { skip }, async () => {
  const bars = [[100, 100, 60, 20], [200, 100, 60, 20], [100, 160, 60, 20]];
  const report = await board([{ lift: 'a', title: 'Boxed' }, { lift: 'b' }, { lift: 'c' }], { bars, boxes: { a: bars[0], b: bars[1], c: bars[2] } });
  assert.ok(report.warnings.includes('a leader crosses another lift'));
  assert.throws(() => assertInvariants(report), /a leader crosses another lift/);
});

test('a connector with no clear side is reported', { skip }, async () => {
  const bars = [[100, 100, 60, 20], [200, 100, 60, 20], [100, 160, 60, 20], [400, 30, 60, 20]];
  const boxes = { a: bars[0], b: bars[1], c: bars[2], far: bars[3] };
  const report = await board([{ lift: ['far', 'a'], title: 'Pair' }, { lift: 'b' }, { lift: 'c' }], { bars, boxes });
  assert.ok(report.warnings.includes('a connector crosses another lift'));
});

test('a connector joins a leader that leaves by the bottom', { skip }, async () => {
  const bars = [[100, 100, 80, 20], [700, 100, 80, 20]];
  const report = await board([{ lift: ['a', 'b'], title: 'Both' }], { size: [1200, 300], bars, boxes: { a: bars[0], b: bars[1] } });
  assertInvariants(report);
  assert.equal(p0(report).connectors.length, 1);
  const leader = p0(report).leaders[0].points;
  assert.ok(Math.abs(leader[0][0] - leader[1][0]) < 0.01, 'the leader leaves downward');
});

test('connectors of two marks never share a lane', { skip }, async () => {
  // Each pair's left lift is walled in on its right by a middle lift, so both connectors drop to the lane under the frame.
  const bars = [[40, 40, 60, 20], [200, 40, 60, 20], [360, 40, 60, 20], [120, 320, 60, 20], [280, 320, 60, 20], [440, 320, 60, 20]];
  const boxes = { a1: bars[0], m1: bars[1], a2: bars[2], b1: bars[3], m2: bars[4], b2: bars[5] };
  const report = await board([{ lift: ['a1', 'a2'], title: 'Top pair' }, { lift: ['b1', 'b2'], title: 'Lower pair' }, { lift: 'm1' }, { lift: 'm2' }], { size: [600, 600], bars, boxes });
  assertInvariants(report);
  const [first, second] = p0(report).connectors;
  assert.ok(first && second, 'each pair has a connector');
  assert.deepEqual([first.points.length, second.points.length], [4, 4], 'both connectors run along the lane');
  assert.notEqual(first.points[1][1], second.points[1][1], 'each connector has its own lane');
  assert.equal(pathsCross(first.points, second.points), false);
});

test('a connector that must rise through another mark\'s leader is reported', { skip }, async () => {
  const bars = [[40, 40, 60, 20], [200, 40, 60, 20], [360, 40, 60, 20], [120, 320, 60, 20], [280, 320, 60, 20], [440, 320, 60, 20]];
  const boxes = { a1: bars[0], m1: bars[1], a2: bars[2], b1: bars[3], m2: bars[4], b2: bars[5] };
  const report = await board([{ lift: ['a1', 'a2'], title: 'Top pair' }, { lift: ['b1', 'b2'], title: 'Lower pair' }, { lift: 'm1' }, { lift: 'm2' }], { size: [600, 600], bars, boxes });
  assert.ok(report.warnings.includes('a connector crosses another leader'));
});

test('merging two colliding lifts never sweeps another mark into them', { skip }, async () => {
  const bars = [[100, 100, 40, 20], [146, 122, 40, 20], [100, 126, 30, 14]];
  const boxes = { a: bars[0], c: bars[1], b: bars[2] };
  const report = await board([{ lift: ['a', 'c'], title: 'Diagonal pair' }, { lift: 'b', title: 'Between' }], { bars, boxes });
  assert.equal(p0(report).lifts.filter((l) => l.mark === 0).length, 2, 'the pair stays two lifts');
  assert.ok(p0(report).lifts.every((l) => !l.merged));
});

test('a connector is scored against clean ground, not against the first pixel under it', { skip }, async () => {
  // A 6px stripe beside the upper lift and a block under it leave no clean dot
  // spot. Against clean ground the stripe is a sample or two of ink and the
  // block is thirty; against the route's own first pixel, which is the stripe,
  // the whole clean run to the margin counts as ink instead.
  const bars = [[40, 40, 60, 20], [360, 220, 60, 20], [112, 30, 6, 40], [20, 70, 100, 60]];
  const report = await board([{ lift: ['a', 'c'], title: 'Both ends' }], { size: [600, 400], bars, boxes: { a: bars[0], c: bars[1] } });
  assert.equal(p0(report).connectors[0].points.length, 3, 'the connector leaves by the stripe side, straight to the leader');
});

test('two connectors that leave by the right run on their own lanes and clear the right-hand labels', { skip }, async () => {
  // Both pairs' leaders go to the bottom; each pair's other lift is walled in below and leaves by the right.
  // The third mark is walled in below too, so its label stands at the right.
  const bars = [[40, 40, 60, 20], [40, 80, 60, 20], [420, 120, 60, 20], [420, 160, 60, 20], [200, 230, 60, 20], [600, 230, 60, 20], [800, 180, 60, 20], [800, 220, 60, 20]];
  const boxes = { sp: bars[0], m1: bars[1], sq: bars[2], m2: bars[3], p: bars[4], q: bars[5], r: bars[6], m3: bars[7] };
  const report = await board([{ lift: ['sp', 'p'], title: 'First' }, { lift: ['sq', 'q'], title: 'Second' }, { lift: 'r', title: 'Third' }, { lift: 'm1' }, { lift: 'm2' }, { lift: 'm3' }], { size: [1000, 320], bars, boxes });
  const panel = p0(report);
  assert.equal(panel.connectors.length, 2);
  assert.ok(panel.connectors.every((c) => c.points.length === 4 && c.points[1][0] > panel.capture[0] + panel.capture[2]), 'both connectors run along a lane at the right');
  assert.ok(panel.labels.some((l) => l.rect[0] > panel.capture[0] + panel.capture[2]), 'a label stands at the right');
  assert.notEqual(panel.connectors[0].points[1][0], panel.connectors[1].points[1][0], 'each connector has its own lane');
  assertInvariants(report);
});

test('two connectors that leave by the bottom run on their own lanes and clear the bottom labels', { skip }, async () => {
  // Both pairs' leaders go to the right; each pair's other lift is walled in at the right and leaves by the bottom.
  // The third mark is walled in at the right too, so its label stands below.
  const bars = [[40, 40, 60, 20], [120, 40, 60, 20], [200, 120, 60, 20], [280, 120, 60, 20], [420, 200, 60, 20], [420, 280, 60, 20], [300, 280, 60, 20]];
  const boxes = { sp: bars[0], m1: bars[1], sq: bars[2], m2: bars[3], p: bars[4], q: bars[5], r: bars[6] };
  const report = await board([{ lift: ['sp', 'p'], title: 'First' }, { lift: ['sq', 'q'], title: 'Second' }, { lift: 'r', title: 'Third' }, { lift: 'm1' }, { lift: 'm2' }], { size: [560, 360], bars, boxes });
  const panel = p0(report);
  assert.equal(panel.connectors.length, 2);
  assert.ok(panel.connectors.every((c) => c.points.length === 4 && c.points[1][1] > panel.capture[1] + panel.capture[3]), 'both connectors run along a lane below');
  assert.ok(panel.labels.some((l) => l.rect[1] > panel.capture[1] + panel.capture[3]), 'a label stands below');
  assert.notEqual(panel.connectors[0].points[1][1], panel.connectors[1].points[1][1], 'each connector has its own lane');
  assertInvariants(report);
});

const centresApart = (a, b) => Math.hypot(a.center[0] - b.center[0], a.center[1] - b.center[1]);

test('a connector dot that would land on a leader dot slides clear of it', { skip }, async () => {
  // The single lift's leader leaves by the bottom, its dot just below the lift. The pair's other lift, below and left of it,
  // would put its connector dot on the middle of its right side, a few px from that one.
  const bars = [[100, 100, 60, 20], [144, 68, 60, 20], [260, 68, 60, 20], [100, 300, 60, 20], [320, 200, 60, 20]];
  const boxes = { a: bars[0], b: bars[1], d: bars[2], z: bars[3], p2: bars[4] };
  const report = await board([{ lift: ['a', 'p2'], title: 'First' }, { lift: 'b', title: 'Second' }, { lift: 'd' }, { lift: 'z' }], { size: [500, 400], bars, boxes });
  assertInvariants(report);
  const [connector] = p0(report).connectors;
  const dot = p0(report).dots.find((d) => d.target === connector.target && d.center[0] === connector.points[0][0] && d.center[1] === connector.points[0][1]);
  const leaderDot = p0(report).dots.find((d) => d.target === p0(report).lifts.findIndex((l) => l.keys.includes('b')));
  assert.ok(dot && leaderDot, 'the connector and the single lift each have a dot');
  assert.ok(centresApart(dot, leaderDot) >= dot.r + leaderDot.r + 2, `the two dots are ${centresApart(dot, leaderDot).toFixed(1)}px apart`);
  assert.notEqual(dot.slid, 0, 'the connector dot slid to make room');
});

test('a connector dot that would land on an earlier connector dot slides clear of it', { skip }, async () => {
  // The same two lifts, each now the second lift of a mark whose leader stands far off, so both dots belong to connectors.
  const bars = [[100, 100, 60, 20], [144, 68, 60, 20], [260, 68, 60, 20], [100, 300, 60, 20], [320, 200, 60, 20], [320, 240, 60, 20]];
  const boxes = { a: bars[0], b: bars[1], d: bars[2], z: bars[3], p2: bars[4], q2: bars[5] };
  const report = await board([{ lift: ['a', 'p2'], title: 'First' }, { lift: ['b', 'q2'], title: 'Second' }, { lift: 'd' }, { lift: 'z' }], { size: [500, 400], bars, boxes });
  assertInvariants(report);
  assert.equal(p0(report).connectors.length, 2);
  const [first, second] = p0(report).connectors.map((c) => p0(report).dots.find((d) => d.target === c.target && d.center[0] === c.points[0][0] && d.center[1] === c.points[0][1]));
  assert.ok(first && second, 'each connector has its dot');
  assert.ok(centresApart(first, second) >= first.r + second.r + 2, `the two dots are ${centresApart(first, second).toFixed(1)}px apart`);
  assert.ok(first.slid !== 0 || second.slid !== 0, 'one dot slid to make room');
});

test('an empty slot holds its text when it fits and hands it to a label when it does not', { skip }, async () => {
  const boxes = { big: [100, 60, 300, 150], small: [450, 230, 50, 18] };
  const report = await board([{ empty: 'big' }, { empty: 'small', text: 'Nothing rendered here' }], { bars: [], boxes });
  assertInvariants(report);
  assert.deepEqual(p0(report).slots.map((s) => s.text), ['inside', 'label']);
  assert.equal(p0(report).labels.length, 1, 'the small slot explains itself in the margin');
  assert.equal(p0(report).targets[p0(report).leaders[0].target].kind, 'slot');
  assert.equal(p0(report).wash, false);
});

test('an empty slot with a title of its own drops text that does not fit, and says so', { skip }, async () => {
  const report = await board([{ empty: 'small', title: 'Chart missing' }], { bars: [], boxes: { small: [300, 150, 50, 18] } });
  assert.equal(p0(report).slots[0].text, 'dropped');
  assert.ok(report.warnings.includes('an empty slot is too small for its text'));
});

test('a ghost slot sits on its box and takes a label', { skip }, async () => {
  const report = await board([{ ghost: 'a', tag: 'REMOVED', title: 'Removed' }], { bars: [], boxes: { a: [100, 100, 200, 40] } });
  assertInvariants(report);
  const [slot] = p0(report).slots;
  assert.equal(slot.kind, 'ghost');
  const scale = p0(report).capture[2] / p0(report).frame[2];
  assert.ok(Math.abs(slot.rect[2] - 200 * scale) < 1 && Math.abs(slot.rect[3] - 40 * scale) < 1, 'the slot is the size of its box');
  assert.equal(p0(report).dots.length, 1);
});

test('the real renderer launches and reports a version', { skip }, async () => {
  const result = await rendererLaunches({ executable: renderer.executablePath });
  assert.equal(result.ok, true);
  assert.match(result.version, /\d/);
});

const rows = [[60, 60, 200, 16], [60, 84, 200, 16], [60, 108, 200, 16]];
const rowBoxes = { r1: rows[0], r2: rows[1], r3: rows[2] };

test('a bracket sits beside its rows, not at the frame edge', { skip }, async () => {
  const report = await board([{ bracket: ['r1', 'r2'], title: 'Two rows' }], { bars: rows, boxes: rowBoxes });
  assertInvariants(report);
  const [bracket] = p0(report).brackets;
  const frameRight = p0(report).capture[0] + p0(report).capture[2];
  assert.equal(bracket.inMargin, false);
  assert.ok(frameRight - (bracket.rect[0] + bracket.rect[2]) > 40, 'the bracket is well inside the frame');
  assert.equal(p0(report).dots.length, 0, 'a bracket needs no dot');
  assert.equal(p0(report).flats.length, 0, 'no wash, so nothing to redraw');
});

test('a bracket slides past content that sits right beside its rows', { skip }, async () => {
  const report = await board([{ bracket: ['r1', 'r2'], title: 'Two rows' }], { bars: [...rows, [264, 60, 10, 40]], boxes: rowBoxes });
  assertInvariants(report);
  assert.ok(p0(report).brackets[0].slid > 0);
  assert.equal(report.warnings.includes('a bracket sits on page content'), false);
});

test('bracketed rows stay readable under a wash', { skip }, async () => {
  const bars = [...rows, [400, 200, 80, 20]];
  const report = await board([{ bracket: ['r1', 'r2'], title: 'Two rows' }, { lift: 'far', title: 'Elsewhere' }], { bars, boxes: { ...rowBoxes, far: bars[3] } });
  assertInvariants(report);
  assert.equal(p0(report).wash, true);
  assert.equal(p0(report).flats.length, 1);
});

test('rows that reach the frame edge put their bracket in the margin', { skip }, async () => {
  const wide = [[400, 60, 196, 16], [400, 84, 196, 16]];
  const report = await board([{ bracket: ['a', 'b'], title: 'Edge rows' }], { bars: wide, boxes: { a: wide[0], b: wide[1] } });
  assertInvariants(report);
  const [bracket] = p0(report).brackets;
  assert.equal(bracket.inMargin, true);
  assert.ok(bracket.rect[0] >= p0(report).capture[0] + p0(report).capture[2], 'the bracket is outside the screenshot');
});

test('a loupe rings its target and magnifies it in the margin', { skip }, async () => {
  const bars = [[300, 150, 10, 10]];
  const report = await board([{ loupe: 'tiny', zoom: 4, title: 'Tiny', note: 'Hard to see' }], { bars, boxes: { tiny: bars[0] } });
  assertInvariants(report);
  const [loupe] = p0(report).loupes;
  assert.equal(loupe.zoom, 4);
  assert.ok(Math.abs(loupe.lens[2] - 110) < 0.5 && Math.abs(loupe.lens[3] - 110) < 0.5, 'the lens is 110px across');
  assert.equal(p0(report).dots.length, 0, 'the ring is the marker');
  assert.equal(p0(report).labels.length, 1);
  assert.equal(report.warnings.length, 0);
});

test('a target too large for the lens is zoomed out, with a warning', { skip }, async () => {
  const bars = [[100, 100, 120, 40]];
  const report = await board([{ loupe: 'big', zoom: 8 }], { bars, boxes: { big: bars[0] } });
  assertInvariants(report);
  assert.ok(p0(report).loupes[0].zoom < 8 && p0(report).loupes[0].asked === 8);
  assert.ok(report.warnings.includes('a loupe was zoomed out to fit its target'));
});

test('a lens shows the frame and nothing beyond it', { skip }, async () => {
  const capture = await syntheticCapture({ bars: [[282, 140, 10, 10]], boxes: { tiny: [282, 140, 10, 10] }, tints: [[304, 100, 80, 100, '#dc2626']] });
  const { report, outPath, dir } = await render(spec([{ loupe: 'tiny', zoom: 2 }]), { ...capture, frame: [0, 0, 300, 300] });
  try {
    const scale = (await readFile(outPath)).readUInt32BE(16) / report.stage[2];
    const rect = p0(report).loupes[0].lens.map((v) => Math.round(v * scale));
    const red = await countOffColor({ png: await readFile(outPath), rect, color: [220, 38, 38], tolerance: 90, renderer });
    assert.equal(red.total - red.off, 0, 'the lens shows page that the frame left out');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// A board of a wide target is drawn at its smallest scale, which is what lets a lens
// reach further than the crop's margin: the lens spans 110 board pixels, about 200 capture pixels here.
test('a lens shows the crop of a single board and nothing the crop left out', { skip }, async () => {
  const bars = [[700, 580, 1000, 30]];
  const capture = await syntheticCapture({ size: [2400, 1200], bars, boxes: { wide: bars[0] },
    tints: [[1150, 495, 100, 20, '#dc2626'], [1150, 675, 100, 18, '#dc2626']] });
  const { report, outPath, dir } = await render(spec([{ loupe: 'wide', zoom: 8 }]), capture);
  try {
    assert.equal(p0(report).cropped, true, 'the board crops, so the blocks lie in the frame but outside the crop');
    const [, cropTop, , cropHeight] = p0(report).frame;
    assert.ok(515 < cropTop && 675 > cropTop + cropHeight, 'the blocks lie clear of the crop');
    const loupe = p0(report).loupes[0];
    const png = await readFile(outPath);
    const scale = png.readUInt32BE(16) / report.stage[2];
    const reach = (LENS_BOARD_PX / 2) / (loupe.zoom * (p0(report).capture[2] / p0(report).frame[2]));
    assert.ok(595 - reach < 495 && 595 + reach > 693, 'an unbounded lens would reach both blocks');
    const rect = loupe.lens.map((v) => Math.round(v * scale));
    const red = await countOffColor({ png, rect, color: [220, 38, 38], tolerance: 90, renderer });
    assert.equal(red.total - red.off, 0, 'the lens shows page that the crop left out');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a loupe over a redacted key magnifies the fill, never the original pixels', { skip }, async () => {
  const bars = [[100, 100, 40, 20]];
  const { report, outPath, dir } = await render(spec([{ redact: 'a' }, { loupe: 'a', zoom: 2 }]), await syntheticCapture({ bars, boxes: { a: bars[0] } }));
  try {
    const scale = (await readFile(outPath)).readUInt32BE(16) / report.stage[2];
    const [x, y, w, h] = p0(report).loupes[0].lens;
    const rect = [x + w / 2 - 6, y + h / 2 - 6, 12, 12].map((v) => Math.round(v * scale));
    const off = await countOffColor({ png: await readFile(outPath), rect, color: [0xCB, 0xD5, 0xE1], tolerance: 24, renderer });
    assert.equal(off.off, 0, 'the middle of the lens is the redaction fill');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a link keeps two lifts where a lift of the same keys would make one', { skip }, async () => {
  const bars = [[100, 100, 60, 20], [166, 100, 60, 20]];
  const boxes = { a: bars[0], b: bars[1] };
  const lifted = await board([{ lift: ['a', 'b'], title: 'Together' }], { bars, boxes });
  assert.equal(p0(lifted).lifts.length, 1, 'adjacent keys in one lift mark cluster');
  const linked = await board([{ link: ['a', 'b'], title: 'Linked' }], { bars, boxes });
  assert.equal(p0(linked).lifts.length, 2);
  assert.equal(p0(linked).links.length, 1);
  assert.equal(p0(linked).labels.length, 1);
  assert.equal(p0(linked).connectors.length, 1);
});

test('a link across the frame holds every invariant', { skip }, async () => {
  const bars = [[40, 40, 60, 20], [420, 220, 60, 20]];
  const report = await board([{ link: ['a', 'b'], title: 'Same fact, two places' }], { size: [600, 400], bars, boxes: { a: bars[0], b: bars[1] } });
  assertInvariants(report);
  assert.equal(p0(report).links.length, 1);
});

test('a bracket with no slide position clear of content warns that it sits on content', { skip }, async () => {
  const report = await board([{ bracket: ['r1', 'r2'], title: 'Two rows' }], { bars: [...rows, [264, 40, 20, 80], [290, 40, 20, 80], [316, 40, 20, 80]], boxes: rowBoxes });
  assert.ok(report.warnings.includes('a bracket sits on page content'));
});

test('rows that cannot be grown to clean ground warn that a bracket edge cuts through content', { skip }, async () => {
  const checker = Array.from({ length: 24 * 40 }, (_, n) => [20 + (n % 40) * 10, 20 + Math.floor(n / 40) * 10, 10, 10]).filter((_, n) => (Math.floor(n / 40) + (n % 40)) % 2 === 0);
  const report = await board([{ bracket: ['a', 'b'], title: 'Noisy rows' }], { size: [480, 300], bars: checker, boxes: { a: [100, 100, 120, 20], b: [100, 130, 120, 20] } });
  assert.ok(report.warnings.includes('a bracket edge cuts through content'));
});

test('a lift beside the rows of a margin bracket raises no leader warning when no leader crosses a lift', { skip }, async () => {
  // Lift x sits just above the rows: its right-hand band brushes the margin bracket, its bottom is blocked by lift y,
  // and its leader runs clear above the bracket.
  const bars = [[400, 60, 196, 16], [400, 84, 196, 16], [100, 46, 40, 16], [100, 90, 40, 16]];
  const report = await board([{ bracket: ['a', 'b'], title: 'Edge rows' }, { lift: 'x', title: 'Beside' }, { lift: 'y', title: 'Below' }], { bars, boxes: { a: bars[0], b: bars[1], x: bars[2], y: bars[3] } });
  assertInvariants(report);
  assert.equal(p0(report).brackets[0].inMargin, true);
  assert.deepEqual(report.warnings, []);
});

test('an untitled loupe has a lens and a leader but no label', { skip }, async () => {
  const bars = [[300, 150, 10, 10]];
  const report = await board([{ loupe: 'tiny' }], { bars, boxes: { tiny: bars[0] } });
  assertInvariants(report);
  const panel = p0(report);
  assert.equal(panel.labels.length, 0);
  assert.equal(panel.loupes.length, 1);
  assert.equal(panel.leaders.length, 1);
  assert.ok(rectDistance(panel.leaders[0].points.at(-1), panel.loupes[0].lens) <= 8, 'the leader ends at the lens');
});

test('a loupe shares the margin with the leaders and labels of other lifts', { skip }, async () => {
  const bars = [[300, 150, 10, 10], [40, 110, 100, 20], [40, 190, 100, 20]];
  const report = await board([{ lift: 'a', title: 'Above' }, { loupe: 'tiny', title: 'Tiny' }, { lift: 'c', title: 'Below' }], { size: [400, 380], bars, boxes: { tiny: bars[0], a: bars[1], c: bars[2] } });
  assertInvariants(report);
  assert.equal(p0(report).loupes.length, 1);
  assert.equal(p0(report).labels.length, 3);
});

test('a loupe on a target larger than the frame allows keeps its ring inside the frame', { skip }, async () => {
  const bars = [[10, 10, 180, 100]];
  const report = await board([{ loupe: 'big' }], { size: [200, 120], bars, boxes: { big: bars[0] } });
  assertInvariants(report);
});

// A mark thin enough that a leader across it stays under LEADER_THROUGH samples, as one letter stroke does.
const stroke = (x, y, w, h) => [x, y, w, h];
const leaves = (panel, side) => {
  const [rx, ry, rw, rh] = panel.loupes[0].ring; const [x, y] = panel.leaders[0].points[0];
  return side === 'right' ? Math.abs(x - (rx + rw)) < 0.5 && Math.abs(y - (ry + rh / 2)) < 0.5 : Math.abs(y - (ry + rh)) < 0.5 && Math.abs(x - (rx + rw / 2)) < 0.5;
};

test('a loupe that cannot slide its leader leaves by the side that strikes the least', { skip }, async () => {
  const bars = [[302, 142, 4, 4], stroke(250, 220, 120, 2)];
  const report = await board([{ loupe: 'tiny', title: 'Tiny' }, { redact: 'far' }], { size: [1400, 300], bars, boxes: { tiny: [300, 140, 10, 10], far: [1300, 10, 30, 10] } });
  assertInvariants(report);
  assert.ok(leaves(p0(report), 'right'), 'the leader goes right, past nothing, and not down through the stroke');
});

test('a loupe avoids a stem that sits one pixel beside its leader\'s centre line', { skip }, async () => {
  const bars = [[302, 142, 4, 4], [306, 165, 1, 120]];
  const report = await board([{ loupe: 'tiny', title: 'Tiny' }, { redact: 'far' }], { size: [1400, 300], bars, boxes: { tiny: [300, 140, 10, 10], far: [1300, 10, 30, 10] } });
  assertInvariants(report);
  assert.ok(leaves(p0(report), 'right'), 'the leader goes right, because the stroke below would cover the stem');
});

test('a loupe on a target unlike the page is scored against the page, not the target', { skip }, async () => {
  const bars = [[300, 140, 10, 10], stroke(250, 220, 120, 2)];
  const report = await board([{ loupe: 'tiny', title: 'Tiny' }, { redact: 'far' }], { size: [1400, 300], bars, boxes: { tiny: bars[0], far: [1300, 10, 30, 10] } });
  assertInvariants(report);
  assert.ok(leaves(p0(report), 'right'), 'the empty run to the right strikes nothing; the stroke below does');
});

test('a loupe with a stroke to its right leaves by the bottom', { skip }, async () => {
  const bars = [[302, 142, 4, 4], stroke(335, 100, 2, 100)];
  const report = await board([{ loupe: 'tiny', title: 'Tiny' }], { bars, boxes: { tiny: [300, 140, 10, 10] } });
  assertInvariants(report);
  assert.ok(leaves(p0(report), 'bottom'), 'the leader goes down, past nothing, and not right through the stroke');
});

test('a lift keeps the preferred side over a stroke, because its dot slides off', { skip }, async () => {
  const bars = [[302, 142, 4, 4], stroke(335, 100, 2, 100)];
  const report = await board([{ lift: 'tiny', title: 'Tiny' }], { bars, boxes: { tiny: [300, 140, 10, 10] } });
  assertInvariants(report);
  const [lift] = p0(report).lifts; const [x] = p0(report).leaders[0].points[0];
  assert.ok(x >= lift.rect[0] + lift.rect[2], 'the leader leaves the lift by its right side');
});

const leavesBy = (panel) => {
  const [lift] = panel.lifts; const [x, y] = panel.leaders[0].points[0];
  return y >= lift.rect[1] + lift.rect[3] && x < lift.rect[0] + lift.rect[2] ? 'bottom' : 'right';
};

test('a lift whose preferred side strikes a wide block at every spot takes the empty side', { skip }, async () => {
  const lift = [100, 100, 60, 20]; const far = [560, 260, 30, 20];
  const open = await board([{ lift: 'a', title: 'Blocked' }, { redact: 'far' }], { bars: [lift, far], boxes: { a: lift, far } });
  assert.equal(leavesBy(p0(open)), 'right', 'with nothing in the way the leader goes to the preferred side');
  const report = await board([{ lift: 'a', title: 'Blocked' }, { redact: 'far' }], { bars: [lift, [260, 60, 140, 140], far], boxes: { a: lift, far } });
  assertInvariants(report);
  assert.equal(leavesBy(p0(report)), 'bottom');
});

test('a lift whose right side is a thin block at every spot leaves by the bottom, and strikes nothing', { skip }, async () => {
  const lift = [100, 100, 60, 20]; const far = [560, 280, 30, 14];
  const bars = [lift, [200, 40, 12, 200], [120, 150, 20, 140], far];
  const report = await board([{ lift: 'a', title: 'Blocked' }, { redact: 'far' }], { bars, boxes: { a: lift, far } });
  assertInvariants(report);
  assert.equal(leavesBy(p0(report)), 'bottom', 'the dot does not sit on the side the block covers');
  assert.equal(report.warnings.includes('a leader dot sits on page content'), false);
});

test('a lift whose every side strikes content keeps the least struck spot and says the dot sits on content', { skip }, async () => {
  const lift = [100, 100, 60, 20]; const far = [560, 280, 30, 14];
  const bars = [lift, [200, 40, 12, 200], [60, 150, 140, 12], far];
  const report = await board([{ lift: 'a', title: 'Boxed in' }, { redact: 'far' }], { bars, boxes: { a: lift, far } });
  assertInvariants(report);
  assert.ok(report.warnings.includes('a leader dot sits on page content'));
});

const DOT_OUTER = 5.5;
const onFill = (panel, point) => panel.redactions.some((r) => rectDistance(point, r.rect) < DOT_OUTER);
const crossesFill = (panel, points) => panel.redactions.some((r) => points.slice(1).some((q, i) => segmentHitsRect(points[i], q, r.rect)));

test('a slot whose bottom edge lies on a redaction fill puts its dot on open ground, not on the fill', { skip }, async () => {
  const slot = [100, 60, 500, 40]; const under = [90, 70, 470, 230];
  const report = await board([{ empty: 'mine', text: 'Nothing here', title: 'Empty slot' }, { redact: 'under' }], { size: [900, 300], bars: [under], boxes: { mine: slot, under } });
  assertInvariants(report);
  const panel = p0(report);
  assert.equal(onFill(panel, panel.dots[0].center), false, 'the dot is not on the fill');
  assert.equal(crossesFill(panel, panel.leaders[0].points.slice(0, 2)), false, 'the path leaves the slot across no fill');
  assert.equal(report.warnings.includes('a leader dot sits on page content'), false);
});

test('a lift whose preferred side is covered by a fill for most of its length puts its dot on the uncovered part', { skip }, async () => {
  const lift = [100, 100, 60, 100]; const covered = [160, 92, 40, 66]; const shelf = [60, 215, 200, 10];
  const report = await board([{ lift: 'a', title: 'Beside a fill' }, { redact: 'covered' }], { bars: [lift, covered, shelf], boxes: { a: lift, covered } });
  assertInvariants(report);
  const panel = p0(report); const [first, second] = panel.leaders[0].points;
  assert.ok(first[1] === second[1] && first[0] >= panel.lifts[0].rect[0] + panel.lifts[0].rect[2], 'the leader leaves by the right');
  assert.ok(panel.dots[0].slid > 0, `the dot slid ${panel.dots[0].slid}px, off the covered upper part`);
  assert.equal(onFill(panel, panel.dots[0].center), false, 'the dot is not on the fill');
  assert.equal(crossesFill(panel, panel.leaders[0].points), false, 'the path crosses no fill');
  assert.equal(report.warnings.includes('a leader dot sits on page content'), false);
});

test('a lift boxed in by fills on every open side still renders and warns that its dot sits on content', { skip }, async () => {
  const lift = [100, 100, 60, 20]; const right = [164, 84, 60, 60]; const below = [80, 124, 120, 40];
  const report = await board([{ lift: 'a', title: 'Boxed in' }, { redact: 'right' }, { redact: 'below' }], { bars: [lift, right, below], boxes: { a: lift, right, below } });
  assertInvariants(report);
  assert.equal(p0(report).leaders.length, 1);
  assert.ok(report.warnings.includes('a leader dot sits on page content'));
});

const LEADER_CLEAR = 2;
const LEADER_HALF = 0.75;
// The gap between a leader's first segment and a bar, in board px, measured across the segment.
const clearance = (panel, [[x0, y0], [x1]], bar) => {
  const S = panel.capture[2] / panel.frame[2];
  const toBoard = ([bx, by, bw, bh]) => [panel.capture[0] + (bx - panel.frame[0]) * S, panel.capture[1] + (by - panel.frame[1]) * S, bw * S, bh * S];
  const [rx, ry, rw, rh] = toBoard(bar);
  return x0 === x1
    ? Math.max(rx - x0, x0 - (rx + rw), 0) - LEADER_HALF
    : Math.max(ry - y0, y0 - (ry + rh), 0) - LEADER_HALF;
};

test('a slot\'s leader drops through the gap between two words and touches neither', { skip }, async () => {
  const words = Array.from({ length: 7 }, (_, i) => [60 + 39 * i, 130, 30, 12]);
  const slots = [[100, 60, 200, 40], [340, 50, 100, 60]];
  const bars = [...words, [500, 270, 30, 10]];
  const report = await board([{ empty: 'mine', text: 'Nothing rendered here at all' }, { empty: 'wall', text: 'Walled' }, { redact: 'far' }], { bars, boxes: { mine: slots[0], wall: slots[1], far: bars.at(-1) } });
  assertInvariants(report);
  const panel = p0(report);
  const leader = panel.leaders.find((l) => panel.targets[l.target].mark === 0);
  const [first, second] = leader.points;
  assert.equal(first[0], second[0], 'the leader drops straight down');
  assert.ok(second[1] >= panel.capture[1] + panel.capture[3] - 0.5, 'and runs on to the edge of the screenshot');
  for (const word of words) assert.ok(clearance(panel, [first, second], word) >= LEADER_CLEAR - 0.01, `a word lies ${clearance(panel, [first, second], word).toFixed(2)}px from the stroke`);
});

test('a lift whose preferred side crosses a bar at its middle slides to a clear row and strikes nothing', { skip }, async () => {
  const bar = [260, 108, 100, 4];
  const bars = [[100, 100, 60, 20], bar, [60, 160, 140, 120], [560, 260, 30, 20]];
  const report = await board([{ lift: 'a', title: 'Crossed' }, { redact: 'far' }], { bars, boxes: { a: bars[0], far: bars[3] } });
  assertInvariants(report);
  const panel = p0(report);
  const [lift] = panel.lifts; const [first, second] = panel.leaders[0].points;
  assert.ok(first[0] >= lift.rect[0] + lift.rect[2] && first[1] === second[1], 'the leader leaves by the right side');
  const S = panel.capture[2] / panel.frame[2];
  assert.ok(Math.abs(panel.dots[0].slid) <= (4 + 2 * LEADER_CLEAR) * S + 3, `the dot slid ${panel.dots[0].slid}px, no further than the first clear row`);
  const rowGap = clearance(panel, [first, second], bar);
  assert.ok(rowGap >= LEADER_CLEAR - 0.01, `the bar lies ${rowGap.toFixed(2)}px from the stroke`);
});

test('a lift on open ground keeps its dot in the middle of its side', { skip }, async () => {
  const bars = [[100, 100, 60, 20], [560, 260, 30, 20]];
  const report = await board([{ lift: 'a', title: 'Open' }, { redact: 'far' }], { bars, boxes: { a: bars[0], far: bars[1] } });
  assertInvariants(report);
  assert.deepEqual(p0(report).dots.map((d) => d.slid), [0]);
});

// A copy of LIFT_CLEAR in lib/compose/page-geometry.js, kept apart so the check does not read the code it checks.
const LIFT_CLEAR = 3;
const boardOf = (panel, [x, y, w, h]) => {
  const S = panel.capture[2] / panel.frame[2];
  return [panel.capture[0] + (x - panel.frame[0]) * S, panel.capture[1] + (y - panel.frame[1]) * S, w * S, h * S];
};
const liftBox = (lift) => {
  const [x, y, w, h] = lift.source; const [left, top, right, bottom] = lift.pad;
  return [x - left, y - top, w + left + right, h + top + bottom];
};
const overlapArea = (a, b) => Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));

for (const gap of [10, 5]) {
  test(`a lift keeps ${LIFT_CLEAR} capture px of ground between its card and a bar ${gap}px from its element`, { skip }, async () => {
    const element = [200, 100, 40, 12];
    const bar = [200 - gap - 40, 103, 40, 6];
    const report = await board([{ lift: 'a', title: 'Small' }, { redact: 'far' }], { bars: [bar, [560, 260, 30, 20]], boxes: { a: element, far: [560, 260, 30, 20] } });
    assertInvariants(report);
    const panel = p0(report); const [lift] = panel.lifts;
    const S = panel.capture[2] / panel.frame[2];
    const [bx, , bw] = boardOf(panel, bar);
    const ground = lift.rect[0] - (bx + bw);
    assert.ok(ground >= LIFT_CLEAR * S - 0.01, `${(ground / S).toFixed(2)} capture px of ground lie between the card and the bar`);
  });
}

const OVER = [[100, 138, 130, 6], [100, 166, 130, 6]];
const SHORT = [200, 150, 40, 10];

test('an enlarged lift between two rows reaches for the open ground beside them and hides less of the rows than a centred card', { skip }, async () => {
  const report = await board([{ lift: 'a', title: 'Short' }, { redact: 'far' }], { bars: [...OVER, [560, 260, 30, 20]], boxes: { a: SHORT, far: [560, 260, 30, 20] } });
  assertInvariants(report);
  const panel = p0(report); const [lift] = panel.lifts;
  const [x, y, w, h] = boardOf(panel, liftBox(lift));
  const [, , W, H] = lift.rect;
  assert.ok(W > w && H > h, 'the lift is enlarged');
  const centred = [x + w / 2 - W / 2, y + h / 2 - H / 2, W, H];
  const hidden = (card) => OVER.reduce((sum, row) => sum + overlapArea(card, boardOf(panel, row)), 0);
  assert.ok(hidden(lift.rect) < hidden(centred), `the card hides ${hidden(lift.rect).toFixed(0)} board px of the rows, a centred card ${hidden(centred).toFixed(0)}`);
  assert.ok(lift.rect[0] <= x + 0.01 && lift.rect[0] + W >= x + w - 0.01 && lift.rect[1] <= y + 0.01 && lift.rect[1] + H >= y + h - 0.01, 'the card still covers its element');
});

test('an enlarged lift on open ground stays centred on its element', { skip }, async () => {
  const report = await board([{ lift: 'a', title: 'Short' }, { redact: 'far' }], { bars: [[560, 260, 30, 20]], boxes: { a: SHORT, far: [560, 260, 30, 20] } });
  assertInvariants(report);
  const panel = p0(report); const [lift] = panel.lifts;
  const [x, y, w, h] = boardOf(panel, liftBox(lift));
  assert.ok(lift.rect[2] > w, 'the lift is enlarged');
  assert.ok(Math.abs(lift.rect[0] + lift.rect[2] / 2 - (x + w / 2)) <= 1 && Math.abs(lift.rect[1] + lift.rect[3] / 2 - (y + h / 2)) <= 1, 'the card is centred to within a pixel');
});

// A card's 1px outline, as bars.
const outlineOf = ([x, y, w, h]) => [[x, y, w, 1], [x, y + h - 1, w, 1], [x, y, 1, h], [x + w - 1, y, 1, h]];

test('a lift beside a card\'s right border stays centred on its element and its leader leaves by the right', { skip }, async () => {
  // The border is 7 capture px outside the lift's padded box: inside its count margin, and a card hung off it can clear it.
  const element = [562, 134, 4, 4];
  const report = await board([{ lift: 'a', title: 'Version' }], { size: [700, 300], bars: [...outlineOf([20, 20, 558, 260]), element], boxes: { a: element } });
  assertInvariants(report);
  const panel = p0(report); const [lift] = panel.lifts;
  const [x, y, w, h] = boardOf(panel, liftBox(lift));
  assert.ok(Math.abs(lift.rect[0] + lift.rect[2] / 2 - (x + w / 2)) <= 1 && Math.abs(lift.rect[1] + lift.rect[3] / 2 - (y + h / 2)) <= 1, 'the card is centred on its element to within a pixel');
  const [[ax, ay], [bx, by]] = panel.leaders[0].points;
  assert.ok(bx > ax && Math.abs(by - ay) < 1, 'the leader runs right');
});

test('a leader does not run through another mark\'s slot', { skip }, async () => {
  const bars = [[40, 100, 100, 20], [400, 340, 60, 20]];
  const report = await board([{ lift: 'a', title: 'Lift' }, { empty: 'e', text: 'Nothing here' }, { lift: 'z', title: 'Far' }], { size: [600, 400], bars, boxes: { a: bars[0], e: [300, 90, 80, 40], z: bars[1] } });
  assertInvariants(report);
  assert.equal(report.warnings.includes('a leader crosses another lift'), false);
});

test('a leader does not run through another mark\'s loupe ring', { skip }, async () => {
  const bars = [[40, 100, 100, 20], [400, 340, 60, 20]];
  const report = await board([{ lift: 'a', title: 'Lift' }, { loupe: 'tiny' }, { lift: 'z', title: 'Far' }], { size: [600, 400], bars, boxes: { a: bars[0], tiny: [300, 105, 10, 10], z: bars[1] } });
  assertInvariants(report);
  assert.equal(report.warnings.includes('a leader crosses another lift'), false);
});

const multi = (layout, panels, title = 'Board') => ({ state: 'FLOW', title, layout, out: 'o.png', panels: panels.map((marks, i) => ({ label: `Panel ${i + 1}`, capture: `c${i}.json`, marks })) });

test('a pair draws two captures of very different sizes at one height', { skip }, async () => {
  const big = await syntheticCapture({ size: [1800, 900], bars: [[300, 300, 600, 60]], boxes: { a: [300, 300, 600, 60] } });
  const small = await syntheticCapture({ size: [600, 300], bars: [[100, 100, 200, 20]], boxes: { a: [100, 100, 200, 20] } });
  const { report, pixels, dir } = await render(multi('pair', [[], [{ lift: 'a', title: 'After' }]]), [big, small]);
  try {
    assertInvariants(report);
    assert.equal(report.panels.length, 2);
    assert.equal(report.panels[0].capture[3], report.panels[1].capture[3]);
    assert.equal(report.arrows.length, 0);
    assert.equal(pixels.width, Math.round(report.stage[2] * 2));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a strip beside a card shares the floor height and the board says the shapes clash', { skip }, async () => {
  const strip = await syntheticCapture({ size: [1500, 75], bars: [[40, 30, 200, 14]], boxes: { a: [40, 30, 200, 14] } });
  const card = await syntheticCapture({ size: [450, 300], bars: [[40, 40, 200, 20]], boxes: { a: [40, 40, 200, 20] } });
  const { report, pixels, dir } = await render(multi('pair', [[], []]), [strip, card]);
  try {
    assertInvariants(report);
    assert.equal(report.panels[0].capture[3], 96);
    assert.ok(report.warnings.includes('the panels differ too much in shape to share a height well'));
    assert.equal(pixels.width, Math.round(report.stage[2] * 2), 'the whole board is in the PNG');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const SMALL_PANEL = 'a panel is drawn small; frame the card that holds its marks';

// Marks in two corners of a large frame leave a region that is nearly the whole frame, drawn small.
const CORNERS = [[20, 20, 200, 40], [1280, 940, 200, 40]];
const cornerMarks = [{ lift: 'a', title: 'Value' }, { lift: 'b', title: 'Other' }];
const cornerCapture = () => syntheticCapture({ size: [1500, 1000], bars: CORNERS, boxes: { a: CORNERS[0], b: CORNERS[1] } });

test('a pair of large frames warns once that a panel is drawn small', { skip }, async () => {
  const a = await cornerCapture();
  const b = await syntheticCapture({ size: [1500, 1000], bars: [], boxes: {} });
  const { report, dir } = await render(multi('pair', [cornerMarks, []]), [a, b]);
  try {
    assertInvariants(report);
    assert.equal(report.warnings.filter((w) => w === SMALL_PANEL).length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a steps board of large frames with small marks crops them and does not warn that a panel is drawn small', { skip }, async () => {
  const a = await syntheticCapture({ size: [1500, 1000], bars: [[300, 300, 400, 40]], boxes: { a: [300, 300, 400, 40] } });
  const b = await syntheticCapture({ size: [1500, 1000], bars: [[300, 300, 400, 40]], boxes: { a: [300, 300, 400, 40] } });
  const { report, dir } = await render(multi('steps', [[{ lift: 'a', title: 'Value' }], [{ lift: 'a', title: 'Value' }]]), [a, b]);
  try {
    assertInvariants(report);
    assert.deepEqual(report.panels.map((p) => p.cropped), [true, true]);
    assert.equal(report.warnings.includes(SMALL_PANEL), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a pair of card-sized frames does not warn that a panel is drawn small', { skip }, async () => {
  const a = await syntheticCapture({ size: [600, 240], bars: [[100, 100, 200, 20]], boxes: { a: [100, 100, 200, 20] } });
  const b = await syntheticCapture({ size: [600, 240], bars: [], boxes: {} });
  const { report, dir } = await render(multi('pair', [[{ lift: 'a', title: 'Value' }], []]), [a, b]);
  try {
    assertInvariants(report);
    assert.equal(report.warnings.includes(SMALL_PANEL), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a single board of a large capture does not warn that a panel is drawn small', { skip }, async () => {
  const report = await board([{ lift: 'a', title: 'Value' }], { size: [1500, 1000], bars: [[300, 300, 400, 40]], boxes: { a: [300, 300, 400, 40] } });
  assertInvariants(report);
  assert.equal(report.warnings.includes(SMALL_PANEL), false);
});

test('a steps board of three large frames warns once that a panel is drawn small', { skip }, async () => {
  const captures = [];
  for (let i = 0; i < 3; i += 1) captures.push(await cornerCapture());
  const { report, dir } = await render(multi('steps', captures.map(() => cornerMarks)), captures);
  try {
    assertInvariants(report);
    assert.equal(report.warnings.filter((w) => w === SMALL_PANEL).length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('four labelled steps render whole, even wider than the renderer viewport', { skip }, async () => {
  const captures = [];
  // A lift that fills most of a squarish frame keeps the frame uncropped and its label on the right, the widest arrangement.
  for (let i = 0; i < 4; i += 1) captures.push(await syntheticCapture({ size: [400, 300], bars: [[40, 40, 300, 200]], boxes: { a: [40, 40, 300, 200] } }));
  const long = 'A label title long enough to take its full width';
  const { report, pixels, dir } = await render(multi('steps', captures.map(() => [{ lift: 'a', title: long, note: long }])), captures);
  try {
    assertInvariants(report);
    assert.ok(report.stage[2] > 2400, 'the board is wider than the renderer viewport');
    assert.equal(report.arrows.length, 3);
    assert.deepEqual(report.panels.map((p) => p.head.number), [1, 2, 3, 4]);
    assert.equal(pixels.width, Math.round(report.stage[2] * 2), 'no panel was clipped by the viewport');
    assert.equal(pixels.height, Math.round(report.stage[3] * 2));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a single board with a panel label draws a head and nothing else changes', { skip }, async () => {
  const marks = [{ lift: 'a', title: 'First' }];
  const one = (panel) => ({ state: 'AFTER', title: 'Board', layout: 'single', out: 'o.png', panels: [{ capture: 'c.json', marks, ...panel }] });
  const capture = await syntheticCapture();
  const labelled = await render(one({ label: 'AFTER' }), capture);
  const plain = await render(one({}), capture);
  try {
    assertInvariants(labelled.report);
    const [a, b] = [p0(labelled.report), p0(plain.report)];
    assert.ok(a.head);
    assert.equal(a.head.number, null);
    assert.equal(b.head, null);
    assert.deepEqual(a.capture.slice(2), b.capture.slice(2));
    assert.equal(a.lifts.length, b.lifts.length);
    assert.equal(a.labels.length, b.labels.length);
    assert.deepEqual(labelled.report.warnings, plain.report.warnings);
  } finally {
    await rm(labelled.dir, { recursive: true, force: true });
    await rm(plain.dir, { recursive: true, force: true });
  }
});

const FLOOR = [320, 200];

// Two captures of one page, each with one small mark in a different place; the second frame is smaller and offset.
async function samePageCaptures() {
  const marks = [[400, 300, 60, 20], [520, 340, 60, 20]];
  const first = await syntheticCapture({ size: [1200, 800], bars: [marks[0]], boxes: { a: marks[0] } });
  const second = await syntheticCapture({ size: [1200, 800], bars: [marks[1]], boxes: { a: marks[1] } });
  return { captures: [first, { ...second, frame: [10, 5, 1190, 790] }], marks };
}

const shownBy = (panel) => panel.frame.map((v, i) => (i < 2 ? v - panel.cleanFrame[i] : v));
const containsBox = (frame, box) => box[0] >= frame[0] && box[1] >= frame[1] && box[0] + box[2] <= frame[0] + frame[2] && box[1] + box[3] <= frame[1] + frame[3];

// A pair shows each frame whole, trimmed of blank ground: the shown frame is the cleaned frame less what the trim took.
const shownWhole = (panel) => {
  const [cx, cy, cw, ch] = panel.cleanFrame; const { left, top, right, bottom } = panel.trimmed;
  assert.equal(panel.cropped, false);
  assert.equal(panel.cropEdges, undefined);
  assert.deepEqual(panel.frame, [cx + left, cy + top, cw - left - right, ch - top - bottom], 'the frame is the cleaned frame less the trim');
};

test('a pair shows each frame whole, whatever its marks', { skip }, async () => {
  const { captures, marks } = await samePageCaptures();
  const { report, dir } = await render(multi('pair', [[{ lift: 'a', title: 'First' }], [{ lift: 'a', title: 'Second' }]]), captures);
  await rm(dir, { recursive: true, force: true });
  assertInvariants(report);
  const [a, b] = report.panels;
  shownWhole(a); shownWhole(b);
  assert.ok(containsBox(a.cleanFrame, a.frame) && containsBox(b.cleanFrame, b.frame));
  assert.ok(containsBox(a.frame, marks[0]) && containsBox(b.frame, marks[1]));
  assert.deepEqual(a.capture[3], b.capture[3], 'and the panels draw at one height');
});

test('the same two captures as steps are each cropped on their own, to at least the context floor', { skip }, async () => {
  const { captures, marks } = await samePageCaptures();
  const { report, dir } = await render(multi('steps', [[{ lift: 'a', title: 'First' }], [{ lift: 'a', title: 'Second' }]]), captures);
  await rm(dir, { recursive: true, force: true });
  assertInvariants(report);
  const [a, b] = report.panels;
  assert.deepEqual([a.cropped, b.cropped], [true, true]);
  for (const panel of [a, b]) assert.ok(panel.frame[2] >= FLOOR[0] && panel.frame[3] >= FLOOR[1], `a crop of ${panel.frame.slice(2)} is under the floor`);
  assert.notDeepEqual(shownBy(a), shownBy(b), 'each crop follows its own mark');
  assert.ok(containsBox(a.frame, marks[0]) && containsBox(b.frame, marks[1]));
  assert.deepEqual(a.capture.slice(2), b.capture.slice(2), 'the panels still draw at one height');
});

test('a pair of an imported capture and a live one shows each frame whole, the imported one inside the frame its spec gives', { skip }, async () => {
  const given = [100, 100, 1200, 800];
  const mark = [700, 500, 60, 20];
  const ticket = { ...(await syntheticCapture({ size: [1600, 1000], bars: [mark], boxes: { a: mark } })), frame: given, source: 'import' };
  const live = await syntheticCapture({ size: [900, 500], bars: [[300, 200, 60, 20]], boxes: { a: [300, 200, 60, 20] } });
  const { report, dir } = await render(multi('pair', [[{ lift: 'a', title: 'Ticket' }], [{ lift: 'a', title: 'Live' }]]), [ticket, live]);
  await rm(dir, { recursive: true, force: true });
  assertInvariants(report);
  const [imported, shown] = report.panels;
  shownWhole(imported); shownWhole(shown);
  assert.ok(containsBox(given, imported.frame), `the imported panel shows ${imported.frame}, outside the frame ${given} its spec gives`);
  assert.ok(containsBox(imported.frame, mark) && containsBox(shown.frame, [300, 200, 60, 20]));
});

test('a single board with a link crops to both ends of the link, like any other panel', { skip }, async () => {
  const bars = [[400, 300, 60, 20], [700, 500, 60, 20]];
  const report = await board([{ link: ['a', 'b'], title: 'Same fact, two places' }], { size: [1200, 800], bars, boxes: { a: bars[0], b: bars[1] } });
  assertInvariants(report);
  assert.equal(p0(report).cropped, true);
  assert.ok(containsBox(p0(report).frame, bars[0]) && containsBox(p0(report).frame, bars[1]), 'both ends of the link are inside the crop');
  assert.ok(p0(report).frame[2] < FLOOR[0] + 300, 'and the single board is not held to the floor');
});

test('a pair with a link panel shows both frames whole', { skip }, async () => {
  const bars = [[400, 300, 60, 20], [700, 500, 60, 20]];
  const first = await syntheticCapture({ size: [1200, 800], bars, boxes: { a: bars[0], b: bars[1] } });
  const second = await syntheticCapture({ size: [1200, 800], bars: [bars[0]], boxes: { a: bars[0] } });
  const { report, dir } = await render(multi('pair', [[{ link: ['a', 'b'], title: 'Linked' }], [{ lift: 'a', title: 'Lifted' }]]), [first, second]);
  await rm(dir, { recursive: true, force: true });
  assertInvariants(report);
  report.panels.forEach(shownWhole);
});

test('a steps lift whose second solve merges grows only inside the crop it was cropped to', { skip }, async () => {
  const a = [400, 300, 30, 60]; const b = [447, 366, 30, 60];
  const bars = [a, b, [452, 220, 20, 140], ...Array.from({ length: 30 }, (_, i) => [250, 60 + 11 * i, 30, 8])];
  const first = await syntheticCapture({ size: [1000, 700], bars, boxes: { a, b } });
  const lone = [400, 300, 60, 20];
  const others = [];
  for (let i = 0; i < 3; i += 1) others.push(await syntheticCapture({ size: [1000, 700], bars: [lone], boxes: { a: lone } }));
  const marks = [[{ lift: ['a', 'b'], title: 'Pair' }], ...others.map(() => [{ lift: 'a', title: 'Lone' }])];
  const { report, dir } = await render(multi('steps', marks), [first, ...others]);
  await rm(dir, { recursive: true, force: true });
  assertInvariants(report);
  assert.equal(p0(report).lifts.length, 1, 'the two lifts of the first panel merged');
});

// A grid of 11px squares every 16px: no clean line crosses it and no gap is a band.
const denseBars = (size) => Array.from({ length: Math.ceil(size[0] / 16) * Math.ceil(size[1] / 16) }, (_, n) => [(n % Math.ceil(size[0] / 16)) * 16, Math.floor(n / Math.ceil(size[0] / 16)) * 16, 11, 11]);

test('a steps board crops a dense page to its margins and says the edges cut through content', { skip }, async () => {
  const mark = [400, 304, 64, 16];
  const dense = await syntheticCapture({ size: [900, 600], bars: denseBars([900, 600]), boxes: { a: mark } });
  const open = await syntheticCapture({ size: [900, 600], bars: [mark], boxes: { a: mark } });
  const { report, dir } = await render(multi('steps', [[{ lift: 'a', title: 'Dense' }], [{ lift: 'a', title: 'Open' }]]), [dense, open]);
  await rm(dir, { recursive: true, force: true });
  assertInvariants(report);
  const [a, b] = report.panels;
  assert.deepEqual([a.cropped, b.cropped], [true, true]);
  assert.ok(a.frame[2] <= FLOOR[0] + 2 * 80 && a.frame[3] <= FLOOR[1] + 2 * 80, `the dense crop of ${a.frame.slice(2)} swelled past the floor and the snap reach`);
  assert.ok(Object.values(a.cropEdges).includes('margin'), 'an unsnapped edge is named margin');
  assert.ok(report.warnings.includes('a crop edge cuts through content'));
  assert.equal(report.warnings.includes('a frame edge cuts through content'), false, 'a held crop edge is not a frame edge');
});

test('the same dense page on a single board still sends an unsnapped edge to the frame', { skip }, async () => {
  const mark = [400, 304, 64, 16];
  const dense = await syntheticCapture({ size: [900, 600], bars: denseBars([900, 600]), boxes: { a: mark } });
  const { report, dir } = await render(spec([{ lift: 'a', title: 'Dense' }]), dense);
  await rm(dir, { recursive: true, force: true });
  assertInvariants(report);
  assert.equal(p0(report).cropped, false, 'the crop covers half the page, so the board shows the frame');
  assert.equal(p0(report).cropEdges, undefined);
});

test('a pair whose frames cleaning moved differently still shows each whole', { skip }, async () => {
  const mark = [500, 400, 60, 20];
  // A bar across the top edge of the first capture's frame moves that edge when the frame is cleaned.
  const first = await syntheticCapture({ size: [1200, 800], bars: [mark, [100, 60, 900, 14]], boxes: { a: mark } });
  const second = await syntheticCapture({ size: [1200, 800], bars: [], boxes: {} });
  const frame = [100, 70, 1000, 700];
  const { report, dir } = await render(multi('pair', [[{ lift: 'a', title: 'First' }], []]), [{ ...first, frame }, { ...second, frame }]);
  await rm(dir, { recursive: true, force: true });
  assertInvariants(report);
  const [a, b] = report.panels;
  assert.notDeepEqual(a.cleanFrame, b.cleanFrame, 'cleaning moved the two frames differently');
  shownWhole(a); shownWhole(b);
});

// A card of the capture's own colour drawn as a 2px outline.
const outline = ([x, y, w, h]) => [[x, y, w, 2], [x, y + h - 2, w, 2], [x, y, 2, h], [x + w - 2, y, 2, h]];

test('a pair of frames of one size trims both panels by the same amounts, so they show one region', { skip }, async () => {
  const cards = [[20, 20, 560, 260], [50, 30, 500, 240]];
  const big = [[60, 50, 480, 200], [90, 60, 420, 180]];
  const captures = [];
  for (const [i, card] of cards.entries()) captures.push(await syntheticCapture({ bars: [...outline(card), big[i]], boxes: { a: big[i] } }));
  const { report, dir } = await render(multi('pair', [[{ lift: 'a', title: 'First' }], [{ lift: 'a', title: 'Second' }]]), captures);
  await rm(dir, { recursive: true, force: true });
  assertInvariants(report);
  const [a, b] = report.panels;
  assert.deepEqual([a.cropped, b.cropped], [false, false]);
  assert.deepEqual(a.trimmed, { left: 18, top: 18, right: 18, bottom: 18 }, 'the smaller of the two trims on each side');
  assert.deepEqual(b.trimmed, a.trimmed);
  assert.deepEqual(a.frame, [18, 18, 564, 264]);
  assert.deepEqual(b.frame, a.frame);
  assert.deepEqual(a.cleanFrame, [0, 0, 600, 300], 'the cleaned frame is reported as it was');
});

test('a pair of frames of different sizes trims each panel on its own', { skip }, async () => {
  const cards = [[20, 20, 560, 260], [50, 30, 500, 240]];
  const big = [[60, 50, 480, 200], [90, 60, 420, 180]];
  const first = await syntheticCapture({ bars: [...outline(cards[0]), big[0]], boxes: { a: big[0] } });
  const second = await syntheticCapture({ size: [580, 300], bars: [...outline(cards[1]), big[1]], boxes: { a: big[1] } });
  const { report, dir } = await render(multi('pair', [[{ lift: 'a', title: 'First' }], [{ lift: 'a', title: 'Second' }]]), [first, second]);
  await rm(dir, { recursive: true, force: true });
  assertInvariants(report);
  const [a, b] = report.panels;
  assert.deepEqual([a.trimmed.left, b.trimmed.left], [18, 48]);
  assert.deepEqual([a.trimmed.top, b.trimmed.top], [18, 28]);
});

// A heading and rows on a page with no border: nothing marks where the region ends.
const borderless = (rowCount, lastWidth) => {
  const rows = Array.from({ length: rowCount }, (_, i) => [40, 70 + 28 * i, i === rowCount - 1 ? lastWidth : 260, 12]);
  return { bars: [[40, 30, 200, 16], ...rows], boxes: { a: rows[2] } };
};

test('a pair of one region with no border shows one region at one size, whatever each state holds', { skip }, async () => {
  const frame = [20, 10, 560, 280];
  const before = await syntheticCapture(borderless(3, 260));
  const after = await syntheticCapture(borderless(6, 420));
  const { report, dir } = await render(multi('pair', [[{ lift: 'a', title: 'Before' }], [{ lift: 'a', title: 'After' }]]), [{ ...before, frame }, { ...after, frame }]);
  await rm(dir, { recursive: true, force: true });
  assertInvariants(report);
  const [a, b] = report.panels;
  assert.deepEqual(a.frame, b.frame, 'both panels show one rectangle of the page');
  assert.deepEqual(a.capture.slice(2), b.capture.slice(2), 'at one size');
  assert.equal(report.warnings.includes('a lift was scaled down to fit the frame'), false);
});

test('a single board does not trim a frame that carries blank ground', { skip }, async () => {
  const card = [20, 20, 560, 260];
  const report = await board([{ lift: 'a', title: 'First' }], { bars: [...outline(card), [60, 50, 480, 200]], boxes: { a: [60, 50, 480, 200] } });
  assertInvariants(report);
  assert.deepEqual(p0(report).trimmed, { left: 0, top: 0, right: 0, bottom: 0 });
  assert.deepEqual(p0(report).frame, [0, 0, 600, 300]);
});

test('a single board is not held to the context floor, so a small mark crops to its margins', { skip }, async () => {
  const capture = await syntheticCapture({ size: [1200, 800], bars: [[400, 300, 60, 20]], boxes: { a: [400, 300, 60, 20] } });
  const { report, dir } = await render(spec([{ lift: 'a', title: 'First' }]), capture);
  try {
    assertInvariants(report);
    assert.equal(p0(report).cropped, true);
    assert.ok(p0(report).frame[2] < FLOOR[0], `a single board's crop of ${p0(report).frame.slice(2)} is as wide as the floor`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the same capture and mark as a single board is still cropped to the mark', { skip }, async () => {
  const capture = await syntheticCapture({ size: [600, 300], bars: [[100, 100, 60, 20]], boxes: { a: [100, 100, 60, 20] } });
  const { report, dir } = await render(spec([{ lift: 'a', title: 'First' }]), capture);
  try {
    assertInvariants(report);
    assert.equal(p0(report).cropped, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// A real 2x2 GIF with two frames, the first all red and the second all blue.
const TWO_FRAME_GIF = Buffer.from('47494638396102000200810000ff000000000000000000000021ff0b4e45545343415045322e30030100000021f904040a00'
  + '00002c00000000020002000008060001080410100021f904050a0001002c0000000002000200810000ff0000000000000000000806000108041010003b', 'hex');

async function encoded(mime) {
  const { chromium } = await import(renderer.playwrightCore);
  const browser = await chromium.launch({ headless: true, executablePath: renderer.executablePath });
  try {
    const page = await browser.newPage();
    const uri = await page.evaluate((type) => {
      const canvas = document.createElement('canvas'); canvas.width = 40; canvas.height = 20;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#16a34a'; ctx.fillRect(0, 0, 40, 20);
      return canvas.toDataURL(type, 0.95);
    }, mime);
    return Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64');
  } finally { await browser.close(); }
}

for (const mime of ['image/png', 'image/jpeg', 'image/webp']) {
  test(`the renderer converts ${mime} to a PNG of the same size`, { skip }, async () => {
    const png = await rasterizeImage({ bytes: await encoded(mime), mime, ...renderer });
    assert.deepEqual(readPngSize(png), { width: 40, height: 20 });
    const green = await countOffColor({ png, rect: [4, 4, 32, 12], color: [22, 163, 74], tolerance: 40, renderer });
    assert.equal(green.off, 0);
  });
}

test('a GIF imports as its first frame', { skip }, async () => {
  const png = await rasterizeImage({ bytes: TWO_FRAME_GIF, mime: 'image/gif', ...renderer });
  assert.deepEqual(readPngSize(png), { width: 2, height: 2 });
  const red = await countOffColor({ png, rect: [0, 0, 2, 2], color: [255, 0, 0], tolerance: 40, renderer });
  assert.equal(red.off, 0, 'the first frame is red');
});

test('a JPEG cut off in its header is refused, not half-drawn', { skip }, async () => {
  const bytes = (await encoded('image/jpeg')).subarray(0, 40);
  await assert.rejects(() => rasterizeImage({ bytes, mime: 'image/jpeg', ...renderer }));
});

test('a decode that outlasts its time limit is refused as a decode timeout', { skip }, async () => {
  const bytes = await encoded('image/png');
  await assert.rejects(() => rasterizeImage({ bytes, mime: 'image/png', ...renderer, timeoutMs: 1 }),
    (error) => error.name === 'ImageDecodeTimeoutError');
});

test('an image wider than the side limit is refused with a named error', { skip }, async () => {
  const { chromium } = await import(renderer.playwrightCore);
  const browser = await chromium.launch({ headless: true, executablePath: renderer.executablePath });
  let bytes;
  try {
    const page = await browser.newPage();
    const uri = await page.evaluate((width) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = 1;
      return canvas.toDataURL('image/png');
    }, IMPORT_MAX_SIDE + 1);
    bytes = Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64');
  } finally { await browser.close(); }
  await assert.rejects(() => rasterizeImage({ bytes, mime: 'image/png', ...renderer }),
    (error) => error.name === 'ImageTooLargeError');
});

test('an inspection redaction is padded by 12 image pixels, a measured one by 2', { skip }, async () => {
  const bars = [[200, 120, 80, 20]];
  const capture = await syntheticCapture({ bars, boxes: { a: bars[0] } });
  const live = await board([{ redact: 'a' }], { bars, boxes: { a: bars[0] } });
  const { report, dir } = await render(spec([{ redact: 'a' }]), { ...capture, source: 'import' });
  await rm(dir, { recursive: true, force: true });
  const scale = p0(report).capture[2] / p0(report).frame[2];
  assert.ok(Math.abs(p0(report).redactions[0].rect[2] - (80 + 24) * scale) < 1);
  assert.ok(Math.abs(p0(live).redactions[0].rect[2] - (80 + 4) * (p0(live).capture[2] / p0(live).frame[2])) < 1);
  assert.equal(p0(report).source, 'import');
  assert.equal(p0(report).head.origin, true);
});

test('a redaction pad that runs past the image is clipped and still hides its box', { skip }, async () => {
  const bars = [[0, 0, 60, 20]];
  const capture = await syntheticCapture({ bars, boxes: { a: bars[0] } });
  const { report, outPath, dir } = await render(spec([{ redact: 'a' }]), { ...capture, source: 'import' });
  try {
    const [x, y, w, h] = p0(report).redactions[0].rect;
    assert.ok(Math.abs(x - p0(report).capture[0]) < 0.5 && Math.abs(y - p0(report).capture[1]) < 0.5, 'the fill starts at the screenshot corner');
    const scale = (await readFile(outPath)).readUInt32BE(16) / report.stage[2];
    const inner = [x + 4, y + 4, w - 8, h - 8].map((v) => Math.round(v * scale));
    const off = await countOffColor({ png: await readFile(outPath), rect: inner, color: [0xCB, 0xD5, 0xE1], tolerance: 24, renderer });
    assert.equal(off.off, 0, 'nothing but fill where the box was');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a redaction in the image corner still gets a crop, clipped by the image and the stage', { skip }, async () => {
  const bars = [[0, 0, 60, 20]];
  const capture = await syntheticCapture({ bars, boxes: { a: bars[0] } });
  const { report, crops, outPath, dir } = await render(spec([{ redact: 'a' }]), { ...capture, source: 'import' });
  try {
    assert.equal(report.gated, true);
    assert.equal(report.crops.length, 1);
    const [x, y, w, h] = report.crops[0].rect;
    const [fx, fy, fw, fh] = p0(report).redactions[0].rect;
    assert.ok(w > 0 && h > 0 && x >= 0 && y >= 0 && x + w <= report.stage[2] && y + h <= report.stage[3], 'the crop lies inside the stage');
    assert.ok(x <= fx && y <= fy && x + w >= fx + fw && y + h >= fy + fh, 'and holds the whole fill');
    assert.ok(fx - x >= 23 && fy - y >= 23 && (x + w) - (fx + fw) >= 23 && (y + h) - (fy + fh) >= 23, 'with a margin of context past it');
    const scale = (await readFile(outPath)).readUInt32BE(16) / report.stage[2];
    assert.equal(crops.length, 1);
    assert.deepEqual([crops[0].readUInt32BE(16), crops[0].readUInt32BE(20)], [Math.round(w * scale), Math.round(h * scale)], 'the crop is at the board\'s device scale');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an imported panel never shows what lies outside the frame it was given', { skip }, async () => {
  const bars = [[440, 100, 60, 100]];
  const capture = await syntheticCapture({ bars, boxes: { a: bars[0] }, tints: [[503, 100, 40, 100, '#dc2626']] });
  const { report, outPath, dir } = await render(spec([]), { ...capture, frame: [100, 50, 400, 250], source: 'import' });
  try {
    const png = await readFile(outPath);
    const red = await countOffColor({ png, rect: [0, 0, png.readUInt32BE(16), png.readUInt32BE(20)], color: [220, 38, 38], tolerance: 90, renderer });
    assert.equal(red.total - red.off, 0, 'the board shows page that the frame left out');
    assert.deepEqual(p0(report).frame, [100, 50, 400, 250], 'the frame stayed as given');
    assert.ok(report.warnings.includes('a frame edge cuts through content'), 'the held edge is reported for the driver to move');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a board with no imported redaction is not gated and cuts no crops', { skip }, async () => {
  const live = await render(spec([{ redact: 'a' }]), await syntheticCapture());
  const imported = await render(spec([{ lift: 'a', title: 'Only a lift' }]), { ...(await syntheticCapture()), source: 'import' });
  try {
    assert.deepEqual([live.report.gated, live.report.crops, live.crops], [false, [], []]);
    assert.deepEqual([imported.report.gated, imported.report.crops, imported.crops], [false, [], []]);
  } finally { await rm(live.dir, { recursive: true, force: true }); await rm(imported.dir, { recursive: true, force: true }); }
});

test('an imported panel takes its wash from its own pixels', { skip }, async () => {
  const dark = await syntheticCapture({ dark: true });
  const { report, dir } = await render(spec([{ lift: 'a', title: 'Dark' }]), { ...dark, dark: false, source: 'import' });
  await rm(dir, { recursive: true, force: true });
  assert.equal(p0(report).dark, true, 'the sidecar says nothing about dark; the pixels do');
});

// A report panel built by hand, so a capture-pixel number in the invariants helper is tested without a render.
// Sources and padding are in the panel's capture pixels; rects are board pixels.
const reportPanel = (scale, { frame, lifts }) => ({
  scale, capture: [0, 0, 400, 200], frame: frame.map((n) => n * scale), labels: [], redactions: [], dots: [], leaders: [], connectors: [], targets: [],
  lifts: lifts.map(({ rect, source, pad = [0, 0, 0, 0] }) => ({ rect, source: source.map((n) => n * scale), pad: pad.map((n) => n * scale) })),
});
const apartBy = (gap) => ({
  frame: [0, 0, 400, 200],
  lifts: [{ rect: [100, 40, 80, 40], source: [100, 40, 50, 20] }, { rect: [150, 50, 80, 40], source: [150 + gap, 40, 50, 20] }],
});

for (const scale of [1, 2]) {
  test(`the invariants forgive overlapping lifts whose sources are 6 CSS px apart, at ${scale}x`, () => {
    assertPanel(reportPanel(scale, apartBy(6)), [0, 0, 600, 400]);
  });

  test(`the invariants catch overlapping lifts whose sources are 12 CSS px apart, at ${scale}x`, () => {
    assert.throws(() => assertPanel(reportPanel(scale, apartBy(12)), [0, 0, 600, 400]), /two lifts of separate content overlap/);
  });

  test(`a lift may draw 0.4 CSS px past the shown region and not 0.75, at ${scale}x`, () => {
    const lift = (left) => ({ frame: [10, 0, 380, 200], lifts: [{ rect: [100, 40, 80, 40], source: [10, 40, 50, 20], pad: [left, 0, 0, 0] }] });
    assertPanel(reportPanel(scale, lift(0.4)), [0, 0, 600, 400]);
    assert.throws(() => assertPanel(reportPanel(scale, lift(0.75)), [0, 0, 600, 400]), /capture pixels outside the panel's shown region/);
  });
}

// A pair of one region captured at two device scales shares its trim in CSS pixels.
const cardCapture = (card, inner, scale) => syntheticCapture({ scale, bars: [...outline(card), inner], boxes: { a: inner } });
const pairOf = async (captures) => {
  const { report, dir } = await render(multi('pair', [[{ lift: 'a', title: 'First' }], [{ lift: 'a', title: 'Second' }]]), captures);
  await rm(dir, { recursive: true, force: true });
  assertInvariants(report);
  return report;
};
const trimmedCss = (panel) => Object.fromEntries(Object.entries(panel.trimmed).map(([side, n]) => [side, n / panel.scale]));

test('a pair of one size captured at 1x and 2x trims both by the smaller trim in CSS pixels, as at 1x', { skip }, async () => {
  const cards = [[30, 24, 540, 252], [20, 40, 560, 230]];
  const inner = [[60, 50, 480, 200], [60, 70, 480, 170]];
  const mixed = await pairOf([await cardCapture(cards[0], inner[0], 1), await cardCapture(cards[1], inner[1], 2)]);
  const flat = await pairOf([await cardCapture(cards[0], inner[0], 1), await cardCapture(cards[1], inner[1], 1)]);
  assert.deepEqual(mixed.panels.map((p) => p.scale), [1, 2]);
  const smaller = { left: 18, top: 22, right: 18, bottom: 22 };
  assert.deepEqual(trimmedCss(mixed.panels[0]), smaller, 'the 1x panel takes the smaller of the two trims');
  assert.deepEqual(trimmedCss(mixed.panels[1]), smaller, 'and so does the 2x panel');
  assert.deepEqual(flat.panels.map(trimmedCss), [smaller, smaller], 'which is what the 1x board gives');
  assert.deepEqual(mixed.panels.map((p) => p.frame.map((n) => n / p.scale)), flat.panels.map((p) => p.frame), 'so both show one region');
});

// An image of 2x the pixels whose blank ground is an odd number of device pixels, which no CSS length at 2x gives.
const edges = ([x, y, w, h]) => [[x, y, w, 4], [x, y + h - 4, w, 4], [x, y, 4, h], [x + w - 4, y, 4, h]];

test('a shared trim of half a CSS pixel is rounded down in the 1x panel and exact in the 2x one', { skip }, async () => {
  const first = await cardCapture([30, 24, 540, 252], [60, 50, 480, 200], 1);
  const inner = [120, 140, 960, 340];
  const image = await syntheticCapture({ size: [1200, 600], bars: [...edges([41, 80, 1118, 460]), inner], boxes: { a: inner } });
  const report = await pairOf([first, { ...image, scale: 2 }]);
  const [a, b] = report.panels;
  assert.deepEqual(a.trimmed, { left: 18, top: 22, right: 18, bottom: 22 }, 'the 1x panel takes the floor of 18.5, and no more than its own blank ground');
  assert.deepEqual(b.trimmed, { left: 37, top: 44, right: 37, bottom: 44 }, 'the 2x panel takes 18.5 CSS pixels exactly');
  assert.ok(a.trimmed.left <= 28 && b.trimmed.left <= 37, 'neither trims past its own blank ground');
});

// The bar runs 140px past the lift box, so at the 96px grow limit of an imported capture the lift cannot reach clean ground and stays put.
test('an imported panel with a lift lays out the same beside a 1x and a 2x live panel', { skip }, async () => {
  const bar = [60, 40, 220, 20]; const box = [40, 30, 100, 40];
  const ticket = { ...(await syntheticCapture({ size: [600, 300], bars: [bar], boxes: { a: box } })), source: 'import' };
  const liveBars = [[300, 200, 60, 20]];
  const boardAt = async (scale) => pairOf([ticket, await syntheticCapture({ size: [900, 500], bars: liveBars, boxes: { a: liveBars[0] }, scale })]);
  const [one, two] = [await boardAt(1), await boardAt(2)];
  assert.deepEqual(two.panels.map((p) => p.scale), [1, 2]);
  const [a, b] = [one.panels[0].lifts[0], two.panels[0].lifts[0]];
  assert.deepEqual(a.grown, [0, 0, 0, 0], 'the imported lift is held to the limit of its own scale');
  for (const key of ['source', 'grown', 'pad', 'rect']) assert.deepEqual(b[key], a[key], `the imported lift's ${key}`);
});
