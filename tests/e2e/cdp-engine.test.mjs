import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { startEntrypointClient } from './helpers/mcp-client.mjs';

// The end-to-end proof for the whole cloud-CDP-engine project (Tasks 1-6):
// CDP over a localhost debugging port is indistinguishable, from the
// runtime's point of view, from CDP to a same-pod Chrome sidecar -- both are
// just "an http(s) endpoint whose /json/version answers with a
// webSocketDebuggerUrl" -- which is exactly what makes the cloud path
// testable here, on a laptop, with no k8s and no sidecar container.

const pluginRoot = fileURLToPath(new URL('../../', import.meta.url));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function endpointIsReady(endpoint, deadlineMs = 15_000) {
  const expiresAt = Date.now() + deadlineMs;
  for (;;) {
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    if (Date.now() > expiresAt) return false;
    await delay(250);
  }
}

// Starts headless Chrome on an OS-assigned port (`--remote-debugging-port=0`)
// and reads the port back out of Chrome's own DevTools activity log rather
// than pinning a fixed port -- the two tests in this file that need a live
// Chrome each get their own instance, and a fixed shared port would make
// them unable to run concurrently (node:test's default is sequential, so
// this is belt-and-suspenders, not a fix for an observed collision).
async function startChrome(t) {
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'fb-cdp-chrome-'));
  const child = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let cleaned = false;
  t.after(async () => {
    if (cleaned) return;
    cleaned = true;
    child.kill('SIGKILL');
    await rm(userDataDir, { recursive: true, force: true });
  });

  const port = await new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += String(chunk);
      const match = buffer.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) {
        child.stderr.off('data', onData);
        resolve(Number(match[1]));
      }
    };
    child.stderr.on('data', onData);
    child.once('exit', (code, signal) => {
      reject(new Error(`chrome exited before printing its devtools port (code ${code}, signal ${signal})`));
    });
    setTimeout(() => reject(new Error('chrome did not print its devtools port within 15s')), 15_000);
  });

  const endpoint = `http://127.0.0.1:${port}`;
  assert.ok(await endpointIsReady(endpoint), 'chrome did not expose a cdp endpoint');
  return { child, endpoint, kill: (signal) => { cleaned = true; child.kill(signal); return rm(userDataDir, { recursive: true, force: true }); } };
}

test('the cdp engine drives a real chrome over a local debugging port', async (t) => {
  const chrome = await startChrome(t);

  const outputDir = await mkdtemp(path.join(tmpdir(), 'fb-cdp-out-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));

  // Drive bin/fast-browser-mcp.mjs through the env contract, exactly as a
  // baked MCP config in a pod would -- not startMcpClient's fixed local flag
  // list, which never reads FAST_BROWSER_ENGINE at all.
  const client = await startEntrypointClient({
    outputDir,
    env: {
      ...process.env,
      FAST_BROWSER_ENGINE: 'cdp',
      FAST_BROWSER_CDP_ENDPOINT: chrome.endpoint,
      FAST_BROWSER_OUTPUT_DIR: outputDir,
    },
  });
  t.after(() => client.close());

  const result = await client.callTool('browser_navigate', { url: 'https://example.com/' });
  assert.match(String(result), /example\.com/);
});

test('a cdp endpoint with nothing behind it exits 69 without serving mcp', async () => {
  const child = spawn(process.execPath, [path.join(pluginRoot, 'bin/fast-browser-mcp.mjs')], {
    env: {
      ...process.env,
      FAST_BROWSER_ENGINE: 'cdp',
      FAST_BROWSER_CDP_ENDPOINT: 'http://127.0.0.1:9444',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });

  const code = await new Promise((resolve) => { child.once('exit', resolve); });

  assert.equal(code, 69, 'EX_UNAVAILABLE so the controller knows to restart');
  assert.match(stderr, /9444/, 'names the endpoint that did not answer');
});

test('an unknown engine value exits 78 and never falls back to the local path', async () => {
  const child = spawn(process.execPath, [path.join(pluginRoot, 'bin/fast-browser-mcp.mjs')], {
    env: { ...process.env, FAST_BROWSER_ENGINE: 'headless' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });

  const code = await new Promise((resolve) => { child.once('exit', resolve); });

  assert.equal(code, 78, 'EX_CONFIG so the controller stops instead of crash-looping');
  assert.match(stderr, /FAST_BROWSER_ENGINE/);
});

// The boundary Task 5's own diff cannot prove: SIDECAR_LOST is produced by
// builtins/macros/flow-runner.js, which ships in this repo, but the code
// that turns a thrown macro Error into an MCP tool-call error response lives
// in the runtime fork (m4ttheweric/playwright), not here. This is the one
// place that can drive a real macro failure through that boundary and
// observe what a real MCP client actually receives.
test('a flow-runner call in flight when chrome dies surfaces SIDECAR_LOST through the mcp tool boundary', async (t) => {
  const chrome = await startChrome(t);

  const outputDir = await mkdtemp(path.join(tmpdir(), 'fb-cdp-sidecar-lost-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  await copyFile(
    path.join(pluginRoot, 'builtins/macros/flow-runner.js'),
    path.join(outputDir, 'flow-runner.js'),
  );

  const client = await startEntrypointClient({
    outputDir,
    env: {
      ...process.env,
      FAST_BROWSER_ENGINE: 'cdp',
      FAST_BROWSER_CDP_ENDPOINT: chrome.endpoint,
      FAST_BROWSER_OUTPUT_DIR: outputDir,
    },
  });
  t.after(() => client.close());

  // A page whose one button starts with pointer-events disabled, flipped
  // back on only after 8s -- far longer than this test needs. Deliberately
  // NOT a missing selector: flow-runner.js's resolveTarget() (used only to
  // LOCATE a target) routes every waitFor() rejection through
  // probeCandidates()'s blanket try/catch ("continue" on any failure,
  // connection-loss included, verified empirically against this exact
  // fixture before landing this test) and reports a plain "no locator
  // candidate matched" regardless of why the probe failed -- so a
  // disconnect during RESOLUTION can never surface as SIDECAR_LOST, only as
  // an ordinary FLOW_RUNNER_FAILURE. The button here resolves (visible)
  // immediately, so resolveTarget succeeds well before the kill; it's
  // click()'s own actionability wait -- polling "receives pointer events"
  // over real CDP round trips, per Playwright's actionability protocol --
  // that is genuinely in flight, unswallowed, when chrome dies.
  const targetPage = '<!doctype html><button id="t" style="pointer-events:none">Click me</button>'
    + '<script>setTimeout(function(){'
    + 'document.getElementById("t").style.pointerEvents="auto";'
    + '},8000);</script>';
  await client.callTool('browser_navigate', { url: `data:text/html,${encodeURIComponent(targetPage)}` });

  // Empty origin: a data: URL has no scheme://authority form, so
  // flow-runner.js's own originOf() (an intentionally minimal hand-rolled
  // parser, no URL platform global in scope) never matches it, and a
  // non-empty flow.origin here would always force a precondition
  // navigation away from the very page just set up. `origin: ''` is falsy,
  // which flow-runner.js's own precondition check treats as "skip it
  // entirely, run the steps against whatever page is already loaded" --
  // exactly what this fixture needs.
  const flow = {
    schemaVersion: 1,
    name: 'sidecar-lost-probe',
    origin: '',
    steps: [
      { op: 'click', target: { locators: [{ kind: 'css', selector: '#t' }] } },
    ],
  };

  const callPromise = client.callTool('browser_run_code_unsafe', {
    filename: 'flow-runner.js',
    args: { flow },
  });
  // Purely to stop Node from surfacing the eventual (expected) rejection as
  // an unhandled-rejection warning before assert.rejects attaches its own
  // handler below (same reasoning as drift-harness.test.mjs's own kill leg).
  callPromise.catch(() => {});

  // Give resolution (near-instant: the button is visible from first paint)
  // time to finish and click()'s actionability polling to genuinely start
  // before the kill -- too early risks racing the navigate/dispatch
  // handshake instead of a real in-flight CDP call.
  await delay(500);
  await chrome.kill('SIGKILL');

  await assert.rejects(callPromise, (error) => {
    t.diagnostic(`observed rejection: ${error.message}`);
    assert.match(
      error.message,
      /SIDECAR_LOST:/,
      'flow-runner\'s SIDECAR_LOST classification did not survive the mcp tool boundary',
    );
    return true;
  });
});
