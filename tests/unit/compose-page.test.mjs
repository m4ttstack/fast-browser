import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBoardHtml, REDACT_FILL } from '../../lib/compose/page.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');

test('the page inlines the capture, the font and the layout script, and fetches nothing', () => {
  const html = buildBoardHtml({
    spec: { state: 'AFTER', title: 'T <b>', layout: 'single', out: 'o.png',
      panels: [{ capture: 'c.json', marks: [{ lift: 'a', title: 'Hello' }] }] },
    captures: [{ png: PNG, size: [1, 1], frame: [0, 0, 1, 1], boxes: { a: [0, 0, 1, 1] }, dark: false }],
    fontBytes: Buffer.from('wOF2fake'),
    geometrySource: 'globalThis.__composeGeometry = {};',
    layoutSource: 'window.__composeLayout = () => {};',
  });
  assert.match(html, /data:image\/png;base64,/);
  assert.match(html, /data:font\/woff2;base64,/);
  assert.match(html, /window\.__composeLayout/);
  assert.ok(html.indexOf('__composeGeometry') < html.indexOf('__composeLayout'), 'geometry loads before the layout');
  assert.equal(/https?:\/\//.test(html), false);
  assert.equal(html.includes('<b>'), false, 'spec text is JSON-encoded, never raw HTML');
  assert.ok(html.includes(REDACT_FILL));
});
