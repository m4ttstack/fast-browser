import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { OFFERED_PALETTES } from '../annotate/palette.mjs';
import { readPngSize } from '../annotate/png.mjs';
import { rasterise as defaultRasterise } from '../annotate/render.mjs';
import { buildSvg } from '../annotate/svg.mjs';
import { assertConfinedPath } from '../core/containment.mjs';
import { loadConfig as defaultLoadConfig } from '../core/config.mjs';
import { resolvePaths } from '../core/paths.mjs';
import { LifecycleError } from './shared.mjs';

const MEASUREMENT_SCHEMA_VERSION = 1;

function fail(message, exitCode = 2) {
  return new LifecycleError(message, { stage: 'annotate', exitCode });
}

// `base` and `out` are names inside the screenshots directory, never paths.
// assertConfinedPath structurally requires its root to sit under dataDir, so
// honouring caller-chosen absolute paths and confining are mutually exclusive;
// containment wins.
async function confinedName(paths, name, field) {
  if (typeof name !== 'string' || name.length === 0) throw fail(`${field} is required`);
  const candidate = path.resolve(paths.screenshotsDir, name);
  await assertConfinedPath({
    dataDir: paths.dataDir,
    rootDir: paths.screenshotsDir,
    candidate,
  });
  return candidate;
}

function assertMeasurement(measured, width) {
  if (!measured || measured.schemaVersion !== MEASUREMENT_SCHEMA_VERSION) {
    throw fail(
      'unsupported measurement payload; remove ~/.fast-browser/macros/capture-annotated.js '
      + 'and run `fast-browser setup` to reinstall it',
    );
  }
  const inner = measured.viewport?.inner?.[0];
  const client = measured.viewport?.client?.[0];
  // Corroboration only. Atomic capture-and-measure is what makes the
  // coordinates trustworthy; this catches a base swapped out from under the
  // config. innerWidth alone cannot see a classic scrollbar because it counts
  // the scrollbar's own pixels, which is why both widths are checked.
  if (width !== inner && width !== client) {
    throw fail(
      `the base image width ${width} does not match the measured viewport `
      + `(inner ${inner}, client ${client})`,
    );
  }
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// Every corner returned here is later compared against the image bounds with
// plain `<`/`>`. If a corner were built from a non-numeric field the compares
// would run against NaN, which is neither < 0 nor > width -- an annotation
// with garbage geometry would silently read as "in bounds" and sail through
// to buildSvg. buildSvg does the real type validation and throws a clear
// "invalid annotation geometry" error, so this skips (returns no corners)
// anything it cannot interpret as finite numbers instead, deferring to that
// error rather than manufacturing a misleading "outside the image" one.
function corners(a) {
  if (Array.isArray(a.box) && a.box.length === 4 && a.box.every(finite)) {
    const [x, y, w, h] = a.box;
    return [[x, y], [x + w, y + h]];
  }
  if (a.type === 'ellipse') {
    const ry = a.ry === undefined ? a.rx : a.ry;
    if (![a.cx, a.cy, a.rx, ry].every(finite)) return [];
    return [[a.cx - a.rx, a.cy - ry], [a.cx + a.rx, a.cy + ry]];
  }
  if (a.type === 'arrow') {
    if (!Array.isArray(a.tail) || a.tail.length !== 2 || !a.tail.every(finite)) return [];
    if (!Array.isArray(a.head) || a.head.length !== 2 || !a.head.every(finite)) return [];
    return [a.tail, a.head];
  }
  if (a.type === 'chip' || a.type === 'counter') {
    if (!Array.isArray(a.xy) || a.xy.length !== 2 || !a.xy.every(finite)) return [];
    return [a.xy];
  }
  return [];
}

function assertInBounds(annotations, width, height) {
  for (const [index, annotation] of annotations.entries()) {
    for (const [x, y] of corners(annotation)) {
      if (x < 0 || y < 0 || x > width || y > height) {
        // boundingBox() returns real coordinates for elements below the fold.
        // SVG outside the viewBox rasterises to nothing, so without this a blur
        // silently covers nothing and the agent reports a redaction that is not
        // there.
        throw fail(
          `annotation ${index} (${annotation.type}) falls outside the image `
          + `(${width}x${height}); it was probably measured out of view`,
        );
      }
    }
  }
}

export async function annotate(request, supplied = {}) {
  // Every other command falls back to resolvePaths when the CLI entrypoint
  // invokes it without an explicit `paths` (bin/fast-browser.mjs calls
  // `main()` with no dependencies at all); matching that here is what makes
  // `fast-browser annotate` work outside tests.
  const paths = supplied.paths ?? resolvePaths({
    homeDir: supplied.homeDir,
    pluginRoot: supplied.pluginRoot,
  });
  const loadConfig = supplied.loadConfig ?? defaultLoadConfig;
  const rasterise = supplied.rasterise ?? defaultRasterise;

  const config = await loadConfig(paths);
  const palette = config.annotation?.palette ?? null;
  if (!palette) {
    throw fail(
      'no annotation palette is configured. Choose one of '
      + `${OFFERED_PALETTES.join(', ')} with \`fast-browser configure --palette <name>\``,
    );
  }

  let body;
  try {
    body = JSON.parse(await readFile(request.config, 'utf8'));
  } catch {
    throw fail('unable to read the annotation config');
  }
  if (!Array.isArray(body.annotations) || body.annotations.length === 0) {
    throw fail('the annotation config lists no annotations');
  }

  const basePath = await confinedName(paths, body.base, 'base');
  const outPath = await confinedName(paths, body.out, 'out');
  if (basePath === outPath) throw fail('out must not overwrite the base capture');

  const base = await readFile(basePath);
  const { width, height } = readPngSize(base);
  assertMeasurement(body.measured, width);
  assertInBounds(body.annotations, width, height);

  const scale = body.scale === undefined ? 2 : body.scale;
  if (!Number.isInteger(scale) || scale < 1 || scale > 4) throw fail('scale must be 1 to 4');

  const svg = buildSvg({
    base, width, height, annotations: body.annotations, palette, scale,
  });
  await mkdir(paths.screenshotsDir, { recursive: true, mode: 0o700 });
  await rasterise({ svg, outPath });

  return {
    base: basePath,
    out: outPath,
    palette,
    annotations: body.annotations.length,
    width: width * scale,
    height: height * scale,
  };
}
