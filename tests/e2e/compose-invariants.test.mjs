import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { rendererLaunches } from '../../lib/compose/renderer.mjs';
import { IMPORT_MAX_SIDE, rasterizeImage, renderBoard } from '../../lib/compose/engine.mjs';
import { readPngSize } from '../../lib/annotate/png.mjs';
import { buildBoardHtml, REDACT_FILL } from '../../lib/compose/page.mjs';
import { assertInvariants, assertPanel, assertPanelSizes, inside, intersects, rectDistance, segmentHitsRect } from './helpers/invariants.mjs';
import { countOffColor } from './helpers/png-diff.mjs';
import { readPixels } from './helpers/png-pixels.mjs';
import { rendererForTests } from './helpers/renderer.mjs';
import { assertSameLayout } from './helpers/same-layout.mjs';

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

// Content in two corners of the default 600 by 300 capture keeps the whole of it in the frame: a scene written
// for one frame size reads the same once every layout trims blank ground. A px in from the edge, so no frame edge cuts it,
// and longer than ORPHAN (16 px), so no edge comes off it as a lone small item.
const CORNERS_600 = [[1, 1, 20, 4], [579, 295, 20, 4]];
// The same at 700 wide: a frame at least 640 CSS px wide is drawn at 1x or less, which the lift-room tests assume.
// A ghost mark far out to the right keeps a cropped frame at least 640 CSS px wide, so it is drawn at 1x or less.
const holdOf = ([w]) => [w - 40, 10, 30, 14];
const CORNERS_700 = [[1, 1, 20, 4], [679, 295, 20, 4]];

const spec = (marks, title = 'Board') => ({ state: 'AFTER', title, layout: 'single', out: 'o.png', panels: [{ capture: 'c.json', marks }] });
const p0 = (report) => report.panels[0];
const LENS_BOARD_PX = 110;
// A copy of BASE_K in lib/compose/page-layout.js, kept apart so the check does not read the code it checks.
const BASE_K = 1.06;
// A copy of LIFT_CSS in lib/compose/page-layout.js, for the same reason.
const LIFT_CSS = 1.15;
// A copy of STRAY_CSS in lib/compose/page-layout.js, for the same reason.
const STRAY_CSS = 12;

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

test('a card over a redacted row shows the fill where the page has it, however far its scale could go', { skip }, async () => {
  // a line above pins the card's top, so it grows downward; the page is drawn at 0.55 and the lift wants about twice that
  const bars = [[60, 30, 140, 16], [60, 60, 140, 16], [60, 84, 140, 16], [900, 60, 60, 16]];
  const { report, outPath, dir } = await render(spec([{ lift: ['a', 'b'], title: 'Two lines' }, { redact: 'b' }, { lift: 'far', title: 'Far' }]),
    await syntheticCapture({ size: [1100, 240], bars, boxes: { a: bars[1], b: bars[2], far: bars[3] } }));
  try {
    assertInvariants(report);
    const panel = p0(report); const [fill] = panel.redactions;
    const lift = panel.lifts.find((l) => l.keys.includes('b'));
    assert.ok(intersects(lift.rect, fill.rect), 'the card holds the fill');
    const [x0, y0] = [Math.max(lift.rect[0], fill.rect[0]) + 3, Math.max(lift.rect[1], fill.rect[1]) + 3];
    const [x1, y1] = [Math.min(lift.rect[0] + lift.rect[2], fill.rect[0] + fill.rect[2]) - 3, Math.min(lift.rect[1] + lift.rect[3], fill.rect[1] + fill.rect[3]) - 3];
    const png = await readFile(outPath); const scale = png.readUInt32BE(16) / report.stage[2];
    const off = await countOffColor({ png, rect: [x0, y0, x1 - x0, y1 - y0].map((v) => Math.round(v * scale)), color: [0xCB, 0xD5, 0xE1], tolerance: 24, renderer });
    assert.ok(off.total > 0);
    assert.equal(off.off, 0, `${off.off} of ${off.total} pixels of the fill's place under the card (k ${lift.k}) are not the fill`);
    assert.ok(lift.k > 1 + 1e-6, 'and the card is still enlarged');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a redaction is drawn as its fill alone, with no pill', { skip }, async () => {
  const { report, dir } = await render(spec([{ redact: 'a' }]), await syntheticCapture());
  try {
    assert.equal(p0(report).redactions.length, 1);
    assert.deepEqual(Object.keys(p0(report).redactions[0]).sort(), ['fill', 'rect', 'rects']);
    assert.deepEqual(p0(report).redactions[0].rects, [p0(report).redactions[0].rect], 'a live fill is one rect');
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
    assert.ok(tiny.rect[3] >= 23.5, 'the tiny lift renders near 24px tall');
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
    assert.deepEqual(p0(report).frame, [28, 28, 572, 272], 'whole, less the blank ground past 12 px at its left and top');
    assert.equal(p0(report).cropped, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a crop tightens around its marks and a redaction outside it is not drawn', { skip }, async () => {
  const bars = [[300, 120, 60, 20], [900, 500, 40, 30]];
  const capture = await syntheticCapture({ size: [1000, 600], bars, boxes: { a: bars[0], far: bars[1] } });
  const marks = [{ lift: 'a', title: 'Small' }, { redact: 'far' }];
  const both = await render(spec(marks), { ...capture, frame: [0, 0, 1000, 600] });
  try {
    assert.equal(p0(both.report).cropped, true, 'a redaction never grows the crop');
    assert.equal(p0(both.report).redactions.length, 0, 'and one outside the crop is not drawn');
  } finally { await rm(both.dir, { recursive: true, force: true }); }
  const left = await render(spec(marks), { ...capture, frame: [0, 0, 600, 600] });
  try {
    assert.equal(p0(left.report).cropped, true);
    assert.ok(p0(left.report).frame[2] * p0(left.report).frame[3] < 0.5 * 600 * 600);
    assert.equal(p0(left.report).redactions.length, 0, 'a redaction outside the frame is not drawn');
    assertInvariants(left.report);
  } finally { await rm(left.dir, { recursive: true, force: true }); }
});

test('a point over two apart elements gets two lifts and one label, and both carry its number where a connector would have to go around a lift', { skip }, async () => {
  const bars = [[40, 40, 60, 20], [200, 40, 60, 20], [360, 40, 60, 20], [360, 260, 60, 20]];
  const boxes = { a: bars[0], b: bars[1], c: bars[2], z: bars[3] };
  const { report, dir } = await render(spec([
    { lift: ['a', 'c'], title: 'Both ends' }, { lift: 'b', title: 'Middle' }, { lift: 'z', title: 'Below' },
  ]), await syntheticCapture({ size: [600, 400], bars, boxes }));
  try {
    assertInvariants(report);
    assert.deepEqual(p0(report).lifts.map((l) => l.mark), [0, 0, 1, 2], 'the first point has one lift per element');
    assert.equal(p0(report).labels.length, 3, 'one label per point');
    assert.equal(report.pinned, true, 'a connector along a lane round the frame is a tangle');
    assert.deepEqual(p0(report).pins.filter((pin) => p0(report).targets[pin.target].mark === 0).map((pin) => pin.number), [1, 1], 'both lifts of the first point carry its number');
    assert.equal(p0(report).connectors.length, 0);
    assert.equal(report.warnings.includes('a connector crosses another lift'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('with no clean spot for a dot on any open side the board is pinned, and no dot is drawn on content', { skip }, async () => {
  const bars = [[100, 100, 40, 20], [146, 40, 80, 160], [40, 126, 200, 60]];
  const { report, dir } = await render(spec([{ lift: 'a', title: 'Boxed in' }]), await syntheticCapture({ bars, boxes: { a: bars[0] } }));
  try {
    assertInvariants(report);
    assert.equal(report.pinned, true);
    assert.equal(p0(report).pins.length, 1);
    assert.deepEqual(p0(report).dots, [], 'no dot is drawn');
    assert.equal(report.warnings.includes('a leader dot sits on page content'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a connector dot slides off page content like a leader dot', { skip }, async () => {
  // The two lifts stand near enough that the connector's run is a short one; the block lies under the middle of the second.
  const bars = [[40, 40, 40, 20], [120, 40, 60, 20], [140, 76, 20, 14]];
  const { report, dir } = await render(spec([{ lift: ['a', 'c'], title: 'Both ends' }, { ghost: 'hold' }]), await syntheticCapture({ size: [740, 400], bars: [...bars, holdOf([740, 400])], boxes: { a: bars[0], c: bars[1], hold: holdOf([740, 400]) } }));
  try {
    assertInvariants(report);
    assert.equal(report.pinned, false);
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
  const bars = [[100, 100, 60, 20], [100, 123, 60, 20]];
  const report = await board([{ lift: 'a', title: 'Upper' }, { lift: 'b', title: 'Lower' }], { bars, boxes: { a: bars[0], b: bars[1] } });
  assert.ok(report.warnings.includes('two lifts overlap'));
});

test('a later lift gives way, down toward the base scale, when moving apart is not enough', { skip }, async () => {
  const bars = [[100, 100, 40, 8], [100, 122, 40, 8]];
  const report = await board([{ lift: 'a' }, { lift: 'b' }, { ghost: 'hold' }], { size: [740, 300], bars: [...bars, holdOf([740, 300])], boxes: { a: bars[0], b: bars[1], hold: holdOf([740, 300]) } });
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
  // The block under the small lift leaves it no clean way down, so the board's labels leave by the right.
  const bars = [[32, 16, 48, 160], [108, 112, 48, 16], [86, 16, 8, 78], [93, 189, 80, 13]];
  const report = await board([{ lift: 'a', title: 'Tall' }, { lift: 'b', title: 'Small' }], { size: [600, 300], bars, boxes: { a: bars[0], b: bars[1] } });
  assertInvariants(report);
  const tall = p0(report).dots.find((d) => d.target === 0);
  assert.ok(tall.slid > 40, `the tall lift's dot slid ${tall.slid}px down its side`);
});

test('a point with no side clear of other lifts is pinned, and the invariants catch a leader that crosses a lift', { skip }, async () => {
  const bars = [[100, 100, 60, 20], [200, 100, 60, 20], [100, 160, 60, 20]];
  const report = await board([{ lift: 'a', title: 'Boxed' }, { lift: 'b' }, { lift: 'c' }], { bars, boxes: { a: bars[0], b: bars[1], c: bars[2] } });
  assertInvariants(report);
  assert.equal(report.pinned, true);
  assert.deepEqual(p0(report).pins.map((pin) => p0(report).targets[pin.target].mark), [0], 'the titled lift alone carries a pin');
  assert.equal(report.warnings.includes('a leader crosses another lift'), false);
  // The same lift alone has a leader; a lift put across it is what the invariants exist to catch.
  const alone = await board([{ lift: 'a', title: 'Boxed' }], { bars, boxes: { a: bars[0] } });
  assertInvariants(alone);
  const [[x0, y0], [x1, y1]] = p0(alone).leaders[0].points;
  p0(alone).targets.push({ kind: 'lift', mark: 1, rect: [(x0 + x1) / 2 - 3, (y0 + y1) / 2 - 3, 6, 6] });
  assert.throws(() => assertInvariants(alone), /a leader crosses another lift/);
});

test('a point whose connector has no side clear of other lifts is pinned', { skip }, async () => {
  const bars = [[100, 100, 60, 20], [200, 100, 60, 20], [100, 160, 60, 20], [400, 30, 60, 20]];
  const boxes = { a: bars[0], b: bars[1], c: bars[2], far: bars[3] };
  const report = await board([{ lift: ['far', 'a'], title: 'Pair' }, { lift: 'b' }, { lift: 'c' }], { bars, boxes });
  assertInvariants(report);
  assert.equal(report.pinned, true);
  assert.deepEqual(p0(report).pins.map((pin) => [p0(report).targets[pin.target].mark, pin.number]), [[0, 1], [0, 1]], 'both lifts of the pair carry its number');
  assert.equal(p0(report).connectors.length, 0);
  assert.equal(report.warnings.includes('a connector crosses another lift'), false);
});

test('a connector joins a leader that leaves by the bottom', { skip }, async () => {
  // The second lift stands across the first one's way right, and near enough that the connector's run is a short one.
  const bars = [[100, 100, 40, 20], [170, 100, 60, 20]];
  const report = await board([{ lift: ['a', 'b'], title: 'Both' }], { size: [1200, 300], bars, boxes: { a: bars[0], b: bars[1] } });
  assertInvariants(report);
  assert.equal(report.pinned, false);
  assert.equal(p0(report).connectors.length, 1);
  const leader = p0(report).leaders[0].points;
  assert.ok(Math.abs(leader[0][0] - leader[1][0]) < 0.01, 'the leader leaves downward');
});

test('two pairs whose connectors would each need a lane are pinned, each pair under its own number', { skip }, async () => {
  // Each pair's left lift is walled in on its right by a middle lift, so both connectors would drop to a lane under the frame.
  const bars = [[40, 40, 60, 20], [200, 40, 60, 20], [360, 40, 60, 20], [120, 320, 60, 20], [280, 320, 60, 20], [440, 320, 60, 20]];
  const boxes = { a1: bars[0], m1: bars[1], a2: bars[2], b1: bars[3], m2: bars[4], b2: bars[5] };
  const report = await board([{ lift: ['a1', 'a2'], title: 'Top pair' }, { lift: ['b1', 'b2'], title: 'Lower pair' }, { lift: 'm1' }, { lift: 'm2' }], { size: [600, 600], bars, boxes });
  assertInvariants(report);
  const panel = p0(report);
  assert.equal(report.pinned, true);
  assert.equal(panel.connectors.length, 0, 'no connector is drawn');
  assert.deepEqual(panel.pins.map((pin) => [panel.targets[pin.target].mark, pin.number]).sort(), [[0, 1], [0, 1], [1, 2], [1, 2]], 'each pair has its number on both its lifts, and the untitled lifts have none');
  assert.deepEqual(panel.labels.map((label) => label.number), [1, 2]);
});

test('a board on which a connector would rise through another mark\'s leader is pinned, so nothing crosses', { skip }, async () => {
  const bars = [[40, 40, 60, 20], [200, 40, 60, 20], [360, 40, 60, 20], [120, 320, 60, 20], [280, 320, 60, 20], [440, 320, 60, 20]];
  const boxes = { a1: bars[0], m1: bars[1], a2: bars[2], b1: bars[3], m2: bars[4], b2: bars[5] };
  const report = await board([{ lift: ['a1', 'a2'], title: 'Top pair' }, { lift: ['b1', 'b2'], title: 'Lower pair' }, { lift: 'm1' }, { lift: 'm2' }], { size: [600, 600], bars, boxes });
  assertInvariants(report);
  assert.equal(report.pinned, true);
  assert.equal(p0(report).leaders.length, 0);
  assert.equal(report.warnings.includes('a connector crosses another leader'), false);
});

test('merging two colliding lifts never sweeps another mark into them', { skip }, async () => {
  const bars = [[100, 100, 40, 20], [146, 122, 40, 20], [100, 126, 30, 14]];
  const boxes = { a: bars[0], c: bars[1], b: bars[2] };
  const report = await board([{ lift: ['a', 'c'], title: 'Diagonal pair' }, { lift: 'b', title: 'Between' }], { bars, boxes });
  assert.equal(p0(report).lifts.filter((l) => l.mark === 0).length, 2, 'the pair stays two lifts');
  assert.ok(p0(report).lifts.every((l) => !l.merged));
});

test('a point whose upper lift has a stripe beside it and a block under it is pinned, with its number on both lifts', { skip }, async () => {
  // A 6px stripe beside the upper lift and a block under it leave no clean dot
  // spot, and the lower lift stands a long connector away.
  const bars = [[40, 40, 60, 20], [360, 220, 60, 20], [112, 30, 6, 40], [20, 70, 100, 60]];
  const report = await board([{ lift: ['a', 'c'], title: 'Both ends' }], { size: [600, 400], bars, boxes: { a: bars[0], c: bars[1] } });
  assertInvariants(report);
  assert.equal(report.pinned, true);
  assert.equal(p0(report).connectors.length, 0);
  assert.deepEqual(p0(report).pins.map((pin) => pin.number), [1, 1]);
});

test('two pairs whose connectors would leave by the right while their leaders go down are pinned', { skip }, async () => {
  // Both pairs' leaders would go to the bottom; each pair's other lift is walled in below and could only leave by the right.
  // The third mark is walled in below too, so no side takes every label.
  const bars = [[40, 40, 60, 20], [40, 100, 60, 20], [420, 120, 60, 20], [420, 180, 60, 20], [200, 230, 60, 20], [600, 230, 60, 20], [800, 180, 60, 20], [800, 240, 60, 20]];
  const boxes = { sp: bars[0], m1: bars[1], sq: bars[2], m2: bars[3], p: bars[4], q: bars[5], r: bars[6], m3: bars[7] };
  const report = await board([{ lift: ['sp', 'p'], title: 'First' }, { lift: ['sq', 'q'], title: 'Second' }, { lift: 'r', title: 'Third' }, { lift: 'm1' }, { lift: 'm2' }, { lift: 'm3' }], { size: [1000, 320], bars, boxes });
  const panel = p0(report);
  assert.equal(report.pinned, true);
  assert.equal(panel.connectors.length, 0);
  assert.deepEqual(panel.pins.map((pin) => pin.number).sort(), [1, 1, 2, 2, 3], 'each pair carries its number twice and the third mark once');
  assert.deepEqual(panel.labels.map((label) => label.number), [1, 2, 3], 'every label stands in the one legend');
  assertInvariants(report);
});

test('two pairs whose connectors would leave by the bottom while their leaders go right are pinned', { skip }, async () => {
  // Both pairs' leaders would go to the right; each pair's other lift is walled in at the right and could only leave by the bottom.
  // The third mark is walled in at the right too, so no side takes every label.
  const bars = [[40, 40, 60, 20], [120, 40, 60, 20], [200, 120, 60, 20], [280, 120, 60, 20], [420, 200, 60, 20], [420, 280, 60, 20], [300, 280, 60, 20]];
  const boxes = { sp: bars[0], m1: bars[1], sq: bars[2], m2: bars[3], p: bars[4], q: bars[5], r: bars[6] };
  const report = await board([{ lift: ['sp', 'p'], title: 'First' }, { lift: ['sq', 'q'], title: 'Second' }, { lift: 'r', title: 'Third' }, { lift: 'm1' }, { lift: 'm2' }], { size: [560, 360], bars, boxes });
  const panel = p0(report);
  assert.equal(report.pinned, true);
  assert.equal(panel.connectors.length, 0);
  assert.deepEqual(panel.pins.map((pin) => pin.number).sort(), [1, 1, 2, 2, 3], 'each pair carries its number twice and the third mark once');
  assert.deepEqual(panel.labels.map((label) => label.number), [1, 2, 3], 'every label stands in the one legend');
  assertInvariants(report);
});

const centresApart = (a, b) => Math.hypot(a.center[0] - b.center[0], a.center[1] - b.center[1]);

test('a board whose connector dot would land on a leader dot of another side is pinned, and its pins stand apart', { skip }, async () => {
  // The single lift's leader would leave by the bottom, its dot just below the lift. The pair's other lift, below and left of it,
  // would put its connector dot on the middle of its right side, a few px from that one.
  const bars = [[100, 100, 60, 20], [148, 68, 60, 20], [260, 68, 60, 20], [100, 300, 60, 20], [320, 200, 60, 20]];
  const boxes = { a: bars[0], b: bars[1], d: bars[2], z: bars[3], p2: bars[4] };
  const report = await board([{ lift: ['a', 'p2'], title: 'First' }, { lift: 'b', title: 'Second' }, { lift: 'd' }, { lift: 'z' }], { size: [500, 400], bars, boxes });
  assertInvariants(report);
  const panel = p0(report);
  assert.equal(report.pinned, true);
  assert.deepEqual(panel.dots, [], 'no dot is drawn');
  const near = ['a', 'b'].map((key) => panel.pins.find((pin) => panel.lifts[panel.targets[pin.target].lift].keys.includes(key)));
  assert.ok(near[0] && near[1], 'the two lifts that stand close each carry a pin');
  assert.ok(centresApart(near[0], near[1]) >= near[0].r + near[1].r + 2, `the two pins are ${centresApart(near[0], near[1]).toFixed(1)}px apart`);
});

test('a board whose connector dot would land on an earlier connector dot is pinned, and its pins stand apart', { skip }, async () => {
  // The same two lifts, each now the second lift of a mark whose other lift stands far off, so both dots would belong to connectors.
  const bars = [[100, 100, 60, 20], [148, 68, 60, 20], [260, 68, 60, 20], [100, 300, 60, 20], [320, 200, 60, 20], [320, 240, 60, 20]];
  const boxes = { a: bars[0], b: bars[1], d: bars[2], z: bars[3], p2: bars[4], q2: bars[5] };
  const report = await board([{ lift: ['a', 'p2'], title: 'First' }, { lift: ['b', 'q2'], title: 'Second' }, { lift: 'd' }, { lift: 'z' }], { size: [500, 400], bars, boxes });
  assertInvariants(report);
  const panel = p0(report);
  assert.equal(report.pinned, true);
  assert.equal(panel.connectors.length, 0);
  const [first, second] = ['a', 'b'].map((key) => panel.pins.find((pin) => panel.lifts[panel.targets[pin.target].lift].keys.includes(key)));
  assert.ok(first && second, 'the two lifts that stand close each carry a pin');
  assert.notEqual(first.number, second.number, 'of different points');
  assert.ok(centresApart(first, second) >= first.r + second.r + 2, `the two pins are ${centresApart(first, second).toFixed(1)}px apart`);
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

test("an empty slot's own text is its callout even where it would fit inside", { skip }, async () => {
  const report = await board([{ empty: 'big', text: 'Chart is blank' }], { bars: [], boxes: { big: [100, 60, 300, 150] } });
  assertInvariants(report);
  const panel = p0(report);
  assert.equal(panel.slots[0].text, 'label', 'the slot is a blank outline, not the words twice');
  assert.equal(panel.labels.length, 1);
  assert.equal(panel.targets[panel.labels[0].target].kind, 'slot');
});

test('an empty slot with a title of its own writes text that fits inside, and labels the title', { skip }, async () => {
  const report = await board([{ empty: 'big', title: 'Chart missing', text: 'Chart is blank' }], { bars: [], boxes: { big: [100, 60, 300, 150] } });
  assertInvariants(report);
  const panel = p0(report);
  assert.equal(panel.slots[0].text, 'inside');
  assert.equal(panel.labels.length, 1, 'the title is the one label');
  assert.equal(panel.targets[panel.labels[0].target].kind, 'slot');
  assert.ok(!report.warnings.includes('an empty slot is too small for its text'));
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

test('a ghost inside a redaction fill is an outline alone: the fill is no blank to hatch', { skip }, async () => {
  const report = await board([{ redact: 'v' }, { ghost: 'g', title: 'Removed' }], { bars: [[110, 110, 180, 20]], boxes: { v: [100, 100, 200, 40], g: [150, 112, 60, 16] } });
  assertInvariants(report);
  const [slot] = p0(report).slots;
  assert.equal(slot.hatched, false);
  const open = await board([{ ghost: 'g', title: 'Removed' }], { bars: [], boxes: { g: [150, 112, 60, 16] } });
  assert.equal(p0(open).slots[0].hatched, true, 'on blank ground the same ghost is hatched');
});

// Copies of GHOST_MIN and SLOT_FILL_GAP in lib/compose/page-layout.js, kept apart so the check does not read the code it checks.
const [GHOST_MIN, SLOT_FILL_GAP] = [24, 4];
// A small ghost beside one fill, with room to move clear of it; the same against the frame's edge, with none; and
// one between two fills, where a move off one lands on the other. The tight board is pinned and its pin stands on a
// fill, a fault of the pin's placement that the board has without any stand-off rule, so it is held to the fills alone.
for (const [name, size, bars, boxes, keepsSize, invariants = true] of [
  ['with room to move', [600, 300], [[100, 100, 80, 16]], { v: [100, 100, 80, 16], g: [184, 104, 12, 8] }, true],
  ['against the frame edge', [200, 300], [[100, 100, 80, 16]], { v: [100, 100, 80, 16], g: [184, 104, 12, 8] }, false],
  ['between two fills', [600, 300], [[100, 100, 40, 80], [162, 100, 40, 16], [20, 20, 10, 10], [400, 250, 10, 10]], { v: [100, 100, 40, 80], w: [162, 100, 40, 16], g: [146, 110, 10, 8] }, false],
  ['between two fills, tight', [600, 300], [[100, 100, 40, 80], [158, 96, 40, 20], [20, 20, 10, 10], [400, 250, 10, 10]], { v: [100, 100, 40, 80], w: [158, 96, 40, 20], g: [144, 108, 8, 6] }, false, false],
]) {
  test(`a small ghost beside a fill never lands on one, ${name}`, { skip }, async () => {
    const fills = Object.keys(boxes).filter((key) => key !== 'g').map((key) => ({ redact: key }));
    const report = await board([...fills, { ghost: 'g', title: 'Removed' }], { size, bars, boxes });
    if (invariants) assertInvariants(report);
    const [slot] = p0(report).slots;
    const [sx, sy, sw, sh] = slot.rect;
    for (const { rect: [fx, fy, fw, fh] } of p0(report).redactions) {
      const apart = Math.max(fx - (sx + sw), sx - (fx + fw), fy - (sy + sh), sy - (fy + fh));
      assert.ok(apart >= SLOT_FILL_GAP - 1e-6, `the ghost ${slot.rect} stands ${apart} px from the fill ${[fx, fy, fw, fh]}`);
    }
    if (keepsSize) assert.ok(sw >= GHOST_MIN - 1e-6 && sh >= GHOST_MIN - 1e-6, `with room to move, the ghost keeps its least size: ${sw} by ${sh}`);
  });
}

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

test('a zoom capped by a quarter or less stays quiet, and one capped by more warns', { skip }, async () => {
  const at = async (side) => {
    const bars = [[300, 150, side, side]];
    const report = await board([{ loupe: 'icon', zoom: 4, title: 'Icon' }], { bars, boxes: { icon: bars[0] } });
    assertInvariants(report);
    return { zoom: p0(report).loupes[0].zoom, warned: report.warnings.includes('a loupe was zoomed out to fit its target') };
  };
  const slight = await at(16);
  assert.ok(slight.zoom < 4 && slight.zoom >= 3, `a 16px target caps 4x to ${slight.zoom}`);
  assert.equal(slight.warned, false);
  const steep = await at(24);
  assert.ok(steep.zoom < 3, `a 24px target caps 4x to ${steep.zoom}`);
  assert.equal(steep.warned, true);
});

test('a target too large for the default zoom is zoomed out without a warning: the mark asked for none', { skip }, async () => {
  const bars = [[100, 100, 120, 40]];
  const report = await board([{ loupe: 'big' }], { bars, boxes: { big: bars[0] } });
  assertInvariants(report);
  assert.ok(p0(report).loupes[0].zoom < 4);
  assert.ok(!report.warnings.includes('a loupe was zoomed out to fit its target'));
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
    tints: [[1150, 505, 100, 20, '#dc2626'], [1150, 665, 100, 18, '#dc2626']] });
  const { report, outPath, dir } = await render(spec([{ loupe: 'wide', zoom: 8 }]), capture);
  try {
    assert.equal(p0(report).cropped, true, 'the board crops, so the blocks lie in the frame but outside the crop');
    const [, cropTop, , cropHeight] = p0(report).frame;
    assert.ok(525 < cropTop && 665 > cropTop + cropHeight, 'the blocks lie clear of the crop');
    const loupe = p0(report).loupes[0];
    const png = await readFile(outPath);
    const scale = png.readUInt32BE(16) / report.stage[2];
    const reach = (LENS_BOARD_PX / 2) / (loupe.zoom * (p0(report).capture[2] / p0(report).frame[2]));
    assert.ok(595 - reach < 505 && 595 + reach > 683, 'an unbounded lens would reach both blocks');
    const rect = loupe.lens.map((v) => Math.round(v * scale));
    const red = await countOffColor({ png, rect, color: [220, 38, 38], tolerance: 90, renderer });
    assert.equal(red.total - red.off, 0, 'the lens shows page that the crop left out');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// A 12 px blue badge and a red glyph to its left, on a 300 by 200 frame drawn at 1.25: a 4x lens about the badge
// is a circle of 11 CSS px, which reaches the glyph's right column.
const lensScene = async (glyph) => {
  const size = [300, 200]; const badge = [140, 90, 12, 12];
  const capture = await syntheticCapture({ size, bars: [], tints: [[...badge, '#2563eb'], [...glyph, '#dc2626']], boxes: { badge, ...holdBoxes(size) } });
  const { report, outPath, dir } = await render(spec([{ loupe: 'badge', zoom: 4, title: 'Badge' }, ...holdMarks]), capture);
  try {
    const png = await readFile(outPath);
    const loupe = p0(report).loupes[0];
    const scale = png.readUInt32BE(16) / report.stage[2];
    const red = await countOffColor({ png, rect: loupe.lens.map((v) => Math.round(v * scale)), color: [220, 38, 38], tolerance: 90, renderer });
    // Image px per CSS px inside the lens.
    const zoom = loupe.zoom * (p0(report).capture[2] / p0(report).frame[2]) * scale;
    return { loupe, red: red.total - red.off, area: glyph[2] * glyph[3] * zoom ** 2 };
  } finally { await rm(dir, { recursive: true, force: true }); }
};

test('a lens leaves out a glyph its circle would cut to a sliver', { skip }, async () => {
  const { loupe, red } = await lensScene([133, 91, 3, 10]);
  assert.deepEqual(loupe.moved, [0, 0], 'the lens stays on the badge');
  assert.ok(loupe.hidden > 0, 'the glyph is painted out');
  assert.equal(red, 0, 'none of the glyph shows in the lens');
});

test('a lens moves to take in whole a glyph its circle would cut', { skip }, async () => {
  const { loupe, red, area } = await lensScene([134, 92, 2, 8]);
  assert.deepEqual(loupe.moved, [-2, 0], 'the lens moves 2 CSS px left');
  assert.equal(loupe.hidden, 0);
  assert.ok(red > 0.6 * area, `${red} px of the glyph show in the lens, of ${area}`);
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

test('a bracket stands clear of a redaction on one of its rows', { skip }, async () => {
  const boxes = Object.fromEntries([0, 1, 2].map((i) => [`r${i}`, [40, 40 + 30 * i, 500, 14]]));
  const bars = [...[0, 1, 2].map((i) => [40, 40 + 30 * i, 80, 14]), [130, 70, 150, 14]];
  const report = await board([{ bracket: ['r0', 'r1', 'r2'], title: 'Rows' }, { redact: 'v' }], { bars, boxes: { ...boxes, v: bars[3] } });
  assertInvariants(report);
  const [bracket] = p0(report).brackets; const [fill] = p0(report).redactions;
  const beyond = bracket.rect[0] - (fill.rect[0] + fill.rect[2]);
  assert.ok(beyond > 0, 'the bracket is right of the fill');
  assert.ok(beyond <= 30, `the bracket stands ${beyond} px from the fill: its rows end where their content ends, not where their boxes do`);
});

test('a bracket with no clear spot beside its rows stands past a redaction, never through it', { skip }, async () => {
  // the fill starts 6 px right of the rows and runs on past everywhere the bracket may slide to
  const bars = [...[0, 1, 2].map((i) => [40, 40 + 30 * i, 80, 14]), [128, 70, 150, 14]];
  const report = await board([{ bracket: ['r0', 'r1', 'r2'], title: 'Rows' }, { redact: 'v' }], { bars, boxes: { r0: bars[0], r1: bars[1], r2: bars[2], v: bars[3] } });
  assertInvariants(report);
  const [bracket] = p0(report).brackets; const [fill] = p0(report).redactions;
  assert.equal(intersects(bracket.rect, fill.rect), false, 'the bracket is not drawn through the fill');
  assert.ok(bracket.rect[0] >= fill.rect[0] + fill.rect[2], 'it stands right of the fill');
  assert.equal(report.warnings.includes('a bracket sits on page content'), false, 'the ground past the fill is clear');
});

test('a bracket walled in by a redaction that runs to the frame edge goes to the margin', { skip }, async () => {
  const bars = [...[0, 1, 2].map((i) => [40, 40 + 30 * i, 80, 14]), [128, 70, 472, 14]];
  const report = await board([{ bracket: ['r0', 'r1', 'r2'], title: 'Rows' }, { redact: 'v' }], { bars, boxes: { r0: bars[0], r1: bars[1], r2: bars[2], v: bars[3] } });
  assertInvariants(report);
  assert.equal(p0(report).brackets[0].inMargin, true);
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
  const report = await board([{ loupe: 'tiny', title: 'Tiny' }, { ghost: 'far' }], { size: [1400, 300], bars, boxes: { tiny: [300, 140, 10, 10], far: [1300, 10, 30, 10] } });
  assertInvariants(report);
  assert.ok(leaves(p0(report), 'right'), 'the leader goes right, past nothing, and not down through the stroke');
});

test('a loupe avoids a stem that sits one pixel beside its leader\'s centre line', { skip }, async () => {
  const bars = [[302, 142, 4, 4], [306, 165, 1, 120]];
  const report = await board([{ loupe: 'tiny', title: 'Tiny' }, { ghost: 'far' }], { size: [1400, 300], bars, boxes: { tiny: [300, 140, 10, 10], far: [1300, 10, 30, 10] } });
  assertInvariants(report);
  assert.ok(leaves(p0(report), 'right'), 'the leader goes right, because the stroke below would cover the stem');
});

test('a loupe on a target unlike the page is scored against the page, not the target', { skip }, async () => {
  const bars = [[300, 140, 10, 10], stroke(250, 220, 120, 2)];
  const report = await board([{ loupe: 'tiny', title: 'Tiny' }, { ghost: 'far' }], { size: [1400, 300], bars, boxes: { tiny: bars[0], far: [1300, 10, 30, 10] } });
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
  const bars = [[302, 142, 4, 4], stroke(335, 100, 2, 44)];
  const report = await board([{ lift: 'tiny', title: 'Tiny' }], { bars, boxes: { tiny: [300, 140, 10, 10] } });
  assertInvariants(report);
  const [lift] = p0(report).lifts; const [x] = p0(report).leaders[0].points[0];
  assert.ok(x >= lift.rect[0] + lift.rect[2], 'the leader leaves the lift by its right side');
  assert.notEqual(p0(report).dots[0].slid, 0, 'because its dot slid off the stroke');
});

const leavesBy = (panel) => {
  const [lift] = panel.lifts; const [x, y] = panel.leaders[0].points[0];
  return y >= lift.rect[1] + lift.rect[3] && x < lift.rect[0] + lift.rect[2] ? 'bottom' : 'right';
};

test('a lift whose preferred side strikes a wide block at every spot takes the empty side', { skip }, async () => {
  // The lift stands near enough to the right edge that its run there is not a long one: of two long runs the far shorter one below would win.
  const lift = [300, 100, 60, 20]; const far = [560, 260, 30, 20];
  const open = await board([{ lift: 'a', title: 'Blocked' }, { ghost: 'far' }], { bars: [lift, far, ...CORNERS_600], boxes: { a: lift, far } });
  assert.equal(leavesBy(p0(open)), 'right', 'with nothing in the way the leader goes to the preferred side');
  const report = await board([{ lift: 'a', title: 'Blocked' }, { ghost: 'far' }], { bars: [lift, [460, 60, 100, 140], far, ...CORNERS_600], boxes: { a: lift, far } });
  assertInvariants(report);
  assert.equal(leavesBy(p0(report)), 'bottom');
});

test('a lift whose right side is a thin block at every spot leaves by the bottom, and strikes nothing', { skip }, async () => {
  const lift = [100, 100, 60, 20]; const far = [560, 280, 30, 14];
  const bars = [lift, [200, 40, 12, 200], [120, 150, 20, 140], far];
  const report = await board([{ lift: 'a', title: 'Blocked' }, { ghost: 'far' }], { bars, boxes: { a: lift, far } });
  assertInvariants(report);
  assert.equal(leavesBy(p0(report)), 'bottom', 'the dot does not sit on the side the block covers');
  assert.equal(report.warnings.includes('a leader dot sits on page content'), false);
});

test('a lift whose every side strikes content is pinned, and no dot sits on content', { skip }, async () => {
  const lift = [100, 100, 60, 20]; const far = [560, 280, 30, 14];
  const bars = [lift, [200, 40, 12, 200], [60, 150, 140, 12], far];
  const report = await board([{ lift: 'a', title: 'Boxed in' }, { ghost: 'far' }], { bars, boxes: { a: lift, far } });
  assertInvariants(report);
  assert.equal(report.pinned, true);
  assert.equal(p0(report).pins.length, 1);
  assert.equal(report.warnings.includes('a leader dot sits on page content'), false);
});

const DOT_OUTER = 5.5;
const onFill = (panel, point) => panel.redactions.some((r) => r.rects.some((rect) => rectDistance(point, rect) < DOT_OUTER));
const crossesFill = (panel, points) => panel.redactions.some((r) => r.rects.some((rect) => points.slice(1).some((q, i) => segmentHitsRect(points[i], q, rect))));

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

test('a lift boxed in by fills on every open side is pinned, and its pin stands on neither fill', { skip }, async () => {
  const lift = [100, 100, 60, 20]; const right = [164, 84, 60, 60]; const below = [80, 124, 120, 40];
  const report = await board([{ lift: 'a', title: 'Boxed in' }, { redact: 'right' }, { redact: 'below' }], { bars: [lift, right, below], boxes: { a: lift, right, below } });
  assertInvariants(report);
  const panel = p0(report); const [pin] = panel.pins;
  assert.equal(report.pinned, true);
  assert.equal(panel.leaders.length, 0);
  assert.equal(panel.redactions.length, 2);
  for (const fill of panel.redactions) assert.ok(rectDistance(pin.center, fill.rect) >= pin.r, `the pin is ${rectDistance(pin.center, fill.rect).toFixed(1)}px from a fill`);
  assert.equal(report.warnings.includes('a leader dot sits on page content'), false);
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
  const report = await board([{ empty: 'mine', text: 'Nothing rendered here at all' }, { empty: 'wall', text: 'Walled' }, { ghost: 'far' }], { size: [700, 300], bars: [...bars, ...CORNERS_700], boxes: { mine: slots[0], wall: slots[1], far: bars.at(-1) } });
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
  const report = await board([{ lift: 'a', title: 'Crossed' }, { ghost: 'far' }], { bars, boxes: { a: bars[0], far: bars[3] } });
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
  const report = await board([{ lift: 'a', title: 'Open' }, { ghost: 'far' }], { bars, boxes: { a: bars[0], far: bars[1] } });
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

// The lift-room scenes run below 1x, at about 1.07x and at 1.25x, where whole board px fall between capture px. A case
// names the range its frame must be drawn in, so a frame that drifts out of it fails instead of testing another scale.
const drawnAt = (panel, [label, low, high]) => {
  const S = panel.capture[2] / panel.frame[2];
  assert.ok(S >= low && S <= high, `drawn at ${S}x, not ${label}`);
  return S;
};

// Capture px of ground between a lift's card and a bar to its left, at the scale the card was placed at: the capture's
// board width is rounded to a whole px, so its ratio to the frame is off the layout's own by up to half a px across it.
const groundLeftOf = (panel, lift, bar) => {
  const S = lift.rect[2] / (lift.k * liftBox(lift)[2]);
  return (lift.rect[0] - panel.capture[0] - (bar[0] + bar[2] - panel.frame[0]) * S) / S;
};
const clearScene = async (width, gap) => {
  const element = [200, 100, 40, 12];
  const bar = [200 - gap - 40, 103, 40, 6];
  const far = [width - 40, 260, 30, 20];
  const report = await board([{ lift: 'a', title: 'Small' }, { ghost: 'far' }], { size: [width, 300], bars: [bar, far], boxes: { a: element, far } });
  assertInvariants(report);
  return { panel: p0(report), ground: groundLeftOf(p0(report), p0(report).lifts[0], bar) };
};

for (const gap of [10, 5]) for (const [width, ...scale] of [[840, 'below 1x', 0.9, 0.95], [738, 'about 1.07x', 1.05, 1.1], [600, '1.25x', 1.24, 1.26]]) {
  test(`a lift keeps ${LIFT_CLEAR} capture px of ground between its card and a bar ${gap}px from its element, drawn ${scale[0]}`, { skip }, async () => {
    const { panel, ground } = await clearScene(width, gap);
    drawnAt(panel, scale);
    assert.ok(ground >= LIFT_CLEAR - 0.01, `${ground.toFixed(2)} capture px of ground lie between the card and the bar`);
  });
}

// Whether a card placed at whole board px loses its clearance depends on where those px fall between capture px, which
// moves with every frame width: the widths run from the 1.25x cap down past 1x.
test(`a lift keeps ${LIFT_CLEAR} capture px of ground beside a bar 5px from its element at every single-board scale`, { skip }, async () => {
  const short = [];
  for (let width = 500; width <= 760; width += 6) {
    const { panel, ground } = await clearScene(width, 5);
    if (ground < LIFT_CLEAR - 0.01) short.push(`${width} wide at ${(panel.capture[2] / panel.frame[2]).toFixed(3)}x: ${ground.toFixed(2)}`);
  }
  assert.deepEqual(short, [], 'capture px of ground between the card and the bar');
});

const OVER = [[100, 138, 110, 6], [100, 166, 110, 6]];
const SHORT = [200, 150, 40, 10];
// At 1.25x the card is short enough to stand between rows 22 px apart, so there they stand 4 px off the element.
const OVER_CLOSE = [[100, 140, 110, 6], [100, 164, 110, 6]];

for (const [width, rows, ...scale] of [[700, OVER, 'below 1x', 0.9, 0.95], [600, OVER, 'about 1.07x', 1.05, 1.1], [500, OVER_CLOSE, '1.25x', 1.24, 1.26]]) {
  test(`an enlarged lift between two rows it cannot clear at a readable height gives way, hides no more than a stray edge of them and reaches for the open ground beside them, drawn ${scale[0]}`, { skip }, async () => {
    const far = [width - 40, 260, 30, 20];
    const corners = [[1, 1, 20, 4], [width - 21, 295, 20, 4]];
    const report = await board([{ lift: 'a', title: 'Short' }, { ghost: 'far' }], { size: [width, 300], bars: [...rows, far, ...corners], boxes: { a: SHORT, far } });
    assertInvariants(report);
    const panel = p0(report); const [lift] = panel.lifts;
    const S = drawnAt(panel, scale);
    const [x, y, w, h] = boardOf(panel, liftBox(lift));
    const [, , W, H] = lift.rect;
    assert.ok(W > w && H > h, 'the lift is enlarged');
    assert.ok(H < 24, `the card gave way below a readable height (${H.toFixed(1)} px)`);
    const hidden = rows.reduce((sum, row) => sum + overlapArea(lift.rect, boardOf(panel, row)), 0) / S ** 2;
    assert.ok(hidden <= STRAY_CSS, `the card hides ${hidden.toFixed(1)} CSS px squared of the rows`);
    // A card stands on whole board px, so it may start up to one px before its element.
    assert.ok(lift.rect[0] > x - 1 && lift.rect[0] + W > x + w + 1, `the card grows away from the rows, toward the open ground (${lift.rect[0]} against ${x.toFixed(2)})`);
    assert.ok(lift.rect[0] <= x + 0.01 && lift.rect[0] + W >= x + w - 0.01 && lift.rect[1] <= y + 0.01 && lift.rect[1] + H >= y + h - 0.01, 'the card still covers its element');
  });
}

test('a tiny lift that cannot clear its neighbours even at the base scale hides less of them than a centred card, at 1x and at 2x', { skip }, async () => {
  // A wide line between a tall narrow column 14 px to its left and a line 3 px to its right: at BASE_K the card's ring
  // reaches one or the other wherever it stands. Moving left clears most of the line from the card's margin and puts
  // the whole column under its face.
  const wide = [200, 150, 300, 10]; const column = [181, 135, 5, 40]; const line = [503, 150, 100, 10];
  const boards = await twinBoards([{ lift: 'w', title: 'Wide' }, ...holdMarks], { size: GRID_SIZE, bars: [wide, column, line], boxes: { w: wide, ...holdBoxes(GRID_SIZE) } });
  assertSameLayout(...boards, [2]);
  for (const report of boards) {
    const panel = p0(report); const [lift] = panel.lifts;
    assert.ok(lift.tiny && Math.abs(lift.k - BASE_K) < 1e-9, `the card stays at the base scale (k ${lift.k})`);
    const [x, y, w, h] = boardOf(panel, liftBox(lift));
    const [, , W, H] = lift.rect;
    const centred = [x + w / 2 - W / 2, y + h / 2 - H / 2, W, H];
    const hidden = (card) => [column, line].reduce((sum, bar) => sum + overlapArea(card, boardOf(panel, bar.map((n) => n * panel.scale))), 0);
    assert.ok(hidden(lift.rect) < hidden(centred), `the card hides ${hidden(lift.rect).toFixed(1)} board px of its neighbours, a centred card ${hidden(centred).toFixed(1)}`);
  }
});

test('an enlarged lift on open ground stays centred on its element', { skip }, async () => {
  const report = await board([{ lift: 'a', title: 'Short' }, { ghost: 'far' }], { bars: [[560, 260, 30, 20]], boxes: { a: SHORT, far: [560, 260, 30, 20] } });
  assertInvariants(report);
  const panel = p0(report); const [lift] = panel.lifts;
  const [x, y, w, h] = boardOf(panel, liftBox(lift));
  assert.ok(lift.rect[2] > w, 'the lift is enlarged');
  assert.ok(Math.abs(lift.rect[0] + lift.rect[2] / 2 - (x + w / 2)) <= 1 && Math.abs(lift.rect[1] + lift.rect[3] / 2 - (y + h / 2)) <= 1, 'the card is centred to within a pixel');
});

// A card's 1px outline, as bars.
const outlineOf = ([x, y, w, h]) => [[x, y, w, 1], [x, y + h - 1, w, 1], [x, y, 1, h], [x + w - 1, y, 1, h]];

test('a lift beside a card\'s right border stays centred on its element and its leader leaves by the right', { skip }, async () => {
  // The border is 5 capture px outside the lift's padded box: inside its count margin, and a card hung off it can clear it.
  const element = [564, 134, 4, 4];
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

const cssFrames = (report) => report.panels.map((p) => p.frame.map((n) => n / p.scale));
const multi = (layout, panels, title = 'Board') => ({ state: 'FLOW', title, layout, out: 'o.png', panels: panels.map((marks, i) => ({ label: `Panel ${i + 1}`, capture: `c${i}.json`, marks })) });

test('a pair draws two captures of very different sizes at one height', { skip }, async () => {
  // Content in two corners keeps each frame whole: trimmed to its one line, either would be a strip, and the pair stacked.
  const big = await syntheticCapture({ size: [1800, 900], bars: [[300, 300, 600, 60], [1, 1, 20, 4], [1779, 895, 20, 4]], boxes: { a: [300, 300, 600, 60] } });
  const small = await syntheticCapture({ size: [600, 300], bars: [[100, 100, 200, 20], ...CORNERS_600], boxes: { a: [100, 100, 200, 20] } });
  const { report, pixels, dir } = await render(multi('pair', [[], [{ lift: 'a', title: 'After' }]]), [big, small]);
  try {
    assertInvariants(report);
    assert.equal(report.panels.length, 2);
    assert.equal(report.panels[0].capture[3], report.panels[1].capture[3]);
    assert.equal(report.textScale, 1, 'a pair is never drawn past CSS size, so its type keeps CSS size');
    assert.equal(report.arrows.length, 0);
    assert.equal(pixels.width, Math.round(report.stage[2] * 2));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a strip beside a card is stacked at one width', { skip }, async () => {
  const strip = await syntheticCapture({ size: [1500, 75], bars: [[40, 30, 600, 14]], boxes: { a: [40, 30, 600, 14] } });
  const card = await syntheticCapture({ size: [450, 300], bars: [[40, 40, 200, 20]], boxes: { a: [40, 40, 200, 20] } });
  const { report, pixels, dir } = await render(multi('pair', [[], []]), [strip, card]);
  try {
    assertInvariants(report);
    assert.equal(report.stacked, true);
    assert.equal(report.panels[0].capture[2], report.panels[1].capture[2]);
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
  for (let i = 0; i < 4; i += 1) captures.push(await syntheticCapture({ size: [300, 300], bars: [[20, 20, 260, 260]], boxes: { a: [20, 20, 260, 260] } }));
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
// Squares 14 px wide every 16: the 2 px between them is no word space, let alone a band.
const denseBars = (size) => Array.from({ length: Math.ceil(size[0] / 16) * Math.ceil(size[1] / 16) }, (_, n) => [(n % Math.ceil(size[0] / 16)) * 16, Math.floor(n / Math.ceil(size[0] / 16)) * 16, 14, 14]);

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

test('a pair takes a word step outward past a sidebar only where both states do', { skip }, async () => {
  // A sidebar strip down the left and text rows down to y 342. Above the rows the first state shows ground within
  // WORD_REACH of its frame's top, which only the strip crosses; the second state's rows run on up to y 200.
  const mark = [70, 350, 60, 20];
  const rows = (from) => Array.from({ length: Math.floor((342 - from) / 7) }, (_, n) => Array.from({ length: 72 }, (_, m) => [60 + 7 * m, from + 7 * n, 6, 6])).flat();
  const scene = (from) => syntheticCapture({ size: [600, 500], bars: [[20, 0, 16, 500], mark, ...rows(from)], boxes: { a: mark } });
  const frame = [0, 302, 600, 190];
  const alone = await render(spec([{ lift: 'a', title: 'Alone' }]), { ...(await scene(300)), frame });
  await rm(alone.dir, { recursive: true, force: true });
  assert.equal(p0(alone.report).frameEdges.top, 'word', 'on its own the first state steps out past the strip');
  const { report, dir } = await render(multi('pair', [[{ lift: 'a', title: 'First' }], [{ lift: 'a', title: 'Second' }]]), [{ ...(await scene(300)), frame }, { ...(await scene(202)), frame }]);
  await rm(dir, { recursive: true, force: true });
  assertInvariants(report);
  assert.deepEqual(report.panels.map((p) => [p.frameEdges.top, p.cleanFrame[1]]), [['cut', 302], ['cut', 302]], 'neither state steps out, so both show the same top row');
});

test('a pair of one region whose states reflow differently takes no word step where they would settle apart, at 1x and at 2x', { skip }, async () => {
  // Rows of words 30 px wide and 4 apart, which the frame's right edge at x 400 cuts: a word space is the only clean
  // column near it. The second state's words start 11 px further right, so its nearest word space lies elsewhere.
  const mark = [20, 20, 60, 16];
  const rows = (from) => Array.from({ length: 11 }, (_, n) => Array.from({ length: Math.ceil((600 - from) / 34) }, (_, m) => [from + 34 * m, 60 + 20 * n, 30, 12])).flat();
  const frame = [0, 0, 400, 300];
  const css = (panel, box) => box.map((n) => n / panel.scale);
  const boards = [];
  for (const scale of [1, 2]) {
    const states = [];
    for (const from of [20, 31]) {
      const capture = await syntheticCapture({ size: [600, 300], bars: [mark, ...rows(from)], boxes: { a: mark }, scale });
      states.push({ ...capture, frame: frame.map((n) => n * scale) });
    }
    if (scale === 1) {
      const alone = [];
      for (const state of states) {
        const { report, dir } = await render(spec([{ lift: 'a', title: 'Alone' }]), state);
        await rm(dir, { recursive: true, force: true });
        alone.push(p0(report));
      }
      assert.deepEqual(alone.map((p) => p.frameEdges.right), ['word', 'word'], 'on its own each state settles its right edge in a word space');
      assert.notEqual(alone[0].cleanFrame[2], alone[1].cleanFrame[2], 'and the two word spaces lie apart');
    }
    const { report, dir } = await render(multi('pair', [[{ lift: 'a', title: 'Before' }], [{ lift: 'a', title: 'After' }]]), states);
    await rm(dir, { recursive: true, force: true });
    assertInvariants(report);
    const [a, b] = report.panels;
    assert.deepEqual(css(b, b.frame), css(a, a.frame), `both panels show one rectangle at ${scale}x`);
    assert.deepEqual(report.panels.map((p) => p.frameEdges.right), ['cut', 'cut'], 'neither state takes its own word space');
    for (const panel of report.panels) assert.ok(panel.fades.some((f) => f.side === 'right'), 'the right edge, cutting words, fades');
    boards.push({ ...report, imageSizes: states.map((state) => state.size) });
  }
  assertSameLayout(...boards, [2, 2]);
});

test('a pair of two viewports whose states reflow differently agrees on its word steps too, at 1x and at 2x', { skip }, async () => {
  // As above, but the second viewport is 10 px shorter, so the two frames are not one size.
  const mark = [20, 20, 60, 16];
  const rows = (from) => Array.from({ length: 11 }, (_, n) => Array.from({ length: Math.ceil((600 - from) / 34) }, (_, m) => [from + 34 * m, 60 + 20 * n, 30, 12])).flat();
  const css = (panel, box) => box.map((n) => n / panel.scale);
  const boards = [];
  for (const scale of [1, 2]) {
    const states = [];
    for (const [from, height] of [[20, 300], [31, 290]]) {
      const capture = await syntheticCapture({ size: [600, height], bars: [mark, ...rows(from)], boxes: { a: mark }, scale });
      states.push({ ...capture, frame: [0, 0, 400, height].map((n) => n * scale) });
    }
    const { report, dir } = await render(multi('pair', [[{ lift: 'a', title: 'Before' }], [{ lift: 'a', title: 'After' }]]), states);
    await rm(dir, { recursive: true, force: true });
    assertInvariants(report);
    const [a, b] = report.panels;
    assert.deepEqual(report.panels.map((p) => p.frameEdges.right), ['cut', 'cut'], `neither state takes its own word space at ${scale}x`);
    assert.deepEqual([css(b, b.cleanFrame)[2], css(b, b.frame)[2]], [css(a, a.cleanFrame)[2], css(a, a.frame)[2]], `both panels show one width of the region at ${scale}x`);
    boards.push({ ...report, imageSizes: states.map((state) => state.size) });
  }
  assertSameLayout(...boards, [2, 2]);
});

test('a steps crop edge held through a button fades: a button ends at its corners, so it is no strip', { skip }, async () => {
  const mark = [400, 300, 60, 20];
  const scene = await syntheticCapture({ size: [1000, 800], bars: [mark, [100, 330, 600, 30]], boxes: { a: mark } });
  const { report, dir } = await render(multi('steps', [[{ lift: 'a', title: 'One' }], [{ lift: 'a', title: 'Two' }]]), [scene, scene]);
  await rm(dir, { recursive: true, force: true });
  assertInvariants(report);
  for (const panel of report.panels) {
    assert.deepEqual([panel.cropEdges.left, panel.cropEdges.right], ['margin', 'margin']);
    assert.deepEqual(panel.fades.map((f) => f.side).filter((side) => side === 'left' || side === 'right'), ['left', 'right'], 'both cut sides fade');
  }
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
  // 12 px outside the first card's outline above and below; none at the sides, where the lift's card wants the room
  assert.deepEqual(a.trimmed, { left: 0, top: 8, right: 0, bottom: 8 }, 'the smaller of the two trims on each side');
  assert.deepEqual(b.trimmed, a.trimmed);
  assert.deepEqual(a.frame, [0, 8, 600, 284]);
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
  assert.deepEqual([a.trimmed.left, b.trimmed.left], [0, 38]);
  assert.deepEqual([a.trimmed.top, b.trimmed.top], [8, 18]);
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

test('a single board trims a frame that carries blank ground, as a pair does', { skip }, async () => {
  const card = [20, 20, 640, 260];
  const report = await board([{ lift: 'a', title: 'First' }], { size: [680, 300], bars: [...outline(card), [60, 50, 560, 200]], boxes: { a: [60, 50, 560, 200] } });
  assertInvariants(report);
  assert.deepEqual(p0(report).trimmed, { left: 0, top: 8, right: 0, bottom: 8 }, '12 px stay outside the outline; the sides keep the room the lift\'s card wants');
  assert.deepEqual(p0(report).frame, [0, 8, 680, 284]);
});

test('a single board trims the blank half of its frame', { skip }, async () => {
  // the marks span the frame's height, so the crop does not apply and the frame is shown whole
  const bars = [[30, 40, 160, 16], [30, 150, 120, 16]];
  const { report, dir } = await render(spec([{ lift: 'a', title: 'First' }, { lift: 'b', title: 'Second' }]), await syntheticCapture({ size: [420, 200], bars, boxes: { a: bars[0], b: bars[1] } }));
  try {
    assertInvariants(report);
    const panel = p0(report);
    assert.equal(panel.cropped, false);
    // 12 px of ground would clamp the card: beside a lift the trim keeps its padding, the 12.6 px a centred card adds at 1.15 and the card's 6 px at the frame edge
    assert.ok(panel.frame[0] + panel.frame[2] <= 190 + 4 + 12.6 + 6 + 1, `the shown frame ends at ${panel.frame[0] + panel.frame[2]}: the blank right half is still there`);
    assert.ok(panel.lifts.every((l) => !l.clamped), 'and no card is clamped by the trim');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// A card with a 1 px border on a tinted page, its heading flush against the border: the frame is the card.
// The two marks stand far enough apart that the board shows the frame whole.
const flushCard = async (scale) => {
  const card = [60, 40, 400, 180]; const [x, y, w, h] = card;
  const border = [[x, y, w, 1], [x, y + h - 1, w, 1], [x, y, 1, h], [x + w - 1, y, 1, h]];
  const heading = [x + 2, y + 2, 180, 16]; const marks = [[x + 40, y + 90, 120, 16], [x + 240, y + 140, 120, 16]];
  const capture = await syntheticCapture({ size: [600, 300], bars: [heading, ...marks], boxes: { a: marks[0], b: marks[1] }, scale,
    tints: [[0, 0, 600, y, '#f1f5f9'], [0, y + h, 600, 300 - y - h, '#f1f5f9'], [0, y, x, h, '#f1f5f9'], [x + w, y, 600 - x - w, h, '#f1f5f9'], ...border.map((b) => [...b, '#cbd5e1'])] });
  return { ...capture, frame: card.map((n) => n * scale) };
};

for (const scale of [1, 2]) {
  test(`a frame loses the border on its edges and a heading flush against one gets ground beside it, at ${scale}x`, { skip }, async () => {
    const { report, outPath, dir } = await render(spec([{ lift: 'a', title: 'First' }, { lift: 'b', title: 'Second' }]), await flushCard(scale));
    try {
      assertInvariants(report);
      const panel = p0(report); const css = (n) => n / scale;
      assert.equal(panel.cropped, false);
      assert.deepEqual(panel.cleanFrame.map(css), [60, 40, 400, 180], 'the frame was clean as captured');
      assert.deepEqual(Object.values(panel.air).map(css), [11, 11, 1, 1], 'the heading stood 1 px inside the left and top edges, so each is given 11 px; the other two get back the px they lost, for the lifts');
      assert.deepEqual(panel.wholeFrame.map(css), [50, 30, 410, 190], 'the border goes from every side and the air is added');
      // the board's left and top edges show the card's white, not its border or the page behind it
      const png = await readFile(outPath); const k = png.readUInt32BE(16) / report.stage[2];
      const [bx, by, bw, bh] = panel.capture;
      for (const rect of [[bx + 1, by + 6, 3, bh - 12], [bx + 6, by + 1, bw - 12, 3]]) {
        const off = await countOffColor({ png, rect: rect.map((v) => Math.round(v * k)), color: [255, 255, 255], tolerance: 6, renderer });
        assert.equal(off.off, 0, `${off.off} of ${off.total} pixels along a painted edge are not the card's ground`);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test('a redaction 4 px inside a frame edge that is given air keeps its whole fill, and so does one the air is painted over', { skip }, async () => {
  // `beside` lies just outside the frame's left edge, where the 10 px of air are painted
  const hidden = [104, 100, 80, 16]; const beside = [86, 150, 10, 16];
  const capture = await syntheticCapture({ size: [600, 300], bars: [hidden, beside, [300, 180, 120, 16]], boxes: { a: hidden, b: beside } });
  const { report, outPath, dir } = await render(spec([{ redact: 'a' }, { redact: 'b' }]), { ...capture, frame: [100, 50, 400, 200] });
  try {
    assertInvariants(report);
    const panel = p0(report);
    assert.equal(panel.air.left, 10, 'the fill starts 2 px inside the edge, so the edge is given 10 px');
    assert.equal(panel.redactions.length, 2);
    const S = panel.capture[2] / panel.frame[2];
    const page = ([x, , w]) => [(x - panel.capture[0]) / S + panel.frame[0], w / S];
    const [inside, painted] = panel.redactions.map((r) => r.rect);
    assert.ok(Math.abs(page(inside)[0] - 102) < 0.75 && Math.abs(page(inside)[1] - 84) < 0.75, `the fill stands where the page has it (${page(inside)})`);
    assert.ok(Math.abs(page(painted)[0] - 90) < 0.75 && Math.abs(page(painted)[1] - 8) < 0.75, `the fill under the air is drawn from the new edge to its own (${page(painted)})`);
    const png = await readFile(outPath); const k = png.readUInt32BE(16) / report.stage[2];
    for (const [x, y, w, h] of [inside, painted]) {
      const off = await countOffColor({ png, rect: [x + 1, y + 1, w - 2, h - 2].map((v) => Math.round(v * k)), color: [0xCB, 0xD5, 0xE1], tolerance: 24, renderer });
      assert.equal(off.off, 0, `${off.off} of ${off.total} pixels of a fill are not the fill colour`);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// A real page: a white card with a 1 px border and 12 px corners on a tinted page, framed as the capture frames it (the card and 12 px).
const ROUND_CARD = `<body style="margin:0;background:#f1f5f9;font:14px Helvetica,Arial,sans-serif;color:#0f172a">
<div id="card" style="position:absolute;left:60px;top:40px;width:420px;box-sizing:border-box;padding:20px;background:#fff;border:1px solid #cbd5e1;border-radius:12px">
<div style="font-weight:700;font-size:16px">Deploy checks</div><div style="margin-top:12px"><span id="build">Build passed</span></div><div style="margin-top:8px;text-align:right"><span id="tests">Tests passed</span></div></div></body>`;
async function roundCardCapture(scale, extra = '') {
  const { chromium } = await import(renderer.playwrightCore);
  const browser = await chromium.launch({ headless: true, executablePath: renderer.executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 600, height: 300 }, deviceScaleFactor: scale });
    await page.setContent(ROUND_CARD.replace('</div></body>', `${extra}</div></body>`));
    const [card, build, tests] = await page.evaluate(() => ['card', 'build', 'tests'].map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }));
    const frame = [card[0] - 12, card[1] - 12, card[2] + 24, card[3] + 24];
    const boxes = Object.fromEntries(Object.entries({ build, tests }).map(([key, box]) => [key, box.map((n) => n * scale)]));
    return { card, capture: { png: await page.screenshot({ scale: 'device' }), size: [600 * scale, 300 * scale], frame: frame.map((n) => n * scale), dark: false, scale, boxes } };
  } finally { await browser.close(); }
}

test('a card with round corners loses its outline on all four sides, and the frame trims to its content, at 1x and at 2x', { skip }, async () => {
  const frames = [];
  for (const scale of [1, 2]) {
    const { card, capture } = await roundCardCapture(scale);
    const { report, outPath, dir } = await render(spec([]), capture);
    try {
      assertInvariants(report);
      const panel = p0(report); const css = (box) => box.map((n) => n / scale);
      const [wx, wy, ww, wh] = css(panel.wholeFrame);
      assert.ok(wx > card[0] + 1 && wy > card[1] + 1 && wx + ww < card[0] + card[2] - 1 && wy + wh < card[1] + card[3] - 1, `the whole frame ${css(panel.wholeFrame)} lies inside the border of the card ${card}`);
      assert.ok(wx - card[0] <= 6 && wy - card[1] <= 6, 'and no further in than the border and the arc of a 12 px corner');
      assert.ok(panel.trimmed.right > 0, 'with the border gone the trim takes the blank right part of the card');
      // The four edges of the shown frame, 3 board px deep, clear of the board's own round corners: no pixel of the border or of the page behind the card.
      const png = await readFile(outPath); const k = png.readUInt32BE(16) / report.stage[2];
      const [bx, by, bw, bh] = panel.capture;
      for (const rect of [[bx + 12, by + 0.5, bw - 24, 3], [bx + 12, by + bh - 3.5, bw - 24, 3], [bx + 0.5, by + 12, 3, bh - 24], [bx + bw - 3.5, by + 12, 3, bh - 24]]) {
        const off = await countOffColor({ png, rect: rect.map((v) => Math.round(v * k)), color: [255, 255, 255], tolerance: 6, renderer });
        assert.equal(off.off, 0, `${off.off} of ${off.total} pixels on an edge of the shown frame are not the card's ground`);
      }
      frames.push(css(panel.frame));
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  frames[0].forEach((n, i) => assert.ok(Math.abs(n - frames[1][i]) <= 0.5, `the 2x frame ${frames[1]} is not the 1x frame ${frames[0]}`));
});

test('a lift 20 px inside a round card\'s border keeps the room the captured frame gave its card: the edges that moved in are given it back as air', { skip }, async () => {
  const { card, capture } = await roundCardCapture(1);
  const { report, dir } = await render(spec([{ lift: 'build', title: 'Build' }, { lift: 'tests', title: 'Tests' }]), capture);
  await rm(dir, { recursive: true, force: true });
  assertInvariants(report);
  const panel = p0(report); const [wx, , ww] = panel.wholeFrame; const [cx, , cw] = panel.cleanFrame;
  assert.ok(panel.air.left > 0 && panel.air.right > 0, `air ${JSON.stringify(panel.air)}`);
  assert.ok(wx < card[0] + 4 && wx >= cx && wx + ww <= cx + cw, `the whole frame ${panel.wholeFrame} reaches back over the border, and no further than the frame as captured ${panel.cleanFrame}`);
  assert.ok(panel.lifts.every((l) => !l.clamped) && !report.warnings.includes('a lift was clamped at the frame edge'));
});

test('a pair of one region moves its frame edges alike or not at all: a state the card cannot be entered in keeps both outlines', { skip }, async () => {
  // in the second state a bar stands flush inside the card's left border, so that card keeps its outline
  const first = await roundCardCapture(1);
  const second = await roundCardCapture(1, '<div style="position:absolute;left:0;top:70px;width:60px;height:12px;background:#334155"></div>');
  const both = await render(multi('pair', [[], []]), [first.capture, second.capture]);
  const alike = await render(multi('pair', [[], []]), [first.capture, first.capture]);
  await rm(both.dir, { recursive: true, force: true }); await rm(alike.dir, { recursive: true, force: true });
  assertInvariants(both.report);
  const [a, b] = both.report.panels;
  assert.deepEqual(a.wholeFrame, a.cleanFrame, 'the first panel is not entered alone');
  assert.deepEqual(b.wholeFrame, b.cleanFrame);
  assert.deepEqual(a.frame, b.frame, 'so the two panels show one rectangle');
  const [c, d] = alike.report.panels;
  assert.notDeepEqual(c.wholeFrame, c.cleanFrame, 'two states the card can be entered in are both entered');
  assert.deepEqual(c.frame, d.frame);
});

// A copy of the room a trim keeps beside a lift (page-layout.js `roomRegion`), for a centred card: CSS px.
const roomFor = (size, S) => 4 + (Math.min(3, Math.max(1.06, 1.15 / S)) - 1) * (size + 8) / 2 + 6 / S;

test('a trim leaves the room a card wants at the scale the trimmed frame is drawn at, not the scale the trim began with', { skip }, async () => {
  // about 700 px of content: the frame is drawn near 0.8, where the lift wants more than it does at 1
  const lift = [300, 140, 120, 16]; const far = [900, 230, 60, 16];
  const report = await board([{ lift: 'a', title: 'Left' }, { ghost: 'far' }], { size: [1000, 300], bars: [lift, [820, 60, 160, 16], far], boxes: { a: lift, far } });
  assertInvariants(report);
  const panel = p0(report); const S = panel.capture[2] / panel.frame[2];
  assert.ok(S < 0.9, `the frame is drawn at ${S}`);
  assert.ok(panel.trimmed.left > 0, 'the blank ground left of the lift is trimmed');
  assert.ok(lift[0] - panel.frame[0] >= roomFor(lift[2], S) - 1, `${lift[0] - panel.frame[0]} px stay left of the lift, and its card wants ${roomFor(lift[2], S)} at ${S}`);
  assert.equal(panel.lifts[0].clamped, false);
  assert.ok(!report.warnings.includes('a lift was clamped at the frame edge'));
});

test('a pair drawn small leaves a lift beside a trimmed edge the room its card wants at that size', { skip }, async () => {
  // two tall frames share a height of 360, so each is drawn near half size and its lift wants about twice its box
  const lift = [300, 340, 120, 20]; const bars = [[300, 40, 200, 16], lift, [300, 640, 200, 16]];
  const captures = [await syntheticCapture({ size: [600, 700], bars, boxes: { a: lift } }), await syntheticCapture({ size: [600, 700], bars, boxes: { a: lift } })];
  const { report, dir } = await render(multi('pair', [[{ lift: 'a', title: 'First' }], [{ lift: 'a', title: 'Second' }]]), captures);
  await rm(dir, { recursive: true, force: true });
  assertInvariants(report);
  for (const panel of report.panels) {
    const S = panel.capture[2] / panel.frame[2];
    assert.ok(S < 0.7, `the panel is drawn at ${S}`);
    assert.ok(panel.trimmed.left > 0, 'the blank ground left of the lift is trimmed');
    assert.ok(lift[0] - panel.frame[0] >= roomFor(lift[2], S) - 1, `${lift[0] - panel.frame[0]} px stay left of the lift, and its card wants ${roomFor(lift[2], S)} at ${S}`);
    assert.equal(panel.lifts[0].clamped, false);
  }
  assert.ok(!report.warnings.includes('a lift was clamped at the frame edge'));
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
  assert.ok(Math.abs(p0(report).redactions[0].rect[2] - (80 + 4) * scale) < 1);
  assert.ok(Math.abs(p0(live).redactions[0].rect[2] - (80 + 4) * (p0(live).capture[2] / p0(live).frame[2])) < 1);
  assert.equal(p0(report).source, 'import');
  assert.equal(p0(report).head.origin, true);
});

test('an inspection redaction reaches 12 image pixels for what its box missed, a measured one 2', { skip }, async () => {
  // the box was drawn 10 px inside the bar on every side
  const bars = [[200, 120, 80, 40]]; const box = [210, 130, 60, 20];
  const capture = await syntheticCapture({ bars, boxes: { a: box } });
  const live = await board([{ redact: 'a' }], { bars, boxes: { a: box } });
  const { report, dir } = await render(spec([{ redact: 'a' }]), { ...capture, source: 'import' });
  await rm(dir, { recursive: true, force: true });
  const sizeOf = (panel) => { const S = panel.capture[2] / panel.frame[2]; return panel.redactions[0].rect.slice(2).map((n) => n / S); };
  const [iw, ih] = sizeOf(p0(report)); const [lw, lh] = sizeOf(p0(live));
  assert.ok(Math.abs(iw - (80 + 4)) < 1 && Math.abs(ih - (40 + 4)) < 1, `the inspected fill found the whole bar and stands 2 px off it (${iw} by ${ih})`);
  assert.ok(Math.abs(lw - (60 + 4)) < 1 && Math.abs(lh - (20 + 4)) < 1, `the measured fill is its box and 2 px (${lw} by ${lh})`);
});

test('a redaction over nothing keeps its whole fill', { skip }, async () => {
  const report = await board([{ lift: 'a', title: 'A' }, { redact: 'blank' }], { bars: [[40, 40, 200, 20]], boxes: { a: [40, 40, 200, 20], blank: [200, 80, 180, 24] } });
  assertInvariants(report);
  const panel = p0(report); const S = panel.capture[2] / panel.frame[2];
  assert.equal(panel.redactions.length, 1);
  const [, , w, h] = panel.redactions[0].rect;
  assert.ok(w >= 180 * S && h >= 24 * S, `the fill is ${w} by ${h} board px for a 180 by 24 box drawn at ${S}`);
});

for (const scale of [1, 2]) {
  test(`two fills on neighbouring lines stand apart and cover their content alone, at ${scale}x`, { skip }, async () => {
    // two rows 20 px tall with no gap, each holding a 12 px bar: the fills are the bars and 2 px
    const bars = [[60, 64, 90, 12], [60, 84, 150, 12]];
    const { report, dir } = await render(spec([{ redact: 'a' }, { redact: 'b' }]), await syntheticCapture({ bars, boxes: { a: [40, 60, 400, 20], b: [40, 80, 400, 20] }, scale }));
    await rm(dir, { recursive: true, force: true });
    const panel = p0(report); const S = panel.capture[2] / (panel.frame[2] / scale);
    const css = (rect) => [(rect[0] - panel.capture[0]) / S + panel.frame[0] / scale, (rect[1] - panel.capture[1]) / S + panel.frame[1] / scale, rect[2] / S, rect[3] / S];
    const [a, b] = panel.redactions.map((r) => css(r.rect));
    [[a, bars[0]], [b, bars[1]]].forEach(([fill, bar]) => fill.forEach((n, i) => assert.ok(Math.abs(n - [bar[0] - 2, bar[1] - 2, bar[2] + 4, bar[3] + 4][i]) < 0.75, `fill ${fill} against bar ${bar}`)));
    assert.ok(b[1] - (a[1] + a[3]) >= 3, 'ground shows between the two fills');
  });
}

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

test('an imported panel is never given painted air and never grows', { skip }, async () => {
  // a bar flush against the left edge, which the frame moves in past, and one 4 px inside the top edge, where a live frame would be given air
  const given = [20, 20, 300, 160]; const bar = [20, 60, 120, 16];
  const ticket = { ...(await syntheticCapture({ size: [600, 300], bars: [bar, [200, 120, 80, 16], [230, 24, 60, 10]], boxes: { a: [200, 120, 80, 16] } })), frame: given, source: 'import' };
  const { report, dir } = await render(spec([{ lift: 'a', title: 'Marked' }]), ticket);
  try {
    assertInvariants(report);
    const panel = p0(report);
    assert.deepEqual(panel.air, { left: 0, top: 0, right: 0, bottom: 0 });
    assert.ok(inside(panel.frame, given, 0.5), `the shown frame ${panel.frame} left the frame the spec gave`);
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
    assert.deepEqual(p0(report).frame, [428, 88, 72, 124], 'the frame only shrank: to 12 px of ground round what it holds, and not at all on the edge that cuts');
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
  lifts: lifts.map(({ rect, source, pad = [0, 0, 0, 0] }) => ({ k: 1.1, tiny: false, rect, source: source.map((n) => n * scale), pad: pad.map((n) => n * scale) })),
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
  const smaller = { left: 0, top: 12, right: 0, bottom: 12 };
  assert.deepEqual(trimmedCss(mixed.panels[0]), smaller, 'the 1x panel takes the smaller of the two trims');
  assert.deepEqual(trimmedCss(mixed.panels[1]), smaller, 'and so does the 2x panel');
  assert.deepEqual(flat.panels.map(trimmedCss), [smaller, smaller], 'which is what the 1x board gives');
  assert.deepEqual(mixed.panels.map((p) => p.frame.map((n) => n / p.scale)), flat.panels.map((p) => p.frame), 'so both show one region');
});

// An image of 2x the pixels whose blank ground is an odd number of device pixels, which no CSS length at 2x gives.
const edges = ([x, y, w, h]) => [[x, y, w, 4], [x, y + h - 4, w, 4], [x, y, 4, h], [x + w - 4, y, 4, h]];

test('blank ground of half a CSS pixel is read in a 2x panel as its 1x twin would read it, so both panels trim whole CSS pixels', { skip }, async () => {
  const first = await cardCapture([30, 24, 540, 252], [60, 50, 480, 200], 1);
  const inner = [120, 140, 960, 340];
  // the odd pixels lie above and below: at the sides the lifts' cards want the room, so neither panel trims there
  const image = await syntheticCapture({ size: [1200, 600], bars: [...edges([80, 41, 1040, 518]), inner], boxes: { a: inner } });
  const report = await pairOf([first, { ...image, scale: 2 }]);
  const [a, b] = report.panels;
  assert.deepEqual(a.trimmed, { left: 0, top: 8, right: 0, bottom: 8 }, 'the 1x panel takes the smaller trim, and no more than its own blank ground');
  assert.deepEqual(b.trimmed, { left: 0, top: 16, right: 0, bottom: 16 }, 'the 2x panel has 20.5 CSS pixels of ground and keeps 12.5: the half pixel is not blank at 1x');
  assert.ok(a.trimmed.top <= 12 && b.trimmed.top <= 17, 'neither trims past its own blank ground');
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

test('a frame is never drawn above its CSS size, at 1x and at 2x', { skip }, async () => {
  for (const scale of [1, 2]) {
    const { report, dir } = await render(spec([{ lift: 'a', title: 'First' }]), await syntheticCapture({ size: [320, 200], bars: [[40, 40, 120, 20]], boxes: { a: [40, 40, 120, 20] }, scale }));
    try {
      const panel = p0(report);
      assert.ok(panel.capture[2] <= 320 + 0.5, `a ${scale}x frame 320 CSS px wide is drawn ${panel.capture[2]} board px wide`);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test('two lifts of one panel share one scale, whatever their sizes', { skip }, async () => {
  // a wide frame drawn at 0.55: a one-line lift and a two-line lift, far apart, with room around both
  const bars = [[60, 60, 140, 16], [60, 84, 140, 16], [640, 60, 120, 16]];
  const { report, dir } = await render(spec([{ lift: ['a', 'b'], title: 'Two lines' }, { lift: 'c', title: 'One line' }]),
    await syntheticCapture({ size: [1100, 240], bars, boxes: { a: bars[0], b: bars[1], c: bars[2] } }));
  try {
    assertInvariants(report);
    const lifts = p0(report).lifts;
    assert.equal(lifts.length, 2);
    assert.ok(Math.abs(lifts[0].k - lifts[1].k) < 1e-6, `scales ${lifts.map((l) => l.k)}`);
    const s = p0(report).capture[2] / p0(report).frame[2];
    assert.ok(lifts[0].k >= 1 - 1e-6, 'a lift is never drawn smaller than the page under it');
    assert.ok(lifts[0].k * s <= LIFT_CSS + 1e-6, 'and at 1.15 at most');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a lift gives up enlargement before it covers the line above or below', { skip }, async () => {
  // three lines 24 px apart (8 px of ground between them); lifting the middle one at 1.15 would cover its neighbours
  const bars = [[40, 40, 200, 16], [40, 64, 200, 16], [40, 88, 200, 16]];
  const { report, dir } = await render(spec([{ lift: 'b', title: 'Middle' }, { ghost: 'hold' }]), await syntheticCapture({ size: [740, 200], bars: [...bars, holdOf([740, 200])], boxes: { a: bars[0], b: bars[1], c: bars[2], hold: holdOf([740, 200]) } }));
  try {
    assertInvariants(report);
    const [lift] = p0(report).lifts; const S = p0(report).capture[2] / p0(report).frame[2];
    assert.ok(lift.k < LIFT_CSS / S - 0.05, `the lift gave up enlargement (k ${lift.k})`);
    const ring = 3 / S; const top = p0(report).frame[1] + (lift.rect[1] - p0(report).capture[1]) / S;
    assert.ok(top - ring >= (40 + 16) - 0.5 / S, 'the card and its ring stay below the line above');
    assert.ok(top + lift.rect[3] / S + ring <= 88 + 0.5 / S, 'and above the line below');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a lift beside the frame edge keeps its ring inside the frame', { skip }, async () => {
  const bars = [[8, 60, 160, 20]];
  const { report, dir } = await render(spec([{ lift: 'a', title: 'At the edge' }]), await syntheticCapture({ size: [400, 200], bars, boxes: { a: bars[0] } }));
  try {
    assertInvariants(report);
    const [lift] = p0(report).lifts; const cap = p0(report).capture;
    assert.ok(lift.rect[0] - 3 >= cap[0] - 0.5, 'the ring is inside the frame');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a lift with one K limited by what fits the frame leaves its sibling at that same K', { skip }, async () => {
  // the wide lift fills its frame, so it fits below 1.15; the small one has room for more and must not take it
  const bars = [[20, 60, 640, 20], [150, 160, 60, 16]];
  const { report, dir } = await render(spec([{ lift: 'a', title: 'Wide' }, { lift: 'b', title: 'Small' }]), await syntheticCapture({ size: [680, 260], bars, boxes: { a: bars[0], b: bars[1] } }));
  try {
    assertInvariants(report);
    const lifts = p0(report).lifts; const S = p0(report).capture[2] / p0(report).frame[2];
    assert.equal(lifts.length, 2);
    assert.ok(lifts.every((lift) => !lift.tiny), 'both are sized lifts');
    assert.ok(Math.abs(lifts[0].k - lifts[1].k) < 1e-6, `scales ${lifts.map((l) => l.k)}`);
    assert.ok(lifts[0].k < LIFT_CSS / S - 0.02, 'the wide lift held the scale below what was wanted');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a tiny lift beside a sized one draws at the panel\'s one scale, even where it holds less than a lift on another row, at 1x and at 2x', { skip }, async () => {
  // The top line has open ground to 1.15. The second row pairs a sized line with a short line set between two lines
  // 5 px above and below it, which its card covers once enlarged.
  const top = [60, 40, 120, 16]; const sized = [60, 150, 120, 14]; const tiny = [300, 151, 60, 10];
  const bars = [top, sized, tiny, [300, 136, 60, 10], [300, 166, 60, 10]];
  const boards = await twinBoards([{ lift: 'a', title: 'Top' }, { lift: 'b', title: 'Sized' }, { lift: 't', title: 'Tiny' }, ...holdMarks],
    { size: [640, 300], bars, boxes: { a: top, b: sized, t: tiny, ...holdBoxes([640, 300]) } });
  for (const report of boards) {
    const { lifts } = p0(report);
    assert.equal(lifts.length, 3);
    assert.ok(lifts.every((lift) => !lift.tiny), 'the short line is drawn as a sized lift beside its row');
    assert.ok(lifts.every((lift) => Math.abs(lift.k - lifts[0].k) < 1e-6), `scales ${lifts.map((l) => l.k)}`);
    assert.ok(lifts[0].k < LIFT_CSS - 0.02, 'the short line held the top line below what it has room for');
    assertInvariants(report);
  }
});

test('on a frame drawn at 0.55 a two-line lift covers neither line beside it, or is drawn at 1', { skip }, async () => {
  // neighbours one line above and below; a far lift keeps the frame wide, and a low line keeps it under 10 to 1, so no strip
  const bars = [[60, 38, 140, 16], [60, 60, 140, 16], [60, 82, 140, 16], [60, 104, 140, 16], [1400, 60, 60, 16], [1400, 200, 60, 16]];
  const { report, dir } = await render(spec([{ lift: ['b', 'c'], title: 'Two lines' }, { lift: 'far', title: 'Far' }]),
    await syntheticCapture({ size: [1500, 240], bars, boxes: { a: bars[0], b: bars[1], c: bars[2], d: bars[3], far: bars[4] } }));
  try {
    assertInvariants(report);
    const panel = p0(report); const S = panel.capture[2] / panel.frame[2];
    assert.ok(S < 0.56, `the frame is drawn at ${S}`);
    const lift = panel.lifts.find((l) => l.keys.includes('b'));
    const top = panel.frame[1] + (lift.rect[1] - panel.capture[1]) / S; const ring = 3 / S;
    const clear = top - ring >= 38 + 16 - 0.5 / S && top + lift.rect[3] / S + ring <= 104 + 0.5 / S;
    assert.ok(clear || Math.abs(lift.k - 1) < 1e-6, `k ${lift.k} covers a neighbouring line`);
    assert.ok(lift.k >= 1 - 1e-6);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('two wide lifts side by side on a frame drawn at 0.55 do not overlap', { skip }, async () => {
  // at 1.64 times the capture each card is wider than the gap between their centres
  const bars = [[200, 80, 300, 16], [550, 80, 300, 16], [1400, 80, 60, 16]];
  const { report, dir } = await render(spec([{ lift: 'a', title: 'Left' }, { lift: 'b', title: 'Right' }, { lift: 'far', title: 'Far' }]),
    await syntheticCapture({ size: [1500, 200], bars, boxes: { a: bars[0], b: bars[1], far: bars[2] } }));
  try {
    assertInvariants(report);
    const lifts = p0(report).lifts;
    assert.equal(lifts.length, 3, 'no two merged');
    const [a, b] = lifts;
    assert.equal(intersects(a.rect, b.rect), false, 'the two wide cards do not overlap');
    assert.equal(report.warnings.includes('two lifts overlap'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('two lifts in one row send both labels the same way, on straight leaders', { skip }, async () => {
  const bars = [[40, 60, 160, 20], [420, 60, 160, 20]];
  const { report, dir } = await render(spec([{ lift: 'a', title: 'Left' }, { lift: 'b', title: 'Right' }]), await syntheticCapture({ size: [640, 160], bars, boxes: { a: bars[0], b: bars[1] } }));
  try {
    assertInvariants(report);
    const panel = p0(report);
    assert.equal(panel.side, 'bottom', 'the right is closed to the left lift, so both go below');
    for (const leader of panel.leaders) assert.equal(leader.points.length, 2, 'a label that can stand under its dot gets a straight leader');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the panels of a pair send their labels the same way', { skip }, async () => {
  const right = [[220, 60, 140, 20]]; const low = [[40, 180, 140, 20]];
  const pair = { state: 'BEFORE → AFTER', title: 'Pair', layout: 'pair', out: 'o.png', panels: [
    { label: 'BEFORE', capture: 'c1.json', marks: [{ lift: 'a', title: 'One' }] }, { label: 'AFTER', capture: 'c2.json', marks: [{ lift: 'a', title: 'Two' }] }] };
  const { report, dir } = await render(pair, [
    await syntheticCapture({ size: [400, 240], bars: [...right, [40, 200, 80, 12]], boxes: { a: right[0] } }),
    await syntheticCapture({ size: [400, 240], bars: [...low, [300, 30, 60, 12]], boxes: { a: low[0] } })]);
  try {
    assertInvariants(report);
    assert.equal(report.pinned, false);
    assert.equal(report.panels[0].side, report.panels[1].side);
    assert.equal(report.panels[0].side, report.side);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// The leader accent, #6E56CF.
const ACCENT = [0x6E, 0x56, 0xCF];

test('a leader on a dark frame is light inside the frame, and keeps the accent outside it', { skip }, async () => {
  const { report, dir, outPath } = await render(spec([{ lift: 'a', title: 'First' }]), await syntheticCapture({ dark: true }));
  try {
    assertInvariants(report);
    const panel = p0(report); const [leader] = panel.leaders; const cap = panel.capture;
    const [[x0, y0], [x1, y1]] = leader.points;
    // a point of the first segment 6 board px out from the dot, which is still inside the frame
    const along = Math.abs(y1 - y0) < 0.01 ? [x0 + 6, y0] : [x0, y0 + 6];
    assert.ok(along[0] < cap[0] + cap[2] && along[1] < cap[1] + cap[3], 'the sample lies inside the frame');
    // the same segment 6 board px past the frame's edge, short of the leader's first turn and of its label
    const beyond = Math.abs(y1 - y0) < 0.01 ? [cap[0] + cap[2] + 6, y0] : [x0, cap[1] + cap[3] + 6];
    assert.ok(beyond[0] <= x1 + 0.01 && beyond[1] <= y1 + 0.01, 'the second sample lies on the first segment, outside the frame');
    const png = await readFile(outPath); const device = png.readUInt32BE(16) / report.stage[2];
    const { at } = await readPixels({ png, renderer, points: [along, beyond].map((point) => point.map((v) => v * device)) });
    assert.ok(at[0][0] > 170 && at[0][2] > 235, `the stroke inside a dark frame is ${at[0]}, not the light accent`);
    assert.ok(ACCENT.every((v, c) => Math.abs(at[1][c] - v) <= 12), `the stroke outside the frame is ${at[1]}, not the accent`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a bracket on a dark frame is drawn in the light stroke', { skip }, async () => {
  const { report, dir, outPath } = await render(spec([{ bracket: ['r1', 'r2'], title: 'Two rows' }]), await syntheticCapture({ dark: true, bars: rows, boxes: rowBoxes }));
  try {
    assertInvariants(report);
    const panel = p0(report); const [bracket] = panel.brackets;
    assert.equal(bracket.inMargin, false, 'the bracket stands inside the frame');
    const [x, y, w, h] = bracket.rect;
    // on the upright, a quarter of the way down: clear of the arms and of a leader that leaves its middle or its foot
    const upright = [x + w, y + h / 4];
    const png = await readFile(outPath); const device = png.readUInt32BE(16) / report.stage[2];
    const { at } = await readPixels({ png, renderer, points: [upright.map((v) => v * device)] });
    assert.ok(at[0][0] > 170 && at[0][2] > 235, `the bracket on a dark frame is ${at[0]}, not the light accent`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a board whose only mark is an untitled loupe with a long empty run to its right keeps its leader', { skip }, async () => {
  // A stroke lies under the ring and the run to the right is long: a long run over empty ground is no tangle, so the lens stands to the right.
  const bars = [[102, 102, 4, 4], [60, 180, 120, 2], [300, 20, 60, 12], [20, 20, 20, 10]];
  const pair = { state: 'BEFORE → AFTER', title: 'Pair', layout: 'pair', out: 'o.png', panels: [
    { label: 'BEFORE', capture: 'c1.json', marks: [{ loupe: 'a' }] }, { label: 'AFTER', capture: 'c2.json', marks: [] }] };
  const { report, dir } = await render(pair, [await syntheticCapture({ size: [400, 240], bars, boxes: { a: [100, 100, 10, 10] } }), await syntheticCapture({ size: [400, 240], bars })]);
  try {
    assertInvariants(report);
    assert.deepEqual([report.side, report.pinned], ['right', false]);
    assert.equal(report.panels[0].labels.length, 0);
    assert.equal(report.panels[0].leaders.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a bracket whose label stands below carries its upright straight on to the label', { skip }, async () => {
  // The block beside the rows lies across the way right, so the label stands below.
  const report = await board([{ bracket: ['r1', 'r2'], title: 'Two rows' }], { bars: [...rows, [300, 50, 30, 60]], boxes: rowBoxes });
  assertInvariants(report);
  const panel = p0(report); const [bracket] = panel.brackets; const [leader] = panel.leaders;
  assert.equal(panel.side, 'bottom');
  assert.equal(leader.points.length, 2, 'the leader is straight');
  assert.ok(Math.abs(leader.points[0][0] - (bracket.rect[0] + bracket.rect[2])) < 0.01, 'it leaves the foot of the upright, not the middle of the arm');
});

test('a lone lift or bracket with open ground on both sides labels to the right', { skip }, async () => {
  const lift = await board([{ lift: 'tiny', title: 'Tiny' }], { bars: [[302, 142, 4, 4]], boxes: { tiny: [300, 140, 10, 10] } });
  assertInvariants(lift);
  const liftRun = p0(lift).capture[0] + p0(lift).capture[2] - (p0(lift).lifts[0].rect[0] + p0(lift).lifts[0].rect[2]);
  const liftDrop = p0(lift).capture[1] + p0(lift).capture[3] - (p0(lift).lifts[0].rect[1] + p0(lift).lifts[0].rect[3]);
  assert.ok(liftDrop < liftRun && liftDrop >= liftRun / 2, `the way down (${liftDrop}) is shorter than the way right (${liftRun}), but not under half of it`);
  assert.deepEqual([lift.side, lift.pinned], ['right', false]);
  assert.equal(p0(lift).leaders[0].points.length, 2, 'on a straight leader');
  const bracket = await board([{ bracket: ['r1', 'r2'], title: 'Two rows' }], { bars: rows, boxes: rowBoxes });
  assertInvariants(bracket);
  assert.deepEqual([bracket.side, bracket.pinned], ['right', false]);
  assert.equal(p0(bracket).leaders[0].points.length, 2, 'on a straight leader');
});

test('a link whose connector would run long makes a pinned board, and one whose lifts stand close does not', { skip }, async () => {
  const apart = [[40, 40, 60, 20], [420, 220, 60, 20]];
  const far = await board([{ link: ['a', 'b'], title: 'Same fact, two places' }], { size: [600, 400], bars: apart, boxes: { a: apart[0], b: apart[1] } });
  assertInvariants(far);
  assert.equal(far.pinned, true, 'no side takes the connector without a long run');
  const close = [[100, 100, 60, 20], [166, 100, 60, 20]];
  const near = await board([{ link: ['a', 'b'], title: 'Linked' }], { bars: close, boxes: { a: close[0], b: close[1] } });
  assertInvariants(near);
  assert.equal(near.pinned, false);
  assert.equal(p0(near).connectors.length, 1);
});

// Three columns of three lines over one full line, 708 by 330: the middle line of the middle column has content
// to its right and below it at every spot. A ghost slot in each of two opposite corners keeps the whole capture in the
// frame, where a single board would crop to its marks and leave the lift a clean way out.
const GRID_SIZE = [708, 330];
const gridLines = [];
for (let c = 0; c < 3; c += 1) for (let r = 0; r < 3; r += 1) gridLines.push([40 + c * 190, 90 + r * 24, 150, 14]);
const gridBars = [...gridLines, [40, 170, 530, 14]];
const holdMarks = [{ ghost: 'holdA' }, { ghost: 'holdB' }];
const holdBoxes = ([w, h]) => ({ holdA: [6, 6, 16, 8], holdB: [w - 22, h - 14, 16, 8] });
const gridBoard = (marks, boxes, { bars = [], dark = false } = {}) => board([...marks, ...holdMarks], { dark, size: GRID_SIZE, bars: [...gridBars, ...bars], boxes: { ...boxes, ...holdBoxes(GRID_SIZE) } });
// The same on a frame more than 2.2 times as wide as it is tall: four columns, 900 by 180.
const WIDE_SIZE = [900, 180];
const wideLines = [];
for (let c = 0; c < 4; c += 1) for (let r = 0; r < 3; r += 1) wideLines.push([40 + c * 210, 40 + r * 24, 170, 14]);
const wideBoard = (marks, boxes) => board([...marks, ...holdMarks], { size: WIDE_SIZE, bars: [...wideLines, [40, 120, 800, 14]], boxes: { ...boxes, ...holdBoxes(WIDE_SIZE) } });
// A copy of the pin's white ring in lib/compose/page.mjs (.pin box-shadow), kept apart so the check does not read the code it checks.
const PIN_RING = 2;
// The part of a lift's card that shows its element, without the padding round it.
const wordsOf = (lift) => {
  const [L, T, W] = lift.rect; const [, , w, h] = lift.source; const [left, top, right] = lift.pad;
  const f = W / (w + left + right);
  return [L + left * f, T + top * f, w * f, h * f];
};

test('a point boxed in by content gets a pin and a numbered label, and no leader', { skip }, async () => {
  // a grid: three columns of three lines over a full line; the lift is the middle line of the middle column
  const report = await gridBoard([{ lift: 'm', title: 'Middle of the grid' }], { m: gridLines[4] });
  assertInvariants(report);
  const panel = p0(report);
  assert.equal(report.pinned, true);
  assert.equal(panel.pins.length, 1);
  assert.equal(panel.labels[0].number, 1);
  assert.ok(!report.warnings.some((w) => /leader|connector|dot/.test(w)), `a pinned board warns about leaders: ${report.warnings}`);
});

test('pins number the points in reading order and every lift of a point carries its number', { skip }, async () => {
  // mark 0 lifts the first line of column 1 and the last line of column 3; mark 1 the middle of the grid
  const report = await gridBoard([{ lift: ['p', 'q'], title: 'Two places' }, { lift: 'm', title: 'Middle' }], { p: gridLines[0], q: gridLines[8], m: gridLines[4] });
  assertInvariants(report);
  const panel = p0(report);
  assert.equal(report.pinned, true);
  const numberOf = (mark) => [...new Set(panel.pins.filter((pin) => panel.targets[pin.target].mark === mark).map((pin) => pin.number))];
  assert.deepEqual(numberOf(0), [1], 'both lifts of the first point carry 1');
  assert.equal(panel.pins.filter((pin) => pin.number === 1).length, 2);
  assert.deepEqual(numberOf(1), [2]);
  assert.deepEqual(panel.labels.map((label) => label.number), [1, 2]);
  const [one, two] = panel.labels.map((label) => label.rect);
  assert.ok(two[1] >= one[1] + one[3] || two[0] >= one[0] + one[2], 'the legend runs in number order');
});

test('a board with clean room keeps its leaders', { skip }, async () => {
  const { report, dir } = await render(spec([{ lift: 'a', title: 'First' }]), await syntheticCapture());
  try { assertInvariants(report); assert.equal(report.pinned, false); assert.equal(p0(report).pins.length, 0); assert.equal(p0(report).leaders.length, 1); } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a board with marks but no titles draws neither pins nor a legend', { skip }, async () => {
  const { report, dir } = await render(spec([{ lift: 'a' }]), await syntheticCapture());
  try { assertInvariants(report); assert.equal(report.pinned, false); assert.equal(p0(report).pins.length, 0); assert.equal(p0(report).labels.length, 0); } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the same grid cropped to its marks leaves the lift a clean way out, and it keeps its leader', { skip }, async () => {
  // Without the slots that hold the frame the board shows the middle column alone, with open ground to its right.
  const report = await board([{ lift: 'm', title: 'Middle of the grid' }], { size: GRID_SIZE, bars: gridLines, boxes: { m: gridLines[4] } });
  assertInvariants(report);
  assert.deepEqual([report.side, report.pinned], ['right', false]);
  assert.equal(p0(report).leaders.length, 1);
});

test('a long run over empty ground keeps its leader: only content in the way earns pins', { skip }, async () => {
  // The block under the lift leaves no clean way down, and the slot in the far corner keeps the whole frame, so the way right is long.
  const bars = [[40, 40, 100, 20], [40, 64, 160, 40]];
  const boxes = { a: bars[0], far: [540, 150, 30, 10] };
  const open = await board([{ lift: 'a', title: 'Far from its label' }, { ghost: 'far' }], { size: [600, 200], bars, boxes });
  assertInvariants(open);
  const [leader] = p0(open).leaders;
  const run = leader.points[1][0] - leader.points[0][0];
  assert.ok(run > 160 && run > p0(open).capture[2] / 2, `the run to the right (${run}) is a long one`);
  assert.deepEqual([open.side, open.pinned], ['right', false], 'a long leader that strikes nothing is no tangle');
  assert.equal(leader.points.length, 2, 'on a straight leader');
  assert.equal(p0(open).pins.length, 0);
  // The same board with a block across the way right has no clean way out.
  const shut = await board([{ lift: 'a', title: 'Boxed in' }, { ghost: 'far' }], { size: [600, 200], bars: [...bars, [300, 20, 20, 80]], boxes });
  assertInvariants(shut);
  assert.equal(shut.pinned, true);
  assert.equal(p0(shut).pins.length, 1);
});

test('a lift on a tinted pill keeps its leader: the pill it leaves and the page it reaches are both ground', { skip }, async () => {
  // The words stand on a pill of their own colour, 40px of it to their right and 12px below, and the page past it is white.
  const words = [100, 100, 100, 16]; const pill = [88, 88, 152, 40, '#e0e7ff'];
  const boxes = { a: words, ...holdBoxes(GRID_SIZE) };
  const { report, dir } = await render(spec([{ lift: 'a', title: 'On a pill' }, ...holdMarks]), await syntheticCapture({ size: GRID_SIZE, bars: [words], tints: [pill, [...words, '#334155']], boxes }));
  try {
    assertInvariants(report);
    assert.equal(report.pinned, false, 'the edge of the pill is not content in the way');
    assert.equal(p0(report).leaders.length, 1);
    assert.deepEqual(report.warnings, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
  // A block on the page past the pill, to the right and below, is still content.
  const blocks = [[300, 60, 20, 120], [60, 160, 260, 20]];
  const shut = await render(spec([{ lift: 'a', title: 'On a pill' }, ...holdMarks]), await syntheticCapture({ size: GRID_SIZE, bars: [words, ...blocks], tints: [pill, [...words, '#334155']], boxes }));
  try {
    assertInvariants(shut.report);
    assert.equal(shut.report.pinned, true);
  } finally { await rm(shut.dir, { recursive: true, force: true }); }
});

test('a block that runs to the edge of the frame is content, not the ground of the frame', { skip }, async () => {
  // The band to the right of the lift ends a pixel from the frame's edge, so a leader to the right would end on it.
  const bars = [[100, 100, 60, 20], [200, 90, 419, 40], [60, 130, 160, 30]];
  const report = await board([{ lift: 'a', title: 'Beside a band' }, ...holdMarks], { size: GRID_SIZE, bars, boxes: { a: bars[0], ...holdBoxes(GRID_SIZE) } });
  assertInvariants(report);
  assert.equal(report.pinned, true, 'the band is in the way to the right and the block below');
});

test('a loupe on a tinted pill keeps its leader', { skip }, async () => {
  const speck = [140, 104, 8, 8]; const pill = [88, 88, 152, 40, '#e0e7ff'];
  const { report, dir } = await render(spec([{ loupe: 'speck', title: 'On a pill' }, ...holdMarks]), await syntheticCapture({ size: GRID_SIZE, bars: [speck], tints: [pill, [142, 106, 4, 4, '#334155']], boxes: { speck, ...holdBoxes(GRID_SIZE) } }));
  try {
    assertInvariants(report);
    assert.equal(report.pinned, false);
    assert.equal(p0(report).leaders.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a pin stands on the corner of its card, clear of the words in it', { skip }, async () => {
  const report = await gridBoard([{ lift: 'm', title: 'Middle of the grid' }], { m: gridLines[4] });
  assertInvariants(report);
  const panel = p0(report); const [pin] = panel.pins; const [lift] = panel.lifts;
  assert.ok(pin.center[0] < lift.rect[0] + pin.r && pin.center[1] < lift.rect[1] + pin.r, `the pin (${pin.center}) is at the top left corner of its card (${lift.rect})`);
  assert.ok(rectDistance(pin.center, lift.rect) < pin.r, 'the pin overlaps its card');
  const gap = rectDistance(pin.center, wordsOf(lift));
  assert.ok(gap >= pin.r + PIN_RING - 0.5, `the pin and its ring reach ${pin.r + PIN_RING}, and the words begin ${gap} from its centre`);
});

test('the pins of a steps board count through its panels in reading order', { skip }, async () => {
  // The first and third panels hold two points each, the second none with a title: 1 and 2, then 3 and 4.
  const steps = { state: 'FLOW', title: 'Steps', layout: 'steps', out: 'o.png', panels: [
    { label: 'One', capture: 'c1.json', marks: [{ lift: 'q', title: 'Last line' }, { lift: 'm', title: 'Middle line' }] },
    { label: 'Two', capture: 'c2.json', marks: [{ lift: 'm' }] },
    { label: 'Three', capture: 'c3.json', marks: [{ lift: 'm', title: 'Middle again' }, { lift: 'p', title: 'First line' }] }] };
  const capture = () => syntheticCapture({ size: GRID_SIZE, bars: gridBars, boxes: { p: gridLines[0], m: gridLines[4], q: gridLines[8] } });
  const { report, dir } = await render(steps, [await capture(), await capture(), await capture()]);
  try {
    assertInvariants(report);
    assert.equal(report.pinned, true);
    const numbersOf = (panel) => panel.pins.map((pin) => [panel.lifts[panel.targets[pin.target].lift].keys[0], pin.number]).sort((a, b) => a[1] - b[1]);
    assert.deepEqual(report.panels.map(numbersOf), [[['m', 1], ['q', 2]], [], [['p', 3], ['m', 4]]]);
    assert.deepEqual(report.panels.map((panel) => panel.legend.map((entry) => entry.number)), [[1, 2], [], [3, 4]], "each panel's legend lists its own numbers");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a pin moves to the corner of its card where it hides nothing of the page', { skip }, async () => {
  // A line with one beside it and a full line under it, so it is boxed in. A line of text ends above its top left
  // corner, far enough off that the card keeps its scale and near enough that a pin on that corner would cover it.
  const page = [gridLines[4], gridLines[7], gridBars.at(-1)]; const over = [150, 84, 80, 12];
  const scene = (scale) => syntheticCapture({ scale, size: GRID_SIZE, bars: [...page, over], boxes: { m: gridLines[4], ...holdBoxes(GRID_SIZE) } });
  const boardSpec = spec([{ lift: 'm', title: 'Middle of the grid' }, ...holdMarks]);
  const one = await render(boardSpec, await scene(1)); const two = await render(boardSpec, await scene(2));
  try {
    for (const { report } of [one, two]) {
      assertInvariants(report);
      const panel = p0(report); const [pin] = panel.pins; const [lift] = panel.lifts;
      assert.equal(report.pinned, true);
      assert.deepEqual(report.warnings, []);
      const k = panel.capture[2] / panel.frame[2];
      for (const bar of [over, ...page.slice(1)]) {
        const drawn = [panel.capture[0] + (bar[0] * panel.scale - panel.frame[0]) * k, panel.capture[1] + (bar[1] * panel.scale - panel.frame[1]) * k, bar[2] * panel.scale * k, bar[3] * panel.scale * k];
        assert.ok(rectDistance(pin.center, drawn) >= pin.r + PIN_RING - 0.5, `the pin and its ring stand ${rectDistance(pin.center, drawn).toFixed(1)}px from a line of the page`);
      }
      assert.ok(pin.center[0] > lift.rect[0] + lift.rect[2] / 2 || pin.center[1] > lift.rect[1] + lift.rect[3] / 2, `so it has left the top left corner of its card: ${pin.center} on ${lift.rect}`);
      assert.ok(rectDistance(pin.center, lift.rect) < pin.r, 'for another corner');
    }
    const [a] = p0(one.report).pins; const [b] = p0(two.report).pins;
    assert.ok(Math.hypot(a.center[0] - b.center[0], a.center[1] - b.center[1]) <= 2, `the 2x capture's pin stands where the 1x one's does: ${b.center} against ${a.center}`);
  } finally { await rm(one.dir, { recursive: true, force: true }); await rm(two.dir, { recursive: true, force: true }); }
});

test('a pin whose every corner covers the page takes the one that covers the least', { skip }, async () => {
  // Lines lie over all four corners of the card: a thick one over three of them, a hairline over the bottom right.
  const thick = [[150, 96, 80, 12], [150, 134, 80, 12], [380, 96, 60, 12]]; const hair = [384, 138, 40, 2];
  const report = await gridBoard([{ lift: 'm', title: 'Middle of the grid' }], { m: gridLines[4] }, { bars: [...thick, hair] });
  const panel = p0(report); const [pin] = panel.pins; const [lift] = panel.lifts;
  assertInvariants(report);
  assert.equal(report.pinned, true);
  assert.ok(pin.center[0] > lift.rect[0] + lift.rect[2] / 2 && pin.center[1] > lift.rect[1] + lift.rect[3] / 2, `the pin (${pin.center}) stands at the bottom right of its card (${lift.rect})`);
  assert.deepEqual(report.warnings, [], 'page content under a pin is no warning');
});

test('a pin with no spot off its neighbours says so', { skip }, async () => {
  // Three lines, each a point of its own, with a block across their way right: the middle card has a card hard above it and one hard below.
  const bars = [[100, 100, 150, 14], [100, 124, 150, 14], [100, 148, 150, 14], [300, 80, 20, 100]];
  const report = await board([{ lift: 'a', title: 'Upper' }, { lift: 'b', title: 'Middle' }, { lift: 'c', title: 'Lower' }, ...holdMarks], { size: GRID_SIZE, bars, boxes: { a: bars[0], b: bars[1], c: bars[2], ...holdBoxes(GRID_SIZE) } });
  const panel = p0(report);
  assert.equal(report.pinned, true);
  assert.equal(panel.pins.length, 3);
  assert.ok(report.warnings.includes('a pin covers another mark, a redaction or the words of its own card'), `warnings: ${report.warnings}`);
  assert.throws(() => assertInvariants(report), /a pin sits on another mark's target/);
});

test('a pin at the frame edge moves off the words of its card', { skip }, async () => {
  // The lift's card is hard against the left of the frame, so a pin on its corner would be pushed in over the first letters.
  const bars = [[2, 114, 150, 14], [230, 114, 150, 14], [2, 138, 330, 14]];
  const report = await board([{ lift: 'm', title: 'First in its row' }, ...holdMarks], { size: GRID_SIZE, bars, boxes: { m: bars[0], ...holdBoxes(GRID_SIZE), holdA: [30, 6, 16, 8] } });
  assertInvariants(report);
  const panel = p0(report); const [pin] = panel.pins; const [lift] = panel.lifts;
  assert.equal(report.pinned, true);
  assert.ok(lift.rect[0] - panel.capture[0] < pin.r, `the card stands ${lift.rect[0] - panel.capture[0]}px from the frame's edge, less than a pin's radius`);
  const gap = rectDistance(pin.center, wordsOf(lift));
  assert.ok(gap >= pin.r + PIN_RING - 0.5, `the pin and its ring reach ${pin.r + PIN_RING}, and the words begin ${gap} from its centre`);
});

test('a pin keeps off a redaction beside its lift', { skip }, async () => {
  // The fill stands in the gap between the columns, on the corner the pin would take.
  const secret = [190, 92, 16, 12];
  const report = await gridBoard([{ lift: 'm', title: 'Middle of the grid' }, { redact: 'secret' }], { m: gridLines[4], secret }, { bars: [secret] });
  assertInvariants(report);
  const panel = p0(report); const [pin] = panel.pins; const [lift] = panel.lifts;
  assert.equal(report.pinned, true);
  assert.equal(panel.pins.length, 1, 'a redaction carries no pin');
  const fill = panel.redactions.find((r) => rectDistance([lift.rect[0], lift.rect[1]], r.rect) < pin.r);
  assert.ok(fill, "the fill lies within a pin's radius of the card's top left corner");
  assert.ok(rectDistance(pin.center, fill.rect) >= pin.r + PIN_RING - 0.5, 'neither the pin nor its ring touches the fill');
});

test('a pin whose corner another mark holds stands further along its target', { skip }, async () => {
  // The loupe's ring sits just off the top left corner of the lift's card.
  const report = await gridBoard([{ lift: 'm', title: 'Middle of the grid' }, { loupe: 'speck', title: 'A speck' }], { m: gridLines[4], speck: [192, 94, 8, 8] }, { bars: [[194, 96, 4, 4]] });
  assertInvariants(report);
  const panel = p0(report); const [lift] = panel.lifts; const [{ ring }] = panel.loupes;
  assert.equal(report.pinned, true);
  assert.equal(panel.pins.length, 2);
  const liftPin = panel.pins.find((pin) => panel.targets[pin.target].kind === 'lift');
  assert.ok(rectDistance([lift.rect[0], lift.rect[1]], ring) < liftPin.r, "the ring lies within a pin's radius of the card's top left corner");
  assert.ok(rectDistance(liftPin.center, ring) >= liftPin.r - 0.5, "the lift's pin is off the ring");
  assert.ok(rectDistance(liftPin.center, lift.rect) <= liftPin.r + 3 + 1, 'and still on its own card');
});

test('a pin stands against the middle of a bracket and leaves both its arms showing', { skip }, async () => {
  const r1 = [60, 200, 200, 16]; const r2 = [60, 224, 200, 16];
  const report = await gridBoard([{ lift: 'm', title: 'Middle of the grid' }, { bracket: ['r1', 'r2'], title: 'Two rows' }], { m: gridLines[4], r1, r2 }, { bars: [r1, r2] });
  assertInvariants(report);
  const panel = p0(report); const [bracket] = panel.brackets;
  assert.equal(report.pinned, true);
  const pin = panel.pins.find((p) => panel.targets[p.target].kind === 'bracket');
  const [x, y, w, h] = bracket.rect;
  assert.ok(pin.center[0] - pin.r >= x + w, 'the pin stands to the right of the upright');
  assert.ok(Math.abs(pin.center[1] - (y + h / 2)) < 0.5, 'level with its middle');
});

test('a pin beside a loupe takes the corner that hides no page content', { skip }, async () => {
  // The block stands up and to the left of the ring, where its pin would go first.
  const block = [182, 198, 20, 14];
  const mark = [{ lift: 'm', title: 'Middle of the grid' }, { loupe: 'speck', title: 'A speck' }];
  const open = await gridBoard(mark, { m: gridLines[4], speck: [206, 220, 8, 8] }, { bars: [[208, 222, 4, 4]] });
  const shut = await gridBoard(mark, { m: gridLines[4], speck: [206, 220, 8, 8] }, { bars: [[208, 222, 4, 4], block] });
  const ringPin = (report) => p0(report).pins.find((pin) => p0(report).targets[pin.target].kind === 'ring');
  const middle = (report) => { const [x, , w] = p0(report).loupes[0].ring; return x + w / 2; };
  assertInvariants(open); assertInvariants(shut);
  assert.ok(ringPin(open).center[0] < middle(open), 'on open ground the pin stands up and to the left of the ring');
  const panel = p0(shut); const k = panel.capture[2] / panel.frame[2];
  const drawn = [panel.capture[0] + (block[0] - panel.frame[0]) * k, panel.capture[1] + (block[1] - panel.frame[1]) * k, block[2] * k, block[3] * k];
  assert.ok(rectDistance(ringPin(open).center, drawn) < ringPin(open).r, 'which is where the block lies');
  assert.ok(rectDistance(ringPin(shut).center, drawn) >= ringPin(shut).r + PIN_RING, `with the block there the pin stands ${rectDistance(ringPin(shut).center, drawn).toFixed(1)}px clear of it`);
  assert.ok(rectDistance(ringPin(shut).center, panel.loupes[0].ring) <= ringPin(shut).r + 1, 'and still against its ring');
});

// Two rows, each a line with another beside it and a full line under it, so the board is pinned: `upper` and
// `lower` are the lifted lines. `over` lists lines laid round the cards' corners.
const twoRows = (over = []) => {
  const upper = [100, 100, 150, 14]; const lower = [100, 200, 150, 14];
  return { upper, lower, bars: [upper, [290, 100, 150, 14], [40, 140, 540, 14], lower, [290, 200, 150, 14], [40, 240, 540, 14], ...over] };
};
// Which corner of its card a pin stands on, as 'TL', 'TR', 'BL' or 'BR'.
const cornerOf = (panel, pin) => {
  const [x, y, w, h] = panel.targets[pin.target].rect;
  return `${pin.center[1] < y + h / 2 ? 'T' : 'B'}${pin.center[0] < x + w / 2 ? 'L' : 'R'}`;
};
// A capture rect (CSS px) as the panel draws it.
const drawnOn = (panel, [x, y, w, h]) => {
  const k = panel.capture[2] / panel.frame[2];
  return [panel.capture[0] + (x * panel.scale - panel.frame[0]) * k, panel.capture[1] + (y * panel.scale - panel.frame[1]) * k, w * panel.scale * k, h * panel.scale * k];
};
const hidesNothing = (panel, bars) => panel.pins.forEach((pin) => bars.forEach((bar) => {
  const gap = rectDistance(pin.center, drawnOn(panel, bar));
  assert.ok(gap >= pin.r + PIN_RING - 0.5, `pin ${pin.number} and its ring stand ${gap.toFixed(1)}px from a line of the page`);
}));

test('the pins of two cards stand on the same corner when one corner is free for both, at 1x and at 2x', { skip }, async () => {
  // A line ends just above the upper card's top left corner, so alone its pin would take another corner.
  const over = [60, 78, 40, 8];
  const { upper, lower, bars } = twoRows([over]);
  const boards = await twinBoards([{ lift: 'u', title: 'Upper' }, { lift: 'l', title: 'Lower' }, ...holdMarks], { size: GRID_SIZE, bars, boxes: { u: upper, l: lower, ...holdBoxes(GRID_SIZE) } });
  assertSameLayout(...boards, [2]);
  for (const report of boards) {
    const panel = p0(report);
    assert.equal(report.pinned, true);
    assert.deepEqual(report.warnings, []);
    assert.equal(panel.pins.length, 2);
    const [first, second] = panel.pins.map((pin) => cornerOf(panel, pin));
    assert.equal(first, second, `the pins stand on ${first} and ${second}`);
    assert.notEqual(first, 'TL', 'the line over the upper card keeps both off the top left');
    hidesNothing(panel, bars.filter((bar) => bar !== upper && bar !== lower));
  }
});

test('the pins of a steps board stand on one corner across its panels, at 1x and at 2x', { skip }, async () => {
  // One row of the two above on a frame narrow enough that three steps are drawn near their size.
  const size = [400, 200];
  const lifted = [60, 80, 150, 14]; const bars = [lifted, [250, 80, 120, 14], [20, 120, 360, 14]];
  const over = [20, 58, 40, 8];
  const boards = [];
  for (const scale of [1, 2]) {
    const captures = [];
    for (const extra of [[], [over], []]) captures.push(await syntheticCapture({ scale, size, bars: [...bars, ...extra], boxes: { u: lifted, ...holdBoxes(size) } }));
    const { report, dir } = await render(multi('steps', [0, 1, 2].map((i) => [{ lift: 'u', title: `Step ${i + 1}` }, ...holdMarks])), captures);
    await rm(dir, { recursive: true, force: true });
    boards.push({ ...report, imageSizes: captures.map((capture) => capture.size) });
  }
  assertSameLayout(...boards, [2, 2, 2]);
  for (const report of boards) {
    assert.equal(report.pinned, true);
    assert.deepEqual(report.warnings, []);
    const corners = report.panels.map((panel) => panel.pins.map((pin) => cornerOf(panel, pin))).flat();
    assert.equal(corners.length, 3);
    assert.deepEqual(corners, corners.map(() => corners[0]), `the pins stand on ${corners}`);
    assert.notEqual(corners[0], 'TL', "the line over the second step's card keeps every pin off the top left");
    report.panels.forEach((panel, i) => hidesNothing(panel, [...bars, ...(i === 1 ? [over] : [])].filter((bar) => bar !== lifted)));
  }
});

test('the pins of two cards stand on different corners only when no corner is free for both, at 1x and at 2x', { skip }, async () => {
  // Lines over three corners of the upper card leave it only its top right; one over the lower card's top right.
  const upperOver = [[60, 78, 40, 8], [60, 124, 40, 8], [256, 124, 30, 8]]; const lowerOver = [[256, 178, 30, 8]];
  const { upper, lower, bars } = twoRows([...upperOver, ...lowerOver]);
  const boards = await twinBoards([{ lift: 'u', title: 'Upper' }, { lift: 'l', title: 'Lower' }, ...holdMarks], { size: GRID_SIZE, bars, boxes: { u: upper, l: lower, ...holdBoxes(GRID_SIZE) } });
  assertSameLayout(...boards, [2]);
  for (const report of boards) {
    const panel = p0(report);
    assert.equal(report.pinned, true);
    assert.deepEqual(report.warnings, []);
    assert.deepEqual(panel.pins.map((pin) => cornerOf(panel, pin)), ['TR', 'TL']);
    hidesNothing(panel, bars.filter((bar) => bar !== upper && bar !== lower));
  }
});

test('a legend to the right lists its numbers in a column, each label with its tag and note', { skip }, async () => {
  const report = await gridBoard([
    { lift: ['p', 'q'], title: 'Two places', tag: 'CHANGED', note: 'The first line and the last' }, { lift: 'm', title: 'Middle' }, { loupe: 'speck', title: 'A speck' },
  ], { p: gridLines[0], q: gridLines[8], m: gridLines[4], speck: [206, 220, 8, 8] }, { bars: [[208, 222, 4, 4]] });
  assertInvariants(report);
  const panel = p0(report); const cap = panel.capture;
  assert.deepEqual([report.pinned, report.side], [true, 'right']);
  assert.deepEqual(panel.legend.map((entry) => entry.number), [1, 2, 3]);
  assert.ok(panel.legend.every((entry) => Math.abs(entry.rect[0] - panel.legend[0].rect[0]) < 0.01), 'the numbers stand in one column');
  assert.ok(panel.legend[0].rect[0] >= cap[0] + cap[2], 'to the right of the frame');
  assert.ok(Math.abs(panel.legend[0].rect[1] - cap[1]) <= 1, 'from the top of the frame');
  const [noted, plain, lensed] = panel.labels;
  assert.ok(noted.rect[3] > plain.rect[3] + 10, 'a label with a note keeps its second line');
  assert.ok(noted.rect[2] > plain.rect[2], 'and its tag');
  // the number of a plain label is level with its one line
  const second = panel.legend[1].rect;
  assert.ok(Math.abs(second[1] + second[3] / 2 - (plain.rect[1] + plain.rect[3] / 2)) <= 1.5, 'a number is level with the line it names');
  // a lens stands between its number and its label
  const [loupe] = panel.loupes; const number = panel.legend[2].rect;
  assert.ok(loupe.lens[0] >= number[0] + number[2] && lensed.rect[0] >= loupe.lens[0] + loupe.lens[2], 'number, lens, label');
  assert.ok(Math.abs(number[1] + number[3] / 2 - (loupe.lens[1] + loupe.lens[3] / 2)) <= 0.5, 'the number is level with the middle of its lens');
});

test('a legend below a wide frame starts at the left edge of the frame and runs in a row', { skip }, async () => {
  const report = await wideBoard([{ lift: 'm', title: 'Second column' }, { lift: 'n', title: 'Third column', tag: 'NEW' }], { m: wideLines[4], n: wideLines[7] });
  assertInvariants(report);
  const panel = p0(report); const cap = panel.capture;
  assert.deepEqual([report.pinned, report.side], [true, 'bottom']);
  assert.ok(Math.abs(panel.legend[0].rect[0] - cap[0]) <= 1, 'the legend starts at the left edge of the frame');
  assert.ok(panel.legend[0].rect[1] >= cap[1] + cap[3], 'below it');
  assert.ok(Math.abs(panel.legend[1].rect[1] - panel.legend[0].rect[1]) < 0.01, 'the numbers stand in one row');
  assert.ok(panel.legend[1].rect[0] > panel.labels[0].rect[0] + panel.labels[0].rect[2], 'the second number follows the first label');
});

test('a legend below wraps to a second row before it runs past its frame', { skip }, async () => {
  const keys = [1, 4, 7, 10];
  const report = await wideBoard(keys.map((i, n) => ({ lift: `k${i}`, title: `Number ${n + 1} of four long labels in one legend` })), Object.fromEntries(keys.map((i) => [`k${i}`, wideLines[i]])));
  assertInvariants(report);
  const panel = p0(report); const cap = panel.capture;
  assert.deepEqual([report.pinned, report.side], [true, 'bottom']);
  assert.equal(panel.legend.length, 4);
  for (const label of panel.labels) assert.ok(label.rect[0] + label.rect[2] <= cap[0] + cap[2] + 0.5, 'no label of the legend runs past the frame');
  const tops = [...new Set(panel.legend.map((entry) => Math.round(entry.rect[1])))];
  assert.ok(tops.length > 1, 'so the legend takes a second row');
  assert.ok(Math.abs(panel.legend.find((entry) => Math.round(entry.rect[1]) === tops[1]).rect[0] - cap[0]) <= 1, "which starts at the frame's left edge again");
});

test('every panel of a pinned board is pinned, its pins count on from the panel before, and each legend stands under its own panel', { skip }, async () => {
  const pair = { state: 'BEFORE → AFTER', title: 'Pair', layout: 'pair', out: 'o.png', panels: [
    { label: 'BEFORE', capture: 'c1.json', marks: [{ lift: 'm', title: 'Boxed in' }] }, { label: 'AFTER', capture: 'c2.json', marks: [{ lift: 'a', title: 'In the open' }] }] };
  const { report, dir } = await render(pair, [
    await syntheticCapture({ size: GRID_SIZE, bars: gridBars, boxes: { m: gridLines[4] } }),
    await syntheticCapture({ size: GRID_SIZE, bars: [[40, 40, 120, 20], [500, 250, 60, 12]], boxes: { a: [40, 40, 120, 20] } })]);
  try {
    assertInvariants(report);
    assert.deepEqual([report.pinned, report.side], [true, 'bottom']);
    for (const [p, panel] of report.panels.entries()) {
      assert.equal(panel.pins.length, 1);
      assert.equal(panel.leaders.length, 0);
      assert.deepEqual([panel.pins[0].number, ...panel.labels.map((label) => label.number)], [p + 1, p + 1], 'the second panel counts on from the first: no number stands twice on a board');
      assert.ok(Math.abs(panel.legend[0].rect[0] - panel.capture[0]) <= 1, "a panel's legend starts at its own left edge");
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('on a pinned board an untitled loupe keeps a pin and its lens, and an untitled lift gets neither pin nor label', { skip }, async () => {
  const report = await gridBoard([{ lift: 'm', title: 'Middle of the grid' }, { loupe: 'speck' }, { lift: 'p' }], { m: gridLines[4], p: gridLines[0], speck: [206, 220, 8, 8] }, { bars: [[208, 222, 4, 4]] });
  assertInvariants(report);
  const panel = p0(report);
  assert.equal(report.pinned, true);
  assert.equal(panel.lifts.length, 2);
  assert.deepEqual(panel.pins.map((pin) => panel.targets[pin.target].kind).sort(), ['lift', 'ring']);
  assert.equal(panel.labels.length, 1);
  assert.equal(panel.legend.length, 2);
  assert.equal(panel.loupes.length, 1);
});

test('a pin is the accent in a white ring, drawn over its card, on a dark frame as on a light one', { skip }, async () => {
  for (const dark of [false, true]) {
    const { report, dir, outPath } = await render(spec([{ lift: 'm', title: 'Middle of the grid' }, ...holdMarks]), await syntheticCapture({ dark, size: GRID_SIZE, bars: gridBars, boxes: { m: gridLines[4], ...holdBoxes(GRID_SIZE) } }));
    try {
      assertInvariants(report);
      const [pin] = p0(report).pins;
      assert.ok(pin, 'the board is pinned');
      // left of the digit, inside the disc; then the middle of the ring round it
      const points = [[pin.center[0] - 6, pin.center[1]], [pin.center[0] - pin.r - PIN_RING / 2, pin.center[1]]];
      const png = await readFile(outPath); const device = png.readUInt32BE(16) / report.stage[2];
      const { at } = await readPixels({ png, renderer, points: points.map((point) => point.map((v) => v * device)) });
      assert.ok(ACCENT.every((v, c) => Math.abs(at[0][c] - v) <= 12), `the pin's disc is ${at[0]}, not the accent (dark: ${dark})`);
      assert.ok(at[1].slice(0, 3).every((v) => v >= 235), `the pin's ring is ${at[1]}, not white (dark: ${dark})`);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

// A board drawn at one board px per capture px, held whole: a narrow slot with a wide one 3px to its right, so the
// labels leave by the bottom. A block under the wide slot leaves it a clean spot at its left end, 12px from the
// narrow slot's dot. The slots are empty ones, whose own text is their label: a ghost this narrow grows to GHOST_MIN.
const SLOTS_SIZE = [640, 240];
const slotMarks = [{ empty: 'narrow', text: 'Narrow' }, { empty: 'wide', text: 'Wide' }, ...holdMarks];
const slotBoxes = { narrow: [100, 100, 6, 20], wide: [109, 100, 80, 20], ...holdBoxes(SLOTS_SIZE) };
const dotOf = (panel, mark) => panel.dots.find((d) => panel.targets[d.target].mark === mark);

test('a dot whose cleanest spot would touch another dot takes its next clean spot, on a board with leaders', { skip }, async () => {
  // The wide slot has a second clean spot past the block, over a hairline, so the spot at its left end is the cleaner one.
  const report = await board(slotMarks, { size: SLOTS_SIZE, bars: [[127, 124, 30, 16], [160, 180, 40, 2]], boxes: slotBoxes });
  assertInvariants(report);
  const panel = p0(report);
  assert.deepEqual([report.side, report.pinned], ['bottom', false]);
  assert.equal(Math.round(panel.capture[2]), SLOTS_SIZE[0], 'the board is drawn at the size of its capture');
  const [narrow, wide] = [dotOf(panel, 0), dotOf(panel, 1)];
  assert.equal(narrow.slid, 0);
  assert.ok(centresApart(narrow, wide) >= narrow.r + wide.r + 2, `the two dots are ${centresApart(narrow, wide).toFixed(1)}px apart`);
  assert.ok(wide.slid > 0, 'the wide slot\'s dot stands past the block');
  assert.deepEqual(report.warnings, []);
});

test('a dot whose only clean spot another dot has taken sits by content, and the board with leaders says so', { skip }, async () => {
  // The block runs on under the rest of the wide slot, so the spot at its left end is the only clean one.
  const report = await board(slotMarks, { size: SLOTS_SIZE, bars: [[127, 124, 60, 16]], boxes: slotBoxes });
  assertInvariants(report);
  const panel = p0(report);
  assert.deepEqual([report.side, report.pinned], ['bottom', false], 'each dot alone has a clean spot, so the board keeps its leaders');
  assert.ok(centresApart(dotOf(panel, 0), dotOf(panel, 1)) >= 13, 'the dots stand apart');
  assert.deepEqual(report.warnings, ['a leader dot sits on page content']);
});

test('a connector that crosses another mark\'s leader is reported on a board with leaders', { skip }, async () => {
  // The pair's upper lift joins the leader of its lower one along the pair's track, down past the leader of the lift between them.
  const bars = [[170, 40, 50, 13], [90, 72, 50, 13], [180, 104, 50, 13]];
  const report = await board([{ lift: ['s', 'p'], title: 'Pair' }, { lift: 'i', title: 'Between' }], { bars, boxes: { s: bars[0], i: bars[1], p: bars[2] } });
  assertInvariants(report);
  assert.deepEqual([report.side, report.pinned], ['right', false]);
  assert.equal(p0(report).connectors.length, 1);
  assert.deepEqual(report.warnings, ['a connector crosses another leader']);
});

test('both panels of a pair are washed when one has a lift', { skip }, async () => {
  const bars = [[40, 60, 160, 20], [40, 120, 220, 20]];
  const capture = () => syntheticCapture({ size: [400, 240], bars, boxes: { a: bars[0], b: bars[1] } });
  const { report, dir } = await render(multi('pair', [[{ empty: 'b', text: 'Nothing here' }], [{ lift: 'a', title: 'Shown' }]]), [await capture(), await capture()]);
  try { assertInvariants(report); assert.deepEqual(report.panels.map((p) => p.wash), [true, true]); } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a board with no lift washes no panel, and the invariants catch a board washed in part', { skip }, async () => {
  const bars = [[40, 60, 160, 20], [40, 120, 220, 20]];
  const capture = () => syntheticCapture({ size: [400, 240], bars, boxes: { a: bars[0], b: bars[1] } });
  const { report, dir } = await render(multi('pair', [[{ empty: 'b', text: 'Nothing here' }], [{ ghost: 'a', title: 'Gone' }]]), [await capture(), await capture()]);
  try {
    assertInvariants(report);
    assert.deepEqual(report.panels.map((p) => p.wash), [false, false]);
    const partly = { ...report, panels: [{ ...report.panels[0], wash: true }, report.panels[1]] };
    assert.throws(() => assertInvariants(partly), /one panel is washed and another is not/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('two captures of one viewport with overlapping frames show one rectangle', { skip }, async () => {
  const bars = [[40, 20, 300, 14], [40, 80, 200, 20], [40, 250, 300, 14]];
  const first = await syntheticCapture({ size: [600, 300], bars, boxes: { a: bars[1] } });
  const second = { ...(await syntheticCapture({ size: [600, 300], bars, boxes: { a: bars[1] } })), frame: [0, 40, 600, 260] };
  const { report, dir } = await render(multi('pair', [[{ lift: 'a', title: 'One' }], [{ lift: 'a', title: 'Two' }]]), [first, second]);
  try {
    assertInvariants(report);
    assert.deepEqual(report.panels[0].frame, report.panels[1].frame, 'the panels of one viewport show different rectangles');
    assert.ok(report.panels.every((panel) => !intersects(panel.frame, bars[0])), 'no panel shows the line the second frame left out');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Two frames of one viewport, a row apart, that meet in [20, 10, 560, 270]. The extra line stands in the first
// capture alone, inside its own frame.
const ROW_APART = [[20, 10, 560, 290], [20, 0, 560, 280]];
const rowApart = async (extra) => {
  const bars = [[40, 40, 300, 14], [40, 100, 200, 20], [40, 200, 300, 14]];
  const captures = [await syntheticCapture({ bars: [...bars, extra], boxes: { a: bars[1] } }), await syntheticCapture({ bars, boxes: { a: bars[1] } })];
  const { report, dir } = await render(multi('pair', [[{ lift: 'a', title: 'One' }], [{ lift: 'a', title: 'Two' }]]), captures.map((capture, i) => ({ ...capture, frame: ROW_APART[i] })));
  await rm(dir, { recursive: true, force: true });
  assertInvariants(report);
  return report;
};

test('two captures of one viewport show one rectangle when a line stands by an edge in one and not in the other', { skip }, async () => {
  // The line ends 4 px above the shared bottom edge: left to itself that panel alone would be given air there.
  const report = await rowApart([40, 262, 300, 14]);
  const [a, b] = report.panels;
  assert.deepEqual(a.frame, b.frame, 'the panels of one viewport show different rectangles');
  assert.deepEqual(a.wholeFrame, [20, 10, 560, 270], 'both show where the two frames meet');
  assert.deepEqual([a.air, b.air], [{ left: 0, top: 0, right: 0, bottom: 0 }, { left: 0, top: 0, right: 0, bottom: 0 }], 'an edge takes air in both panels or in neither');
  assert.ok(a.frame[1] + a.frame[3] >= 276, 'the line is inside the rectangle both show');
});

test('two captures of one viewport show one rectangle when an edge cuts a line in one and not in the other', { skip }, async () => {
  // The line crosses the shared top edge: left to itself that panel's edge alone would move off it.
  const report = await rowApart([40, 4, 300, 14]);
  const [a, b] = report.panels;
  assert.deepEqual(a.frame, b.frame, 'the panels of one viewport show different rectangles');
  assert.deepEqual([a.cleanFrame, b.cleanFrame], [[20, 10, 560, 270], [20, 10, 560, 270]], 'no edge moves in one panel alone');
  assert.equal(a.frameEdges.top, 'cut');
  assert.ok(report.warnings.includes('a frame edge cuts through content'), 'and the board says an edge cuts');
});

test('one viewport captured at 1x and at 2x with overlapping frames shows one rectangle in CSS pixels', { skip }, async () => {
  const bars = [[40, 20, 300, 14], [40, 80, 200, 20], [40, 250, 300, 14]];
  const first = await syntheticCapture({ bars, boxes: { a: bars[1] } });
  const second = { ...(await syntheticCapture({ bars, boxes: { a: bars[1] }, scale: 2 })), frame: [0, 80, 1200, 520] };
  const { report, dir } = await render(multi('pair', [[{ lift: 'a', title: 'One' }], [{ lift: 'a', title: 'Two' }]]), [first, second]);
  await rm(dir, { recursive: true, force: true });
  assertInvariants(report);
  assert.deepEqual(report.panels.map((p) => p.scale), [1, 2]);
  assert.deepEqual(cssFrames(report)[0], cssFrames(report)[1], 'the panels of one viewport show different rectangles');
  assert.deepEqual(report.panels[0].capture.slice(2), report.panels[1].capture.slice(2));
});

test('a pair of one viewport never shows a panel the page outside its own capture\'s frame, at 1x and at 2x', { skip }, async () => {
  // The second capture's frame leaves out a row the first frame holds; what that row shows in the second image
  // (magenta) was never inspected for that panel. Cyan stands inside both frames, so the count can see a tint.
  // Both are counted as the board's wash leaves them.
  const MAGENTA = [255, 140, 255]; const CYAN = [140, 230, 255];
  const bars = [[40, 80, 200, 20], [40, 250, 300, 14]];
  for (const scale of [1, 2]) {
    const first = await syntheticCapture({ bars, boxes: { a: bars[0] }, scale });
    const second = { ...(await syntheticCapture({ bars, boxes: { a: bars[0] }, scale, tints: [[40, 10, 120, 20, '#ff00ff'], [300, 150, 60, 20, '#00c8ff']] })), frame: [0, 40, 600, 260].map((n) => n * scale) };
    const captures = [first, second];
    const { report, outPath, dir } = await render(multi('pair', [[{ lift: 'a', title: 'One' }], [{ lift: 'a', title: 'Two' }]]), captures);
    try {
      assertInvariants(report);
      const png = await readFile(outPath);
      assert.ok((await readPixels({ png, renderer, colour: CYAN })).near > 0, `the board at ${scale}x shows no tint at all`);
      assert.equal((await readPixels({ png, renderer, colour: MAGENTA })).near, 0, `the board at ${scale}x shows the row the second frame left out`);
      report.panels.forEach((panel, i) => {
        assert.ok(containsBox(captures[i].frame, panel.wholeFrame), `panel ${i + 1} at ${scale}x shows ${panel.wholeFrame}, past its own frame ${captures[i].frame}`);
      });
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test('frames of one viewport that overlap by half of the smaller share where they meet when that holds every mark, and otherwise keep their own', { skip }, async () => {
  // A value to hide, `hidden`, stands in the first capture alone.
  const boardOf = async (frames, bars, marks, hidden = null) => {
    const boxes = { a: bars[0], b: bars[1], r: hidden ?? bars[0] };
    const captures = [await syntheticCapture({ bars: hidden ? [...bars, hidden] : bars, boxes }), await syntheticCapture({ bars, boxes })];
    const { report, dir } = await render(multi('pair', marks), captures.map((capture, i) => ({ ...capture, frame: frames[i] })));
    await rm(dir, { recursive: true, force: true });
    assertInvariants(report);
    return report.panels;
  };
  const HALF = [[0, 0, 400, 300], [200, 0, 400, 300]];
  const lifts = [[{ lift: 'a', title: 'One' }], [{ lift: 'b', title: 'Two' }]];
  const inside = [[220, 60, 160, 20], [220, 200, 140, 20]];
  const half = await boardOf(HALF, inside, lifts);
  assert.deepEqual(half.map((p) => p.wholeFrame), [[200, 0, 200, 300], [200, 0, 200, 300]], 'both show where the frames meet');
  assert.deepEqual(half[0].frame, half[1].frame);
  const hiding = [[{ lift: 'a', title: 'One' }, { redact: 'r' }], lifts[1]];
  const farRedaction = await boardOf(HALF, inside, hiding, [40, 150, 40, 16]);
  assert.deepEqual(farRedaction.map((p) => p.wholeFrame), [[200, 0, 200, 300], [200, 0, 200, 300]], 'a redaction that does not meet where they meet changes nothing');
  const own = [[0, 0, 400, 300], [200, 0, 400, 300]];
  const outside = await boardOf(HALF, [[40, 60, 160, 20], inside[1]], lifts);
  assert.deepEqual(outside.map((p) => p.wholeFrame), own, 'a lift outside where they meet keeps each panel its own frame');
  const straddling = await boardOf(HALF, inside, hiding, [180, 150, 40, 16]);
  assert.deepEqual(straddling.map((p) => p.wholeFrame), own, 'so does a redaction that meets where they meet and runs past it');
  const fillReaches = await boardOf(HALF, inside, hiding, [160, 150, 39, 16]);
  assert.deepEqual(fillReaches.map((p) => p.wholeFrame), own, 'so does a redaction whose box stops short of where they meet but whose fill reaches it');
  const less = await boardOf([[0, 0, 399, 300], [200, 0, 400, 300]], inside, lifts);
  assert.deepEqual(less.map((p) => p.wholeFrame), [[0, 0, 399, 300], [200, 0, 400, 300]], 'and frames that overlap by less keep their own');
});

test('a pair of wide short panels is stacked at one width', { skip }, async () => {
  const bars = [[40, 30, 300, 16], [40, 90, 200, 20], [900, 150, 300, 16]];
  const capture = () => syntheticCapture({ size: [1400, 220], bars, boxes: { a: bars[1] } });
  const { report, dir } = await render(multi('pair', [[{ lift: 'a', title: 'One' }], [{ lift: 'a', title: 'Two' }]]), [await capture(), await capture()]);
  try {
    assertInvariants(report);
    assert.equal(report.stacked, true);
    const [a, b] = report.panels.map((p) => p.capture);
    assert.ok(Math.abs(a[2] - b[2]) <= 0.5 && Math.abs(a[0] - b[0]) <= 0.5, 'stacked panels share a width and a left edge');
    assert.ok(b[1] >= a[1] + a[3], 'the second panel is below the first');
    assert.equal(a[2], 720, 'at the stack width');
    assert.deepEqual([report.pinned, report.side], [false, 'right'], 'and their labels leave by the right');
    const flat = { ...report, panels: [report.panels[0], { ...report.panels[1], capture: [b[0] + 2, b[1], b[2], b[3]] }] };
    assert.throws(() => assertInvariants(flat), /stacked panels do not line up/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a board in a row reports that it is not stacked, and so does a single board', { skip }, async () => {
  const bars = [[40, 40, 200, 20], [40, 180, 300, 20]];
  const capture = () => syntheticCapture({ size: [400, 240], bars, boxes: { a: bars[0] } });
  const { report, dir } = await render(multi('pair', [[{ lift: 'a', title: 'One' }], [{ lift: 'a', title: 'Two' }]]), [await capture(), await capture()]);
  await rm(dir, { recursive: true, force: true });
  assertInvariants(report);
  assert.equal(report.stacked, false);
  assert.equal((await board([{ lift: 'a', title: 'One' }])).stacked, false);
});

// Two marks at the ends of a strip keep a steps panel whole: a crop round both would cover the frame.
const stripSteps = async (ends) => {
  const bars = [...ends, [40, 150, 300, 16]];
  const captures = [];
  for (let i = 0; i < 3; i += 1) captures.push(await syntheticCapture({ size: [1400, 220], bars, boxes: { a: ends[0], b: ends[1] } }));
  const { report, dir } = await render(multi('steps', captures.map(() => [{ lift: 'a', title: 'Left' }, { lift: 'b', title: 'Right' }])), captures);
  await rm(dir, { recursive: true, force: true });
  assertInvariants(report);
  return report;
};

test('stacked steps are joined by arrows that stand between the panels, centred on their width, and send their labels right', { skip }, async () => {
  const report = await stripSteps([[40, 40, 200, 20], [1100, 100, 200, 20]]);
  assert.equal(report.stacked, true);
  assert.deepEqual([report.pinned, report.side], [false, 'right']);
  assert.equal(report.arrows.length, 2);
  report.arrows.forEach(([x, y, w, h], i) => {
    const [above, below] = [report.panels[i], report.panels[i + 1]];
    assert.ok(Math.abs(x + w / 2 - (below.capture[0] + below.capture[2] / 2)) <= 0.5, 'an arrow is centred on the panel width');
    assert.ok(y >= above.extent[1] + above.extent[3] && y + h <= below.extent[1], 'an arrow stands between the two panels it joins');
  });
  for (const panel of report.panels) for (const label of panel.labels) assert.ok(label.rect[0] >= panel.capture[0] + panel.capture[2], 'a label stands to the right of its panel');
});

test('a stacked board that is pinned puts each panel\'s legend to the right of that panel', { skip }, async () => {
  // Both marks stand in one row, so the way right from the first runs through the second.
  const report = await stripSteps([[40, 70, 200, 20], [1100, 70, 200, 20]]);
  assert.equal(report.stacked, true);
  assert.deepEqual([report.pinned, report.side], [true, 'right']);
  for (const panel of report.panels) {
    assert.equal(panel.legend.length, 2);
    for (const entry of panel.legend) {
      assert.ok(entry.rect[0] >= panel.capture[0] + panel.capture[2], 'a legend number stands to the right of its panel');
      assert.ok(entry.rect[1] >= panel.capture[1] - 0.5 && entry.rect[1] + entry.rect[3] <= panel.extent[1] + panel.extent[3] + 0.5, 'and beside it, not under the board');
    }
  }
});

const stepsOfThree = async (scale) => {
  const filler = Array.from({ length: 12 }, (_, n) => [40 + (n % 4) * 240, 40 + Math.floor(n / 4) * 220, 180, 14]);
  const small = [460, 330, 60, 16]; const wide = [200, 330, 520, 16]; const tall = [[460, 150, 80, 16], [460, 520, 80, 16]];
  const captures = [
    await syntheticCapture({ scale, size: [1000, 700], bars: [...filler, small], boxes: { a: small } }),
    await syntheticCapture({ scale, size: [1000, 700], bars: [...filler, wide], boxes: { a: wide } }),
    await syntheticCapture({ scale, size: [1000, 700], bars: [...filler, ...tall], boxes: { a: tall[0], b: tall[1] } })];
  const { report, dir } = await render(multi('steps', [[{ lift: 'a', title: 'One' }], [{ lift: 'a', title: 'Two' }], [{ lift: 'a', title: 'Three' }, { lift: 'b', title: 'Four' }]]), captures);
  await rm(dir, { recursive: true, force: true });
  assertInvariants(report);
  return report;
};

test('steps crops grow to the largest crop, so the steps share a scale', { skip }, async () => {
  const report = await stepsOfThree(1);
  const cropped = report.panels.filter((p) => p.cropped);
  assert.ok(cropped.length >= 2, 'the small-mark steps are cropped');
  const scales = cropped.map((p) => p.capture[3] / p.frame[3]);
  assert.ok(Math.max(...scales) / Math.min(...scales) < 1.12, `steps of one board are drawn at scales ${scales}`);
});

test('steps crops grow alike on a 2x capture and its 1x twin', { skip }, async () => {
  const [one, two] = [await stepsOfThree(1), await stepsOfThree(2)];
  assert.deepEqual([one.textScale, two.textScale], [1, 1], 'steps are never drawn past CSS size, so their type keeps CSS size');
  assert.deepEqual(two.panels.map((p) => p.cropped), one.panels.map((p) => p.cropped));
  cssFrames(two).forEach((frame, i) => frame.forEach((n, k) => assert.ok(Math.abs(n - cssFrames(one)[i][k]) <= 1, `panel ${i + 1} shows ${frame} at 2x and ${cssFrames(one)[i]} at 1x`)));
  assert.deepEqual(two.panels.map((p) => p.capture), one.panels.map((p) => p.capture));
});

// Three steps on 1000 by 700 captures whose middle lift is wide, so the small lifts' crops grow to its width. The
// third holds a row of words, 34 px long and 6 apart, where its grown crop's left edge would fall, with clean
// ground past the row's end. It guards the shipped settle and does not reproduce the held-edge case.
const grownSteps = async (scale, row) => {
  const small = [460, 330, 60, 16]; const wide = [200, 330, 520, 16];
  const words = Array.from({ length: Math.floor((row[1] - row[0] + 6) / 40) }, (_, n) => [row[0] + 40 * n, 270, 34, 12]);
  const captures = [
    await syntheticCapture({ scale, size: [1000, 700], bars: [small], boxes: { a: small } }),
    await syntheticCapture({ scale, size: [1000, 700], bars: [wide], boxes: { a: wide } }),
    await syntheticCapture({ scale, size: [1000, 700], bars: [small, ...words], boxes: { a: small } })];
  const { report, dir } = await render(multi('steps', [[{ lift: 'a', title: 'One' }], [{ lift: 'a', title: 'Two' }], [{ lift: 'a', title: 'Three' }]]), captures);
  await rm(dir, { recursive: true, force: true });
  return { ...report, imageSizes: captures.map((capture) => capture.size) };
};

test('a steps crop that grew keeps the shipped settle of its edge on clean ground beside a row of words, at 1x and at 2x', { skip }, async () => {
  for (const row of [[46, 200], [126, 280]]) {
    const boards = [await grownSteps(1, row), await grownSteps(2, row)];
    assertSameLayout(...boards, [2, 2, 2]);
    for (const report of boards) {
      const third = report.panels[2];
      assert.equal(third.cropped, true);
      assert.notEqual(third.cropEdges.left, 'margin', `the third step's left edge is held in the row of words (${third.frame})`);
      assert.equal(report.warnings.includes('a crop edge cuts through content'), false, `warnings: ${report.warnings}`);
      const scales = report.panels.filter((p) => p.cropped).map((p) => (p.capture[3] / p.frame[3]) * p.scale);
      assert.ok(Math.max(...scales) / Math.min(...scales) < 1.12, `the cropped steps are drawn at scales ${scales}`);
    }
  }
});

test('a stacked pair lays out the same at 2x as at 1x', { skip }, async () => {
  const bars = [[40, 30, 300, 16], [40, 90, 200, 20], [900, 150, 300, 16]];
  const boardAt = async (scale) => {
    const capture = () => syntheticCapture({ scale, size: [1400, 220], bars, boxes: { a: bars[1] } });
    const { report, dir } = await render(multi('pair', [[{ lift: 'a', title: 'One' }], [{ lift: 'a', title: 'Two' }]]), [await capture(), await capture()]);
    await rm(dir, { recursive: true, force: true });
    assertInvariants(report);
    return report;
  };
  const [one, two] = [await boardAt(1), await boardAt(2)];
  assert.deepEqual([one.stacked, two.stacked], [true, true]);
  assert.deepEqual(cssFrames(two), cssFrames(one));
  assert.deepEqual(two.panels.map((p) => p.capture), one.panels.map((p) => p.capture));
});

// One scene captured at 1x and at 2x, each board with the size of its capture's image, which the twin check reads.
const twinBoards = async (marks, options) => {
  const boards = [];
  for (const scale of [1, 2]) {
    const capture = await syntheticCapture({ ...options, scale });
    const { report, dir } = await render(spec(marks), capture);
    await rm(dir, { recursive: true, force: true });
    boards.push({ ...report, imageSizes: [capture.size] });
  }
  return boards;
};

test('a pair of one region whose lifts sit in different places loses the border and gives both panels the air either wants, at 1x and at 2x', { skip }, async () => {
  // flushCard's left lift wants room by the left edge, its right one by the right and bottom edges: each panel lifts one.
  const boards = [];
  for (const scale of [1, 2]) {
    const capture = await flushCard(scale);
    const { report, dir } = await render(multi('pair', [[{ lift: 'a', title: 'First' }], [{ lift: 'b', title: 'Second' }]]), [capture, capture]);
    await rm(dir, { recursive: true, force: true });
    boards.push({ ...report, imageSizes: [capture.size, capture.size] });
  }
  assertSameLayout(...boards, [2, 2]);
  for (const report of boards) {
    const [a, b] = report.panels; const css = (panel, box) => box.map((n) => n / panel.scale);
    for (const panel of [a, b]) {
      assert.deepEqual(css(panel, panel.cleanFrame), [60, 40, 400, 180], 'the frame was clean as captured');
      assert.deepEqual(css(panel, Object.values(panel.air)), [11, 11, 1, 1], 'the heading wants 11 px left and top, the lifts between them the px the border took on the other two');
      assert.deepEqual(css(panel, panel.wholeFrame), [50, 30, 410, 190], 'the border goes from every side and the air is added');
    }
    assert.deepEqual(a.frame, b.frame, 'both panels show one rectangle');
  }
});

test('a boxed-in lift lays out the same at 2x as at 1x, its card at one scale', { skip }, async () => {
  // The lines above and below stand 10 px off the lifted one: the card gives way until its ring is off them, to a
  // fraction of a CSS px that a 2x capture resolves and its 1x twin does not.
  const [one, two] = await twinBoards([{ lift: 'm', title: 'Middle of the grid' }, ...holdMarks], { size: GRID_SIZE, bars: gridBars, boxes: { m: gridLines[4], ...holdBoxes(GRID_SIZE) } });
  assertSameLayout(one, two, [2]);
  const [k1, k2] = [p0(one).lifts[0].k, p0(two).lifts[0].k];
  assert.ok(k1 < LIFT_CSS / (p0(one).capture[2] / p0(one).frame[2]) - 1e-6, `the card gave way to the lines beside it (k ${k1})`);
  assert.ok(Math.abs(k2 - k1) < 1e-6, `the card is drawn at ${k1} at 1x and at ${k2} at 2x`);
});

test('two lifts in one row are drawn at one scale though the shorter alone would be tiny, at 1x and at 2x', { skip }, async () => {
  // At the frame's scale the taller line, with its padding, reaches a readable height at the wanted K and the shorter does not.
  const tall = [100, 100, 80, 14]; const short = [300, 101, 80, 12];
  const boards = await twinBoards([{ lift: 't', title: 'Taller' }, { lift: 's', title: 'Shorter' }, ...holdMarks], { size: GRID_SIZE, bars: [tall, short], boxes: { t: tall, s: short, ...holdBoxes(GRID_SIZE) } });
  assertSameLayout(...boards, [2]);
  for (const report of boards) {
    const lifts = p0(report).lifts;
    assert.deepEqual(lifts.map((lift) => lift.tiny), [false, false], 'a row with a sized lift has no tiny one');
    assert.ok(Math.abs(lifts[0].k - lifts[1].k) < 1e-6, `the row is drawn at ${lifts.map((lift) => lift.k)}`);
  }
});

test('two tiny lifts in one row are drawn at one scale, the taller at a readable height, at 1x and at 2x', { skip }, async () => {
  const low = [100, 150, 40, 6]; const high = [300, 149, 40, 8];
  const boards = await twinBoards([{ lift: 'l', title: 'Lower' }, { lift: 'h', title: 'Higher' }, ...holdMarks], { size: GRID_SIZE, bars: [low, high], boxes: { l: low, h: high, ...holdBoxes(GRID_SIZE) } });
  assertSameLayout(...boards, [2]);
  for (const report of boards) {
    const lifts = p0(report).lifts;
    assert.deepEqual(lifts.map((lift) => lift.tiny), [true, true]);
    assert.ok(Math.abs(lifts[0].k - lifts[1].k) < 1e-6, `the row is drawn at ${lifts.map((lift) => lift.k)}`);
    assert.ok(lifts[1].rect[3] >= 23.5, `the taller card is ${lifts[1].rect[3]} px tall`);
  }
});

test('a staircase of chips, each half a line below the last, keeps them readable beside a boxed-in lift, at 1x and at 2x', { skip }, async () => {
  // Each chip shares a row with the next alone, and the large lift is held at 1 by the lines round it.
  const chips = [0, 1, 2, 3, 4].map((n) => [60 + n * 80, 100 + n * 4, 40, 8]);
  const big = [480, 116, 100, 30]; const round = [[470, 108, 120, 4], [470, 150, 120, 4], [462, 116, 6, 30], [592, 116, 6, 30]];
  const marks = [...chips.map((_, n) => ({ lift: `c${n}`, title: `Chip ${n}` })), { lift: 'big', title: 'Big' }, ...holdMarks];
  const boxes = { ...Object.fromEntries(chips.map((chip, n) => [`c${n}`, chip])), big, ...holdBoxes(GRID_SIZE) };
  const boards = await twinBoards(marks, { size: GRID_SIZE, bars: [...chips, big, ...round], boxes });
  assertSameLayout(...boards, [2]);
  for (const report of boards) {
    const lifts = p0(report).lifts;
    lifts.slice(0, 5).forEach((chip, n) => assert.ok(chip.tiny && chip.rect[3] >= 23.5, `chip ${n} is ${chip.rect[3].toFixed(1)} px tall (k ${chip.k})`));
    assert.ok(Math.abs(lifts[5].k - 1) < 1e-9, `the boxed-in lift is held at 1 (k ${lifts[5].k})`);
  }
});

test('a chip level with the middle of a tall lift is not in its row, and is raised to a readable height, at 1x and at 2x', { skip }, async () => {
  const tall = [40, 60, 120, 220]; const chip = [500, 150, 40, 8];
  const boards = await twinBoards([{ lift: 't', title: 'Tall' }, { lift: 'c', title: 'Chip' }, ...holdMarks], { size: GRID_SIZE, bars: [tall, chip], boxes: { t: tall, c: chip, ...holdBoxes(GRID_SIZE) } });
  assertSameLayout(...boards, [2]);
  for (const report of boards) {
    const [side, small] = p0(report).lifts;
    assert.equal(side.tiny, false);
    assert.ok(small.tiny && small.rect[3] >= 23.5, `the chip is ${small.rect[3].toFixed(1)} px tall (k ${small.k})`);
  }
});

test('a tiny lift holding a fill gives way when the fill would drift off its place, though nothing lies beside it, at 1x and at 2x', { skip }, async () => {
  const chip = [300, 150, 80, 8]; const secret = [350, 150, 30, 8];
  for (const scale of [1, 2]) {
    const capture = await syntheticCapture({ size: GRID_SIZE, bars: [chip], boxes: { c: chip, s: secret, ...holdBoxes(GRID_SIZE) }, scale });
    const { report, outPath, dir } = await render(spec([{ lift: 'c', title: 'Chip' }, { redact: 's' }, ...holdMarks]), capture);
    try {
      assertInvariants(report);
      const panel = p0(report); const [fill] = panel.redactions; const [lift] = panel.lifts;
      assert.ok(lift.tiny && lift.rect[3] < 23.5 && lift.k > BASE_K, `the card gave way short of a readable height (k ${lift.k})`);
      // An edge of a fill on a card may stand 2 board px inside its place (FILL_SHIFT), and a px more is antialiased.
      const [x0, y0] = [Math.max(lift.rect[0], fill.rect[0]) + 3, Math.max(lift.rect[1], fill.rect[1]) + 3];
      const [x1, y1] = [Math.min(lift.rect[0] + lift.rect[2], fill.rect[0] + fill.rect[2]) - 3, Math.min(lift.rect[1] + lift.rect[3], fill.rect[1] + fill.rect[3]) - 3];
      const png = await readFile(outPath); const px = png.readUInt32BE(16) / report.stage[2];
      const off = await countOffColor({ png, rect: [x0, y0, x1 - x0, y1 - y0].map((v) => Math.round(v * px)), color: [0xCB, 0xD5, 0xE1], tolerance: 24, renderer });
      assert.ok(off.total > 0);
      assert.equal(off.off, 0, `${off.off} of ${off.total} pixels of the fill's place under the card are not the fill, at ${scale}x`);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test('a tiny lift between two neighbours on its line gives way until its card hides no more of them than a stray edge, at 1x and at 2x', { skip }, async () => {
  const chip = [300, 150, 40, 8]; const neighbours = [[230, 150, 60, 8], [350, 150, 60, 8]];
  const boards = await twinBoards([{ lift: 'c', title: 'Chip' }, ...holdMarks], { size: GRID_SIZE, bars: [chip, ...neighbours], boxes: { c: chip, ...holdBoxes(GRID_SIZE) } });
  assertSameLayout(...boards, [2]);
  for (const report of boards) {
    const panel = p0(report); const [lift] = panel.lifts;
    assert.equal(lift.tiny, true);
    assert.ok(lift.k >= BASE_K - 1e-9, `the card stays at the base scale or more (k ${lift.k})`);
    const perCss = (panel.capture[2] / panel.frame[2]) * panel.scale;
    const hidden = neighbours.reduce((sum, bar) => sum + overlapArea(lift.rect, boardOf(panel, bar.map((n) => n * panel.scale))), 0) / perCss ** 2;
    assert.ok(hidden <= STRAY_CSS, `the card hides ${hidden.toFixed(1)} CSS px squared of its neighbours (k ${lift.k})`);
  }
});

// A tab near the top of a tall page, and a value to hide that lies far below it or just beside it.
const TAB = [100, 60, 80, 20];
const FAR_VALUE = [600, 560, 160, 16];
const NEAR_VALUE = [150, 95, 300, 16];
const tabScene = (value) => ({ size: [1000, 700], bars: [TAB, value], boxes: { a: TAB, v: value } });
const holds = (frame, box) => frame[0] <= box[0] && frame[1] <= box[1] && frame[0] + frame[2] >= box[0] + box[2] && frame[1] + frame[3] >= box[1] + box[3];

test('a redaction wholly outside the crop its lift wants leaves that crop as it is, at 1x and at 2x', { skip }, async () => {
  const boards = await twinBoards([{ lift: 'a', title: 'Tab' }, { redact: 'v' }], tabScene(FAR_VALUE));
  const plain = await twinBoards([{ lift: 'a', title: 'Tab' }], tabScene(FAR_VALUE));
  assertSameLayout(...boards, [2]);
  boards.forEach((report, i) => {
    assert.equal(p0(report).cropped, true);
    assert.deepEqual(cssFrames(report), cssFrames(plain[i]), 'the crop is where the lift alone puts it');
    assert.equal(p0(report).redactions.length, 0, 'the redaction lies outside what is shown');
  });
});

test('a redaction that meets the crop its lift wants is taken in whole and filled, at 1x and at 2x', { skip }, async () => {
  const boards = [];
  for (const scale of [1, 2]) {
    const capture = await syntheticCapture({ ...tabScene(NEAR_VALUE), scale });
    const { report, outPath, dir } = await render(spec([{ lift: 'a', title: 'Tab' }, { redact: 'v' }]), capture);
    try {
      const panel = p0(report);
      assert.equal(panel.cropped, true);
      assert.ok(holds(cssFrames(report)[0], NEAR_VALUE), `the crop ${cssFrames(report)[0]} holds the whole value`);
      assert.equal(panel.redactions.length, 1);
      const [fill] = panel.redactions;
      assert.ok(inside(fill.rect, panel.capture), 'the fill is drawn whole inside the panel');
      const png = await readFile(outPath); const px = png.readUInt32BE(16) / report.stage[2];
      // Under the wash the fill is lighter, so it gets the wider tolerance that still catches the dark value; rows a
      // lift's card and its ring stand over are left out.
      const [x, y, w, h] = fill.rect;
      let rows = [[y, y + h]];
      for (const { rect: [, ly, , lh] } of panel.lifts) rows = rows.flatMap(([a, b]) => [[a, Math.min(b, ly - 4)], [Math.max(a, ly + lh + 4), b]]).filter(([a, b]) => b - a > 2);
      assert.ok(rows.length > 0, 'some of the fill lies clear of the card');
      for (const [a, b] of rows) {
        const off = await countOffColor({ png, rect: [x + 3, a + 1, w - 6, b - a - 2].map((v) => Math.round(v * px)), color: [0xCB, 0xD5, 0xE1], tolerance: 70, renderer });
        assert.ok(off.total > 0);
        assert.equal(off.off, 0, `${off.off} of ${off.total} pixels of the fill are not the fill`);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
    boards.push({ ...report, imageSizes: [capture.size] });
  }
  assertSameLayout(...boards, [2]);
});

test('a panel whose only mark is a redaction is cropped to it', { skip }, async () => {
  for (const report of await twinBoards([{ redact: 'v' }], tabScene(FAR_VALUE))) {
    assert.equal(p0(report).cropped, true);
    assert.ok(holds(cssFrames(report)[0], FAR_VALUE), `the crop ${cssFrames(report)[0]} holds the value`);
    assert.equal(p0(report).redactions.length, 1);
  }
});

const tabSteps = async (scale, firstMarks) => {
  const captures = [];
  for (const scene of [tabScene(FAR_VALUE), tabScene(FAR_VALUE), tabScene(FAR_VALUE)]) captures.push(await syntheticCapture({ ...scene, scale }));
  const { report, dir } = await render(multi('steps', [firstMarks, [{ lift: 'a', title: 'Two' }], [{ lift: 'a', title: 'Three' }]]), captures);
  await rm(dir, { recursive: true, force: true });
  return { ...report, imageSizes: captures.map((capture) => capture.size) };
};

test('a redaction far from a step\'s lift does not grow that step\'s crop, at 1x and at 2x', { skip }, async () => {
  const marks = [{ lift: 'a', title: 'One' }, { redact: 'v' }];
  const boards = [await tabSteps(1, marks), await tabSteps(2, marks)];
  assertSameLayout(...boards, [2, 2, 2]);
  const plain = await tabSteps(1, [{ lift: 'a', title: 'One' }]);
  for (const report of boards) {
    assert.equal(report.panels[0].cropped, true);
    assert.deepEqual(cssFrames(report), cssFrames(plain), 'every step shows what it shows without the redaction');
    assert.equal(report.panels[0].redactions.length, 0);
  }
});

// Two steps on one page: the first lifts the tab, and a value runs from beside it far past where its crop ends.
// A steps edge with no clean band is held at its margin, so the tab's crop alone would cut the value.
const WIDE_VALUE = [150, 95, 700, 16];
const cutSteps = async (scale, firstMarks) => {
  const captures = [];
  for (let i = 0; i < 2; i += 1) captures.push(await syntheticCapture({ ...tabScene(WIDE_VALUE), scale }));
  const { report, dir } = await render(multi('steps', [firstMarks, [{ lift: 'a', title: 'Two' }]]), captures);
  await rm(dir, { recursive: true, force: true });
  return { ...report, imageSizes: captures.map((capture) => capture.size) };
};

test('a redaction that a step\'s crop would cut is taken in whole, at 1x and at 2x', { skip }, async () => {
  const plain = [await cutSteps(1, [{ lift: 'a', title: 'One' }]), await cutSteps(2, [{ lift: 'a', title: 'One' }])];
  const boards = [await cutSteps(1, [{ lift: 'a', title: 'One' }, { redact: 'v' }]), await cutSteps(2, [{ lift: 'a', title: 'One' }, { redact: 'v' }])];
  assertSameLayout(...boards, [2, 2]);
  plain.forEach((report) => assert.ok(!holds(cssFrames(report)[0], WIDE_VALUE), `the tab's crop alone, ${cssFrames(report)[0]}, cuts the value`));
  boards.forEach((report) => {
    assert.equal(report.panels[0].cropped, true);
    assert.ok(holds(cssFrames(report)[0], WIDE_VALUE), `the crop ${cssFrames(report)[0]} holds the whole value`);
    assert.equal(report.panels[0].redactions.length, 1);
  });
});

// Two steps: a large block, then a tab whose larger shared crop comes to meet a redaction below it.
const BLOCK = [100, 60, 420, 220];
const LOW_VALUE = [100, 300, 380, 16];
const sharedSteps = async (scale) => {
  const captures = [
    await syntheticCapture({ scale, size: [1000, 700], bars: [BLOCK], boxes: { a: BLOCK } }),
    await syntheticCapture({ scale, size: [1000, 700], bars: [TAB, LOW_VALUE], boxes: { a: TAB, v: LOW_VALUE } })];
  const { report, dir } = await render(multi('steps', [[{ lift: 'a', title: 'One' }], [{ lift: 'a', title: 'Two' }, { redact: 'v' }]]), captures);
  await rm(dir, { recursive: true, force: true });
  return { ...report, imageSizes: captures.map((capture) => capture.size) };
};

test('steps keep one size when a crop grown to the shared size meets a redaction, at 1x and at 2x', { skip }, async () => {
  const boards = [await sharedSteps(1), await sharedSteps(2)];
  assertSameLayout(...boards, [2, 2]);
  for (const report of boards) {
    assert.deepEqual(report.panels.map((p) => p.cropped), [true, true]);
    const [one, two] = cssFrames(report);
    assert.deepEqual(two.slice(2), one.slice(2), `the steps show ${one} and ${two}`);
    assert.ok(holds(two, LOW_VALUE), 'the redaction the grown crop met is taken in whole');
    assert.ok(Math.abs(report.panels[0].capture[2] - report.panels[1].capture[2]) < 0.5, 'and both are drawn at one zoom');
  }
});

// Rows of words 4 px tall and 2 apart, staggered, fill the page under a tab, so no steps crop edge finds a clean band or a word space
// and each is held at its margin: the bottom one at y 200. The value's box starts there, and its fill reaches a px above it.
const DENSE_ROWS = Array.from({ length: 52 }, (_, n) => Array.from({ length: 23 }, (_, m) => [(n % 2) * 22 + 44 * m, 87 + 6 * n, 40, 4])).flat();
const ROW_VALUE = [150, 200, 300, 4];
const denseSteps = async (scale) => {
  const captures = [];
  for (let i = 0; i < 2; i += 1) captures.push(await syntheticCapture({ scale, size: [1000, 700], bars: [TAB, ...DENSE_ROWS], boxes: { a: TAB, v: ROW_VALUE } }));
  const { report, dir } = await render(multi('steps', [[{ lift: 'a', title: 'One' }, { redact: 'v' }], [{ lift: 'a', title: 'Two' }]]), captures);
  await rm(dir, { recursive: true, force: true });
  return { ...report, imageSizes: captures.map((capture) => capture.size) };
};

test('a redaction whose fill meets a held crop edge, though its box does not, is taken in whole, at 1x and at 2x', { skip }, async () => {
  const boards = [await denseSteps(1), await denseSteps(2)];
  assertSameLayout(...boards, [2, 2]);
  for (const report of boards) {
    const [panel] = report.panels;
    assert.equal(panel.cropped, true);
    assert.ok(holds(cssFrames(report)[0], [ROW_VALUE[0] - 2, ROW_VALUE[1] - 2, ROW_VALUE[2] + 4, ROW_VALUE[3] + 4]), `the crop ${cssFrames(report)[0]} holds the whole fill`);
    assert.equal(panel.redactions.length, 1);
  }
});

test('an imported frame edge that cuts content fades into its ground, cut around a fill it meets', { skip }, async () => {
  // Rows 4 px tall and 2 apart of 2 px strokes 2 apart, staggered by a stroke: the frame's right edge at x 700 finds no
  // band and no word space, and the page is more ground than ink. The redact box sits in a clearing of them, further
  // from any row than the value's reach: a row within it that the fill left bare would refuse the board.
  const clearing = [520, 140, 280, 210];
  const rows = Array.from({ length: 83 }, (_, n) => Array.from({ length: 200 }, (_, m) => [(n % 2) * 2 + 4 * m, 6 * n, 2, 4])).flat()
    .filter(([x, y, w, h]) => x + w <= clearing[0] || y + h <= clearing[1] || y >= clearing[1] + clearing[3]);
  const value = [680, 240, 60, 8];
  const capture = await syntheticCapture({ size: [800, 500], bars: rows, boxes: { g: [300, 200, 120, 24], v: value } });
  const { report, dir } = await render(spec([{ ghost: 'g', title: 'Slot' }, { redact: 'v' }]), { ...capture, frame: [100, 100, 600, 300], source: 'import' });
  await rm(dir, { recursive: true, force: true });
  assertInvariants(report);
  const panel = p0(report);
  assert.equal(panel.frameEdges.right, 'cut');
  const fade = panel.fades.find((f) => f.side === 'right');
  assert.ok(fade, 'the cut right edge fades');
  assert.equal(fade.parts.length, 2, 'the fade stops at the fill and starts again past it');
  assert.ok(fade.ground.every((v) => v > 200), `the fade's ground ${fade.ground} is the page's, not the rows' ink or the fill`);
});

test('a fade lies under the wash and every mark: first after the capture in its panel, with no z-index of its own', { skip }, async () => {
  const rows = Array.from({ length: 83 }, (_, n) => Array.from({ length: 200 }, (_, m) => [(n % 2) * 2 + 4 * m, 6 * n, 2, 4])).flat();
  const capture = await syntheticCapture({ size: [800, 500], bars: rows, boxes: { g: [640, 200, 80, 24], a: [300, 300, 60, 20], v: [680, 240, 60, 8] } });
  const html = buildBoardHtml({ spec: spec([{ ghost: 'g', title: 'Slot' }, { lift: 'a', title: 'Lift' }, { redact: 'v' }]), captures: [{ ...capture, frame: [100, 100, 600, 300], source: 'import' }], fontBytes: font, geometrySource, layoutSource });
  const { chromium } = await import(renderer.playwrightCore);
  const browser = await chromium.launch({ headless: true, executablePath: renderer.executablePath });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const report = await page.evaluate(() => window.__composeLayout());
    assert.ok(p0(report).fades.length > 0 && p0(report).lifts.length > 0 && p0(report).slots.length > 0, 'the board draws a fade, a lift and a slot');
    const layers = await page.evaluate(() => [...document.querySelectorAll('.capture')].map((cap) => ({
      children: [...cap.children].map((node) => node.className.split(' ')[0]),
      zIndex: [...cap.querySelectorAll('.fade')].map((node) => getComputedStyle(node).zIndex),
    })));
    for (const { children, zIndex } of layers) {
      const fades = children.flatMap((name, i) => (name === 'fade' ? [i] : []));
      assert.ok(fades.length > 0, `a panel draws its fades: ${children}`);
      assert.deepEqual(children.slice(0, 1 + fades.length), ['fill', ...fades.map(() => 'fade')], `the fades come straight after the capture, before the wash and every mark: ${children}`);
      assert.ok(zIndex.every((z) => z === 'auto'), `a fade has a z-index of its own (${zIndex}), which would lift it over the wash, a slot or a lift`);
    }
  } finally { await browser.close(); }
});

test('a narrow single frame draws up to 1.25x, so its capture is at least 600 board px wide', { skip }, async () => {
  const bars = [[20, 90, 100, 20], [360, 90, 100, 20]];
  for (const scale of [1, 2]) {
    const capture = await syntheticCapture({ size: [480, 200], bars, boxes: { a: bars[0], b: bars[1] }, scale });
    const { report, dir } = await render(spec([{ lift: 'a', title: 'Left' }, { lift: 'b', title: 'Right' }]), capture);
    try {
      const panel = p0(report);
      const drawn = panel.capture[2] / (panel.frame[2] / panel.scale);
      assert.ok(panel.frame[2] / panel.scale >= 480 - 1e-6, `the frame keeps its ${panel.frame[2] / panel.scale} CSS px width`);
      assert.ok(drawn > 1.0 && drawn <= 1.25 + 1e-6, `drawn at ${drawn}x at scale ${scale}`);
      assert.ok(panel.capture[2] >= 600 - 1, `capture is ${panel.capture[2]} board px wide at scale ${scale}`);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

// The board's computed annotation type in CSS px, from the page that drew it, with its layout report.
// `plain` draws the board with its type held at CSS size, the board the type scale must not widen.
async function typeOf(boardSpec, capture, { plain = false } = {}) {
  const geometry = plain ? `${geometrySource}\nglobalThis.__composeGeometry.textScale = () => 1;` : geometrySource;
  const html = buildBoardHtml({ spec: boardSpec, captures: [capture], fontBytes: font, geometrySource: geometry, layoutSource });
  const { chromium } = await import(renderer.playwrightCore);
  const browser = await chromium.launch({ headless: true, executablePath: renderer.executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 2400, height: 1600 } });
    await page.setContent(html, { waitUntil: 'load' });
    const report = await page.evaluate(() => window.__composeLayout());
    const sizes = await page.evaluate(() => Object.fromEntries(['title', 'state', 'ltitle', 'lnote', 'tag', 'pin', 'lnum', 'empty'].map((cls) => {
      const node = document.querySelector(`.${cls}`);
      return [cls, node ? parseFloat(getComputedStyle(node).fontSize) : null];
    })));
    return { report, sizes };
  } finally { await browser.close(); }
}
// The page CSS sizes in page.mjs, kept apart so the check does not read the code it checks.
const TYPE_CSS = { title: 15, state: 11, ltitle: 13, lnote: 12, tag: 10, pin: 11, lnum: 11, empty: 13 };
const PIN_CSS_R = 9;

test('a lone panel drawn past CSS size sets its annotation type larger by its zoom; at or under CSS size the type keeps its CSS size', { skip }, async () => {
  const marks = [{ lift: 'a', title: 'Left', note: 'A short note', tag: 'NEW' }, { lift: 'b', title: 'Right' }];
  // 480 CSS px is drawn at 1.25x, 560 at 640 / 560, and 900 at under 1x.
  for (const [width, scale, zoom] of [[480, 1, 1.25], [480, 2, 1.25], [560, 1, 1.14], [900, 1, 1]]) {
    const bars = [[20, 90, 100, 20], [width - 120, 90, 100, 20]];
    const capture = await syntheticCapture({ size: [width, 200], bars, boxes: { a: bars[0], b: bars[1] }, scale });
    const { report, sizes } = await typeOf(spec(marks), capture);
    assertInvariants(report);
    const drawn = p0(report).capture[2] / (p0(report).frame[2] / p0(report).scale);
    assert.ok(Math.abs(Math.min(1.25, Math.max(1, drawn)) - zoom) < 0.01, `a ${width} CSS px frame at scale ${scale} is drawn at ${drawn}x`);
    assert.equal(report.textScale, zoom, `a ${width} CSS px frame at scale ${scale} sets its type at ${report.textScale}x`);
    for (const [cls, css] of Object.entries({ title: TYPE_CSS.title, state: TYPE_CSS.state, ltitle: TYPE_CSS.ltitle, lnote: TYPE_CSS.lnote, tag: TYPE_CSS.tag })) {
      assert.ok(Math.abs(sizes[cls] - css * zoom) < 0.01, `.${cls} is ${sizes[cls]} px on a ${width} CSS px frame, not ${css * zoom}`);
    }
  }
});

test('zoomed annotation type never widens the board: it keeps its hierarchy and wraps onto more lines within the widths CSS-size type took', { skip }, async () => {
  const long = 'A note that runs well past any sensible label width so it must wrap across several lines cleanly';
  const bars = [[20, 60, 100, 20], [20, 130, 100, 20]];
  const marks = [{ lift: 'a', title: 'A fairly long label title for a lifted element', note: long, tag: 'CHANGED' }, { lift: 'b', title: 'Another label', note: long }];
  const headline = 'A headline over the board that runs long enough to wrap once its type grows';
  // A ghost far out to the right keeps the frame whole, so its width alone sets the zoom.
  const capture = await syntheticCapture({ size: [480, 200], bars: [...bars, holdOf([480])], boxes: { a: bars[0], b: bars[1], hold: holdOf([480]) } });
  const board = spec([...marks, { ghost: 'hold' }], headline);
  const zoomed = await typeOf(board, capture);
  const plain = await typeOf(board, capture, { plain: true });
  assert.equal(zoomed.report.textScale, 1.25);
  assert.equal(plain.report.textScale, 1);
  for (const { report, sizes } of [zoomed, plain]) {
    assertInvariants(report);
    assert.ok(sizes.title > sizes.ltitle && sizes.ltitle > sizes.lnote, `the headline (${sizes.title}) stands over the callout title (${sizes.ltitle}) over its note (${sizes.lnote})`);
  }
  assert.ok(Math.abs(zoomed.report.stage[2] - plain.report.stage[2]) <= 0.5, `the board is ${zoomed.report.stage[2]} px wide at 1.25x type, ${plain.report.stage[2]} at CSS size`);
  assert.ok(zoomed.report.stage[3] > plain.report.stage[3], 'the larger type makes the board taller');
  assert.deepEqual(p0(zoomed.report).capture.slice(2), p0(plain.report).capture.slice(2), 'the screenshot is drawn at the same size');
  p0(zoomed.report).labels.forEach((label, i) => {
    const before = p0(plain.report).labels[i].rect;
    assert.ok(label.rect[2] <= Math.max(before[2], 240) + 0.5, `label ${i} is ${label.rect[2]} px wide, past its ${before[2]} and the 240 px wrap`);
    assert.ok(label.rect[3] > before[3], `label ${i} wraps onto more lines: ${label.rect[3]} px high against ${before[3]}`);
  });
});

test('a board whose larger type would run a word past the width it holds steps its type down, to CSS size at the least', { skip }, async () => {
  const bars = [[20, 60, 100, 20]];
  const capture = await syntheticCapture({ size: [480, 200], bars: [...bars, holdOf([480])], boxes: { a: bars[0], hold: holdOf([480]) } });
  const { report, sizes } = await typeOf(spec([{ lift: 'a', title: 'Unbreakablewordthatfillsthelabelcolumnwhole' }, { ghost: 'hold' }]), capture);
  const plain = await typeOf(spec([{ lift: 'a', title: 'Unbreakablewordthatfillsthelabelcolumnwhole' }, { ghost: 'hold' }]), capture, { plain: true });
  assert.equal(report.textScale, 1);
  assert.equal(sizes.ltitle, TYPE_CSS.ltitle);
  assert.deepEqual(report.stage, plain.report.stage, 'the board is the one CSS-size type draws');
});

test("an empty slot's own words grow with the board's type, and still sit inside a slot that holds them", { skip }, async () => {
  for (const [width, zoom] of [[480, 1.25], [900, 1]]) {
    const slot = [40, 60, 300, 80];
    const { report, sizes } = await typeOf(spec([{ empty: 'blank' }, { ghost: 'hold' }]), await syntheticCapture({ size: [width, 200], bars: [holdOf([width])], boxes: { blank: slot, hold: holdOf([width]) } }));
    assertInvariants(report);
    assert.equal(report.textScale, zoom);
    assert.equal(p0(report).slots[0].text, 'inside');
    assert.ok(Math.abs(sizes.empty - TYPE_CSS.empty * zoom) < 0.01, `the slot's words are ${sizes.empty} px at ${zoom}x`);
  }
});

test('a pinned board with zoomed annotation type keeps its pins and legend numbers at CSS size, clear of each other', { skip }, async () => {
  const bars = [[100, 100, 60, 20], [200, 100, 60, 20], [100, 160, 60, 20]];
  const marks = [{ lift: 'a', title: 'Boxed', note: 'A note wider than its title' }, { lift: 'b' }, { lift: 'c' }];
  const at = async (width, options) => typeOf(spec([...marks, { ghost: 'hold' }]), await syntheticCapture({ size: [width, 260], bars: [...bars, holdOf([width])], boxes: { a: bars[0], b: bars[1], c: bars[2], hold: holdOf([width]) } }), options);
  const zoomed = await at(480);
  const plain = await at(480, { plain: true });
  for (const { report, sizes } of [zoomed, plain]) {
    assertInvariants(report);
    assert.equal(report.pinned, true);
    assert.ok(p0(report).pins.every((pin) => pin.r === PIN_CSS_R), `pins of radius ${p0(report).pins.map((pin) => pin.r)}`);
    assert.ok(p0(report).legend.every(({ rect }) => rect[2] === 2 * PIN_CSS_R), `legend numbers ${p0(report).legend.map(({ rect }) => rect[2])} px across`);
    for (const cls of ['pin', 'lnum']) assert.equal(sizes[cls], TYPE_CSS[cls], `.${cls} is ${sizes[cls]} px`);
    const [label] = p0(report).labels; const [entry] = p0(report).legend;
    assert.equal(intersects(label.rect, entry.rect), false, 'the legend number stands clear of its label');
  }
  assert.equal(zoomed.report.textScale, 1.25);
  const onCapture = (report) => p0(report).pins.map(({ center: [x, y] }) => [x - p0(report).capture[0], y - p0(report).capture[1]]);
  assert.deepEqual(onCapture(zoomed.report), onCapture(plain.report), 'the pins stand on the screenshot where they stand at CSS-size type');
});

// Stems of a line of text from x to x + width: 1 px wide, 2 apart, a third starting a px lower and a third ending
// one higher, so no run of its rows repeats.
const textStems = (x, y, width) => Array.from({ length: Math.ceil(width / 3) }, (_, i) => [x + 3 * i, y + (i % 3 === 1 ? 1 : 0), 1, 10 - (i % 3 === 0 ? 0 : 1)]);

test('an imported fill that grows says so, and one that covers a line beside the value to its end names the panel, the mark and the side', { skip }, async () => {
  // The lifted bar stands above the line beside the value, further off than a wrapped line or its first line's tail
  // reaches.
  const capture = await syntheticCapture({ size: [700, 260], bars: [...textStems(100, 100, 60), ...textStems(100, 118, 480), [500, 30, 60, 20]], boxes: { v: [100, 100, 60, 10], h: [500, 30, 60, 20] } });
  const { report, dir } = await render(spec([{ lift: 'h', title: 'Heading' }, { redact: 'v' }]), { ...capture, source: 'import' });
  await rm(dir, { recursive: true, force: true });
  assert.ok(report.warnings.includes('a redaction on panel 1 (v) grew to cover ink beside it'), `${report.warnings}`);
  assert.ok(report.warnings.includes("a redaction on panel 1 (v) covered a line beside it to that line's end, past its right edge"), `${report.warnings}`);
  assert.deepEqual(report.unhidden, [], 'a line beside the value is covered to its end, and the board is written');
});

test('a lifted bar under the value\'s columns, within the reach of its covered line, is never written', { skip }, async () => {
  // A mark asserts nothing about what its box holds: a bar a lead or two under the value may be its own.
  const capture = await syntheticCapture({ size: [700, 260], bars: [...textStems(100, 100, 60), ...textStems(100, 118, 480), [100, 160, 60, 20]], boxes: { v: [100, 100, 60, 10], h: [100, 160, 60, 20] } });
  await assert.rejects(render(spec([{ lift: 'h', title: 'Heading' }, { redact: 'v' }]), { ...capture, source: 'import' }),
    (error) => error.name === 'LifecycleError' && error.message.startsWith("a redaction on panel 1 (v) met another mark's box"));
});

test('an imported fill whose own line runs on past its limit is never written', { skip }, async () => {
  const capture = await syntheticCapture({ size: [700, 260], bars: [...textStems(100, 100, 480), [40, 40, 40, 20]], boxes: { v: [100, 100, 60, 10], h: [40, 40, 40, 20] } });
  await assert.rejects(render(spec([{ lift: 'h', title: 'Heading' }, { redact: 'v' }]), { ...capture, source: 'import' }),
    (error) => error.name === 'LifecycleError' && error.message.startsWith('a redaction on panel 1 (v) reached its growth limit with ink still at its right edge'));
});

test('a refused fill the crop leaves off the board refuses it only when the value\'s ink runs on into the board', { skip }, async () => {
  // The crop is chosen by the lift alone, far from the value, so no rect of the refused fill is drawn. Past the
  // fill's capped right edge its line runs away from the crop: a stray mark, written with its warning.
  const away = await syntheticCapture({ size: [1400, 700], bars: [...textStems(900, 550, 480), [100, 100, 140, 20]], boxes: { v: [900, 550, 60, 10], h: [100, 100, 140, 20] } });
  const { report, dir } = await render(spec([{ lift: 'h', title: 'Heading' }, { redact: 'v' }]), { ...away, source: 'import' });
  await rm(dir, { recursive: true, force: true });
  assert.deepEqual(p0(report).redactions, [], 'no rect of the fill is drawn');
  assert.ok(report.warnings.includes('a redact mark on panel 1 lies outside the board, so it hides nothing'), `${report.warnings}`);
  assert.deepEqual([report.gated, report.crops], [true, []], 'the board is gated with nothing to confirm');
  // Past its capped left edge the value's own line runs on, along the lift's rows, into the crop.
  const into = await syntheticCapture({ size: [1400, 700], bars: [...textStems(420, 100, 540), [100, 100, 140, 20]], boxes: { v: [900, 100, 60, 10], h: [100, 100, 140, 20] } });
  await assert.rejects(render(spec([{ lift: 'h', title: 'Heading' }, { redact: 'v' }]), { ...into, source: 'import' }),
    (error) => error.name === 'LifecycleError' && error.message.startsWith('a redact mark on panel 1 (v) lies outside the board, but the value\'s ink runs into the board past its left edge. Frame the panel so that value is out of the board, or redact it where it shows'),
    'the value runs into the board');
});

test('a live redaction never grows: its fill is its box and reach less the ground, at 1x and 2x', { skip }, async () => {
  for (const scale of [1, 2]) {
    const capture = await syntheticCapture({ size: [700, 260], scale, bars: [...textStems(100, 100, 60), [100, 124, 60, 2]], boxes: { v: [100, 100, 60, 10] } });
    const { report, dir } = await render(spec([{ redact: 'v' }]), capture);
    await rm(dir, { recursive: true, force: true });
    assert.ok(!report.warnings.some((w) => w.includes('grew') || w.includes('growth limit')), `${report.warnings}`);
  }
});

test('a redaction\'s gate crop takes in the ink just past where its fill stopped', { skip }, async () => {
  // A value line, a gap of over three leads, and a line past it under the value with another line between them off
  // to the side: the fill does not cover through, the board warns and the crop shows the far line.
  const far = [100, 215, 60, 10];
  // The heading and footer are context off the value's columns and past its reach, with a line between: a mark's
  // box over a line the fill would cover, beside the value or as its wrap, would refuse the board.
  // The fill takes the line between for one the value may wrap to, so the far line is the next line under a covered
  // one: the driver marks it context, and the board is written.
  const capture = await syntheticCapture({ size: [700, 300], bars: [...textStems(100, 100, 60), ...textStems(far[0], far[1], far[2]), ...textStems(300, 150, 60), ...textStems(300, 40, 60), [400, 4, 60, 20], [400, 250, 60, 20]], boxes: { v: [100, 100, 60, 10], h: [400, 4, 60, 20], f: [400, 250, 60, 20], l: [98, 213, 64, 14] } });
  await assert.rejects(render(spec([{ context: 'h' }, { context: 'f' }, { redact: 'v' }]), { ...capture, source: 'import' }),
    (error) => error.name === 'LifecycleError' && error.message.startsWith('a redaction on panel 1 (v) left ink past its bottom edge uncovered, at [100, 215, 58, 10] in the image, where the value may go on'));
  const { report, dir } = await render(spec([{ context: 'h' }, { context: 'f' }, { context: 'l' }, { redact: 'v' }]), { ...capture, source: 'import' });
  await rm(dir, { recursive: true, force: true });
  assert.ok(report.warnings.includes('a redaction on panel 1 (v) stopped at a gap with more ink just past its bottom edge'), `${report.warnings}`);
  const panel = p0(report);
  const [cx, cy, cw, ch] = panel.capture; const [fx, fy, fw, fh] = panel.frame;
  const drawn = [cx + (far[0] - fx) * (cw / fw), cy + (far[1] - fy) * (ch / fh), far[2] * (cw / fw), far[3] * (ch / fh)];
  assert.ok(!intersects(panel.redactions[0].rect, drawn), 'the fill stops short of the far line');
  assert.equal(report.crops.length, 1);
  assert.ok(inside(drawn, report.crops[0].rect, 0), `the gate crop ${report.crops[0].rect} leaves out the far line at ${drawn}`);
});

// A copy of CROP_MARGIN in lib/compose/page-layout.js, kept apart so the check does not read the code it checks.
const CROP_MARGIN = 24;

test('a live redaction on a gated board gets a crop of its own fill and margin, not one read as capture px', { skip }, async () => {
  const pair = { state: 'BEFORE → AFTER', title: 'Pair', layout: 'pair', out: 'o.png', panels: [
    { label: 'BEFORE', capture: 'c1.json', marks: [{ lift: 'h', title: 'Heading' }, { redact: 'v' }] },
    { label: 'AFTER', capture: 'c2.json', marks: [{ lift: 'h', title: 'Heading' }, { redact: 'v' }] }] };
  // The value lies far from the frame's corner, where a board rect read as capture px lands on other ground.
  const scene = { size: [700, 460], bars: [[1, 1, 20, 4], [100, 60, 160, 20], ...textStems(500, 380, 60), [679, 455, 20, 4]], boxes: { h: [100, 60, 160, 20], v: [500, 380, 60, 10] } };
  const before = await syntheticCapture(scene);
  const after = await syntheticCapture(scene);
  const { report, dir } = await render(pair, [{ ...before, source: 'import' }, { ...after, frame: [40, 40, 660, 420] }]);
  await rm(dir, { recursive: true, force: true });
  assert.equal(report.gated, true, 'an imported redaction gates the board');
  const live = report.crops.find((crop) => crop.panel === 1);
  assert.ok(live, 'the live redaction has a crop');
  const [rx, ry, rw, rh] = report.panels[1].redactions[live.redaction].rect;
  const [x, y, w, h] = live.rect;
  assert.ok(x >= Math.floor(rx - CROP_MARGIN) && y >= Math.floor(ry - CROP_MARGIN)
    && x + w <= Math.ceil(rx + rw + CROP_MARGIN) && y + h <= Math.ceil(ry + rh + CROP_MARGIN),
  `the live crop ${live.rect} reaches past its fill ${[rx, ry, rw, rh]} and margin`);
});

// A line with a short sub-line 3 px under it, on a frame drawn at 0.55: the card's ring, 3 board px, is 5.5 px of
// the page, so it cuts the sub-line at any size. Ghosts in the corners keep the frame 1500 by 240.
const SUB_SIZE = [1500, 240];
const subLine = (sub, extra = {}) => ({ size: SUB_SIZE, bars: [[100, 100, 140, 16], sub], boxes: { a: [100, 100, 140, 16], sub, ...holdBoxes(SUB_SIZE) }, ...extra });
const HIDES = 'a lift hides content beside it';

test('a lift whose ring cuts a sub-line takes it in whole, at 1x, 1.25x, 1.5x and 2x', { skip }, async () => {
  const sub = [100, 119, 60, 8];
  const marks = [{ lift: 'a', title: 'Line' }, ...holdMarks];
  const boards = await twinBoards(marks, subLine(sub));
  assertSameLayout(...boards, [2]);
  const fractional = [];
  for (const scale of [1.25, 1.5]) {
    const { report, dir } = await render(spec(marks), await syntheticCapture({ ...subLine(sub), scale }));
    await rm(dir, { recursive: true, force: true });
    assertInvariants(report);
    fractional.push(report);
  }
  for (const report of [...boards, ...fractional]) {
    const panel = p0(report); const { scale } = panel;
    assert.ok(panel.capture[2] / (panel.frame[2] / scale) < 0.56, 'the frame is drawn at 0.55');
    const lift = panel.lifts.find((l) => l.keys.includes('a'));
    assert.ok(lift.source[1] + lift.source[3] >= (sub[1] + sub[3]) * scale, `the lift's box ${lift.source} holds the sub-line`);
    assert.ok(inside(drawnOn(panel, sub), lift.rect, 0), 'the card shows the sub-line');
    assert.ok(!report.warnings.includes(HIDES), `${report.warnings}`);
  }
});

test('a lift whose ring cuts a sub-line a little wider than its box takes in the sub-line\'s whole width, at 1x and at 2x', { skip }, async () => {
  // Stems from x 95 to 243 under a box from 100 to 240: within the card, past the box on both ends.
  const stems = textStems(95, 119, 150); const ink = [95, 119, 148, 10];
  const scene = { size: SUB_SIZE, bars: [[100, 100, 140, 16], ...stems], boxes: { a: [100, 100, 140, 16], ...holdBoxes(SUB_SIZE) } };
  const boards = await twinBoards([{ lift: 'a', title: 'Line' }, ...holdMarks], scene);
  assertSameLayout(...boards, [2]);
  for (const report of boards) {
    const panel = p0(report); const { scale } = panel;
    const lift = panel.lifts.find((l) => l.keys.includes('a'));
    assert.ok(inside(ink.map((n) => n * scale), lift.source, 0), `the lift's box ${lift.source} holds the sub-line's ends`);
    assert.ok(inside(drawnOn(panel, ink), lift.rect, 0), 'the card shows the sub-line whole');
    assert.ok(!report.warnings.includes(HIDES), `${report.warnings}`);
  }
});

test('a lift whose ring cuts a line running past its card leaves the line and says it hides content', { skip }, async () => {
  const sub = [40, 119, 400, 8];
  const { report, dir } = await render(spec([{ lift: 'a', title: 'Line' }, ...holdMarks]), await syntheticCapture(subLine(sub)));
  try {
    assertInvariants(report);
    const lift = p0(report).lifts.find((l) => l.keys.includes('a'));
    assert.ok(lift.source[1] + lift.source[3] <= sub[1], `the lift's box ${lift.source} stops above the line`);
    assert.ok(report.warnings.includes(HIDES), `${report.warnings}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a lift whose ring cuts a redacted sub-line never takes it in', { skip }, async () => {
  const sub = [100, 119, 60, 8];
  const { report, dir } = await render(spec([{ lift: 'a', title: 'Line' }, { redact: 'sub' }, ...holdMarks]), await syntheticCapture(subLine(sub)));
  try {
    assertInvariants(report);
    const lift = p0(report).lifts.find((l) => l.keys.includes('a'));
    assert.ok(lift.source[1] + lift.source[3] <= sub[1], `the lift's box ${lift.source} stops above the redaction`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('steps drawn at one zoom pass the size invariant only where one size would draw them more than 1.25 apart', () => {
  // Panels at a zoom of 1, so each is drawn at its CSS size: a row lines up their tops, a stack their left edges.
  const row = (heights) => ({ layout: 'steps', stacked: false, panels: heights.map((h, i) => ({ scale: 2, frame: [0, 0, 800, 2 * h], capture: [20 + 420 * i, 40, 400, h] })) });
  const stack = (widths) => ({ layout: 'steps', stacked: true, panels: widths.map((w, i) => ({ scale: 1, frame: [0, 0, w, 60], capture: [20, 40 + 80 * i, w, 60] })) });
  assertPanelSizes(row([200, 100]));
  assertPanelSizes(stack([600, 300]));
  assert.throws(() => assertPanelSizes(row([200, 180])), /panels differ in height/, 'one height drew them at zooms 1.11 apart');
  assert.throws(() => assertPanelSizes(stack([600, 500])), /stacked panels differ in width/, 'one width drew them at zooms 1.2 apart');
  assert.throws(() => assertPanelSizes({ ...row([200, 100]), layout: 'pair' }), /panels differ in height/, 'only steps share a zoom');
});

test('a lone strip is drawn at the width rule of any lone panel', { skip }, async () => {
  // 1300 CSS px wide, at 60 px tall a strip and at 140 px tall none: each is drawn at MIN_S 0.55, 715 wide.
  const line = [40, 20, 200, 20];
  for (const size of [[1300, 60], [1300, 140]]) {
    const { report, dir } = await render(spec([{ lift: 'a', title: 'Line' }, ...holdMarks]), await syntheticCapture({ size, bars: [line], boxes: { a: line, ...holdBoxes(size) } }));
    try {
      assertInvariants(report);
      const panel = p0(report);
      assert.deepEqual(panel.frame, [0, 0, ...size], 'the ghosts hold the whole frame');
      assert.ok(Math.abs(panel.capture[2] - 715) <= 1, `a ${size} frame is drawn ${panel.capture[2]} px wide`);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});
