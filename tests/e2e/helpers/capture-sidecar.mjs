import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CAPTURE_SCHEMA, captureDigest } from '../../../lib/compose/capture.mjs';

// The capture tool writes this file itself. Suites that capture headless with
// the helper script have no tool to call, so they write the same shape here.
export async function writeSidecar(captureReturn) {
  const png = captureReturn.png;
  const sidecar = path.join(path.dirname(png), `${path.basename(png).replace(/\.png$/i, '')}.capture.json`);
  const body = {
    schemaVersion: CAPTURE_SCHEMA, source: 'live', image: path.basename(png),
    frame: captureReturn.frame, frameSnap: captureReturn.frameSnap ?? 'card', boxes: captureReturn.boxes,
    missed: captureReturn.missed ?? [], dark: Boolean(captureReturn.dark), scale: captureReturn.scale ?? 1,
  };
  body.digest = captureDigest(await readFile(png), { frame: body.frame, boxes: body.boxes, scale: body.scale });
  await writeFile(sidecar, `${JSON.stringify(body, null, 2)}\n`);
  return { sidecar, png };
}
