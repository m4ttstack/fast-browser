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

test('padding asked for more clear lines than LIFT_CLEAR keeps them, and never fewer', () => {
  const px = canvas(120, 120).fill(43, 54, 1, 3, INK);
  assert.deepEqual(cleanPad(px, [50, 50, 12, 12], 4, { clear: 5 }), [1, 4, 4, 4]);
  assert.deepEqual(cleanPad(px, [50, 50, 12, 12], 4, { clear: 2 }), [3, 4, 4, 4]);
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

// Content within 24 px of the marks leaves an edge no band to come in to, so it looks outward alone.
test('a tightened edge that cuts content moves outward to the first clean band', () => {
  const px = canvas(600, 400).fill(255, 150, 86, 10, INK);
  const frame = [0, 0, 600, 400];
  const out = cropToMarks(px, frame, [200, 150, 40, 20]).box;
  assert.deepEqual(out, [136, 102, 217, 116]);
  for (const side of ['left', 'top', 'right', 'bottom']) assert.equal(edgeIsClean(px, out, side), true, side);
});

test('an edge looks no further than 80px for a clean band', () => {
  const px = canvas(600, 400).fill(255, 150, 320, 10, INK);
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
  assert.deepEqual(box, [136, 107, 168, 111]);
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
  // Bars of 2 px: three lines inside a wider one are one colour, which is a word space.
  const px = canvas(301, 301);
  for (let x = 3; x < 301; x += 6) px.fill(x, 0, 2, 301, INK);
  for (let y = 3; y < 301; y += 6) px.fill(0, y, 301, 2, INK);
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

const pickBoardSide = (...args) => ({ ...sandbox.__composeGeometry.pickBoardSide(...args) });
const side = (open, hard, ink, run) => ({ open, hard, ink, run });

test('pickBoardSide takes the side open to every panel', () => {
  const surveys = [{ right: side(true, false, 0, 40), bottom: side(true, false, 0, 90) }, { right: side(false, false, 0, 0), bottom: side(true, false, 0, 60) }];
  assert.deepEqual(pickBoardSide(surveys, { fallback: 'right' }), { side: 'bottom', pinned: false });
});

test('pickBoardSide prefers less content, then the bottom when its run is under half the right\'s, then the right', () => {
  const dirty = [{ right: side(true, false, 9, 40), bottom: side(true, false, 2, 400) }];
  assert.equal(pickBoardSide(dirty, { fallback: 'right' }).side, 'bottom', 'less content wins, however long the run');
  const cleaner = [{ right: side(true, false, 2, 400), bottom: side(true, false, 9, 40) }];
  assert.equal(pickBoardSide(cleaner, { fallback: 'right' }).side, 'right', 'and wins for the right as well');
  const far = [{ right: side(true, false, 1, 400), bottom: side(true, false, 2, 40) }];
  assert.equal(pickBoardSide(far, { fallback: 'right' }).side, 'bottom', 'a run under half the right\'s');
  const shorter = [{ right: side(true, false, 0, 100), bottom: side(true, false, 0, 60) }];
  assert.equal(pickBoardSide(shorter, { fallback: 'right' }).side, 'right', 'a shorter run below, but not under half');
  const half = [{ right: side(true, false, 0, 100), bottom: side(true, false, 0, 50) }];
  assert.equal(pickBoardSide(half, { fallback: 'right' }).side, 'right', 'exactly half is not under half');
  const split = [{ right: side(true, false, 0, 60), bottom: side(true, false, 0, 10) }, { right: side(true, false, 0, 40), bottom: side(true, false, 0, 45) }];
  assert.equal(pickBoardSide(split, { fallback: 'right' }).side, 'right', 'the runs are totalled over the panels: 55 below is not under half of 100');
  const even = [{ right: side(true, false, 0, 50), bottom: side(true, false, 0, 50) }];
  assert.equal(pickBoardSide(even, { fallback: 'right' }).side, 'right');
});

test('pickBoardSide pins a board with no easy side, and a board with no labels is not pinned', () => {
  const hard = [{ right: side(true, true, 0, 10), bottom: side(false, false, 0, 10) }];
  assert.deepEqual(pickBoardSide(hard, { fallback: 'bottom' }), { side: 'bottom', pinned: true });
  const none = [{ right: side(true, false, 0, 0), bottom: side(true, false, 0, 0) }];
  assert.deepEqual(pickBoardSide(none, { fallback: 'right' }), { side: 'right', pinned: false });
});

test('pickBoardSide takes a side whose only fault is a long run before it pins the board', () => {
  const far = (open, hard, ink, run) => ({ ...side(open, hard, ink, run), far: true });
  const longRight = [{ right: far(true, false, 0, 400), bottom: side(true, true, 9, 40) }];
  assert.deepEqual(pickBoardSide(longRight, { fallback: 'bottom' }), { side: 'right', pinned: false }, 'a long clean run beats a way through content');
  const nearBelow = [{ right: far(true, false, 0, 400), bottom: side(true, false, 0, 300) }];
  assert.deepEqual(pickBoardSide(nearBelow, { fallback: 'right' }), { side: 'bottom', pinned: false }, 'a side with no long run beats one with');
  const both = [{ right: far(true, false, 0, 400), bottom: far(true, false, 0, 300) }];
  assert.deepEqual(pickBoardSide(both, { fallback: 'bottom' }), { side: 'right', pinned: false }, 'two long sides are chosen between as two easy ones are');
  const across = [{ right: far(true, false, 0, 400), bottom: side(true, false, 0, 40) }, { right: side(true, false, 0, 40), bottom: far(true, false, 0, 300) }];
  assert.deepEqual(pickBoardSide(across, { fallback: 'bottom' }), { side: 'right', pinned: false }, 'a long run in any panel makes the side a long one for the board');
  const tangled = [{ right: far(true, true, 0, 400), bottom: side(true, true, 9, 40) }];
  assert.deepEqual(pickBoardSide(tangled, { fallback: 'bottom' }), { side: 'bottom', pinned: true }, 'a long run does not excuse a hard side');
  const shut = [{ right: far(false, false, 0, 400), bottom: side(true, true, 9, 40) }];
  assert.deepEqual(pickBoardSide(shut, { fallback: 'right' }), { side: 'right', pinned: true }, 'nor a side that is not open');
});

test('pickBoardSide keeps a forced side', () => {
  const surveys = [{ right: side(true, false, 5, 300), bottom: side(true, false, 0, 10) }];
  assert.deepEqual(pickBoardSide(surveys, { forced: 'right', fallback: 'right' }), { side: 'right', pinned: false });
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

test('a frame told to stay moves no edge: one through text is named cut where it stands, and one through a fill stays too', () => {
  const px = canvas(600, 400).fill(100, 100, 200, 10, INK);
  const frame = [0, 100, 600, 250];
  assert.equal(cleanFrame(px, frame, [200, 200, 40, 20]).edges.top, 'inward', 'left to itself the edge moves');
  assert.deepEqual(cleanFrame(px, frame, [200, 200, 40, 20], { stay: true }), { frame, edges: { ...ALL_CLEAN, top: 'cut' }, cut: true });
  const filled = cleanFrame(canvas(400, 200), [100, 20, 200, 160], [150, 60, 40, 20], { keep: [[80, 60, 60, 24]], stay: true });
  assert.deepEqual(filled.frame, [100, 20, 200, 160]);
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
  const c = canvas(600, 400).fill(201, 180, 80, 60, INK);
  const { box, edges } = cropToMarks(c, [0, 0, 600, 400], [300, 200, 40, 20]);
  assert.equal(box[0], 189, 'the text starts at 201, so the edge sits 12px from it');
  assert.equal(edges.left, 'snapped', 'a move for air does not rename the edge');
});

test('a crop edge stops its move for air at the first unclean line', () => {
  const c = canvas(600, 400).fill(201, 180, 80, 60, INK).fill(190, 180, 5, 60, INK);
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
  const c = canvas(600, 400).fill(201, 180, 80, 60, INK);
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

const panelSizes = (...args) => ({ ...sandbox.__composeGeometry.panelSizes(...args) });

test('two frames of one shape share the height their width budget allows', () => {
  assert.deepEqual(panelSizes([[0, 0, 600, 300], [0, 0, 600, 300]]), { stacked: false, height: 280 });
});

test('a frame three times the size of its neighbour gets the same height', () => {
  assert.deepEqual(panelSizes([[0, 0, 1800, 900], [10, 10, 600, 300]]), { stacked: false, height: 280 });
});

test('small frames are not blown up past 1x', () => {
  assert.deepEqual(panelSizes([[0, 0, 300, 120], [0, 0, 300, 120]]), { stacked: false, height: 120 });
});

test('tall frames stop at 360', () => {
  assert.equal(panelSizes([[0, 0, 300, 600], [0, 0, 300, 600]]).height, 360);
});

test('the height is rounded to a whole pixel, not cut off', () => {
  assert.deepEqual(panelSizes([[0, 0, 1000, 300], [0, 0, 700, 300]]), { stacked: false, height: 198 });
});

test('a short frame whose 1x is under 96 is raised to 96', () => {
  assert.deepEqual(panelSizes([[0, 0, 200, 60], [0, 0, 200, 60]]), { stacked: false, height: 96 });
});

test('a strip beside a card is stacked at the width of the narrower', () => {
  assert.deepEqual(panelSizes([[0, 0, 1500, 75], [0, 0, 450, 100]]), { stacked: true, width: 450 });
});

test('panelSizes keeps ordinary panels in a row at one height, never above their size', () => {
  const sizes = panelSizes([[0, 0, 400, 300], [0, 0, 400, 300]]);
  assert.equal(sizes.stacked, false);
  assert.equal(sizes.height, 300, 'a 300 px frame is not enlarged');
});

test('panelSizes stacks panels that would make a strip', () => {
  const sizes = panelSizes([[0, 0, 1400, 220], [0, 0, 1400, 220]]);
  assert.equal(sizes.stacked, true);
  assert.equal(sizes.width, 720);
});

test('panelSizes never enlarges the narrowest stacked panel', () => {
  assert.equal(panelSizes([[0, 0, 500, 60], [0, 0, 1400, 150]]).width, 500);
});

test('a row exactly 9 times as wide as it is high stays a row, above the floor, and one a pixel wider is stacked', () => {
  assert.deepEqual(panelSizes([[0, 0, 900, 200], [0, 0, 900, 200]]), { stacked: false, height: 124 }, 'the widest row there is still has 124 px, over the least height of 96');
  assert.equal(panelSizes([[0, 0, 901, 200], [0, 0, 900, 200]]).stacked, true);
});

test('three steps of 2.4 to 1 stay a row', () => {
  assert.deepEqual(panelSizes([[0, 0, 480, 200], [0, 0, 480, 200], [0, 0, 480, 200]]), { stacked: false, height: 156 });
});

const { sharedZoom, cutLine } = sandbox.__composeGeometry;

test('steps whose one height draws them at zooms more than 1.25 apart share the zoom the board allows', () => {
  // At one height of 110 the rail is drawn at 0.42 and the header at 1.
  const frames = [[0, 0, 140, 260], [0, 0, 420, 110], [0, 0, 360, 150]];
  assert.equal(sharedZoom(frames, panelSizes(frames)), 1);
  const wide = [[0, 0, 700, 300], [0, 0, 600, 120]];
  assert.equal(sharedZoom(wide, panelSizes(wide)), 1120 / 1300, 'the width budget over the widths');
  const tall = [[0, 0, 300, 600], [0, 0, 300, 300]];
  assert.equal(sharedZoom(tall, panelSizes(tall)), 0.6, 'the height cap over the tallest');
});

test('steps keep their one height when their zooms stay close, or one zoom would draw them below 0.55', () => {
  const close = [[0, 0, 400, 300], [0, 0, 400, 260]];
  assert.equal(sharedZoom(close, panelSizes(close)), null);
  const small = [[0, 0, 900, 700], [0, 0, 900, 200]];
  assert.equal(sharedZoom(small, panelSizes(small)), null, '360 over 700 is under 0.55');
});

test('stacked steps share a zoom of the stack width over the widest frame', () => {
  const near = [[0, 0, 1000, 60], [0, 0, 700, 60]];
  assert.equal(panelSizes(near).stacked, true);
  assert.equal(sharedZoom(near, panelSizes(near)), 0.72);
  const far = [[0, 0, 1500, 75], [0, 0, 900, 60]];
  assert.equal(sharedZoom(far, panelSizes(far)), null, '720 over 1500 is under 0.55');
});

test('cutLine reaches to the last line of a sub-line within reach, held to the height allowed', () => {
  // A 16 px line on rows 20..35 and a sub-line on rows 39..46, four lines past the box's bottom edge.
  const px = canvas(200, 80).fill(40, 20, 100, 16, INK).fill(40, 39, 50, 8, INK);
  const box = [40, 20, 100, 16];
  assert.equal(cutLine(px, box, 'bottom', 9, 16), 11, 'to row 46');
  assert.equal(cutLine(px, box, 'bottom', 3, 16), 0, 'the sub-line starts past the reach');
  assert.equal(cutLine(px, box, 'bottom', 9, 7), 0, 'the sub-line is taller than allowed');
  assert.equal(cutLine(px, box, 'top', 9, 16), 0, 'nothing above');
  assert.equal(cutLine(px, box, 'bottom', 9, 16, { bounds: [0, 0, 200, 45] }), 0, 'the sub-line runs past the bounds');
});

test('cutLine finds the sub-line at a fractional device scale, where LIFT_BAND is no whole number of lines', () => {
  // The scene above at 1.5x and 1.25x: the sub-line's last content line is the same number of lines past the box.
  for (const [scale, line, sub] of [[1.5, [60, 30, 150, 24], [60, 58, 75, 12]], [1.25, [50, 25, 125, 20], [50, 49, 63, 10]]]) {
    const px = canvas(300, 120).fill(...line, INK).fill(...sub, INK);
    const geometry = sandbox.__composeGeometry.withScale(scale);
    assert.equal(geometry.cutLine(px, line, 'bottom', 9 * scale, 16 * scale), sub[1] + sub[3] - line[1] - line[3], `at ${scale}x`);
  }
});

test('a crop is held to the least size it is given, above the context floor', () => {
  const frame = [0, 0, 1000, 800];
  assert.deepEqual(cropToMarks(canvas(1000, 800), frame, [480, 390, 40, 20], { floor: true, min: [500, 300] }).box, [250, 250, 500, 300]);
  assert.deepEqual(cropToMarks(canvas(1000, 800), frame, [480, 390, 40, 20], { floor: true, min: [200, 120] }).box, [340, 300, 320, 200], 'a least size under the floor does not lower it');
  assert.deepEqual(cropToMarks(canvas(1000, 800), frame, [480, 390, 40, 20], { min: [200, 120] }).box, [400, 340, 200, 120], 'and holds without the floor');
  assert.deepEqual(cropToMarks(canvas(1000, 800), frame, [20, 20, 40, 20], { floor: true, min: [500, 300] }).box, [0, 0, 500, 300], 'a crop pushed against the frame keeps the size');
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
  assert.deepEqual(spotOn(canvas(200, 100), near), { L: 5, T: 30, clamped: true });
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

test('a frame with 30px of ground and then a border trims to 12px outside the border', () => {
  const { box, trimmed } = trimBlank(card(300, 200, [30, 30], [240, 140]), [0, 0, 300, 200], null);
  assert.deepEqual(box, [18, 18, 264, 164]);
  assert.deepEqual(trimmed, { left: 18, top: 18, right: 18, bottom: 18 });
});

test('a frame tight to the border does not move', () => {
  const { box, trimmed } = trimBlank(card(300, 200, [30, 30], [240, 140]), [30, 30, 240, 140], null);
  assert.deepEqual(box, [30, 30, 240, 140]);
  assert.deepEqual(trimmed, { left: 0, top: 0, right: 0, bottom: 0 });
});

test('a frame 11px or 12px outside the border does not move either', () => {
  assert.deepEqual(trimBlank(card(300, 200, [30, 30], [240, 140]), [19, 19, 262, 162], null).box, [19, 19, 262, 162]);
  assert.deepEqual(trimBlank(card(300, 200, [30, 30], [240, 140]), [18, 18, 264, 164], null).box, [18, 18, 264, 164]);
  assert.deepEqual(trimBlank(card(300, 200, [30, 30], [240, 140]), [17, 17, 266, 166], null).box, [18, 18, 264, 164]);
});

test('each side trims on its own', () => {
  const { box, trimmed } = trimBlank(card(300, 200, [50, 10], [200, 180]), [0, 0, 300, 200], null);
  assert.deepEqual(box, [38, 0, 224, 200]);
  assert.deepEqual(trimmed, { left: 38, top: 0, right: 38, bottom: 0 });
});

test('a faint card border on near-white ground still stops the trim, so the card keeps its padding', () => {
  const ground = [246, 247, 249]; const edge = [229, 231, 235];
  const px = canvas(300, 200, ground).fill(40, 40, 220, 120, [255, 255, 255]);
  px.fill(40, 40, 220, 1, edge).fill(40, 159, 220, 1, edge).fill(40, 40, 1, 120, edge).fill(259, 40, 1, 120, edge);
  px.fill(70, 70, 60, 10, INK);
  const { box } = trimBlank(px, [0, 0, 300, 200], null);
  assert.deepEqual(box, [28, 28, 244, 144], 'the frame ends 12px outside the border, not at the text inside it');
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
  assert.equal(box[1], 28, 'the top edge stops 12px outside the rule');
});

// A header row 400px wide: hairlines across its whole width at rows 10 and 69, its content on the left 55%.
const DIVIDER = [200, 200, 200];
const headerRow = () => canvas(400, 80).fill(0, 10, 400, 1, DIVIDER).fill(0, 69, 400, 1, DIVIDER).fill(20, 30, 200, 20, INK);

test('the side trims cross the dead space over hairlines that run out to the frame edge', () => {
  const { box, trimmed } = trimBlank(headerRow(), [0, 0, 400, 80], null);
  assert.deepEqual(trimmed, { left: 8, top: 0, right: 168, bottom: 0 }, 'each side stops 12px outside the content');
  assert.deepEqual(box, [8, 0, 224, 80]);
});

test('a card border parallel to the trimmed side still stops it there', () => {
  const px = headerRow().fill(380, 0, 1, 80, DIVIDER);
  const { box, trimmed } = trimBlank(px, [0, 0, 400, 80], null);
  assert.equal(trimmed.right, 7, 'the right edge stays 12px outside the border');
  assert.equal(box[0] + box[2], 393);
});

test('a hairline that ends short of the frame edge still stops the trim', () => {
  const px = canvas(400, 80).fill(250, 60, 120, 1, DIVIDER).fill(20, 30, 200, 20, INK);
  assert.equal(trimBlank(px, [0, 0, 400, 80], null).trimmed.right, 18, 'a rule ending 30px short of the edge stops the trim 12px outside it');
});

test('a band thicker than a rule running out to the edge is content, not a hairline', () => {
  const px = headerRow().fill(0, 60, 400, 4, DIVIDER);
  assert.equal(trimBlank(px, [0, 0, 400, 80], null).trimmed.right, 0);
});

test('a stroke that reaches the edge but runs in less than a rule length is content, not a hairline', () => {
  const px = headerRow().fill(390, 60, 10, 1, INK);
  assert.equal(trimBlank(px, [0, 0, 400, 80], null).trimmed.right, 0);
});

test('thin chart bars standing on the bottom edge are content, so the bottom does not trim', () => {
  const px = canvas(300, 200).fill(20, 20, 150, 14, INK);
  [50, 90, 120, 70, 110, 60, 100, 80, 40, 115].forEach((h, k) => px.fill(40 + k * 22, 200 - h, 2, h, [37, 99, 235]));
  assert.equal(trimBlank(px, [0, 0, 300, 200], null).trimmed.bottom, 0);
});

test('a progress track running out to the edge with its fill in the same rows does not trim, so the bar reads as full as it is', () => {
  const px = canvas(300, 120).fill(20, 40, 60, 10, INK).fill(20, 60, 280, 2, DIVIDER).fill(20, 60, 80, 2, [37, 99, 235]);
  assert.equal(trimBlank(px, [0, 0, 300, 120], null).trimmed.right, 0);
});

test('gridlines that stop short of the content beyond them are not hairlines across the frame', () => {
  const px = canvas(300, 200).fill(20, 20, 60, 10, INK);
  for (let x = 40; x < 300; x += 30) px.fill(x, 40, 1, 160, DIVIDER);
  px.fill(40, 120, 100, 3, [37, 99, 235]);
  assert.equal(trimBlank(px, [0, 0, 300, 200], null).trimmed.bottom, 0);
});

test('a hairline that starts at the far side content still crosses, as a row divider inset from the left does', () => {
  const px = canvas(400, 80).fill(30, 10, 370, 1, DIVIDER).fill(30, 69, 370, 1, DIVIDER).fill(30, 30, 190, 20, INK);
  assert.equal(trimBlank(px, [0, 0, 400, 80], null).trimmed.right, 168);
});

test('a trim never passes the marks, even over ground', () => {
  const px = canvas(300, 200).fill(100, 100, 40, 20, INK);
  const { box } = trimBlank(px, [0, 0, 300, 200], [20, 60, 30, 30]);
  assert.equal(box[0], 8, 'a mark box over ground keeps its side');
  assert.equal(box[1], 48);
});

// Ink squares 14px wide every 16px: no line crosses them clean, and no gap is wide enough to be a band or a word space.
function dense(width, height) {
  const px = canvas(width, height);
  for (let y = 0; y < height; y += 16) for (let x = 0; x < width; x += 16) px.fill(x, y, Math.min(14, width - x), Math.min(14, height - y), INK);
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
  assert.deepEqual(box, [86, 72, 412, 216]);
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


// Pixel replication: what a 2x capture of the same page looks like to the geometry.
function doubled(px) {
  const out = canvas(px.width * 2, px.height * 2);
  for (let y = 0; y < out.height; y += 1) {
    for (let x = 0; x < out.width; x += 1) {
      const from = ((y >> 1) * px.width + (x >> 1)) * 4;
      out.data.set(px.data.subarray(from, from + 4), (y * out.width + x) * 4);
    }
  }
  return out;
}
const times2 = (box) => box.map((n) => n * 2);

test('at scale 2 a lift grows to twice what it grows to at scale 1', () => {
  const px = canvas(200, 60).fill(45, 24, 55, 4, INK);
  const two = sandbox.__composeGeometry.withScale(2);
  const one = growBox(px, [40, 20, 30, 12], 96).box;
  assert.deepEqual([...two.growBox(doubled(px), times2([40, 20, 30, 12]), 192).box], times2(one));
});

test('at scale 2 a crop lands on twice the crop at scale 1', () => {
  const px = canvas(600, 400).fill(250, 180, 60, 12, INK);
  const two = sandbox.__composeGeometry.withScale(2);
  const one = cropToMarks(px, [0, 0, 600, 400], [250, 180, 60, 12]).box;
  assert.deepEqual([...two.cropToMarks(doubled(px), [0, 0, 1200, 800], times2([250, 180, 60, 12])).box], times2(one));
});

test('withScale(1) is the default geometry', () => {
  const px = canvas(200, 60).fill(45, 24, 55, 4, INK);
  assert.deepEqual([...sandbox.__composeGeometry.withScale(1).growBox(px, [40, 20, 30, 12], 96).box], growBox(px, [40, 20, 30, 12], 96).box);
});

// A rounded corner leaves off-colour arc pixels at each end of an edge line.
test('the corner trim covers 2px of arc at scale 1 and 5px at scale 2', () => {
  const arc = (rows) => canvas(100, 60).fill(40, 10 + rows, 30, 30 - 2 * rows, [37, 99, 235]);
  const box = [40, 10, 30, 30];
  const at = (scale) => sandbox.__composeGeometry.withScale(scale).edgeIsClean;
  assert.equal(at(1)(arc(2), box, 'left'), true);
  assert.equal(at(1)(arc(5), box, 'left'), false);
  assert.equal(at(2)(arc(5), box, 'left'), true);
  assert.equal(at(2)(arc(6), box, 'left'), false);
});

// One distance per test below: the same page at 1x and pixel-replicated at 2x must give the same answer.
const atScale = (scale) => sandbox.__composeGeometry.withScale(scale);
const twin = (px) => [px, doubled(px)];
const edgeAtBothScales = (px, box, side) => twin(px).map((p, i) => atScale(i + 1).edgeIsClean(p, i ? times2(box) : box, side));

// The extra source line a 2x edge takes is only taken where it is in reach.
const GROW_BOX_2X = [80, 40, 60, 24];
const inkTo205 = (width) => canvas(width, 100).fill(90, 48, 116, 8, INK);

test('at scale 2 a growing edge never ends past the image bound', () => {
  const [x, , w] = atScale(2).growBox(inkTo205(207), GROW_BOX_2X, 192).box;
  assert.equal(x + w, 207);
});

test('at scale 2 a growing edge never ends inside an avoid box', () => {
  const [x, , w] = atScale(2).growBox(inkTo205(300), GROW_BOX_2X, 192, { avoid: [[207, 0, 20, 100]] }).box;
  assert.equal(x + w, 207);
});

test('at scale 2 a growing edge never grows past its limit', () => {
  const [x, , w] = atScale(2).growBox(inkTo205(300), GROW_BOX_2X, 67).box;
  assert.equal(x + w - 140, 67);
});

test('at scale 2 the lift band still rejects a 2px word gap (LIFT_BAND)', () => {
  const px = canvas(120, 60).fill(45, 24, 10, 4, INK).fill(57, 24, 10, 4, INK);
  const one = atScale(1).growBox(px, [40, 20, 12, 12], 96, { band: atScale(1).LIFT_BAND }).box;
  const two = atScale(2).growBox(doubled(px), times2([40, 20, 12, 12]), 192, { band: atScale(2).LIFT_BAND }).box;
  assert.ok(one[0] + one[2] >= 68, 'at 1x the right edge clears both words, not the 2px gap');
  assert.deepEqual([...two], times2([...one]));
});

test('at scale 2 clusters join boxes 24px apart and split boxes 26px apart (CLUSTER_GAP)', () => {
  const row = (scale, gap) => [...atScale(scale).clusterBoxes([[0, 0, 80 * scale, 20 * scale], [(80 + gap) * scale, 0, 80 * scale, 20 * scale]])].map((c) => [...c]);
  for (const scale of [1, 2]) {
    assert.deepEqual(row(scale, 12), [[0, 1]], `a 12px gap joins at scale ${scale}`);
    assert.deepEqual(row(scale, 13), [[0], [1]], `a 13px gap splits at scale ${scale}`);
  }
});

test('at scale 2 an outward frame edge reaches 192px (FRAME_REACH)', () => {
  const px = canvas(600, 400).fill(100, 60, 200, 110, INK);
  const frame = [0, 150, 600, 200]; const marks = [200, 155, 40, 20];
  const one = atScale(1).cleanFrame(px, frame, marks);
  const two = atScale(2).cleanFrame(doubled(px), times2(frame), times2(marks));
  assert.equal(one.edges.top, 'outward');
  assert.equal(two.edges.top, 'outward', 'the 182px band is within reach at scale 2');
});

test('at scale 2 an inward frame edge lands 4px inside its band (FRAME_CUSHION)', () => {
  const px = canvas(600, 400).fill(100, 100, 200, 10, INK);
  const frame = [0, 100, 600, 250]; const marks = [200, 200, 40, 20];
  const one = atScale(1).cleanFrame(px, frame, marks);
  const two = atScale(2).cleanFrame(doubled(px), times2(frame), times2(marks));
  assert.deepEqual([...one.frame], [0, 112, 600, 238]);
  assert.deepEqual([...two.frame], times2([...one.frame]));
});

test('at scale 2 a 2px rule is a rule and a 3px bar is content (RULE_THICKNESS)', () => {
  const box = [100, 10, 60, 80];
  assert.deepEqual(edgeAtBothScales(canvas(300, 100).fill(20, 40, 260, 2, GREY), box, 'left'), [true, true]);
  assert.deepEqual(edgeAtBothScales(canvas(300, 100).fill(20, 40, 260, 3, GREY), box, 'left'), [false, false]);
});

test('at scale 2 a rule must hold its colour 96px across the line, as 48px at scale 1 (RULE_LENGTH)', () => {
  const box = [100, 10, 60, 80];
  assert.deepEqual(edgeAtBothScales(canvas(300, 100).fill(77, 40, 48, 2, GREY), box, 'left'), [false, false]);
  assert.deepEqual(edgeAtBothScales(canvas(300, 100).fill(76, 40, 49, 2, GREY), box, 'left'), [true, true]);
});

// The same page at 1x, and pixel-replicated at 2x, must give the same answer in board terms:
// a distance in capture pixels doubles, one in board pixels does not.
const cropAt = (scale, px, frame, marks, options) => {
  const result = atScale(scale).cropToMarks(px, frame, marks, options);
  return { box: [...result.box], edges: result.edges && { ...result.edges }, cut: result.cut };
};
const cropTwice = (px, frame, marks, options) => {
  const parts = options && options.parts;
  const two = parts ? { ...options, parts: parts.map((part) => ({ ...part, box: times2(part.box) })) } : options;
  return [cropAt(1, px, frame, marks, options), cropAt(2, doubled(px), times2(frame), times2(marks), two)];
};
const sameCropTwice = (px, frame, marks, options) => {
  const [one, two] = cropTwice(px, frame, marks, options);
  assert.deepEqual(two.box, times2(one.box));
  assert.deepEqual(two.edges, one.edges);
  assert.equal(two.cut, one.cut);
  return one;
};

test('at scale 2 a gap of 5px between letters is not a band, as at scale 1 (BAND)', () => {
  const px = canvas(240, 60);
  for (let x = 45; x < 80; x += 9) px.fill(x, 24, 4, 4, INK);
  const box = [40, 20, 16, 12];
  const one = atScale(1).growBox(px, box, 96).box;
  const two = atScale(2).growBox(doubled(px), times2(box), 192).box;
  assert.deepEqual([...one], [40, 20, 37, 12], 'at 1x the 5px gaps are crossed and the edge stops past the last letter');
  assert.deepEqual([...two], times2([...one]));
});

test('at scale 2 a crop edge snaps to a band 57px away, as at scale 1 (CROP_SNAP)', () => {
  const px = canvas(600, 400).fill(255, 150, 106, 10, INK);
  const one = sameCropTwice(px, [0, 0, 600, 400], [200, 150, 40, 20]);
  assert.deepEqual(one.box, [136, 102, 237, 116], 'at 1x the right edge snaps to the band past the text');
});

test('at scale 2 an inward frame edge stops 16px short of the marks (FRAME_MARGIN)', () => {
  const px = canvas(600, 400).fill(100, 100, 200, 10, INK);
  const edgeFor = (marks) => [atScale(1).cleanFrame(px, [0, 100, 600, 250], marks).edges.top,
    atScale(2).cleanFrame(doubled(px), times2([0, 100, 600, 250]), times2(marks)).edges.top];
  assert.deepEqual(edgeFor([200, 128, 40, 20]), ['inward', 'inward'], 'an edge 16px above the marks is allowed');
  assert.deepEqual(edgeFor([200, 127, 40, 20]), ['outward', 'outward'], 'an edge 15px above the marks is refused');
});

test('at scale 2 a snapped crop edge backs away 24 lines from text, as 12 at scale 1 (CROP_AIR)', () => {
  const left = sameCropTwice(canvas(600, 400).fill(201, 180, 80, 60, INK), [0, 0, 600, 400], [300, 200, 40, 20]);
  assert.equal(left.box[0], 189);
  const bottom = sameCropTwice(canvas(600, 400).fill(250, 150, 60, 30, INK), [0, 0, 600, 400], [260, 100, 40, 20]);
  assert.equal(bottom.box[1] + bottom.box[3], 192);
});

test('at scale 2 the context floor is 640 by 400, as 320 by 200 at scale 1 (CROP_MIN_W, CROP_MIN_H)', () => {
  const one = sameCropTwice(canvas(800, 600), [0, 0, 800, 600], [380, 290, 40, 20], { floor: true });
  assert.deepEqual(one.box, [240, 200, 320, 200]);
  const tall = sameCropTwice(canvas(1000, 800), [0, 0, 1000, 800], [300, 300, 300, 20], { floor: true });
  assert.deepEqual(tall.box, [236, 210, 428, 200]);
});

test('at scale 2 a bracket group crops 32 capture px beyond its rows, as 16 at scale 1 (CROP_MARGIN_TIGHT)', () => {
  const rows = rowsOfText(canvas(600, 600), Array.from({ length: 16 }, (_, i) => rowAt(i)));
  const frame = [0, 0, 600, 600];
  const tight = sameCropTwice(rows, frame, groupBox, { parts: [{ box: groupBox, bracket: true }] });
  assert.ok(tight.box[1] + tight.box[3] > rowAt(12) + 10 && tight.box[1] + tight.box[3] <= rowAt(13));
  const lift = [100, GROUP[1] - 10, 60, 10];
  sameCropTwice(rows, frame, groupBox, { parts: [{ box: groupBox, bracket: true }, { box: lift, bracket: false }] });
});

test('at scale 2 a trim keeps 24 capture px of ground outside the first content, as 12 at scale 1 (TRIM_PAD)', () => {
  const frame = [0, 0, 300, 200];
  const px = card(300, 200, [30, 30], [240, 140]);
  const one = trimBlank(px, frame, null);
  const two = atScale(2).trimBlank(doubled(px), times2(frame), null);
  assert.deepEqual(one.box, [18, 18, 264, 164]);
  assert.deepEqual([...two.box], times2(one.box));
  assert.deepEqual({ ...two.trimmed }, { left: 36, top: 36, right: 36, bottom: 36 });
});

test('at scale 2 a trim crosses hairlines that run out to the frame edge, as at scale 1', () => {
  const frame = [0, 0, 400, 80];
  const one = trimBlank(headerRow(), frame, null);
  const two = atScale(2).trimBlank(doubled(headerRow()), times2(frame), null);
  assert.deepEqual([...two.box], times2(one.box));
  assert.equal(two.trimmed.right, 336);
});

test('at scale 2 a trim stops 24 capture px short of the marks, as 12 at scale 1 (TRIM_PAD)', () => {
  const frame = [0, 0, 300, 200]; const marks = [20, 60, 30, 30];
  const px = canvas(300, 200).fill(100, 100, 40, 20, INK);
  const one = trimBlank(px, frame, marks);
  const two = atScale(2).trimBlank(doubled(px), times2(frame), times2(marks));
  assert.deepEqual(one.box.slice(0, 2), [8, 48]);
  assert.deepEqual([...two.box], times2(one.box));
});

test('at scale 2 padding keeps 6 capture px of ground beside its neighbour, as 3 at scale 1 (LIFT_CLEAR)', () => {
  const px = canvas(160, 120).fill(36, 54, 4, 4, INK);
  const one = cleanPad(px, [50, 50, 12, 12], 12);
  const two = atScale(2).cleanPad(doubled(px), times2([50, 50, 12, 12]), 24);
  assert.deepEqual(one, [7, 12, 12, 12]);
  assert.deepEqual([...two], times2(one));
});

// The card and the element are in board px, so the same board picture has S = 1 at 1x and S = 1/2 at 2x:
// a block of n pixels at 1x is 4n pixels, and the margin LIFT_CLEAR reaches 6 capture px, not 3.
test('at scale 2 content under a card counts 4 times the pixels, over the same board distance (LIFT_CLEAR)', () => {
  const px = canvas(200, 100).fill(64, 40, 4, 4, INK);
  const hiddenOne = contentUnder(px, [0, 0, 200, 100], 1, ELEMENT);
  const hiddenTwo = atScale(2).contentUnder(doubled(px), [0, 0, 400, 200], 0.5, ELEMENT);
  for (const [left, count] of [[70, 16], [73, 4], [74, 0]]) {
    assert.equal(hiddenOne([left, 30, 40, 30]), count);
    assert.equal(hiddenTwo([left, 30, 40, 30]), 4 * count, `a card at ${left}`);
  }
});

// A card's edge is seldom on a pixel line. One that reaches 0.3 of a CSS px into a line takes that whole px by the
// 1x count, and half of it by a count of the 2x capture's own pixels.
test('at scale 2 a card whose edge falls within a CSS px hides and covers what its 1x twin does', () => {
  const px = canvas(200, 100).fill(40, 20, 120, 8, INK);
  const hidden = [contentUnder(px, [0, 0, 200, 100], 1, ELEMENT), atScale(2).contentUnder(doubled(px), [0, 0, 400, 200], 0.5, ELEMENT)];
  const covered = [contentUnder(px, [0, 0, 200, 100], 1, ELEMENT, -0.5), atScale(2).contentUnder(doubled(px), [0, 0, 400, 200], 0.5, ELEMENT, -1)];
  for (const top of [30.7, 30.4, 29.8]) {
    const card = [70, top, 40, 30];
    assert.ok(hidden[0](card) > 0, `a card at ${top} hides some of the line`);
    assert.equal(hidden[1](card), 4 * hidden[0](card), `hidden by a card at ${top}`);
    assert.equal(covered[1](card), 4 * covered[0](card), `covered by a card at ${top}`);
  }
  assert.equal(covered[0]([70, 30.7, 40, 30]), 0, 'a ring 0.3 px into the line covers no pixel by its centre');
  assert.equal(covered[0]([70, 30.4, 40, 30]), 46, 'and one 0.6 px into it covers a row');
});

test('at scale 2 a lift keeps clear of a block the same board distance away (LIFT_CLEAR)', () => {
  const px = canvas(200, 100).fill(60, 30, 5, 40, INK);
  const one = liftSpot(contentUnder(px, [0, 0, 200, 100], 1, ELEMENT), [200, 100], ELEMENT, [40, 30]);
  const two = atScale(2).liftSpot(atScale(2).contentUnder(doubled(px), [0, 0, 400, 200], 0.5, ELEMENT), [200, 100], ELEMENT, [40, 30]);
  assert.deepEqual({ L: two.L, T: two.T, clamped: two.clamped }, one);
  assert.ok(one.L > 70, 'the block 5px from the centred card is inside its margin, so the card moves away');
});

test('at scale 2 a rule keeps 8 capture px on its shorter side, as 4 at scale 1 (RULE_MIN_SIDE)', () => {
  const bottom = (below) => edgeAtBothScales(canvas(200, 200).fill(100, 40, 1, 98 + below, [200, 200, 200]), [20, 20, 160, 118], 'bottom');
  assert.deepEqual(bottom(3), [false, false], '3px below the line');
  assert.deepEqual(bottom(4), [true, true], '4px below the line');
});

test('liftSpot parts spots its first rank ties by the next, before the nearest to centred', () => {
  const nearer = ([L]) => Math.abs(L - 65);
  assert.equal(liftSpot(() => 0, [200, 100], ELEMENT, [40, 30]).L, 70);
  assert.equal(liftSpot([() => 0, nearer], [200, 100], ELEMENT, [40, 30]).L, 65);
});

// A card's face is the card less its ring: `clear` takes the ring back off the margin.
test('an exact count takes the part of each pixel a card covers, at 1x and at 2x alike', () => {
  const px = canvas(200, 100).fill(40, 20, 120, 8, INK);
  const face = [contentUnder(px, [0, 0, 200, 100], 1, ELEMENT, -3, true), atScale(2).contentUnder(doubled(px), [0, 0, 400, 200], 0.5, ELEMENT, -6, true)];
  const card = [70, 27.7, 40, 30];
  assert.ok(Math.abs(face[0](card) - 0.3 * 40) < 1e-9, `a card 0.3 px into the line covers ${face[0](card)} of it`);
  assert.ok(Math.abs(face[1](card) - 4 * face[0](card)) < 1e-9, 'and its 2x twin four times as many capture px');
  assert.equal(contentUnder(px, [0, 0, 200, 100], 1, ELEMENT, -3)(card), 40, 'where a whole count takes the row');
});

test('liftSpot never takes a row whole under its card to move another out of its margin', () => {
  // A 22 px card for a 10 px element between rows 18 px apart covers some of both, or one whole at either end.
  const px = canvas(200, 100).fill(40, 30, 120, 6, INK).fill(40, 54, 120, 6, INK);
  const hidden = contentUnder(px, [0, 0, 200, 100], 1, ELEMENT);
  const face = contentUnder(px, [0, 0, 200, 100], 1, ELEMENT, -3, true);
  const size = [40, 22];
  const loose = liftSpot(hidden, [200, 100], ELEMENT, size);
  assert.ok([28, 40].includes(loose.T), `by its margin alone the card takes a row whole (top ${loose.T})`);
  const held = liftSpot(hidden, [200, 100], ELEMENT, size, face);
  assert.ok(face([held.L, held.T, ...size]) <= face([70, 34, ...size]), `the card at top ${held.T} hides no more under it than a centred one`);
});

test('liftSpot keeps a card its ring and 2 px inside the frame', () => {
  const nothing = () => 0;
  // element at x 3..43 in a 200 px room, card 60 wide: it must start at 5 or later to keep the ring inside
  const spot = liftSpot(nothing, [200, 100], [3, 40, 40, 20], [60, 30]);
  assert.ok(spot.L >= 5 - 1e-9, `card starts at ${spot.L}`);
  assert.equal(spot.clamped, true, 'the element sits nearer the edge than a card may');
});

test('liftSpot leaves room for a dot on the right and the bottom while the element allows', () => {
  // element ends 30 px from the right edge and 30 from the bottom; a card 20 px larger each way could reach both edges,
  // and this measure prefers exactly that
  const towardsEdge = ([L, T]) => 1000 - L - T;
  const spot = liftSpot(towardsEdge, [200, 100], [130, 50, 40, 20], [60, 40]);
  assert.ok(spot.L + 60 <= 200 - 16 + 1e-9, 'right edge keeps 16');
  assert.ok(spot.T + 40 <= 100 - 16 + 1e-9, 'bottom edge keeps 16');
});

test('liftSpot gives the dot room up when the element itself sits nearer the edge', () => {
  const spot = liftSpot(() => 0, [200, 100], [150, 40, 44, 20], [50, 26]);
  assert.ok(spot.L + 50 >= 194 - 1e-9, 'the card still covers its element');
  assert.ok(spot.L + 50 <= 200 - 5 + 1e-9, 'and keeps its ring inside');
});

test('liftSpot keeps the dot room only when it leaves the card a board px to move', () => {
  // the element ends 16.2 px above the frame bottom, then 17.2: the room would hold the first card to 0.2 px of travel
  const hangs = (bottom) => liftSpot((card) => Math.max(0, 60 - card[1]), [200, 100], [40, 60, 60, 100 - bottom - 60], [70, (100 - bottom - 60) + 4]).T;
  assert.equal(hangs(16.2), 60, 'the card is free to hang from the top of its element');
  assert.ok(hangs(17.2) < 60, 'with a px to move it stays clear of the dot room');
});

const { tightenBox, adoptLeading } = sandbox.__composeGeometry;
const tight = (...args) => { const { box, moved } = tightenBox(...args); return { box: [...box], moved: { ...moved } }; };
const RULE = [229, 231, 235];

test('tightenBox shrinks a full-width row to its words', () => {
  const px = canvas(400, 100).fill(40, 44, 90, 12, INK);
  assert.deepEqual(tight(px, [20, 40, 360, 20]).box, [40, 44, 90, 12]);
});

test('tightenBox drops a divider on one edge and keeps the words', () => {
  const px = canvas(400, 100).fill(40, 44, 90, 12, INK).fill(20, 59, 360, 1, RULE);
  assert.deepEqual(tight(px, [20, 40, 360, 20]).box, [40, 44, 90, 12]);
});

test('tightenBox keeps a border that turns a corner, and the padding inside it', () => {
  const px = canvas(400, 100);
  px.fill(20, 40, 200, 1, RULE).fill(20, 69, 200, 1, RULE).fill(20, 40, 1, 30, RULE).fill(219, 40, 1, 30, RULE).fill(40, 50, 60, 10, INK);
  assert.deepEqual(tight(px, [20, 40, 200, 30]).box, [20, 40, 200, 30]);
});

test('tightenBox keeps the padding of an element with its own background', () => {
  const px = canvas(400, 100).fill(40, 40, 80, 24, [219, 234, 254]).fill(52, 47, 40, 10, INK);
  assert.deepEqual(tight(px, [40, 40, 80, 24]).box, [40, 40, 80, 24]);
});

test('tightenBox keeps a thick accent border', () => {
  const px = canvas(400, 100).fill(40, 40, 4, 24, [79, 70, 229]).fill(60, 46, 80, 12, INK);
  const { box } = tight(px, [40, 40, 300, 24]);
  assert.equal(box[0], 40, 'the left edge stays on the accent');
  assert.equal(box[0] + box[2], 140, 'the right edge comes in to the words');
});

test('tightenBox keeps the fraction of a side that stays', () => {
  const px = canvas(400, 100).fill(40, 40, 4, 24, [79, 70, 229]).fill(60, 46, 80, 12, INK);
  const { box, moved } = tight(px, [40, 40.5, 300, 23.25]);
  assert.deepEqual(moved, { left: 0, top: 0, right: 200, bottom: 0 });
  assert.deepEqual(box, [40, 40.5, 100, 23.25], 'top and bottom stay where the element put them, not on the pixel grid');
});

test('tightenBox leaves a box with nothing in it alone', () => {
  const px = canvas(400, 100);
  assert.deepEqual(tight(px, [20, 40, 360, 20]).box, [20, 40, 360, 20]);
});

test('cleanPad stops before a hairline', () => {
  const px = canvas(400, 100).fill(40, 44, 90, 12, INK).fill(20, 59, 360, 1, RULE);
  const [, , , bottom] = cleanPad(px, [40, 44, 90, 12], 4, {});
  assert.equal(bottom, 2, 'two lines of ground, then the line before the rule');
});

test('adoptLeading takes a tick that leads the line', () => {
  const px = canvas(400, 100).fill(60, 44, 90, 12, INK).fill(40, 44, 12, 12, [22, 163, 74]);
  assert.deepEqual([...adoptLeading(px, [60, 44, 90, 12], {})], [40, 44, 110, 12]);
});

test('adoptLeading leaves the word before a word space, a wide neighbour, and a taller thing alone', () => {
  const word = canvas(400, 100).fill(60, 44, 90, 12, INK).fill(44, 44, 12, 12, INK);
  assert.deepEqual([...adoptLeading(word, [60, 44, 90, 12], {})], [60, 44, 90, 12], 'a 4 px gap is a word space');
  const wide = canvas(400, 100).fill(100, 44, 90, 12, INK).fill(50, 44, 42, 12, INK);
  assert.deepEqual([...adoptLeading(wide, [100, 44, 90, 12], {})], [100, 44, 90, 12], 'wider than an icon');
  const tall = canvas(400, 100).fill(60, 44, 90, 12, INK).fill(40, 30, 12, 40, INK);
  assert.deepEqual([...adoptLeading(tall, [60, 44, 90, 12], {})], [60, 44, 90, 12], 'taller than the line');
});

test('adoptLeading never takes a box it was told to avoid', () => {
  const px = canvas(400, 100).fill(60, 44, 90, 12, INK).fill(40, 44, 12, 12, INK);
  assert.deepEqual([...adoptLeading(px, [60, 44, 90, 12], { avoid: [[38, 42, 16, 16]] })], [60, 44, 90, 12]);
});

test('tightenBox shrinks a row that lies under the divider of the row above', () => {
  const px = canvas(400, 100).fill(40, 44, 90, 12, INK).fill(20, 39, 360, 1, RULE);
  assert.deepEqual(tight(px, [20, 40, 360, 20]).box, [40, 44, 90, 12]);
});

test('tightenBox keeps a faint background of its own', () => {
  const px = canvas(400, 100).fill(40, 40, 80, 24, [243, 244, 246]).fill(52, 47, 40, 10, INK);
  assert.deepEqual(tight(px, [40, 40, 80, 24]).box, [40, 40, 80, 24]);
});

test('tightenBox takes its ground from outside the box, so a block of one colour is content', () => {
  const px = canvas(600, 100).fill(40, 40, 80, 14, INK).fill(128, 40, 156, 14, [17, 24, 39]);
  assert.deepEqual(tight(px, [40, 40, 500, 14]).box, [40, 40, 244, 14], 'the right edge stops at the block; the bar on the left edge stays');
});

test('tightenBox leaves the sides beside an edge that content runs on past', () => {
  const px = canvas(400, 100).fill(40, 40, 120, 10, INK);
  assert.deepEqual(tight(px, [30, 35, 60, 20]).box, [40, 35, 50, 20], 'the bar is cut on the right: top and bottom stay, so the cut still shows');
  assert.deepEqual(growBox(px, tight(px, [30, 35, 60, 20]).box, 96, { band: LIFT_BAND }).box, [39, 35, 122, 20]);
  const whole = canvas(400, 100).fill(40, 40, 50, 10, INK).fill(90, 44, 1, 2, [120, 120, 120]);
  assert.deepEqual(tight(whole, [30, 35, 60, 20]).box, [40, 40, 50, 10], 'a pixel of overhang is not content running on');
});

test('tightenBox at the image edge takes the ground the other sides found, and keeps a background that has none', () => {
  const row = canvas(400, 100).fill(40, 44, 90, 12, INK);
  assert.deepEqual(tight(row, [0, 40, 400, 20]).box, [40, 44, 90, 12]);
  const banner = canvas(400, 100).fill(0, 40, 200, 24, [219, 234, 254]).fill(20, 47, 40, 10, INK);
  assert.deepEqual(tight(banner, [0, 40, 200, 24]).box, [0, 40, 200, 24]);
});

test('tightenBox never moves in past a fill it was told to keep', () => {
  const FILL = [17, 24, 39];
  const px = canvas(400, 100).fill(40, 44, 60, 12, INK).fill(108, 40, 94, 20, FILL);
  assert.deepEqual(tight(px, [20, 40, 180, 20]).box, [40, 40, 68, 20], 'the fill runs past the right edge, so alone it reads as ground there');
  assert.deepEqual(tight(px, [20, 40, 180, 20], { keep: [[108, 40, 94, 20]] }).box, [40, 40, 160, 20], 'kept, the box still holds the fill');
  const grown = canvas(400, 100).fill(40, 44, 60, 12, INK).fill(106, 38, 98, 24, FILL);
  assert.deepEqual(tight(grown, [20, 40, 180, 20], { keep: [[108, 40, 94, 20]], ignore: [[106, 38, 98, 24]] }).box, [40, 40, 160, 20],
    'a fill drawn past the box on three sides is not content running on: the left still shrinks, and the fill holds the rest');
});

test('tightenBox is free of a fill that only grazes the box with its margin', () => {
  const px = canvas(400, 100).fill(40, 44, 90, 12, INK).fill(18, 58, 364, 24, [17, 24, 39]);
  assert.deepEqual(tight(px, [20, 40, 360, 20], { keep: [[20, 60, 360, 20]], ignore: [[18, 58, 364, 24]] }).box, [40, 44, 90, 12], 'the redaction is the row below');
  assert.deepEqual(tight(px, [20, 40, 360, 20]).box, [40, 44, 90, 14], 'unread, the margin is a block on the bottom edge');
});

test('cleanPad reads a hairline through an ignored fill as it reads a clean line', () => {
  const px = canvas(400, 100).fill(38, 42, 94, 16, [17, 24, 39]);
  assert.deepEqual(cleanPad(px, [40, 44, 90, 12], 4, { ignore: [[38, 42, 94, 16]] }), [4, 4, 4, 4]);
});

const TICK = [22, 163, 74];

test('adoptLeading takes an icon as tall as the element the box was tightened from', () => {
  const px = canvas(400, 100).fill(60, 46, 90, 9, INK).fill(40, 43, 14, 14, TICK);
  assert.deepEqual([...adoptLeading(px, [60, 46, 90, 9], {})], [60, 46, 90, 9], 'taller than the words alone');
  assert.deepEqual([...adoptLeading(px, [60, 46, 90, 9], { element: [60, 42, 300, 16] })], [40, 43, 110, 14], 'the box takes the icon whole');
  assert.deepEqual([...adoptLeading(px, [60, 46, 90, 9], { element: [60, 44, 300, 12] })], [60, 46, 90, 9], 'taller than the element');
});

test('adoptLeading leaves a short word that stands a word space from the word before it', () => {
  const px = canvas(400, 100).fill(60, 44, 90, 12, INK).fill(40, 44, 14, 12, INK).fill(8, 44, 26, 12, INK);
  assert.deepEqual([...adoptLeading(px, [60, 44, 90, 12], {})], [60, 44, 90, 12], '6 px before it, 6 px after it');
  const led = canvas(400, 100).fill(60, 44, 90, 12, INK).fill(40, 44, 14, 12, INK).fill(8, 44, 23, 12, INK);
  assert.deepEqual([...adoptLeading(led, [60, 44, 90, 12], {})], [40, 44, 110, 12], '9 px of ground beyond a 6 px gap');
});

test('adoptLeading takes an icon that stands at the edge of its bounds', () => {
  const px = canvas(400, 100).fill(60, 44, 90, 12, INK).fill(40, 44, 12, 12, TICK);
  assert.deepEqual([...adoptLeading(px, [60, 44, 90, 12], { bounds: [38, 0, 362, 100] })], [40, 44, 110, 12]);
  assert.deepEqual([...adoptLeading(px, [60, 44, 90, 12], { bounds: [44, 0, 356, 100] })], [60, 44, 90, 12], 'cut by the bounds');
});

const rulesAcross = (...args) => [...sandbox.__composeGeometry.rulesAcross(...args)];

test('rulesAcross names the rows of a divider the rect crosses, and nothing shorter or thicker', () => {
  const px = canvas(400, 200).fill(20, 60, 360, 1, RULE).fill(20, 90, 360, 2, RULE).fill(20, 120, 360, 3, RULE).fill(196, 150, 16, 1, INK);
  assert.deepEqual(rulesAcross(px, [200, 40, 210, 180]), [60, 90, 91], 'a 3 px band is a block and a 16 px dash is a glyph');
  assert.deepEqual(rulesAcross(px, [200, 91, 210, 180]), [91], 'a rect that starts inside a rule still reads it whole');
  const stub = canvas(400, 200).fill(20, 60, 200, 1, RULE);
  assert.deepEqual(rulesAcross(stub, [200, 40, 210, 180]), [], 'a rule that ends beside the rect is not one it crosses');
  assert.deepEqual(rulesAcross(stub, [200, 40, 210, 180], [0, 0, 220, 200]), [60], 'unless the bounds end there too');
  const border = canvas(400, 200).fill(300, 20, 1, 160, RULE).fill(20, 60, 360, 1, RULE);
  assert.deepEqual(rulesAcross(border, [280, 90, 320, 96], null, true), [300], 'upright, a border the rect crosses is a column of it');
  assert.deepEqual(rulesAcross(border, [280, 90, 320, 96]), [], 'and no row');
});

test('at scale 2 tightening, a hairline pad stop and a leading icon give the 1x answers doubled (RULE_THICKNESS, TIGHT_MIN, ADOPT_*)', () => {
  const row = canvas(400, 100).fill(60, 44, 90, 12, INK).fill(20, 59, 360, 1, RULE).fill(40, 44, 12, 12, [22, 163, 74]);
  const twoRow = doubled(row);
  assert.deepEqual([...atScale(2).tightenBox(twoRow, times2([20, 40, 360, 20])).box], times2(tight(row, [20, 40, 360, 20]).box));
  assert.deepEqual([...atScale(2).cleanPad(twoRow, times2([60, 44, 90, 12]), 8)], [...cleanPad(row, [60, 44, 90, 12], 4)].map((n) => n * 2));
  assert.deepEqual([...adoptLeading(row, [60, 44, 90, 12], {})], [40, 44, 110, 12]);
  assert.deepEqual([...atScale(2).adoptLeading(twoRow, times2([60, 44, 90, 12]), {})], times2([40, 44, 110, 12]));
  const half = doubled(canvas(400, 100).fill(40, 44, 90, 12, INK)).fill(79, 87, 182, 1, INK).fill(79, 87, 1, 26, INK).fill(260, 87, 1, 26, INK).fill(79, 112, 182, 1, INK);
  assert.deepEqual([...atScale(2).tightenBox(half, times2([20, 40, 360, 20])).box], [78, 86, 184, 28], 'half a CSS px of ink on each side takes the whole CSS px, as its 1x twin would');
  const tick = doubled(canvas(400, 100).fill(60, 44, 90, 12, INK).fill(40, 44, 12, 12, TICK)).fill(79, 87, 25, 1, TICK).fill(79, 87, 1, 25, TICK);
  assert.deepEqual([...atScale(2).adoptLeading(tick, times2([60, 44, 90, 12]), { element: times2([60, 42, 90, 16]) })], [78, 86, 222, 26]);
  const lines = canvas(400, 200).fill(20, 60, 360, 1, RULE).fill(20, 90, 360, 2, RULE).fill(20, 120, 360, 3, RULE);
  assert.deepEqual([...atScale(2).rulesAcross(doubled(lines), times2([200, 40, 210, 180]))], [120, 121, 180, 181, 182, 183]);
});

const contentBox = (...args) => [...sandbox.__composeGeometry.contentBox(...args)];

test('contentBox is the box less the full lines of ground at its edges', () => {
  const px = canvas(300, 100).fill(50, 46, 80, 10, INK);
  assert.deepEqual(contentBox(px, [40, 40, 120, 22]), [50, 46, 80, 10]);
});

test('contentBox keeps a blank box whole', () => {
  assert.deepEqual(contentBox(canvas(300, 100), [40, 40, 120, 22]), [40, 40, 120, 22]);
});

test('contentBox does not shrink past a single faint pixel', () => {
  const px = canvas(300, 100).fill(50, 46, 80, 10, INK).fill(41, 41, 1, 1, [240, 240, 240]);
  const box = contentBox(px, [40, 40, 120, 22]);
  assert.ok(box[0] <= 41 && box[1] <= 41, 'the faint pixel stays inside');
});

test('every pixel contentBox leaves out lies on a full line of one colour', () => {
  const px = canvas(300, 100, [250, 250, 250]).fill(60, 44, 40, 14, INK).fill(120, 50, 30, 4, [200, 30, 30]);
  const outer = [40, 40, 140, 24]; const [x, y, w, h] = contentBox(px, outer);
  for (let yy = outer[1]; yy < outer[1] + outer[3]; yy += 1) for (let xx = outer[0]; xx < outer[0] + outer[2]; xx += 1) {
    if (xx >= x && xx < x + w && yy >= y && yy < y + h) continue;
    const at = (yy * px.width + xx) * 4;
    assert.ok(px.data[at] >= 242, `pixel ${xx},${yy} outside the content box is not ground`);
  }
});

test('contentBox keeps a box whole when the ground runs from its two sides meet', () => {
  // each end column is within 8 of the middle but not of the other end, and one faint pixel keeps the rows from being one colour throughout
  const px = canvas(300, 100, [240, 240, 240]).fill(40, 40, 1, 22, [245, 245, 245]).fill(159, 40, 1, 22, [235, 235, 235]).fill(40, 50, 1, 1, [252, 252, 252]);
  const box = contentBox(px, [40, 40, 120, 22]);
  assert.deepEqual(box, [40, 40, 120, 22], `a box with nothing to find came back ${box}`);
});

const edgeSliver = (...args) => [...sandbox.__composeGeometry.edgeSliver(...args)];
const edgeAir = (...args) => Object.fromEntries(Object.entries(sandbox.__composeGeometry.edgeAir(...args)).map(([side, { have, ground }]) => [side, { have, ground: ground && [...ground] }]));
const BORDER = [203, 213, 225];

test('edgeSliver takes a border off every side it lies on', () => {
  const px = canvas(300, 200);
  px.fill(20, 20, 200, 1, BORDER).fill(20, 119, 200, 1, BORDER).fill(20, 20, 1, 100, BORDER).fill(219, 20, 1, 100, BORDER).fill(40, 50, 80, 12, INK);
  assert.deepEqual(edgeSliver(px, [20, 20, 200, 100], null), [21, 21, 198, 98]);
});

test('edgeSliver takes a strip of the page behind a card and the border after it', () => {
  const px = canvas(300, 200, [241, 245, 249]).fill(24, 0, 276, 200, [255, 255, 255]).fill(24, 0, 1, 200, BORDER).fill(60, 50, 80, 12, INK);
  assert.equal(edgeSliver(px, [20, 20, 200, 100], null)[0], 25);
});

test('edgeSliver leaves a band wider than a sliver, content at the edge, and the marks alone', () => {
  const header = canvas(300, 200).fill(20, 20, 200, 30, [30, 41, 59]).fill(40, 70, 80, 12, INK);
  assert.equal(edgeSliver(header, [20, 20, 200, 100], null)[1], 20, 'a 30 px header bar is not a sliver');
  const text = canvas(300, 200).fill(20, 50, 80, 12, INK);
  assert.equal(edgeSliver(text, [20, 20, 200, 100], null)[0], 20, 'content at the edge is not a sliver');
  const marked = canvas(300, 200).fill(20, 20, 1, 100, BORDER).fill(40, 50, 80, 12, INK);
  assert.equal(edgeSliver(marked, [20, 20, 200, 100], [20, 48, 100, 16])[0], 20, 'an edge never moves into the marks');
});

test('edgeSliver leaves the margin of content that stands on the ground at the edge', () => {
  const px = canvas(300, 200).fill(23, 50, 80, 12, INK);
  assert.deepEqual(edgeSliver(px, [20, 20, 200, 100], null), [20, 20, 200, 100]);
});

// The capture's own frame: a card with a 1 px border on a tinted page, and 12 px of that page all round it.
const PAGE = [241, 245, 249];
const padded = (radius = 0) => {
  const px = canvas(300, 200, PAGE).fill(32, 32, 176, 76, BORDER).fill(33, 33, 174, 74, [255, 255, 255]).fill(60, 60, 80, 12, INK);
  for (const [x, y] of [[32, 32], [208 - radius, 32], [32, 108 - radius], [208 - radius, 108 - radius]]) px.fill(x, y, radius, radius, PAGE);
  return px;
};

test('edgeSliver takes the strip of page the capture pads a frame with, and the border inside it, from all four sides', () => {
  assert.deepEqual(edgeSliver(padded(), [20, 20, 200, 100], null), [33, 33, 174, 74]);
});

// A white card with a 1 px border and round corners on the tinted page, drawn a pixel at a time by its centre.
const roundCard = (px, [x, y, w, h], radius) => {
  const within = (cx, cy, inset) => {
    const r = radius - inset; const [x0, y0, x1, y1] = [x + inset, y + inset, x + w - inset, y + h - inset];
    if (cx < x0 || cy < y0 || cx > x1 || cy > y1) return false;
    const dx = Math.max(x0 + r - cx, 0, cx - (x1 - r)); const dy = Math.max(y0 + r - cy, 0, cy - (y1 - r));
    return dx * dx + dy * dy <= r * r;
  };
  for (let j = y; j < y + h; j += 1) for (let i = x; i < x + w; i += 1) {
    if (within(i + 0.5, j + 0.5, 1)) px.fill(i, j, 1, 1, [255, 255, 255]); else if (within(i + 0.5, j + 0.5, 0)) px.fill(i, j, 1, 1, BORDER);
  }
  return px;
};
const CARD = [32, 32, 236, 116];
const cardFrame = [20, 20, 260, 140];
const oneColour = (px, [x, y, w, h]) => [[x, y, w, 1], [x, y + h - 1, w, 1], [x, y, 1, h], [x + w - 1, y, 1, h]].every(([lx, ly, lw, lh]) => {
  for (let j = ly; j < ly + lh; j += 1) for (let i = lx; i < lx + lw; i += 1) if (px.data[(j * px.width + i) * 4] !== 255 || px.data[(j * px.width + i) * 4 + 2] !== 255) return false;
  return true;
});

test('edgeSliver moves all four edges inside a card with round corners, past its border and its arcs', () => {
  const px = roundCard(canvas(320, 200, PAGE), CARD, 12).fill(70, 70, 80, 12, INK);
  const box = edgeSliver(px, cardFrame, null);
  assert.deepEqual(box, [36, 36, 228, 108], 'the 12 px strip and 4 px more: the border, and as far as the arc of a 12 px corner reaches');
  assert.ok(oneColour(px, box), "each of the four edge lines is the card's ground and nothing else");
  assert.deepEqual(edgeSliver(roundCard(canvas(320, 200, PAGE), CARD, 24).fill(70, 70, 80, 12, INK), cardFrame, null), [40, 40, 220, 100], 'a rounder corner takes the edges further in: the arc is found, not assumed');
});

test('edgeSliver leaves a round card whole when content stands flush inside its border on one side', () => {
  const px = roundCard(canvas(320, 200, PAGE), CARD, 12).fill(34, 70, 80, 12, INK);
  assert.deepEqual(edgeSliver(px, cardFrame, null), cardFrame, 'no edge moves: an outline on three sides is worse than one on four');
});

test('edgeSliver enters a round card only as far as the marks, a fill or an imported frame allow', () => {
  const px = roundCard(canvas(320, 200, PAGE), CARD, 12).fill(70, 70, 80, 12, INK);
  assert.deepEqual(edgeSliver(px, cardFrame, [35, 70, 80, 12]), cardFrame, 'a mark 3 px inside the border holds every edge');
  assert.deepEqual(edgeSliver(px, cardFrame, null, { fixed: true }), [36, 36, 228, 108], 'an imported frame may shrink onto 12 px of ground');
  const near = roundCard(canvas(320, 200, PAGE), CARD, 12).fill(45, 70, 80, 12, INK);
  assert.deepEqual(edgeSliver(near, cardFrame, null)[0], 36, 'a live frame moves in beside content 9 px away, and is given air');
  assert.deepEqual(edgeSliver(near, cardFrame, null, { fixed: true }), cardFrame, 'an imported one would need air painted there, so it stays');
});

test('at scale 2 a round card is entered as its 1x twin is', () => {
  const px = roundCard(canvas(320, 200, PAGE), CARD, 12).fill(70, 70, 80, 12, INK);
  assert.deepEqual([...atScale(2).edgeSliver(doubled(px), times2(cardFrame), null)], times2(edgeSliver(px, cardFrame, null)));
});

test('edgeSliver leaves a strip wider than the pad, and a band wider than a sliver behind a strip', () => {
  const wide = canvas(300, 200, PAGE).fill(33, 0, 267, 200, [255, 255, 255]).fill(33, 0, 1, 200, BORDER).fill(60, 50, 80, 12, INK);
  assert.equal(edgeSliver(wide, [20, 20, 200, 100], null)[0], 20, '13 px of page is a band of its own');
  const thick = canvas(300, 200, PAGE).fill(25, 0, 275, 200, [255, 255, 255]).fill(25, 0, 7, 200, BORDER).fill(60, 50, 80, 12, INK);
  assert.equal(edgeSliver(thick, [20, 20, 200, 100], null)[0], 25, 'the strip goes and the 7 px band stays');
});

test('edgeSliver takes a border that content stands flush against', () => {
  const px = canvas(300, 200).fill(20, 20, 1, 100, BORDER).fill(21, 50, 80, 12, INK);
  assert.equal(edgeSliver(px, [20, 20, 200, 100], null)[0], 21);
});

test('edgeSliver leaves ground that ends at content, however near the edge', () => {
  const px = canvas(300, 200).fill(28, 50, 80, 12, INK).fill(60, 28, 80, 12, INK);
  assert.deepEqual(edgeSliver(px, [20, 20, 200, 100], null), [20, 20, 200, 100], 'the 8 px beside the text and above it are its margin');
});

test('edgeAir reads ground through a rule that crosses the edge', () => {
  const px = canvas(300, 200).fill(0, 60, 300, 1, BORDER).fill(24, 80, 80, 12, INK);
  const { left } = edgeAir(px, [20, 20, 200, 100]);
  assert.equal(left.have, 4);
  assert.deepEqual(left.ground, [255, 255, 255]);
});

test('edgeAir counts the ground inside each edge and names its colour', () => {
  const px = canvas(300, 200).fill(23, 50, 80, 12, INK);
  const air = edgeAir(px, [20, 20, 200, 100]);
  assert.equal(air.left.have, 3);
  assert.deepEqual(air.left.ground, [255, 255, 255]);
  assert.equal(air.top.have, 12, 'counted up to the air it needs and no further');
});

test('edgeAir gives no ground for an edge that cuts content', () => {
  const px = canvas(300, 200).fill(10, 50, 80, 12, INK);
  assert.equal(edgeAir(px, [20, 20, 200, 100]).left.ground, null);
});

test('edgeAir finds no ground inside an edge that content stands flush against, and names the ground to paint', () => {
  const px = canvas(300, 200).fill(19, 0, 1, 200, BORDER).fill(20, 50, 80, 12, INK);
  const { left } = edgeAir(px, [20, 20, 200, 100]);
  assert.equal(left.have, 0);
  assert.deepEqual(left.ground, [255, 255, 255], 'the line outside is one colour, so the text ends at the edge and is not cut by it');
});

test('edgeAir gives no ground for an edge that lies on a rule', () => {
  const px = canvas(300, 200).fill(20, 20, 2, 100, BORDER).fill(40, 50, 80, 12, INK);
  assert.equal(edgeAir(px, [20, 20, 200, 100]).left.ground, null, 'a border the marks kept at the edge is not ground to paint more of');
});

test('edgeAir counts a strip wider than a sliver as ground, though a border ends it', () => {
  const px = canvas(300, 200, PAGE).fill(28, 0, 272, 200, [255, 255, 255]).fill(28, 0, 1, 200, BORDER).fill(60, 50, 80, 12, INK);
  const { left } = edgeAir(px, [20, 20, 200, 100]);
  assert.equal(left.have, 8);
  assert.deepEqual(left.ground, PAGE);
});

test('edgeAir counts a header bar as the ground of the edge it runs along', () => {
  const bar = [30, 41, 59];
  const px = canvas(300, 200).fill(20, 20, 200, 30, bar).fill(40, 27, 80, 12, [255, 255, 255]);
  const { top } = edgeAir(px, [20, 20, 200, 100]);
  assert.equal(top.have, 7);
  assert.deepEqual(top.ground, bar);
});

test('at scale 2 a strip is 24 capture px, a sliver 12 and air 24, as 12, 6 and 12 at scale 1 (FRAME_PAD, SLIVER, AIR)', () => {
  const frame = [20, 20, 200, 100];
  const one = edgeSliver(padded(), frame, null);
  assert.deepEqual([...atScale(2).edgeSliver(doubled(padded()), times2(frame), null)], times2(one));
  const thick = canvas(300, 200, PAGE).fill(25, 0, 275, 200, [255, 255, 255]).fill(25, 0, 7, 200, BORDER).fill(60, 50, 80, 12, INK);
  assert.equal(atScale(2).edgeSliver(doubled(thick), times2(frame), null)[0], 50, 'a 14 capture px band stays');
  const text = canvas(300, 200).fill(23, 50, 80, 12, INK);
  const two = atScale(2).edgeAir(doubled(text), times2(frame));
  assert.deepEqual([two.left.have, two.top.have], [6, 24]);
});

// Lines of text 10 px apart, as rows of 6 px glyphs with 1 px gaps: a solid bar wider than the crop would be a line of one colour, which is clean.
const paragraph = (from, to) => {
  const px = canvas(600, 400);
  for (let y = from; y < to; y += 10) for (let x = 41; x < 540; x += 7) px.fill(x, y, 6, 6, INK);
  return px;
};

test('a crop edge that cuts a line looks inward for a clean band before it gives up', () => {
  // a paragraph block ends 44 px above the mark; 48 px above the mark the margin line runs through it
  const px = paragraph(60, 150).fill(200, 190, 100, 14, INK);
  const { box, edges } = cropToMarks(px, [0, 0, 600, 400], [200, 190, 100, 14], { parts: [{ box: [200, 190, 100, 14], bracket: false }], hold: true });
  assert.equal(edges.top, 'snapped');
  assert.ok(box[1] >= 146 && box[1] <= 152, `the top edge sits in the gap under the paragraph (at ${box[1]})`);
});

test('a crop edge that looks inward keeps 24 px to the marks', () => {
  // the block's last line ends 26 px above the mark, so the band under it ends nearer than the edge may go
  const px = paragraph(38, 168).fill(200, 190, 100, 14, INK);
  const { box, edges, cut } = cropToMarks(px, [0, 0, 600, 400], [200, 190, 100, 14], { parts: [{ box: [200, 190, 100, 14], bracket: false }], hold: true });
  assert.equal(box[1], 146, 'the top edge takes the space between two lines just inside its margin, not the band');
  assert.equal(edges.top, 'word');
  assert.equal(cut, true);
});

// Lines of text 7 px apart, so one px of leading, from `from` until `space`, then again 4 px on: a word space between two lines.
const leading = (from, space) => {
  const px = canvas(600, 400).fill(200, 190, 100, 14, INK);
  for (const [start, end] of [[from, space], [space + 4, 190]]) for (let y = start; y + 6 <= end; y += 7) for (let x = 41; x < 540; x += 7) px.fill(x, y, 6, 6, INK);
  return px;
};

test('a held crop edge looks for a word space no nearer than 24 px to the marks', () => {
  const crop = (px) => cropToMarks(px, [0, 0, 600, 400], [200, 190, 100, 14], { parts: [{ box: [200, 190, 100, 14], bracket: false }], hold: true });
  const near = crop(leading(59, 170));
  assert.deepEqual([near.box[1], near.edges.top], [142, 'margin'], 'the space at 170..173 lies within 24 px of the mark at 190');
  const far = crop(leading(56, 160));
  assert.deepEqual([far.box[1], far.edges.top], [162, 'word'], 'the space at 160..163 does not');
});

test('a crop edge with a band both ways takes the nearer one', () => {
  const out = canvas(600, 400).fill(270, 150, 36, 10, INK);
  assert.equal(cropToMarks(out, [0, 0, 600, 400], [200, 150, 40, 20]).box[2], 318 - 136, 'the ink ends 2 px out and starts 34 px in: the edge goes out, and 12 px on for air');
  const back = canvas(600, 400).fill(295, 150, 46, 10, INK);
  assert.equal(cropToMarks(back, [0, 0, 600, 400], [200, 150, 40, 20]).box[2], 293 - 136, 'the ink ends 37 px out and starts 9 px in: the edge comes in, 2 px into the band');
});

test("a link's crop keeps 96 px above its places", () => {
  const px = canvas(800, 600).fill(100, 300, 80, 14, INK).fill(400, 300, 80, 14, INK);
  const parts = [{ box: [100, 300, 80, 14], bracket: false, link: true }, { box: [400, 300, 80, 14], bracket: false, link: true }];
  const { box } = cropToMarks(px, [0, 0, 800, 600], [100, 300, 380, 14], { parts });
  assert.ok(box[1] <= 300 - 96, `the crop starts at ${box[1]}`);
});

test('at scale 2 a crop edge looks inward to 48 capture px of the marks and a link keeps 192 above (CROP_MARGIN_MIN, CROP_MARGIN_LINK)', () => {
  const px = paragraph(60, 150).fill(200, 190, 100, 14, INK);
  const marks = [200, 190, 100, 14];
  sameCropTwice(px, [0, 0, 600, 400], marks, { parts: [{ box: marks, bracket: false }], hold: true });
  const link = canvas(800, 600).fill(100, 300, 80, 14, INK).fill(400, 300, 80, 14, INK);
  const two = sameCropTwice(link, [0, 0, 800, 600], [100, 300, 380, 14], { parts: [{ box: [100, 300, 380, 14], bracket: false, link: true }] });
  assert.ok(two.box[1] <= 300 - 96);
});

test('a trim never enters the box it is told to keep', () => {
  const px = canvas(400, 300).fill(100, 100, 120, 40, INK);
  const { box, trimmed } = trimBlank(px, [0, 0, 400, 300], [100, 100, 120, 40], [70, 92, 190, 56]);
  assert.deepEqual(box, [70, 88, 190, 64], 'the left and right edges stop at the kept box, the others 12 px from the marks');
  assert.deepEqual(trimmed, { left: 70, top: 88, right: 140, bottom: 148 });
});

test('a trim is measured from ink, not from the faint fringe a glyph leaves beside it, and still stops at a faint rule', () => {
  const fringe = [243, 243, 243];
  const px = canvas(400, 300).fill(100, 100, 120, 40, INK).fill(100, 99, 20, 1, fringe).fill(99, 100, 1, 20, fringe);
  assert.deepEqual(trimBlank(px, [0, 0, 400, 300], null).box, [88, 88, 144, 64], 'a fringe 20 px long is not where the content begins');
  const ruled = canvas(400, 300).fill(100, 100, 120, 40, INK).fill(100, 80, 24, 1, fringe);
  assert.equal(trimBlank(ruled, [0, 0, 400, 300], null).box[1], 68, 'a faint line 24 px long is a rule');
});

test('trimBlank keeps 12 px of ground', () => {
  const px = canvas(400, 300).fill(100, 100, 120, 40, INK);
  assert.deepEqual(trimBlank(px, [0, 0, 400, 300], null).box, [88, 88, 144, 64]);
});

const shedEdgeRules = (...args) => { const { box, shed } = sandbox.__composeGeometry.shedEdgeRules(...args); return { box: [...box], shed: { ...shed } }; };
const edgeRuleAt = (...args) => { const rule = sandbox.__composeGeometry.edgeRuleAt(...args); return rule && { thickness: rule.thickness, colour: [...rule.colour] }; };
const GREY_E2 = [226, 232, 240];
const NO_SHED = { left: 0, top: 0, right: 0, bottom: 0 };
// A 200 by 100 page: a line of text, and a 1px divider indented 10px that runs to the edge at row 80.
const divided = () => canvas(200, 100).fill(20, 20, 120, 14, INK).fill(10, 80, 190, 1, GREY_E2);

test('edgeRuleAt finds a thin line of one colour along half the line or more, and nothing thicker or shorter', () => {
  const row = (y, from = 0, to = 200) => ({ horizontal: true, fixed: y, from, to });
  assert.deepEqual(edgeRuleAt(divided(), row(80), { step: -1 }), { thickness: 1, colour: GREY_E2 });
  assert.equal(edgeRuleAt(divided(), row(79), { step: -1 }), null, 'a line of ground is no rule: it runs on past RULE_THICKNESS');
  assert.equal(edgeRuleAt(canvas(200, 100).fill(0, 78, 200, 3, GREY_E2), row(80), { step: -1 }), null, 'a 3px bar is content');
  assert.equal(edgeRuleAt(canvas(200, 100).fill(0, 80, 90, 1, GREY_E2), row(80), { step: -1 }), null, 'a line under half the length is not a rule');
  assert.equal(edgeRuleAt(divided(), row(80), { step: -1, ground: [228, 232, 238] }), null, 'a rule within SLIGHT of the ground is ground');
});

test('shedEdgeRules drops a divider lying inside the bottom edge', () => {
  const { box, shed } = shedEdgeRules(divided(), [0, 0, 200, 92], [20, 20, 120, 14], {});
  assert.ok(box[1] + box[3] <= 80, 'the edge stands above the divider');
  assert.ok(box[1] + box[3] >= 34 + 6, 'and keeps a clean band under the content');
  assert.equal(shed.bottom > 0, true);
  assert.deepEqual({ ...shed, bottom: 0 }, NO_SHED, 'no other side has a rule to shed');
});

test('shedEdgeRules drops a rule lying on the edge itself, and leaves FRAME_CUSHION lines between it and the edge', () => {
  const { box, shed } = shedEdgeRules(divided(), [0, 0, 200, 81], [20, 20, 120, 14], {});
  assert.deepEqual(box, [0, 0, 200, 78]);
  assert.equal(shed.bottom, 3);
});

test('shedEdgeRules keeps a divider with content right under it', () => {
  const px = divided().fill(20, 63, 120, 14, INK);
  assert.deepEqual(shedEdgeRules(px, [0, 0, 200, 92], [20, 20, 120, 14], {}), { box: [0, 0, 200, 92], shed: NO_SHED });
});

test('shedEdgeRules keeps a divider more than AIR lines in, or too near the marks', () => {
  assert.deepEqual(shedEdgeRules(divided(), [0, 0, 200, 94], [20, 20, 120, 14], {}).shed, NO_SHED, '13 lines of ground before the rule');
  assert.deepEqual(shedEdgeRules(divided(), [0, 0, 200, 92], [20, 20, 120, 40], {}).shed, NO_SHED, 'the edge would come within CROP_MARGIN_MIN of the marks');
});

test('shedEdgeRules never moves past a fill', () => {
  assert.deepEqual(shedEdgeRules(divided(), [0, 0, 200, 92], [20, 20, 120, 14], { keep: [[150, 76, 30, 8]] }), { box: [0, 0, 200, 92], shed: NO_SHED });
});

test('shedEdgeRules at scale 2 matches scale 1', () => {
  const one = shedEdgeRules(divided(), [0, 0, 200, 92], [20, 20, 120, 14], {});
  const { box, shed } = atScale(2).shedEdgeRules(doubled(divided()), times2([0, 0, 200, 92]), times2([20, 20, 120, 14]), {});
  assert.deepEqual([...box], times2(one.box));
  assert.equal(shed.bottom, 2 * one.shed.bottom);
});

test('a snapped crop edge comes off a divider it hugs', () => {
  const px = canvas(600, 400).fill(250, 180, 60, 12, INK).fill(100, 236, 400, 1, GREY_E2);
  const { box, edges } = cropToMarks(px, [0, 0, 600, 400], [250, 180, 60, 12]);
  assert.equal(edges.bottom, 'snapped');
  assert.ok(box[1] + box[3] <= 236, `the crop ends at ${box[1] + box[3]}, below the divider at 236`);
});

test('a snapped crop edge keeps a divider whose lines a fill reaches into', () => {
  const px = canvas(600, 400).fill(250, 180, 60, 12, INK).fill(100, 236, 400, 1, GREY_E2);
  const fill = [280, 232, 20, 6];
  const { box, edges } = cropToMarks(px, [0, 0, 600, 400], [250, 180, 60, 12], { keep: [fill], ignore: [fill] });
  assert.equal(edges.bottom, 'snapped');
  assert.ok(box[1] + box[3] >= fill[1] + fill[3], `the crop ends at ${box[1] + box[3]}, inside the fill`);
});

test('shedEdgeRules says which depths a side can lose: its ground, and its rule only whole', () => {
  const takes = (px, box) => [...sandbox.__composeGeometry.shedEdgeRules(px, box, [20, 20, 120, 14], {}).takes.bottom];
  const ruled = takes(divided(), [0, 0, 200, 92]);
  assert.deepEqual([0, 5, 11, 12, 13, 14].map((d) => ruled[d]), [true, false, false, true, true, true], 'none of the 11 lines of ground alone, since the rule would stay; past the rule, any');
  const plain = takes(canvas(200, 100).fill(20, 20, 120, 14, INK), [0, 0, 200, 92]);
  assert.ok([0, 5, 11, 12, 13, 14].every((d) => plain[d]), 'a side of ground alone can lose any of it');
  assert.equal(sandbox.__composeGeometry.shedEdgeRules(divided(), [0, 0, 200, 92], [20, 20, 120, 40], {}).takes.bottom[14], false, 'never within CROP_MARGIN_MIN of the marks');
  const two = [...atScale(2).shedEdgeRules(doubled(divided()), times2([0, 0, 200, 92]), times2([20, 20, 120, 14]), {}).takes.bottom];
  assert.deepEqual([0, 22, 24, 26, 27, 28].map((d) => two[d]), [true, false, true, true, false, true], 'at scale 2, whole CSS px of the 1x answer');
});

test('at scale 1.5 a pair sheds a depth every panel can take, and never moves an edge outward', () => {
  const geo = atScale(1.5);
  const page = (ruled) => {
    const px = canvas(300, 150).fill(30, 30, 180, 21, INK);
    return ruled ? px.fill(15, 130, 285, 1, GREY_E2) : px;
  };
  const panel = (px) => ({ scale: 1.5, ...geo.shedEdgeRules(px, [0, 0, 300, 138], [30, 30, 180, 21], {}) });
  const panels = [panel(page(true)), panel(page(false))];
  assert.equal(panels[0].shed.bottom, 11, '7 lines of ground, the rule and FRAME_CUSHION');
  const shared = sandbox.__composeGeometry.sharedShed(panels);
  for (const side of ['left', 'top', 'right', 'bottom']) {
    assert.ok(shared[side] >= 0, `the ${side} edge never moves outward (${shared[side]})`);
    for (const p of panels) assert.equal(p.takes[side][Math.round(shared[side] * p.scale)], true, `each panel can take the ${side} depth`);
  }
  assert.equal(Math.round(shared.bottom * 1.5), 11, 'both panels lose the divider\'s 11 capture px');
  const flat = { left: 0, top: 0, right: 0 };
  const none = { left: [true], top: [true], right: [true] };
  const blocked = sandbox.__composeGeometry.sharedShed([
    { scale: 1.5, shed: { ...flat, bottom: 4 }, takes: { ...none, bottom: [true, false, false, false, true] } },
    { scale: 1.5, shed: { ...flat, bottom: 0 }, takes: { ...none, bottom: [true, false, false, false, false] } },
  ]);
  assert.equal(blocked.bottom, 0, 'a depth one panel cannot take leaves both edges where they are');
});

const orphanBands = (...args) => { const { box, cut } = sandbox.__composeGeometry.orphanBands(...args); return { box: [...box], cut: { ...cut } }; };
const NO_CUT = { left: 0, top: 0, right: 0, bottom: 0 };
// A 300 by 200 card: a 10px "1" index in its top-left corner, `gap` clean lines under it, the card's name, then
// two status lines, the marks.
const STATUS_LINES = [6, 80, 200, 42];
const indexed = ({ gap = 30, index = true } = {}) => {
  const px = canvas(300, 200).fill(6, 16 + gap, 120, 14, INK).fill(6, 80, 200, 12, INK).fill(6, 110, 200, 12, INK);
  return index ? px.fill(6, 6, 10, 10, INK) : px;
};

test('orphanBands cuts a lone small index off the top, keeping AIR clean lines over the name', () => {
  const { box, cut } = orphanBands(indexed(), [0, 0, 300, 200], STATUS_LINES, {});
  assert.deepEqual(cut, { ...NO_CUT, top: 34 }, 'the name starts at row 46: 46 less AIR');
  assert.deepEqual(box, [0, 34, 300, 166]);
});

test('orphanBands keeps an index too close to the next content, or to a mark', () => {
  assert.deepEqual(orphanBands(indexed({ gap: 8 }), [0, 0, 300, 200], STATUS_LINES, {}).cut, NO_CUT, '8 clean lines is under ORPHAN_GAP (12)');
  assert.deepEqual(orphanBands(indexed(), [0, 0, 300, 200], [6, 46, 120, 14], {}).cut, NO_CUT, 'the index lies 30 lines from a mark, inside ORPHAN_CLEAR (32)');
});

test('orphanBands cuts an index 14 clean lines over the name, or 34 lines from a mark', () => {
  assert.deepEqual(orphanBands(indexed({ gap: 14 }), [0, 0, 300, 200], STATUS_LINES, {}).cut, { ...NO_CUT, top: 18 }, 'the name starts at row 30: 30 less AIR');
  assert.deepEqual(orphanBands(indexed(), [0, 0, 300, 200], [50, 50, 120, 14], {}).cut, { ...NO_CUT, top: 26 }, 'CROP_MARGIN_MIN short of the mark at row 50');
});

test('orphanBands keeps an icon that leads its row, and cuts one with nothing beside it', () => {
  const rows = (first) => canvas(300, 200).fill(4, 20, 10, 10, INK).fill(28, first, 200, 12, INK).fill(28, 100, 200, 12, INK).fill(28, 140, 200, 12, INK);
  assert.deepEqual(orphanBands(rows(20), [0, 0, 300, 200], [100, 100, 128, 52], {}).cut, NO_CUT, 'the line the icon leads runs on past the gap');
  assert.deepEqual(orphanBands(rows(40), [0, 0, 300, 200], [100, 100, 128, 52], {}).cut, { ...NO_CUT, left: 16 }, 'the rows under it start 14 columns on: 28 less AIR');
});

test('orphanBands keeps a status dot or a close button that shares its row with a title, however far off', () => {
  const header = (title) => {
    const px = canvas(300, 200).fill(280, 20, 8, 8, INK).fill(10, 60, 200, 12, INK).fill(10, 100, 200, 12, INK);
    return title ? px.fill(10, 18, 120, 12, INK) : px;
  };
  assert.deepEqual(orphanBands(header(true), [0, 0, 300, 200], [10, 100, 200, 12], {}).cut, NO_CUT, 'a right-aligned dot on the title\'s row');
  assert.deepEqual(orphanBands(header(false), [0, 0, 300, 200], [10, 100, 200, 12], {}).cut, { ...NO_CUT, top: 48, right: 66 }, 'with nothing on its row the dot is lone');
  const closer = canvas(300, 200).fill(10, 10, 150, 14, INK).fill(10, 50, 260, 12, INK).fill(10, 90, 260, 12, INK);
  for (let k = 0; k < 10; k += 1) closer.fill(282 + k, 10 + k, 1, 1, INK).fill(291 - k, 10 + k, 1, 1, INK);
  assert.deepEqual(orphanBands(closer, [0, 0, 300, 200], [10, 90, 260, 12], {}).cut, NO_CUT, 'a close button on the title\'s row');
});

test('orphanBands never takes a redaction fill for an orphan', () => {
  const px = indexed({ index: false }).fill(6, 6, 10, 10, [17, 24, 39]);
  assert.deepEqual(orphanBands(px, [0, 0, 300, 200], STATUS_LINES, { keep: [[6, 6, 10, 10]], ignore: [[6, 6, 10, 10]] }).cut, NO_CUT);
  assert.deepEqual(orphanBands(px, [0, 0, 300, 200], STATUS_LINES, { keep: [[6, 6, 10, 10]] }).cut, NO_CUT, 'nor a fill whose pixels are read');
});

test('orphanBands takes neither a strip along the edge nor a divider for an item', () => {
  const strip = indexed().fill(0, 0, 300, 3, [241, 245, 249]);
  assert.deepEqual(orphanBands(strip, [0, 0, 300, 200], STATUS_LINES, {}).cut, NO_CUT, 'a strip runs the length of the edge');
  const divided = indexed().fill(0, 2, 300, 1, GREY_E2);
  assert.deepEqual(orphanBands(divided, [0, 0, 300, 200], STATUS_LINES, {}).cut, NO_CUT, 'a divider before the index');
  const under = indexed().fill(0, 24, 300, 1, GREY_E2);
  assert.deepEqual(orphanBands(under, [0, 0, 300, 200], STATUS_LINES, {}).cut, NO_CUT, 'a divider 8 lines under the index is the next content');
});

test('orphanBands at scale 2 matches scale 1', () => {
  const one = orphanBands(indexed(), [0, 0, 300, 200], STATUS_LINES, {});
  const { box, cut } = atScale(2).orphanBands(doubled(indexed()), times2([0, 0, 300, 200]), times2(STATUS_LINES), {});
  assert.deepEqual([...box], times2(one.box));
  assert.deepEqual({ ...cut }, { ...NO_CUT, top: 68 });
  const near = atScale(2).orphanBands(doubled(indexed()), times2([0, 0, 300, 200]), times2([6, 46, 120, 14]), {});
  assert.deepEqual({ ...near.cut }, NO_CUT, 'the 48 px from a mark is 96 capture px');
});

test('a pair cuts an orphan only at a depth every panel can lose over ground or its own orphan', () => {
  const { sharedShed } = sandbox.__composeGeometry;
  const panel = (px) => {
    const { cut, takes } = sandbox.__composeGeometry.orphanBands(px, [0, 0, 300, 200], STATUS_LINES, {});
    return { scale: 1, shed: cut, takes };
  };
  const index = panel(indexed());
  assert.deepEqual([0, 5, 6, 10, 15, 16, 34, 35].map((d) => Boolean(index.takes.top[d])), [true, false, false, false, false, true, true, false], 'the index only whole, and AIR left over the name');
  assert.equal(sharedShed([index, panel(indexed({ index: false }))]).top, 34, 'ground under the same name takes the whole cut');
  const higher = panel(indexed({ gap: 14, index: false }));
  assert.equal(sharedShed([index, higher]).top, 18, 'a name 16 lines higher leaves room for 18');
  assert.equal(index.takes.top[18], true);
  const crowded = panel(canvas(300, 200).fill(6, 10, 200, 12, INK).fill(6, 80, 200, 12, INK).fill(6, 110, 200, 12, INK));
  assert.equal(sharedShed([index, crowded]).top, 0, 'content near the edge in one state keeps the edge in both');
});

test('at scale 1.5 orphanBands cuts whole capture px and never moves an edge outward', () => {
  const geo = atScale(1.5);
  const page = (index) => {
    const px = canvas(450, 300).fill(9, 69, 180, 21, INK).fill(9, 120, 300, 18, INK).fill(9, 165, 300, 18, INK);
    return index ? px.fill(9, 9, 15, 15, INK) : px;
  };
  const box = [0.5, 0.5, 449, 299];
  const found = geo.orphanBands(page(true), box, [9, 120, 300, 63], {});
  assert.equal(found.cut.top, 51, 'the name starts at row 69: 69 less AIR (18)');
  for (const side of ['left', 'top', 'right', 'bottom']) assert.ok(Number.isInteger(found.cut[side]) && found.cut[side] >= 0, `the ${side} cut is whole and inward`);
  assert.ok(found.box[1] >= box[1] && found.box[1] + found.box[3] <= box[1] + box[3]);
  const panels = [page(true), page(false)].map((px) => ({ scale: 1.5, ...(({ cut, takes }) => ({ shed: cut, takes }))(geo.orphanBands(px, box, [9, 120, 300, 63], {})) }));
  const shared = sandbox.__composeGeometry.sharedShed(panels);
  for (const side of ['left', 'top', 'right', 'bottom']) {
    assert.ok(shared[side] >= 0, `the ${side} edge never moves outward`);
    for (const p of panels) assert.equal(p.takes[side][Math.round(shared[side] * 1.5)], true, `each panel can take the ${side} depth`);
  }
  assert.equal(Math.round(shared.top * 1.5), 51);
});

const SLATE_CB = [203, 213, 225];
// A tab: a rounded 1px outline at [40, 30, 240, 60] round an avatar and a block of text.
function outlinedTab() {
  const px = canvas(320, 120);
  const [x, y, w, h, radius] = [40, 30, 240, 60, 6];
  px.fill(x + radius, y, w - 2 * radius, 1, SLATE_CB).fill(x + radius, y + h - 1, w - 2 * radius, 1, SLATE_CB);
  px.fill(x, y + radius, 1, h - 2 * radius, SLATE_CB).fill(x + w - 1, y + radius, 1, h - 2 * radius, SLATE_CB);
  const corners = [[x + radius, y + radius], [x + w - 1 - radius, y + radius], [x + radius, y + h - 1 - radius], [x + w - 1 - radius, y + h - 1 - radius]];
  for (const [cx, cy] of corners) {
    for (let py = cy - radius; py <= cy + radius; py += 1) {
      for (let pxx = cx - radius; pxx <= cx + radius; pxx += 1) {
        const outward = (pxx - cx) * (pxx < x + w / 2 ? -1 : 1) >= 0 && (py - cy) * (py < y + h / 2 ? -1 : 1) >= 0;
        if (outward && Math.abs(Math.hypot(pxx - cx, py - cy) - radius) <= 0.5) px.fill(pxx, py, 1, 1, SLATE_CB);
      }
    }
  }
  return px.fill(52, 44, 28, 28, INK).fill(96, 44, 120, 12, INK).fill(96, 62, 40, 10, INK).fill(144, 62, 40, 10, INK);
}
// The sides whose outline a lift's box drops: none when it drops no outline.
const droppedSides = (geo, px, box, options) => { const dropped = geo.droppedOutline(px, box, options); return dropped ? Object.keys(dropped.sides) : []; };
const pastOutline = (...args) => [...sandbox.__composeGeometry.pastOutline(...args)];

test('a side carries an outline whose line lies within OUTLINE_REACH inside it, or inside the element it grew from', () => {
  const geo = sandbox.__composeGeometry;
  assert.deepEqual(droppedSides(geo, outlinedTab(), [40, 30, 200, 50], {}), ['left', 'top'], 'the box holds the top and left lines only');
  assert.deepEqual(droppedSides(geo, outlinedTab(), [48, 38, 180, 40], {}), [], 'a box inside the outline holds none of it');
  assert.deepEqual(droppedSides(geo, outlinedTab(), [37, 30, 200, 50], {}), ['left', 'top'], 'a line 3 lines in is the side\'s');
  assert.deepEqual(droppedSides(geo, outlinedTab(), [35, 30, 200, 50], {}), [], 'a line 5 lines in is not, and a top line alone has no corner');
  assert.deepEqual(droppedSides(geo, outlinedTab(), [42, 30, 240, 50], {}), ['top', 'right'], 'the top line is found on a box whose left side holds no line');
  assert.deepEqual(droppedSides(geo, outlinedTab(), [20, 30, 220, 50], { element: [40, 30, 200, 50] }), ['left', 'top'], 'a lift grown past its element still carries the element\'s outline');
});

test('at scale 2 a side carries the outline its 1x twin does', () => {
  for (const box of [[40, 30, 200, 50], [37, 30, 200, 50], [35, 30, 200, 50]]) {
    assert.deepEqual(droppedSides(atScale(2), doubled(outlinedTab()), times2(box), {}), droppedSides(sandbox.__composeGeometry, outlinedTab(), box, {}), `${box}`);
  }
});

test('pastOutline moves each named side in past its outline to the first clean line, and leaves the others', () => {
  const box = pastOutline(outlinedTab(), [40, 30, 200, 50], ['left', 'top'], {});
  assert.deepEqual(box, [44, 31, 196, 49], 'the left edge also clears the corner\'s arc, to the line\'s ends');
  assert.deepEqual(droppedSides(sandbox.__composeGeometry, outlinedTab(), box, {}), []);
  const two = [...atScale(2).pastOutline(doubled(outlinedTab()), times2([40, 30, 200, 50]), ['left', 'top'], {})];
  assert.deepEqual(two, times2(box), 'at scale 2, twice the 1x box');
  const [x, y, w, h] = [...atScale(1.5).pastOutline(outlinedTab(), [39.6, 29.5, 200.3, 50.2], ['left', 'top'], {})];
  assert.ok(Number.isInteger(x) && Number.isInteger(y) && x > 39.6 && y > 29.5, `at scale 1.5 a moved side lands on a whole line, inward (${x}, ${y})`);
  assert.equal(x + w, 39.6 + 200.3, 'and a side not named keeps its coordinate');
  assert.equal(y + h, 29.5 + 50.2);
});

test('droppedOutline takes an outline of one colour with a corner, and nothing else', () => {
  const dropped = sandbox.__composeGeometry.droppedOutline(outlinedTab(), [40, 30, 200, 50], {});
  assert.deepEqual([...dropped.box], [44, 31, 196, 49]);
  assert.deepEqual(Object.keys(dropped.sides), ['left', 'top']);
  assert.deepEqual([...dropped.sides.left.colour], SLATE_CB);
  assert.deepEqual([...dropped.sides.left.ground], [255, 255, 255]);
  assert.equal(sandbox.__composeGeometry.droppedOutline(outlinedTab(), [38, 28, 244, 64], {}), null, 'a whole outline is the element\'s own card');
  const accent = canvas(320, 120).fill(40, 30, 2, 60, [79, 70, 229]).fill(40, 89, 240, 1, SLATE_CB).fill(60, 50, 120, 14, INK);
  assert.equal(sandbox.__composeGeometry.droppedOutline(accent, [40, 30, 240, 60], {}), null, 'an accent bar beside a rule of another colour is a design');
  const underline = canvas(320, 120).fill(40, 89, 240, 1, SLATE_CB).fill(60, 50, 120, 14, INK);
  assert.equal(sandbox.__composeGeometry.droppedOutline(underline, [40, 30, 240, 60], {}), null, 'a rule on one side is an underline');
});

test('coverBands paints only the outline, never past an open side, and gives up on a mark in its way', () => {
  const geo = sandbox.__composeGeometry;
  const box = [40, 30, 200, 50]; const footprint = [36, 26, 208, 64]; const element = [40, 30, 200, 56];
  const dropped = geo.droppedOutline(outlinedTab(), box, {});
  const bands = geo.coverBands(outlinedTab(), dropped, footprint, element, []);
  assert.deepEqual([...bands].map((band) => [...band.rect]), [[36, 26, 8, 60], [36, 26, 204, 5]], 'each band stops at the element\'s edge on a side the outline leaves open');
  const pinned = outlinedTab().fill(38, 50, 4, 4, [124, 58, 237]);
  assert.equal(geo.coverBands(pinned, geo.droppedOutline(pinned, box, {}), footprint, element, []), null, 'a pin on the outline is never painted out');
  assert.notEqual(geo.coverBands(pinned, geo.droppedOutline(pinned, box, {}), footprint, element, [[38, 50, 4, 4]]), null, 'a fill there is left alone');
  const grey = outlinedTab().fill(38, 50, 4, 4, [209, 213, 219]);
  assert.equal(geo.coverBands(grey, geo.droppedOutline(grey, box, {}), footprint, element, []), null, 'nor is a pin in a blend of the rule and the ground, off the rule\'s lines');
  const divided = outlinedTab().fill(36, 26, 1, 64, SLATE_CB);
  assert.notEqual(geo.coverBands(divided, geo.droppedOutline(divided, box, {}), footprint, element, []), null, 'a divider the length of a band is a line too');
});

test('onRule takes the ground, the rule and blends of them, and not a glyph\'s grey', () => {
  const at = (rgb) => new Uint8ClampedArray([...rgb, 255]);
  const white = [255, 255, 255];
  assert.ok(sandbox.__composeGeometry.onRule(at(white), 0, white, SLATE_CB));
  assert.ok(sandbox.__composeGeometry.onRule(at(SLATE_CB), 0, white, SLATE_CB));
  assert.ok(sandbox.__composeGeometry.onRule(at([229, 234, 240]), 0, white, SLATE_CB), 'half way is an antialiased edge');
  assert.equal(sandbox.__composeGeometry.onRule(at([207, 209, 212]), 0, white, SLATE_CB), false, 'a text edge is another hue');
  assert.equal(sandbox.__composeGeometry.onRule(at([124, 58, 237]), 0, white, SLATE_CB), false);
});

// Lines of text 8 px apart, 6 px glyphs with 1 px letter gaps, so no row between two lines is a gap; every line
// sets its words at the same places, `space` px apart, so a column through every word space is clean.
function running(width, height, space) {
  const px = canvas(width, height);
  const word = 5 * 4 + 4;
  for (let y = 0; y < height; y += 8) {
    for (let x = 0; x < width; x += word + space) for (let k = 0; k < 5; k += 1) px.fill(x + 5 * k, y, Math.min(4, Math.max(0, width - x - 5 * k)), Math.min(6, height - y), INK);
  }
  return px;
}
const WORD_MARKS = [400, 300, 60, 20];

test('a held crop edge through running text settles in the middle of the nearest word space inward', () => {
  const { box, edges, cut } = cropToMarks(running(1000, 800, 4), [0, 0, 1000, 800], WORD_MARKS, { hold: true });
  assert.deepEqual(edges, { left: 'word', top: 'margin', right: 'word', bottom: 'margin' }, 'two px of leading is no gap, a four px word space is');
  assert.equal(box[0], 362, 'the margin at 336 runs through a word; the space at 360..363 lies inward, nearer than the one outward at 332..335 is not looked at first');
  assert.equal(box[0] + box[2], 502, 'the margin at 524 runs through a word; the space at 500..503 lies inward');
  assert.deepEqual([box[1], box[3]], [252, 116], 'the top and bottom stay at their margins');
  assert.equal(cut, true, 'a margin edge still runs through content');
});

test('a held crop edge with no word space within reach stays at its margin', () => {
  const { box, edges } = cropToMarks(running(1000, 800, 2), [0, 0, 1000, 800], WORD_MARKS, { hold: true });
  assert.deepEqual(box, [336, 252, 188, 116]);
  assert.deepEqual(edges, { left: 'margin', top: 'margin', right: 'margin', bottom: 'margin' });
});

test('at scale 2 the same running text settles its edges in the same word spaces (LIFT_BAND, WORD_REACH)', () => {
  const one = sameCropTwice(running(1000, 800, 4), [0, 0, 1000, 800], WORD_MARKS, { hold: true });
  assert.equal(one.edges.left, 'word');
});

test('a cut frame edge settles in a word space outward when none lies inward, and an imported one never looks out', () => {
  const px = running(600, 400, 4);
  const frame = [30, 100, 540, 250];
  const marks = [60, 200, 40, 20];
  const live = cleanFrame(px, frame, marks);
  assert.equal(live.edges.left, 'word');
  assert.equal(live.frame[0], 26, 'the space at 24..27 lies outside the edge at 30');
  const fixed = cleanFrame(px, frame, marks, { fixed: true });
  assert.equal(fixed.edges.left, 'cut');
  assert.equal(fixed.frame[0], 30);
});

test('a cut frame edge looks inward for a word space first', () => {
  const px = running(600, 400, 4);
  const { frame, edges } = cleanFrame(px, [30, 100, 540, 250], [300, 200, 40, 20], { fixed: true });
  assert.equal(edges.left, 'word');
  assert.equal(frame[0], 54, 'the space at 52..55 lies inward');
});

test('at scale 2 a frame edge settles in the same word space', () => {
  const px = running(600, 400, 4);
  const frame = [30, 100, 540, 250]; const marks = [60, 200, 40, 20];
  const one = atScale(1).cleanFrame(px, frame, marks);
  const two = atScale(2).cleanFrame(doubled(px), times2(frame), times2(marks));
  assert.deepEqual([two.edges.left, two.frame[0]], [one.edges.left, 2 * one.frame[0]]);
});

test('at a fractional scale a word space settles an edge on a whole pixel, and an imported edge only inward', () => {
  // Five px spaces: LIFT_BAND is 4.5 capture px at 1.5.
  const px = running(600, 400, 5);
  for (const scale of [1.25, 1.5]) {
    const frame = [30, 100, 540, 250];
    const { frame: out, edges } = atScale(scale).cleanFrame(px, frame, [300, 200, 40, 20], { fixed: true });
    assert.equal(edges.left, 'word', `at ${scale}`);
    assert.ok(Number.isInteger(out[0]) && out[0] > frame[0] && out[0] + out[2] <= frame[0] + frame[2], `at ${scale} the frame ${out} only shrinks`);
    const { box } = atScale(scale).cropToMarks(px, [0, 0, 600, 400], [280, 180, 40, 20], { hold: true });
    assert.ok([...box].every(Number.isInteger), `at ${scale} the crop ${[...box]} is whole`);
  }
});

// A sidebar down the left of the page: a grey strip from the top to `to` and a rule beside it, each one colour all
// the way. Text rows with one px of leading fill y `from`..342 and the ground above them is clean; the marks sit just
// under the text.
const SIDEBAR_MARKS = [70, 350, 60, 20];
function sidebarPage(varied, from = 300, to = 500) {
  const px = canvas(600, 500).fill(20, 0, 16, to, [200, 200, 210]).fill(38, 0, 1, 500, [120, 120, 120]);
  for (let y = from; y + 6 <= 342; y += 7) for (let x = 60; x < 560; x += 7) px.fill(x, y, 6, 6, INK);
  // Nav labels down the strip: it changes along the edge, which is content.
  if (varied) for (let y = 0; y < 500; y += 10) px.fill(22, y, 12, 4, INK);
  return px;
}

test('a strip of one colour running across a held crop edge does not stop it settling in the ground beyond', () => {
  const { box, edges } = cropToMarks(sidebarPage(false), [0, 0, 600, 500], SIDEBAR_MARKS, { hold: true });
  assert.equal(edges.top, 'word', 'the lines above the text cross only the sidebar');
  assert.ok(box[1] < 300 && box[1] >= 302 - 48, `the top edge sits above the text, within WORD_REACH of its margin, at ${box[1]}`);
});

test('a strip that changes along the edge is content, and still holds the edge at its margin', () => {
  const { box, edges } = cropToMarks(sidebarPage(true), [0, 0, 600, 500], SIDEBAR_MARKS, { hold: true });
  assert.equal(edges.top, 'margin');
  assert.equal(box[1], 302);
});

test('past a strip, an edge reaches no further out than a word space, though a band lies within the snap reach', () => {
  // The text starts at 251, 51 lines out from the margin at 302: within CROP_SNAP, beyond WORD_REACH.
  const { box, edges } = cropToMarks(sidebarPage(false, 251), [0, 0, 600, 500], SIDEBAR_MARKS, { hold: true });
  assert.equal(edges.top, 'margin');
  assert.equal(box[1], 302);
});

test('a strip of one colour running across a cut frame edge does not stop it settling in the ground beyond', () => {
  const frame = [0, 302, 600, 190];
  assert.equal(cleanFrame(sidebarPage(false), frame, SIDEBAR_MARKS).edges.top, 'word');
  assert.equal(cleanFrame(sidebarPage(true), frame, SIDEBAR_MARKS).edges.top, 'cut');
  assert.equal(cleanFrame(sidebarPage(false, 251), frame, SIDEBAR_MARKS).edges.top, 'cut', 'no further out than WORD_REACH');
});

test('at scale 2 a strip across an edge is read as at scale 1', () => {
  sameCropTwice(sidebarPage(false), [0, 0, 600, 500], SIDEBAR_MARKS, { hold: true });
  sameCropTwice(sidebarPage(true), [0, 0, 600, 500], SIDEBAR_MARKS, { hold: true });
});

test('a frame edge takes a word step outward past a strip only on a side it is let, and says when it did', () => {
  const frame = [0, 302, 600, 190];
  const free = sandbox.__composeGeometry.cleanFrame(sidebarPage(false), frame, SIDEBAR_MARKS);
  assert.deepEqual({ ...free.stripOut }, { top: true });
  const held = sandbox.__composeGeometry.cleanFrame(sidebarPage(false), frame, SIDEBAR_MARKS, { stripOut: ['left', 'right', 'bottom'] });
  assert.deepEqual([held.edges.top, held.frame[1], { ...held.stripOut }], ['cut', 302, {}]);
});

// A white page with a wide button below the marks, out of line with them, running past both side margins.
const BUTTON_MARKS = [400, 300, 60, 20];
const buttonPage = (label) => {
  const px = canvas(1000, 800).fill(400, 300, 60, 20, INK).fill(100, 330, 600, 30, [99, 102, 241]);
  if (label) for (let x = 530; x < 600; x += 7) px.fill(x, 340, 5, 10, [255, 255, 255]);
  return px;
};

test('a button the side edges cross ends at its corners, so it is content: the edges hold at their margins and cut it', () => {
  for (const scale of [1, 2]) {
    const px = scale === 1 ? buttonPage(false) : doubled(buttonPage(false));
    const { box, edges, cut } = atScale(scale).cropToMarks(px, [0, 0, 1000, 800].map((n) => n * scale), BUTTON_MARKS.map((n) => n * scale), { hold: true });
    assert.deepEqual([[...box].map((n) => n / scale), edges.left, edges.right, cut], [[336, 252, 188, 116], 'margin', 'margin', true], `at ${scale}`);
  }
  assert.deepEqual({ ...cleanFrame(buttonPage(false), [336, 252, 188, 116], BUTTON_MARKS).edges }, { left: 'cut', top: 'clean', right: 'cut', bottom: 'clean' });
});

test('a button with a white label never takes a glyph of it for a word space', () => {
  const { box, edges } = cropToMarks(buttonPage(true), [0, 0, 1000, 800], BUTTON_MARKS, { hold: true });
  assert.deepEqual([edges.right, box[0] + box[2]], ['margin', 524], 'the right edge stays at its margin, outside the glyphs at 530..534');
});

test('at scale 2 a word space past a strip that the search limits cut short settles where its 1x twin does', () => {
  // Text rows end at 306 just inside the margin at 302; below them ground, crossed only by the sidebar, runs past
  // the inward limit (CROP_MARGIN_MIN short of the mark at 350).
  const px = canvas(600, 500).fill(20, 0, 16, 500, [200, 200, 210]).fill(38, 0, 1, 500, [120, 120, 120]).fill(...SIDEBAR_MARKS, INK);
  for (let y = 251; y + 6 <= 306; y += 7) for (let x = 60; x < 560; x += 7) px.fill(x, y, 6, 6, INK);
  const one = sameCropTwice(px, [0, 0, 600, 500], SIDEBAR_MARKS, { hold: true });
  assert.equal(one.edges.top, 'word');
});

// The top edge's search lines run from 48 above its margin at 302 down to 370, the bottom of the marks.
test('a strip that touches the image at one end and runs WORD_REACH past the search lines at the other is a strip', () => {
  const { box, edges } = cropToMarks(sidebarPage(false, 300, 440), [0, 0, 600, 500], SIDEBAR_MARKS, { hold: true });
  assert.equal(edges.top, 'word', 'the sidebar ends at 440, 70 lines past 370, short of the bottom at 500');
  assert.ok(box[1] < 300 && box[1] >= 302 - 48, `the top edge sits above the text, within WORD_REACH of its margin, at ${box[1]}`);
  assert.equal(cleanFrame(sidebarPage(false, 300, 440), [0, 302, 600, 190], SIDEBAR_MARKS).edges.top, 'word');
});

test('a strip that touches the image at one end but stops short of WORD_REACH past the search lines is content', () => {
  const { box, edges } = cropToMarks(sidebarPage(false, 300, 400), [0, 0, 600, 500], SIDEBAR_MARKS, { hold: true });
  assert.deepEqual([edges.top, box[1]], ['margin', 302], 'the sidebar ends at 400, 30 lines past 370');
  assert.equal(cleanFrame(sidebarPage(false, 300, 400), [0, 302, 600, 190], SIDEBAR_MARKS).edges.top, 'cut');
});

test('at scale 2 a strip that touches the image at one end is read as at scale 1', () => {
  assert.equal(sameCropTwice(sidebarPage(false, 300, 440), [0, 0, 600, 500], SIDEBAR_MARKS, { hold: true }).edges.top, 'word');
  assert.equal(sameCropTwice(sidebarPage(false, 300, 400), [0, 0, 600, 500], SIDEBAR_MARKS, { hold: true }).edges.top, 'margin');
});

test('two strips of one colour with ground between them are two strips, and the ground between is still ground', () => {
  const px = sidebarPage(false).fill(564, 0, 16, 500, [200, 200, 210]);
  assert.equal(cropToMarks(px, [0, 0, 600, 500], SIDEBAR_MARKS, { hold: true }).edges.top, 'word');
});

// A banner below the marks, out of line with them, touching both sides of the image, with a white label at the right
// margin.
const bannerPage = () => {
  const px = canvas(1000, 800).fill(...BUTTON_MARKS, INK).fill(0, 330, 1000, 30, [99, 102, 241]);
  for (let x = 530; x < 600; x += 7) px.fill(x, 340, 5, 10, [255, 255, 255]);
  return px;
};

test('a label inside a full-width banner is the banner\'s content, so no edge settles inside a glyph of it', () => {
  for (const scale of [1, 2]) {
    const px = scale === 1 ? bannerPage() : doubled(bannerPage());
    const { box, edges } = atScale(scale).cropToMarks(px, [0, 0, 1000, 800].map((n) => n * scale), BUTTON_MARKS.map((n) => n * scale), { hold: true });
    assert.deepEqual([edges.right, (box[0] + box[2]) / scale], ['margin', 524], `at ${scale} the right edge stays at its margin, outside the glyphs at 530..534`);
  }
  assert.equal(cleanFrame(bannerPage(), [336, 252, 188, 116], BUTTON_MARKS).edges.right, 'cut');
});

// A header from the top of the image to 350 whose blue fades by half a step a row, with a white label at rows
// 320..335 that the right margin at 524 crosses: the strip above the label and the one below differ by more than
// SLIGHT where they meet it.
const gradientHeader = () => {
  const px = canvas(1000, 800);
  for (let y = 0; y < 350; y += 1) px.fill(0, y, 1000, 1, [37, Math.round(99 - y / 6), Math.round(235 - y / 2)]);
  for (let x = 506; x < 600; x += 7) px.fill(x, 320, 5, 16, [255, 255, 255]);
  return px.fill(400, 360, 60, 20, INK);
};

test('a label inside a header whose colour drifts down its rows is still the header\'s content', () => {
  for (const scale of [1, 2]) {
    const px = scale === 1 ? gradientHeader() : doubled(gradientHeader());
    const { box, edges, cut } = atScale(scale).cropToMarks(px, [0, 0, 1000, 800].map((n) => n * scale), [400, 360, 60, 20].map((n) => n * scale), { hold: true });
    assert.deepEqual([edges.right, (box[0] + box[2]) / scale, cut], ['margin', 524, true], `at ${scale} the right edge holds at its margin and fades, never in the glyph at 520..524`);
  }
  assert.equal(cleanFrame(gradientHeader(), [336, 312, 188, 116], [400, 360, 60, 20]).edges.right, 'cut');
});

const RED = [220, 38, 38];
// Columns along `row` whose red channel lies strictly between `from` and `to` of the way across the step it holds.
const risePixels = (out, row, [from, to] = [0.1, 0.9]) => {
  const at = (x) => out.data[(row * out.width + x) * 4];
  const [left, right] = [at(0), at(out.width - 1)];
  let rise = 0;
  for (let x = 0; x < out.width; x += 1) {
    const t = (at(x) - left) / (right - left);
    if (t > from && t < to) rise += 1;
  }
  return rise;
};
// Pixels whose every channel lies within `tolerance` of `colour`.
const countNear = (out, colour, tolerance) => {
  let n = 0;
  for (let i = 0; i < out.width * out.height; i += 1) {
    if (colour.every((v, c) => Math.abs(out.data[i * 4 + c] - v) <= tolerance)) n += 1;
  }
  return n;
};
// The reference the lens is measured against: separable linear interpolation over pixel centres, edges clamped.
const bilinear = (px, [sx, sy, sw, sh], outW, outH) => {
  const data = new Uint8ClampedArray(outW * outH * 4);
  const read = (x, y, c) => px.data[(Math.min(px.height - 1, Math.max(0, y)) * px.width + Math.min(px.width - 1, Math.max(0, x))) * 4 + c];
  for (let oy = 0; oy < outH; oy += 1) {
    for (let ox = 0; ox < outW; ox += 1) {
      const u = sx + ((ox + 0.5) * sw) / outW - 0.5; const v = sy + ((oy + 0.5) * sh) / outH - 0.5;
      const x = Math.floor(u); const y = Math.floor(v); const fu = u - x; const fv = v - y;
      for (let c = 0; c < 4; c += 1) {
        data[(oy * outW + ox) * 4 + c] = (read(x, y, c) * (1 - fu) + read(x + 1, y, c) * fu) * (1 - fv) + (read(x, y + 1, c) * (1 - fu) + read(x + 1, y + 1, c) * fu) * fv;
      }
    }
  }
  return { data, width: outW, height: outH };
};

// Both rise 10-90% over 12 columns at 16x; Lanczos's steeper middle shows between 25% and 75%.
test('resampleLanczos keeps a step edge sharper than bilinear', () => {
  const px = canvas(16, 16).fill(8, 0, 8, 16, BLUE);
  const out = sandbox.__composeGeometry.resampleLanczos(px, [0, 0, 16, 16], 256, 16, [0, 0, 16, 16]);
  const reference = bilinear(px, [0, 0, 16, 16], 256, 16);
  const [rise, linear] = [risePixels(out, 8, [0.25, 0.75]), risePixels(reference, 8, [0.25, 0.75])];
  assert.ok(rise < linear, `the edge rises over ${rise} px against bilinear's ${linear}`);
});

test('resampleLanczos does not ring: every pixel across a step lies between its two colours', () => {
  for (const ground of [[255, 255, 255], [17, 24, 39]]) {
    const px = canvas(16, 16, ground).fill(6, 6, 4, 4, [34, 197, 94]);
    const out = sandbox.__composeGeometry.resampleLanczos(px, [0, 0, 16, 16], 128, 128, [0, 0, 16, 16]);
    for (let i = 0; i < 128 * 128; i += 1) {
      for (let c = 0; c < 3; c += 1) {
        const [lo, hi] = [Math.min(ground[c], [34, 197, 94][c]), Math.max(ground[c], [34, 197, 94][c])];
        assert.ok(out.data[i * 4 + c] >= lo - 1 && out.data[i * 4 + c] <= hi + 1, `pixel ${i} channel ${c} is ${out.data[i * 4 + c]}, outside ${lo}..${hi}`);
      }
    }
  }
});

test('resampleLanczos never reads past its clip', () => {
  const px = canvas(16, 16).fill(12, 0, 4, 16, RED);
  const out = sandbox.__composeGeometry.resampleLanczos(px, [0, 0, 12, 16], 96, 128, [0, 0, 12, 16]);
  assert.equal(countNear(out, [255, 255, 255], 1), 96 * 128, 'every pixel is the white inside the clip');
});

test('resampleLanczos keeps a 1px line visible when it shrinks the source', () => {
  for (const step of [3, 4]) {
    const px = canvas(48, 8).fill(24, 0, 1, 8, INK);
    const out = sandbox.__composeGeometry.resampleLanczos(px, [0, 0, 48, 8], 48 / step, 8, [0, 0, 48, 8]);
    let darkest = 255;
    for (let i = 0; i < out.width * out.height; i += 1) darkest = Math.min(darkest, out.data[i * 4]);
    assert.ok(darkest < 230, `at step ${step} the darkest pixel is ${darkest}: the line is gone`);
  }
});

test('resampleLanczos returns a flat field unchanged, alpha and all, from a fractional source', () => {
  const px = canvas(16, 16, [37, 99, 235]);
  for (let i = 0; i < 16 * 16; i += 1) px.data[i * 4 + 3] = 128;
  const out = sandbox.__composeGeometry.resampleLanczos(px, [2.25, 3.5, 7.5, 6], 30, 24, [0, 0, 16, 16]);
  assert.deepEqual([out.width, out.height], [30, 24]);
  assert.equal(countNear(out, [37, 99, 235, 128], 1), 30 * 24);
});

// sourceOf takes a rule at a frame edge off before trimBlank reads the frame, so
// these read the two in that order: the trim then passes the ground beyond the rule.
const shedThenTrim = (geo, px, frame) => {
  const shed = [...geo.shedEdgeRules(px, frame, null, {}).box];
  const { box, trimmed } = geo.trimBlank(px, shed, null);
  return { box: [...box], trimmed: { ...trimmed } };
};

function borderAtRight() {
  const px = canvas(500, 100).fill(40, 40, 100, 20, INK);
  return px.fill(440, 0, 1, 100, [209, 213, 219]);
}

test('a border at the right edge leaves with the shed, and the trim takes the blank ground past it to the content', () => {
  const { box, trimmed } = shedThenTrim(sandbox.__composeGeometry, borderAtRight(), [0, 0, 441, 100]);
  assert.equal(box[0] + box[2], 140 + 12, 'the right edge sits TRIM_PAD past the content');
  assert.ok(trimmed.right > 280, `the right side trimmed ${trimmed.right} px of blank ground`);
});

test('at scale 2 a border at the right edge trims to twice the scale 1 box', () => {
  const one = shedThenTrim(sandbox.__composeGeometry, borderAtRight(), [0, 0, 441, 100]).box;
  const two = shedThenTrim(sandbox.__composeGeometry.withScale(2), doubled(borderAtRight()), [0, 0, 882, 200]).box;
  assert.deepEqual(two, times2(one));
});

test('a divider along the bottom edge that stops short of the corner no longer holds the right side', () => {
  const px = canvas(500, 100).fill(40, 30, 100, 20, INK).fill(0, 97, 484, 1, [226, 227, 229]);
  const frame = [0, 0, 500, 99];
  assert.equal(trimBlank(px, frame, null).trimmed.right, 4, 'read alone, every column crosses the divider until it ends');
  const { box } = shedThenTrim(sandbox.__composeGeometry, px, frame);
  assert.equal(box[0] + box[2], 140 + 12);
});

const fillRect = (...args) => [...sandbox.__composeGeometry.fillRect(...args)];
// An imported redaction: a pad of 12 px round a box drawn by eye, a fill 2 px off what it found (page-layout.js).
const importFill = (px, box, options = {}) => {
  const { rect, rects, density, grew, capped } = sandbox.__composeGeometry.importFill(px, box, { pad: 12, back: 2, ...options });
  const { extended, near, bridged, spared, peek } = sandbox.__composeGeometry.importFill(px, box, { pad: 12, back: 2, ...options });
  return { rect: [...rect], rects: Array.from(rects, (r) => [...r]), density, grew, capped: Array.from(capped, (c) => ({ ...c })), extended: [...extended], near: [...near], bridged: [...bridged], spared: [...spared], peek: [...peek] };
};
// What an imported fill paints: its rects.
const importedFill = (px, box) => importFill(px, box).rects;
const ICON = [99, 102, 241];
const inRect = (x, y, [rx, ry, rw, rh]) => x >= rx && x < rx + rw && y >= ry && y < ry + rh;
// Whether a fill, one rect or the rects it paints, covers the pixel.
const covers = (fill, x, y) => (Array.isArray(fill[0]) ? fill.some((r) => inRect(x, y, r)) : inRect(x, y, fill));
// Every pixel of `area` more than 8 off the white ground lies under the fill.
const assertHidden = (px, fill, area) => {
  const [ax, ay, aw, ah] = area;
  for (let y = ay; y < ay + ah; y += 1) for (let x = ax; x < ax + aw; x += 1) {
    const at = (y * px.width + x) * 4;
    if ([0, 1, 2].every((c) => px.data[at + c] >= 247)) continue;
    assert.ok(covers(fill, x, y), `pixel ${x},${y} of the value shows outside the fill ${JSON.stringify(fill)}`);
  }
};
// A value on rows 20..29 under a box drawn tight to it, and a row with an icon below.
const valueOver = (iconTop) => canvas(300, 100).fill(44, 20, 90, 10, INK).fill(40, iconTop, 12, 12, ICON).fill(60, iconTop + 2, 80, 8, INK);
const VALUE_BOX = [40, 18, 100, 12];

// Regression guards: an imported fill keeps its whole pad, which hides every pixel of the value it reaches.
test('an imported fill keeps its whole pad over a neighbouring row 6 px under its box', () => {
  const px = valueOver(36);
  const { rect, rects } = importFill(px, VALUE_BOX);
  assert.ok(rect[1] + rect[3] >= 42, `the fill ${rect} gave back some of its pad`);
  assertHidden(px, rects, [28, 6, 124, 30]);
});

test('descenders past the box stay hidden', () => {
  const px = valueOver(40);
  for (const x of [50, 70, 96, 120]) px.fill(x, 30, 2, 4, INK);
  assertHidden(px, importedFill(px, VALUE_BOX), [28, 6, 124, 34]);
});

test('an underline under the value stays hidden', () => {
  const px = valueOver(41).fill(44, 31, 90, 1, INK);
  assertHidden(px, importedFill(px, VALUE_BOX), [28, 6, 124, 35]);
});

test('a faint antialiased tail past the value stays hidden', () => {
  const px = valueOver(40).fill(60, 30, 2, 3, INK).fill(60, 33, 2, 1, [240, 240, 240]);
  const fill = importedFill(px, VALUE_BOX);
  assert.ok(covers(fill, 60, 33), `the fill ${JSON.stringify(fill)} leaves the tail bare`);
});

test('a value whose descenders and underline sit beside the next row is hidden in every arrangement', () => {
  for (let iconTop = 31; iconTop <= 40; iconTop += 1) for (let tail = 0; tail <= 6; tail += 1) for (const underline of [false, true]) {
    const px = valueOver(iconTop);
    if (tail) px.fill(70, 30, 2, Math.min(tail, iconTop - 30), INK);
    if (underline && iconTop > 31) px.fill(44, 30, 90, 1, INK);
    const fill = importedFill(px, VALUE_BOX);
    const valueEnd = Math.min(iconTop, 30 + Math.max(tail, underline ? 1 : 0));
    assertHidden(px, fill, [28, 6, 124, valueEnd - 6]);
  }
});

test('a value whose last glyph overhangs its box beside a neighbour on its right is hidden in every arrangement', () => {
  for (let next = 141; next <= 150; next += 1) for (let overhang = 0; overhang <= 6; overhang += 1) {
    const px = canvas(300, 100).fill(44, 20, 90, 10, INK).fill(next, 18, 30, 14, ICON);
    if (overhang) px.fill(134, 22, Math.min(overhang, next - 134), 9, INK);
    const fill = importedFill(px, [40, 18, 94, 12]);
    assertHidden(px, fill, [28, 6, Math.min(next, 134 + overhang) - 28, 36]);
  }
});

test('a value whose glyphs reach into a band of another ground is hidden', () => {
  const px = canvas(300, 100).fill(30, 0, 200, 14, [238, 242, 247]).fill(44, 20, 90, 10, INK).fill(60, 12, 2, 8, INK);
  const fill = importedFill(px, VALUE_BOX);
  assert.ok(covers(fill, 60, 12) && covers(fill, 61, 12), `the fill ${JSON.stringify(fill)} leaves the ascender bare`);
});

test('a box with nothing of its own in it keeps its pad, which may be all that hides the value', () => {
  const px = canvas(300, 100).fill(44, 24, 90, 6, INK);
  assertHidden(px, importedFill(px, [40, 8, 100, 10]), [28, 0, 124, 31]);
});

test('content on the value\'s own rows, beside the box, stays hidden', () => {
  const px = canvas(300, 100).fill(50, 20, 90, 10, INK).fill(40, 20, 5, 10, INK).fill(145, 20, 6, 10, INK);
  assertHidden(px, importedFill(px, [48, 18, 94, 12]), [36, 6, 118, 36]);
});

// The reviewer's probes A1 to A10: the value's own ink past a few plain lines.
test('A1: a short last word in the pad after a word space stays hidden', () => {
  const px = canvas(300, 100);
  for (let x = 40; x < 100; x += 6) px.fill(x, 20, 4, 10, INK);
  px.fill(102, 20, 3, 10, INK).fill(107, 20, 3, 10, INK);
  assertHidden(px, importedFill(px, [38, 18, 62, 14]), [26, 6, 100, 40]);
});

test('A2: on a 2x image the letter past a 3 px gap stays hidden', () => {
  const px = canvas(400, 140);
  for (let x = 40; x < 140; x += 11) px.fill(x, 40, 8, 20, INK);
  assertHidden(px, importedFill(px, [38, 38, 98, 24]), [26, 26, 140, 50]);
});

test('A3: on a 2x image tittles 4 px above the x-height stay hidden', () => {
  const px = canvas(400, 140);
  for (let x = 40; x < 140; x += 11) px.fill(x, 50, 6, 16, INK);
  px.fill(40, 42, 6, 4, INK).fill(62, 42, 6, 4, INK);
  assertHidden(px, importedFill(px, [38, 50, 104, 16]), [26, 30, 130, 50]);
});

test('A4: an underline 3 or 4 rows under the baseline stays hidden', () => {
  for (const under of [33, 34]) {
    const px = canvas(300, 100);
    for (let x = 40; x < 130; x += 6) px.fill(x, 20, 4, 10, INK);
    px.fill(40, under, 90, 1, INK);
    assertHidden(px, importedFill(px, [38, 18, 94, 12]), [26, 6, 120, 40]);
  }
});

test('A10: a 2x underline 4 rows under the baseline stays hidden', () => {
  const px = canvas(400, 140);
  for (let x = 40; x < 140; x += 11) px.fill(x, 40, 8, 20, INK);
  px.fill(40, 64, 100, 2, INK);
  assertHidden(px, importedFill(px, [38, 38, 104, 22]), [26, 26, 130, 50]);
});

test('a thick underline or a border-bottom under the value stays hidden, at 1x and 2x', () => {
  for (const [under, thick] of [[33, 3], [34, 4]]) {
    const px = canvas(300, 100);
    for (let x = 40; x < 130; x += 6) px.fill(x, 20, 4, 10, INK);
    px.fill(40, under, 90, thick, INK);
    assertHidden(px, importedFill(px, [38, 18, 94, 12]), [26, 6, 120, 40]);
  }
  for (const [under, thick] of [[64, 6], [66, 6]]) {
    const px = canvas(400, 140);
    for (let x = 40; x < 140; x += 11) px.fill(x, 40, 8, 20, INK);
    px.fill(38, under, 104, thick, [203, 213, 225]);
    assertHidden(px, importedFill(px, [38, 38, 104, 22]), [26, 26, 130, 54]);
  }
});

test('a box drawn short of a 2x value\'s height still hides the glyphs below it', () => {
  const px = canvas(400, 140);
  for (let x = 40; x < 140; x += 11) px.fill(x, 40, 8, 16, INK);
  assertHidden(px, importedFill(px, [38, 40, 104, 6]), [26, 28, 130, 30]);
});

test('a thin line past a wide gap, an underline or a divider, stays hidden', () => {
  const px = valueOver(60).fill(30, 37, 200, 2, [203, 213, 225]);
  assertHidden(px, importedFill(px, VALUE_BOX), [28, 6, 124, 36]);
});

test('a stray of the value\'s own ink and a short run before a neighbour keep the pad whole', () => {
  const px = canvas(300, 100).fill(44, 20, 90, 10, INK).fill(70, 34, 2, 1, INK).fill(40, 38, 12, 12, ICON);
  const { rect } = importFill(px, VALUE_BOX);
  assert.ok(rect[1] + rect[3] >= 42, `the fill ${rect} gave back some of its pad`);
});

test('a live fill is the box and its reach less the ground', () => {
  const px = valueOver(36);
  assert.deepEqual(fillRect(px, [40, 18, 100, 12], { reach: 2, back: 2 }), [42, 18, 94, 14]);
  assert.deepEqual(fillRect(px, [400, 18, 100, 12], { reach: 2, back: 2 }).slice(2), [0, 0], 'a box off the image covers nothing');
});

// The reviewer's other synthetic probes: every pixel off the ground in `area`, a neighbour's aside, lies under the fill.
const assertValueHidden = (px, fill, area, neighbours = []) => {
  const [ax, ay, aw, ah] = area;
  for (let y = ay; y < ay + ah; y += 1) for (let x = ax; x < ax + aw; x += 1) {
    if (neighbours.some((r) => inRect(x, y, r))) continue;
    const at = (y * px.width + x) * 4;
    if ([0, 1, 2].every((c) => px.data[at + c] === 255)) continue;
    assert.ok(covers(fill, x, y), `pixel ${x},${y} of the value shows outside the fill ${JSON.stringify(fill)}`);
  }
};
const stems = (px, from, to, y, h, step, colour = INK) => { for (let x = from; x < to; x += step) px.fill(x, y, step - 2, h, colour); return px; };

test('A5 to A9: the value\'s faint, light, fractional and chip-held ink stays hidden', () => {
  { const px = stems(canvas(300, 100), 40, 130, 20, 10, 6).fill(70, 30, 2, 3, INK).fill(40, 36, 12, 12, ICON);
    assertValueHidden(px, importedFill(px, [38, 18, 94, 12]), [26, 6, 120, 30], [[40, 36, 12, 12]]); }
  { const px = stems(canvas(300, 100), 40, 130, 20, 10, 6).fill(90, 30, 1, 8, [236, 236, 236]).fill(40, 33, 12, 12, ICON);
    assertValueHidden(px, importedFill(px, [38, 18, 94, 12]), [26, 6, 120, 34], [[40, 33, 12, 12]]); }
  { const px = canvas(300, 100);
    for (let x = 40; x < 130; x += 6) px.fill(x, 20, 4, 10, [200, 200, 200]).fill(x - 1, 20, 1, 10, [232, 232, 232]).fill(x + 4, 20, 1, 10, [232, 232, 232]);
    px.fill(70, 30, 2, 2, [232, 232, 232]).fill(40, 36, 12, 12, INK);
    assertValueHidden(px, importedFill(px, [38, 18, 94, 9]), [26, 6, 120, 30], [[40, 36, 12, 12]]); }
  { const px = stems(canvas(300, 100), 40, 130, 20, 10, 6).fill(40, 34, 12, 12, ICON);
    assertValueHidden(px, importedFill(px, [38.6, 18.4, 93.7, 11.3]), [26, 6, 120, 28], [[40, 34, 12, 12]]); }
  { const px = stems(canvas(300, 100).fill(34, 14, 104, 22, [238, 242, 247]), 40, 130, 20, 10, 6);
    assertValueHidden(px, importedFill(px, [40, 20, 90, 10]), [26, 6, 120, 40]); }
});

test('an imported fill is never smaller than the fill of its box and its 12 px pad', () => {
  let seed = 11; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 1500; i += 1) {
    const W = 80 + Math.floor(rnd() * 160); const H = 60 + Math.floor(rnd() * 100);
    const px = canvas(W, H, rnd() < 0.3 ? [17, 24, 39] : [255, 255, 255]);
    for (let k = 0; k < 1 + rnd() * 6; k += 1) {
      const colour = [rnd() * 255, rnd() * 255, rnd() * 255].map(Math.floor);
      const [x, y] = [Math.floor(rnd() * W), Math.floor(rnd() * H)];
      px.fill(x, y, Math.min(W - x, Math.floor(rnd() * 40)), Math.min(H - y, Math.floor(rnd() * 20)), colour);
    }
    const box = [rnd() * (W + 40) - 30, rnd() * (H + 40) - 30, rnd() * 60, rnd() * 30].map((v) => (rnd() < 0.5 ? Math.round(v) : v));
    const pad = fillRect(px, box, { reach: 12, back: 2 });
    if (pad[2] <= 0 || pad[3] <= 0) continue;
    const bounds = rnd() < 0.5 ? undefined : [Math.floor(rnd() * 20), Math.floor(rnd() * 20), W - 20, H - 20];
    const { rects } = importFill(px, box, { bounds });
    assert.ok(rects.some((rect) => rect[0] <= pad[0] && rect[1] <= pad[1] && rect[0] + rect[2] >= pad[0] + pad[2] && rect[1] + rect[3] >= pad[1] + pad[3]), `case ${i}: the fill ${JSON.stringify(rects)} is smaller than the pad's ${pad}`);
  }
});

// A line of lowercase text at `d` device px per CSS px: an x-height of 7 CSS px of stems 1 CSS px wide and 2 apart,
// a third of them starting a CSS px lower and another third ending one higher as round letters do, and three
// ascenders of 3 more CSS px.
const textLine = (px, x, y, width, d, colour = INK) => {
  for (let i = 0, sx = x; sx < x + width; i += 1, sx += 3 * d) px.fill(sx, y + 3 * d + (i % 3 === 1 ? d : 0), d, 7 * d - (i % 3 === 0 ? 0 : d), colour);
  for (const k of [0, 4, 9]) if (x + k * 3 * d < x + width) px.fill(x + k * 3 * d, y, d, 3 * d, colour);
  return px;
};

test('an imported fill reads the density from the value\'s x-height, rounding up, and a blank box from its height', () => {
  for (const d of [1, 2, 3]) {
    const px = textLine(canvas(200 * d, 80 * d), 20 * d, 20 * d, 60 * d, d);
    assert.equal(importFill(px, [20 * d, 20 * d, 60 * d, 10 * d]).density, d, `a ${d}x value`);
  }
  assert.equal(importFill(canvas(200, 120), [20, 20, 100, 48]).density, 2, 'a blank box 48 px tall reads as one line at 2x');
});

test('an imported fill grows over an underline or a border past its pad, at 1x and 2x, and says so', () => {
  for (const d of [1, 2]) {
    const px = textLine(canvas(200 * d, 100 * d), 20 * d, 20 * d, 60 * d, d).fill(20 * d, 46 * d, 60 * d, 3 * d, INK);
    const pad = fillRect(px, [20 * d, 20 * d, 60 * d, 10 * d], { reach: 12, back: 2 });
    assert.ok(pad[1] + pad[3] <= 46 * d, 'the border lies past the pad');
    const fill = importFill(px, [20 * d, 20 * d, 60 * d, 10 * d]);
    assertValueHidden(px, fill.rects, [0, 0, px.width, px.height]);
    assert.equal(fill.grew, true);
    assert.deepEqual(fill.capped, []);
  }
});

test('an imported fill grows over a wrapped line under or over its box, wider than it, and the leading between', () => {
  for (const d of [1, 2]) for (const below of [true, false]) {
    const px = canvas(240 * d, 140 * d);
    const [boxed, other] = below ? [30, 54] : [54, 30];
    textLine(px, 20 * d, boxed * d, 50 * d, d);
    textLine(px, 20 * d, other * d, 80 * d, d);
    const fill = importFill(px, [20 * d, boxed * d, 50 * d, 10 * d]);
    assertValueHidden(px, fill.rects, [0, 0, px.width, px.height]);
    assert.deepEqual(fill.capped, [], `${d}x, the other line ${below ? 'below' : 'above'}`);
  }
});

test('an imported fill grows over the rest of a word its box stops short of, on the value\'s own line', () => {
  const px = textLine(canvas(300, 80), 20, 20, 80, 1);
  const fill = importFill(px, [20, 20, 40, 10]);
  assertValueHidden(px, fill.rects, [0, 0, 300, 80]);
  assert.equal(fill.grew, true);
});

test('an imported fill does not grow into ground of another colour, a rule that runs past it, or another mark\'s box', () => {
  const chart = textLine(canvas(300, 100).fill(10, 0, 280, 18, [238, 242, 247]), 40, 20, 60, 1);
  assert.equal(importFill(chart, [40, 20, 60, 10]).grew, false, 'a chart flush above the value');
  const ruled = textLine(canvas(300, 100).fill(0, 44, 300, 1, [203, 213, 225]), 40, 20, 60, 1);
  textLine(ruled, 40, 50, 60, 1);
  const fill = importFill(ruled, [40, 20, 60, 10]).rect;
  assert.ok(fill[1] + fill[3] <= 44, `the fill ${fill} crosses the divider`);
  const marked = textLine(textLine(canvas(300, 100), 40, 20, 60, 1), 40, 44, 60, 1);
  const kept = importFill(marked, [40, 20, 60, 10], { keep: [[38, 42, 64, 14]] }).rect;
  assert.ok(kept[1] + kept[3] <= 42, `the fill ${kept} grows into another mark's box`);
  const grown = importFill(marked, [40, 20, 60, 10]).rect;
  assert.ok(grown[1] + grown[3] > 54, `without that box the fill ${grown} takes the line below`);
});

test('an imported fill reads nothing past its bounds, so ink there neither grows it nor caps it', () => {
  const px = textLine(canvas(300, 100), 40, 20, 60, 1).fill(40, 44, 60, 2, INK);
  const fill = importFill(px, [40, 20, 60, 10], { bounds: [0, 0, 300, 42] });
  assert.ok(fill.rect[1] + fill.rect[3] <= 42);
  assert.deepEqual(fill.capped, []);
});

test('ink that runs on along the value\'s own line past the limit refuses the board; another line is covered to its end', () => {
  const own = textLine(canvas(600, 80), 20, 20, 560, 1);
  assert.deepEqual(importFill(own, [20, 20, 40, 10]).capped, [{ side: 'right', why: 'limit', refuse: true }]);
  const beside = textLine(textLine(canvas(600, 80), 20, 20, 40, 1), 20, 38, 560, 1);
  const fill = importFill(beside, [20, 20, 40, 10]);
  assert.deepEqual(fill.capped, []);
  assert.deepEqual(fill.extended, ['right']);
  assertValueHidden(beside, fill.rects, [0, 0, 600, 80]);
});

test('a line beside the value is followed to its end either way, as a right-aligned or wrapped-left value runs', () => {
  const px = textLine(textLine(canvas(400, 80), 200, 40, 40, 1), 20, 22, 240, 1);
  const fill = importFill(px, [200, 40, 40, 10]);
  assertValueHidden(px, fill.rects, [0, 0, 400, 80]);
  assert.ok(fill.extended.includes('left'), `${fill.extended}`);
});

test('ink that runs into another mark\'s box is named, and refuses the board under the value\'s columns or past the limit', () => {
  // A mark's box over the line under the value may hold the value's own wrapped line: refused. A context box there
  // is the driver's word, and the walk stops at it.
  const px = textLine(textLine(canvas(300, 100), 40, 20, 60, 1), 40, 44, 60, 1);
  assert.deepEqual(importFill(px, [40, 20, 60, 10], { keep: [[38, 42, 64, 14]] }).capped, [{ side: 'bottom', why: 'mark', refuse: true }]);
  // Off the value's columns a mark is still no reason to leave a line its reach takes in; further off, it is.
  const beside = textLine(textLine(canvas(300, 100), 40, 20, 60, 1), 160, 44, 60, 1);
  assert.deepEqual(importFill(beside, [40, 20, 60, 10], { keep: [[158, 42, 64, 14]] }).capped.filter((c) => c.refuse).map((c) => [c.why, c.at[0], c.at[1]]), [['mark', 160, 44]]);
  const off = textLine(textLine(canvas(300, 160), 40, 20, 60, 1), 160, 130, 60, 1);
  assert.deepEqual(importFill(off, [40, 20, 60, 10], { keep: [[158, 128, 64, 14]] }).capped.filter((c) => c.refuse), [], 'a mark over a line beyond the value\'s reach refuses nothing');
  const long = textLine(textLine(canvas(600, 80), 20, 20, 40, 1), 20, 38, 560, 1);
  const capped = importFill(long, [20, 20, 40, 10], { keep: [[400, 30, 40, 30]] }).capped;
  assert.ok(capped.some((c) => c.side === 'right' && c.why === 'mark' && c.refuse), JSON.stringify(capped));
});

test('a context box over the value\'s own wrapped line refuses the board naming the line; one over a line a rule fences off does not', () => {
  const wrapped = textLine(textLine(canvas(300, 100), 40, 20, 60, 1), 40, 44, 60, 1);
  const fill = importFill(wrapped, [40, 20, 60, 10], { held: [[38, 42, 64, 14]] });
  assert.deepEqual(fill.capped.filter((c) => c.why === 'context').map((c) => [c.side, c.refuse, [...c.at]]), [['bottom', true, [40, 44, 58, 10]]]);
  assert.ok(!fill.rects.some((r) => r[1] + r[3] > 44), `the fill ${JSON.stringify(fill.rects)} paints into the context box`);
  const fenced = textLine(textLine(canvas(300, 100), 40, 20, 60, 1), 40, 50, 60, 1).fill(0, 40, 300, 1, [203, 213, 225]);
  assert.deepEqual(importFill(fenced, [40, 20, 60, 10], { held: [[38, 48, 64, 14]] }).capped.filter((c) => c.refuse), [], 'the line past the rule is the driver\'s to keep');
});

// A row's border under the value's line, across the frame, and the value's line past it.
const ruledValue = (line2At) => textLine(textLine(canvas(400, 100), 40, 20, 60, 1).fill(0, 36, 400, 1, [203, 213, 225]), line2At, 44, 80, 1);

test('a line past a row\'s border wholly beside the value\'s columns is refused, or covered, as far as a wrapped line reaches', () => {
  // A cell on the value's own row above that line keeps the wrap rule off it: the board is refused naming it.
  const celled = textLine(ruledValue(130), 150, 20, 50, 1);
  const rule = importFill(celled, [40, 20, 60, 10]).capped.find((c) => c.why === 'rule');
  assert.ok(rule?.refuse && rule.at[0] <= 130 && rule.at[0] + rule.at[2] >= 205, JSON.stringify(rule));
  // With that row clear, the wrap rule may take the line for the value's wrapped right to left: never left bare.
  const clear = ruledValue(130);
  const fill = importFill(clear, [40, 20, 60, 10]);
  if (!fill.capped.some((c) => c.refuse)) assertValueHidden(clear, fill.rects, [120, 40, 100, 20]);
  assert.deepEqual(importFill(ruledValue(300), [40, 20, 60, 10]).capped.filter((c) => c.refuse), [], 'a line beyond a wrap\'s reach refuses nothing');
});

test('a lift\'s box over the line past a row\'s border is read, so that line refuses the board', () => {
  const px = textLine(textLine(canvas(400, 100), 40, 20, 60, 1).fill(0, 36, 400, 1, [203, 213, 225]), 40, 44, 60, 1);
  const fill = importFill(px, [40, 20, 60, 10], { keep: [[38, 42, 64, 14]] });
  assert.deepEqual(fill.capped.filter((c) => c.refuse).map((c) => [c.why, [...c.at]]), [['rule', [40, 44, 58, 10]]]);
});

test('a mark\'s or a context box over the value\'s line wrapped to its container\'s edge refuses the board naming that line', () => {
  // The value ends a line at 200 and wraps to the left edge under it, off the fill's columns.
  const px = textLine(textLine(canvas(400, 100), 200, 20, 60, 1), 20, 40, 80, 1);
  const lift = importFill(px, [200, 20, 60, 10], { keep: [[18, 38, 84, 14]] });
  assert.deepEqual(lift.capped.filter((c) => c.refuse).map((c) => [c.why, c.at[0], c.at[1]]), [['mark', 20, 40]]);
  const context = importFill(px, [200, 20, 60, 10], { held: [[18, 38, 84, 14]] });
  assert.deepEqual(context.capped.filter((c) => c.refuse).map((c) => [c.why, c.at[0], c.at[1]]), [['context', 20, 40]]);
  assertValueHidden(px, importFill(px, [200, 20, 60, 10]).rects, [0, 0, 400, 100]);
});

test('the gate refuses a line within the value\'s reach that the fill leaves bare, unless a context mark holds it alone', () => {
  // Above the value past a gap of more than a lead, overlapping its columns too little to be taken for its line.
  const above = (y) => textLine(textLine(canvas(400, 140), 100, 80, 60, 1), 150, y, 100, 1);
  const fill = importFill(above(42), [100, 80, 60, 10]);
  assert.deepEqual(fill.capped.filter((c) => c.refuse).map((c) => [c.why, c.side, [...c.at]]), [['reach', 'top', [150, 42, 100, 10]]]);
  const held = importFill(above(42), [100, 80, 60, 10], { held: [[148, 40, 104, 14]] });
  assert.deepEqual(held.capped.filter((c) => c.refuse), [], 'the driver\'s word on that line');
  assert.deepEqual(importFill(above(14), [100, 80, 60, 10]).capped.filter((c) => c.refuse), [], 'a line further off than two leads');
  // A line wholly left of the value past a clear gutter, with a label beside the value on its row, is another
  // column's.
  const apart = textLine(textLine(textLine(canvas(400, 140), 200, 80, 60, 1), 20, 80, 60, 1), 20, 42, 100, 1);
  const columns = importFill(apart, [200, 80, 60, 10]);
  assert.deepEqual(columns.capped.filter((c) => c.refuse), [], 'another column');
  assert.ok(!columns.rects.some((r) => r[0] < 120), `the fill ${JSON.stringify(columns.rects)} reaches the other column`);
});

test('the gate refuses a line within a lead past a rule the walk never reached, and leaves one beyond the value\'s reach', () => {
  // The walk stops at the gap before the rule; the line past it lies beside the value's columns, which the wrap rule
  // does not cross a rule to take.
  const line = (y) => textLine(textLine(canvas(400, 140), 40, 20, 60, 1).fill(0, 62, 400, 1, [203, 213, 225]), 130, y, 80, 1);
  assert.deepEqual(importFill(line(66), [40, 20, 60, 10]).capped.filter((c) => c.refuse).map((c) => [c.why, c.at[0], c.at[1]]), [['rule', 130, 66]]);
  assert.deepEqual(importFill(line(100), [40, 20, 60, 10]).capped.filter((c) => c.refuse), [], 'further off than two leads');
});

test('a line of capitals whose inkiest row is one bar still reads its density', () => {
  for (const d of [2, 3]) {
    // An L: a stem 9 CSS px tall and a foot 5 wide, 2 CSS px apart, as 12px capitals are.
    const px = canvas(200 * d, 80 * d);
    for (let x = 20 * d; x < 80 * d; x += 7 * d) px.fill(x, 20 * d, d, 9 * d, INK).fill(x, 28 * d, 5 * d, d, INK);
    assert.ok(importFill(px, [20 * d, 20 * d, 60 * d, 9 * d]).density >= d, `a ${d}x line of capitals`);
  }
});

test('a word a word space past the box\'s 12 CSS px reach is covered, at 1x, 2x and 3x', () => {
  for (const d of [1, 2, 3]) {
    const px = textLine(textLine(canvas(260 * d, 60 * d), 20 * d, 20 * d, 60 * d, d), 94 * d, 20 * d, 30 * d, d);
    assertValueHidden(px, importFill(px, [20 * d, 20 * d, 60 * d, 10 * d]).rects, [0, 0, px.width, px.height]);
  }
});

test('a value wrapped onto three or four lines is covered to its last line, from a box on any of them', () => {
  for (const d of [1, 2, 3]) for (const count of [3, 4]) for (let boxed = 0; boxed < count; boxed += 1) {
    const px = canvas(240 * d, (40 + 22 * count) * d);
    for (let n = 0; n < count; n += 1) textLine(px, 20 * d, (20 + 22 * n) * d, (n === 1 ? 110 : 60) * d, d);
    const fill = importFill(px, [20 * d, (20 + 22 * boxed) * d, 60 * d, 10 * d]);
    assertValueHidden(px, fill.rects, [0, 0, px.width, px.height]);
  }
});

// A value line at rows 20 to 30 has a lead of 21 rows below its fill's edge at row 32.
test('ink that resumes within one more lead past a gap is covered, and said so', () => {
  const px = textLine(textLine(canvas(240, 120), 20, 20, 60, 1), 20, 60, 60, 1);
  const fill = importFill(px, [20, 20, 60, 10]);
  assertValueHidden(px, fill.rects, [0, 0, 240, 120]);
  assert.deepEqual(fill.bridged, ['bottom']);
});

test('ink farther past a gap, under the value with nothing between, is covered through; with a line between, it is left, named, and inside what the gate shows', () => {
  // The far line 78 rows under the pad's edge: past three leads of 21, within five.
  const clear = textLine(textLine(canvas(240, 160), 20, 20, 60, 1), 20, 110, 60, 1);
  const through = importFill(clear, [20, 20, 60, 10]);
  assertValueHidden(clear, through.rects, [0, 0, 240, 160]);
  assert.deepEqual(through.bridged, ['bottom']);
  const between = textLine(clear, 160, 70, 50, 1);
  const fill = importFill(between, [20, 20, 60, 10]);
  assert.ok(fill.rect[1] + fill.rect[3] < 110, `the fill ${fill.rect} reaches the far line`);
  assert.deepEqual(fill.near, ['bottom']);
  assert.ok(fill.peek[1] + fill.peek[3] >= 120, `the gate's view ${fill.peek} stops short of the far line`);
});

test('a border past a gap is neither covered through nor named: only text is', () => {
  const px = textLine(canvas(240, 140), 20, 20, 60, 1).fill(0, 60, 240, 1, [203, 213, 225]).fill(0, 82, 240, 1, [203, 213, 225]);
  const fill = importFill(px, [20, 20, 60, 10]);
  assert.deepEqual([fill.bridged, fill.near], [[], []]);
});

test('ink at the frame on the value\'s own line refuses the board; on a line beside it, it is named', () => {
  const own = textLine(canvas(300, 80), 20, 20, 200, 1);
  assert.deepEqual(importFill(own, [20, 20, 40, 10], { bounds: [0, 0, 120, 80] }).capped, [{ side: 'right', why: 'frame', refuse: true }]);
  const beside = textLine(textLine(canvas(300, 80), 20, 20, 40, 1), 20, 38, 200, 1);
  assert.deepEqual(importFill(beside, [20, 20, 40, 10], { bounds: [0, 0, 120, 80] }).capped, [{ side: 'right', why: 'frame', refuse: false }]);
});

test('a value with nothing beside it keeps the fill of its box and pad', () => {
  const px = textLine(canvas(300, 100), 40, 20, 60, 1);
  const fill = importFill(px, [40, 20, 60, 10]);
  assert.deepEqual(fill.rect, fillRect(px, [40, 20, 60, 10], { reach: 12, back: 2 }));
  assert.deepEqual(fill.rects, [fill.rect], 'and paints that one rect');
  assert.equal(fill.grew, false);
});

// A value of three lines, the last past a gap of 38 rows: within two leads of 21 at 1x.
const threeLines = (d) => {
  const px = canvas(240 * d, 160 * d);
  for (const [y, width] of [[40, 60], [62, 50], [110, 70]]) textLine(px, 20 * d, y * d, width * d, d);
  return px;
};

test('a box drawn just off its value, holding no ink, takes the line under its pad as the value\'s and covers through a gap to its last line', () => {
  for (const d of [1, 2, 3]) {
    const px = threeLines(d);
    const fill = importFill(px, [20 * d, 28 * d, 60 * d, 10 * d]);
    assertValueHidden(px, fill.rects, [0, 0, px.width, px.height]);
    assert.ok(fill.bridged.includes('bottom'), `${d}x: ${fill.bridged}`);
    assert.equal(fill.density, d);
  }
});

test('a box off its value by more than its pad takes the line its lead reaches as the value\'s, reads the density from it, and grows again from there', () => {
  for (const d of [2, 3]) {
    const px = threeLines(d);
    const pad = fillRect(px, [20 * d, 24 * d, 60 * d, 10 * d], { reach: 12, back: 2 });
    assert.ok(pad[1] + pad[3] <= 40 * d, 'the pad reaches no ink');
    const fill = importFill(px, [20 * d, 24 * d, 60 * d, 10 * d]);
    assertValueHidden(px, fill.rects, [0, 0, px.width, px.height]);
    assert.ok(fill.bridged.includes('bottom'), `${d}x: ${fill.bridged}`);
    assert.equal(fill.density, d, `${d}x reads its density from the line it reached`);
  }
});

test('a blank box in a clearing covers through no gap: the ink two leads off is left to the gate', () => {
  const px = textLine(canvas(240, 120), 20, 70, 60, 1);
  const fill = importFill(px, [20, 20, 60, 10]);
  assert.equal(fill.grew, false);
  assert.deepEqual([fill.bridged, fill.rects], [[], [fill.rect]]);
  assert.ok(fill.peek[1] + fill.peek[3] >= 80, `the gate's view ${fill.peek} stops short of the line`);
});

test('an imported fill paints one rectangle per line it covers: a label on the value\'s line past a clean gap, and the next column\'s rows, stay bare', () => {
  const px = canvas(360, 120);
  textLine(px, 20, 44, 40, 1); textLine(px, 100, 44, 60, 1); textLine(px, 200, 44, 60, 1);
  textLine(px, 100, 20, 160, 1);
  const fill = importFill(px, [100, 44, 60, 10]);
  assertValueHidden(px, fill.rects, [98, 18, 64, 40]);
  assertValueHidden(px, fill.rects, [160, 18, 102, 14]);
  assert.ok(fill.rects.length >= 2, `${JSON.stringify(fill.rects)}`);
  assert.ok(inRect(230, 48, fill.rect) && !covers(fill.rects, 230, 48), 'the next column\'s words lie inside the bounding box and outside every rect');
  assert.ok(!covers(fill.rects, 30, 48) && !covers(fill.rects, 56, 48), 'the label 40 px before the value stays bare');
});

test('ink past a gap is covered through only when its line lies under or over the value\'s: a wide heading set off from it is left to the gate', () => {
  const value = (px) => textLine(px, 100, 60, 60, 1);
  const offset = value(textLine(canvas(300, 140), 20, 20, 100, 1));
  const fill = importFill(offset, [100, 60, 60, 10]);
  assert.deepEqual([fill.bridged, fill.near], [[], ['top']]);
  assert.ok(fill.rect[1] > 30 && fill.peek[1] <= 20, `the fill ${fill.rect} covers the heading, or the gate's view ${fill.peek} leaves it out`);
  const under = value(textLine(canvas(300, 140), 100, 20, 100, 1));
  const covered = importFill(under, [100, 60, 60, 10]);
  assert.deepEqual(covered.bridged, ['top']);
  assertValueHidden(under, covered.rects, [0, 0, 300, 140]);
});

// A value that starts mid-line (after a text indent or a label set far off) and wraps to its container's left
// edge: the second line lies wholly left of the first line's columns, 30 rows below it (over a lead of 21).
const wrappedLeft = (d) => textLine(textLine(canvas(300 * d, 120 * d), 150 * d, 30 * d, 60 * d, d), 20 * d, 70 * d, 40 * d, d);

test('a value that wraps to its container\'s left edge, wholly left of its first line, is covered from a box on either line', () => {
  for (const d of [1, 2, 3]) {
    const onFirst = importFill(wrappedLeft(d), [150 * d, 30 * d, 60 * d, 10 * d]);
    assertValueHidden(wrappedLeft(d), onFirst.rects, [0, 0, 300 * d, 120 * d]);
    assert.equal(onFirst.grew, true);
    const onSecond = importFill(wrappedLeft(d), [20 * d, 70 * d, 40 * d, 10 * d]);
    assertValueHidden(wrappedLeft(d), onSecond.rects, [0, 0, 300 * d, 120 * d]);
  }
});

test('a wrapped line too faint to seed a piece is still painted: the walk reads it, so a piece of it is kept', () => {
  for (const d of [1, 2]) {
    const px = textLine(textLine(canvas(240 * d, 100 * d), 20 * d, 20 * d, 60 * d, d, [240, 240, 240]), 20 * d, 42 * d, 80 * d, d, [240, 240, 240]);
    const fill = importFill(px, [20 * d, 20 * d, 60 * d, 10 * d]);
    assertValueHidden(px, fill.rects, [0, 0, px.width, px.height]);
  }
});

// A definition grid: a label column at x 20 and a value column at x 120, rows `pitch` apart, the value on row 1.
const grid = (d, pitch, labelPitch = pitch) => {
  const px = canvas(300 * d, 160 * d);
  for (let row = 0; row < 4; row += 1) textLine(px, 20 * d, (20 + row * labelPitch) * d, 50 * d, d, [107, 114, 128]);
  for (let row = 0; row < 4; row += 1) textLine(px, 120 * d, (20 + row * pitch) * d, (row === 0 ? 90 : 60) * d, d);
  return px;
};

// A definition grid whose redacted row has a two-line label beside a two-line value (its lines 20 apart), the
// other rows `gap` rows under the line before them.
const wrappedGrid = (d, gap) => {
  const px = canvas(300 * d, 200 * d);
  textLine(px, 20 * d, 20 * d, 50 * d, d, [107, 114, 128]); textLine(px, 20 * d, 40 * d, 60 * d, d, [107, 114, 128]);
  textLine(px, 120 * d, 20 * d, 70 * d, d); textLine(px, 120 * d, 40 * d, 90 * d, d);
  for (const row of [1, 2]) { const y = 40 + row * (20 + gap); textLine(px, 20 * d, y * d, 50 * d, d, [107, 114, 128]); textLine(px, 120 * d, y * d, 60 * d, d); }
  return px;
};

test('a grid row\'s value is hidden whole, whether the label column keeps the value\'s rhythm or one of its own', () => {
  for (const d of [1, 2]) {
    const px = grid(d, 26);
    assertValueHidden(px, importFill(px, [120 * d, 20 * d, 90 * d, 10 * d]).rects, [118 * d, 18 * d, 94 * d, 14 * d]);
  }
  const uneven = grid(1, 24, 22);
  assertValueHidden(uneven, importFill(uneven, [120, 20, 90, 10]).rects, [118, 18, 94, 14]);
});

test('a two-line value beside a two-line label is hidden whole from a box on either line, at any row gap', () => {
  for (const d of [1, 2]) {
    for (const gap of [0, 6, 12]) {
      const px = wrappedGrid(d, gap);
      assertValueHidden(px, importFill(px, [120 * d, 20 * d, 70 * d, 10 * d]).rects, [118 * d, 18 * d, 94 * d, 34 * d]);
      assertValueHidden(px, importFill(px, [120 * d, 40 * d, 90 * d, 10 * d]).rects, [118 * d, 18 * d, 94 * d, 34 * d]);
    }
  }
});

test('text that runs right to left wraps to its container\'s right edge: the wrap below and a lone tail above are covered', () => {
  for (const d of [1, 2]) {
    // Line 1 indented from the right (x 80 to 140), line 2 flush right (x 190 to 230), 22 rows apart.
    const rtl = () => textLine(textLine(canvas(300 * d, 100 * d), 80 * d, 30 * d, 60 * d, d), 190 * d, 52 * d, 40 * d, d);
    const onFirst = importFill(rtl(), [80 * d, 30 * d, 60 * d, 10 * d]);
    assertValueHidden(rtl(), onFirst.rects, [0, 0, 300 * d, 100 * d]);
    const onSecond = importFill(rtl(), [190 * d, 52 * d, 40 * d, 10 * d]);
    assertValueHidden(rtl(), onSecond.rects, [0, 0, 300 * d, 100 * d]);
  }
});

test('a row of cells to the upper left of the value is no tail: it is named for the gate and left readable', () => {
  const px = textLine(textLine(textLine(canvas(400, 100), 20, 30, 50, 1), 90, 30, 50, 1), 220, 52, 60, 1);
  const fill = importFill(px, [220, 52, 60, 10]);
  assert.ok(!covers(fill.rects, 25, 35) && !covers(fill.rects, 95, 35), `the row above is covered: ${JSON.stringify(fill.rects)}`);
  assert.deepEqual(fill.near, ['top']);
  assert.ok(fill.peek[0] <= 20 && fill.peek[1] <= 30, `the gate's view ${fill.peek} leaves the row out`);
});

test('a rounded corner\'s arc, hanging off a card\'s border below the value, is no wrapped line', () => {
  // At 2x: a 2 px border 360 px long with a 20 px block at its left end, 50 rows under the value and wholly left of it.
  const px = textLine(canvas(500, 200), 150, 60, 60, 2).fill(40, 120, 360, 2, [229, 231, 235]).fill(20, 120, 20, 20, [229, 231, 235]);
  const fill = importFill(px, [150, 60, 60, 20]);
  assert.ok(!covers(fill.rects, 25, 125), `the arc is painted: ${JSON.stringify(fill.rects)}`);
});

// A card heading over an inner card, at `d` device px per CSS px: the outer card's left side a hairline beside the
// heading, and 12 CSS px under it the inner card's 1 CSS px border, its top far wider than the heading and its left
// side running down from a rounded corner. Inside, an icon and a sentence; below them, a row of facts.
const CARD_LINE = [229, 231, 235];
const headingOverCard = (d) => {
  const px = canvas(520 * d, 200 * d).fill(19 * d, 4 * d, d, 192 * d, CARD_LINE);
  textLine(px, 24 * d, 20 * d, 150 * d, d);
  px.fill(28 * d, 42 * d, 466 * d, d, CARD_LINE).fill(24 * d, 46 * d, d, 140 * d, CARD_LINE);
  for (let i = 1; i < 4; i += 1) px.fill((24 + i) * d, (46 - i) * d, d, d, CARD_LINE);
  px.fill(36 * d, 56 * d, 10 * d, 10 * d, ICON);
  textLine(px, 52 * d, 56 * d, 300 * d, d);
  textLine(px, 36 * d, 92 * d, 80 * d, d); textLine(px, 200 * d, 92 * d, 80 * d, d);
  return px;
};

test('a fill stops at a card\'s hairline border past a clean gap: the border and what it holds stay bare', () => {
  for (const d of [1, 2, 3]) for (const box of [[24, 20, 150, 10], [84, 20, 50, 10]]) {
    const px = headingOverCard(d);
    const fill = importFill(px, box.map((v) => v * d));
    const label = `${d}x, box ${box}`;
    assertValueHidden(px, fill.rects, [20 * d, 0, 480 * d, 36 * d]);
    // Over the whole heading nothing lies past the pad to grow onto; over one word, the rest of the heading does.
    if (box[2] === 150) assert.equal(fill.grew, false, `${label}: the fill grew ${JSON.stringify(fill.rects)}`);
    for (const [x, y] of [[300, 42], [480, 42], [26, 44], [24, 60], [24, 120], [40, 60], [100, 60], [300, 62], [60, 96], [220, 96]]) {
      assert.ok(!covers(fill.rects, x * d, y * d), `${label}: ${x},${y} is covered by ${JSON.stringify(fill.rects)}`);
    }
  }
});

test('a fill inside a card stops short of its hairline border and the rounded corner that leads into it', () => {
  for (const d of [1, 2, 3]) for (const box of [[52, 56, 300, 10], [36, 56, 316, 10]]) {
    const px = headingOverCard(d);
    const fill = importFill(px, box.map((v) => v * d));
    const label = `${d}x, box ${box}`;
    assertValueHidden(px, fill.rects, [30 * d, 52 * d, 330 * d, 16 * d]);
    // The pad's own fill may reach the corner: nothing is painted short of it.
    const pad = fillRect(px, box.map((v) => v * d), { reach: 12, back: 2 });
    for (const [x, y] of [[100, 42], [300, 42], [480, 42], [25, 45], [26, 44], [27, 43], [24, 50], [24, 120], [60, 24], [150, 24]]) {
      if (inRect(x * d, y * d, pad)) continue;
      assert.ok(!covers(fill.rects, x * d, y * d), `${label}: ${x},${y} is covered by ${JSON.stringify(fill.rects)}`);
    }
  }
});

// A link that wraps in a narrow column, its first line long and its second short, each underlined `offset` CSS px
// under its text: the first line's underline runs far past the second line's columns.
const underlinedWrap = (d, offset) => {
  const px = canvas(300 * d, 120 * d);
  textLine(px, 20 * d, 20 * d, 150 * d, d).fill(20 * d, (30 + offset) * d, 150 * d, d, INK);
  return textLine(px, 20 * d, 42 * d, 50 * d, d).fill(20 * d, (52 + offset) * d, 50 * d, d, INK);
};

test('an underline that hugs the line past it is no card border: a wrapped link is covered from a box on its short line', () => {
  for (const d of [1, 2, 3]) for (const offset of [2, 3, 4]) {
    const px = underlinedWrap(d, offset);
    assertValueHidden(px, importFill(px, [20 * d, 42 * d, 50 * d, 10 * d]).rects, [0, 0, px.width, px.height]);
  }
});

test('a row\'s border that a wrapped value overflows past is no edge of the value: its first line is covered', () => {
  for (const d of [1, 2, 3]) {
    // The row's border 3 CSS px under the first line, 7 over the second.
    const px = textLine(textLine(canvas(480 * d, 120 * d), 20 * d, 20 * d, 170 * d, d), 20 * d, 40 * d, 90 * d, d).fill(20 * d, 33 * d, 420 * d, d, CARD_LINE);
    assertValueHidden(px, importFill(px, [20 * d, 40 * d, 90 * d, 10 * d]).rects, [0, 0, px.width, px.height], [[0, 33 * d, px.width, d]]);
  }
});

test('a fill that stops at a hairline with ink just past it names that side for the gate', () => {
  for (const d of [1, 2]) {
    const fill = importFill(headingOverCard(d), [24 * d, 20 * d, 150 * d, 10 * d]);
    assert.deepEqual(fill.near, ['bottom'], `${d}x`);
  }
});

// An icon-led list at `d` device px per CSS px: a heading at y 20, then rows at a pitch of 27 from y 60, each an icon
// 12 CSS px square at x 40 and a line of text at x 60. `rtl` mirrors it in a 300 CSS px wide image: icons at x
// 248, text ending at x 240. `heading` sets where the heading starts and whether a sparkle leads it; `pitch` the
// heading's distance above the first row.
const iconList = (d, { rtl = false, heading = 'sparkle', pitch = 40, rows = 3, widths = [90, 80, 60] } = {}) => {
  const px = canvas(300 * d, 160 * d);
  const headY = (60 - pitch) * d;
  if (heading !== 'none') {
    if (rtl) {
      textLine(px, 70 * d, headY, 170 * d, d);
      if (heading === 'sparkle') px.fill(270 * d, headY, 8 * d, 8 * d, ICON);
    } else {
      textLine(px, (heading === 'sparkle' ? 30 : 40) * d, headY, 170 * d, d);
      if (heading === 'sparkle') px.fill(14 * d, headY, 8 * d, 8 * d, ICON);
    }
  }
  for (let i = 0; i < rows; i += 1) {
    const y = (60 + 27 * i) * d;
    if (rtl) { px.fill(248 * d, y, 12 * d, 12 * d, ICON); textLine(px, (240 - widths[i]) * d, y, widths[i] * d, d); }
    else { px.fill(40 * d, y, 12 * d, 12 * d, ICON); textLine(px, 60 * d, y, widths[i] * d, d); }
  }
  return px;
};
const ROW_BOX = (d, rtl = false) => (rtl ? [148 * d, 58 * d, 114 * d, 16 * d] : [38 * d, 58 * d, 116 * d, 16 * d]);
// Points of the list's other rows and heading, CSS px: the icon's centre and two points along each line.
const otherRows = (rtl = false) => (rtl ? [[254, 93], [200, 92], [170, 92], [254, 120], [220, 119], [200, 119]] : [[46, 93], [70, 92], [120, 92], [46, 120], [70, 119], [100, 119]]);
const headingPoints = (rtl = false, pitch = 40) => (rtl ? [[150, 65 - pitch], [100, 65 - pitch]] : [[60, 65 - pitch], [150, 65 - pitch]]);
const assertBare = (fill, points, d, label) => { for (const [x, y] of points) assert.ok(!covers(fill.rects, x * d, y * d), `${label}: ${x},${y} is covered by ${JSON.stringify(fill.rects)}`); };
const inPeek = (fill, points, d, label) => { for (const [x, y] of points) assert.ok(inRect(x * d, y * d, fill.peek), `${label}: ${x},${y} lies outside the gate's view ${fill.peek}`); };

test('a redaction of one row of an icon-led list spares the other rows and the heading above, and refuses the board naming each', () => {
  for (const d of [1, 2, 3]) for (const rtl of [false, true]) {
    const px = iconList(d, { rtl });
    const fill = importFill(px, ROW_BOX(d, rtl));
    const label = `${d}x${rtl ? ' rtl' : ''}`;
    assertValueHidden(px, fill.rects, rtl ? [146 * d, 56 * d, 118 * d, 18 * d] : [36 * d, 56 * d, 120 * d, 18 * d]);
    assertBare(fill, [...otherRows(rtl), ...headingPoints(rtl)], d, label);
    assert.deepEqual(fill.spared, ['top', 'bottom'], label);
    inPeek(fill, [...otherRows(rtl), ...headingPoints(rtl)], d, label);
    assert.deepEqual(fill.capped.map((c) => [c.side, c.why, c.refuse]), [['top', 'row', true], ['bottom', 'row', true]], label);
    // The rows named lie where the spared lines are: the heading above, the two rows below.
    const [top, bottom] = fill.capped.map((c) => c.at);
    assert.ok(top[1] + top[3] <= 60 * d && top[1] >= 16 * d, `${label}: the heading's box ${top}`);
    assert.ok(bottom[1] >= 85 * d && bottom[1] + bottom[3] >= 114 * d, `${label}: the rows' box ${bottom}`);
    assert.deepEqual([fill.extended, fill.bridged], [[], []], label);
  }
});

test('a context box on a list\'s next row holds the walk there, though the pad reaches it, so the board is written', () => {
  for (const d of [1, 2]) {
    const px = iconList(d);
    const row = [38 * d, 85 * d, 116 * d, 16 * d];
    const fill = importFill(px, ROW_BOX(d), { held: [row] });
    assertValueHidden(px, fill.rects, [36 * d, 56 * d, 120 * d, 18 * d]);
    assert.ok(!fill.capped.some((c) => c.why === 'row' && c.side === 'bottom'), `${d}x: ${JSON.stringify(fill.capped)}`);
    assert.ok(!fill.rects.some((r) => r[1] + r[3] > 85 * d + 2 * d), `${d}x: the fill ${JSON.stringify(fill.rects)} enters the held row`);
  }
});

test('a heading above an icon-led list is spared by the list\'s pitch, or by starting outside the icon column, and otherwise covered', () => {
  for (const d of [1, 2]) {
    // Flush with the icon column, a clear pitch above the rows.
    const byPitch = importFill(iconList(d, { heading: 'flush', pitch: 40 }), ROW_BOX(d));
    assertBare(byPitch, headingPoints(false, 40), d, `${d}x by pitch`);
    assert.deepEqual(byPitch.spared, ['top', 'bottom'], `${d}x by pitch`);
    // Led by a glyph left of the icon column, at the rows' own pitch.
    const byStart = importFill(iconList(d, { heading: 'sparkle', pitch: 27 }), ROW_BOX(d));
    assertBare(byStart, headingPoints(false, 27), d, `${d}x by start`);
    // Flush with the icon column at the rows' own pitch: nothing proves it is not the value's first line.
    const near = iconList(d, { heading: 'flush', pitch: 27 });
    const kept = importFill(near, ROW_BOX(d));
    assertValueHidden(near, kept.rects, [36 * d, 30 * d, 220 * d, 44 * d]);
    assert.deepEqual(kept.spared, ['bottom'], `${d}x near heading`);
  }
});

test('a value that wraps under its text column is covered whole; a list row proven after it is spared', () => {
  for (const d of [1, 2, 3]) {
    const px = canvas(300 * d, 160 * d);
    px.fill(40 * d, 60 * d, 12 * d, 12 * d, ICON); textLine(px, 60 * d, 60 * d, 90 * d, d);
    textLine(px, 60 * d, 80 * d, 70 * d, d);
    px.fill(40 * d, 107 * d, 12 * d, 12 * d, ICON); textLine(px, 60 * d, 107 * d, 80 * d, d);
    const fill = importFill(px, ROW_BOX(d));
    assertValueHidden(px, fill.rects, [36 * d, 56 * d, 120 * d, 36 * d]);
    assertBare(fill, [[46, 113], [70, 112], [120, 112]], d, `${d}x`);
    assert.deepEqual(fill.spared, ['bottom'], `${d}x`);
  }
});

test('a line wrapped to the container\'s edge is covered unless its first word takes the icon\'s place and its text the value\'s column, which is then named', () => {
  for (const d of [1, 2, 3]) {
    const row = (first, gap) => {
      const px = canvas(300 * d, 160 * d);
      px.fill(40 * d, 60 * d, 12 * d, 12 * d, ICON); textLine(px, 60 * d, 60 * d, 90 * d, d);
      textLine(px, 40 * d, 87 * d, first * d, d); textLine(px, (40 + first + gap) * d, 87 * d, 70 * d, d);
      return px;
    };
    const word = row(4, 6);
    const fill = importFill(word, ROW_BOX(d));
    assertValueHidden(word, fill.rects, [36 * d, 56 * d, 160 * d, 44 * d]);
    assert.deepEqual(fill.spared, [], `${d}x a short word`);
    const chance = row(12, 8);
    const spared = importFill(chance, ROW_BOX(d));
    assert.deepEqual(spared.spared, ['bottom'], `${d}x a word of the icon's size at its text column`);
    inPeek(spared, [[46, 92], [70, 92], [120, 92]], d, `${d}x`);
  }
});

test('a value boxed without its icon, or whose first run is a word, spares nothing', () => {
  for (const d of [1, 2]) {
    const px = iconList(d);
    const textOnly = importFill(px, [58 * d, 58 * d, 96 * d, 16 * d]);
    assert.deepEqual(textOnly.spared, [], `${d}x text only`);
    assertValueHidden(px, textOnly.rects, [36 * d, 56 * d, 120 * d, 72 * d]);
    const words = canvas(300 * d, 160 * d);
    for (let i = 0; i < 3; i += 1) { textLine(words, 40 * d, (60 + 27 * i) * d, 30 * d, d); textLine(words, 78 * d, (60 + 27 * i) * d, 60 * d, d); }
    const plain = importFill(words, [38 * d, 58 * d, 104 * d, 16 * d]);
    assert.deepEqual(plain.spared, [], `${d}x words`);
    assertValueHidden(words, plain.rects, [36 * d, 56 * d, 120 * d, 72 * d]);
  }
});

test('a two-line label beside a two-line value is no list: both lines of the value stay covered', () => {
  for (const d of [1, 2]) {
    const px = canvas(300 * d, 160 * d);
    textLine(px, 30 * d, 60 * d, 40 * d, d); textLine(px, 90 * d, 60 * d, 80 * d, d);
    textLine(px, 30 * d, 80 * d, 44 * d, d); textLine(px, 90 * d, 80 * d, 60 * d, d);
    textLine(px, 30 * d, 112 * d, 36 * d, d); textLine(px, 90 * d, 112 * d, 50 * d, d);
    const fill = importFill(px, [28 * d, 58 * d, 144 * d, 16 * d]);
    assertValueHidden(px, fill.rects, [26 * d, 56 * d, 150 * d, 36 * d]);
    assert.deepEqual(fill.spared, [], `${d}x`);
  }
});

// A blank tile with a hairline border and rounded bottom corners, narrower than the pad of the value's box 8 CSS
// px under it: the pad reaches into the tile, and the corners' rows differ from the tile's, so the walk takes
// them for ink at its edge and grows onto the tile.
test('an imported fill never grows into a slot\'s blank, and paints nothing inside it', () => {
  for (const d of [1, 2, 3]) {
    const px = canvas(320 * d, 180 * d).fill(99 * d, 19 * d, 142 * d, 102 * d, REGION_BORDER).fill(100 * d, 20 * d, 140 * d, 100 * d, REGION);
    px.fill(100 * d, 115 * d, d, 2 * d, REGION_BORDER).fill(239 * d, 115 * d, d, 2 * d, REGION_BORDER);
    textLine(px, 100 * d, 128 * d, 140 * d, d);
    const box = [96 * d, 128 * d, 148 * d, 10 * d];
    const pad = fillRect(px, box, { reach: 12, back: 2 });
    if (d === 1) {
      assert.equal(pad[1], 116, 'the 12 px pad reaches 4 px into the tile');
      assert.ok(importFill(px, box).rect[1] < 116, `without the blank the fill ${JSON.stringify(importFill(px, box).rects)} does not grow into the tile`);
    }
    const fill = importFill(px, box, { blanks: [[100 * d, 20 * d, 140 * d, 100 * d]] });
    // The own line's piece is painted its own back past the pad; nothing reaches into the tile past the pad.
    for (const rect of fill.rects) assert.ok(rect[1] >= Math.min(pad[1], 120 * d), `${d}x: ${rect} is painted into the tile past the pad ${pad}`);
    assertValueHidden(px, fill.rects, [84 * d, 121 * d, 172 * d, 22 * d]);
  }
});

const snapSlot = (geo, ...args) => [...geo.snapSlot(...args)];
const REGION = [241, 245, 249];
const REGION_BORDER = [226, 232, 240];
// A blank region [50, 30, 200, 100] with a 1 px border round it, on white.
const blankRegion = () => canvas(320, 180).fill(49, 29, 202, 102, REGION_BORDER).fill(50, 30, 200, 100, REGION);

test('a slot drawn by eye snaps each edge to the inside of its blank, either way', () => {
  assert.deepEqual(snapSlot(sandbox.__composeGeometry, blankRegion(), [46, 34, 206, 92]), [50, 30, 200, 100]);
});

test('a slot edge further than SLOT_SNAP from the blank stays where it was drawn', () => {
  assert.deepEqual(snapSlot(sandbox.__composeGeometry, blankRegion(), [40, 34, 206, 92]), [40, 30, 210, 100]);
});

test('a slot over text is no blank and stays as drawn', () => {
  const px = canvas(320, 80);
  px.fill(40, 23, 2, 10, INK);
  for (let x = 46; x < 150; x += 7) px.fill(x, 26, 4, 7, INK);
  assert.deepEqual(snapSlot(sandbox.__composeGeometry, px, [40, 20, 120, 16]), [40, 20, 120, 16]);
});

test('a slot over a gap does not snap onto the glyphs of the line beside it', () => {
  const px = canvas(200, 100);
  for (let x = 30; x < 80; x += 4) px.fill(x, 50, 3, 9, INK).fill(x + 1, 50, 1, 1, [120, 120, 120]);
  assert.deepEqual(snapSlot(sandbox.__composeGeometry, px, [40, 20, 28, 26]), [40, 20, 28, 26]);
});

test('a slot edge never moves to cover more of a fill', () => {
  const px = blankRegion().fill(60, 126, 120, 20, [203, 213, 225]);
  const keep = [[60, 126, 120, 20]];
  const box = snapSlot(sandbox.__composeGeometry, px, [46, 34, 206, 88], { keep });
  assert.ok(box[1] + box[3] <= 126, `the slot ${box} reaches into the fill`);
  assert.deepEqual(box.slice(0, 3), [50, 30, 200]);
});

test('two slot edges moving out together never take a fill in the corner between them', () => {
  const fill = [50, 30, 5, 5];
  const px = blankRegion().fill(...fill, [203, 213, 225]);
  const [x, y, w, h] = snapSlot(sandbox.__composeGeometry, px, [56, 36, 190, 90], { keep: [fill] });
  const overlap = Math.max(0, Math.min(x + w, 55) - Math.max(x, 50)) * Math.max(0, Math.min(y + h, 35) - Math.max(y, 30));
  assert.equal(overlap, 0, `the slot ${[x, y, w, h]} covers the fill in its corner`);
});

test('a slot that overlaps a fill may snap back off it, read past the fill', () => {
  const px = blankRegion().fill(60, 128, 120, 20, [203, 213, 225]);
  const box = snapSlot(sandbox.__composeGeometry, px, [46, 34, 206, 102], { keep: [[60, 128, 120, 20]] });
  assert.deepEqual(box, [50, 30, 200, 100]);
});

test('at scale 2 a slot snaps to twice its scale 1 box', () => {
  const one = snapSlot(sandbox.__composeGeometry, blankRegion(), [43, 34, 206, 92]);
  const two = snapSlot(atScale(2), doubled(blankRegion()), times2([43, 34, 206, 92]));
  assert.deepEqual(two, times2(one));
});

const holdsContent = (...args) => sandbox.__composeGeometry.holdsContent(...args);

test('a box over text holds content; a blank, or one a border merely crosses, holds none', () => {
  const text = canvas(200, 60);
  for (let x = 42; x < 110; x += 7) text.fill(x, 24, 4, 8, INK);
  assert.equal(holdsContent(text, [40, 20, 80, 16]), true);
  assert.equal(holdsContent(canvas(200, 60), [40, 20, 80, 16]), false);
  const ruled = canvas(200, 100).fill(80, 0, 1, 100, [203, 213, 225]);
  assert.equal(holdsContent(ruled, [40, 20, 80, 16]), false, 'a hairline running through the box is no content');
});

test('at scale 2 a slot too thin to read stays as given, as its 1x twin does', () => {
  assert.deepEqual(snapSlot(sandbox.__composeGeometry, blankRegion(), [53, 40, 1, 60]), [53, 40, 1, 60]);
  assert.deepEqual(snapSlot(atScale(2), doubled(blankRegion()), times2([53, 40, 1, 60])), times2([53, 40, 1, 60]));
});

const edgeGround = (...args) => { const ground = sandbox.__composeGeometry.edgeGround(...args); return ground && [...ground]; };

test('edgeGround reads the ground of the lines inside an edge, not the glyphs its own line runs through', () => {
  // Glyphs 8 px wide every 10 cover the box's bottom two rows, so its edge line is mostly ink.
  const px = canvas(200, 100);
  for (let x = 20; x < 120; x += 10) px.fill(x, 58, 8, 2, INK);
  const box = [20, 20, 100, 40];
  assert.deepEqual(edgeGround(px, box, 'bottom', [], 1), INK, 'the edge line alone is ink');
  assert.deepEqual(edgeGround(px, box, 'bottom', [], 12), [255, 255, 255], 'twelve lines in are mostly ground');
  assert.deepEqual(edgeGround(px, box, 'bottom', [], 0.4), INK, 'a depth under a line still reads the edge line');
  assert.deepEqual(edgeGround(px, box, 'top', [], 12), [255, 255, 255]);
});

test('edgeGround skips a fill, reads whole pixels inside a fractional box, and is null with nothing to read', () => {
  const px = canvas(200, 100).fill(20, 40, 100, 20, RED);
  assert.deepEqual(edgeGround(px, [20, 20, 100, 40], 'bottom', [], 12), RED, 'a fill across the lines reads as their colour');
  assert.equal(edgeGround(px, [20, 20, 100, 40], 'bottom', [[20, 40, 100, 20]], 12), null, 'a fill over every pixel leaves nothing to read');
  assert.deepEqual(edgeGround(px, [20, 20, 100, 40], 'bottom', [[20, 40, 60, 20]], 12), RED, 'the part of the lines beside the fill is read');
  // The bottom edge at y 39.6 keeps row 38 as its last whole line: row 39 is white, and red ends at 39.
  const half = canvas(200, 100).fill(20, 0, 100, 39, RED);
  assert.deepEqual(edgeGround(half, [20, 20, 100, 19.6], 'bottom', [], 1), RED);
});

const edgeInGap = (...args) => sandbox.__composeGeometry.edgeInGap(...args);
// A row of words: a 4 px word space at x 50-53 and a 2 px letter gap at x 84-85.
const wordRow = () => canvas(200, 60).fill(20, 20, 30, 12, INK).fill(54, 20, 30, 12, INK).fill(86, 20, 34, 12, INK);

test('edgeInGap holds an edge in a word space and not in a letter gap', () => {
  assert.equal(edgeInGap(wordRow(), [0, 0, 52, 60], 'right', null, []), true, 'x 51 lies in the 4 px word space');
  assert.equal(edgeInGap(wordRow(), [0, 0, 85, 60], 'right', null, []), false, 'x 84 lies in the 2 px letter gap');
  assert.equal(edgeInGap(wordRow(), [51, 0, 100, 60], 'left', null, []), true);
  assert.equal(edgeInGap(wordRow(), [20, 0, 100, 60], 'left', null, []), false, 'the left edge runs down the first word');
});

test('edgeInGap counts a run the bounds cut short, reads past an ignored rect, and refuses an edge into content', () => {
  assert.equal(edgeInGap(wordRow(), [0, 0, 86, 60], 'right', [0, 0, 86, 60], []), true, 'the letter gap runs to the bounds');
  const crossed = wordRow().fill(50, 24, 4, 4, RED);
  assert.equal(edgeInGap(crossed, [0, 0, 52, 60], 'right', null, []), false, 'a mark crosses the word space');
  assert.equal(edgeInGap(crossed, [0, 0, 52, 60], 'right', null, [[50, 24, 4, 4]]), true, 'and is ignored');
  assert.equal(edgeInGap(wordRow(), [0, 0, 52, 60], 'right', null, [], [{ rect: [40, 0, 20, 60], colour: [37, 99, 235] }]), false, 'the edge runs into a block of another colour');
  assert.equal(edgeInGap(wordRow(), [0, 0, 52, 60], 'right', null, [], [{ rect: [40, 0, 20, 60], colour: [255, 255, 255] }]), true, 'a block of the line\'s own colour is its ground');
});

test('at scale 2 edgeInGap answers as at scale 1', () => {
  for (const [box, side] of [[[0, 0, 52, 60], 'right'], [[0, 0, 85, 60], 'right'], [[51, 0, 100, 60], 'left']]) {
    assert.equal(atScale(2).edgeInGap(doubled(wordRow()), times2(box), side, null, []), edgeInGap(wordRow(), box, side, null, []), `${side} edge of ${box}`);
  }
});

const lensView = (...args) => {
  const { centre, hide } = sandbox.__composeGeometry.lensView(...args);
  return { centre: [...centre], hide: new Set(hide) };
};
// A 12 px badge at x 50-61, y 24-35, and a glyph 3 px wide to its left. A lens of radius 11 about the badge's
// centre (56, 30) shows the glyph's columns x 44 and 45, within a px of its circle, and not x 43.
const BADGE = [50, 24, 12, 12];
const badgeRow = () => canvas(100, 60).fill(...BADGE, BLUE).fill(43, 25, 3, 10, INK);
const pixelsOf = ([x, y, w, h], width) => Array.from({ length: w * h }, (_, i) => (y + Math.floor(i / w)) * width + x + (i % w));
const away = ([cx, cy], i, width) => Math.hypot((i % width) + 0.5 - cx, Math.floor(i / width) + 0.5 - cy);
const ALL = { bounds: [0, 0, 100, 60] };
// At radius 13 the circle about the badge shows x 42 of a glyph at x 41-43; 3 px left it holds the glyph whole.
const takeIn = () => canvas(100, 60).fill(...BADGE, BLUE).fill(41, 26, 3, 8, INK);

test('lensView moves the window the least that takes a glyph the circle cuts in whole', () => {
  const { centre, hide } = lensView(takeIn(), [56, 30], 13, BADGE, ALL);
  assert.deepEqual([centre, hide.size], [[53, 30], 0]);
  assert.ok(pixelsOf([41, 26, 3, 8], 100).every((i) => away(centre, i, 100) + Math.SQRT1_2 < 13), 'the glyph lies wholly in the circle');
  assert.ok([[50, 24], [62, 24], [50, 36], [62, 36]].every(([x, y]) => Math.hypot(x - centre[0], y - centre[1]) <= 12), 'and the badge a px clear of its edge');
});

test('lensView leaves out a glyph the circle cuts where no move that keeps the target whole takes it in', () => {
  // At radius 11 the badge allows a move of 3 px, and the glyph wants 4.
  const { centre, hide } = lensView(badgeRow(), [56, 30], 11, BADGE, ALL);
  assert.deepEqual(centre, [56, 30], 'the circle stays on the badge');
  assert.ok(pixelsOf([43, 25, 3, 10], 100).every((i) => hide.has(i)), 'every pixel of the glyph is left out');
  assert.ok(!pixelsOf(BADGE, 100).some((i) => hide.has(i)), 'no pixel of the badge is');
});

test('lensView leaves out only a sliver, never a glyph whole inside whose faint edge it shares', () => {
  // A second glyph at x 47-48 lies whole in the circle; a faint column at x 46 joins it to the sliver at x 43-45.
  const px = badgeRow().fill(47, 25, 2, 10, INK).fill(46, 25, 1, 10, [180, 180, 180]);
  const { centre, hide } = lensView(px, [56, 30], 11, BADGE, ALL);
  assert.deepEqual(centre, [56, 30]);
  assert.ok(pixelsOf([43, 25, 3, 10], 100).every((i) => hide.has(i)), 'the sliver is left out');
  assert.ok(!pixelsOf([46, 25, 3, 10], 100).some((i) => hide.has(i)), 'the glyph inside keeps every pixel, its faint edge too');
});

test('lensView moves to take in a glyph nearly whole inside, and leaves out the sliver it cannot take in', () => {
  // A glyph at x 64-66 is cut at the circle's right edge with most of it inside; 1 px right takes it in whole.
  const px = badgeRow().fill(64, 26, 3, 8, INK);
  const { centre, hide } = lensView(px, [56, 30], 11, BADGE, ALL);
  assert.deepEqual(centre, [57, 30]);
  assert.ok(pixelsOf([43, 25, 3, 10], 100).every((i) => hide.has(i)), 'the sliver is left out');
  assert.ok(!pixelsOf([64, 26, 3, 8], 100).some((i) => hide.has(i)), 'the glyph taken in is not');
});

test('lensView leaves a glyph nearly whole inside where no move takes it in', () => {
  // At radius 9 nothing moves; the glyph at x 63-64 shows all but the outer edge of its last column.
  const px = canvas(100, 60).fill(...BADGE, BLUE).fill(63, 27, 2, 6, INK);
  assert.deepEqual(lensView(px, [56, 30], 9, BADGE, ALL), { centre: [56, 30], hide: new Set() });
});

test('lensView reads a faint glyph as a glyph beside a target far darker than it', () => {
  const px = canvas(100, 60).fill(...BADGE, [0, 0, 0]).fill(43, 25, 3, 10, [150, 150, 150]);
  const { hide } = lensView(px, [56, 30], 11, BADGE, ALL);
  assert.ok(pixelsOf([43, 25, 3, 10], 100).every((i) => hide.has(i)), 'the faint sliver is left out');
});

test('lensView paints a glyph it leaves out from the ground beside it on its row', () => {
  const ground = (x) => Math.round(255 - x * 1.2);
  const px = canvas(100, 60);
  for (let x = 0; x < 100; x += 1) px.fill(x, 0, 1, 60, [ground(x), ground(x), ground(x)]);
  px.fill(...BADGE, BLUE).fill(43, 25, 3, 10, INK);
  const { hide, paint } = sandbox.__composeGeometry.lensView(px, [56, 30], 11, BADGE, ALL);
  assert.ok(hide.length > 0);
  hide.forEach((i, n) => assert.ok(Math.abs(paint[n][0] - ground(i % 100)) <= 2, `x ${i % 100} is painted ${paint[n][0]} on ground ${ground(i % 100)}`));
});

test('lensView reads a glyph apart from a neighbour its antialiased edge joins', () => {
  // A faint row of grey joins the glyph to one 13 px further left: 16 px of ink together, wider than the lens holds.
  const px = badgeRow().fill(30, 25, 3, 10, INK).fill(33, 29, 10, 1, [200, 200, 200]);
  const { hide } = lensView(px, [56, 30], 11, BADGE, ALL);
  assert.ok(pixelsOf([43, 25, 3, 10], 100).every((i) => hide.has(i)), 'the glyph is left out');
  assert.ok(!pixelsOf([30, 25, 3, 10], 100).some((i) => hide.has(i)), 'its neighbour is not');
});

test('lensView keeps a rule too long to take in whole, a glyph it sees whole, and a glyph under a kept rect', () => {
  const none = (px, radius, keep) => assert.deepEqual(lensView(px, [56, 30], radius, BADGE, { ...ALL, keep }), { centre: [56, 30], hide: new Set() });
  none(canvas(100, 60).fill(...BADGE, BLUE).fill(0, 42, 100, 1, INK), 15);
  none(canvas(100, 60).fill(...BADGE, BLUE).fill(46, 26, 2, 8, INK), 11);
  none(badgeRow(), 11, [[43, 25, 3, 10]]);
});

test('lensView reads no ink outside its bounds', () => {
  const { centre, hide } = lensView(badgeRow(), [56, 30], 11, BADGE, { bounds: [47, 0, 53, 60] });
  assert.deepEqual([centre, hide.size], [[56, 30], 0]);
});

test('at scale 2 lensView moves the window, or leaves a glyph out, as at scale 1', () => {
  const moved = atScale(2).lensView(doubled(takeIn()), [112, 60], 26, times2(BADGE), { bounds: [0, 0, 200, 120] });
  assert.deepEqual([...moved.centre].map((v) => v / 2), [53, 30]);
  const left = atScale(2).lensView(doubled(badgeRow()), [112, 60], 22, times2(BADGE), { bounds: [0, 0, 200, 120] });
  assert.deepEqual([...left.centre], [112, 60]);
  const hidden = new Set(left.hide);
  assert.ok(pixelsOf(times2([43, 25, 3, 10]), 200).every((i) => hidden.has(i)), 'every pixel of the glyph is left out');
});
