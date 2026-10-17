// The reviewers' fuzz of a fill on random pixels, run in workers side by side. A worker gets { geometrySource, kind,
// seed, part, parts }, draws every case of the seed and checks those whose index is `part` modulo `parts`, then posts
// the failures it found (at most 10) and how many cases it checked.
import vm from 'node:vm';
import { parentPort, workerData } from 'node:worker_threads';

// A reconstruction of the fill before imports grew (a25cc09): the box and its reach, shrunk to the content inside,
// then grown back by `back`.
const clampTo = ([x, y, w, h], [ox, oy, ow, oh]) => { const x0 = Math.max(x, ox); const y0 = Math.max(y, oy); return [x0, y0, Math.min(x + w, ox + ow) - x0, Math.min(y + h, oy + oh) - y0]; };
const firstFill = (geo, px, [bx, by, bw, bh], reach, back) => {
  const x0 = Math.floor(bx - reach); const y0 = Math.floor(by - reach);
  const outer = clampTo([x0, y0, Math.ceil(bx + bw + reach) - x0, Math.ceil(by + bh + reach) - y0], [0, 0, px.width, px.height]);
  const [x, y, w, h] = geo.contentBox(px, outer);
  const [fx, fy, fw, fh] = clampTo([x - back, y - back, w + 2 * back, h + 2 * back], outer);
  return [fx, fy, Math.max(0, fw), Math.max(0, fh)];
};
const holds = (a, b) => b[2] <= 0 || b[3] <= 0 || (a[0] <= b[0] && a[1] <= b[1] && a[0] + a[2] >= b[0] + b[2] && a[1] + a[3] >= b[1] + b[3]);
const random = (seed) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

// An imported fill holds its pad's fill and the first fill, and grows no further out than its bounds.
function importFills(geo, seed, part, parts) {
  const rnd = random(seed); const failures = []; let ran = 0;
  for (let i = 0; i < 8000; i += 1) {
    const W = 60 + Math.floor(rnd() * 260); const H = 40 + Math.floor(rnd() * 160);
    const data = new Uint8ClampedArray(W * H * 4);
    const bg = rnd() < 0.3 ? [17, 24, 39] : rnd() < 0.5 ? [255, 255, 255] : [246, 247, 249];
    for (let p = 0; p < W * H; p += 1) data.set([...bg, 255], p * 4);
    const kinds = 1 + rnd() * 12;
    for (let k = 0; k < kinds; k += 1) {
      const c = [rnd() * 255, rnd() * 255, rnd() * 255].map(Math.floor);
      const x = Math.floor(rnd() * W); const y = Math.floor(rnd() * H);
      const shape = rnd();
      const w = shape < 0.3 ? Math.floor(rnd() * 200) : Math.floor(rnd() * 40); const h = shape < 0.3 ? 1 + Math.floor(rnd() * 4) : Math.floor(rnd() * 20);
      for (let yy = y; yy < Math.min(H, y + h); yy += 1) for (let xx = x; xx < Math.min(W, x + w); xx += 1) { if (shape > 0.6 && xx % 3 === 0) continue; data.set([...c, 255], (yy * W + xx) * 4); }
    }
    const px = { data, width: W, height: H };
    const box = [rnd() * (W + 40) - 30, rnd() * (H + 40) - 30, rnd() * 80, rnd() * 40].map((v) => (rnd() < 0.5 ? Math.round(v) : v));
    const bounds = rnd() < 0.5 ? null : [Math.floor(rnd() * 30), Math.floor(rnd() * 30), W - Math.floor(rnd() * 60), H - Math.floor(rnd() * 40)];
    const keep = rnd() < 0.5 ? [] : [[rnd() * W, rnd() * H, rnd() * 50, rnd() * 30]];
    if (i % parts !== part) continue;
    ran += 1;
    const fill = geo.importFill(px, box, { pad: 12, back: 2, bounds, keep });
    const pad = [...geo.fillRect(px, box, { reach: 12, back: 2 })];
    const rect = fill.rects.find((q) => holds(q, pad));
    const at = `seed ${seed} case ${i} box ${box}`;
    if (!rect) failures.push(`${at}: no rect of ${JSON.stringify(fill.rects)} holds the pad's ${pad}`);
    else if (!holds(rect, firstFill(geo, px, box, 12, 2))) failures.push(`${at}: the fill ${rect} is smaller than the first fill`);
    else if (bounds && fill.grew && (rect[0] < Math.min(pad[0], Math.max(0, bounds[0])) || rect[1] < Math.min(pad[1], Math.max(0, bounds[1])))) failures.push(`${at}: the fill ${rect} grew past its bounds ${bounds}`);
    if (failures.length >= 10) break;
  }
  return { ran, failures };
}

// A live fill, and the fill of an imported box at its reach, is still the first fill at 1x, 1.5x and 2x.
function liveFills(geo, seed, part, parts) {
  const rnd = random(seed); const failures = []; let ran = 0;
  for (let i = 0; i < 6000; i += 1) {
    const scale = [1, 1, 2, 1.5][i % 4]; const imported = i % 3 !== 0;
    const at = scale === 1 ? geo : geo.withScale(scale);
    const W = 80 + Math.floor(rnd() * 160); const H = 60 + Math.floor(rnd() * 100);
    const data = new Uint8ClampedArray(W * H * 4);
    const bg = rnd() < 0.3 ? [17, 24, 39] : [255, 255, 255];
    for (let p = 0; p < W * H; p += 1) data.set([...bg, 255], p * 4);
    for (let k = 0; k < 1 + rnd() * 6; k += 1) {
      const c = [rnd() * 255, rnd() * 255, rnd() * 255].map(Math.floor); const x = Math.floor(rnd() * W); const y = Math.floor(rnd() * H); const w = Math.floor(rnd() * 40); const h = Math.floor(rnd() * 20);
      for (let yy = y; yy < Math.min(H, y + h); yy += 1) for (let xx = x; xx < Math.min(W, x + w); xx += 1) { const a = rnd() < 0.2 ? Math.floor(rnd() * 255) : null; data.set([...(a === null ? c : [a, a, a]), 255], (yy * W + xx) * 4); }
    }
    const px = { data, width: W, height: H };
    const box = [rnd() * (W + 40) - 30, rnd() * (H + 40) - 30, rnd() * 60, rnd() * 30].map((v) => (rnd() < 0.5 ? Math.round(v) : v));
    const reach = imported ? 12 : 2 * scale; const back = 2 * scale;
    if (i % parts !== part) continue;
    ran += 1;
    const first = firstFill(at, px, box, reach, back); const now = [...at.fillRect(px, box, { reach, back })];
    // An empty fill may sit anywhere along its empty side.
    if ((first[2] === 0 && now[2] === 0) || (first[3] === 0 && now[3] === 0)) continue;
    if (now.join() !== first.join()) failures.push(`case ${i} at ${scale}x box ${box}: ${now}, first ${first}`);
    if (failures.length >= 10) break;
  }
  return { ran, failures };
}

if (parentPort) {
  const sandbox = {};
  vm.runInNewContext(workerData.geometrySource, sandbox);
  const run = { import: importFills, live: liveFills }[workerData.kind];
  parentPort.postMessage(run(sandbox.__composeGeometry, workerData.seed, workerData.part, workerData.parts));
}
