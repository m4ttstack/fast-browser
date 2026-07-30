import { mkdir, readFile, realpath } from 'node:fs/promises';
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
  try {
    await assertConfinedPath({
      dataDir: paths.dataDir,
      rootDir: paths.screenshotsDir,
      candidate,
    });
  } catch {
    // `name` is user-supplied config data; a PathConfinementError's message
    // can embed the resolved path, so it is not safe to print verbatim (and
    // is not in main.mjs's safeFailure() allowlist anyway, which would
    // otherwise collapse this to a diagnostics-free exit 1). Name the field
    // -- always one of our own literals, "base" or "out", never user input
    // -- instead of the value.
    throw fail(`${field} must resolve inside the screenshots directory`);
  }
  return candidate;
}

// The empty string means the candidate is the root itself, which counts as
// inside for the import refusal (annotating the directory is nonsense anyway,
// but "not inside" would be the wrong answer).
function resolvesInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
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
    if (Array.isArray(annotation.box) && annotation.box.length === 4) {
      const [, , w, h] = annotation.box;
      // A collapsed element (a common boundingBox() outcome) yields a box
      // whose two corners are identical: both trivially "in bounds", so the
      // corner check below accepts it. buildSvg's clipPath/mask then encloses
      // zero pixels, so a `blur` -- the PII redaction primitive -- would
      // silently redact nothing while the command still reports success.
      // Only judge boxes made of finite numbers here; a non-numeric width or
      // height is a shape problem for buildSvg's own validation, not this
      // check, exactly like corners() below.
      // The index, not `annotation.type`: `type` is user-supplied config data
      // and nothing validates it against ANNOTATION_TYPES before this point,
      // so interpolating it echoes an arbitrary string into CLI output. This
      // command names the field rather than the value everywhere else it
      // reports a failure (confinedName and the missing-base error below), and
      // the index locates the offending entry in the agent's own config just
      // as precisely. The dimensions are safe to print: they reach here only
      // through the finite() guard, so they are numbers, never strings.
      if (finite(w) && finite(h) && (w <= 0 || h <= 0)) {
        throw fail(
          `annotation ${index} has a zero-area box `
          + `(${w}x${h}); it was probably measured out of view or not rendered`,
        );
      }
    }
    for (const [x, y] of corners(annotation)) {
      if (x < 0 || y < 0 || x > width || y > height) {
        // boundingBox() returns real coordinates for elements below the fold.
        // SVG outside the viewBox rasterises to nothing, so without this a blur
        // silently covers nothing and the agent reports a redaction that is not
        // there. The index rather than `annotation.type`, for the reason given
        // above; the image dimensions come from readPngSize, not the config.
        throw fail(
          `annotation ${index} falls outside the image `
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

  // `import` marks up a PNG that never went through the capture flow (a bug
  // screenshot off a ticket, an image somebody handed the agent). It is one
  // mode of two, never a supplement: `base` is the capture flow's field, and
  // `measured` only means anything for a capture, so a config carrying both
  // worlds is confused about which guarantees it is asking for.
  const importMode = body.import !== undefined;
  if (importMode && body.base !== undefined) {
    throw fail('import and base are mutually exclusive; provide exactly one');
  }
  if (!importMode && body.base === undefined) {
    throw fail('the annotation config must name a source image: base for a capture, import for an outside image');
  }
  if (importMode && body.measured !== undefined) {
    throw fail('measured does not apply to import; it corroborates a live capture, which a foreign image is not');
  }

  let sourcePath = null;
  if (importMode) {
    if (typeof body.import !== 'string' || !path.isAbsolute(body.import)) {
      // A relative path would resolve against whatever directory the CLI
      // happened to be launched from, which the config author has no reliable
      // view of; requiring absolute keeps the config self-describing.
      throw fail('import must be an absolute path');
    }
    sourcePath = path.resolve(body.import);
    // The refusal below must judge physical locations, not spellings: an
    // import path outside the screenshots directory can still be a symlink to
    // a capture inside it (or reach one through a platform alias like macOS's
    // /var -> /private/var), and confinedName's symlink walk covers only
    // out's side of the collision. A path realpath cannot resolve names no
    // existing file and so cannot alias a capture; its spelling is still
    // judged below, and readFile reports it as not found.
    let physicalSource = null;
    try {
      physicalSource = await realpath(sourcePath);
    } catch {
      physicalSource = null;
    }
    let physicalScreenshots;
    try {
      physicalScreenshots = await realpath(paths.screenshotsDir);
    } catch {
      // Not created until the write below on a first run; a directory that
      // does not exist yet holds no capture a link could reach, so comparing
      // against the logical spelling loses nothing.
      physicalScreenshots = paths.screenshotsDir;
    }
    const insideScreenshots = resolvesInside(paths.screenshotsDir, sourcePath)
      || (physicalSource !== null && resolvesInside(physicalScreenshots, physicalSource));
    if (insideScreenshots) {
      // Captures inside the screenshots directory are exactly what base mode
      // and its measurement corroboration exist for; letting them in through
      // import would be a measurement bypass. Rejecting them here also makes
      // the out-overwrites-source collision structurally impossible: out is
      // confined inside the directory import is barred from, and the bar
      // holds at the physical layer on both sides -- confinedName refuses
      // symlinks along out's path, and the realpath comparison above refuses
      // an import that reaches a capture through one.
      throw fail('import must not resolve inside the screenshots directory; name a capture with base instead');
    }
  }

  const outPath = await confinedName(paths, body.out, 'out');
  let basePath = null;
  if (!importMode) {
    basePath = await confinedName(paths, body.base, 'base');
    if (basePath === outPath) throw fail('out must not overwrite the base capture');
  }

  let base;
  try {
    base = await readFile(importMode ? sourcePath : basePath);
  } catch {
    // The name is user-supplied config data and not safe to echo (and, like
    // the confinement failure above, ENOENT/EACCES aren't in main.mjs's
    // safeFailure() allowlist, which would otherwise collapse this to a
    // diagnostics-free exit 1 the agent cannot act on). Naming the field that
    // is missing -- "base" or "import" -- gives an agent enough to
    // self-correct without repeating the raw, possibly-wrong value back at it.
    throw fail(importMode
      ? 'the image named by import in the annotation config was not found'
      : 'the base capture named in the annotation config was not found in the screenshots directory');
  }
  const { width, height } = readPngSize(base);
  // assertMeasurement is deliberately skipped in import mode: that check
  // exists to catch a base swapped out from under coordinates measured
  // against a live render. A foreign image has no measured coordinates, so
  // the premise does not hold and the PNG's own dimensions are the only truth
  // available; the bounds checks below run against them unchanged.
  if (!importMode) assertMeasurement(body.measured, width);
  assertInBounds(body.annotations, width, height);

  const scale = body.scale === undefined ? 2 : body.scale;
  if (!Number.isInteger(scale) || scale < 1 || scale > 4) throw fail('scale must be 1 to 4');

  const svg = buildSvg({
    base, width, height, annotations: body.annotations, palette, scale,
  });
  await mkdir(paths.screenshotsDir, { recursive: true, mode: 0o700 });
  await rasterise({ svg, outPath });

  // `mode` tells a caller which guarantees applied: `measured` means the
  // coordinates were corroborated against a live viewport, `import` means the
  // only check possible was the PNG's own dimensions. The source field is the
  // resolved absolute path either way, under the field the config used.
  const report = {
    mode: importMode ? 'import' : 'measured',
    out: outPath,
    palette,
    annotations: body.annotations.length,
    width: width * scale,
    height: height * scale,
  };
  if (importMode) report.source = sourcePath;
  else report.base = basePath;
  return report;
}
