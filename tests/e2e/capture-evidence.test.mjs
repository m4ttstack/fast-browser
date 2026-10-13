import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { compose } from '../../lib/commands/compose.mjs';
import { loadCapture } from '../../lib/compose/capture.mjs';
import { renderBoard } from '../../lib/compose/engine.mjs';
import { resolvePaths } from '../../lib/core/paths.mjs';
import { readPngSize } from '../../lib/annotate/png.mjs';
import { servePages, startCaptureTool } from './helpers/capture-tool.mjs';
import { writeSidecar } from './helpers/capture-sidecar.mjs';
import { assertInvariants } from './helpers/invariants.mjs';
import { readPixels } from './helpers/png-pixels.mjs';
import { rendererForTests } from './helpers/renderer.mjs';
import { comparePngs } from './helpers/sharpness.mjs';

const renderer = await rendererForTests();
const skip = renderer ? false : 'skipped by FAST_BROWSER_SKIP_COMPOSE_E2E=1';
const source = await readFile(new URL('./helpers/capture-evidence.js', import.meta.url), 'utf8');
// The helper script is a single async arrow expression, evaluated as one.
const macro = new Function(`return (${source});`)();
const pageUrl = (name) => pathToFileURL(path.resolve(`tests/fixtures/evidence/pages/${name}.html`)).href;

async function withTool(pageName, body, { inline, ...options } = {}) {
  let home; let pages; let tool;
  try {
    home = await mkdtemp(path.join(tmpdir(), 'fb-captool-'));
    pages = await servePages({ inline });
    tool = await startCaptureTool({ home, renderer, ...options });
    await tool.call('browser_navigate', { url: pages.url(pageName) });
    return await body({ tool, home, pages });
  } finally {
    await tool?.close().catch(() => {});
    await pages?.close().catch(() => {});
    if (home) await rm(home, { recursive: true, force: true }).catch(() => {});
  }
}

function fetchStatus(url, agent) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { agent, timeout: 3000 }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('timeout', () => request.destroy(new Error(`no response from ${url} within 3s`)));
    request.on('error', reject);
  });
}

test('the page server answers a missing page and the favicon with 404 and keeps serving', async () => {
  const pages = await servePages();
  try {
    const origin = new URL(pages.url('nested-cards')).origin;
    assert.equal(await fetchStatus(`${origin}/no-such-page.html`), 404);
    assert.equal(await fetchStatus(`${origin}/favicon.ico`), 404);
    assert.equal(await fetchStatus(pages.url('nested-cards')), 200);
  } finally { await pages.close(); }
});

// Node's server.close() already drops idle keep-alive sockets; a request still in flight, as a browser tab leaves, is what holds it open.
test('the page server closes within a second while a client holds connections open', async () => {
  const pages = await servePages();
  const agent = new http.Agent({ keepAlive: true });
  let stalled;
  try {
    assert.equal(await fetchStatus(pages.url('nested-cards'), agent), 200);
    const { port } = new URL(pages.url('nested-cards'));
    stalled = net.connect({ port: Number(port), host: '127.0.0.1' });
    await new Promise((resolve) => stalled.once('connect', resolve));
    stalled.write('GET /nested-cards.html HTTP/1.1\r\nHost: 127.0.0.1\r\n');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const closed = await Promise.race([
      pages.close().then(() => true),
      new Promise((resolve) => setTimeout(resolve, 1000, false)),
    ]);
    assert.equal(closed, true, 'close() did not resolve within 1s of connections a client holds open');
  } finally { agent.destroy(); stalled?.destroy(); }
});

test('the tool: auto frame snaps to the card, at 2x, with a sidecar compose loads', { skip }, async () => {
  await withTool('nested-cards', async ({ tool }) => {
    const result = await tool.capture({ targets: { owner: '[data-testid=owner]', reviewer: '[data-testid=reviewer]' }, out: 'cap' });
    assert.equal(result.schemaVersion, 'capture-evidence/1');
    assert.equal(result.frameSnap, 'card');
    assert.equal(result.scale, 2);
    assert.ok(result.frame[2] < 1000 && result.frame[3] < 700);
    assert.deepEqual(Object.keys(result.boxes).sort(), ['owner', 'reviewer']);
    assert.equal(result.png, path.join(tool.captureDir, 'cap.png'));
    const capture = await loadCapture({ sidecarPath: result.sidecar, fail: (message) => new Error(message) });
    assert.deepEqual(capture.size, [2000, 1400]);
    assert.deepEqual(capture.frame, result.frame.map((n) => n * 2));
  });
});

test('the tool: an ambiguous selector is missed, never guessed', { skip }, async () => {
  await withTool('repeated-rows', async ({ tool }) => {
    const result = await tool.capture({ targets: { edit: 'button', bravo: '[data-testid=row-b] >> text=Bravo' }, out: 'cap' });
    assert.deepEqual(result.missed, [{ key: 'edit', reason: 'ambiguous', count: 3 }]);
    assert.ok(result.boxes.bravo);
  });
});

test('the tool: a dark surface is reported as dark', { skip }, async () => {
  await withTool('dark-surface', async ({ tool }) => {
    assert.equal((await tool.capture({ targets: { value: '[data-testid=value]' }, out: 'cap' })).dark, true);
  });
});

test('the tool: a heading-only strip is not a frame', { skip }, async () => {
  await withTool('heading-strip', async ({ tool }) => {
    assert.equal((await tool.capture({ targets: { heading: '[data-testid=heading]' }, out: 'cap' })).frameSnap, 'union');
  });
});

test('the tool: targets too far apart capture nothing', { skip }, async () => {
  await withTool('far-targets', async ({ tool }) => {
    const result = await tool.capture({ targets: { top: '[data-testid=top]', bottom: '[data-testid=bottom]' }, out: 'cap' });
    assert.equal(result.failedStep, 'frame');
    assert.equal(result.frameSnap, 'too-large');
  });
});

test('the tool: a tiny badge is measured in CSS pixels', { skip }, async () => {
  await withTool('tiny-badge', async ({ tool }) => {
    const result = await tool.capture({ targets: { badge: '[data-testid=badge]', title: '[data-testid=title]' }, out: 'cap' });
    assert.equal(result.boxes.badge[2], 12);
  });
});

test('the tool: a failed call leaves no tags for the next call on the same page', { skip }, async () => {
  await withTool('nested-cards', async ({ tool }) => {
    const first = await tool.capture({ frame: '[data-testid=nothing]', targets: { owner: '[data-testid=owner]' }, out: 'cap' });
    assert.equal(first.failedStep, 'frame');
    const second = await tool.capture({ targets: { contact: '[data-testid=contact]' }, out: 'cap' });
    assert.deepEqual(Object.keys(second.boxes), ['contact']);
    assert.notEqual(second.frameSnap, 'selector');
  });
});

for (const [edge, fixture] of [['right', 'off-right-edge'], ['left', 'off-left-edge']]) {
  test(`the tool: a target clipped by the ${edge} edge is missed as out-of-view`, { skip }, async () => {
    await withTool(fixture, async ({ tool }) => {
      const result = await tool.capture({ targets: { inside: '[data-testid=inside]', clipped: '[data-testid=clipped]' }, out: 'cap' });
      assert.deepEqual(result.missed, [{ key: 'clipped', reason: 'out-of-view' }]);
      assert.deepEqual(Object.keys(result.boxes), ['inside']);
    });
  });
}

test('the tool: an explicit frame that does not contain every target fails', { skip }, async () => {
  await withTool('frame-misses-target', async ({ tool }) => {
    const result = await tool.capture({ frame: '[data-testid=panel]', targets: { in: '[data-testid=in]', out: '[data-testid=out]' }, out: 'cap' });
    assert.deepEqual(result, { failedStep: 'frame', error: 'the frame selector does not contain every target' });
  });
});

test('the tool: a 2x capture matches a native DPR 2 render, and an upscaled 1x does not', { skip }, async () => {
  await withTool('nested-cards', async ({ tool, pages }) => {
    const result = await tool.capture({ targets: { owner: '[data-testid=owner]' }, out: 'sharp' });
    assert.equal(result.scale, 2);
    await tool.call('browser_take_screenshot', { filename: 'one.png', scale: 'css' });
    const scrollText = tool.text(await tool.call('browser_evaluate', { function: '() => JSON.stringify([scrollX, scrollY])' }));
    const scrollMatch = scrollText.match(/\[\s*-?[\d.]+\s*,\s*-?[\d.]+\s*\]/);
    assert.ok(scrollMatch, `the scroll position could not be read from: ${scrollText}`);
    const scroll = JSON.parse(scrollMatch[0]);
    const { chromium } = await import(renderer.playwrightCore);
    const browser = await chromium.launch({ headless: true, executablePath: renderer.executablePath });
    let reference;
    try {
      const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 2 });
      await page.goto(pages.url('nested-cards'));
      await page.evaluate(([x, y]) => scrollTo(x, y), scroll);
      reference = await page.screenshot({ scale: 'device' });
    } finally { await browser.close(); }
    const verdict = await comparePngs({ tool: await readFile(result.png), reference, oneX: await readFile(path.join(tool.outputDir, 'one.png')), renderer });
    assert.equal(verdict.sameSize, true);
    assert.ok(verdict.upscaledDiffering > 1000, 'the page has enough text for an upscale to show');
    assert.ok(verdict.differing * 50 <= verdict.upscaledDiffering, `${verdict.differing} pixels differ from the native render; an upscale differs by ${verdict.upscaledDiffering}`);
  });
});

const live = skip || (process.env.FAST_BROWSER_LIVE_E2E === '1' ? false : 'live only: set FAST_BROWSER_LIVE_E2E=1 (drives the real Chrome)');

// The reference is a metrics-override capture of the same page in the same
// Chrome: headed and headless Chromium rasterise text differently.
test('live: a 2x capture through the real relay is sharp and returns in time', { skip: live }, async () => {
  let home; let pages;
  try {
    home = await mkdtemp(path.join(tmpdir(), 'fb-caplive-'));
    pages = await servePages();
    const env = process.env.FAST_BROWSER_LIVE_EXTENSION_TOKEN ? { PLAYWRIGHT_MCP_EXTENSION_TOKEN: process.env.FAST_BROWSER_LIVE_EXTENSION_TOKEN } : {};
    const run = async (strategy, out, alsoOneX) => {
      let tool;
      try {
        tool = await startCaptureTool({ home, renderer, mode: 'extension', env: { ...env, PLAYWRIGHT_MCP_CAPTURE_2X: strategy } });
        // Navigation waits for the connection to be allowed in Chrome when no token is set.
        await tool.call('browser_navigate', { url: pages.url('nested-cards') }, 120_000);
        const started = Date.now();
        let timer;
        let result;
        try {
          result = await Promise.race([
            tool.capture({ targets: { owner: '[data-testid=owner]' }, out }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the capture did not return within 20s')), 20_000); }),
          ]);
        } finally { clearTimeout(timer); }
        const ms = Date.now() - started;
        if (alsoOneX) await tool.call('browser_take_screenshot', { filename: 'one.png', scale: 'css' });
        return { result, ms };
      } finally { await tool?.close().catch(() => {}); }
    };
    const clip = await run('clip', 'live-clip', true);
    const override = await run('override', 'live-override', false);
    assert.ok(clip.ms < 20_000, `the clip capture took ${clip.ms}ms`);
    assert.ok(override.ms < 20_000, `the override capture took ${override.ms}ms`);
    assert.equal(clip.result.scale, 2);
    assert.deepEqual(clip.result.frame, override.result.frame, 'both captures saw the same layout');
    const verdict = await comparePngs({
      tool: await readFile(clip.result.png), reference: await readFile(override.result.png),
      oneX: await readFile(path.join(home, '.fast-browser', 'output', 'one.png')), renderer,
    });
    assert.equal(verdict.sameSize, true);
    assert.ok(verdict.upscaledDiffering > 1000, 'the page has enough text for an upscale to show');
    assert.ok(verdict.differing * 50 <= verdict.upscaledDiffering, `${verdict.differing} pixels differ from the override capture; an upscale differs by ${verdict.upscaledDiffering}`);
    console.log(`live capture times: clip ${clip.ms}ms, override ${override.ms}ms`);
  } finally {
    await pages?.close().catch(() => {});
    if (home) await rm(home, { recursive: true, force: true }).catch(() => {});
  }
});

const specDir = path.resolve('tests/fixtures/evidence/specs');

const inputsOf = (fixture) => fixture.panels.map((panel, i) => panel.fixture ?? (i === 0 ? { page: fixture.page, targets: fixture.targets, frame: fixture.frame } : {}));

// `deviceScaleFactor` is one number for every live panel, or one per panel; an imported panel is always at scale 1.
async function boardReport({ file, deviceScaleFactor }) {
  const home = await mkdtemp(path.join(tmpdir(), 'fb-twin-'));
  try {
    const paths = resolvePaths({ homeDir: home, pluginRoot: path.resolve('.') });
    const fixture = JSON.parse(await readFile(path.join(specDir, file), 'utf8'));
    const stem = path.basename(file, '.json');
    const { chromium } = await import(renderer.playwrightCore);
    const browser = await chromium.launch({ headless: true, executablePath: renderer.executablePath });
    const sidecars = [];
    try {
      for (const [i, input] of inputsOf(fixture).entries()) {
        if (input.import) {
          const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: input.import.dpr });
          await page.goto(pageUrl(input.import.page));
          const shot = path.join(home, `${stem}.c${i + 1}.${input.import.format}`);
          await page.screenshot({ path: shot, type: input.import.format, quality: input.import.format === 'jpeg' ? 92 : undefined });
          await page.close();
          const { sidecar } = await compose({ command: 'compose', import: shot, out: `${stem}.c${i + 1}`, origin: 'https://tracker.example/issues/1' }, { paths, rendererLocation: async () => renderer });
          sidecars.push(sidecar);
          continue;
        }
        const scale = Array.isArray(deviceScaleFactor) ? deviceScaleFactor[i] : deviceScaleFactor;
        const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: scale });
        await page.goto(pageUrl(input.page ?? stem));
        const captureReturn = await macro(page, { targets: input.targets, out: `${stem}.c${i + 1}`, home, frame: input.frame });
        assert.equal(captureReturn.failedStep, undefined);
        if (scale === 2) {
          // The script leaves the page where it measured it; the same view at device pixels is the 2x twin.
          await page.screenshot({ path: captureReturn.png, scale: 'device' });
          captureReturn.scale = 2;
        }
        await page.close();
        sidecars.push((await writeSidecar(captureReturn)).sidecar);
      }
    } finally { await browser.close(); }
    const imageSizes = [];
    for (const sidecar of sidecars) {
      const { image } = JSON.parse(await readFile(sidecar, 'utf8'));
      const { width, height } = readPngSize(await readFile(path.join(path.dirname(sidecar), image)));
      imageSizes.push([width, height]);
    }
    const spec = { ...fixture, panels: fixture.panels.map(({ fixture: _input, ...panel }, i) => ({ ...panel, capture: path.basename(sidecars[i]) })) };
    delete spec.targets; delete spec.page; delete spec.expect; delete spec.frame;
    const specPath = path.join(paths.screenshotsDir, `${stem}.spec.json`);
    await writeFile(specPath, JSON.stringify(spec));
    let report;
    await compose({ command: 'compose', spec: specPath }, {
      paths, rendererLocation: async () => renderer,
      renderBoard: async (args) => { const r = await renderBoard(args); report = r.report; return r; },
    });
    return { ...report, imageSizes };
  } finally { await rm(home, { recursive: true, force: true }); }
}

const near = (a, b, tolerance, what) => {
  assert.equal(a.length, b.length, `${what}: ${a} against ${b}`);
  a.forEach((value, i) => assert.ok(Math.abs(value - b[i]) <= tolerance, `${what}: ${a} against ${b}`));
};

const fixtures = [];
for (const file of (await readdir(specDir)).filter((f) => f.endsWith('.json'))) {
  const inputs = inputsOf(JSON.parse(await readFile(path.join(specDir, file), 'utf8')));
  fixtures.push({ file, imported: inputs.map((input) => Boolean(input.import)) });
}
// An imported image is never taken at a device scale, so a board with one has no 2x twin of that panel.
const liveFixtures = fixtures.filter(({ imported }) => !imported.some(Boolean));
// Boards that mix scales: two or more live panels, or one live panel beside an imported one.
const mixedFixtures = fixtures.filter(({ imported }) => imported.filter((i) => !i).length >= 2 || (imported.some(Boolean) && imported.some((i) => !i)));
const scalesFor = (imported, pick) => { let live = -1; return imported.map((i) => (i ? 1 : pick(live += 1))); };

const FIXED = 2;
const COUNTED = ['targets', 'lifts', 'labels', 'dots', 'leaders', 'connectors', 'redactions', 'slots', 'brackets', 'loupes', 'flats', 'links'];

// A panel's source and frame numbers are in its own capture pixels; they meet the twin's in CSS pixels.
function assertSameLayout(one, other, scales) {
  const CLAMPED = 'a lift was clamped at the frame edge';
  assertInvariants(one);
  assertInvariants(other);
  assert.deepEqual(one.panels.map((p) => p.scale), scales.map(() => 1));
  assert.deepEqual(other.panels.map((p) => p.scale), scales);
  assert.equal(other.panels.length, one.panels.length);
  assert.deepEqual(other.imageSizes, one.imageSizes.map(([w, h], p) => [w * scales[p], h * scales[p]]), "each capture is its scale times its 1x twin's size");
  // Glyph antialiasing at 1x can spill a column past a box that sits at the frame edge, which 2x does not:
  // the clamp warning is the one a 2x board may lack, and every other warning must match.
  const expectedWarnings = other.warnings.includes(CLAMPED) ? one.warnings : one.warnings.filter((w) => w !== CLAMPED);
  assert.deepEqual(other.warnings, expectedWarnings, `warnings ${JSON.stringify(other.warnings)} against 1x warnings ${JSON.stringify(one.warnings)}`);
  one.panels.forEach((a, p) => {
    for (const list of COUNTED) assert.equal(other.panels[p][list].length, a[list].length, `panel ${p} ${list} count`);
  });
  const css = (panel, list) => list.map((n) => n / panel.scale);
  // Board pixels: the same picture. Image pixels: a panel's scale times as many.
  // A 1x pixel can straddle a glyph edge that a 2x pixel resolves, so a lift's source may differ by a pixel,
  // and a lift drawn larger than its source carries that pixel into board space: only that lift, and what is
  // drawn for it, gets the slack.
  const liftSlacks = one.panels.map((a, p) => a.lifts.map((lift, i) => (lift.rect[2] / Math.max(lift.source[2], 1))
    * Math.max(...css(other.panels[p], other.panels[p].lifts[i].source).map((n, k) => Math.abs(n - lift.source[k])))));
  near(other.stage, one.stage, FIXED + Math.max(0, ...liftSlacks.flat()), 'stage');
  one.panels.forEach((a, p) => {
    const b = other.panels[p];
    const slackOf = (target) => (a.targets[target]?.kind === 'lift' ? liftSlacks[p][a.targets[target].lift] : 0);
    const leaderSlack = (leader) => Math.max(0, ...(a.leaders[leader]?.targets ?? []).map(slackOf));
    assert.deepEqual(b.frameEdges, a.frameEdges);
    assert.equal(b.cropped, a.cropped);
    assert.deepEqual(b.cropEdges, a.cropEdges);
    near(b.capture, a.capture, FIXED, 'capture');
    near(css(b, b.frame), a.frame, 1, 'frame');
    near(css(b, b.cleanFrame), a.cleanFrame, 1, 'cleanFrame');
    a.lifts.forEach((lift, i) => {
      near(b.lifts[i].rect, lift.rect, FIXED + liftSlacks[p][i], 'lift rect');
      near(css(b, b.lifts[i].source), lift.source, 1, 'lift source');
      near(css(b, b.lifts[i].grown), lift.grown, 1, 'lift growth');
      assert.ok(Math.abs(b.lifts[i].k - lift.k) < 0.05, 'lift zoom');
    });
    a.labels.forEach((label, i) => near(b.labels[i].rect, label.rect, FIXED + slackOf(label.target), 'label rect'));
    a.dots.forEach((dot, i) => near(b.dots[i].center, dot.center, FIXED + slackOf(dot.target), 'dot'));
    a.redactions.forEach((redaction, i) => near(b.redactions[i].rect, redaction.rect, FIXED, 'redaction'));
    a.slots.forEach((slot, i) => near(b.slots[i].rect, slot.rect, FIXED, 'slot'));
    a.brackets.forEach((bracket, i) => near(b.brackets[i].rect, bracket.rect, FIXED, 'bracket'));
    a.loupes.forEach((loupe, i) => {
      near(b.loupes[i].ring, loupe.ring, FIXED, 'loupe ring');
      near(b.loupes[i].lens, loupe.lens, FIXED, 'loupe lens');
    });
    for (const [list, slack] of [['leaders', (item) => leaderSlack(a.leaders.indexOf(item))], ['connectors', (item) => Math.max(slackOf(item.target), leaderSlack(item.leader))]]) {
      a[list].forEach((item, i) => {
        assert.equal(b[list][i].points.length, item.points.length, `${list} point count`);
        item.points.forEach((point, k) => near(b[list][i].points[k], point, FIXED + slack(item), `${list} point`));
      });
    }
  });
}

for (const { file, imported } of liveFixtures) {
  test(`fixture ${file}: a 2x capture composes to the same layout as its 1x twin`, { skip }, async () => {
    const one = await boardReport({ file, deviceScaleFactor: 1 });
    const two = await boardReport({ file, deviceScaleFactor: 2 });
    assertSameLayout(one, two, imported.map(() => 2));
  });
}

for (const { file, imported } of mixedFixtures.filter(({ imported: i }) => i.filter((x) => !x).length >= 2)) {
  for (const [name, pick] of [['the first live panel at 2x and the others at 1x', (n) => (n === 0 ? 2 : 1)], ['the first live panel at 1x and the others at 2x', (n) => (n === 0 ? 1 : 2)]]) {
    test(`fixture ${file}: ${name} composes to the same layout as all at 1x`, { skip }, async () => {
      const scales = scalesFor(imported, pick);
      const one = await boardReport({ file, deviceScaleFactor: 1 });
      const mixed = await boardReport({ file, deviceScaleFactor: scales });
      assertSameLayout(one, mixed, scales);
    });
  }
}

for (const { file, imported } of mixedFixtures.filter(({ imported: i }) => i.some(Boolean))) {
  test(`fixture ${file}: an imported panel beside a 2x live panel lays out as beside a 1x one`, { skip }, async () => {
    const scales = scalesFor(imported, () => 2);
    const one = await boardReport({ file, deviceScaleFactor: 1 });
    const two = await boardReport({ file, deviceScaleFactor: scales });
    assertSameLayout(one, two, scales);
    imported.forEach((isImport, p) => {
      if (!isImport) return;
      const a = one.panels[p]; const b = two.panels[p];
      for (const key of ['source', 'scale', 'frame', 'cleanFrame', 'trimmed', 'cropped']) assert.deepEqual(b[key], a[key], `the imported panel's ${key}`);
      assert.deepEqual(b.lifts.map((l) => [l.source, l.grown, l.pad]), a.lifts.map((l) => [l.source, l.grown, l.pad]));
      assert.deepEqual(b.redactions.map((r) => r.rect.map((n) => Math.round(n))), a.redactions.map((r) => r.rect.map((n) => Math.round(n))), "the imported panel's redaction fills");
    });
  });
}

// A lift box ending inside a bar whose clean band is 81px away, built inline at a device scale.
async function barGrowth(scale) {
  const home = await mkdtemp(path.join(tmpdir(), 'fb-grow-'));
  try {
    const paths = resolvePaths({ homeDir: home, pluginRoot: path.resolve('.') });
    await mkdir(paths.screenshotsDir, { recursive: true });
    const png = path.join(paths.screenshotsDir, 'bar.c1.png');
    const { chromium } = await import(renderer.playwrightCore);
    const browser = await chromium.launch({ headless: true, executablePath: renderer.executablePath });
    try {
      const page = await browser.newPage({ viewport: { width: 600, height: 300 }, deviceScaleFactor: scale });
      await page.setContent('<body style="margin:0;background:#fff"><div style="position:absolute;left:60px;top:40px;width:160px;height:20px;background:#334155"></div></body>');
      await page.screenshot({ path: png });
    } finally { await browser.close(); }
    const { sidecar } = await writeSidecar({ png, frame: [0, 0, 600, 300], boxes: { a: [40, 30, 100, 40] }, scale });
    const specPath = path.join(paths.screenshotsDir, 'bar.spec.json');
    await writeFile(specPath, JSON.stringify({ state: 'AFTER', title: 'Wide', layout: 'single', out: 'bar.png',
      panels: [{ capture: path.basename(sidecar), marks: [{ lift: 'a', title: 'Wide' }] }] }));
    let report;
    await compose({ command: 'compose', spec: specPath }, {
      paths, rendererLocation: async () => renderer,
      renderBoard: async (args) => { const r = await renderBoard(args); report = r.report; return r; },
    });
    return report.panels[0].lifts[0].grown;
  } finally { await rm(home, { recursive: true, force: true }); }
}

test('a lift grows as far at 2x as at 1x when the clean band is 81px away (GROW_LIMIT)', { skip }, async () => {
  const one = await barGrowth(1);
  const two = await barGrowth(2);
  assert.ok(one[2] > 80, `the lift grows right to the end of the bar, got ${one}`);
  assert.deepEqual(two, one.map((n) => n * 2));
});

// The secret's pink and the marker's blue appear nowhere else on the page, and nowhere on a board.
const SECRET = [255, 20, 147];
const MARKER = [29, 78, 216];
const pixelPage = `<!doctype html><meta charset="utf-8">
<style>body{margin:0;background:#fff;font:700 28px Helvetica,Arial,sans-serif}
.card{margin:80px;padding:24px;background:#f6f7f9;border:1px solid #e5e7eb;border-radius:12px;width:420px}
.bar{display:flex;align-items:center;height:44px;padding-left:12px;background:rgb(${MARKER})}
.secret{color:rgb(${SECRET})}</style>
<div class="card"><div class="bar" data-testid="marker"><span class="secret" data-testid="secret">SECRET</span></div></div>`;

async function composeFromTool({ tool, home, marks, out }) {
  const paths = resolvePaths({ homeDir: home, pluginRoot: path.resolve('.') });
  const captured = await tool.capture({ targets: { marker: '[data-testid=marker]', secret: '[data-testid=secret]' }, out: 'px' });
  assert.equal(captured.scale, 2);
  const specPath = path.join(paths.screenshotsDir, `${out}.spec.json`);
  await writeFile(specPath, JSON.stringify({ state: 'AFTER', title: 'Pixels', layout: 'single', out: `${out}.png`, panels: [{ capture: path.basename(captured.sidecar), marks }] }));
  let report;
  await compose({ command: 'compose', spec: specPath }, {
    paths, rendererLocation: async () => renderer,
    renderBoard: async (args) => { const r = await renderBoard(args); report = r.report; return r; },
  });
  return { report, board: await readFile(path.join(paths.screenshotsDir, `${out}.png`)) };
}

// The marker's corners and centre on the board, from the lift's rect and the pad around its source, as the report gives them.
// The report is in stage pixels; the board PNG has `ratio` pixels to each of them.
function markerPoints(report, board) {
  const { stage, panels: [{ lifts: [{ rect, source, pad }] }] } = report;
  const f = rect[2] / (source[2] + pad[0] + pad[2]);
  const bar = [rect[0] + pad[0] * f, rect[1] + pad[1] * f, source[2] * f, source[3] * f];
  const ratio = readPngSize(board).width / stage[2];
  const inset = 6;
  const [x, y, w, h] = bar.map((n) => n * ratio);
  return [[x + w / 2, y + h / 2], [x + inset, y + inset], [x + w - inset, y + inset], [x + inset, y + h - inset], [x + w - inset, y + h - inset]];
}

test('the tool: a redaction inside a lift is drawn on a 2x board, and the lift shows the picture where the report says', { skip }, async () => {
  await withTool('pixels', async ({ tool, home }) => {
    const lift = { lift: 'marker', title: 'Marker' };
    const redacted = await composeFromTool({ tool, home, marks: [{ redact: 'secret' }, lift], out: 'redacted' });
    const open = await composeFromTool({ tool, home, marks: [lift], out: 'open' });
    assert.equal(redacted.report.panels[0].scale, 2);
    const hidden = await readPixels({ png: redacted.board, renderer, colour: SECRET, distance: 150, points: markerPoints(redacted.report, redacted.board) });
    const shown = await readPixels({ png: open.board, renderer, colour: SECRET });
    hidden.at.forEach((pixel, i) => assert.ok(
      Math.abs(pixel[0] - MARKER[0]) + Math.abs(pixel[1] - MARKER[1]) + Math.abs(pixel[2] - MARKER[2]) <= 48,
      `marker point ${i} is ${pixel}, not the marker's colour`,
    ));
    assert.equal(hidden.near, 0, 'the secret colour is on a board that redacts it');
    assert.ok(shown.near > 100, `the same board without the redaction shows the secret (${shown.near} pixels)`);
  }, { inline: { pixels: pixelPage } });
});
