import assert from 'node:assert/strict';
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
import { assertInvariants, inside, intersects } from './helpers/invariants.mjs';
import { countOffColor, diffPngs } from './helpers/png-diff.mjs';
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
// How far that shadow reaches above a lift (its blur less its drop) and to each side (its ring and its blur).
const LIFT_SHADOW_ABOVE = 28 - 12;
const LIFT_SHADOW_BESIDE = 3 + 28;
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
const unionOf = (boxes) => {
  const x = Math.min(...boxes.map((b) => b[0])); const y = Math.min(...boxes.map((b) => b[1]));
  return [x, y, Math.max(...boxes.map((b) => b[0] + b[2])) - x, Math.max(...boxes.map((b) => b[1] + b[3])) - y];
};

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
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: input.dpr });
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
      const report = await compose({ command: 'compose', spec: specPath }, {
        paths,
        rendererLocation: async () => renderer,
        renderBoard: async (args) => { const r = await renderBoard(args); layoutReport = r.report; return r; },
      });
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
          else if (kind !== 'snapped') assert.equal(at[side], true, `the ${side} edge is ${kind}, so it sits on the whole frame's edge`);
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
          else assert.ok(kind === 'inward' ? offset[side] > 0 : offset[side] < 0, `the ${side} edge moved ${kind}`);
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
      if (fixture.expect?.noWarnings) assert.deepEqual(layoutReport.warnings, [], 'the board renders without warnings');
      if (fixture.expect?.padClamped) {
        const side = ['left', 'top', 'right', 'bottom'].indexOf(fixture.expect.padClamped);
        assert.ok(board0.lifts[0].pad[side] < 4, `the ${fixture.expect.padClamped} padding stops short of the neighbouring content`);
      }
      if (fixture.expect?.minLiftHeight) {
        assert.ok(board0.lifts[0].rect[3] >= fixture.expect.minLiftHeight - 0.5, `the lift renders at least ${fixture.expect.minLiftHeight}px tall`);
      }
      if (fixture.expect?.slots) {
        assert.deepEqual(board0.slots.map((s) => [s.kind, s.text]), fixture.expect.slots, 'each slot is drawn as expected');
        assert.equal(board0.wash, board0.lifts.length > 0, 'a slot alone raises no wash');
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
      const board = await readFile(report.out);
      const marks = fixture.panels[0].marks;
      const fill = [1, 3, 5].map((i) => parseInt(REDACT_FILL.slice(i, i + 2), 16));
      assert.equal(board0.redactions.length > 0, marks.some((m) => m.redact), 'redactions in the report match the spec');
      // Under a lift the fill is exact. Elsewhere it carries the lift's drop
      // shadow, so that part gets a wider tolerance that still catches white or
      // dark leaked content.
      const scale = board.readUInt32BE(16) / layoutReport.stage[2];
      const px = (r) => r.map((v) => Math.round(v * scale));
      const leaderPoints = [...board0.leaders, ...board0.connectors].flatMap((l) => l.points);
      let sampled = 0;
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
      for (const redaction of board0.redactions) {
        assert.deepEqual(Object.keys(redaction).sort(), ['fill', 'rect'], 'a redaction is its rect and fill alone: the fill marks it, no pill');
        const [rx, ry, rw, rh] = redaction.rect;
        sampled = 0;
        // A lift's 3px ring is drawn outside its rect, so a card that stands within it of a fill covers the fill's edge too.
        const lifts = board0.lifts.filter((l) => intersects([l.rect[0] - 3, l.rect[1] - 3, l.rect[2] + 6, l.rect[3] + 6], redaction.rect));
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
        assert.ok(sampled > 0, 'a redaction was never sampled');
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
      if (fixture.expect?.crops === undefined) assert.equal(report.redactions, undefined, 'a board with no imported redaction has no record');
      else {
        assert.equal(report.redactions.crops.length, fixture.expect.crops, 'one crop per drawn redaction');
        const body = JSON.parse(await readFile(report.redactions.record, 'utf8'));
        assert.ok(body.redactions.every((r) => r.confirmed === false), 'a fresh render is unconfirmed');
        for (const [i, file] of report.redactions.crops.entries()) {
          const bytes = await readFile(file);
          const [, , w, h] = layoutReport.crops[i].rect;
          assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [Math.round(w * scale), Math.round(h * scale)], 'the crop is at the board\'s full resolution');
          // The drawn redaction, inset past its antialiased edge, is fill and nothing else.
          const { panel, redaction } = layoutReport.crops[i];
          const [rx, ry, rw, rh] = layoutReport.panels[panel].redactions[redaction].rect;
          const [cx, cy] = layoutReport.crops[i].rect;
          const inner = [rx + 3, ry + 3, rw - 6, rh - 6];
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
          }
        }
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
