import crypto from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { readPngSize } from '../annotate/png.mjs';
import { confinedScreenshotPath } from '../core/screenshots.mjs';

export const CAPTURE_SCHEMA = 'capture-evidence/1';

// Unkeyed on purpose: it catches accidental edits and copy mistakes, the bar
// the spec sets. It is not a defence against an agent that recomputes it.
export function captureDigest(pngBytes, { frame, boxes }) {
  return crypto.createHash('sha256')
    .update(pngBytes)
    .update(JSON.stringify({ frame, boxes }))
    .digest('hex');
}

function isBox(value) {
  return Array.isArray(value) && value.length === 4 && value.every((n) => Number.isFinite(n));
}

export async function sealCapture({ paths, captureReturn, fail }) {
  const r = captureReturn;
  if (!r || r.schemaVersion !== CAPTURE_SCHEMA) throw fail('the file is not a capture-evidence return');
  if (!isBox(r.frame) || !r.boxes || typeof r.boxes !== 'object') throw fail('the capture return has no frame or boxes');
  for (const box of Object.values(r.boxes)) if (!isBox(box)) throw fail('the capture return has a malformed box');
  // The sidecar names its image by basename, so a nested capture would seal
  // a sidecar that can never find its png.
  if (typeof r.name === 'string' && r.name !== path.basename(r.name)) throw fail('capture png must be a bare file name');
  const png = await confinedScreenshotPath(paths, r.name, 'capture png', fail);
  if (typeof r.png !== 'string' || path.resolve(r.png) !== png) {
    throw fail('capture png must be inside the screenshots directory');
  }
  let bytes;
  try { bytes = await readFile(png); } catch { throw fail('the capture png was not found'); }
  const stem = path.basename(png).replace(/\.png$/i, '');
  const sidecar = await confinedScreenshotPath(paths, `${stem}.capture.json`, 'capture sidecar', fail);
  const body = {
    schemaVersion: CAPTURE_SCHEMA,
    source: 'live',
    image: path.basename(png),
    frame: r.frame,
    frameSnap: r.frameSnap ?? 'card',
    boxes: r.boxes,
    missed: Array.isArray(r.missed) ? r.missed : [],
    dark: Boolean(r.dark),
    scale: Number.isInteger(r.scale) ? r.scale : 1,
    digest: captureDigest(bytes, { frame: r.frame, boxes: r.boxes }),
  };
  const temp = `${sidecar}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, sidecar);
  return { sidecar, png };
}

export async function loadCapture({ sidecarPath, fail }) {
  let body;
  try { body = JSON.parse(await readFile(sidecarPath, 'utf8')); } catch { throw fail('a capture sidecar could not be read'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || body.schemaVersion !== CAPTURE_SCHEMA || typeof body.image !== 'string'
    || body.image !== path.basename(body.image)) {
    throw fail('a capture sidecar is malformed');
  }
  const pngPath = path.join(path.dirname(sidecarPath), body.image);
  let png;
  try { png = await readFile(pngPath); } catch { throw fail("a capture sidecar's image was not found beside it"); }
  const imported = body.source === 'import';
  if (imported && (body.frame !== undefined || body.boxes !== undefined)) {
    throw fail('an imported capture sidecar must not carry measurements');
  }
  if (captureDigest(png, imported ? {} : { frame: body.frame, boxes: body.boxes }) !== body.digest) {
    throw fail('a capture sidecar does not match its image');
  }
  const { width, height } = readPngSize(png);
  if (imported) {
    return {
      sidecarPath, pngPath, png, size: [width, height], source: 'import', origin: body.origin, format: body.format,
      frame: null, boxes: {}, missed: [], dark: false, scale: 1,
    };
  }
  return {
    sidecarPath, pngPath, png, size: [width, height],
    frame: body.frame, frameSnap: body.frameSnap, boxes: body.boxes,
    missed: body.missed ?? [], dark: Boolean(body.dark), scale: body.scale ?? 1,
  };
}
