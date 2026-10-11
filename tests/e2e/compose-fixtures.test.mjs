import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { compose } from '../../lib/commands/compose.mjs';
import { renderBoard } from '../../lib/compose/engine.mjs';
import { REDACT_FILL } from '../../lib/compose/page.mjs';
import { resolvePaths } from '../../lib/core/paths.mjs';
import { assertInvariants, intersects } from './helpers/invariants.mjs';
import { countOffColor, diffPngs } from './helpers/png-diff.mjs';
import { rendererForTests } from './helpers/renderer.mjs';

const renderer = await rendererForTests();
const skip = renderer ? false : 'skipped by FAST_BROWSER_SKIP_COMPOSE_E2E=1';
const macro = new Function(`return (${await readFile(new URL('../../builtins/macros/capture-evidence.js', import.meta.url), 'utf8')});`)();
const specDir = path.resolve('tests/fixtures/evidence/specs');
const goldenDir = path.resolve('tests/fixtures/evidence/goldens');
const pluginRoot = path.resolve('.');
const unionOf = (boxes) => {
  const x = Math.min(...boxes.map((b) => b[0])); const y = Math.min(...boxes.map((b) => b[1]));
  return [x, y, Math.max(...boxes.map((b) => b[0] + b[2])) - x, Math.max(...boxes.map((b) => b[1] + b[3])) - y];
};

for (const file of (await readdir(specDir)).filter((f) => f.endsWith('.json'))) {
  test(`fixture ${file} composes, holds its invariants and matches its golden`, { skip }, async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'fb-fx-'));
    try {
      const paths = resolvePaths({ homeDir: home, pluginRoot });
      const fixture = JSON.parse(await readFile(path.join(specDir, file), 'utf8'));
      const pageName = fixture.page ?? path.basename(file, '.json');
      const { chromium } = await import(renderer.playwrightCore);
      const browser = await chromium.launch({ headless: true, executablePath: renderer.executablePath });
      let captureReturn;
      try {
        const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
        await page.goto(pathToFileURL(path.resolve(`tests/fixtures/evidence/pages/${pageName}.html`)).href);
        captureReturn = await macro(page, { targets: fixture.targets, out: `${path.basename(file, '.json')}.c1`, home, frame: fixture.frame });
      } finally { await browser.close(); }
      assert.equal(captureReturn.failedStep, undefined, `capture failed at ${captureReturn.failedStep}`);
      assert.equal(captureReturn.missed.length, 0, 'every fixture target resolves');
      const ret = path.join(home, 'return.json');
      await writeFile(ret, JSON.stringify(captureReturn));
      const { sidecar } = await compose({ command: 'compose', seal: ret, spec: null }, { paths });
      const spec = { ...fixture, panels: [{ ...fixture.panels[0], capture: path.basename(sidecar) }] };
      delete spec.targets; delete spec.page; delete spec.expect; delete spec.frame;
      const specPath = path.join(paths.screenshotsDir, `${path.basename(file, '.json')}.spec.json`);
      await writeFile(specPath, JSON.stringify(spec));
      let layoutReport;
      const report = await compose({ command: 'compose', spec: specPath, seal: null }, {
        paths,
        rendererLocation: async () => renderer,
        renderBoard: async (args) => { const r = await renderBoard(args); layoutReport = r.report; return r; },
      });
      assertInvariants(layoutReport);
      for (const lift of layoutReport.lifts) {
        assert.equal(lift.grown.length, 4, 'every lift reports its growth');
        assert.ok(lift.grown.every((g) => Number.isInteger(g) && g >= 0 && g <= 96), 'growth is whole pixels within the limit');
        assert.ok(lift.k > 0 && lift.k <= 3 + 1e-9, 'every lift reports the scale it used');
      }
      for (const key of fixture.expect?.covers ?? []) {
        const [x, y, w, h] = unionOf(layoutReport.lifts[0].keys.map((k) => captureReturn.boxes[k]));
        const [l, t, r, b] = layoutReport.lifts[0].grown;
        const [cx, cy, cw, ch] = captureReturn.boxes[key];
        assert.ok(x + w > cx && x + w < cx + cw, 'the named box alone ends inside the covered target');
        assert.ok(x - l <= cx && y - t <= cy && x + w + r >= cx + cw && y + h + b >= cy + ch, `the grown lift covers ${key}`);
      }
      if (fixture.expect?.maxGrown !== undefined) {
        assert.ok(layoutReport.lifts[0].grown.every((g) => g <= fixture.expect.maxGrown), `the first lift grew ${layoutReport.lifts[0].grown} (more than ${fixture.expect.maxGrown}px on a side)`);
      }
      if (fixture.expect?.laterLiftsCapped) {
        assert.ok(layoutReport.lifts[1].k < layoutReport.lifts[0].k, 'the later lift gives way to the earlier one');
      }
      if (fixture.expect?.liftsPerMark) {
        const markIndexes = fixture.panels[0].marks.flatMap((m, i) => ('lift' in m ? [i] : []));
        assert.deepEqual(markIndexes.map((i) => layoutReport.lifts.filter((l) => l.mark === i).length), fixture.expect.liftsPerMark, 'each point gets one lift per cluster');
        assert.equal(layoutReport.labels.length, markIndexes.length, 'each point has one label however many lifts it has');
        assert.deepEqual(layoutReport.leaders.map((l) => l.lifts.length), fixture.expect.liftsPerMark, 'each leader serves every lift of its point');
      }
      assert.ok(layoutReport.lifts.every((l) => Boolean(l.merged) === Boolean(fixture.expect?.merged)), 'a lift reports merged only when its point was split and put back together');
      if (fixture.expect?.merged) assert.equal(layoutReport.connectors.length, 0, 'a merged lift is drawn like a single-cluster mark: no connectors');
      for (const name of fixture.expect?.apart ?? []) {
        for (const lift of layoutReport.lifts) {
          const [x, y, w, h] = lift.source; const [l, t, r, b] = lift.pad;
          assert.equal(intersects([x - l, y - t, w + l + r, h + t + b], captureReturn.boxes[name]), false, `${name} sits inside a lift`);
        }
      }
      if (fixture.expect?.cropped !== undefined) {
        const [, , fw, fh] = layoutReport.cleanFrame; const [, , uw, uh] = layoutReport.frame;
        assert.equal(layoutReport.cropped, fixture.expect.cropped, 'the report says whether the frame was tightened');
        assert.equal(uw * uh < 0.5 * fw * fh, fixture.expect.cropped, 'the frame used is under half the cleaned frame when tightened');
        assert.ok(layoutReport.lifts.every((l) => !l.clamped), 'no lift is clamped');
        assert.ok(Math.abs(layoutReport.capture[2] / uw - layoutReport.capture[3] / uh) < 0.01, 'the board shows the frame used');
      }
      if (layoutReport.cropped) {
        const [fx, fy, fw, fh] = layoutReport.frame; const [ox, oy, ow, oh] = layoutReport.cleanFrame;
        const at = { left: fx === ox, top: fy === oy, right: fx + fw === ox + ow, bottom: fy + fh === oy + oh };
        for (const [side, kind] of Object.entries(layoutReport.cropEdges)) {
          assert.equal(at[side], kind === 'frame', `the ${side} edge is ${kind}: it sits on the cleaned frame's edge only when it fell back`);
        }
      } else assert.equal(layoutReport.cropEdges, undefined, 'an uncropped board has no crop edges');
      const allClean = { left: 'clean', top: 'clean', right: 'clean', bottom: 'clean' };
      assert.deepEqual(layoutReport.frameEdges, fixture.expect?.frameEdges ?? allClean, 'each captured frame edge was clean, moved inward, moved outward or cut as expected');
      {
        const [cx, cy, cw, ch] = captureReturn.frame; const [kx, ky, kw, kh] = layoutReport.cleanFrame;
        const offset = { left: kx - cx, top: ky - cy, right: cx + cw - (kx + kw), bottom: cy + ch - (ky + kh) };
        for (const [side, kind] of Object.entries(layoutReport.frameEdges)) {
          if (kind === 'clean' || kind === 'cut') assert.equal(offset[side], 0, `the ${side} edge is ${kind}, so it stays where the macro put it`);
          else assert.ok(kind === 'inward' ? offset[side] > 0 : offset[side] < 0, `the ${side} edge moved ${kind}`);
        }
      }
      if (fixture.expect?.cleanRows) {
        // The captured pixels on the cleaned frame's outermost rows hold nothing but the page ground.
        const shot = await readFile(captureReturn.png);
        const [kx, ky, kw, kh] = layoutReport.cleanFrame;
        for (const side of fixture.expect.cleanRows) {
          const rect = side === 'top' ? [kx, ky, kw, 1] : [kx, ky + kh - 1, kw, 1];
          const r = await countOffColor({ png: shot, rect, color: null, renderer });
          assert.equal(r.off, 0, `${r.off} pixels on the capture's ${side} row are not ground`);
        }
      }
      if (fixture.expect?.leaderGround) {
        // The first leader's dot and the stretch of its first segment over the capture sit on page ground only.
        const shot = await readFile(captureReturn.png);
        const [cx, cy, cw, ch] = layoutReport.capture; const [fx, fy, fw] = layoutReport.frame;
        const k = fw / cw;
        const [[ax, ay], [bx, by]] = layoutReport.leaders[0].points;
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
      if (fixture.expect?.dotGround) {
        // Every dot keeps clear ground around it: the square (half-side 8, inside the 11.5px disc the layout tested) holds page ground only, rounded inward.
        const shot = await readFile(captureReturn.png);
        const [cx, cy, cw, ch] = layoutReport.capture; const [fx, fy, fw] = layoutReport.frame;
        const k = fw / cw;
        for (const dot of layoutReport.dots) {
          const half = 8;
          const x0 = Math.ceil(fx + (Math.max(dot.center[0] - half, cx) - cx) * k); const y0 = Math.ceil(fy + (Math.max(dot.center[1] - half, cy) - cy) * k);
          const x1 = Math.floor(fx + (Math.min(dot.center[0] + half, cx + cw) - cx) * k); const y1 = Math.floor(fy + (Math.min(dot.center[1] + half, cy + ch) - cy) * k);
          if (x1 - x0 < 1 || y1 - y0 < 1) continue;
          const r = await countOffColor({ png: shot, rect: [x0, y0, x1 - x0, y1 - y0], color: fixture.expect.dotGround, renderer });
          assert.equal(r.off, 0, `${r.off} of ${r.total} pixels under an anchor dot are page content`);
        }
      }
      assert.ok(layoutReport.dots.every((d) => Number.isFinite(d.slid)), 'every dot reports how far it slid from the side centre');
      if (fixture.expect?.slid) assert.ok(layoutReport.dots.some((d) => d.slid !== 0), 'a dot slid off the centre of its side');
      if (fixture.expect?.cropEdges) assert.deepEqual(layoutReport.cropEdges, fixture.expect.cropEdges, 'each crop edge snapped or fell back as expected');
      if (fixture.expect?.noWarnings) assert.deepEqual(layoutReport.warnings, [], 'the board renders without warnings');
      if (fixture.expect?.padClamped) {
        const side = ['left', 'top', 'right', 'bottom'].indexOf(fixture.expect.padClamped);
        assert.ok(layoutReport.lifts[0].pad[side] < 4, `the ${fixture.expect.padClamped} padding stops short of the neighbouring content`);
      }
      if (fixture.expect?.minLiftHeight) {
        assert.ok(layoutReport.lifts[0].rect[3] >= fixture.expect.minLiftHeight - 0.5, `the lift renders at least ${fixture.expect.minLiftHeight}px tall`);
      }
      const board = await readFile(report.out);
      const marks = fixture.panels[0].marks;
      const fill = [1, 3, 5].map((i) => parseInt(REDACT_FILL.slice(i, i + 2), 16));
      assert.equal(layoutReport.redactions.length > 0, marks.some((m) => m.redact), 'redactions in the report match the spec');
      // Under a lift the fill is exact. Elsewhere it carries the lift's drop
      // shadow, so that part gets a wider tolerance that still catches white or
      // dark leaked content.
      const scale = board.readUInt32BE(16) / layoutReport.stage[2];
      const px = (r) => r.map((v) => Math.round(v * scale));
      const leaderPoints = [...layoutReport.leaders, ...layoutReport.connectors].flatMap((l) => l.points);
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
      for (const redaction of layoutReport.redactions) {
        assert.deepEqual(Object.keys(redaction).sort(), ['fill', 'rect'], 'a redaction is its rect and fill alone: the fill marks it, no pill');
        const [rx, ry, rw, rh] = redaction.rect;
        sampled = 0;
        const lifts = layoutReport.lifts.filter((l) => intersects(l.rect, redaction.rect));
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
      if (marks.some((m) => m.redact) && marks.some((m) => m.lift)) {
        const crossed = layoutReport.lifts.some((l) => layoutReport.redactions.some((r) => intersects(l.rect, r.rect)));
        assert.ok(crossed, 'a lift overlaps a redaction');
      }
      const golden = path.join(goldenDir, `${path.basename(file, '.json')}.png`);
      if (process.env.UPDATE_GOLDENS === '1') {
        await mkdir(goldenDir, { recursive: true });
        await writeFile(golden, board);
        return;
      }
      if (fixture.expect?.cleanRows?.includes('top')) {
        // The first rows past the rounded corners, which show what lies behind the board.
        const [bx, by, bw] = layoutReport.capture;
        const r = await countOffColor({ png: board, rect: px([bx + 20, by + 1, bw - 40, 3]), color: null, tolerance: 6, renderer });
        assert.equal(r.off, 0, `${r.off} pixels on the board's top edge are not ground: a glyph is cut there`);
      }
      const diff = await diffPngs({ a: board, b: await readFile(golden), renderer });
      assert.equal(diff.sameSize, true, 'board and golden differ in size');
      assert.ok(diff.differing / diff.total < 0.002, `${diff.differing} of ${diff.total} pixels differ from the golden`);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
}
