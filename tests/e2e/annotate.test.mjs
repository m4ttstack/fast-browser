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

// A fixture for the space measurement: #open sits in the top-left corner
// with genuinely empty viewport to its right and below, while #packed is
// walled in by text-bearing divs on all four sides. The walls are sized to
// cover every candidate band the macro can plan around #packed (the shrink
// schedule keeps the near edge 6 px off the padded target and reaches at
// most 240 px, so a wall spanning that reach on each side defeats every
// candidate), while staying clear of the top strip #open's bands live in.
// Everything is position:fixed so the page cannot scroll and inner ===
// client. The wall text wraps to fill each wall's width and (with overflow
// hidden) its height, so the glyph line rectangles the geometric occupancy
// rule judges cover every candidate band a wall is meant to defeat.
const WALL = 'lorem ipsum dolor sit amet '.repeat(30);
const SPACE_PAGE = `data:text/html,${encodeURIComponent(`
<meta charset="utf-8">
<style>body{margin:0;font:14px Helvetica,Arial,sans-serif}
.wall{position:fixed;overflow:hidden;line-height:1.2}</style>
<span id="open" style="position:fixed;left:16px;top:16px">Open field</span>
<span id="packed" style="position:fixed;left:300px;top:400px">tight value</span>
<div class="wall" style="left:180px;top:150px;width:360px;height:244px">${WALL}</div>
<div class="wall" style="left:180px;top:430px;width:360px;height:290px">${WALL}</div>
<div class="wall" style="left:0;top:360px;width:296px;height:120px">${WALL}</div>
<div class="wall" style="left:370px;top:360px;width:600px;height:120px">${WALL}</div>`)}`;

// Playwright checking the macro's claim, the same pattern the affordances
// e2e uses: a second, independent call enumerates every element that renders
// direct non-whitespace text and counts intersections with each returned
// band. The macro's own scan never runs here, so agreement is evidence,
// not tautology.
const TEXT_INTERSECTIONS = `async (page, args) => {
  return page.evaluate((boxes) => {
    const bearing = [];
    const walk = (element) => {
      for (const node of element.childNodes) {
        if (node.nodeType === 3 && /\\S/.test(node.nodeValue)) {
          bearing.push(element);
          break;
        }
      }
      for (const child of element.children) walk(child);
    };
    walk(document.body);
    return boxes.map(([x, y, w, h]) => bearing.filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left < x + w && rect.right > x && rect.top < y + h && rect.bottom > y;
    }).length);
  }, args.boxes);
}
`;

// One fixture per empirically confirmed blind spot of the original
// elementFromPoint-sampling occupancy rule, each reproduced live against the
// pinned runtime before the geometric rule replaced it: text small enough to
// sit between fixed sample points, visible text under pointer-events:none
// (which hit-testing can never return), an iframe full of text (absent from
// the visual selector list), and a background image painted by an ancestor
// or the body while a transparent element takes the hit. Every page keeps
// the same target so band geometry is comparable, and the first three keep
// the space above the target genuinely open so the test also proves the
// scan is not refusing everything.
const TINY_TEXT_PAGE = `data:text/html,${encodeURIComponent(`
<meta charset="utf-8">
<style>body{margin:0;font:14px Helvetica,Arial,sans-serif}</style>
<span id="t" style="position:fixed;left:300px;top:300px">target value</span>
<span id="decoy" style="position:fixed;left:318px;top:364px;font-size:12px">XX</span>`)}`;

// The text node is a child of the ShadowRoot itself, not of any element:
// root.textContent creates exactly that shape, and a scan that only reads
// element.childNodes never sees it.
const SHADOW_TEXT_PAGE = `data:text/html,${encodeURIComponent(`
<meta charset="utf-8">
<style>body{margin:0;font:14px Helvetica,Arial,sans-serif}</style>
<span id="t" style="position:fixed;left:300px;top:300px">target value</span>
<div id="decoy" style="position:fixed;left:280px;top:340px;width:200px;height:200px;overflow:hidden"></div>
<script>document.getElementById('decoy').attachShadow({mode:'open'}).textContent = 'ghost text '.repeat(40);</script>`)}`;

const POINTER_EVENTS_PAGE = `data:text/html,${encodeURIComponent(`
<meta charset="utf-8">
<style>body{margin:0;font:14px Helvetica,Arial,sans-serif}</style>
<span id="t" style="position:fixed;left:300px;top:300px">target value</span>
<div id="decoy" style="position:fixed;left:280px;top:340px;width:200px;height:200px;pointer-events:none;overflow:hidden">${WALL}</div>`)}`;

const IFRAME_PAGE = `data:text/html,${encodeURIComponent(`
<meta charset="utf-8">
<style>body{margin:0;font:14px Helvetica,Arial,sans-serif}</style>
<span id="t" style="position:fixed;left:300px;top:300px">target value</span>
<iframe id="decoy" style="position:fixed;left:250px;top:340px;width:300px;height:300px;border:0" srcdoc="${WALL}"></iframe>`)}`;

const ANCESTOR_GRADIENT_PAGE = `data:text/html,${encodeURIComponent(`
<meta charset="utf-8">
<style>body{margin:0;font:14px Helvetica,Arial,sans-serif}</style>
<div style="position:fixed;inset:0;background-image:linear-gradient(#fff,#889)">
<div style="width:100%;height:100%">
<span id="t" style="position:fixed;left:300px;top:300px">target value</span>
</div></div>`)}`;

// The body's own box is 0 px tall here (every child is fixed), so this only
// refuses correctly if the rule honours background propagation to the
// canvas rather than judging the body's rectangle.
const BODY_GRADIENT_PAGE = `data:text/html,${encodeURIComponent(`
<meta charset="utf-8">
<style>body{margin:0;font:14px Helvetica,Arial,sans-serif;background-image:linear-gradient(#fff,#889)}</style>
<span id="t" style="position:fixed;left:300px;top:300px">target value</span>`)}`;

// Independent measurement of a decoy's box, so the non-intersection
// assertions below compare the macro's bands against Playwright's own idea
// of where the decoy is, not against coordinates the fixture hard-codes.
const RECT_OF = `async (page, args) => page.evaluate((selector) => {
  const rect = document.querySelector(selector).getBoundingClientRect();
  return [rect.left, rect.top, rect.width, rect.height];
}, args.selector)
`;

async function harness(t) {
  // Each rm is registered right after its own mkdtemp, not batched at the end
  // of this function: startMcpClient below reads a manifest, validates a
  // checksum, and extracts a tarball into outputDir/.runtime before it
  // returns, and any of those throwing must still leave neither temp
  // directory orphaned. Each hook also catches its own rejection, so one
  // teardown failing never cancels the others (see
  // tests/e2e/simultaneous.test.mjs for the same convention).
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'fb-annot-e2e-out-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }).catch(() => {}));
  // A separate temp directory stands in for the real $HOME: it is where the
  // macro writes its capture and where the CLI (run with HOME overridden to
  // match) looks for it. Never the developer's actual home.
  const tempHome = await mkdtemp(path.join(os.tmpdir(), 'fb-annot-e2e-home-'));
  t.after(() => rm(tempHome, { recursive: true, force: true }).catch(() => {}));

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
  // startMcpClient always returns a close function (see
  // tests/e2e/direct-mcp.test.mjs, which calls it plainly), so no optional
  // chaining is needed here.
  t.after(() => client.close().catch(() => {}));
  return {
    client, outputDir, tempHome, macroPath,
  };
}

// startMcpClient's callTool already JSON-parses a text result that is
// entirely JSON (see textResult() in helpers/mcp-client.mjs), so the macro's
// payload comes back as a plain object, not text requiring its own
// extraction. Asserting schemaVersion here (rather than just `typeof result
// === 'object'`) matters because the macro's own structured failure payload
// -- `{ failedStep, error }`, e.g. the prior `home`-argument ReferenceError
// -- is also an object and would otherwise slip past a bare typeof check and
// fail confusingly later with no reference to the macro's own error string.
async function measure(client, macroPath, tempHome, args) {
  const result = await client.callTool('browser_run_code_unsafe', {
    filename: macroPath,
    args: { ...args, home: tempHome },
  });
  assert.equal(
    result?.schemaVersion,
    1,
    `macro did not return a schemaVersion-1 payload: ${JSON.stringify(result)}`,
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

  const baseBytes = await readFile(measured.png);
  const base = readPngSize(baseBytes);
  const outBytes = await readFile(report.out);
  const out = readPngSize(outBytes);
  assert.equal(out.width, base.width * 2);
  assert.equal(out.height, base.height * 2);

  // Pixel-level proof that the CLI actually drew the annotations, not merely
  // produced a correctly sized image: rasterise the same base bytes at the
  // same scale and the same palette the CLI just ran with (read back from its
  // own report rather than assumed, in case a config could ever choose a
  // different one), but with no annotations. rsvg-convert is deterministic,
  // so if the CLI's real output were byte-identical to this unannotated
  // control, that would mean `annotate` silently dropped every annotation
  // while still reporting success and the right dimensions -- the same shape
  // of failure this task exists to catch, one layer up from the macro. This
  // is additive to, not a replacement for, the direct buildSvg/rasterise
  // comparison in the next test.
  const scale = out.width / base.width;
  const unannotatedPath = path.join(outputDir, 'e2e-annotate-unannotated.png');
  await rasterise({
    svg: buildSvg({
      base: baseBytes,
      width: base.width,
      height: base.height,
      annotations: [],
      palette: report.palette,
      scale,
    }),
    outPath: unannotatedPath,
  });
  const unannotatedBytes = await readFile(unannotatedPath);
  assert.ok(
    !outBytes.equals(unannotatedBytes),
    'the CLI output must differ from an unannotated raster of the same base; '
    + 'equal bytes means annotate silently dropped every annotation',
  );
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

test('capture-annotated returns verified empty bands and refuses them for a walled-in target', async (t) => {
  const {
    client, outputDir, tempHome, macroPath,
  } = await harness(t);
  await client.callTool('browser_navigate', { url: SPACE_PAGE });

  const measured = await measure(client, macroPath, tempHome, {
    out: 'e2e-space',
    targets: { open: '#open', packed: '#packed' },
  });
  assert.ok(measured.resolved.open, 'the clear target resolves');
  assert.ok(measured.resolved.packed, 'the walled-in target resolves');

  const bounds = [
    Math.min(measured.viewport.inner[0], measured.viewport.client[0]),
    Math.min(measured.viewport.inner[1], measured.viewport.client[1]),
  ];
  const openBands = measured.space.open ?? [];
  assert.ok(
    openBands.length >= 1,
    `the clear target gets at least one band: ${JSON.stringify(measured.space)}`,
  );
  const [tx, ty, tw, th] = measured.resolved.open;
  for (const { box: [x, y, w, h] } of openBands) {
    assert.ok(
      x >= 0 && y >= 0 && x + w <= bounds[0] && y + h <= bounds[1],
      'every band lies inside the viewport',
    );
    assert.ok(
      x >= tx + tw || y >= ty + th || x + w <= tx || y + h <= ty,
      'a band never intersects its own target box',
    );
  }

  // The recheck covers EVERY returned band, so the walled-in target either
  // came back with no bands (the expected refusal) or with bands the
  // independent count below proves genuinely empty. Either satisfies the
  // contract; a band over a text wall fails it.
  const counterPath = path.join(outputDir, 'text-intersections.js');
  await writeFile(counterPath, TEXT_INTERSECTIONS);
  const everyBand = Object.values(measured.space).flat();
  const counts = await client.callTool('browser_run_code_unsafe', {
    filename: counterPath,
    args: { boxes: everyBand.map((band) => band.box) },
  });
  assert.deepEqual(
    counts,
    everyBand.map(() => 0),
    `every returned band must intersect zero text-bearing elements: ${JSON.stringify(measured.space)}`,
  );
});

test('space bands refuse what hit-testing missed: tiny text, pointer-events none, iframes, painted-through backgrounds', async (t) => {
  const {
    client, outputDir, tempHome, macroPath,
  } = await harness(t);
  const rectPath = path.join(outputDir, 'rect-of.js');
  await writeFile(rectPath, RECT_OF);
  const disjoint = ([bx, by, bw, bh], [dx, dy, dw, dh]) => (
    bx >= dx + dw || by >= dy + dh || bx + bw <= dx || by + bh <= dy
  );

  // Each decoy sits squarely inside the target's below-side candidates, so a
  // rule that cannot see it returns exactly the band the original one did.
  for (const [label, url] of [
    ['tiny text between the former sample points', TINY_TEXT_PAGE],
    ['bare text directly under an open shadow root', SHADOW_TEXT_PAGE],
    ['visible text under pointer-events:none', POINTER_EVENTS_PAGE],
    ['an iframe full of text', IFRAME_PAGE],
  ]) {
    await client.callTool('browser_navigate', { url });
    const measured = await measure(client, macroPath, tempHome, {
      out: 'e2e-blindspot',
      targets: { t: '#t' },
    });
    assert.ok(measured.resolved.t, `${label}: the target resolves`);
    const bands = measured.space.t ?? [];
    assert.ok(
      bands.length >= 1,
      `${label}: the open side above still yields a band: ${JSON.stringify(measured.space)}`,
    );
    const decoy = await client.callTool('browser_run_code_unsafe', {
      filename: rectPath,
      args: { selector: '#decoy' },
    });
    for (const { side, box } of bands) {
      assert.ok(
        disjoint(box, decoy),
        `${label}: the ${side} band ${JSON.stringify(box)} must not touch the decoy at ${JSON.stringify(decoy)}`,
      );
    }
  }

  // A background image behind the whole viewport leaves nowhere verifiable,
  // so the honest answer is no bands at all, and the caller falls back to
  // the target's own padded corner as the skill instructs.
  for (const [label, url] of [
    ['an ancestor painting a gradient through a transparent child', ANCESTOR_GRADIENT_PAGE],
    ['a body background propagated to the canvas', BODY_GRADIENT_PAGE],
  ]) {
    await client.callTool('browser_navigate', { url });
    const measured = await measure(client, macroPath, tempHome, {
      out: 'e2e-blindspot',
      targets: { t: '#t' },
    });
    assert.ok(measured.resolved.t, `${label}: the target resolves`);
    assert.equal(
      measured.space.t,
      undefined,
      `${label}: every band is refused: ${JSON.stringify(measured.space)}`,
    );
  }
});
