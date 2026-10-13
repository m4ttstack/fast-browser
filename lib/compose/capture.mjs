import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { readPngSize } from '../annotate/png.mjs';

export const CAPTURE_SCHEMA = 'capture-evidence/1';
export const COMPOSABLE_SCALES = Object.freeze([1, 2]);

// Unkeyed on purpose: it catches accidental edits and copy mistakes, the bar
// the spec sets. It is not a defence against an agent that recomputes it.
// A 1x capture hashes exactly what it always did; any other scale is covered
// too, so editing it cannot move the layout. Pass the resolved scale.
export function captureDigest(pngBytes, { frame, boxes, scale }) {
  const covered = scale === undefined || scale === null || scale === 1 ? { frame, boxes } : { frame, boxes, scale };
  return crypto.createHash('sha256')
    .update(pngBytes)
    .update(JSON.stringify(covered))
    .digest('hex');
}

function isBox(value) {
  return Array.isArray(value) && value.length === 4 && value.every((n) => Number.isFinite(n));
}

// compose reads only the key of an entry, to refuse a redaction of a key the capture missed.
const isMissedEntry = (entry) => entry !== null && typeof entry === 'object' && typeof entry.key === 'string';

const isSizedBox = (value) => isBox(value) && value[2] > 0 && value[3] > 0;

export async function loadCapture({ sidecarPath, fail }) {
  let body;
  try { body = JSON.parse(await readFile(sidecarPath, 'utf8')); } catch { throw fail('a capture sidecar could not be read'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || body.schemaVersion !== CAPTURE_SCHEMA || typeof body.image !== 'string'
    || body.image !== path.basename(body.image)
    || (body.missed !== undefined && !(Array.isArray(body.missed) && body.missed.every(isMissedEntry)))) {
    throw fail('a capture sidecar is malformed');
  }
  const pngPath = path.join(path.dirname(sidecarPath), body.image);
  let png;
  try { png = await readFile(pngPath); } catch { throw fail("a capture sidecar's image was not found beside it"); }
  const imported = body.source === 'import';
  if (imported && (body.frame !== undefined || body.boxes !== undefined)) {
    throw fail('an imported capture sidecar must not carry measurements');
  }
  const scale = body.scale ?? 1;
  if (captureDigest(png, imported ? {} : { frame: body.frame, boxes: body.boxes, scale }) !== body.digest) {
    throw fail('a capture sidecar does not match its image');
  }
  const { width, height } = readPngSize(png);
  if (imported) {
    return {
      sidecarPath, pngPath, png, size: [width, height], source: 'import', origin: body.origin, format: body.format,
      frame: null, boxes: {}, missed: [], dark: false, scale: 1,
    };
  }
  if (!isSizedBox(body.frame) || !body.boxes || typeof body.boxes !== 'object' || Array.isArray(body.boxes)
    || !Object.values(body.boxes).every(isSizedBox)) {
    throw fail('a capture sidecar is malformed');
  }
  // The digest covers frame, boxes and a scale other than 1 as written, in CSS pixels; the layout
  // works in the image's own pixels, so they are scaled only after the check.
  const toImage = (box) => (COMPOSABLE_SCALES.includes(scale) ? box.map((n) => n * scale) : box);
  const frame = toImage(body.frame);
  if (COMPOSABLE_SCALES.includes(scale)
    && (frame[0] < 0 || frame[1] < 0 || frame[0] + frame[2] > width || frame[1] + frame[3] > height)) {
    throw fail('a capture sidecar does not match its image');
  }
  const boxes = Object.fromEntries(Object.entries(body.boxes).map(([key, box]) => [key, toImage(box)]));
  return {
    sidecarPath, pngPath, png, size: [width, height],
    frame, frameSnap: body.frameSnap, boxes,
    missed: body.missed ?? [], dark: Boolean(body.dark), scale,
  };
}
