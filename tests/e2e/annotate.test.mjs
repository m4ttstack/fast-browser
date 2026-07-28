// tests/e2e/annotate.test.mjs
//
// Step 1 finding, established empirically against the pinned runtime
// (fast-browser-mcp 0.1.0-alpha.7, the version this repo's runtime-lock.json
// pins and the default `tests/e2e` release dir ships): `browser_run_code_unsafe`'s
// `filename` is subject to a path-containment check, not merely resolved
// relative to some directory. Passing an absolute path to the real builtin
// macro at `<pluginRoot>/builtins/macros/capture-annotated.js` was refused
// outright:
//
//   Error: File access denied: <pluginRoot>/builtins/macros/capture-annotated.js
//   is outside allowed roots. Allowed roots: <outputDir>, <outputDir>
//
// (the root list is doubled because tests/e2e/helpers/mcp-client.mjs starts
// the runtime with BOTH `cwd: outputDir` and `--output-dir=${outputDir}`, so
// in this harness both allowed roots happen to be the same directory.) So
// `filename` must name a file inside one of those roots. A bare relative
// name such as `'capture-annotated.js'` would also resolve there, but only
// because this harness happens to set cwd === outputDir; per the brief, this
// test does not lean on that coupling. Instead it copies the builtin macro
// into `outputDir` (in the `harness()` helper below) and always calls
// `browser_run_code_unsafe` with that copy's absolute path, which satisfies
// the containment check regardless of which of the two (identical, here)
// roots actually does the resolving.
//
// Separately: the macro's `home` argument (see the comment in
// builtins/macros/capture-annotated.js) cannot be read from
// `process.env.HOME` -- `browser_run_code_unsafe` executes with no Node
// globals at all, so the macro has no way to see the environment. The caller
// must supply `home` explicitly. The `annotate` CLI, invoked here as a real
// child process, independently resolves its own paths from `process.env.HOME`
// (lib/core/paths.mjs). For the macro's screenshot and the CLI's lookup of
// the config's `base` name to agree on where the screenshots directory is --
// and for neither to touch the developer's real `~/.fast-browser/` -- this
// test creates one temp directory (`tempHome`), passes it as the macro's
// `home`, and sets `HOME` to that same directory in the environment of the
// `fast-browser.mjs` child process. Verified directly (outside this suite,
// with an ad hoc script running this exact flow): `ls -la ~/.fast-browser`
// taken before and after showed no new files and an unchanged `config.json`
// mtime, confirming the real home directory is never touched.
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import {
  copyFile, mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { defaultConfig } from '../../lib/core/config.mjs';
import { saveConfig } from '../../lib/core/files.mjs';
import { resolvePaths } from '../../lib/core/paths.mjs';
import { readPngSize } from '../../lib/annotate/png.mjs';
import { rasterise } from '../../lib/annotate/render.mjs';
import { buildSvg } from '../../lib/annotate/svg.mjs';
import { startMcpClient } from './helpers/mcp-client.mjs';

const execFile = promisify(execFileCallback);
const pluginRoot = fileURLToPath(new URL('../../', import.meta.url));

// A data: URL avoids standing up a fixture server for three rows of markup.
const PAGE = `data:text/html,${encodeURIComponent(`
<meta charset="utf-8">
<style>body{margin:0;font:14px Helvetica,Arial,sans-serif}
.row{display:flex;justify-content:space-between;padding:9px 20px}.v{font-weight:600}</style>
<div class="row"><span>Name</span><span class="v" id="nm">Dana Whitfield</span></div>
<div class="row"><span>Policy</span><span class="v">PA-99-4471-02</span></div>
<div class="row"><span>Estimate</span><span class="v" id="est">$4,182.60</span></div>`)}`;

async function harness(t) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'fb-annot-e2e-out-'));
  // A separate temp directory stands in for the real $HOME: it is where the
  // macro writes its capture and where the CLI (run with HOME overridden to
  // match) looks for it. Never the developer's actual home.
  const tempHome = await mkdtemp(path.join(os.tmpdir(), 'fb-annot-e2e-home-'));

  // Copied into outputDir, not referenced from builtins/macros/ directly: see
  // the file-level comment above for why an absolute path outside outputDir
  // is refused by the runtime's own containment check.
  const macroPath = path.join(outputDir, 'capture-annotated.js');
  await copyFile(
    path.join(pluginRoot, 'builtins/macros/capture-annotated.js'),
    macroPath,
  );

  // The `annotate` CLI refuses to run without a chosen palette (see
  // lib/commands/annotate.mjs). Writing config.json directly under tempHome
  // is simpler and more direct than shelling out to `fast-browser configure`.
  const paths = resolvePaths({ homeDir: tempHome, pluginRoot });
  await saveConfig(paths, { ...defaultConfig(), annotation: { palette: 'violet' } });

  const client = await startMcpClient({ outputDir });
  t.after(async () => {
    await client.close?.();
    await rm(outputDir, { recursive: true, force: true });
    await rm(tempHome, { recursive: true, force: true });
  });
  return {
    client, outputDir, tempHome, macroPath,
  };
}

// startMcpClient's callTool already JSON-parses a text result that is
// entirely JSON (see textResult() in helpers/mcp-client.mjs), so the macro's
// payload comes back as a plain object, not text requiring its own
// extraction.
async function measure(client, macroPath, tempHome, args) {
  const result = await client.callTool('browser_run_code_unsafe', {
    filename: macroPath,
    args: { ...args, home: tempHome },
  });
  assert.equal(
    typeof result,
    'object',
    `macro returned no JSON payload: ${JSON.stringify(result)}`,
  );
  return result;
}

test('capture-annotated resolves, reports misses, and annotate rasterises', async (t) => {
  const {
    client, outputDir, tempHome, macroPath,
  } = await harness(t);
  await client.callTool('browser_navigate', { url: PAGE });

  const measured = await measure(client, macroPath, tempHome, {
    out: 'e2e-annotate',
    targets: {
      estimate: '#est', // exactly one match
      name: '#nm', // exactly one match
      missing: '#not-here', // no match
      ambiguous: '.v', // three matches
    },
  });

  assert.equal(measured.schemaVersion, 1);
  assert.ok(measured.resolved.estimate, 'the unambiguous target resolves');
  assert.ok(measured.resolved.name, 'the redaction target resolves');
  assert.equal(measured.resolved.ambiguous, undefined, 'a multi-match never resolves');

  const reasons = Object.fromEntries(measured.missed.map((m) => [m.key, m.reason]));
  assert.equal(reasons.missing, 'no-match');
  assert.equal(reasons.ambiguous, 'ambiguous');
  const ambiguousEntry = measured.missed.find((m) => m.key === 'ambiguous');
  assert.ok(
    ambiguousEntry.count > 1,
    'the ambiguous partition records how many elements collided, not just that it collided',
  );

  const configPath = path.join(outputDir, 'e2e-annotate.json');
  await writeFile(configPath, JSON.stringify({
    base: measured.name,
    out: 'e2e-annotate-out.png',
    measured: { schemaVersion: measured.schemaVersion, viewport: measured.viewport },
    annotations: [
      { type: 'highlight', box: measured.resolved.estimate },
      { type: 'blur', box: measured.resolved.name, amount: 9 },
    ],
  }));

  const { stdout } = await execFile(
    process.execPath,
    [path.join(pluginRoot, 'bin/fast-browser.mjs'), 'annotate', configPath, '--json'],
    // HOME must match the macro's `home` argument above: the CLI resolves
    // `base` and `out` inside `${HOME}/.fast-browser/screenshots`
    // (lib/core/paths.mjs), and that must be the same directory the macro
    // just wrote the capture into, not the developer's real home.
    { env: { ...process.env, HOME: tempHome } },
  );
  const report = JSON.parse(stdout);

  assert.ok(
    report.out.startsWith(path.join(tempHome, '.fast-browser', 'screenshots')),
    'the annotated output must land under the temp home, never the real one',
  );

  const base = readPngSize(await readFile(measured.png));
  const out = readPngSize(await readFile(report.out));
  assert.equal(out.width, base.width * 2);
  assert.equal(out.height, base.height * 2);
});

test('a measured blur actually changes the raster over its target', async (t) => {
  const {
    client, outputDir, tempHome, macroPath,
  } = await harness(t);
  await client.callTool('browser_navigate', { url: PAGE });

  const measured = await measure(client, macroPath, tempHome, {
    out: 'e2e-redact',
    targets: { name: '#nm' },
  });
  const base = await readFile(measured.png);
  const { width, height } = readPngSize(base);
  const plain = path.join(outputDir, 'plain.png');
  const blurred = path.join(outputDir, 'blurred.png');

  // Rasterise the same base twice at the same scale (no CLI/annotate
  // involved, so no upscale to compare against): once untouched, once with
  // the measured blur, so any pixel difference can only come from the blur
  // itself, never from a 1x-vs-2x scale mismatch.
  await rasterise({
    svg: buildSvg({
      base, width, height, annotations: [], palette: 'violet',
    }),
    outPath: plain,
  });
  await rasterise({
    svg: buildSvg({
      base,
      width,
      height,
      palette: 'violet',
      annotations: [{ type: 'blur', box: measured.resolved.name, amount: 9 }],
    }),
    outPath: blurred,
  });

  const [a, b] = await Promise.all([readFile(plain), readFile(blurred)]);
  assert.ok(a.length > 0 && b.length > 0);
  assert.ok(!a.equals(b), 'the blur must visibly change the raster');
});
