// tests/e2e/video.test.mjs
//
// End to end over the pinned runtime's --save-video flag and the plugin's
// `gif` CLI: a managed (runtime-launched, headless) session with recording
// enabled must leave a finalized WebM in the `videos` subdirectory of the
// output directory once the session closes, and the real `fast-browser gif`
// child process must convert that WebM into a GIF inside a temp home's
// screenshots directory. Everything runs against temp directories; the
// developer's real ~/.fast-browser is never touched (the CLI child gets
// HOME overridden, the same convention as tests/e2e/annotate.test.mjs).
//
// This harness launches its own headless browser, one of the two session
// kinds the runtime records. The other, the production one -- an extension
// relay attached to real Chrome -- needs a headed browser with the unpacked
// extension loaded, so it is proven by the pinned runtime's own
// tests/extension/save-video.spec.ts rather than re-staged here; both paths
// share the recording pipeline this test exercises end to end.
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import {
  mkdir, mkdtemp, readdir, readFile, rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { startMcpClient } from './helpers/mcp-client.mjs';

const execFile = promisify(execFileCallback);
const pluginRoot = fileURLToPath(new URL('../../', import.meta.url));

// WebM is an EBML container; every valid file opens with this magic.
const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

// Visible, animated content so the recording has real frames to encode: a
// counter the interactions below advance, plus a continuous CSS animation so
// the screencast keeps emitting frames between the discrete steps (a static
// page repaints nothing, and a recording of nothing is 0.04s long however
// long the session stays open).
const PAGE = `data:text/html,${encodeURIComponent(`
<meta charset="utf-8">
<style>body{margin:0;font:48px Helvetica,Arial,sans-serif;background:#fff}
#n{display:block;padding:80px;color:#123}
#spin{width:120px;height:120px;margin:0 80px;background:#36c;animation:r 1s linear infinite}
@keyframes r{to{transform:rotate(360deg)}}</style>
<span id="n">step 0</span>
<div id="spin"></div>
<script>let s=0;function step(){s+=1;document.getElementById('n').textContent='step '+s}</script>`)}`;

async function newestWebm(videosDir) {
  let names;
  try {
    names = await readdir(videosDir);
  } catch {
    return null;
  }
  const webms = names.filter((name) => name.endsWith('.webm'));
  return webms.length > 0 ? webms[webms.length - 1] : null;
}

// The WebM finalizes when the recorded context closes, which happens as the
// runtime process exits after client.close(); poll rather than assume the
// write has settled the instant the transport is gone.
async function settledWebm(videosDir) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const name = await newestWebm(videosDir);
    if (name) {
      const bytes = await readFile(path.join(videosDir, name));
      if (bytes.length >= 1024 && bytes.subarray(0, 4).equals(EBML_MAGIC)) {
        return { name, bytes };
      }
    }
    await new Promise((resolve) => { setTimeout(resolve, 200); });
  }
  return null;
}

test('a managed session records a finalized webm and the gif CLI converts it', async (t) => {
  // The output dir doubles as the temp home's data dir: pointing the runtime
  // at `<tempHome>/.fast-browser` means its recordings land exactly where the
  // gif CLI (run with HOME=tempHome) will look for them, mirroring how
  // launchRuntime pins --output-dir to the real data dir in production.
  const tempHome = await mkdtemp(path.join(os.tmpdir(), 'fb-video-e2e-home-'));
  t.after(() => rm(tempHome, { recursive: true, force: true }).catch(() => {}));
  const outputDir = path.join(tempHome, '.fast-browser');
  await mkdir(outputDir, { recursive: true });

  const client = await startMcpClient({
    outputDir,
    extraArgs: ['--save-video', '800x600'],
  });
  let closed = false;
  t.after(() => (closed ? Promise.resolve() : client.close().catch(() => {})));

  await client.callTool('browser_navigate', { url: PAGE });
  // A couple of real interactions, spaced with genuine waits: the screencast
  // timestamps frames in wall time, so back-to-back evaluate calls produce a
  // recording a few hundredths of a second long, which an fps filter then
  // reduces to zero frames. The waits are what give the clip real duration.
  await client.callTool('browser_evaluate', { function: '() => step()' });
  await client.callTool('browser_wait_for', { time: 1 });
  await client.callTool('browser_evaluate', { function: '() => step()' });
  await client.callTool('browser_wait_for', { time: 1 });
  await client.callTool('browser_evaluate', {
    function: '() => document.getElementById("n").textContent',
  });
  await client.close();
  closed = true;

  const videosDir = path.join(outputDir, 'videos');
  const recording = await settledWebm(videosDir);
  assert.ok(recording, 'a finalized webm appears in the videos directory');
  assert.ok(
    recording.bytes.subarray(0, 4).equals(EBML_MAGIC),
    'the recording opens with the EBML magic',
  );
  assert.ok(
    recording.bytes.length >= 1024,
    `the recording is non-trivial (${recording.bytes.length} bytes)`,
  );

  const { stdout } = await execFile(
    process.execPath,
    [
      path.join(pluginRoot, 'bin/fast-browser.mjs'),
      'gif', recording.name, '--fps', '8', '--width', '800', '--json',
    ],
    // HOME must be the temp home so the CLI resolves the same
    // .fast-browser/videos the runtime just wrote into, and its screenshots
    // directory, never the developer's real one.
    { env: { ...process.env, HOME: tempHome } },
  );
  const report = JSON.parse(stdout);

  assert.equal(report.source, path.join(videosDir, recording.name));
  assert.ok(
    report.out.startsWith(path.join(tempHome, '.fast-browser', 'screenshots')),
    'the GIF must land under the temp home, never the real one',
  );
  assert.equal(report.fps, 8);
  assert.equal(report.width, 800);

  const gifBytes = await readFile(report.out);
  assert.equal(gifBytes.subarray(0, 6).toString('latin1'), 'GIF89a');
  assert.ok(gifBytes.length > 0, 'the GIF has content');
});
