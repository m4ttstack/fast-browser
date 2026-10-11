import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { rendererForTests } from './helpers/renderer.mjs';

const renderer = await rendererForTests();
const skip = renderer ? false : 'skipped by FAST_BROWSER_SKIP_COMPOSE_E2E=1';
const source = await readFile(new URL('../../builtins/macros/capture-evidence.js', import.meta.url), 'utf8');
// The macro file is a single async arrow expression, exactly as
// browser_run_code_unsafe receives it.
const macro = new Function(`return (${source});`)();
const pageUrl = (name) => pathToFileURL(path.resolve(`tests/fixtures/evidence/pages/${name}.html`)).href;

async function run(name, args) {
  const home = await mkdtemp(path.join(tmpdir(), 'fb-capev-'));
  const { chromium } = await import(renderer.playwrightCore);
  const browser = await chromium.launch({ headless: true, executablePath: renderer.executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.goto(pageUrl(name));
    return { home, result: await macro(page, { home, out: 'cap', ...args }) };
  } finally { await browser.close(); }
}

test('auto frame snaps to the card holding every target', { skip }, async () => {
  const { home, result } = await run('nested-cards', { targets: { owner: '[data-testid=owner]', reviewer: '[data-testid=reviewer]' } });
  try {
    assert.equal(result.schemaVersion, 'capture-evidence/1');
    assert.equal(result.frameSnap, 'card');
    assert.ok(result.frame[2] < 1000 && result.frame[3] < 700);
    assert.deepEqual(Object.keys(result.boxes).sort(), ['owner', 'reviewer']);
    assert.equal(result.png, path.join(home, '.fast-browser', 'screenshots', 'cap.png'));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('an ambiguous selector is missed, never guessed', { skip }, async () => {
  const { home, result } = await run('repeated-rows', { targets: { edit: 'button', bravo: '[data-testid=row-b] >> text=Bravo' } });
  try {
    assert.deepEqual(result.missed, [{ key: 'edit', reason: 'ambiguous', count: 3 }]);
    assert.ok(result.boxes.bravo);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a dark surface is reported as dark', { skip }, async () => {
  const { home, result } = await run('dark-surface', { targets: { value: '[data-testid=value]' } });
  try { assert.equal(result.dark, true); } finally { await rm(home, { recursive: true, force: true }); }
});

test('a heading-only strip is not a frame; the union is used and reported', { skip }, async () => {
  const { home, result } = await run('heading-strip', { targets: { heading: '[data-testid=heading]' } });
  try { assert.equal(result.frameSnap, 'union'); } finally { await rm(home, { recursive: true, force: true }); }
});

test('targets too far apart for one frame capture nothing', { skip }, async () => {
  const { home, result } = await run('far-targets', { targets: { top: '[data-testid=top]', bottom: '[data-testid=bottom]' } });
  try {
    assert.equal(result.failedStep, 'frame');
    assert.equal(result.frameSnap, 'too-large');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a tiny badge is measured', { skip }, async () => {
  const { home, result } = await run('tiny-badge', { targets: { badge: '[data-testid=badge]', title: '[data-testid=title]' } });
  try { assert.equal(result.boxes.badge[2], 12); } finally { await rm(home, { recursive: true, force: true }); }
});

test('a failed call leaves no tags behind for the next call on the same page', { skip }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'fb-capev-'));
  const { chromium } = await import(renderer.playwrightCore);
  const browser = await chromium.launch({ headless: true, executablePath: renderer.executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.goto(pageUrl('nested-cards'));
    const first = await macro(page, { home, out: 'cap', frame: '[data-testid=nothing]', targets: { owner: '[data-testid=owner]' } });
    assert.equal(first.failedStep, 'frame');
    const second = await macro(page, { home, out: 'cap', targets: { contact: '[data-testid=contact]' } });
    assert.deepEqual(Object.keys(second.boxes), ['contact']);
    assert.notEqual(second.frameSnap, 'selector');
  } finally { await browser.close(); await rm(home, { recursive: true, force: true }); }
});

for (const [edge, fixture] of [['right', 'off-right-edge'], ['left', 'off-left-edge']]) {
  test(`a target clipped by the ${edge} edge is missed as out-of-view`, { skip }, async () => {
    const { home, result } = await run(fixture, { targets: { inside: '[data-testid=inside]', clipped: '[data-testid=clipped]' } });
    try {
      assert.deepEqual(result.missed, [{ key: 'clipped', reason: 'out-of-view' }]);
      assert.deepEqual(Object.keys(result.boxes), ['inside']);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
}

test('an explicit frame that does not contain every target fails', { skip }, async () => {
  const { home, result } = await run('frame-misses-target', {
    frame: '[data-testid=panel]', targets: { in: '[data-testid=in]', out: '[data-testid=out]' },
  });
  try {
    assert.deepEqual(result, { failedStep: 'frame', error: 'the frame selector does not contain every target' });
  } finally { await rm(home, { recursive: true, force: true }); }
});
