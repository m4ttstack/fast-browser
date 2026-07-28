import assert from 'node:assert/strict';
import test from 'node:test';

import { ANNOTATION_TYPES, buildSvg } from '../../lib/annotate/svg.mjs';

const BASE = Buffer.alloc(24);
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(BASE, 0);

function svg(annotations) {
  return buildSvg({
    base: BASE, width: 900, height: 560, annotations, palette: 'violet', scale: 2,
  });
}

test('all eight primitives are supported', () => {
  assert.deepEqual([...ANNOTATION_TYPES].sort(), [
    'arrow', 'blur', 'box', 'chip', 'counter', 'ellipse', 'highlight', 'spotlight',
  ]);
});

test('the root svg rasterises at scale while keeping base-pixel coordinates', () => {
  const out = svg([{ type: 'box', box: [10, 20, 30, 40] }]);
  assert.match(out, /width="1800" height="1120"/);
  assert.match(out, /viewBox="0 0 900 560"/);
});

test('highlight fills with accent at 14 percent, never with soft', () => {
  const out = svg([{ type: 'highlight', box: [10, 20, 30, 40] }]);
  assert.match(out, /fill="#6e56cf" fill-opacity="0\.14"/);
  assert.doesNotMatch(out, /fill="#f4f0fe" fill-opacity/);
});

test('chip uses soft fill with ink text', () => {
  const out = svg([{ type: 'chip', xy: [10, 20], text: 'Estimate' }]);
  assert.match(out, /fill="#f4f0fe"/);
  assert.match(out, /fill="#6550b9"/);
});

test('chip text is escaped so markup cannot be injected', () => {
  const out = svg([{ type: 'chip', xy: [0, 0], text: '<script>&"x"' }]);
  assert.doesNotMatch(out, /<script>/);
  assert.match(out, /&lt;script&gt;&amp;/);
});

test('counter n is validated as an integer rather than interpolated raw', () => {
  assert.throws(() => svg([{ type: 'counter', xy: [0, 0], n: '</text><script/>' }]), /counter/);
  assert.match(svg([{ type: 'counter', xy: [5, 5], n: 3 }]), />3</);
});

test('every generated element id is unique within one document', () => {
  const out = svg([
    { type: 'blur', box: [0, 0, 10, 10] },
    { type: 'spotlight', box: [0, 0, 10, 10] },
    { type: 'blur', box: [0, 0, 10, 10] },
  ]);
  const ids = [...out.matchAll(/id="(clip|blur|spot)(\d+)"/g)].map((m) => `${m[1]}${m[2]}`);
  assert.equal(new Set(ids).size, ids.length, 'every generated id is unique');
});

test('blur and spotlight advance one shared id counter', () => {
  const out = svg([
    { type: 'blur', box: [0, 0, 10, 10] },
    { type: 'spotlight', box: [0, 0, 10, 10] },
  ]);
  // A shared counter gives the spotlight index 2. Per-type counters would
  // restart it at 1, which is invisible to a uniqueness check because the
  // 'spot' prefix keeps the strings distinct either way.
  assert.match(out, /id="clip1"/);
  assert.match(out, /id="blur1"/);
  assert.match(out, /id="spot2"/);
  assert.doesNotMatch(out, /id="spot1"/);
});

test('an unknown annotation type is refused', () => {
  assert.throws(() => svg([{ type: 'sparkle', box: [0, 0, 1, 1] }]), /unsupported annotation/);
});

test('a non-finite or negative geometry value is refused', () => {
  assert.throws(() => svg([{ type: 'box', box: [0, 0, Number.NaN, 1] }]), /invalid/);
  assert.throws(() => svg([{ type: 'box', box: [0, 0, -5, 1] }]), /invalid/);
  assert.throws(() => svg([{ type: 'box', box: [0, 0, 1] }]), /invalid/);
});
