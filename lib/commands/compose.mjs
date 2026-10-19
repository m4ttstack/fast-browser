import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { COMPOSABLE_SCALES, loadCapture } from '../compose/capture.mjs';
import {
  RuntimeUnavailableError, playwrightCorePath, rasterizeImage as defaultRasterizeImage, renderBoard as defaultRenderBoard,
} from '../compose/engine.mjs';
import { sameFile } from '../compose/files.mjs';
import { importCapture } from '../compose/import.mjs';
import { buildBoardHtml } from '../compose/page.mjs';
import {
  clearRedactionArtifacts, confirmRedactions, isRedactionArtifact, writeRedactionRecord,
} from '../compose/redactions.mjs';
import { rendererExecutable, rendererPlatform, rendererStatus } from '../compose/renderer.mjs';
import { validateSpec } from '../compose/spec.mjs';
import { PLUGIN_ROOT, resolvePaths } from '../core/paths.mjs';
import { confinedScreenshotPath } from '../core/screenshots.mjs';
import { loadRuntimeLock } from '../runtime/lock.mjs';
import { LifecycleError } from './shared.mjs';

const RENDERER_REMEDIES = Object.freeze({
  unpinned: 'this fast-browser pins no compose renderer; upgrade fast-browser',
  unsupported: 'compose is not available on this platform',
  missing: 'the compose renderer is not installed; run `fast-browser setup`',
});

function fail(message, exitCode = 2) {
  return new LifecycleError(message, { stage: 'compose', exitCode });
}

async function defaultRendererLocation(paths, supplied) {
  const lock = supplied.runtimeLock ?? await loadRuntimeLock({
    bundledPath: path.join(paths.pluginRoot ?? PLUGIN_ROOT, 'runtime-lock.json'),
  });
  const platform = 'rendererPlatform' in supplied ? supplied.rendererPlatform : rendererPlatform();
  const status = await rendererStatus({ lock, paths, platform });
  if (status !== 'ready') return { status };
  return { executablePath: rendererExecutable(paths, lock, platform), playwrightCore: playwrightCorePath(paths, lock) };
}

const bundleFile = (paths, dir, fail) => (name) => confinedScreenshotPath(paths, path.join(dir, name), 'out', fail);

async function readJson(file, what) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { throw fail(`unable to read the ${what}`); }
}

export async function compose(request, supplied = {}) {
  const paths = supplied.paths ?? resolvePaths({ homeDir: supplied.homeDir, pluginRoot: supplied.pluginRoot });
  if (typeof request.import === 'string') {
    if (request.import.length === 0) throw fail('the image to import needs a path');
    const location = await (supplied.rendererLocation ?? defaultRendererLocation)(paths, supplied);
    if (!location || location.status) throw fail(RENDERER_REMEDIES[location?.status] ?? RENDERER_REMEDIES.missing);
    const convert = supplied.rasterizeImage ?? defaultRasterizeImage;
    try {
      const done = await importCapture({
        paths, source: path.resolve(request.import), out: request.out, origin: request.origin, fail,
        rasterize: (image) => convert({ ...image, ...location }),
      });
      return { mode: 'import', ok: true, ...done };
    } catch (error) {
      if (error instanceof RuntimeUnavailableError) throw fail('the fast-browser runtime is not installed; run `fast-browser setup`');
      throw error;
    }
  }
  if (typeof request.confirm === 'string') {
    if (request.confirm.length === 0) throw fail('--confirm needs a spec path');
    const named = await readJson(path.resolve(request.confirm), 'compose spec');
    if (!named || typeof named.out !== 'string' || !named.out.endsWith('.png')) throw fail('the compose spec names no board to confirm');
    const board = await confinedScreenshotPath(paths, named.out, 'out', fail);
    const outDir = path.dirname(board);
    const done = await confirmRedactions({
      dir: outDir, stem: path.basename(board, '.png'), fail, confine: bundleFile(paths, outDir, fail),
    });
    return { mode: 'confirm', ok: true, ...done };
  }

  const specPath = path.resolve(request.spec);
  const spec = await readJson(specPath, 'compose spec');
  const panels = Array.isArray(spec?.panels) ? spec.panels : [];
  const captures = [];
  for (const panel of panels) {
    if (typeof panel?.capture !== 'string' || panel.capture.length === 0) { captures.push(null); continue; }
    captures.push(await loadCapture({ sidecarPath: path.resolve(path.dirname(specPath), panel.capture), fail }));
  }
  const problems = validateSpec(spec, captures);
  // Frame and boxes were scaled to image pixels at load; no other scale has a layout.
  captures.forEach((capture, index) => {
    if (capture && !COMPOSABLE_SCALES.includes(capture.scale)) {
      problems.push(`panels[${index}].capture was taken at a scale this version cannot compose`);
    }
  });
  if (problems.length) throw fail(`the compose spec has problems:\n- ${problems.join('\n- ')}`);
  const outPath = await confinedScreenshotPath(paths, spec.out, 'out', fail);
  const stem = path.basename(outPath, '.png'); const outDir = path.dirname(outPath);
  for (const input of [specPath, ...captures.flatMap((capture) => [capture.pngPath, capture.sidecarPath])]) {
    const besideBoard = await sameFile(path.dirname(input), outDir);
    if (await sameFile(input, outPath) || (besideBoard && isRedactionArtifact(path.basename(input), stem))) {
      throw fail('out must not name the spec or one of its captures');
    }
  }

  // An imported capture has no measurements: its frame and boxes are the panel's own, placed by inspection.
  const drawn = captures.map((capture, index) => (capture.source === 'import'
    ? { ...capture, frame: panels[index].frame, boxes: panels[index].boxes ?? {} } : capture));

  const location = await (supplied.rendererLocation ?? defaultRendererLocation)(paths, supplied);
  if (!location || location.status) throw fail(RENDERER_REMEDIES[location?.status] ?? RENDERER_REMEDIES.missing);
  const fontBytes = await readFile(new URL('../../assets/fonts/InterVariable.woff2', import.meta.url));
  const layoutSource = await readFile(new URL('../compose/page-layout.js', import.meta.url), 'utf8');
  const geometrySource = await readFile(new URL('../compose/page-geometry.js', import.meta.url), 'utf8');
  const html = buildBoardHtml({ spec, captures: drawn, fontBytes, geometrySource, layoutSource });
  // The page decides the same thing from the same inputs; a layout bug must not be able to ungate a board.
  const redacts = (index) => (panels[index].marks ?? []).some((mark) => 'redact' in mark);
  const expectGated = drawn.some((capture, index) => capture.source === 'import' && redacts(index));
  // An empty record is what lets the operator confirm that a board hides nothing.
  const unredacted = !panels.some((_panel, index) => redacts(index));
  // Cleared before drawing, so a render that dies cannot leave a confirmed record beside a new board.
  try { await clearRedactionArtifacts(outDir, stem); } catch { throw fail('the earlier redaction crops could not be removed'); }
  let discard = expectGated;
  try {
    let rendered;
    try {
      rendered = await (supplied.renderBoard ?? defaultRenderBoard)({ html, outPath, ...location });
    } catch (error) {
      if (error instanceof RuntimeUnavailableError) {
        throw fail('the fast-browser runtime is not installed; run `fast-browser setup`');
      }
      throw error;
    }
    const { report, pixels } = rendered;
    if (Boolean(report.gated) !== expectGated) {
      discard = true;
      throw fail('the renderer disagrees with compose about whether this board is gated');
    }
    if (report.gated && (rendered.crops ?? []).length !== report.crops.length) throw fail('the renderer returned the wrong number of redaction crops');
    const recorded = report.gated || unredacted;
    if (recorded && !Buffer.isBuffer(rendered.board)) throw fail('the renderer returned no board');
    const redactions = recorded
      ? await writeRedactionRecord({
        stem, boardPath: outPath, boardBytes: rendered.board, fail, confine: bundleFile(paths, outDir, fail),
        crops: report.gated ? rendered.crops.map((bytes, i) => ({ bytes, panel: report.crops[i].panel })) : [],
      })
      : null;
    return {
      mode: 'render', ok: true, out: outPath, warnings: report.warnings ?? [], width: pixels.width, height: pixels.height,
      ...(redactions ? { redactions } : {}),
    };
  } catch (error) {
    if (discard) await discardGatedBoard({ paths, outPath, cause: error });
    throw error;
  }
}

// A gated board is only ever on disk with its crops and record beside it. The
// folder is resolved again because it may have been swapped for a link while the
// renderer ran; the crops and record go on a best-effort basis, the board must go.
async function discardGatedBoard({ paths, outPath, cause }) {
  try {
    const board = await bundleFile(paths, path.dirname(outPath), fail)(path.basename(outPath));
    await rm(board, { force: true });
    await clearRedactionArtifacts(path.dirname(board), path.basename(board, '.png')).catch(() => {});
  } catch {
    const reason = cause instanceof LifecycleError ? cause.message : 'the render failed';
    throw fail(`${reason}; the board could not be removed`);
  }
}
