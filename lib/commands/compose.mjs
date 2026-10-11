import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { loadCapture, sealCapture } from '../compose/capture.mjs';
import {
  RuntimeUnavailableError, playwrightCorePath, renderBoard as defaultRenderBoard,
} from '../compose/engine.mjs';
import { buildBoardHtml } from '../compose/page.mjs';
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

async function readJson(file, what) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { throw fail(`unable to read the ${what}`); }
}

export async function compose(request, supplied = {}) {
  const paths = supplied.paths ?? resolvePaths({ homeDir: supplied.homeDir, pluginRoot: supplied.pluginRoot });
  if (request.seal) {
    const captureReturn = await readJson(request.seal, 'capture return');
    const { sidecar, png } = await sealCapture({ paths, captureReturn, fail });
    return { mode: 'seal', ok: true, sidecar, png };
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
  // Boxes are CSS pixels; a scaled capture would misplace redaction fills.
  captures.forEach((capture, index) => {
    if (capture && capture.scale !== 1) {
      problems.push(`panels[${index}].capture was taken at a scale this version cannot compose`);
    }
  });
  if (problems.length) throw fail(`the compose spec has problems:\n- ${problems.join('\n- ')}`);
  const outPath = await confinedScreenshotPath(paths, spec.out, 'out', fail);
  const inputs = [specPath, ...captures.flatMap((capture) => [capture.pngPath, capture.sidecarPath])];
  if (inputs.some((input) => path.resolve(input) === outPath)) {
    throw fail('out must not name the spec or one of its captures');
  }

  const location = await (supplied.rendererLocation ?? defaultRendererLocation)(paths, supplied);
  if (!location || location.status) throw fail(RENDERER_REMEDIES[location?.status] ?? RENDERER_REMEDIES.missing);
  const fontBytes = await readFile(new URL('../../assets/fonts/InterVariable.woff2', import.meta.url));
  const layoutSource = await readFile(new URL('../compose/page-layout.js', import.meta.url), 'utf8');
  const geometrySource = await readFile(new URL('../compose/page-geometry.js', import.meta.url), 'utf8');
  const html = buildBoardHtml({ spec, captures, fontBytes, geometrySource, layoutSource });
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
  return { mode: 'render', ok: true, out: outPath, warnings: report.warnings ?? [], width: pixels.width, height: pixels.height };
}
