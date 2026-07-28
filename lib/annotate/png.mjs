import { LifecycleError } from '../commands/shared.mjs';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Dimensions come from the IHDR chunk, which a valid PNG is required to place
// first. Reading 24 bytes avoids decoding the image just to learn its size.
export function readPngSize(buffer) {
  if (
    !Buffer.isBuffer(buffer)
    || buffer.length < 24
    || !buffer.subarray(0, 8).equals(SIGNATURE)
    || buffer.subarray(12, 16).toString('latin1') !== 'IHDR'
  ) {
    throw new LifecycleError('the annotation base is not a PNG', {
      stage: 'validate',
      exitCode: 2,
    });
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width < 1 || height < 1) {
    throw new LifecycleError('invalid PNG dimensions', { stage: 'validate', exitCode: 2 });
  }
  return { width, height };
}
