import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const sandbox = {};
vm.runInNewContext(await readFile(new URL('../../lib/compose/page-geometry.js', import.meta.url), 'utf8'), sandbox);
const { edgeIsClean, LIFT_BAND, LIFT_CLEAR, contentUnder } = sandbox.__composeGeometry;
const cropToMarks = (...args) => {
  const { box, edges, cut } = sandbox.__composeGeometry.cropToMarks(...args);
  return { box: [...box], edges: edges && { ...edges }, cut };
};
const trimBlank = (...args) => {
  const { box, trimmed } = sandbox.__composeGeometry.trimBlank(...args);
  return { box: [...box], trimmed: { ...trimmed } };
};
const cleanFrame = (...args) => {
  const { frame, edges, cut } = sandbox.__composeGeometry.cleanFrame(...args);
  return { frame: [...frame], edges: { ...edges }, cut };
};
const cleanPad = (...args) => [...sandbox.__composeGeometry.cleanPad(...args)];
const liftSpot = (...args) => { const { L, T, clamped } = sandbox.__composeGeometry.liftSpot(...args); return { L, T, clamped }; };
// Arrays from the vm realm carry another Array prototype, which strict deepEqual rejects.
const growBox = (...args) => { const { box, cut } = sandbox.__composeGeometry.growBox(...args); return { box: [...box], cut }; };

function canvas(width, height, background = [255, 255, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) data.set([...background, 255], i * 4);
  return {
    data, width, height,
    fill(x, y, w, h, color) {
      for (let yy = y; yy < y + h; yy += 1) for (let xx = x; xx < x + w; xx += 1) data.set([...color, 255], (yy * width + xx) * 4);
      return this;
    },
  };
}
const INK = [30, 30, 30];

// Edge lines ignore their first and last 2px, so inside a box spanning rows
// 20..31 ink on rows 24..27 leaves every ink column mixed with background.
test('a box whose right edge cuts a glyph block grows to the block far side', () => {
  const px = canvas(200, 60).fill(45, 24, 55, 4, INK);
  assert.deepEqual(growBox(px, [40, 20, 30, 12], 96).box, [40, 20, 61, 12]);
});

test('a box on a uniform background is returned unchanged', () => {
  const px = canvas(200, 60);
  assert.deepEqual(growBox(px, [40, 20, 30, 12], 96).box, [40, 20, 30, 12]);
});

test('a fractional box on clean edges is returned as given', () => {
  const px = canvas(200, 60);
  assert.deepEqual(growBox(px, [40.4, 20.5, 30.2, 12.7], 96).box, [40.4, 20.5, 30.2, 12.7]);
});

test('letter gaps of 2px do not stop growth but a 6px gap does', () => {
  const px = canvas(240, 60);
  for (let x = 45; x < 100; x += 6) px.fill(x, 24, 4, 4, INK);
  px.fill(109, 24, 6, 4, INK);
  assert.deepEqual(growBox(px, [40, 20, 30, 12], 96), { box: [40, 20, 64, 12], cut: false });
});

test('an edge that reaches the limit without a clean band reverts and reports the cut', () => {
  const px = canvas(400, 60).fill(45, 24, 300, 4, INK);
  assert.deepEqual(growBox(px, [40, 20, 30, 12], 50), { box: [40, 20, 30, 12], cut: true });
});

test('an edge that reaches the bounds without a clean band reverts', () => {
  const px = canvas(100, 60).fill(45, 24, 55, 4, INK);
  assert.deepEqual(growBox(px, [40, 20, 30, 12], 96), { box: [40, 20, 30, 12], cut: true });
  const wide = canvas(200, 60).fill(45, 24, 55, 4, INK);
  assert.deepEqual(growBox(wide, [40, 20, 30, 12], 96, { bounds: [0, 0, 80, 60] }), { box: [40, 20, 30, 12], cut: true });
});

test('a clean run cut short by the image edge still places the edge', () => {
  const px = canvas(104, 60).fill(45, 24, 55, 4, INK);
  assert.deepEqual(growBox(px, [40, 20, 30, 12], 96), { box: [40, 20, 61, 12], cut: false });
});

test('an edge reverts alone: the others keep their growth', () => {
  const px = canvas(400, 60).fill(45, 24, 300, 4, INK).fill(25, 24, 18, 4, INK);
  assert.deepEqual(growBox(px, [40, 20, 30, 12], 50), { box: [24, 20, 46, 12], cut: true });
});

test('a uniform card border counts as a clean edge', () => {
  const px = canvas(200, 80).fill(10, 10, 180, 60, [200, 200, 200]).fill(11, 11, 178, 58, [255, 255, 255]).fill(60, 30, 40, 10, INK);
  const box = [11, 11, 178, 58];
  for (const side of ['left', 'top', 'right', 'bottom']) assert.equal(edgeIsClean(px, box, side), true, side);
  assert.deepEqual(growBox(px, box, 96).box, box);
});

test('an edge slicing a glyph is not clean', () => {
  const px = canvas(200, 60).fill(45, 24, 55, 4, INK);
  assert.equal(edgeIsClean(px, [40, 20, 30, 12], 'right'), false);
});

test('an edge is re-tested once another edge has moved', () => {
  const px = canvas(200, 80).fill(45, 24, 35, 4, INK).fill(60, 28, 6, 13, INK);
  assert.deepEqual(growBox(px, [40, 20, 20, 12], 96).box, [40, 20, 41, 22]);
});

test('growth does not enter a box in the avoid list', () => {
  const px = canvas(200, 60).fill(45, 24, 54, 4, INK);
  assert.deepEqual(growBox(px, [40, 20, 30, 12], 96, { avoid: [[101, 0, 20, 60]] }), { box: [40, 20, 60, 12], cut: false });
});

test('an edge walled in by an avoid box before any clean line reverts', () => {
  const px = canvas(200, 60).fill(45, 24, 95, 4, INK);
  assert.deepEqual(growBox(px, [40, 20, 30, 12], 96, { avoid: [[100, 0, 20, 60]] }), { box: [40, 20, 30, 12], cut: true });
});

test('an avoid box the edge already touches does not stop growth in another direction', () => {
  const px = canvas(200, 60).fill(45, 24, 55, 4, INK);
  assert.deepEqual(growBox(px, [40, 20, 30, 12], 96, { avoid: [[40, 0, 10, 20]] }).box, [40, 20, 61, 12]);
});

test('pixels inside an ignore rectangle never make an edge unclean', () => {
  const px = canvas(200, 60).fill(60, 26, 40, 20, [203, 213, 225]);
  assert.notDeepEqual(growBox(px, [40, 20, 30, 12], 96).box, [40, 20, 30, 12]);
  assert.deepEqual(growBox(px, [40, 20, 30, 12], 96, { ignore: [[58, 24, 44, 24]] }).box, [40, 20, 30, 12]);
});

test('tolerance admits small channel differences and rejects larger ones', () => {
  const faint = canvas(200, 60).fill(45, 24, 55, 4, [240, 240, 240]);
  assert.deepEqual(growBox(faint, [40, 20, 30, 12], 96).box, [40, 20, 30, 12]);
  const strong = canvas(200, 60).fill(45, 24, 55, 4, [200, 200, 200]);
  assert.deepEqual(growBox(strong, [40, 20, 30, 12], 96).box, [40, 20, 61, 12]);
});

const BLUE = [37, 99, 235];
function roundedBadge() {
  const px = canvas(120, 120).fill(50, 50, 12, 12, BLUE);
  for (const [x, y] of [[50, 50], [61, 50], [50, 61], [61, 61]]) px.fill(x, y, 1, 1, [255, 255, 255]);
  return px;
}

test('the first and last 2px of an edge line are ignored, so a rounded badge edge is clean', () => {
  const px = roundedBadge();
  for (const side of ['left', 'top', 'right', 'bottom']) assert.equal(edgeIsClean(px, [50, 50, 12, 12], side), true, side);
  assert.deepEqual(growBox(px, [50, 50, 12, 12], 96), { box: [50, 50, 12, 12], cut: false });
});

test('a mark on the third pixel of an edge line is still content', () => {
  const px = roundedBadge().fill(50, 52, 1, 1, [255, 255, 255]);
  assert.equal(edgeIsClean(px, [50, 50, 12, 12], 'left'), false);
});

test('padding extends 4px over clean lines on every side', () => {
  assert.deepEqual(cleanPad(canvas(120, 120), [50, 50, 12, 12], 4), [4, 4, 4, 4]);
});

test('padding stops before the first unclean line outward and may be zero', () => {
  const px = canvas(120, 120).fill(44, 54, 1, 3, INK).fill(62, 54, 1, 3, INK);
  assert.deepEqual(cleanPad(px, [50, 50, 12, 12], 4), [2, 4, 0, 4]);
});

test('padding keeps LIFT_CLEAR clean lines between its outer edge and content', () => {
  assert.equal(LIFT_CLEAR, 3);
  assert.deepEqual(cleanPad(canvas(120, 120).fill(43, 54, 1, 3, INK), [50, 50, 12, 12], 4), [3, 4, 4, 4]);
  assert.deepEqual(cleanPad(canvas(120, 120).fill(45, 54, 1, 3, INK), [50, 50, 12, 12], 4), [1, 4, 4, 4]);
});

test('a neighbour 10px away leaves the padding at most 7px, so 3px of ground shows between', () => {
  const px = canvas(160, 120).fill(36, 54, 4, 4, INK);
  assert.deepEqual(cleanPad(px, [50, 50, 12, 12], 12), [7, 12, 12, 12]);
});

test('a neighbour closer than LIFT_CLEAR clean lines leaves no padding on that side', () => {
  assert.deepEqual(cleanPad(canvas(160, 120).fill(44, 54, 4, 4, INK), [50, 50, 12, 12], 12), [0, 12, 12, 12]);
  assert.deepEqual(cleanPad(canvas(160, 120).fill(43, 54, 4, 4, INK), [50, 50, 12, 12], 12), [0, 12, 12, 12]);
});

test('open ground gives the full padding', () => {
  assert.deepEqual(cleanPad(canvas(160, 120), [50, 50, 12, 12], 12), [12, 12, 12, 12]);
});

test('padding stops at the image edge', () => {
  assert.deepEqual(cleanPad(canvas(120, 120), [2, 50, 12, 12], 4), [2, 4, 4, 4]);
});

test('ignored pixels never stop the padding', () => {
  const px = canvas(120, 120).fill(47, 54, 1, 3, INK);
  assert.deepEqual(cleanPad(px, [50, 50, 12, 12], 4, { ignore: [[46, 50, 3, 12]] }), [4, 4, 4, 4]);
});

test('a gradient whose values straddle 99 and 100 within tolerance reads clean', () => {
  const px = canvas(200, 60);
  for (let x = 60; x < 94; x += 1) px.fill(x, 0, 1, 60, [x + 23, x + 23, x + 23]);
  assert.equal(edgeIsClean(px, [60, 20, 34, 12], 'top'), true);
  assert.deepEqual(growBox(px, [60, 20, 34, 12], 96), { box: [60, 20, 34, 12], cut: false });
});

test('padding stops at the supplied bounds', () => {
  assert.deepEqual(cleanPad(canvas(120, 120), [50, 50, 12, 12], 4, { bounds: [0, 0, 64, 120] }), [4, 4, 2, 4]);
});

const area = (b) => b[2] * b[3];
const insideBox = (b, f) => b[0] >= f[0] && b[1] >= f[1] && b[0] + b[2] <= f[0] + f[2] && b[1] + b[3] <= f[1] + f[3];

test('a small marks box in a large frame tightens to the marks plus the crop margins', () => {
  const px = canvas(600, 400).fill(400, 320, 100, 10, INK);
  const frame = [0, 0, 600, 400];
  const out = cropToMarks(px, frame, [200, 150, 40, 20]).box;
  assert.deepEqual(out, [136, 102, 168, 116]);
  assert.ok(area(out) < 0.5 * area(frame));
});

test('a tightened edge that cuts content moves outward to the first clean band', () => {
  const px = canvas(600, 400).fill(295, 150, 46, 10, INK);
  const frame = [0, 0, 600, 400];
  const out = cropToMarks(px, frame, [200, 150, 40, 20]).box;
  assert.deepEqual(out, [136, 102, 217, 116]);
  for (const side of ['left', 'top', 'right', 'bottom']) assert.equal(edgeIsClean(px, out, side), true, side);
});

test('an edge looks no further than 80px for a clean band', () => {
  const px = canvas(600, 400).fill(295, 150, 280, 10, INK);
  const out = cropToMarks(px, [0, 0, 600, 400], [200, 150, 40, 20]).box;
  assert.deepEqual(out, [136, 102, 464, 116]);
});

test('a marks box filling most of the frame returns the frame unchanged', () => {
  const frame = [0, 0, 600, 400];
  assert.deepEqual(cropToMarks(canvas(600, 400), frame, [20, 20, 560, 360]).box, frame);
  assert.deepEqual(cropToMarks(canvas(600, 400), frame, [100, 60, 400, 280]).box, frame);
});

test('a candidate of exactly half the frame area is not tight enough', () => {
  const frame = [0, 0, 400, 400];
  assert.deepEqual(cropToMarks(canvas(400, 400), frame, [64, 150, 272, 104]).box, frame);
});

test('the result never leaves the frame', () => {
  const px = canvas(600, 400).fill(0, 0, 600, 400, [250, 250, 250]).fill(60, 60, 20, 4, INK);
  const frame = [50, 50, 400, 300];
  for (const marks of [[60, 60, 30, 20], [420, 320, 25, 25], [50, 50, 10, 10]]) {
    const out = cropToMarks(px, frame, marks).box;
    assert.ok(insideBox(out, frame), `inside the frame for ${marks}`);
    assert.ok(insideBox(marks, out), `holds its marks for ${marks}`);
  }
});

test('growth to a clean band stops at the frame edge', () => {
  const px = canvas(600, 400).fill(40, 150, 40, 10, INK);
  const frame = [20, 0, 580, 400];
  const out = cropToMarks(px, frame, [60, 150, 40, 20]).box;
  assert.ok(insideBox(out, frame));
  assert.equal(out[0], 20);
});

test('no marks leaves the frame alone', () => {
  const frame = [10, 10, 300, 200];
  assert.deepEqual(cropToMarks(canvas(400, 300), frame, null).box, frame);
});

test('a left edge landing mid-text falls back to the frame edge while the others stay tightened', () => {
  const px = canvas(600, 400).fill(0, 150, 600, 10, INK);
  const { box, edges } = cropToMarks(px, [0, 0, 600, 400], [200, 150, 40, 20]);
  assert.deepEqual(box, [0, 102, 600, 116]);
  assert.deepEqual(edges, { left: 'frame', top: 'snapped', right: 'frame', bottom: 'snapped' });
});

test('an edge that snaps to a clean band is reported as snapped', () => {
  const px = canvas(600, 400).fill(140, 95, 160, 10, INK);
  const { box, edges } = cropToMarks(px, [0, 0, 600, 400], [200, 150, 40, 20]);
  assert.deepEqual(box, [128, 83, 184, 135]);
  assert.deepEqual(edges, { left: 'snapped', top: 'snapped', right: 'snapped', bottom: 'snapped' });
});

test('fallbacks that push the crop past half the frame return the frame unchanged', () => {
  const px = canvas(600, 400).fill(0, 150, 600, 10, INK).fill(250, 0, 10, 130, INK);
  const frame = [0, 0, 600, 400];
  const { box, edges } = cropToMarks(px, frame, [200, 150, 40, 20]);
  assert.deepEqual(box, frame);
  assert.equal(edges, null);
  assert.deepEqual(cropToMarks(px, frame, [200, 150, 40, 20]).box, frame);
});

test('a fallback edge stays inside a frame that is smaller than the image', () => {
  const px = canvas(800, 500).fill(0, 200, 800, 10, INK);
  const { box, edges } = cropToMarks(px, [100, 50, 600, 400], [300, 200, 40, 20]);
  assert.deepEqual(box, [100, 152, 600, 116]);
  assert.equal(edges.left, 'frame');
  assert.equal(edges.right, 'frame');
});

const GREY = [221, 221, 221];

test('a 1px rule crossing an edge line does not make it unclean', () => {
  const px = canvas(300, 100).fill(20, 40, 260, 1, GREY);
  assert.equal(edgeIsClean(px, [100, 10, 60, 80], 'left'), true);
  assert.equal(edgeIsClean(px, [100, 10, 60, 80], 'right'), true);
});

test('a 2px rule is tolerated and a 3px bar is content', () => {
  const two = canvas(300, 100).fill(20, 40, 260, 2, GREY);
  assert.equal(edgeIsClean(two, [100, 10, 60, 80], 'left'), true);
  const three = canvas(300, 100).fill(20, 40, 260, 3, GREY);
  assert.equal(edgeIsClean(three, [100, 10, 60, 80], 'left'), false);
});

test('a short thin mark is content, not a rule', () => {
  const px = canvas(300, 100).fill(95, 40, 10, 1, INK);
  assert.equal(edgeIsClean(px, [100, 10, 60, 80], 'left'), false);
});

test('a rule must hold its colour 48px in all across the edge line', () => {
  const box = [100, 10, 60, 80];
  assert.equal(edgeIsClean(canvas(300, 100).fill(100, 40, 160, 1, GREY), box, 'left'), false, 'runs only one way');
  assert.equal(edgeIsClean(canvas(300, 100).fill(88, 40, 24, 2, INK), box, 'left'), false, '24px long, crossed at its middle');
  assert.equal(edgeIsClean(canvas(300, 100).fill(76, 40, 48, 2, GREY), box, 'left'), false, '48px long holds 47px across the edge line');
  assert.equal(edgeIsClean(canvas(300, 100).fill(76, 40, 49, 2, GREY), box, 'left'), true, '49px long holds 48px across every line of the band');
  assert.equal(edgeIsClean(canvas(300, 100).fill(70, 40, 56, 2, GREY), box, 'left'), true, '56px long, crossed at its middle');
});

test('a line holds at most two rule runs', () => {
  const stems = (xs) => xs.reduce((px, x) => px.fill(x, 10, 2, 60, GREY), canvas(300, 100));
  assert.equal(edgeIsClean(stems([40, 80]), [10, 40, 200, 50], 'top'), true);
  assert.equal(edgeIsClean(stems([40, 80, 120]), [10, 40, 200, 50], 'top'), false);
});

test('a rule within 8 of the ground around it stays content', () => {
  const px = canvas(300, 100).fill(20, 40, 260, 2, GREY).fill(101, 39, 40, 1, [225, 225, 225]).fill(101, 42, 40, 1, [225, 225, 225]);
  assert.equal(edgeIsClean(px, [100, 10, 60, 80], 'left'), false);
});

test('a row crossing two vertical card borders is clean', () => {
  const px = canvas(300, 100).fill(20, 0, 1, 100, GREY).fill(280, 0, 1, 100, GREY);
  assert.equal(edgeIsClean(px, [10, 30, 280, 40], 'top'), true);
});

test('a card border crossing the crop edges does not stop the crop tightening', () => {
  const px = canvas(600, 200).fill(40, 40, 520, 1, GREY).fill(40, 40, 1, 150, GREY).fill(559, 40, 1, 150, GREY);
  const { box, edges } = cropToMarks(px, [0, 0, 600, 200], [300, 60, 20, 12]);
  assert.deepEqual(box, [236, 12, 148, 108]);
  assert.deepEqual(edges, { left: 'snapped', top: 'snapped', right: 'snapped', bottom: 'snapped' });
});

test('after a fallback widens the crop, an edge that now cuts content falls back too', () => {
  const px = canvas(800, 600).fill(0, 150, 800, 10, INK).fill(20, 100, 30, 5, INK);
  const { box, edges } = cropToMarks(px, [0, 0, 800, 600], [200, 150, 40, 20]);
  assert.deepEqual(box, [0, 0, 800, 218]);
  assert.deepEqual(edges, { left: 'frame', top: 'frame', right: 'frame', bottom: 'snapped' });
});

test('a cascade of fallbacks leaves no snapped edge cutting content', () => {
  const px = canvas(1000, 1000).fill(100, 300, 200, 10, INK).fill(20, 245, 20, 15, INK).fill(375, 20, 20, 10, INK);
  const frame = [0, 0, 1000, 1000];
  const { box, edges } = cropToMarks(px, frame, [300, 300, 20, 20]);
  if (edges) {
    for (const side of ['left', 'top', 'right', 'bottom']) {
      if (edges[side] === 'snapped') assert.equal(edgeIsClean(px, box, side, frame), true, `${side} edge snapped but cuts content`);
    }
  } else assert.deepEqual(box, frame);
});

const clusterBoxes = (boxes) => [...sandbox.__composeGeometry.clusterBoxes(boxes)].map((c) => [...c]);

test('boxes adjacent in a row share a cluster', () => {
  assert.deepEqual(clusterBoxes([[0, 0, 80, 20], [90, 2, 80, 20]]), [[0, 1]]);
});

test('boxes adjacent in a column share a cluster', () => {
  assert.deepEqual(clusterBoxes([[0, 0, 80, 20], [0, 30, 80, 20]]), [[0, 1]]);
});

test('boxes more than 12px apart in a row stay in separate clusters', () => {
  assert.deepEqual(clusterBoxes([[0, 0, 80, 20], [93, 0, 80, 20]]), [[0], [1]]);
});

test('diagonal boxes that overlap on neither axis form two clusters', () => {
  assert.deepEqual(clusterBoxes([[0, 0, 80, 20], [90, 30, 80, 20]]), [[0], [1]]);
});

test('clusters are the connected components of the adjacency', () => {
  assert.deepEqual(clusterBoxes([[0, 0, 40, 20], [50, 0, 40, 20], [100, 0, 40, 20], [0, 200, 40, 20]]), [[0, 1, 2], [3]]);
});

test('a cluster whose union is mostly empty splits into its members', () => {
  const boxes = [[0, 0, 200, 20], [0, 30, 20, 100], [180, 30, 20, 100]];
  assert.deepEqual(clusterBoxes(boxes), [[0], [1], [2]]);
});

test('a union with a small hole stays one cluster', () => {
  assert.deepEqual(clusterBoxes([[0, 0, 100, 20], [0, 25, 100, 20], [0, 50, 100, 20]]), [[0, 1, 2]]);
});

test('a single box is its own cluster', () => {
  assert.deepEqual(clusterBoxes([[5, 5, 10, 10]]), [[0]]);
});

const components = (...args) => [...sandbox.__composeGeometry.components(...args)].map((c) => [...c]);

test('components joins index pairs into ascending groups ordered by their first index', () => {
  assert.deepEqual(components(5, [[1, 3], [2, 3]]), [[0], [1, 2, 3], [4]]);
  assert.deepEqual(components(3, []), [[0], [1], [2]]);
  assert.deepEqual(components(0, []), []);
});

const ALL_CLEAN = { left: 'clean', top: 'clean', right: 'clean', bottom: 'clean' };

test('a frame whose edges are already clean comes back as given, fractions included', () => {
  const frame = [10.5, 20.25, 300.5, 200.5];
  const out = cleanFrame(canvas(400, 300).fill(120, 110, 40, 10, INK), frame, [120, 110, 40, 10]);
  assert.deepEqual(out, { frame, edges: ALL_CLEAN, cut: false });
});

test('an edge through a line of text moves inward to the clean band below it', () => {
  const px = canvas(600, 400).fill(100, 100, 200, 10, INK);
  const out = cleanFrame(px, [0, 100, 600, 250], [200, 200, 40, 20]);
  assert.deepEqual(out.frame, [0, 112, 600, 238]);
  assert.deepEqual(out.edges, { ...ALL_CLEAN, top: 'inward' });
  assert.equal(out.cut, false);
  assert.equal(edgeIsClean(px, out.frame, 'top'), true);
});

test('an inward edge stops 16px short of the marks, so a band nearer the marks is refused', () => {
  const px = canvas(600, 400).fill(100, 100, 200, 10, INK);
  const near = cleanFrame(px, [0, 100, 600, 250], [200, 128, 40, 20]);
  assert.equal(near.edges.top, 'inward', 'an edge at 112 sits exactly 16px above the marks');
  const tight = cleanFrame(px, [0, 100, 600, 250], [200, 127, 40, 20]);
  assert.equal(tight.edges.top, 'outward', 'an edge at 112 would sit 15px above the marks');
});

test('an edge with no room to go inward moves outward to the nearest clean band', () => {
  const px = canvas(600, 400).fill(100, 100, 200, 10, INK);
  const out = cleanFrame(px, [0, 100, 600, 250], [200, 115, 40, 20]);
  assert.deepEqual(out.frame, [0, 99, 600, 251]);
  assert.deepEqual(out.edges, { ...ALL_CLEAN, top: 'outward' });
  assert.equal(edgeIsClean(px, out.frame, 'top'), true);
});

test('an outward edge is clipped to the image', () => {
  const px = canvas(600, 400).fill(100, 3, 200, 10, INK);
  const out = cleanFrame(px, [0, 5, 600, 250], [200, 20, 40, 20]);
  assert.deepEqual(out.frame, [0, 2, 600, 253]);
  assert.equal(out.edges.top, 'outward');
});

test('an edge with no clean band inward or within 96px outward stays and reports a cut', () => {
  const px = canvas(600, 400).fill(100, 20, 200, 150, INK);
  const frame = [0, 150, 600, 200];
  const out = cleanFrame(px, frame, [200, 175, 40, 20]);
  assert.deepEqual(out, { frame, edges: { ...ALL_CLEAN, top: 'cut' }, cut: true });
});

test('a vertical edge in a gap between letters is not clean, since a gap is not a band', () => {
  const px = canvas(600, 400);
  for (let x = 100; x < 200; x += 6) px.fill(x, 100, 4, 10, INK);
  const out = cleanFrame(px, [104, 90, 496, 100], [300, 120, 40, 20]);
  assert.equal(out.edges.left, 'inward');
  assert.equal(out.frame[0], 202);
});

test('an edge moves again when another edge changes the lines it is tested on', () => {
  const px = canvas(800, 600).fill(150, 40, 100, 70, INK).fill(90, 60, 30, 11, INK);
  const out = cleanFrame(px, [100, 100, 300, 200], [220, 115, 40, 20]);
  assert.deepEqual(out.edges, { left: 'inward', top: 'outward', right: 'clean', bottom: 'clean' });
  assert.deepEqual(out.frame, [122, 39, 278, 261]);
  assert.equal(out.cut, false);
  for (const side of ['left', 'top', 'right', 'bottom']) assert.equal(edgeIsClean(px, out.frame, side), true, side);
});

test('a frame that no move can clean terminates with every cut edge unmoved', () => {
  const px = canvas(301, 301);
  for (let x = 3; x < 301; x += 6) px.fill(x, 0, 3, 301, INK);
  for (let y = 3; y < 301; y += 6) px.fill(0, y, 301, 3, INK);
  const frame = [50, 50, 200, 200];
  const out = cleanFrame(px, frame, [140, 140, 20, 20]);
  assert.equal(out.cut, true);
  assert.deepEqual(out.frame, frame);
  assert.deepEqual(Object.values(out.edges), ['cut', 'cut', 'cut', 'cut']);
});

test('no marks leaves an edge nowhere to go inward', () => {
  const px = canvas(600, 400).fill(100, 100, 200, 10, INK);
  const out = cleanFrame(px, [0, 100, 600, 250], null);
  assert.equal(out.edges.top, 'outward');
});

test('pixels inside an ignore rectangle never make a frame edge unclean', () => {
  const px = canvas(600, 400).fill(100, 100, 200, 10, INK);
  const frame = [0, 100, 600, 250];
  assert.deepEqual(cleanFrame(px, frame, [200, 200, 40, 20], { ignore: [[90, 98, 230, 14]] }).edges, ALL_CLEAN);
});

const pickLeaderSide = (...args) => sandbox.__composeGeometry.pickLeaderSide(...args);

test('the preferred leader side stays while it crosses fewer than 3 ink samples', () => {
  assert.equal(pickLeaderSide([0, 0]), 0);
  assert.equal(pickLeaderSide([2, 0]), 0);
  assert.equal(pickLeaderSide([1, 0]), 0);
});

test('a side takes over only when it crosses at least 3 fewer samples than a preferred side that crosses at least 3', () => {
  assert.equal(pickLeaderSide([3, 0]), 1);
  assert.equal(pickLeaderSide([9, 7]), 0, 'only 2 fewer');
  assert.equal(pickLeaderSide([9, 6]), 1);
});

test('among several alternatives the least ink wins and a tie keeps the earlier side', () => {
  assert.equal(pickLeaderSide([12, 4, 4]), 1);
  assert.equal(pickLeaderSide([12, 5, 2]), 2);
});

test('a lone side is the only choice and none is none', () => {
  assert.equal(pickLeaderSide([40]), 0);
  assert.equal(pickLeaderSide([]), -1);
});

const collidingLifts = (items) => [...sandbox.__composeGeometry.collidingLifts(items)].map((p) => [...p]);

test('two lifts of one mark that overlap collide', () => {
  assert.deepEqual(collidingLifts([{ mark: 0, rect: [0, 0, 100, 40] }, { mark: 0, rect: [60, 30, 100, 40] }]), [[0, 1]]);
});

test('two lifts of one mark within 8 display px collide, 9 do not', () => {
  assert.deepEqual(collidingLifts([{ mark: 0, rect: [0, 0, 100, 40] }, { mark: 0, rect: [108, 0, 50, 40] }]), [[0, 1]]);
  assert.deepEqual(collidingLifts([{ mark: 0, rect: [0, 0, 100, 40] }, { mark: 0, rect: [109, 0, 50, 40] }]), []);
});

test('a gap beyond 8 on one axis is not a collision however close the other axis is', () => {
  assert.deepEqual(collidingLifts([{ mark: 0, rect: [0, 0, 100, 40] }, { mark: 0, rect: [104, 200, 50, 40] }]), []);
  assert.deepEqual(collidingLifts([{ mark: 0, rect: [0, 0, 100, 40] }, { mark: 0, rect: [104, 46, 50, 40] }]), [[0, 1]]);
});

test('lifts of different marks never collide here', () => {
  assert.deepEqual(collidingLifts([{ mark: 0, rect: [0, 0, 100, 40] }, { mark: 1, rect: [10, 10, 100, 40] }]), []);
});

test('every colliding pair of one mark is reported', () => {
  const items = [{ mark: 2, rect: [0, 0, 50, 20] }, { mark: 2, rect: [55, 0, 50, 20] }, { mark: 2, rect: [300, 0, 50, 20] }, { mark: 2, rect: [110, 0, 50, 20] }];
  assert.deepEqual(collidingLifts(items), [[0, 1], [1, 3]]);
});

test('lifts that sit far apart report nothing', () => {
  assert.deepEqual(collidingLifts([{ mark: 0, rect: [0, 0, 100, 40] }, { mark: 0, rect: [0, 300, 100, 40] }]), []);
});

const cleanestSpot = (...args) => sandbox.__composeGeometry.cleanestSpot(...args);
const anywhere = () => true;

test('the spot with the least cost wins, wherever it is on the side', () => {
  assert.deepEqual({ ...cleanestSpot(0, 100, 50, anywhere, (p) => Math.abs(p - 83)) }, { at: 83, cost: 0 });
  assert.deepEqual({ ...cleanestSpot(0, 100, 50, anywhere, (p) => (p === 20 ? 1 : 4)) }, { at: 20, cost: 1 });
});

test('a flat cost keeps the dot in the middle', () => {
  assert.deepEqual({ ...cleanestSpot(0, 100, 50, anywhere, () => 0) }, { at: 50, cost: 0 });
  assert.deepEqual({ ...cleanestSpot(0, 101, 50.5, anywhere, () => 3) }, { at: 50.5, cost: 3 });
});

test('spots are walked half a pixel apart and a tie goes to the spot nearest the middle', () => {
  assert.equal(cleanestSpot(0, 100, 50, anywhere, (p) => (p >= 59.2 ? 0 : 1)).at, 59.5);
  assert.equal(cleanestSpot(0, 100, 50, anywhere, (p) => (p === 54.5 ? 0 : 1)).at, 54.5, 'a spot between whole pixels can be the cleanest');
  assert.equal(cleanestSpot(0, 100, 50, anywhere, (p) => (p >= 60 || p <= 36 ? 0 : 1)).at, 60, 'the nearer zero wins');
});

test('two spots equally near the middle: the lower one wins', () => {
  assert.equal(cleanestSpot(0, 100, 50, anywhere, (p) => (p === 44 || p === 56 ? 0 : 1)).at, 44);
});

test('a spot the side does not accept is never chosen', () => {
  assert.equal(cleanestSpot(0, 100, 50, (p) => p !== 50, () => 0).at, 49.5);
  assert.equal(cleanestSpot(0, 100, 50, (p) => p > 70, (p) => p).at, 70.5);
});

test('a dot stays 6px in from each end of the side and never probes beyond', () => {
  const probed = [];
  assert.equal(cleanestSpot(0, 100, 50, (p) => { probed.push(p); return false; }, () => 0), null);
  assert.equal(Math.min(...probed), 6);
  assert.equal(Math.max(...probed), 94);
  assert.equal(cleanestSpot(0, 100, 50, (p) => p <= 6, () => 0).at, 6);
  assert.equal(cleanestSpot(0, 100, 50, (p) => p <= 5, () => 0), null, 'a spot inside the inset is not offered');
  assert.equal(cleanestSpot(0, 100, 50, anywhere, (p) => 100 - p).at, 94, 'the cheapest spot is still inside the inset');
});

test('with no acceptable spot on the side there is no position', () => {
  assert.equal(cleanestSpot(10, 70, 40, () => false, () => 0), null);
});

test('a side shorter than twice the inset offers its centre only', () => {
  assert.deepEqual({ ...cleanestSpot(0, 10, 5, anywhere, () => 7) }, { at: 5, cost: 7 });
  assert.equal(cleanestSpot(0, 10, 5, (p) => p !== 5, () => 0), null);
});

// A row of 6px glyphs with 1px gaps: a gap column is clean on its own but sits
// between two letters, so no edge may stop there.
function glyphRow(width, height, x0, x1, y, h) {
  const px = canvas(width, height);
  for (let x = x0; x < x1; x += 7) px.fill(x, y, 6, h, INK);
  return px;
}

test('a crop edge in a letter gap is not accepted: the crop falls back to the frame edges', () => {
  const px = glyphRow(600, 400, 41, 500, 104, 10);
  assert.equal(px.data[(108 * 600 + 187) * 4], 255, 'the left edge column is a gap');
  assert.equal(px.data[(108 * 600 + 348) * 4], 255, 'the right edge column is a gap');
  const { box, edges } = cropToMarks(px, [0, 0, 600, 400], [251, 100, 34, 20]);
  assert.deepEqual(box, [0, 52, 600, 116]);
  assert.deepEqual(edges, { left: 'frame', top: 'snapped', right: 'frame', bottom: 'snapped' });
});

test('a crop edge in a gap on the right falls back, whatever the left edge does', () => {
  const px = glyphRow(600, 400, 41, 500, 104, 10);
  const { edges } = cropToMarks(px, [0, 0, 600, 400], [252, 100, 33, 20]);
  assert.equal(edges.right, 'frame');
});

test('a lift edge in a letter gap is not clean: it grows to a band or reports the cut', () => {
  const ends = glyphRow(300, 120, 6, 140, 60, 10);
  assert.equal(ends.data[(65 * 300 + 54) * 4], 255, 'the right edge column is a gap');
  const grown = growBox(ends, [20, 54, 35, 24], 96);
  assert.equal(grown.cut, false);
  assert.equal(edgeIsClean(ends, grown.box, 'right'), true);
  assert.ok(grown.box[0] + grown.box[2] >= 140, 'the right edge clears the row');
  const long = growBox(glyphRow(300, 120, 6, 300, 60, 10), [20, 54, 35, 24], 96);
  assert.equal(long.cut, true);
});

// Four-letter words (6px glyphs, 1px gaps) separated by 4px spaces, from x=38.
function sentence(width) {
  const px = canvas(width, 120);
  for (let word = 38; word < width - 30; word += 31) for (let g = 0; g < 4; g += 1) px.fill(word + g * 7, 60, 6, 10, INK);
  return px;
}

test('a lift on one word of running text keeps its edges in the 4px spaces beside it', () => {
  const px = sentence(260);
  assert.deepEqual(growBox(px, [130, 56, 29, 20], 96, { band: LIFT_BAND }), { box: [130, 56, 29, 20], cut: false });
  assert.notDeepEqual(growBox(px, [130, 56, 29, 20], 96).box, [130, 56, 29, 20], 'the default band would swallow the neighbours');
});

test('a lift box touching a word grows one pixel into the spaces beside it, not across its neighbours', () => {
  const px = sentence(260);
  assert.deepEqual(growBox(px, [131, 56, 27, 20], 96, { band: LIFT_BAND }), { box: [130, 56, 29, 20], cut: false });
});

test('a lift band of 3 rejects a 2px letter gap that a band of 2 stops in', () => {
  const px = canvas(120, 120);
  for (let x = 2; x < 56; x += 8) px.fill(x, 60, 6, 10, INK);
  assert.deepEqual(growBox(px, [5, 56, 25, 24], 96, { band: 2 }), { box: [1, 56, 32, 24], cut: false }, 'band 2 stops in a gap mid-word');
  assert.deepEqual(growBox(px, [5, 56, 25, 24], 96, { band: 3 }), { box: [1, 56, 56, 24], cut: false }, 'band 3 clears the word end');
  assert.equal(LIFT_BAND, 3);
});

test('a short band still rejects a 1px letter gap', () => {
  const grown = growBox(glyphRow(300, 120, 6, 140, 60, 10), [20, 54, 35, 24], 96, { band: LIFT_BAND });
  assert.equal(grown.cut, false);
  assert.ok(grown.box[0] + grown.box[2] >= 140, 'the right edge clears the row');
  assert.equal(growBox(glyphRow(300, 120, 6, 300, 60, 10), [20, 54, 35, 24], 96, { band: LIFT_BAND }).cut, true);
});

test('an edge counts as clean only inside a band of clean lines, so a letter gap is not clean', () => {
  const px = glyphRow(300, 120, 6, 140, 60, 10);
  assert.equal(edgeIsClean(px, [20, 54, 35, 24], 'right'), false);
  assert.equal(edgeIsClean(px, [20, 54, 141, 24], 'right'), true);
});

const { edgeName } = sandbox.__composeGeometry;

test('a side that does not grow keeps its fractional coordinate', () => {
  const c = canvas(200, 100).fill(40, 24, 60, 4, INK);
  const { box } = growBox(c, [20.5, 20.25, 40, 11.5], 96);
  assert.equal(box[0], 20.5, 'the left edge did not move');
  assert.equal(box[1], 20.25, 'the top edge did not move');
  assert.equal(box[1] + box[3], 31.75, 'the bottom edge did not move');
  assert.ok(box[0] + box[2] >= 100, 'the right edge grew past the block');
});

test('an edge is named for where it ended up, not for its last move', () => {
  assert.equal(edgeName('top', 50, 43, true), 'outward');
  assert.equal(edgeName('top', 50, 57, true), 'inward');
  assert.equal(edgeName('top', 50, 50, true), 'clean');
  assert.equal(edgeName('right', 300, 310, true), 'outward');
  assert.equal(edgeName('bottom', 200, 190, true), 'inward');
  assert.equal(edgeName('left', 10, 4, false), 'cut');
});

test('a crop edge the margin already put on the frame is clamped, one that fell back is frame', () => {
  const c = canvas(600, 400);
  const { edges } = cropToMarks(c, [0, 0, 600, 400], [10, 150, 40, 20]);
  assert.equal(edges.left, 'clamped', 'the 64px margin reached past the frame');
  assert.equal(edges.right, 'snapped');
});

test('a frame edge that cuts a redaction fill moves out to the fill far side', () => {
  const c = canvas(400, 200);
  const { frame, edges } = cleanFrame(c, [100, 20, 200, 160], [150, 60, 40, 20], { keep: [[80, 60, 60, 24]] });
  assert.equal(frame[0], 80, 'the left edge sits on the fill near side');
  assert.equal(frame[0] + frame[2], 300, 'the right edge did not move');
  assert.equal(edges.left, 'outward');
});

test('a fixed frame never widens: an edge through content stays and reports a cut', () => {
  const px = canvas(700, 400).fill(440, 100, 60, 100, INK).fill(503, 100, 40, 100, INK);
  const frame = [100, 50, 400, 250];
  const free = cleanFrame(px, frame, null);
  assert.equal(free.edges.right, 'outward', 'a live frame still widens');
  assert.ok(free.frame[2] > frame[2]);
  const fixed = cleanFrame(px, frame, null, { fixed: true });
  assert.deepEqual(fixed, { frame, edges: { ...ALL_CLEAN, right: 'cut' }, cut: true });
});

test('a fixed frame still moves an edge inward, off content, when the marks leave room', () => {
  const px = canvas(600, 400).fill(100, 100, 200, 10, INK);
  const out = cleanFrame(px, [0, 100, 600, 250], [200, 200, 40, 20], { fixed: true });
  assert.deepEqual(out.frame, [0, 112, 600, 238]);
  assert.equal(out.edges.top, 'inward');
});

test('a fill whose pad reaches past a fixed frame leaves the frame no wider', () => {
  const c = canvas(500, 200);
  const fixed = cleanFrame(c, [100, 20, 200, 160], [150, 60, 40, 20], { keep: [[280, 60, 32, 24]], fixed: true });
  assert.deepEqual(fixed.frame, [100, 20, 200, 160]);
  const free = cleanFrame(c, [100, 20, 200, 160], [150, 60, 40, 20], { keep: [[280, 60, 32, 24]] });
  assert.equal(free.frame[0] + free.frame[2], 312, 'a live frame still moves out to the fill far side');
});

test('a fill that the frame does not cut leaves the frame alone', () => {
  const c = canvas(400, 200);
  const { frame } = cleanFrame(c, [100, 20, 200, 160], null, { keep: [[150, 60, 60, 24], [10, 60, 30, 24]] });
  assert.deepEqual(frame, [100, 20, 200, 160]);
});

test('a rule near the image edge is still a rule', () => {
  const c = canvas(200, 60).fill(100, 0, 1, 60, [200, 200, 200]);
  assert.equal(edgeIsClean(c, [20, 10, 160, 44], 'bottom'), true, 'the rule runs off the image 6px below the edge line');
});

test('a border cut 10px from its corner is a rule, a stem cut 4px from its end is content', () => {
  const border = canvas(200, 200).fill(100, 40, 1, 100, [200, 200, 200]);
  assert.equal(edgeIsClean(border, [20, 20, 160, 111], 'bottom'), true, '90px above the line, 10px below');
  const stem = canvas(200, 200).fill(100, 40, 2, 40, INK);
  assert.equal(edgeIsClean(stem, [20, 20, 160, 56], 'bottom'), false, '35px above the line, 4px below: 39px in all');
  const shortSide = canvas(200, 200).fill(100, 40, 1, 100, [200, 200, 200]);
  assert.equal(edgeIsClean(shortSide, [20, 20, 160, 118], 'bottom'), false, 'only 2px of the rule lies below the line');
});

test('content flush with the image edge names the edge image and reports no cut', () => {
  const c = canvas(300, 200).fill(0, 60, 80, 12, INK);
  const { frame, edges, cut } = cleanFrame(c, [0, 20, 300, 160], [20, 50, 40, 30]);
  assert.equal(frame[0], 0);
  assert.equal(edges.left, 'image');
  assert.equal(cut, false);
});

test('a snapped crop edge backs away from text until 12 clean lines lie inside it', () => {
  const c = canvas(600, 400).fill(201, 180, 40, 60, INK);
  const { box, edges } = cropToMarks(c, [0, 0, 600, 400], [300, 200, 40, 20]);
  assert.equal(box[0], 189, 'the text starts at 201, so the edge sits 12px from it');
  assert.equal(edges.left, 'snapped', 'a move for air does not rename the edge');
});

test('a crop edge stops its move for air at the first unclean line', () => {
  const c = canvas(600, 400).fill(201, 180, 40, 60, INK).fill(190, 180, 5, 60, INK);
  const { box } = cropToMarks(c, [0, 0, 600, 400], [300, 200, 40, 20]);
  assert.equal(box[0], 195, 'five more clean lines lie outward, and the bar beyond them is not crossed');
});

test('a crop edge that already has 12 clean lines inside it does not move', () => {
  const c = canvas(600, 400).fill(150, 180, 40, 60, INK);
  const { box } = cropToMarks(c, [0, 0, 600, 400], [300, 200, 40, 20]);
  assert.equal(box[0], 236);
});

test('a crop edge on the frame edge stays on it', () => {
  const c = canvas(600, 400).fill(101, 150, 10, 60, INK);
  const { box, edges } = cropToMarks(c, [100, 0, 500, 400], [110, 150, 40, 20]);
  assert.equal(box[0], 100);
  assert.equal(edges.left, 'clamped');
});

test('a snapped crop edge whose move for air ends on the frame bound is still named snapped', () => {
  const c = canvas(600, 400).fill(201, 180, 40, 60, INK);
  const { box, edges } = cropToMarks(c, [195, 0, 405, 400], [300, 200, 40, 20]);
  assert.equal(box[0], 195, 'the air move stops at the frame bound');
  assert.equal(edges.left, 'snapped');
});

test('a snapped bottom crop edge backs away from content until 12 clean lines lie inside it', () => {
  const c = canvas(600, 400).fill(250, 150, 60, 30, INK);
  const { box, edges } = cropToMarks(c, [0, 0, 600, 400], [260, 100, 40, 20]);
  assert.equal(box[1] + box[3], 192, 'the content ends at 180, so the edge sits 12 lines from it');
  assert.equal(edges.bottom, 'snapped');
});

const commonHeight = (frames) => ({ ...sandbox.__composeGeometry.commonHeight(frames) });

test('two frames of one shape share the height their width budget allows', () => {
  assert.deepEqual(commonHeight([[0, 0, 600, 300], [0, 0, 600, 300]]), { height: 280, floored: false });
});

test('a frame three times the size of its neighbour gets the same height', () => {
  assert.deepEqual(commonHeight([[0, 0, 1800, 900], [10, 10, 600, 300]]), { height: 280, floored: false });
});

test('small frames are not blown up past 1.25x', () => {
  assert.deepEqual(commonHeight([[0, 0, 300, 120], [0, 0, 300, 120]]), { height: 150, floored: false });
});

test('tall frames stop at 360', () => {
  assert.equal(commonHeight([[0, 0, 300, 600], [0, 0, 300, 600]]).height, 360);
});

test('the height is rounded to a whole pixel, not cut off', () => {
  assert.deepEqual(commonHeight([[0, 0, 1000, 300], [0, 0, 700, 300]]), { height: 198, floored: false });
});

test('a short frame whose 1.25x is under 96 is raised to 96 without the floored flag', () => {
  assert.deepEqual(commonHeight([[0, 0, 200, 60], [0, 0, 200, 60]]), { height: 96, floored: false });
});

test('a strip beside a card floors the height at 96 and says so', () => {
  assert.deepEqual(commonHeight([[0, 0, 1500, 75], [0, 0, 450, 100]]), { height: 96, floored: true });
});

test('an imported frame is dark when its pixels are, whatever the rest of the image is', () => {
  const { frameIsDark } = sandbox.__composeGeometry;
  const c = canvas(400, 200).fill(200, 0, 200, 200, [17, 24, 39]);
  assert.equal(frameIsDark(c, [0, 0, 190, 200]), false);
  assert.equal(frameIsDark(c, [210, 0, 190, 200]), true);
  assert.equal(frameIsDark(canvas(100, 100, [108, 108, 108]), [0, 0, 100, 100]), true);
  assert.equal(frameIsDark(canvas(100, 100, [112, 112, 112]), [0, 0, 100, 100]), false);
});

test('a frame is judged without the fills drawn over it', () => {
  const { frameIsDark } = sandbox.__composeGeometry;
  const DARK = [17, 24, 39]; const LIGHT = [203, 213, 225];
  const fill = [0, 0, 70, 100];
  const darkWithFill = canvas(100, 100, DARK).fill(0, 0, 70, 100, LIGHT);
  assert.equal(frameIsDark(darkWithFill, [0, 0, 100, 100]), false, 'the fill alone pulls the median up');
  assert.equal(frameIsDark(darkWithFill, [0, 0, 100, 100], [fill]), true, 'skipping the fill leaves the dark ground');
  assert.equal(frameIsDark(canvas(100, 100, LIGHT).fill(0, 0, 70, 100, DARK), [0, 0, 100, 100], [fill]), false, 'and the reverse');
  assert.equal(frameIsDark(canvas(100, 100, DARK).fill(0, 0, 30, 100, LIGHT), [0, 0, 100, 100]), true, 'a light region under a third of the frame does not flip it');
  assert.equal(frameIsDark(canvas(100, 100, LIGHT).fill(0, 0, 30, 100, DARK), [0, 0, 100, 100]), false, 'nor a dark one');
  assert.equal(frameIsDark(darkWithFill, [0, 0, 100, 100], [[0, 0, 100, 100]]), false, 'a frame wholly under fills has nothing to judge and stays light');
});

// A 200x100 capture shown 1:1, with the element at [80, 40, 20, 10] and a 40x30 card to place.
const ELEMENT = [80, 40, 20, 10];
const spotOn = (px, element = ELEMENT, size = [40, 30], S = 1) => liftSpot(contentUnder(px, [0, 0, 200, 100], S, element), [200, 100], element, size);

test('content under a card is counted outside the element only', () => {
  const px = canvas(200, 100).fill(85, 43, 5, 3, INK).fill(60, 20, 10, 10, INK);
  const hidden = contentUnder(px, [0, 0, 200, 100], 1, ELEMENT);
  assert.equal(hidden([76, 34, 28, 22]), 0, 'the element itself never counts, and the block lies clear of the card');
  assert.equal(hidden([60, 20, 40, 30]), 100);
});

// A card's margin is its 3px ring plus LIFT_CLEAR capture px.
test('content within the ring and LIFT_CLEAR px of a card counts as under it, and content beyond does not', () => {
  const px = canvas(200, 100).fill(64, 40, 4, 4, INK);
  const hidden = contentUnder(px, [0, 0, 200, 100], 1, ELEMENT);
  assert.equal(hidden([70, 30, 40, 30]), 16, 'the block ends 2px from the card');
  assert.equal(hidden([73, 30, 40, 30]), 4, 'the block ends 5px from the card');
  assert.equal(hidden([74, 30, 40, 30]), 0, 'the block ends 6px from the card');
  const scaled = contentUnder(px, [0, 0, 200, 100], 2, [160, 80, 40, 20]);
  assert.equal(scaled([142, 60, 80, 60]), 8, 'at 2x the margin is the ring plus 6 board px: a block ending 6 board px away is in it');
  assert.equal(scaled([145, 60, 80, 60]), 0, 'and one ending 9 board px away is not');
});

test('content beyond the frame is not counted', () => {
  const px = canvas(200, 100).fill(60, 20, 10, 10, INK);
  assert.equal(contentUnder(px, [75, 0, 125, 100], 1, ELEMENT)([60, 20, 40, 30]), 0);
});

test('a lift on open ground sits centred on its element', () => {
  assert.deepEqual(spotOn(canvas(200, 100)), { L: 70, T: 30, clamped: false });
  assert.deepEqual(spotOn(canvas(200, 100), [80.5, 40.25, 20, 10]), { L: 70.5, T: 30.25, clamped: false });
});

test('content only above leaves a card that hangs down', () => {
  const px = canvas(200, 100).fill(0, 20, 200, 20, INK);
  assert.deepEqual(spotOn(px), { L: 70, T: 40, clamped: false });
});

test('content left and right with ground below leaves a card centred across and hanging down', () => {
  const px = canvas(200, 100).fill(0, 20, 80, 31, INK).fill(100, 20, 100, 31, INK);
  assert.deepEqual(spotOn(px), { L: 70, T: 40, clamped: false });
});

test('content on every side takes the position that hides the least', () => {
  const px = canvas(200, 100).fill(0, 20, 200, 20, INK).fill(0, 52, 90, 19, INK);
  assert.deepEqual(spotOn(px), { L: 80, T: 40, clamped: false });
});

test('equally covering positions go to the one nearest the centre, the same on every run', () => {
  const px = canvas(200, 100).fill(0, 0, 200, 40, INK).fill(0, 52, 200, 48, INK);
  assert.deepEqual(spotOn(px), { L: 70, T: 30, clamped: false });
  assert.deepEqual(spotOn(px), spotOn(px));
});

test('the card always covers the element it was lifted from', () => {
  const px = canvas(200, 100).fill(0, 0, 200, 36, INK).fill(0, 64, 200, 36, INK).fill(0, 36, 76, 28, INK);
  const { L, T } = spotOn(px);
  assert.ok(L <= 80 && L + 40 >= 100 && T <= 40 && T + 30 >= 50, `the card at ${L},${T} leaves the element showing`);
});

test('a card pinned by the frame edge is reported as clamped', () => {
  const near = [3, 40, 20, 10];
  assert.deepEqual(spotOn(canvas(200, 100), near), { L: 2, T: 30, clamped: true });
});

test('a card no larger than its element stays centred', () => {
  assert.deepEqual(spotOn(canvas(200, 100).fill(0, 20, 200, 20, INK), ELEMENT, [20, 10]), { L: 80, T: 40, clamped: false });
});

test('the search reads the capture at the board scale', () => {
  const px = canvas(100, 50).fill(0, 10, 100, 10, INK);
  const element = [80, 40, 20, 10];
  const { L, T } = liftSpot(contentUnder(px, [0, 0, 100, 50], 2, element), [200, 100], element, [40, 30]);
  assert.ok(T >= 39 && T <= 40, `the card hangs down, to within the capture pixel its margin is counted in: ${T}`);
  assert.ok(Math.abs(L - 70) <= 1, `and stays centred across: ${L}`);
});

const rowsOfText = (px, rows) => rows.reduce((c, y) => c.fill(100, y, 200, 10, INK), px);
const ROW_PITCH = 24;
const rowAt = (i) => 100 + ROW_PITCH * i;

test('marks smaller than the context floor grow evenly to 320 by 200, centred on them', () => {
  const frame = [0, 0, 800, 600];
  const { box } = cropToMarks(canvas(800, 600), frame, [380, 290, 40, 20], { floor: true });
  assert.deepEqual(box, [240, 200, 320, 200]);
});

test('the context floor clamps at a frame corner and keeps its size', () => {
  const frame = [0, 0, 800, 600];
  const { box } = cropToMarks(canvas(800, 600), frame, [10, 10, 40, 20], { floor: true });
  assert.deepEqual(box, [0, 0, 320, 200]);
  const far = cropToMarks(canvas(800, 600), frame, [750, 570, 40, 20], { floor: true }).box;
  assert.deepEqual(far, [480, 400, 320, 200]);
});

test('without the floor a small marks box crops to its margins alone', () => {
  const frame = [0, 0, 800, 600];
  assert.deepEqual(cropToMarks(canvas(800, 600), frame, [380, 290, 40, 20]).box, [316, 242, 168, 116]);
});

test('the context floor is measured on the margins, so marks already wider than it are not widened', () => {
  const { box } = cropToMarks(canvas(1000, 800), [0, 0, 1000, 800], [300, 300, 300, 20], { floor: true });
  assert.deepEqual(box, [236, 210, 428, 200], 'only the short side grows');
});

test('a frame smaller than the context floor is returned whole', () => {
  const frame = [0, 0, 300, 180];
  assert.deepEqual(cropToMarks(canvas(300, 180), frame, [100, 80, 40, 20], { floor: true }).box, frame);
});

const GROUP = [rowAt(3), rowAt(11) + 10];
const groupBox = [100, GROUP[0], 200, GROUP[1] - GROUP[0]];
const textRows = () => rowsOfText(canvas(600, 600), Array.from({ length: 16 }, (_, i) => rowAt(i)));

test('a bracket group crops 16px beyond its rows, so the crop ends after the first row below the group', () => {
  const frame = [0, 0, 600, 600];
  const tight = cropToMarks(textRows(), frame, groupBox, { parts: [{ box: groupBox, bracket: true }] }).box;
  const usual = cropToMarks(textRows(), frame, groupBox).box;
  const bottom = (b) => b[1] + b[3];
  assert.ok(bottom(tight) > rowAt(12) + 10 && bottom(tight) <= rowAt(13), `the tight crop holds row 12 and stops before row 13: ${bottom(tight)}`);
  assert.ok(bottom(usual) > rowAt(13) + 10, `the usual margin takes row 13 too: ${bottom(usual)}`);
  assert.ok(tight[1] > rowAt(1) + 10 && tight[1] <= rowAt(2), `the top edge is tight as well: ${tight[1]}`);
});

test('a lift on the same edge as a bracket keeps the usual margin there', () => {
  const frame = [0, 0, 600, 600];
  const lift = [100, GROUP[1] - 10, 60, 10];
  const parts = [{ box: groupBox, bracket: true }, { box: lift, bracket: false }];
  const mixed = cropToMarks(textRows(), frame, groupBox, { parts }).box;
  assert.ok(mixed[1] + mixed[3] > rowAt(13) + 10, 'the bottom edge keeps the usual margin');
  assert.ok(mixed[1] > rowAt(1) + 10, 'the top edge, bounded by the bracket alone, is tight');
});

const card = (frameW, frameH, at, size) => {
  const [x, y] = at; const [w, h] = size; const c = canvas(frameW, frameH);
  c.fill(x, y, w, 1, INK).fill(x, y + h - 1, w, 1, INK).fill(x, y, 1, h, INK).fill(x + w - 1, y, 1, h, INK);
  return c;
};

test('a frame with 30px of ground and then a border trims to 2px outside the border', () => {
  const { box, trimmed } = trimBlank(card(300, 200, [30, 30], [240, 140]), [0, 0, 300, 200], null);
  assert.deepEqual(box, [28, 28, 244, 144]);
  assert.deepEqual(trimmed, { left: 28, top: 28, right: 28, bottom: 28 });
});

test('a frame tight to the border does not move', () => {
  const { box, trimmed } = trimBlank(card(300, 200, [30, 30], [240, 140]), [30, 30, 240, 140], null);
  assert.deepEqual(box, [30, 30, 240, 140]);
  assert.deepEqual(trimmed, { left: 0, top: 0, right: 0, bottom: 0 });
});

test('a frame 1px or 2px outside the border does not move either', () => {
  assert.deepEqual(trimBlank(card(300, 200, [30, 30], [240, 140]), [28, 28, 244, 144], null).box, [28, 28, 244, 144]);
  assert.deepEqual(trimBlank(card(300, 200, [30, 30], [240, 140]), [27, 27, 246, 146], null).box, [28, 28, 244, 144]);
});

test('each side trims on its own', () => {
  const { box, trimmed } = trimBlank(card(300, 200, [50, 10], [200, 180]), [0, 0, 300, 200], null);
  assert.deepEqual(box, [48, 8, 204, 184]);
  assert.deepEqual(trimmed, { left: 48, top: 8, right: 48, bottom: 8 });
});

test('a faint card border on near-white ground still stops the trim, so the card keeps its padding', () => {
  const ground = [246, 247, 249]; const edge = [229, 231, 235];
  const px = canvas(300, 200, ground).fill(40, 40, 220, 120, [255, 255, 255]);
  px.fill(40, 40, 220, 1, edge).fill(40, 159, 220, 1, edge).fill(40, 40, 1, 120, edge).fill(259, 40, 1, 120, edge);
  px.fill(70, 70, 60, 10, INK);
  const { box } = trimBlank(px, [0, 0, 300, 200], null);
  assert.deepEqual(box, [38, 38, 224, 124], 'the frame ends 2px outside the border, not at the text inside it');
});

test('a frame of nothing but ground is left as it is', () => {
  const frame = [10, 10, 200, 100];
  const { box, trimmed } = trimBlank(canvas(300, 200), frame, null);
  assert.deepEqual(box, frame);
  assert.deepEqual(trimmed, { left: 0, top: 0, right: 0, bottom: 0 });
});

test('a trim stops at a full-width rule instead of passing it', () => {
  const px = canvas(300, 200).fill(0, 40, 300, 1, INK).fill(100, 100, 40, 20, INK);
  const { box } = trimBlank(px, [0, 0, 300, 200], null);
  assert.equal(box[1], 38, 'the top edge stops 2px outside the rule');
});

test('a trim never passes the marks, even over ground', () => {
  const px = canvas(300, 200).fill(100, 100, 40, 20, INK);
  const { box } = trimBlank(px, [0, 0, 300, 200], [20, 60, 30, 30]);
  assert.equal(box[0], 18, 'a mark box over ground keeps its side');
  assert.equal(box[1], 58);
});

// Ink squares 11px wide every 16px: no line crosses them clean, and no gap is wide enough to be a band.
function dense(width, height) {
  const px = canvas(width, height);
  for (let y = 0; y < height; y += 16) for (let x = 0; x < width; x += 16) px.fill(x, y, 11, 11, INK);
  return px;
}

test('on a dense page an edge with no clean band goes to the frame, so the crop is the whole frame', () => {
  const frame = [0, 0, 1000, 800];
  const { box, edges } = cropToMarks(dense(1000, 800), frame, [400, 300, 60, 20]);
  assert.deepEqual(box, frame);
  assert.equal(edges, null);
});

test('with the margin held, an edge with no clean band stays where the margin put it and reports the cut', () => {
  const frame = [0, 0, 1000, 800];
  const { box, edges, cut } = cropToMarks(dense(1000, 800), frame, [400, 300, 60, 20], { hold: true });
  assert.deepEqual(box, [336, 252, 188, 116]);
  assert.deepEqual(edges, { left: 'margin', top: 'margin', right: 'margin', bottom: 'margin' });
  assert.equal(cut, true);
});

test('holding the margin leaves an edge that finds a band snapped and reports no cut', () => {
  const frame = [0, 0, 600, 400];
  const px = canvas(600, 400).fill(500, 150, 46, 10, INK);
  const { box, edges, cut } = cropToMarks(px, frame, [150, 120, 300, 120], { hold: true });
  assert.deepEqual(box, [86, 72, 472, 216]);
  assert.equal(edges.right, 'snapped');
  assert.equal(cut, false);
});

test('holding the margin still returns the frame when the crop covers half of it', () => {
  const frame = [0, 0, 400, 300];
  const { box, edges } = cropToMarks(dense(400, 300), frame, [100, 100, 200, 100], { hold: true });
  assert.deepEqual(box, frame);
  assert.equal(edges, null);
});

// A card border 8px outside the element's right edge, as a rule or as a block of the same ink.
const withBorder = (width, y0 = 0, height = 100) => canvas(200, 100).fill(108, y0, width, height, GREY);

test('a card border within the lift\'s margin is a rule, not content, so the lift stays centred', () => {
  assert.deepEqual(spotOn(withBorder(1)), { L: 70, T: 30, clamped: false });
  assert.deepEqual(spotOn(withBorder(2)), { L: 70, T: 30, clamped: false });
});

test('a rule counts for nothing under the card, whether the card covers it or only leaves it within its margin', () => {
  const hidden = contentUnder(withBorder(1), [0, 0, 200, 100], 1, ELEMENT);
  assert.equal(hidden([70, 30, 40, 30]), 0, 'within the margin');
  assert.equal(hidden([80, 30, 40, 30]), 0, 'under the card');
});

test('a divider along the lift\'s margin is a rule too', () => {
  const px = canvas(200, 100).fill(0, 62, 200, 1, GREY);
  assert.equal(contentUnder(px, [0, 0, 200, 100], 1, ELEMENT)([70, 30, 40, 30]), 0);
});

test('a block in the border\'s place still moves the lift away', () => {
  const { L } = spotOn(withBorder(3, 25, 20));
  assert.ok(L < 70, `the lift moved to ${L}`);
});

test('a line thicker than RULE_MAX is content, however long', () => {
  const { L } = spotOn(withBorder(3));
  assert.ok(L < 70, `the lift moved to ${L}`);
  assert.ok(contentUnder(withBorder(3), [0, 0, 200, 100], 1, ELEMENT)([70, 30, 40, 30]) > 0);
});

test('a rule that stops inside the counted region is content', () => {
  const { L } = spotOn(withBorder(1, 0, 50));
  assert.ok(L < 70, `the lift moved to ${L}`);
});

test('rules that cross inside the counted region are subtracted once, so a grid counts as nothing', () => {
  for (const width of [1, 2]) {
    const px = canvas(200, 100).fill(108, 0, width, 100, GREY).fill(0, 62, 200, width, GREY);
    assert.equal(contentUnder(px, [0, 0, 200, 100], 1, ELEMENT)([70, 30, 40, 30]), 0, `${width}px rules`);
  }
});

test('the edge of a block as tall as the counted region is content, not a rule', () => {
  const px = canvas(200, 100).fill(115, 0, 40, 100, GREY);
  assert.ok(contentUnder(px, [0, 0, 200, 100], 1, ELEMENT)([70, 30, 40, 30]) > 0);
  assert.ok(spotOn(px).L < 70, 'the lift moves away from the block');
});

test('a card border runs the same under the lift at board scale 2', () => {
  const px = canvas(200, 100).fill(108, 0, 1, 100, GREY);
  const element = [160, 80, 40, 20];
  const { L } = liftSpot(contentUnder(px, [0, 0, 200, 100], 2, element), [400, 200], element, [80, 60]);
  assert.equal(L, 140);
});
