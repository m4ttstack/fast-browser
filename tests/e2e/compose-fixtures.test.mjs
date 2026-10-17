import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { compose } from '../../lib/commands/compose.mjs';
import { renderBoard } from '../../lib/compose/engine.mjs';
import { REDACT_FILL } from '../../lib/compose/page.mjs';
import { resolvePaths } from '../../lib/core/paths.mjs';
import { writeSidecar } from './helpers/capture-sidecar.mjs';
import { assertInvariants, inside, intersects, oneZoom } from './helpers/invariants.mjs';
import { countOffColor, diffPngs } from './helpers/png-diff.mjs';
import { fillProbeHardCases, runFillProbes } from './helpers/fill-probes.mjs';
import { readPixels } from './helpers/png-pixels.mjs';
import { rendererForTests } from './helpers/renderer.mjs';

const renderer = await rendererForTests();
const skip = renderer ? false : 'skipped by FAST_BROWSER_SKIP_COMPOSE_E2E=1';
const macro = new Function(`return (${await readFile(new URL('./helpers/capture-evidence.js', import.meta.url), 'utf8')});`)();
const specDir = path.resolve('tests/fixtures/evidence/specs');
const goldenDir = path.resolve('tests/fixtures/evidence/goldens');
const pluginRoot = path.resolve('.');
// A copy of REDACT_GROW in lib/compose/page-layout.js, kept apart so the check does not read the code it checks.
const REDACT_REACH = 2;
// The 3px ring, the 12px drop and the 28px blur of a lift's box-shadow (page.mjs).
const LIFT_SHADOW_REACH = 3 + 12 + 28;
// The opaque white ring of a lift's box-shadow (page.mjs), which hides the page under it like the card does.
const LIFT_RING = 3;
// How far that shadow reaches above a lift (its blur less its drop) and to each side (its ring and its blur).
const LIFT_SHADOW_ABOVE = 28 - 12;
const LIFT_SHADOW_BESIDE = 3 + 28;
// The outline colour of the outlined-tab fixture (#cbd5e1).
const OUTLINE = [203, 213, 225];
// Copies of the .wash and .wash.dark colours in lib/compose/page.mjs, as [r, g, b, alpha]: a fill outside a card is seen through its panel's wash.
const WASH = { light: [255, 255, 255, 0.55], dark: [11, 9, 32, 0.65] };
const underWash = (colour, panel) => {
  if (!panel.wash) return colour;
  const [r, g, b, alpha] = WASH[panel.dark ? 'dark' : 'light'];
  return colour.map((v, c) => Math.round(v * (1 - alpha) + [r, g, b][c] * alpha));
};
const clipTo = ([x, y, w, h], [bx, by, bw, bh]) => {
  const [x0, y0] = [Math.max(x, bx), Math.max(y, by)];
  return [x0, y0, Math.min(x + w, bx + bw) - x0, Math.min(y + h, by + bh) - y0];
};
// The parts of `rect` that `hole` does not cover, as up to four rectangles.
const minus = (rect, hole) => {
  if (!intersects(rect, hole)) return [rect];
  const [x, y, w, h] = rect; const [hx, hy, hw, hh] = clipTo(hole, rect);
  return [[x, y, w, hy - y], [x, hy + hh, w, y + h - hy - hh], [x, hy, hx - x, hh], [hx + hw, hy, x + w - hx - hw, hh]].filter((r) => r[2] > 0 && r[3] > 0);
};
// The 1 px line down the middle of a rect too thin to inset 3 px from both edges, 3 px in from each end where it
// is long enough, as a rect. A sliver under 2 px across is antialiased throughout, so it has none: null.
const thinCore = ([x, y, w, h]) => {
  if (Math.min(w, h) < 2) return null;
  const span = (a, n) => (n >= 8 ? [a + 3, n - 6] : [a + n / 2 - 0.5, 1]);
  const [x0, w0] = span(x, w); const [y0, h0] = span(y, h);
  return [x0, y0, w0, h0];
};
const unionOf = (boxes) => {
  const x = Math.min(...boxes.map((b) => b[0])); const y = Math.min(...boxes.map((b) => b[1]));
  return [x, y, Math.max(...boxes.map((b) => b[0] + b[2])) - x, Math.max(...boxes.map((b) => b[1] + b[3])) - y];
};

// The sides of a lift `rect` (board px) whose strip, 2 to 10 board px inside its edge and clear of its rounded
// corners, holds a line of `colour`: within 24 of it along half the strip's length or more.
// A line sits as far inside the edge as the card's padding is drawn, so the strips widen with the drawing scale `S`
// when it is past 1x.
async function sidesHolding(shot, shotScale, [x, y, w, h], colour, S = 1) {
  const d = Math.max(1, S);
  const strips = { left: [x + 2 * d, y + 12, 8 * d, h - 24], top: [x + 12, y + 2 * d, w - 24, 8 * d], right: [x + w - 10 * d, y + 12, 8 * d, h - 24], bottom: [x + 12, y + h - 10 * d, w - 24, 8 * d] };
  const sides = [];
  for (const [side, rect] of Object.entries(strips)) {
    const r = await countOffColor({ png: shot, rect: rect.map((v) => Math.round(v * shotScale)), color: colour, renderer });
    const length = (side === 'left' || side === 'right' ? rect[3] : rect[2]) * shotScale;
    if (r.total - r.off >= length / 2) sides.push(side);
  }
  return sides;
}

async function captureLive({ browser, pageName, targets, frame, out, home }) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.goto(pathToFileURL(path.resolve(`tests/fixtures/evidence/pages/${pageName}.html`)).href);
  const captureReturn = await macro(page, { targets, out, home, frame });
  await page.close();
  assert.equal(captureReturn.failedStep, undefined, `capture failed at ${captureReturn.failedStep}`);
  assert.equal(captureReturn.missed.length, 0, 'every fixture target resolves');
  const { sidecar } = await writeSidecar(captureReturn);
  return { captureReturn, sidecar };
}

async function captureImport({ browser, input, out, home, paths }) {
  const page = await browser.newPage({ viewport: { width: input.width ?? 1000, height: 700 }, deviceScaleFactor: input.dpr });
  await page.goto(pathToFileURL(path.resolve(`tests/fixtures/evidence/pages/${input.page}.html`)).href);
  const shot = path.join(home, `${out}.${input.format}`);
  await page.screenshot({ path: shot, type: input.format, quality: input.format === 'jpeg' ? 92 : undefined });
  await page.close();
  const { sidecar } = await compose({ command: 'compose', import: shot, out, origin: 'https://tracker.example/issues/1' }, { paths, rendererLocation: async () => renderer });
  return { captureReturn: null, sidecar };
}

async function prepare(file, home) {
  const paths = resolvePaths({ homeDir: home, pluginRoot });
  const fixture = JSON.parse(await readFile(path.join(specDir, file), 'utf8'));
  const name = path.basename(file, '.json');
  const inputs = fixture.panels.map((panel, i) => panel.fixture ?? (i === 0 ? { page: fixture.page, targets: fixture.targets, frame: fixture.frame } : {}));
  const taken = [];
  const { chromium } = await import(renderer.playwrightCore);
  const browser = await chromium.launch({ headless: true, executablePath: renderer.executablePath });
  try {
    for (const [i, input] of inputs.entries()) {
      const out = `${name}.c${i + 1}`;
      taken.push(input.import
        ? await captureImport({ browser, input: input.import, out, home, paths })
        : await captureLive({ browser, pageName: input.page ?? name, targets: input.targets, frame: input.frame, out, home }));
    }
  } finally { await browser.close(); }
  const spec = { ...fixture, panels: fixture.panels.map(({ fixture: _input, ...panel }, i) => ({ ...panel, capture: path.basename(taken[i].sidecar) })) };
  delete spec.targets; delete spec.page; delete spec.expect; delete spec.frame;
  const specPath = path.join(paths.screenshotsDir, `${name}.spec.json`);
  await writeFile(specPath, JSON.stringify(spec));
  return { paths, fixture, taken, specPath };
}

for (const file of (await readdir(specDir)).filter((f) => f.endsWith('.json'))) {
  test(`fixture ${file} composes, holds its invariants and matches its golden`, { skip }, async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'fb-fx-'));
    try {
      const { paths, fixture, taken, specPath } = await prepare(file, home);
      const { captureReturn } = taken[0];
      let layoutReport;
      const composing = compose({ command: 'compose', spec: specPath }, {
        paths,
        rendererLocation: async () => renderer,
        renderBoard: async (args) => { const r = await renderBoard(args); layoutReport = r.report; return r; },
      });
      if (fixture.expect?.refused) {
        // Ink that runs on along the value's own line past a fill's growth limit may be the value: no board is written.
        await assert.rejects(composing, (error) => error.name === 'LifecycleError' && error.message.includes(fixture.expect.refused));
        const left = (await readdir(paths.screenshotsDir)).filter((f) => f.startsWith(path.basename(fixture.out, '.png')));
        assert.deepEqual(left, [], 'neither the board nor its crops are on disk');
        return;
      }
      const report = await composing;
      assertInvariants(layoutReport);
      assert.equal(layoutReport.panels.length, fixture.panels.length, 'one drawn panel per spec panel');
      if (fixture.expect?.dark) assert.deepEqual(layoutReport.panels.map((p) => p.dark), fixture.expect.dark, "each panel takes its own capture's wash");
      if (fixture.expect?.origin) assert.deepEqual(layoutReport.panels.map((p) => Boolean(p.head?.origin)), fixture.expect.origin, 'an imported panel says it came from the ticket');
      if (fixture.expect?.sizeRatio) {
        const [first, second] = layoutReport.panels;
        assert.ok(first.frame[3] / second.frame[3] >= fixture.expect.sizeRatio, 'the imported frame is several times the live one');
        assert.equal(first.capture[3], second.capture[3], 'and both are drawn at one height');
      }
      if (fixture.expect?.redactionPad) {
        const panel = layoutReport.panels[0]; const scale = panel.capture[2] / panel.frame[2];
        const box = fixture.panels[0].boxes[fixture.panels[0].marks.find((m) => m.redact).redact];
        const drawn = panel.redactions[0].rect; const pad = fixture.expect.redactionPad;
        assert.ok(drawn[2] <= (box[2] + 2 * pad) * scale + 1.5, 'the fill never reaches past the box and its pad');
        assert.ok(drawn[2] > 0 && drawn[3] > 0);
      }
      const board0 = layoutReport.panels[0];
      if (fixture.expect?.fillsApart) {
        const [a, b] = board0.redactions.map((r) => r.rect).sort((p, q) => p[1] - q[1]);
        assert.ok(b[1] - (a[1] + a[3]) >= 1, `two fills on neighbouring lines touch: ${a} and ${b}`);
      }
      for (const lift of board0.lifts) {
        assert.equal(lift.grown.length, 4, 'every lift reports its growth');
        assert.ok(lift.grown.every((g) => Number.isInteger(g) && g >= 0 && g <= 96), 'growth is whole pixels within the limit');
        assert.ok(lift.k > 0 && lift.k <= 3 + 1e-9, 'every lift reports the scale it used');
      }
      if (captureReturn) for (const key of fixture.expect?.covers ?? []) {
        const [x, y, w, h] = unionOf(board0.lifts[0].keys.map((k) => captureReturn.boxes[k]));
        const [l, t, r, b] = board0.lifts[0].grown;
        const [cx, cy, cw, ch] = captureReturn.boxes[key];
        assert.ok(x + w > cx && x + w < cx + cw, 'the named box alone ends inside the covered target');
        assert.ok(x - l <= cx && y - t <= cy && x + w + r >= cx + cw && y + h + b >= cy + ch, `the grown lift covers ${key}`);
      }
      if (fixture.expect?.maxGrown !== undefined) {
        assert.ok(board0.lifts[0].grown.every((g) => g <= fixture.expect.maxGrown), `the first lift grew ${board0.lifts[0].grown} (more than ${fixture.expect.maxGrown}px on a side)`);
      }
      if (fixture.expect?.liftsApart) {
        assert.equal(intersects(board0.lifts[0].rect, board0.lifts[1].rect), false, 'the two lifts sit apart, each by moving away from the other');
        assert.equal(board0.lifts[1].k, board0.lifts[0].k, 'both share one scale');
      }
      if (captureReturn && fixture.expect?.liftCoversNothing) {
        for (const lift of board0.lifts) for (const other of fixture.expect.neighbours) {
          const [x, y, w, h] = lift.rect; const ringed = [x - LIFT_RING, y - LIFT_RING, w + 2 * LIFT_RING, h + 2 * LIFT_RING];
          const box = captureReturn.boxes[other];
          const drawn = [(box[0] - board0.frame[0]) * board0.capture[2] / board0.frame[2] + board0.capture[0], (box[1] - board0.frame[1]) * board0.capture[3] / board0.frame[3] + board0.capture[1], box[2] * board0.capture[2] / board0.frame[2], box[3] * board0.capture[3] / board0.frame[3]];
          assert.ok(!intersects(ringed, drawn), `the lift ${lift.rect} or its ring covers ${other} ${drawn}`);
        }
      }
      if (fixture.expect?.liftsPerMark) {
        const markIndexes = fixture.panels[0].marks.flatMap((m, i) => ('lift' in m ? [i] : []));
        assert.deepEqual(markIndexes.map((i) => board0.lifts.filter((l) => l.mark === i).length), fixture.expect.liftsPerMark, 'each point gets one lift per cluster');
        assert.equal(board0.labels.length, markIndexes.length, 'each point has one label however many lifts it has');
        // On a pinned board the lifts of a point share its number in place of a leader.
        const served = layoutReport.pinned ? board0.labels.map((label) => board0.pins.filter((pin) => pin.number === label.number).length) : board0.leaders.map((l) => l.targets.length);
        assert.deepEqual(served, fixture.expect.liftsPerMark, 'each leader, or each number, serves every lift of its point');
      }
      assert.ok(board0.lifts.every((l) => Boolean(l.merged) === Boolean(fixture.expect?.merged)), 'a lift reports merged only when its point was split and put back together');
      if (fixture.expect?.merged) assert.equal(board0.connectors.length, 0, 'a merged lift is drawn like a single-cluster mark: no connectors');
      if (captureReturn) for (const name of fixture.expect?.apart ?? []) {
        for (const lift of board0.lifts) {
          const [x, y, w, h] = lift.source; const [l, t, r, b] = lift.pad;
          assert.equal(intersects([x - l, y - t, w + l + r, h + t + b], captureReturn.boxes[name]), false, `${name} sits inside a lift`);
        }
      }
      if (fixture.expect?.air) {
        assert.ok(board0.air.left > 0, 'a heading flush against the frame gets painted ground beside it');
        assert.ok(!layoutReport.warnings.includes('a lift was clamped at the frame edge'));
      }
      if (fixture.expect?.cropped !== undefined) {
        const [, , fw, fh] = board0.wholeFrame; const [, , uw, uh] = board0.frame;
        assert.equal(board0.cropped, fixture.expect.cropped, 'the report says whether the frame was tightened');
        assert.equal(uw * uh < 0.5 * fw * fh, fixture.expect.cropped, 'the frame used is under half the whole frame when tightened');
        assert.ok(board0.lifts.every((l) => !l.clamped), 'no lift is clamped');
        assert.ok(Math.abs(board0.capture[2] / uw - board0.capture[3] / uh) < 0.01, 'the board shows the frame used');
      }
      if (board0.cropped) {
        // The crop is cut from the whole frame: the cleaned frame less its edge slivers, with any air it was given.
        const [fx, fy, fw, fh] = board0.frame; const [ox, oy, ow, oh] = board0.wholeFrame;
        const at = { left: fx === ox, top: fy === oy, right: fx + fw === ox + ow, bottom: fy + fh === oy + oh };
        for (const [side, kind] of Object.entries(board0.cropEdges)) {
          if (kind === 'margin') assert.equal(at[side], false, `the ${side} edge is held at its margin, so it is off the whole frame's edge`);
          else if (kind !== 'snapped' && kind !== 'word') assert.equal(at[side], true, `the ${side} edge is ${kind}, so it sits on the whole frame's edge`);
        }
      } else assert.equal(board0.cropEdges, undefined, 'an uncropped board has no crop edges');
      const allClean = { left: 'clean', top: 'clean', right: 'clean', bottom: 'clean' };
      assert.deepEqual(board0.frameEdges, fixture.expect?.frameEdges ?? allClean, 'each captured frame edge was clean, moved inward, moved outward or cut as expected');
      if (layoutReport.sharedFrame) {
        // A pair of one viewport framed twice is drawn from one frame, which never reaches past either capture's own.
        for (const { captureReturn: own } of taken) assert.ok(own && inside(layoutReport.sharedFrame.map((n) => n * board0.scale), own.frame, 0), `the shared frame ${layoutReport.sharedFrame} reaches past a capture's frame ${own?.frame}`);
      }
      if (captureReturn) {
        const given = layoutReport.sharedFrame ? layoutReport.sharedFrame.map((n) => n * board0.scale) : captureReturn.frame;
        const [cx, cy, cw, ch] = given; const [kx, ky, kw, kh] = board0.cleanFrame;
        const offset = { left: kx - cx, top: ky - cy, right: cx + cw - (kx + kw), bottom: cy + ch - (ky + kh) };
        for (const [side, kind] of Object.entries(board0.frameEdges)) {
          if (kind === 'clean' || kind === 'cut' || kind === 'image') assert.equal(offset[side], 0, `the ${side} edge is ${kind}, so it stays where the macro put it`);
          else if (kind !== 'word') assert.ok(kind === 'inward' ? offset[side] > 0 : offset[side] < 0, `the ${side} edge moved ${kind}`);
        }
      }
      if (captureReturn && fixture.expect?.cleanRows) {
        // The captured pixels on the cleaned frame's outermost rows hold nothing but the page ground.
        const shot = await readFile(captureReturn.png);
        const [kx, ky, kw, kh] = board0.cleanFrame;
        for (const side of fixture.expect.cleanRows) {
          const rect = side === 'top' ? [kx, ky, kw, 1] : [kx, ky + kh - 1, kw, 1];
          const r = await countOffColor({ png: shot, rect, color: null, renderer });
          assert.equal(r.off, 0, `${r.off} pixels on the capture's ${side} row are not ground`);
        }
      }
      if (captureReturn && fixture.expect?.leaderGround) {
        // The first leader's dot and the stretch of its first segment over the capture sit on page ground only.
        const shot = await readFile(captureReturn.png);
        const [cx, cy, cw, ch] = board0.capture; const [fx, fy, fw] = board0.frame;
        const k = fw / cw;
        const [[ax, ay], [bx, by]] = board0.leaders[0].points;
        const source = (x, y) => [fx + (x - cx) * k, fy + (y - cy) * k];
        const [sx, sy] = source(ax, ay);
        const [ex, ey] = source(Math.min(Math.max(bx, cx), cx + cw), Math.min(Math.max(by, cy), cy + ch));
        const half = 4 * k; const line = 1.5 * k;
        const rects = [[sx - half, sy - half, 2 * half, 2 * half], [Math.min(sx, ex), Math.min(sy, ey) - line, Math.abs(ex - sx), 2 * line + Math.abs(ey - sy)]];
        for (const [x, y, w, h] of rects) {
          const r = await countOffColor({ png: shot, rect: [Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h))], color: fixture.expect.leaderGround, renderer });
          assert.equal(r.off, 0, `${r.off} of ${r.total} pixels under the leader's dot or first segment are page content`);
        }
      }
      if (captureReturn && fixture.expect?.dotGround) {
        // Every dot keeps clear ground around it: the square (half-side 8, inside the 11.5px disc the layout tested) holds page ground only, rounded inward.
        const shot = await readFile(captureReturn.png);
        const [cx, cy, cw, ch] = board0.capture; const [fx, fy, fw] = board0.frame;
        const k = fw / cw;
        for (const dot of board0.dots) {
          const half = 8;
          const x0 = Math.ceil(fx + (Math.max(dot.center[0] - half, cx) - cx) * k); const y0 = Math.ceil(fy + (Math.max(dot.center[1] - half, cy) - cy) * k);
          const x1 = Math.floor(fx + (Math.min(dot.center[0] + half, cx + cw) - cx) * k); const y1 = Math.floor(fy + (Math.min(dot.center[1] + half, cy + ch) - cy) * k);
          if (x1 - x0 < 1 || y1 - y0 < 1) continue;
          const r = await countOffColor({ png: shot, rect: [x0, y0, x1 - x0, y1 - y0], color: fixture.expect.dotGround, renderer });
          assert.equal(r.off, 0, `${r.off} of ${r.total} pixels under an anchor dot are page content`);
        }
      }
      assert.ok(board0.dots.every((d) => Number.isFinite(d.slid)), 'every dot reports how far it slid from the side centre');
      if (fixture.expect?.slid) assert.ok(board0.dots.some((d) => d.slid !== 0), 'a dot slid off the centre of its side');
      if (fixture.expect?.cropEdges) assert.deepEqual(board0.cropEdges, fixture.expect.cropEdges, 'each crop edge snapped or fell back as expected');
      if (fixture.expect?.cropEdgesIn) {
        for (const panel of layoutReport.panels) assert.ok(Object.values(panel.cropEdges ?? {}).every((kind) => fixture.expect.cropEdgesIn.includes(kind)), `crop edges ${JSON.stringify(panel.cropEdges)}`);
      }
      if (fixture.expect?.wordRowsClean) {
        // The capture's line on an edge that settled in a word space holds no glyph: every pixel within 24 a channel
        // of the line's median, the cleanRows test on the sides named `word`. A crop edge is read on the frame
        // drawn, a frame edge on the cleaned frame.
        let words = 0;
        for (const [p, panel] of layoutReport.panels.entries()) {
          const { sidecar } = taken[p];
          const image = path.join(path.dirname(sidecar), JSON.parse(await readFile(sidecar, 'utf8')).image);
          const named = [...Object.entries(panel.cropEdges ?? {}).map(([side, kind]) => [side, kind, panel.frame]), ...Object.entries(panel.frameEdges).map(([side, kind]) => [side, kind, panel.cleanFrame])];
          for (const [side, kind, box] of named) {
            if (kind !== 'word') continue;
            words += 1;
            const [kx, ky, kw, kh] = box.map(Math.round);
            const [x, y, w, h] = { left: [kx, ky, 1, kh], right: [kx + kw - 1, ky, 1, kh], top: [kx, ky, kw, 1], bottom: [kx, ky + kh - 1, kw, 1] }[side];
            const points = w > 1 ? Array.from({ length: w }, (_, i) => [x + i, y]) : Array.from({ length: h }, (_, i) => [x, y + i]);
            const { at } = await readPixels({ png: await readFile(image), renderer, points });
            const median = [0, 1, 2].map((c) => at.map((rgb) => rgb[c]).sort((a, b) => a - b)[at.length >> 1]);
            const off = at.filter((rgb) => rgb.some((v, c) => Math.abs(v - median[c]) > 24)).length;
            assert.equal(off, 0, `${off} pixels on panel ${p + 1}'s ${side} word edge are not ground: a glyph is cut there`);
          }
        }
        assert.ok(words > 0, 'some edge settled in a word space');
      }
      if (fixture.expect?.darkFades) {
        const fades = layoutReport.panels.flatMap((panel) => panel.fades);
        assert.ok(fades.length > 0, 'some edge fades');
        for (const { side, ground } of fades) assert.ok(0.299 * ground[0] + 0.587 * ground[1] + 0.114 * ground[2] < 110, `the ${side} fade's ground ${ground} is not dark`);
      }
      if (fixture.expect?.noColour && fixture.expect.noColourOver) {
        // The named box of an imported panel, in its capture px, drawn where the board shows it.
        const shot = await readFile(path.join(paths.screenshotsDir, fixture.out));
        const shotScale = shot.readUInt32BE(16) / layoutReport.stage[2];
        const [x, y, w, h] = fixture.panels[0].boxes[fixture.expect.noColourOver];
        const s = board0.capture[2] / board0.frame[2];
        const drawn = [board0.capture[0] + (x - board0.frame[0]) * s, board0.capture[1] + (y - board0.frame[1]) * s, w * s, h * s];
        const r = await countOffColor({ png: shot, rect: drawn.map((v) => Math.round(v * shotScale)), color: fixture.expect.noColour, renderer, exact: true });
        assert.equal(r.matching, 0, `${r.matching} pixels over ${fixture.expect.noColourOver} are the colour it must not show`);
      } else if (fixture.expect?.noColour) {
        const shot = await readFile(path.join(paths.screenshotsDir, fixture.out));
        const shotScale = shot.readUInt32BE(16) / layoutReport.stage[2];
        for (const panel of layoutReport.panels) {
          const drawnScale = panel.capture[2] / panel.wholeFrame[2];
          assert.notEqual(drawnScale, Math.round(drawnScale), 'the frame is drawn at a fractional scale, the only case a neighbouring row can blend in');
          const r = await countOffColor({ png: shot, rect: panel.capture.map((v) => Math.round(v * shotScale)), color: fixture.expect.noColour, renderer, exact: true });
          assert.equal(r.matching, 0, 'no pixel of the row just outside the frame reaches the board');
        }
      }
      // Named boxes of each imported panel, in its capture px, drawn where the board shows them: `bare` ones lie clear
      // of every rect the board paints, `covered` ones wholly under the union of them.
      for (const key of [...(fixture.expect?.bare ?? []), ...(fixture.expect?.covered ?? [])]) {
        assert.ok(fixture.panels.some((panel) => panel.boxes?.[key]), `no panel names the box ${key}`);
      }
      for (const [p, panel] of fixture.panels.entries()) {
        const drawnPanel = layoutReport.panels[p];
        const s = drawnPanel.capture[2] / drawnPanel.frame[2];
        const drawnBox = ([x, y, w, h]) => [drawnPanel.capture[0] + (x - drawnPanel.frame[0]) * s, drawnPanel.capture[1] + (y - drawnPanel.frame[1]) * s, w * s, h * s];
        const painted = drawnPanel.redactions.flatMap((r) => r.rects);
        for (const key of fixture.expect?.bare ?? []) {
          if (!panel.boxes?.[key]) continue;
          const over = painted.filter((rect) => intersects(rect, drawnBox(panel.boxes[key])));
          assert.deepEqual(over, [], `a redaction paints over ${key} on panel ${p + 1}`);
        }
        for (const key of fixture.expect?.covered ?? []) {
          if (!panel.boxes?.[key]) continue;
          const [x, y, w, h] = drawnBox(panel.boxes[key]);
          for (let i = 0; i <= 8; i += 1) for (let j = 0; j <= 4; j += 1) {
            const [px, py] = [x + 0.5 + (w - 1) * i / 8, y + 0.5 + (h - 1) * j / 4];
            assert.ok(painted.some(([rx, ry, rw, rh]) => px >= rx && px <= rx + rw && py >= ry && py <= ry + rh), `${key} on panel ${p + 1} shows at ${px},${py} outside every rect`);
          }
        }
      }
      if (fixture.expect?.lensNoColour) {
        const shot = await readFile(path.join(paths.screenshotsDir, fixture.out));
        const shotScale = shot.readUInt32BE(16) / layoutReport.stage[2];
        const loupes = layoutReport.panels.flatMap((panel) => panel.loupes);
        assert.ok(loupes.length > 0, 'the board draws a lens');
        for (const { lens } of loupes) {
          const r = await countOffColor({ png: shot, rect: lens.map((v) => Math.round(v * shotScale)), color: fixture.expect.lensNoColour, renderer, exact: true });
          assert.equal(r.matching, 0, `${r.matching} lens pixels show a colour the crop left out or a redaction hides`);
        }
      }
      if (fixture.expect?.noRuleAtEdge) {
        const shot = await readFile(path.join(paths.screenshotsDir, fixture.out));
        const shotScale = shot.readUInt32BE(16) / layoutReport.stage[2];
        // A trimmed frame keeps 12 px of ground under its last ink (TRIM_PAD), and the ink's faint fringe counts as
        // ground there, so the band stays clear of both. Under a lift's wash a divider is a few levels off the ground.
        const [x, y, w, h] = board0.capture;
        // A leader that leaves the panel downward crosses the band, so the band stands between the columns where leaders cross its bottom edge.
        const bottom = y + h;
        const crossings = board0.leaders.flatMap(({ points }) => points.slice(1).flatMap((q, k) => {
          const p = points[k];
          return Math.min(p[1], q[1]) < bottom && Math.max(p[1], q[1]) >= bottom ? [p[0] + ((q[0] - p[0]) * (bottom - p[1])) / (q[1] - p[1])] : [];
        }));
        const spans = [];
        let from = x + 8;
        for (const lx of crossings.sort((m, n) => m - n)) {
          if (lx - 4 > from) spans.push([from, lx - 4]);
          from = Math.max(from, lx + 4);
        }
        if (x + w - 8 > from) spans.push([from, x + w - 8]);
        for (const [a, b] of spans) {
          const band = await countOffColor({ png: shot, rect: [a, y + h - 10, b - a, 8].map((v) => Math.round(v * shotScale)), color: fixture.expect.ground ?? [255, 255, 255], tolerance: 12, renderer });
          assert.equal(band.off, 0, 'no divider runs along the panel\'s bottom edge');
        }
      }
      if (fixture.expect?.noPartialOutline) {
        // The lift holds a line of the outline's colour (sidesHolding) on all four sides or on none.
        const shot = await readFile(path.join(paths.screenshotsDir, fixture.out));
        const shotScale = shot.readUInt32BE(16) / layoutReport.stage[2];
        const [x, y, w, h] = board0.lifts[0].rect;
        const outlined = await sidesHolding(shot, shotScale, board0.lifts[0].rect, OUTLINE, board0.capture[2] / (board0.frame[2] / board0.scale));
        assert.ok(outlined.length === 0 || outlined.length === 4, `the lift shows the outline on its ${outlined.join(', ')} side only`);
        // The card still covers the outline it dropped. Beside its left and right edges, from just past its 3 px
        // ring to 10 board px out, and from 4 px past each corner to 16 px short of it, no row holds a line of the
        // page: a png px darker by more than 24 (summed) than the one 2 px further from the card. The card's shadow
        // darkens toward it only gradually.
        const span = (from, to) => [...Array(Math.round((to - from) * shotScale)).keys()].map((n) => Math.round(from * shotScale) + n);
        const columns = [...span(x - 10, x - 3.5).map((cx) => [cx, -2]), ...span(x + w + 3.5, x + w + 10).map((cx) => [cx, 2])];
        const rows = [...span(y - 4, y + 16), ...span(y + h - 16, y + h + 4)];
        const points = columns.flatMap(([cx, out]) => rows.flatMap((cy) => [[cx, cy], [cx + out, cy]]));
        const { at } = await readPixels({ png: shot, renderer, points });
        const sum = (rgb) => rgb[0] + rgb[1] + rgb[2];
        const lined = new Set();
        for (let i = 0; i < at.length; i += 2) if (sum(at[i + 1]) - sum(at[i]) > 24) lined.add(`${points[i][0] < x * shotScale ? 'left' : 'right'} ${points[i][1]}`);
        assert.ok(lined.size <= 2, `${lined.size} rows beside the lift's corners show a thin line of the page`);
      }
      if (fixture.expect?.liftKeeps) {
        // A line the element draws itself is kept on the card: [side, colour] pairs, read as noPartialOutline reads.
        const shot = await readFile(path.join(paths.screenshotsDir, fixture.out));
        const shotScale = shot.readUInt32BE(16) / layoutReport.stage[2];
        for (const [side, colour] of fixture.expect.liftKeeps) {
          assert.ok((await sidesHolding(shot, shotScale, board0.lifts[0].rect, colour, board0.capture[2] / (board0.frame[2] / board0.scale))).includes(side), `the lift keeps its ${side} line of ${colour}`);
        }
      }
      if (fixture.expect?.liftShows) {
        // A mark of the page beside the outline stays on the card: each colour fills 20 png px or more of it.
        const shot = await readFile(path.join(paths.screenshotsDir, fixture.out));
        const shotScale = shot.readUInt32BE(16) / layoutReport.stage[2];
        for (const colour of fixture.expect.liftShows) {
          const r = await countOffColor({ png: shot, rect: board0.lifts[0].rect.map((v) => Math.round(v * shotScale)), color: colour, renderer });
          assert.ok(r.total - r.off >= 20, `the lift shows ${colour} (${r.total - r.off} px)`);
        }
      }
      if (fixture.expect?.evenBottom) {
        // Beyond an outline's open side the card shows the page as it is: each png row 2 to 10 board px above the
        // card's bottom edge is one colour 5 px in from each end (inside its 7 px rounded corner there) and at its
        // middle, never ground at the ends with the page's tint between them.
        const shot = await readFile(path.join(paths.screenshotsDir, fixture.out));
        const shotScale = shot.readUInt32BE(16) / layoutReport.stage[2];
        const [x, y, w, h] = board0.lifts[0].rect;
        const rows = [...Array(Math.round(8 * shotScale)).keys()].map((n) => Math.round((y + h - 10) * shotScale) + n);
        const points = rows.flatMap((ry) => [x + 5, x + w / 2, x + w - 5].map((px) => [Math.round(px * shotScale), ry]));
        const { at } = await readPixels({ png: shot, renderer, points });
        const apart = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
        for (let i = 0; i < at.length; i += 3) {
          assert.ok(apart(at[i], at[i + 1]) <= 24 && apart(at[i + 1], at[i + 2]) <= 24, `row ${points[i][1]} of the card's bottom is ${at[i]} at its ends and ${at[i + 1]} between`);
        }
      }
      if (fixture.expect?.frameInside) {
        assert.ok(inside(board0.frame, fixture.panels[0].frame, 0), `the drawn frame ${board0.frame} lies inside the spec's frame ${fixture.panels[0].frame}`);
        assert.ok(inside(board0.cleanFrame, fixture.panels[0].frame, 0), `the cleaned frame ${board0.cleanFrame} lies inside the spec's frame`);
        assert.ok(!Object.values(board0.frameEdges).includes('outward'), `no imported edge moves outward: ${JSON.stringify(board0.frameEdges)}`);
      }
      if (fixture.expect?.frameBelow) {
        // A target listed only to be measured, never marked: the drawn frame starts under it. The spec's boxes are CSS px.
        const key = fixture.expect.frameBelow;
        const [, y, , h] = captureReturn ? captureReturn.boxes[key] : fixture.panels[0].boxes[key].map((n) => n * board0.scale);
        assert.ok(board0.frame[1] >= y + h, `the drawn frame's top ${board0.frame[1]} lies above the ${key} box's bottom ${y + h}`);
      }
      if (fixture.expect?.frameUnder) {
        // The drawn frame is in capture px and the spec's in CSS px. A live capture's frame is its element's whole box.
        const specW = fixture.panels[0].frame ? fixture.panels[0].frame[2] : board0.wholeFrame[2] / board0.scale;
        const drawnW = board0.frame[2] / board0.scale;
        assert.ok(drawnW < specW * fixture.expect.frameUnder, `the drawn frame is ${drawnW} of the spec's ${specW} px: the blank ground went`);
      }
      if (fixture.expect?.trimmed) {
        for (const [side, n] of Object.entries(fixture.expect.trimmed)) assert.equal(board0.trimmed[side], n, `the ${side} edge trimmed ${board0.trimmed[side]} capture px`);
      }
      if (fixture.expect?.trimTo) {
        // The trimmed edge keeps TRIM_PAD (12 CSS px) of ground outside the target's box and no more than a glyph's fringe past that.
        for (const [side, key] of Object.entries(fixture.expect.trimTo)) {
          const [x, y, w, h] = captureReturn.boxes[key]; const [fx, fy, fw, fh] = board0.frame;
          const gap = { left: x - fx, top: y - fy, right: fx + fw - (x + w), bottom: fy + fh - (y + h) }[side] / board0.scale;
          assert.ok(gap >= 0 && gap <= 12 + 2, `the ${side} edge stands ${gap} CSS px outside the ${key} box`);
        }
      }
      if (fixture.expect?.drawnOver) {
        const drawn = board0.capture[2] / (board0.frame[2] / board0.scale);
        assert.ok(drawn > fixture.expect.drawnOver, `the frame is drawn at ${drawn} board px per CSS px`);
      }
      if (fixture.expect?.leaderRunUnder) {
        const [[x0, y0], [x1, y1]] = board0.leaders[0].points;
        const run = Math.hypot(x1 - x0, y1 - y0);
        assert.ok(run < fixture.expect.leaderRunUnder, `the leader's first run is ${Math.round(run)} board px`);
      }
      if (fixture.expect?.sameRect) {
        // Each state is framed on its own card, so a rectangle is compared by where it sits in the frame captured.
        const [first, ...rest] = layoutReport.panels.map((p) => [p.frame[0] - p.cleanFrame[0], p.frame[1] - p.cleanFrame[1], p.frame[2], p.frame[3]].map((n) => n / p.scale));
        for (const other of rest) assert.deepEqual(other, first, 'both panels show the same rectangle');
        for (const p of layoutReport.panels) assert.ok(p.frame[1] + p.frame[3] < p.cleanFrame[1] + p.cleanFrame[3], 'and neither fell back to its cleaned frame: the card border at the bottom went');
      }
      if (fixture.expect?.noWarnings || fixture.expect?.warnings) {
        const expected = fixture.expect.warnings ?? [];
        assert.deepEqual(layoutReport.warnings, expected, 'the board renders with exactly the warnings it declares');
        assert.deepEqual(report.warnings, expected, "compose()'s returned warnings are the layout report's");
      }
      if (fixture.expect?.grownFills !== undefined) {
        assert.equal(layoutReport.warnings.filter((w) => /^a redaction on panel 1 \(.+\) grew to cover ink beside it$/.test(w)).length, fixture.expect.grownFills, 'the render says each fill that grew past its pad');
        assert.deepEqual(report.warnings, layoutReport.warnings, 'and the command returns the same warnings');
      }
      if (fixture.expect?.padClamped) {
        const side = ['left', 'top', 'right', 'bottom'].indexOf(fixture.expect.padClamped);
        assert.ok(board0.lifts[0].pad[side] < 4, `the ${fixture.expect.padClamped} padding stops short of the neighbouring content`);
      }
      if (fixture.expect?.minLiftHeight) {
        assert.ok(board0.lifts[0].rect[3] >= fixture.expect.minLiftHeight - 0.5, `the lift renders at least ${fixture.expect.minLiftHeight}px tall`);
      }
      if (fixture.expect?.slotFillGap !== undefined) {
        assert.ok(board0.redactions.length > 0 && board0.slots.length > 0, 'the board draws a slot and a fill');
        for (const { rect: [sx, sy, sw, sh] } of board0.slots) for (const [fx, fy, fw, fh] of board0.redactions.flatMap((r) => r.rects)) {
          const apart = Math.max(fx - (sx + sw), sx - (fx + fw), fy - (sy + sh), sy - (fy + fh));
          assert.ok(apart >= fixture.expect.slotFillGap - 1e-6, `the slot ${[sx, sy, sw, sh]} stands ${apart} px from the fill ${[fx, fy, fw, fh]}`);
        }
      }
      if (fixture.expect?.hatched) {
        assert.deepEqual(board0.slots.map((slot) => slot.hatched), fixture.expect.hatched, 'a ghost hatches a blank and only outlines content');
      }
      if (fixture.expect?.minSlot) {
        const [, , w, h] = board0.slots[0].rect;
        assert.ok(w >= fixture.expect.minSlot - 1e-6 && h >= fixture.expect.minSlot - 1e-6, `the slot is drawn ${w} by ${h}`);
      }
      if (fixture.expect?.slots) {
        assert.deepEqual(board0.slots.map((s) => [s.kind, s.text]), fixture.expect.slots, 'each slot is drawn as expected');
        assert.equal(board0.wash, board0.lifts.length > 0, 'a slot alone raises no wash');
      }
      if (fixture.expect?.slotCallout) {
        const onSlot = (item) => board0.targets[item.target]?.kind === 'slot';
        assert.equal(board0.labels.filter(onSlot).length, 1, "the empty slot's text is a label of its own");
        assert.equal(layoutReport.pinned, fixture.expect.slotCallout === 'pin', `the board is ${layoutReport.pinned ? '' : 'not '}pinned`);
        assert.ok((layoutReport.pinned ? board0.pins : board0.leaders).some(onSlot), 'and its pin or leader stands on the slot');
      }
      if (fixture.expect?.brackets) {
        assert.deepEqual(board0.brackets.map((b) => b.inMargin), fixture.expect.brackets, 'each bracket sits inside the frame or in the margin as expected');
        assert.equal(board0.flats.length, fixture.expect.flats, 'bracketed rows are redrawn flat only under a wash');
      }
      if (fixture.expect?.tightLift) {
        const [lift] = board0.lifts; const frameW = board0.frame[2];
        assert.ok(lift.source[2] < frameW / 2, `the lift is ${lift.source[2]} of a ${frameW} px frame: it took the row, not its words`);
        assert.equal(lift.adopted, true, 'the ticks that lead the lines are inside the card');
      }
      if (fixture.expect?.bracketNear) {
        const [bracket] = board0.brackets;
        assert.equal(bracket.inMargin, false, 'the bracket stands beside the words, not in the margin');
        assert.ok(bracket.rows[2] < board0.capture[2] / 2, `the bracket's rows are ${bracket.rows[2]} of a ${board0.capture[2]} px panel: the rows, not their words`);
        assert.ok(bracket.rect[0] - (bracket.rows[0] + bracket.rows[2]) <= fixture.expect.bracketNear);
        assert.ok(!layoutReport.warnings.includes('a bracket sits on page content'), 'a divider between rows is not content to a bracket');
      }
      if (fixture.expect?.loupes) assert.deepEqual(board0.loupes.map((l) => l.zoom), fixture.expect.loupes, 'each loupe magnifies as asked');
      if (fixture.expect?.links !== undefined) assert.equal(board0.links.length, fixture.expect.links, 'each link is drawn');
      if (fixture.expect?.pinned !== undefined) assert.equal(layoutReport.pinned, fixture.expect.pinned, 'the board draws pins and a legend only when no side takes every label');
      if (fixture.expect?.stacked !== undefined) assert.equal(layoutReport.stacked, fixture.expect.stacked, 'the panels stand in a column only when a row of them would be a strip');
      if (fixture.expect?.contextIn) {
        const { panel: p, key } = fixture.expect.contextIn; const own = layoutReport.panels[p];
        assert.ok(inside(taken[p].captureReturn.boxes[key], own.frame, 0), `the ${key} box lies inside panel ${p + 1}'s drawn frame ${own.frame}`);
        const marks = fixture.panels[p].marks;
        assert.equal(own.lifts.length, marks.filter((m) => m.lift).length, 'a context mark draws no lift');
        assert.equal(own.labels.length, marks.filter((m) => m.title).length, 'and no label');
        assert.ok(own.pins.length <= own.labels.length, 'and no pin');
      }
      if (fixture.expect?.oneZoom) {
        // Frames this far apart in height are drawn at clashing zooms at one height.
        const heights = layoutReport.panels.map((panel) => panel.capture[3]);
        assert.ok(Math.max(...heights) > 1.25 * Math.min(...heights), `the panels are drawn ${heights} high`);
        assert.ok(oneZoom(layoutReport.panels), `the panels are drawn at zooms ${layoutReport.panels.map((p) => p.capture[3] / (p.frame[3] / p.scale))}`);
        layoutReport.arrows.forEach(([, y, , h], i) => {
          const [before, after] = [layoutReport.panels[i].capture, layoutReport.panels[i + 1].capture];
          assert.ok(Math.abs(y + h / 2 - (after[1] + Math.min(before[3], after[3]) / 2)) <= 1, `arrow ${i + 1} stands level with the smaller panel it joins`);
        });
      }
      if (fixture.expect?.headNotes) {
        layoutReport.panels.forEach((panel, i) => {
          assert.equal(panel.head.tag, fixture.panels[i].tag, `panel ${i + 1} says its tag`);
          assert.equal(panel.head.note, fixture.panels[i].note, `panel ${i + 1} says its note`);
        });
        assert.ok(layoutReport.panels.some((panel) => panel.head.note), 'some panel carries a note');
        assert.ok(layoutReport.panels.every((panel) => panel.capture[1] === layoutReport.panels[0].capture[1]), 'the captures stand level whatever each head carries');
        assert.ok(layoutReport.panels.every((panel) => panel.head.rect[3] === layoutReport.panels[0].head.rect[3]), 'the heads share one height');
      }
      const board = await readFile(report.out);
      const marks = fixture.panels[0].marks;
      const fill = [1, 3, 5].map((i) => parseInt(REDACT_FILL.slice(i, i + 2), 16));
      assert.equal(board0.redactions.length > 0, marks.some((m) => m.redact) && !fixture.expect?.emptyRedactionRecord, 'redactions in the report match the spec');
      // Under a lift the fill is exact. Elsewhere it carries the lift's drop
      // shadow, so that part gets a wider tolerance that still catches white or
      // dark leaked content.
      const scale = board.readUInt32BE(16) / layoutReport.stage[2];
      const px = (r) => r.map((v) => Math.round(v * scale));
      const leaderPoints = [...board0.leaders, ...board0.connectors].flatMap((l) => l.points);
      let sampled = 0;
      // What the board and crop checks sample of rects too thin to inset, which `thinRects` fixtures must reach.
      let thinSampled = 0; let thinChecked = 0;
      // Samples a CSS-px region minus 10px bands around any leader point inside it.
      const sample = async ([x0, y0, x1, y1], tolerance, label) => {
        if (x1 - x0 <= 0 || y1 - y0 <= 0) return;
        const cuts = leaderPoints.filter(([x, y]) => x > x0 - 10 && x < x1 + 10 && y > y0 - 10 && y < y1 + 10).map(([x]) => x).sort((a, b) => a - b);
        const spans = cuts.reduce((acc, x) => {
          const last = acc.pop();
          return [...acc, ...[[last[0], Math.min(last[1], x - 10)], [Math.max(last[0], x + 10), last[1]]].filter(([a, b]) => b - a > 1)];
        }, [[x0, x1]]);
        for (const [a, b] of spans) {
          const r = await countOffColor({ png: board, rect: px([a, y0, b - a, y1 - y0]), color: fill, tolerance, renderer });
          assert.equal(r.off, 0, `${r.off} of ${r.total} pixels in a redaction (${label}) are not the fill`);
          sampled += r.total;
        }
      };
      // Every rect of a redaction is the fill colour throughout; what lies between an imported redaction's rects is not.
      for (const redaction of board0.redactions) {
        let seen = 0;
        for (const rect of redaction.rects) {
          assert.deepEqual(Object.keys(redaction).sort(), ['fill', 'rect', 'rects'], 'a redaction is its rects and fill alone: the fill marks it, no pill');
          const [rx, ry, rw, rh] = rect;
          sampled = 0;
          // A lift's 3px ring is drawn outside its rect, so a card that stands within it of a fill covers the fill's edge too.
          const lifts = board0.lifts.filter((l) => intersects([l.rect[0] - 3, l.rect[1] - 3, l.rect[2] + 6, l.rect[3] + 6], rect));
          if (rw < 8 || rh < 4) {
            // Too thin to inset past both edges: the line down its middle, exact under a lift and loose clear of its ring.
            const line = thinCore(rect);
            if (!line) continue;
            for (const l of lifts) {
              const under = clipTo(line, [l.rect[0] + 3, l.rect[1] + 3, l.rect[2] - 6, l.rect[3] - 6]);
              await sample([under[0], under[1], under[0] + under[2], under[1] + under[3]], 24, 'a thin rect under a lift');
            }
            const clear = lifts.reduce((pieces, l) => pieces.flatMap((piece) => minus(piece, [l.rect[0] - 4, l.rect[1] - 4, l.rect[2] + 8, l.rect[3] + 8])), [line]);
            for (const [x, y, w, h] of clear) await sample([x, y, x + w, y + h], 70, 'a thin rect');
            assert.ok(sampled > 0, `a thin redaction rect ${rect} was never sampled`);
            seen += sampled; thinSampled += sampled;
            continue;
          }
          for (const l of lifts) {
            const [lx, ly, lw, lh] = l.rect;
            await sample([Math.max(lx, rx) + 3, Math.max(ly, ry) + 3, Math.min(lx + lw, rx + rw) - 3, Math.min(ly + lh, ry + rh) - 3], 24, 'under a lift');
          }
          // Rows outside every lift, a 4px margin clear of its white ring.
          let rows = [[ry, ry + rh]];
          for (const l of lifts) {
            rows = rows.flatMap(([a, b]) => [[a, Math.min(b, l.rect[1] - 4)], [Math.max(a, l.rect[1] + l.rect[3] + 4), b]]).filter(([a, b]) => b - a > 2);
          }
          for (const [a, b] of rows) {
            await sample([rx + 3, Math.max(a, ry) + 1, rx + rw - 3, b - 1], 70, 'outside lifts');
          }
          assert.ok(sampled > 0, 'a redaction rect was never sampled');
          seen += sampled;
        }
        assert.ok(seen > 0, `a redaction at ${redaction.rect} was never sampled`);
      }
      const redactMarks = marks.filter((m) => m.redact);
      const redactedKeys = new Set(redactMarks.flatMap((m) => [].concat(m.redact)));
      if (marks.some((m) => m.lift && [].concat(m.lift).some((key) => redactedKeys.has(key)))) {
        const crossed = board0.lifts.some((l) => board0.redactions.some((r) => intersects(l.rect, r.rect)));
        assert.ok(crossed, 'a lift overlaps a redaction');
      }
      if (captureReturn && board0.redactions.length === redactMarks.length) {
        // What a fill leaves bare of its box and reach is ground in the capture. The fill is taken a pixel larger: its rect went through the board's scale.
        const shot = await readFile(captureReturn.png);
        const [cx, cy, cw] = board0.capture; const [fx, fy, fw, fh] = board0.frame; const k = fw / cw;
        for (const [i, mark] of redactMarks.entries()) {
          const [bx, by, bw, bh] = unionOf([].concat(mark.redact).map((key) => captureReturn.boxes[key]));
          const x0 = Math.floor(bx - REDACT_REACH); const y0 = Math.floor(by - REDACT_REACH);
          const reach = clipTo([x0, y0, Math.ceil(bx + bw + REDACT_REACH) - x0, Math.ceil(by + bh + REDACT_REACH) - y0], [fx, fy, fw, fh]);
          const [rx, ry, rw, rh] = board0.redactions[i].rect;
          const drawn = [fx + (rx - cx) * k - 1, fy + (ry - cy) * k - 1, rw * k + 2, rh * k + 2];
          for (const [x, y, w, h] of minus(reach, drawn)) {
            const rect = [Math.ceil(x), Math.ceil(y), Math.floor(x + w) - Math.ceil(x), Math.floor(y + h) - Math.ceil(y)];
            if (rect[2] <= 0 || rect[3] <= 0) continue;
            const bare = await countOffColor({ png: shot, rect, color: null, tolerance: 24, renderer });
            assert.equal(bare.off, 0, `${bare.off} of ${bare.total} pixels a fill leaves bare (${rect}) are not ground`);
          }
        }
      }
      if (fixture.expect?.emptyRedactionRecord) {
        // An imported panel's redact mark that lands nowhere is still gated: the record stands, empty, and names the board.
        assert.deepEqual(report.redactions.crops, [], 'no crop for a mark that hides nothing');
        const body = JSON.parse(await readFile(report.redactions.record, 'utf8'));
        assert.deepEqual(body.redactions, [], 'the record lists no redaction');
        assert.equal(body.boardSha256, createHash('sha256').update(board).digest('hex'), 'the record names the board it was rendered with');
        assert.equal(layoutReport.warnings.filter((w) => w.includes('lies outside the board')).length, fixture.expect.strayMarks, 'the render says each stray mark hides nothing');
        const options = { paths, rendererLocation: async () => renderer };
        const confirmed = await compose({ command: 'compose', confirm: specPath }, options);
        assert.equal(confirmed.confirmed, 0, 'confirm has nothing to confirm');
        assert.deepEqual(JSON.parse(await readFile(report.redactions.record, 'utf8')), body, 'and writes nothing');
      } else if (fixture.expect?.crops === undefined) assert.equal(report.redactions, undefined, 'a board with no imported redaction has no record');
      else {
        assert.equal(report.redactions.crops.length, fixture.expect.crops, 'one crop per drawn redaction');
        const body = JSON.parse(await readFile(report.redactions.record, 'utf8'));
        assert.ok(body.redactions.every((r) => r.confirmed === false), 'a fresh render is unconfirmed');
        for (const [i, file] of report.redactions.crops.entries()) {
          const bytes = await readFile(file);
          const [, , w, h] = layoutReport.crops[i].rect;
          // A fractional stage makes the board's measured scale a hair off the whole device scale the crop is cut at.
          const device = Math.round(scale);
          assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [Math.round(w * device), Math.round(h * device)], 'the crop is at the board\'s full resolution');
          // Each rect of the drawn redaction, inset past its antialiased edge, is fill and nothing else.
          const { panel, redaction } = layoutReport.crops[i];
          const [cx, cy] = layoutReport.crops[i].rect;
          let checked = 0;
          for (const [rx, ry, rw, rh] of layoutReport.panels[panel].redactions[redaction].rects) {
          const thin = rw < 8 || rh < 8;
          const inner = thin ? thinCore([rx, ry, rw, rh]) : [rx + 3, ry + 3, rw - 6, rh - 6];
          if (!inner) continue;
          // Only the part within a lift's shadow reach gets the loose tolerance, which takes in a wash under that shadow.
          // The rest of the fill is exact: the fill itself, or on a washed panel the fill seen through the wash.
          const shadowed = layoutReport.panels[panel].lifts.map((l) => [l.rect[0] - LIFT_SHADOW_REACH, l.rect[1] - LIFT_SHADOW_REACH, l.rect[2] + 2 * LIFT_SHADOW_REACH, l.rect[3] + 2 * LIFT_SHADOW_REACH]).filter((r) => intersects(r, inner));
          const clear = shadowed.reduce((pieces, hole) => pieces.flatMap((piece) => minus(piece, hole)), [inner]);
          const parts = [...clear.map((r) => [r, 24, underWash(fill, layoutReport.panels[panel])]), ...shadowed.map((r) => [clipTo(r, inner), 70, fill])];
          for (const [part, tolerance, color] of parts) {
            const rect = [part[0] - cx, part[1] - cy, part[2], part[3]].map((v) => Math.round(v * scale));
            if (rect[2] <= 0 || rect[3] <= 0) continue;
            const off = await countOffColor({ png: bytes, rect, color, tolerance, renderer });
            assert.equal(off.off, 0, `${off.off} pixels of a crop's redaction are not fill (tolerance ${tolerance})`);
            checked += off.total;
            if (thin) thinChecked += off.total;
          }
          }
          assert.ok(checked > 0, `crop ${i + 1}'s redaction was never sampled`);
        }
        if (fixture.expect.thinRects) assert.ok(thinSampled > 0 && thinChecked > 0, `a thin rect was sampled ${thinSampled} times on the board and ${thinChecked} in its crop`);
        const options = { paths, rendererLocation: async () => renderer };
        assert.equal((await compose({ command: 'compose', confirm: specPath }, options)).confirmed, fixture.expect.crops);
        await compose({ command: 'compose', spec: specPath }, options);
        const again = JSON.parse(await readFile(report.redactions.record, 'utf8'));
        assert.ok(again.redactions.every((r) => r.confirmed === false), 're-rendering resets the confirmation');
      }
      const golden = path.join(goldenDir, `${path.basename(file, '.json')}.png`);
      if (process.env.UPDATE_GOLDENS === '1') {
        await mkdir(goldenDir, { recursive: true });
        await writeFile(golden, board);
        return;
      }
      if (fixture.expect?.cleanRows?.includes('top')) {
        // The first rows past the rounded corners, which show what lies behind the board. A trimmed frame's edge
        // stands near its lift, whose shadow (0 12px 28px, round a 3px ring) reaches 16px above the card and 31px
        // to each side: the columns it darkens are left out.
        const [bx, by, bw] = board0.capture;
        const shaded = board0.lifts.filter((l) => l.rect[1] - LIFT_SHADOW_ABOVE < by + 4).map((l) => [l.rect[0] - LIFT_SHADOW_BESIDE, l.rect[0] + l.rect[2] + LIFT_SHADOW_BESIDE]);
        const spans = shaded.reduce((open, [from, to]) => open.flatMap(([a, b]) => [[a, Math.min(b, from)], [Math.max(a, to), b]]).filter(([a, b]) => b - a >= 8), [[bx + 20, bx + bw - 20]]);
        assert.ok(spans.length > 0, "none of the board's top edge is clear of a lift's shadow");
        for (const [a, b] of spans) {
          const r = await countOffColor({ png: board, rect: px([a, by + 1, b - a, 3]), color: null, tolerance: 6, renderer });
          assert.equal(r.off, 0, `${r.off} pixels on the board's top edge are not ground: a glyph is cut there`);
        }
      }
      const diff = await diffPngs({ a: board, b: await readFile(golden), renderer });
      assert.equal(diff.sameSize, true, 'board and golden differ in size');
      assert.ok(diff.differing / diff.total < 0.002, `${diff.differing} of ${diff.total} pixels differ from the golden`);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
}

test('an imported fill hides every pixel of each real-glyph probe value, at 1x, 2x and 3x', { skip }, async () => {
  const { chromium } = await import(renderer.playwrightCore);
  const browser = await chromium.launch({ headless: true, executablePath: renderer.executablePath });
  let results;
  try {
    results = await runFillProbes({ browser, geometrySource: await readFile(new URL('../../lib/compose/page-geometry.js', import.meta.url), 'utf8') });
  } finally { await browser.close(); }
  assert.equal(results.length, 1419, 'every probe of the real, real2, real3 and real4 sets ran');
  // The pad alone (a25cc09) leaves 499 of them bare; the probes still reach past it.
  assert.ok(results.filter((r) => r.padBare > 0).length >= 400, 'the probes still find ink a 12 px pad leaves bare');
  const bare = results.filter((r) => r.bare > 0);
  assert.deepEqual(bare.map((r) => `${r.set} ${r.name}: ${r.bare} px`), [], 'no probe shows a pixel of its value');
  assert.deepEqual(results.filter((r) => !r.holds).map((r) => `${r.set} ${r.name}`), [], 'no fill is smaller than the 12 px pad\'s');
  assert.deepEqual(results.filter((r) => r.capped).map((r) => `${r.set} ${r.name}`), [], 'no probe reaches the growth limit');
});

test('an imported fill hides capitals, digits, values wrapped onto several lines or past a margin and a far word, or refuses the board', { skip }, async () => {
  const { chromium } = await import(renderer.playwrightCore);
  const browser = await chromium.launch({ headless: true, executablePath: renderer.executablePath });
  let results;
  try {
    results = await runFillProbes({ browser, cases: fillProbeHardCases(), geometrySource: await readFile(new URL('../../lib/compose/page-geometry.js', import.meta.url), 'utf8') });
  } finally { await browser.close(); }
  assert.equal(results.length, 2307, 'every probe of the density, bar, wrap, lines, gap, reach, off, wrapleft, rtl, grid and list sets ran');
  assert.ok(results.filter((r) => r.padBare > 0).length >= 1700, 'the probes still find ink a 12 px pad leaves bare');
  // A refused board is never written, so what its fill left bare is never shown. A written board shows no pixel
  // of the value, whatever it warns.
  assert.deepEqual(results.filter((r) => r.bare > 0 && !r.refused).map((r) => `${r.set} ${r.name}: ${r.bare} px`), [], 'no written board shows a pixel of its value');
  // A row spared as the list's may hold a second value, so the board is refused naming it; a case with no row to
  // spare is written, hidden.
  const list = results.filter((r) => r.set === 'list');
  assert.equal(list.length, 210);
  const sparing = list.filter((r) => /^(one row of an icon-led list|text that runs right to left|the next row is a second value)/.test(r.name));
  assert.equal(sparing.length, 60);
  assert.deepEqual(sparing.filter((r) => !(r.refused && r.whys.includes('row'))).map((r) => r.name), [], 'a row of an icon-led list, either way round, refuses the board for the rows it spares');
  assert.deepEqual(list.filter((r) => r.refused && !r.whys.includes('row')).map((r) => `${r.name}: ${r.whys}`), [], 'a list case is refused only for a spared row');
  assert.deepEqual(list.filter((r) => r.name.startsWith('a two-line icon-sized label') && r.refused).map((r) => r.name), [], 'a two-line label beside a two-line value is no list: its board is written');
  assert.deepEqual(results.filter((r) => !r.holds).map((r) => `${r.set} ${r.name}`), [], 'no fill is smaller than the 12 px pad\'s');
  // A box drawn off its value holds no ink of its own, and the 12 px pad alone leaves most of the value bare. One
  // above the value or in its gap is written whole; one short of it on the left meets the value running on past
  // the limit along its own line, which may refuse the board.
  const off = results.filter((r) => r.set === 'off');
  assert.equal(off.length, 24);
  assert.ok(off.every((r) => r.padBare > 0), 'the pad alone leaves the value bare');
  assert.deepEqual(off.filter((r) => !r.name.startsWith('box left') && (r.refused || r.bare > 0)).map((r) => r.name), [], 'every box above the value or in its gap is written with the value hidden');
  // A second line wholly left of the first line's columns is covered, not left to the gate.
  const wrapleft = results.filter((r) => r.set === 'wrapleft');
  assert.equal(wrapleft.length, 96);
  assert.deepEqual(wrapleft.filter((r) => r.refused || r.bare > 0).map((r) => r.name), [], 'every value wrapped to its container\'s left edge is written with both lines hidden');
  // Right to left with a label before the value, the box on its second line, the label shares the first line's rows:
  // no reason leaves it bare, so the board is refused naming it (a context mark on it recovers).
  const rtl = results.filter((r) => r.set === 'rtl');
  assert.equal(rtl.length, 12);
  assert.deepEqual(rtl.filter((r) => r.bare > 0 || (r.refused !== r.name.startsWith('label, wraps right, box on line 2'))).map((r) => r.name), [], 'every value wrapped to its container\'s right edge is hidden, written but for the label beside its first line');
  assert.deepEqual([...new Set(rtl.filter((r) => r.refused).flatMap((r) => r.whys))], ['reach']);
  const gridRows = results.filter((r) => r.set === 'grid');
  assert.equal(gridRows.length, 24);
  assert.deepEqual(gridRows.filter((r) => r.bare > 0 && !r.refused).map((r) => r.name), [], 'a two-line label beside the value never leaves its second line bare');
});

test('a bundle copied to another folder renders the same board', { skip }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'fb-move-'));
  try {
    const { paths, specPath } = await prepare('import-pair-3x.json', home);
    const options = { paths, rendererLocation: async () => renderer };
    const first = await compose({ command: 'compose', spec: specPath }, options);
    const original = await readFile(first.out);
    const moved = path.join(home, 'elsewhere');
    await mkdir(moved);
    for (const entry of await readdir(paths.screenshotsDir)) {
      if (/\.(spec\.json|capture\.json)$/.test(entry) || /\.c\d+\.png$/.test(entry)) await copyFile(path.join(paths.screenshotsDir, entry), path.join(moved, entry));
    }
    for (const entry of await readdir(paths.screenshotsDir)) await rm(path.join(paths.screenshotsDir, entry), { recursive: true });
    const second = await compose({ command: 'compose', spec: path.join(moved, path.basename(specPath)) }, options);
    assert.equal(second.out, first.out, 'the board still lands in the screenshots folder');
    const diff = await diffPngs({ a: original, b: await readFile(second.out), renderer, tolerance: 0 });
    assert.deepEqual([diff.sameSize, diff.differing], [true, 0], 'the copied bundle draws the same pixels');
  } finally { await rm(home, { recursive: true, force: true }); }
});
