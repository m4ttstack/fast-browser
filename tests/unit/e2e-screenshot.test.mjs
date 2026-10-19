import assert from 'node:assert/strict';
import test from 'node:test';

import { screenshot } from '../e2e/helpers/screenshot.mjs';

const REFUSED = 'page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot\nCall log:\n  - taking page screenshot';

// A page whose screenshot calls answer from `outcomes` in turn: an Error is thrown, anything else returned.
function fakePage(outcomes) {
  const page = {
    shots: [], waits: 0,
    url: () => 'about:blank',
    evaluate: async () => { page.waits += 1; },
    screenshot: async (options) => {
      page.shots.push(options);
      const next = outcomes.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return page;
}

test('a capture Chromium takes first time is returned as it is, with nothing logged', async () => {
  const page = fakePage([Buffer.from('png')]);
  const warnings = [];
  const shot = await screenshot(page, { scale: 'device' }, { warn: (line) => warnings.push(line) });
  assert.equal(shot.toString(), 'png');
  assert.deepEqual(page.shots, [{ scale: 'device' }]);
  assert.deepEqual(warnings, []);
});

test('a capture Chromium could not copy is taken once more, after a frame, and the retry is logged', async () => {
  const page = fakePage([new Error(REFUSED), Buffer.from('png')]);
  const warnings = [];
  const shot = await screenshot(page, { type: 'png' }, { warn: (line) => warnings.push(line) });
  assert.equal(shot.toString(), 'png');
  assert.deepEqual(page.shots, [{ type: 'png' }, { type: 'png' }]);
  assert.equal(page.waits, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Unable to capture screenshot/);
  assert.match(warnings[0], /retrying once/);
});

test('a second refusal fails the capture', async () => {
  const page = fakePage([new Error(REFUSED), new Error(REFUSED), Buffer.from('png')]);
  await assert.rejects(screenshot(page, {}, { warn: () => {} }), /Unable to capture screenshot/);
  assert.equal(page.shots.length, 2);
});

test('any other capture error fails at once, with no retry', async () => {
  for (const error of [new Error('page.screenshot: Timeout 30000ms exceeded.'), new Error('page.screenshot: Target page, context or browser has been closed')]) {
    const page = fakePage([error, Buffer.from('png')]);
    const warnings = [];
    await assert.rejects(screenshot(page, {}, { warn: (line) => warnings.push(line) }), error);
    assert.equal(page.shots.length, 1);
    assert.deepEqual(warnings, []);
  }
});
