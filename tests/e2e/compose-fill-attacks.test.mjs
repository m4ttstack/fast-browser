// Every reviewer attack set on an imported redaction fill (helpers/fill-attacks.mjs), run whole. A case passes when
// its value is hidden, its board is refused, or its board warns that ink is left past the fill; a silent case, a
// written board showing the value with no such warning, fails. Each set's size is pinned so none can shrink.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import { boardAttackScenes, fillAttackCases, runBoardScene, verdictOf } from './helpers/fill-attacks.mjs';
import { runFillProbes } from './helpers/fill-probes.mjs';
import { rendererForTests } from './helpers/renderer.mjs';

const renderer = await rendererForTests();
const skip = renderer ? false : 'skipped by FAST_BROWSER_SKIP_COMPOSE_E2E=1';
const geometrySource = await readFile(new URL('../../lib/compose/page-geometry.js', import.meta.url), 'utf8');

const sizes = (results) => results.reduce((n, r) => ({ ...n, [r.set]: (n[r.set] ?? 0) + 1 }), {});
const silent = (results) => results.filter((r) => verdictOf(r) === 'silent').map((r) => `${r.set} ${r.name}: ${r.bare} px`).sort();

// The cases run on SHARDS browsers side by side: the pixel reading is the cost, and each browser reads on its own.
const SHARDS = 6;
async function probe(sets) {
  const { chromium } = await import(renderer.playwrightCore);
  const cases = fillAttackCases().filter((c) => sets.includes(c.set));
  const shards = Array.from({ length: SHARDS }, (_, k) => cases.filter((_c, i) => i % SHARDS === k));
  const results = await Promise.all(shards.map(async (shard) => {
    const browser = await chromium.launch({ headless: true, executablePath: renderer.executablePath });
    try { return await runFillProbes({ browser, cases: shard, geometrySource }); } finally { await browser.close(); }
  }));
  return results.flat().map((r) => ({ ...r, warned: r.capped > 0 || r.near > 0 }));
}

const GROUND = {
  A3x: 57, Bwide: 24, Cwrap: 18, Dtable: 12, Echip: 27, Favatar: 27, Gdensity: 68, C2wrapleft: 9, Hdensity: 390, C3wrapleft: 6,
  Ibar: 252, Jwrap: 138, Kname: 180, Lright: 18, Mreach: 21, N3line: 720, Pleft: 360, Qfrac: 81, P2left: 180, P3left: 27,
  Rfaint: 18, S1far: 24, S2rtl: 24, S3hang: 18, S4grid: 36, S5three: 27, F1fainter: 9, F2ground: 48, Ggrid: 78, G2inline: 36,
  G3mixed: 24, Hpitch: 168, Hthree: 36, Hlabellh: 36, Hvaluelh: 48, Hcaps: 108,
};

test('an imported fill hides, refuses or truthfully warns on every case of the white-ground attack sets', { skip }, async () => {
  const results = await probe(Object.keys(GROUND));
  assert.deepEqual(sizes(results), GROUND, 'every case of every set ran');
  assert.deepEqual(silent(results), [], 'no written board shows its value without a warning that ink is left');
  assert.deepEqual(results.filter((r) => !r.holds).map((r) => `${r.set} ${r.name}`), [], 'no fill is smaller than the 12 px pad\'s');
});

const DECORATED = {
  U1link: 576, U2valuelink: 288, U3under: 120, S1strike: 48, W1overflow: 120, T1tiny: 24, T1dash: 108, I1input: 270, R1rowspan: 144,
  R2cellwrap: 36, C1corner: 108, K1clear: 108, V1side: 54, V2stems: 36, E1valuewrap: 360, E2email: 120, E3phrase: 120, F1midlink: 384,
  F2startlink: 384, F3phrase: 192, F4border: 120,
};

test('an imported fill hides, refuses or truthfully warns on every case of the underline, rule and border attack sets', { skip }, async () => {
  const results = await probe(Object.keys(DECORATED));
  assert.deepEqual(sizes(results), DECORATED, 'every case of every set ran');
  assert.deepEqual(silent(results), [], 'no written board shows its value without a warning that ink is left');
  assert.deepEqual(results.filter((r) => !r.holds).map((r) => `${r.set} ${r.name}`), [], 'no fill is smaller than the 12 px pad\'s');
});

const BOARDS = { run: 4, run3: 7, run6: 30, run7: 39, run8: 30, run9: 24, run10: 18, run11: 4, run12: 8, run13: 5, run14: 3, run15: 3, e1: 3 };

test('a composed board hides, refuses or truthfully warns on every imported attack page', { skip }, async () => {
  const { chromium } = await import(renderer.playwrightCore);
  const browser = await chromium.launch({ headless: true, executablePath: renderer.executablePath });
  const scenes = boardAttackScenes();
  const results = [];
  try {
    const queue = [...scenes];
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (let scene = queue.shift(); scene; scene = queue.shift()) results.push(await runBoardScene({ browser, renderer, scene }));
    }));
  } finally { await browser.close(); }
  assert.deepEqual(sizes(results), BOARDS, 'every page of every set was composed');
  assert.deepEqual(silent(results), [], 'no written board shows its value without a warning that ink is left');
});

const fuzz = (kind, seed, parts) => Promise.all(Array.from({ length: parts }, (_, part) => new Promise((resolve, reject) => {
  const worker = new Worker(new URL('./helpers/fill-fuzz.mjs', import.meta.url), { workerData: { geometrySource, kind, seed, part, parts } });
  worker.once('message', resolve);
  worker.once('error', reject);
})));

test('fuzz: an imported fill never shrinks below its pad\'s fill or the first fill, and never grows past its bounds', async () => {
  const runs = (await Promise.all([11, 7, 23, 99, 1234].map((seed) => fuzz('import', seed, 2)))).flat();
  assert.deepEqual(runs.flatMap((r) => r.failures), []);
  assert.equal(runs.reduce((n, r) => n + r.ran, 0), 40000);
});

test('fuzz: a live fill is still the first fill, at 1x, 1.5x and 2x', async () => {
  const runs = await fuzz('live', 7, 1);
  assert.deepEqual(runs.flatMap((r) => r.failures), []);
  assert.equal(runs[0].ran, 6000);
});
