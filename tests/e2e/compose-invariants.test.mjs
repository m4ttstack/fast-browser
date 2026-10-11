import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { rendererLaunches } from '../../lib/compose/renderer.mjs';
import { renderBoard } from '../../lib/compose/engine.mjs';
import { buildBoardHtml, REDACT_FILL } from '../../lib/compose/page.mjs';
import { assertInvariants } from './helpers/invariants.mjs';
import { rendererForTests } from './helpers/renderer.mjs';

const renderer = await rendererForTests();
const skip = renderer ? false : 'skipped by FAST_BROWSER_SKIP_COMPOSE_E2E=1';
const font = await readFile(new URL('../../assets/fonts/InterVariable.woff2', import.meta.url));
const geometrySource = await readFile(new URL('../../lib/compose/page-geometry.js', import.meta.url), 'utf8');
const layoutSource = await readFile(new URL('../../lib/compose/page-layout.js', import.meta.url), 'utf8');

// A synthetic 600x300 capture: white card, three grey text bars.
async function syntheticCapture({ dark = false, size = [600, 300], bars, boxes } = {}) {
  const { chromium } = await import(renderer.playwrightCore);
  const browser = await chromium.launch({ headless: true, executablePath: renderer.executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: size[0], height: size[1] } });
    const bg = dark ? '#111827' : '#ffffff'; const fg = dark ? '#e5e7eb' : '#334155';
    const list = bars ?? [[40, 40, 200, 20], [40, 80, 300, 20], [560, 260, 40, 40]];
    await page.setContent(`<body style="margin:0;background:${bg}">${list.map(([x, y, w, h]) =>
      `<div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;background:${fg}"></div>`).join('')}</body>`);
    return { png: await page.screenshot(), size, frame: [0, 0, size[0], size[1]], dark,
      boxes: boxes ?? { a: list[0], b: list[1], edge: list[2] } };
  } finally { await browser.close(); }
}

async function render(spec, capture) {
  const dir = await mkdtemp(path.join(tmpdir(), 'fb-compose-'));
  const outPath = path.join(dir, 'board.png');
  const html = buildBoardHtml({ spec, captures: [capture], fontBytes: font, geometrySource, layoutSource });
  const result = await renderBoard({ html, outPath, ...renderer });
  return { ...result, dir, outPath };
}

const spec = (marks, title = 'Board') => ({ state: 'AFTER', title, layout: 'single', out: 'o.png', panels: [{ capture: 'c.json', marks }] });

test('two adjacent lifts with labels hold every invariant', { skip }, async () => {
  const { report, dir } = await render(spec([
    { lift: 'a', title: 'First', note: 'One line' }, { lift: 'b', title: 'Second', tag: 'NEW' },
  ]), await syntheticCapture());
  try { assertInvariants(report); assert.equal(report.labels.length, 2); } finally { await rm(dir, { recursive: true, force: true }); }
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
    assert.equal(report.lifts[0].clamped, true, 'the edge lift is reported as clamped');
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
    assert.equal(report.lifts.filter((l) => l.clamped).length, 2, 'both lifts are clamped');
    assert.deepEqual(report.warnings, [...new Set(report.warnings)], 'no warning is repeated');
    assert.equal(report.warnings.filter((w) => w === 'a lift was clamped at the frame edge').length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('two lifts side by side on one row keep leaders and labels apart', { skip }, async () => {
  const bars = [[40, 40, 100, 20], [300, 40, 100, 20]];
  const { report, dir } = await render(spec([
    { lift: 'a', title: 'Left target' }, { lift: 'b', title: 'Right target' },
  ]), await syntheticCapture({ bars, boxes: { a: bars[0], b: bars[1] } }));
  try { assertInvariants(report); assert.equal(report.lifts.length, 2); } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a short title on a wide frame keeps labels apart', { skip }, async () => {
  const bars = [[300, 100, 100, 20], [400, 100, 100, 20]];
  const { report, dir } = await render(spec([
    { lift: 'a', title: 'First' }, { lift: 'b', title: 'Second' },
  ], 'X'), await syntheticCapture({ size: [1200, 300], bars, boxes: { a: bars[0], b: bars[1] } }));
  try { assertInvariants(report); assert.equal(report.labels.length, 2); } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a lift over a redacted key shows the fill, never the original pixels', { skip }, async () => {
  const { report, dir, outPath } = await render(spec([{ redact: 'a' }, { lift: 'a', title: 'Covered' }]), await syntheticCapture());
  try {
    const { chromium } = await import(renderer.playwrightCore);
    const browser = await chromium.launch({ headless: true, executablePath: renderer.executablePath });
    try {
      const page = await browser.newPage();
      const png = (await readFile(outPath)).toString('base64');
      const lift = report.lifts[0].rect;
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
    assert.equal(report.redactions.length, 1);
    assert.deepEqual(Object.keys(report.redactions[0]).sort(), ['fill', 'rect']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a lift edge never grows into a neighbouring lift: it stays put and warns', { skip }, async () => {
  const bars = [[40, 40, 102, 10]];
  const boxes = { a: [30, 35, 60, 20], b: [150, 35, 40, 20] };
  const { report, dir } = await render(spec([{ lift: 'a', title: 'First' }, { lift: 'b', title: 'Second' }]), await syntheticCapture({ bars, boxes }));
  try {
    assertInvariants(report);
    assert.deepEqual(report.lifts[0].grown, [0, 0, 0, 0], 'the walled-in edge reverted');
    assert.ok(report.warnings.includes('a lift edge cuts through content'), 'the cut is reported');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a lift that cuts through content grows to the clean edge past it', { skip }, async () => {
  const bars = [[40, 40, 120, 10]];
  const boxes = { a: [30, 35, 60, 20] };
  const { report, dir } = await render(spec([{ lift: 'a', title: 'First' }]), await syntheticCapture({ bars, boxes }));
  try {
    assertInvariants(report);
    const [left, , right] = report.lifts[0].grown;
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
    assert.ok(report.lifts[0].grown[2] > 20, 'the pair grew past its overlapping boxes');
    const tiny = report.lifts[1];
    assert.ok(tiny.rect[3] >= 27.5, 'the tiny lift renders near 28px tall');
    assert.ok(tiny.k > 1.06 && tiny.k <= 3, 'the tiny lift reports the raised scale');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a minimum-size raise capped by the frame width is not reported as scaled down', { skip }, async () => {
  const bars = [[100, 100, 400, 10]];
  const { report, dir } = await render(spec([{ lift: 'a', title: 'Wide' }]), await syntheticCapture({ bars, boxes: { a: bars[0] } }));
  try {
    assertInvariants(report);
    assert.ok(report.lifts[0].k >= 1.06 && report.lifts[0].k < 1.6, 'the raise was capped by the width');
    assert.equal(report.warnings.includes('a lift was scaled down to fit the frame'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a dark capture gets the dark wash and lift border', { skip }, async () => {
  const { report, dir } = await render(spec([{ lift: 'a', title: 'Dark' }]), await syntheticCapture({ dark: true }));
  try { assert.equal(report.dark, true); } finally { await rm(dir, { recursive: true, force: true }); }
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
    assert.deepEqual(report.frame, [0, 0, 600, 300]);
    assert.equal(report.cropped, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a crop tightens around its marks and a redaction outside it is not drawn', { skip }, async () => {
  const bars = [[300, 120, 60, 20], [900, 500, 40, 30]];
  const capture = await syntheticCapture({ size: [1000, 600], bars, boxes: { a: bars[0], far: bars[1] } });
  const marks = [{ lift: 'a', title: 'Small' }, { redact: 'far' }];
  const both = await render(spec(marks), { ...capture, frame: [0, 0, 1000, 600] });
  try {
    assert.equal(both.report.cropped, false, 'the redaction is a mark, so the crop spans both');
    assert.equal(both.report.redactions.length, 1);
  } finally { await rm(both.dir, { recursive: true, force: true }); }
  const left = await render(spec(marks), { ...capture, frame: [0, 0, 600, 600] });
  try {
    assert.equal(left.report.cropped, true);
    assert.ok(left.report.frame[2] * left.report.frame[3] < 0.5 * 600 * 600);
    assert.equal(left.report.redactions.length, 0, 'a redaction outside the frame is not drawn');
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
    assert.deepEqual(report.lifts.map((l) => l.mark), [0, 0, 1, 2], 'the first point has one lift per element');
    assert.equal(report.labels.length, 3, 'one label per point');
    assert.deepEqual(report.leaders[0].lifts.length, 2, 'the leader serves both lifts');
    assert.equal(report.connectors.length, 1);
    assert.equal(report.connectors[0].points.length, 4, 'the connector left by the lift\'s other side and ran along the lane');
    assert.equal(report.connectors[0].lift, report.leaders[0].lifts[1], 'the connector belongs to the lift the leader does not start from');
    assert.equal(report.warnings.includes('a connector crosses another lift'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('with no clean spot for a dot on any open side it stays at the middle and the board warns once', { skip }, async () => {
  const bars = [[100, 100, 40, 20], [146, 40, 80, 160], [40, 126, 200, 60]];
  const { report, dir } = await render(spec([{ lift: 'a', title: 'Boxed in' }]), await syntheticCapture({ bars, boxes: { a: bars[0] } }));
  try {
    assertInvariants(report);
    assert.deepEqual(report.dots.map((d) => d.slid), [0], 'the dot kept its place');
    assert.equal(report.warnings.filter((w) => w === 'a leader dot sits on page content').length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a connector dot slides off page content like a leader dot', { skip }, async () => {
  const bars = [[40, 40, 60, 20], [360, 40, 100, 20], [390, 76, 30, 14]];
  const { report, dir } = await render(spec([{ lift: ['a', 'c'], title: 'Both ends' }]), await syntheticCapture({ size: [600, 400], bars, boxes: { a: bars[0], c: bars[1] } }));
  try {
    assertInvariants(report);
    assert.equal(report.connectors.length, 1);
    const dot = report.dots.find((d) => d.lift === report.connectors[0].lift && d.center[0] === report.connectors[0].points[0][0]);
    assert.ok(dot, 'the connector has its own dot');
    assert.notEqual(dot.slid, 0, 'the connector dot slid off the block under its middle');
    assert.equal(report.warnings.includes('a leader dot sits on page content'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the real renderer launches and reports a version', { skip }, async () => {
  const result = await rendererLaunches({ executable: renderer.executablePath });
  assert.equal(result.ok, true);
  assert.match(result.version, /\d/);
});
