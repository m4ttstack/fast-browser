import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createServer } from 'node:net';
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

// A port nothing was listening on at the moment of the check (fix round 1,
// minor: was a hardcoded 9444, an unexplained-if-it-ever-collides failure
// mode). Bind to port 0 to get an OS-assigned free port, then release it
// immediately -- the caller re-binds moments later, so this is the ordinary
// "probably free" pattern, not a guarantee, and is only ever used for a
// deliberately-unreachable endpoint where "something else took it in the
// interim and answers real CDP" is the only failure mode, not a hang.
async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
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

  // Both the timeout timer and the 'exit' listener are torn down the moment
  // the port is found (fix round 1, minor): left dangling, the timer alone
  // held the event loop open for the rest of its 15s no matter how fast
  // chrome actually answered, which is why a run of this file's own
  // reported duration ran ~13s longer than its subtests summed to.
  const port = await new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';
    let timer;
    const onData = (chunk) => {
      buffer += String(chunk);
      const match = buffer.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) {
        settled = true;
        clearTimeout(timer);
        child.stderr.off('data', onData);
        child.off('exit', onExit);
        resolve(Number(match[1]));
      }
    };
    const onExit = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stderr.off('data', onData);
      reject(new Error(`chrome exited before printing its devtools port (code ${code}, signal ${signal})`));
    };
    child.stderr.on('data', onData);
    child.once('exit', onExit);
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.stderr.off('data', onData);
      child.off('exit', onExit);
      reject(new Error('chrome did not print its devtools port within 15s'));
    }, 15_000);
  });

  const endpoint = `http://127.0.0.1:${port}`;
  assert.ok(await endpointIsReady(endpoint), 'chrome did not expose a cdp endpoint');
  return { child, endpoint, kill: (signal) => { cleaned = true; child.kill(signal); return rm(userDataDir, { recursive: true, force: true }); } };
}

test('the cdp engine drives a real chrome over a local debugging port', async (t) => {
  const chrome = await startChrome(t);

  const outputDir = await mkdtemp(path.join(tmpdir(), 'fb-cdp-out-'));

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
  // Registered BEFORE the outputDir cleanup below (fix round 1, minor):
  // t.after hooks run in registration order, not reverse, so registering
  // them in the other order closed the client's runtime process after its
  // own working directory had already been removed out from under it.
  t.after(() => client.close());
  t.after(() => rm(outputDir, { recursive: true, force: true }));

  // A unique per-run marker on a data: URL rather than a real internet
  // fetch: this is the only test in the file that needed the network, and
  // this property is provable without it. The marker also becomes the
  // sidecar-pinning check below.
  const marker = `fb-cdp-engine-${randomUUID()}`;
  const pageHtml = `<!doctype html><title>${marker}</title><body>${marker}</body>`;
  const url = `data:text/html,${encodeURIComponent(pageHtml)}`;

  const result = await client.callTool('browser_navigate', { url });
  assert.match(String(result), new RegExp(marker));

  // Finding 1 (fix round 1, Important): the assertion above only proves
  // SOME browser navigated somewhere and returned a result mentioning the
  // marker. If the fork point (lib/runtime/entry.mjs) ever regressed and
  // FAST_BROWSER_ENGINE=cdp silently fell through to the LOCAL launch path
  // -- exactly the outcome lib/core/env-config.mjs's own "an unknown value
  // must fail loudly rather than fall through" reasoning exists to prevent
  // -- preflight would never run, some OTHER, locally launched Chrome would
  // serve the navigate just as successfully, and the check above would
  // still pass. Querying THIS test's own `chrome.endpoint` directly and
  // finding the marker among ITS OWN targets pins the page to the sidecar
  // this test started, not to "a Chrome, somewhere."
  const targets = await (await fetch(`${chrome.endpoint}/json/list`)).json();
  assert.ok(
    targets.some((target) => target.title === marker),
    `expected chrome's own /json/list at ${chrome.endpoint} to report a target titled ${marker}`,
  );
});

test('a cdp endpoint with nothing behind it exits 69 without serving mcp', { timeout: 40_000 }, async (t) => {
  const port = await getFreePort();
  const child = spawn(process.execPath, [path.join(pluginRoot, 'bin/fast-browser-mcp.mjs')], {
    env: {
      ...process.env,
      FAST_BROWSER_ENGINE: 'cdp',
      FAST_BROWSER_CDP_ENDPOINT: `http://127.0.0.1:${port}`,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  // Fix round 1, minor: no cleanup and no bound meant that if the entrypoint
  // ever regressed into serving MCP instead of exiting -- the exact
  // regression this test exists to catch -- the awaited 'exit' below would
  // hang forever instead of failing, leaking the child process besides. The
  // `timeout` option (well above the ~30s preflight deadline this test
  // legitimately waits out) turns that into a failed test, and `t.after`
  // guarantees the process is gone either way.
  t.after(() => child.kill('SIGKILL'));

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });

  const code = await new Promise((resolve) => { child.once('exit', resolve); });

  assert.equal(code, 69, 'EX_UNAVAILABLE so the controller knows to restart');
  assert.match(stderr, new RegExp(String(port)), 'names the endpoint that did not answer');
});

// --- MAT-239: local-dev CDP autolaunch, real-entrypoint proof ------------
//
// Both tests below deliberately stay CI-safe: neither one lets Chrome
// actually get spawned (the guard rails route both scenarios back into the
// ordinary "nothing answered" 30s wait), so this pair can run without a
// real Chrome anywhere on the machine. A genuine "autolaunch spawns a real
// Chrome and preflight connects to it" proof lives at the unit level in
// tests/unit/preflight.test.mjs (maybeAutolaunchLocalChrome, with `spawn`
// and `probePort` injected) instead, where it doesn't need one.

test('FAST_BROWSER_CDP_AUTOLAUNCH absent leaves the pod contract byte-identical through the real entrypoint', { timeout: 40_000 }, async (t) => {
  const port = await getFreePort();
  const child = spawn(process.execPath, [path.join(pluginRoot, 'bin/fast-browser-mcp.mjs')], {
    env: {
      ...process.env,
      FAST_BROWSER_ENGINE: 'cdp',
      FAST_BROWSER_CDP_ENDPOINT: `http://127.0.0.1:${port}`,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });

  const code = await new Promise((resolve) => { child.once('exit', resolve); });

  assert.equal(code, 69, 'EX_UNAVAILABLE so the controller knows to restart, exactly as before this feature existed');
  assert.doesNotMatch(stderr, /auto-launched local chrome/, 'no autolaunch machinery should have run at all');
});

test('FAST_BROWSER_CDP_AUTOLAUNCH set but the endpoint is not localhost is ignored and still exits 69', { timeout: 40_000 }, async (t) => {
  const port = await getFreePort();
  // 127.0.0.2, not 127.0.0.1: reachable with no DNS lookup and guaranteed
  // nothing is listening, while still exercising the "opt-in set, but this
  // is not one of the exact hostnames autolaunch treats as local" guard
  // rail -- a typo'd or non-canonical endpoint must fail loudly, not launch
  // a browser nobody asked for on some other address.
  const child = spawn(process.execPath, [path.join(pluginRoot, 'bin/fast-browser-mcp.mjs')], {
    env: {
      ...process.env,
      FAST_BROWSER_ENGINE: 'cdp',
      FAST_BROWSER_CDP_ENDPOINT: `http://127.0.0.2:${port}`,
      FAST_BROWSER_CDP_AUTOLAUNCH: '1',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });

  const code = await new Promise((resolve) => { child.once('exit', resolve); });

  assert.equal(code, 69, 'EX_UNAVAILABLE: the opt-in must not rescue a non-localhost endpoint');
  assert.doesNotMatch(stderr, /auto-launched local chrome/, 'a non-localhost endpoint must never trigger a launch');
});

test('an unknown engine value exits 78 and never falls back to the local path', { timeout: 10_000 }, async (t) => {
  const child = spawn(process.execPath, [path.join(pluginRoot, 'bin/fast-browser-mcp.mjs')], {
    env: { ...process.env, FAST_BROWSER_ENGINE: 'headless' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });

  const code = await new Promise((resolve) => { child.once('exit', resolve); });

  assert.equal(code, 78, 'EX_CONFIG so the controller stops instead of crash-looping');
  // Fix round 1, minor: `/FAST_BROWSER_ENGINE/` also matches the missing-
  // endpoint message (both exit 78), so it never actually pinned THIS
  // test's own scenario. env-config.mjs's unknown-engine message ends
  // "got <value>"; matching the value this test supplies ties the
  // assertion to the behavior its own title names.
  assert.match(stderr, /got headless/);
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
  // Same ordering fix as test 1 above: close the client (and its runtime
  // subprocess) before the directory it was reading/writing under is
  // removed.
  t.after(() => client.close());
  t.after(() => rm(outputDir, { recursive: true, force: true }));

  // A page whose one button starts with pointer-events disabled, flipped
  // back on only after 30s -- far longer than this test needs, and (fix
  // round 1, Finding 2) generous on both sides of the kill delay below, not
  // just this one. Deliberately NOT a missing selector:
  // flow-runner.js's resolveTarget() (used only to LOCATE a target) used to
  // route every waitFor() rejection through probeCandidates()'s blanket
  // try/catch regardless of cause, reporting a plain "no locator candidate
  // matched" even for a genuine disconnect -- fixed in this same commit
  // (probeCandidates now re-throws a lost-sidecar signature instead of
  // swallowing it; see builtins/macros/flow-runner.js and its own unit
  // coverage in tests/unit/flows-runner-source.test.mjs). This fixture
  // still deliberately targets the ACT phase rather than depending on that
  // fix: the button here resolves (visible) immediately, so resolveTarget
  // succeeds well before the kill; it's click()'s own actionability wait --
  // polling "receives pointer events" over real CDP round trips, per
  // Playwright's actionability protocol -- that is genuinely in flight,
  // unswallowed, when chrome dies.
  const targetPage = '<!doctype html><button id="t" style="pointer-events:none">Click me</button>'
    + '<script>setTimeout(function(){'
    + 'document.getElementById("t").style.pointerEvents="auto";'
    + '},30000);</script>';
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

  // Fix round 1, Finding 2 (Important): 500ms had no slack on its lower
  // bound -- the safe window is "resolution has completed" to "the button
  // becomes clickable," and the lower edge is only ordinary JSON-RPC
  // dispatch plus a macro file read plus one resolveTarget pass, which a
  // loaded machine could plausibly exceed, landing the kill mid-resolution
  // instead of mid-act. 2000ms leaves ample room below (resolution is
  // near-instant on a freshly loaded static page) and 30000ms above costs
  // nothing: the `click` step passes no explicit timeout, so Playwright's
  // own default action wait runs well past either number.
  await delay(2_000);
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

// --- MAT-165: the secrets round trip -------------------------------------
//
// The design spec promised this and the implementation plan dropped it, so
// `--secrets` forwarding shipped with only unit-level flag-construction
// coverage. It is the highest-stakes path in cloud mode: credentials plus the
// runtime's redaction guarantee.
//
// The awkward part is asserting the field received the REAL value. Every
// route back through a tool result is redacted by design -- that IS the
// guarantee -- so reading the field back would prove nothing about what was
// typed. This serves a real form from a local origin and asserts on what the
// SERVER received, which is the one vantage point outside the agent's view.
async function startFormServer(t) {
  const submissions = [];
  const server = http.createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/submit') {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        submissions.push(Object.fromEntries(new URLSearchParams(body)));
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<!doctype html><title>signed in</title><body>signed in</body>');
      });
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><title>sign in</title><body>
      <form method="POST" action="/submit">
        <label for="u">Username</label><input id="u" name="username">
        <label for="p">Password</label><input id="p" name="password" type="password">
        <button type="submit">Sign in</button>
      </form></body>`);
  });

  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { server.close(resolve); }));
  return { submissions, origin: `http://127.0.0.1:${server.address().port}` };
}

test('a secret fills by name, arrives at the server verbatim, and never appears in tool output', async (t) => {
  const form = await startFormServer(t);
  const chrome = await startChrome(t);

  // Unique per run so a stale value from an earlier run cannot satisfy the
  // assertions, and so the "appears nowhere" scan cannot pass by matching
  // some unrelated constant.
  const username = `user-${randomUUID()}`;
  const password = `pw-${randomUUID()}`;

  const secretsDir = await mkdtemp(path.join(tmpdir(), 'fb-cdp-secrets-'));
  const secretsFile = path.join(secretsDir, 'app.env');
  await writeFile(secretsFile, `APP_USERNAME=${username}\nAPP_PASSWORD=${password}\n`, { mode: 0o600 });

  const outputDir = await mkdtemp(path.join(tmpdir(), 'fb-cdp-out-'));
  const client = await startEntrypointClient({
    outputDir,
    env: {
      ...process.env,
      FAST_BROWSER_ENGINE: 'cdp',
      FAST_BROWSER_CDP_ENDPOINT: chrome.endpoint,
      FAST_BROWSER_OUTPUT_DIR: outputDir,
      FAST_BROWSER_SECRETS: secretsFile,
    },
  });
  t.after(() => client.close());
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  t.after(() => rm(secretsDir, { recursive: true, force: true }));

  // Every tool result this test provokes, kept for the redaction scan below.
  const outputs = [];
  const call = async (name, args) => {
    const result = String(await client.callTool(name, args));
    outputs.push(result);
    return result;
  };

  await call('browser_navigate', { url: form.origin });

  // The secret NAMES are the field values. This is the whole contract: only
  // browser_fill_form and browser_type resolve them, and the model never
  // holds the value.
  await call('browser_fill_form', {
    fields: [
      { name: 'Username', type: 'textbox', target: '#u', value: 'APP_USERNAME' },
      { name: 'Password', type: 'textbox', target: '#p', value: 'APP_PASSWORD' },
    ],
  });
  await call('browser_click', { element: 'Sign in', target: 'button[type=submit]' });

  const deadline = Date.now() + 10_000;
  while (form.submissions.length === 0 && Date.now() < deadline) await delay(100);

  assert.equal(form.submissions.length, 1, 'the form never reached the server');
  const [submitted] = form.submissions;

  // The real value arrived. Had resolution not happened, the server would
  // have received the literal name instead, which is the exact failure the
  // "never guess a secret name" guidance warns about.
  assert.equal(submitted.password, password, 'the password field did not receive the resolved secret');
  assert.equal(submitted.username, username, 'the username field did not receive the resolved secret');
  assert.notEqual(submitted.password, 'APP_PASSWORD', 'the secret name was typed in literally');

  // ...and it never passed through anything the model can see. Scanning every
  // captured result, not just the fill's, because a later snapshot or
  // console read is just as capable of leaking the field's contents.
  for (const output of outputs) {
    assert.ok(!output.includes(password), `a tool result leaked the secret value: ${output.slice(0, 200)}`);
    assert.ok(!output.includes(username), `a tool result leaked the secret value: ${output.slice(0, 200)}`);
  }

  // The positive half of the same guarantee: redaction rewrote it rather than
  // the value simply never being echoed anywhere.
  assert.ok(
    outputs.some((output) => output.includes('<secret>APP_PASSWORD</secret>')
      || output.includes("process.env['APP_PASSWORD']")),
    'no tool result showed the redacted placeholder, so redaction was never exercised',
  );
});
