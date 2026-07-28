import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_PALETTE,
  OFFERED_PALETTES,
  RADIX_SCALES,
  resolvePalette,
} from '../../lib/annotate/palette.mjs';

test('the default palette is violet and resolves to Radix step 9/3/11', () => {
  assert.equal(DEFAULT_PALETTE, 'violet');
  assert.deepEqual(resolvePalette('violet'), {
    accent: '#6e56cf',
    soft: '#f4f0fe',
    ink: '#6550b9',
  });
});

test('every Radix scale resolves, not only the offered ten', () => {
  assert.equal(Object.keys(RADIX_SCALES).length, 31);
  for (const name of Object.keys(RADIX_SCALES)) {
    const palette = resolvePalette(name);
    for (const role of ['accent', 'soft', 'ink']) {
      assert.match(palette[role], /^#[0-9a-f]{6}$/, `${name}.${role}`);
    }
  }
});

test('the offered ten are a subset of the full set and lead with the default', () => {
  assert.equal(OFFERED_PALETTES.length, 10);
  assert.equal(OFFERED_PALETTES[0], DEFAULT_PALETTE);
  for (const name of OFFERED_PALETTES) assert.ok(RADIX_SCALES[name], name);
});

test('an unknown palette name is refused rather than silently defaulted', () => {
  assert.throws(() => resolvePalette('burgundy'), /unknown annotation palette/);
  assert.throws(() => resolvePalette('__proto__'), /unknown annotation palette/);
});

test('the registry cannot be mutated by a caller', () => {
  assert.throws(() => { RADIX_SCALES.violet = null; });
  assert.throws(() => { RADIX_SCALES.violet.accent = '#000000'; });
});
