import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const sandbox = {};
vm.runInNewContext(await readFile(new URL('../../lib/compose/page-geometry.js', import.meta.url), 'utf8'), sandbox);
const { edgeIsClean, LIFT_BAND } = sandbox.__composeGeometry;
const cropToMarks = (...args) => {
  const { box, edges } = sandbox.__composeGeometry.cropToMarks(...args);
  return { box: [...box], edges: edges && { ...edges } };
};
const cleanFrame = (...args) => {
  const { frame, edges, cut } = sandbox.__composeGeometry.cleanFrame(...args);
  return { frame: [...frame], edges: { ...edges }, cut };
};
const cleanPad = (...args) => [...sandbox.__composeGeometry.cleanPad(...args)];
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
  const px = canvas(120, 120).fill(47, 54, 1, 3, INK).fill(62, 54, 1, 3, INK);
  assert.deepEqual(cleanPad(px, [50, 50, 12, 12], 4), [1, 4, 0, 4]);
});

test('padding keeps one clean line between its outer edge and content', () => {
  assert.deepEqual(cleanPad(canvas(120, 120).fill(44, 54, 1, 3, INK), [50, 50, 12, 12], 4), [4, 4, 4, 4]);
  assert.deepEqual(cleanPad(canvas(120, 120).fill(45, 54, 1, 3, INK), [50, 50, 12, 12], 4), [3, 4, 4, 4]);
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
  assert.deepEqual(out, [136, 102, 206, 116]);
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
  assert.deepEqual(box, [136, 94, 168, 124]);
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

test('a rule must hold its colour 24px on both sides of the edge line', () => {
  const box = [100, 10, 60, 80];
  assert.equal(edgeIsClean(canvas(300, 100).fill(100, 40, 160, 1, GREY), box, 'left'), false, 'runs only one way');
  assert.equal(edgeIsClean(canvas(300, 100).fill(88, 40, 24, 2, INK), box, 'left'), false, '24px long, crossed at its middle');
  assert.equal(edgeIsClean(canvas(300, 100).fill(76, 40, 49, 2, GREY), box, 'left'), false, '49px long is a rule at the edge line only: the band lines beside it are not');
  assert.equal(edgeIsClean(canvas(300, 100).fill(70, 40, 56, 2, GREY), box, 'left'), true, '56px long, crossed at its middle, holds its colour 24px beyond every line of the band');
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

const slideDot = (...args) => sandbox.__composeGeometry.slideDot(...args);

test('a dot whose centre is clean does not slide', () => {
  assert.equal(slideDot(0, 100, 50, () => true), 50);
});

test('a dot slides to the nearest clean spot in 2px steps, either way', () => {
  assert.equal(slideDot(0, 100, 50, (p) => p >= 59), 60, 'only whole steps from the centre are tried');
  assert.equal(slideDot(0, 100, 50, (p) => p <= 38), 38);
  assert.equal(slideDot(0, 100, 50, (p) => p >= 60 || p <= 36), 60, 'the nearer spot wins');
});

test('two clean spots equally near: the lower one wins', () => {
  assert.equal(slideDot(0, 100, 50, (p) => p === 44 || p === 56), 44);
});

test('a dot stays 6px in from each end of the side and never probes beyond', () => {
  const probed = [];
  assert.equal(slideDot(0, 100, 50, (p) => { probed.push(p); return false; }), null);
  assert.equal(Math.min(...probed), 6);
  assert.equal(Math.max(...probed), 94);
  assert.equal(slideDot(0, 100, 50, (p) => p <= 6), 6);
  assert.equal(slideDot(0, 100, 50, (p) => p <= 5), null, 'a spot inside the inset is not offered');
  assert.equal(slideDot(0, 100, 50, (p) => p >= 95), null);
});

test('with no clean spot on the side there is no position', () => {
  assert.equal(slideDot(10, 70, 40, () => false), null);
});

test('a side shorter than twice the inset offers its centre only', () => {
  assert.equal(slideDot(0, 10, 5, () => true), 5);
  assert.equal(slideDot(0, 10, 5, (p) => p !== 5), null);
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
