import assert from 'node:assert/strict';
import test from 'node:test';

import { readPngSize } from '../../lib/annotate/png.mjs';

function pngHeader(width, height) {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.write('IHDR', 12, 'latin1');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

test('reads dimensions from a PNG IHDR header', () => {
  assert.deepEqual(readPngSize(pngHeader(900, 560)), { width: 900, height: 560 });
});

test('rejects a file that is not a PNG', () => {
  assert.throws(() => readPngSize(Buffer.from('GIF89a not a png at all!!')), /not a PNG/);
});

test('rejects a PNG whose header is truncated', () => {
  assert.throws(() => readPngSize(pngHeader(900, 560).subarray(0, 20)), /not a PNG/);
});

test('rejects a zero dimension', () => {
  assert.throws(() => readPngSize(pngHeader(0, 560)), /invalid PNG dimensions/);
  assert.throws(() => readPngSize(pngHeader(900, 0)), /invalid PNG dimensions/);
});
