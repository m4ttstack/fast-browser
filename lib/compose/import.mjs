import { lstat, mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { readPngSize } from '../annotate/png.mjs';
import { confinedScreenshotPath } from '../core/screenshots.mjs';
import { CAPTURE_SCHEMA, captureDigest } from './capture.mjs';
import { IMPORT_MAX_SIDE } from './engine.mjs';
import { sameFile, writeAtomic } from './files.mjs';
import { isReservedName } from './redactions.mjs';

export const IMPORT_MAX_BYTES = 25 * 1024 * 1024;
const ORIGIN_MAX = 2000;
const OUT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MIME = Object.freeze({ png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' });
const ascii = (bytes, from, to) => bytes.subarray(from, to).toString('latin1');

export function detectFormat(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return null;
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'webp';
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'gif';
  return null;
}

async function exists(file) {
  try { await lstat(file); return true; } catch (error) { return error?.code !== 'ENOENT'; }
}

// An import may replace an earlier import of the same name and nothing else:
// a live capture's PNG or sidecar is never overwritten.
async function refuseLiveCapture(png, sidecar, fail) {
  if (!(await exists(png)) && !(await exists(sidecar))) return;
  let earlier = null;
  try { earlier = JSON.parse(await readFile(sidecar, 'utf8')); } catch { /* absent or unreadable */ }
  if (earlier?.source !== 'import') throw fail('out names an existing capture; choose another name');
}

export async function importCapture({ paths, source, out, origin, rasterize, fail }) {
  if (typeof out !== 'string' || !OUT_NAME.test(out)) throw fail('out must be a simple file name');
  if (isReservedName(`${out}.png`)) throw fail('out must not be named like a redaction crop');
  if (typeof origin !== 'string' || origin.trim().length === 0) throw fail('origin is required: say where the image came from');
  if (origin.length > ORIGIN_MAX) throw fail(`origin must be at most ${ORIGIN_MAX} characters`);
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(origin)) throw fail('origin must be one line without control characters');
  const png = await confinedScreenshotPath(paths, `${out}.png`, 'out', fail);
  const sidecar = await confinedScreenshotPath(paths, `${out}.capture.json`, 'out', fail);
  if (await sameFile(source, png)) throw fail('out must not name the image being imported');
  await refuseLiveCapture(png, sidecar, fail);
  let info;
  try { info = await stat(source); } catch { throw fail('the image to import was not found'); }
  if (!info.isFile()) throw fail('the image to import was not found');
  if (info.size > IMPORT_MAX_BYTES) throw fail(`the image to import is larger than ${IMPORT_MAX_BYTES / 1024 / 1024} MB`);
  const bytes = await readFile(source);
  const format = detectFormat(bytes);
  if (!format) throw fail('the image to import must be a PNG, JPEG, WebP or GIF');
  let converted;
  try { converted = await rasterize({ bytes, mime: MIME[format] }); } catch (error) {
    if (error?.name === 'RuntimeUnavailableError') throw error;
    if (error?.name === 'ImageDecodeTimeoutError') throw fail('the image to import took too long to decode');
    if (error?.name === 'ImageTooLargeError') throw fail(`the image to import is larger than ${IMPORT_MAX_SIDE} px on a side`);
    throw fail('the image to import could not be decoded');
  }
  const { width, height } = readPngSize(converted);
  try {
    await mkdir(paths.screenshotsDir, { recursive: true });
    await rm(sidecar, { force: true });
    await writeAtomic(png, converted);
    await writeAtomic(sidecar, `${JSON.stringify({
      schemaVersion: CAPTURE_SCHEMA, source: 'import', image: path.basename(png), origin, format, scale: 1,
      digest: captureDigest(converted, {}),
    }, null, 2)}\n`);
  } catch { throw fail('out could not be written'); }
  return { sidecar, png, format, width, height };
}
