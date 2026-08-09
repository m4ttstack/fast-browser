import { spawn as nodeSpawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

import { isCdpAutolaunchEnabled } from '../core/env-config.mjs';
import { resolvePaths } from '../core/paths.mjs';

const DEFAULT_DEADLINE_MS = 30_000;
const DEFAULT_INTERVAL_MS = 500;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 2_500;
const DEFAULT_PROBE_TIMEOUT_MS = 300;
// URL#hostname keeps the brackets on a bracketed IPv6 literal (Node does not
// strip them), so both spellings are listed explicitly.
const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// Repo-wide convention (see lib/commands/doctor.mjs's `chrome` check): this
// plugin supports macOS only, so a single hardcoded install path stands in
// for "discovery." Injectable so tests never touch the filesystem.
const DEFAULT_CHROME_EXECUTABLE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Exit 69 is sysexits' EX_UNAVAILABLE: retryable. Ordinary sidecar startup
// skew self-heals under the pod's restartPolicy, which is where recovery
// ownership belongs. Fast Browser never supervises or reconnects.
export class SidecarUnreachableError extends Error {
  constructor(endpoint, deadlineMs, cause) {
    super(`chrome sidecar at ${endpoint} did not answer within ${deadlineMs}ms (${cause})`);
    this.name = 'SidecarUnreachableError';
    this.exitCode = 69;
  }
}

// Exported for the decision-matrix unit tests: whether autolaunch may even
// be considered lives entirely on the endpoint's hostname, independent of
// whether anything answers there. A non-localhost endpoint (including a
// typo like "lcoalhost") must never trigger a launch -- that would mean a
// mistyped manifest value silently starts spawning browsers instead of
// failing loudly, which is the opposite of what this opt-in exists for.
export function isLocalhostEndpoint(endpoint) {
  try {
    return LOCALHOST_HOSTNAMES.has(new URL(endpoint).hostname);
  } catch {
    return false;
  }
}

function portOf(endpoint) {
  const { port, protocol } = new URL(endpoint);
  if (port) return Number(port);
  return protocol === 'https:' ? 443 : 80;
}

// A raw TCP probe rather than an HTTP round trip: this only needs to answer
// "is anything listening on this port at all," and a short connect/timeout
// races nothing against waitForSidecar's own fetch-based retry loop below.
function defaultProbePort(hostname, port, { timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: hostname, port });
    const finish = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function defaultFindChrome() {
  return DEFAULT_CHROME_EXECUTABLE;
}

// Never the real profile: a dedicated directory under the fast-browser state
// dir, keyed by port so two autolaunches on different endpoints can't
// collide over the same --user-data-dir lock.
function profileDirFor(dataDir, port) {
  return path.join(dataDir, 'cdp-autolaunch', String(port));
}

// The opt-in surface itself lives in lib/core/env-config.mjs
// (isCdpAutolaunchEnabled); this is purely the launch decision + the launch
// itself, kept separate from waitForSidecar's polling loop so the
// opt-in x localhost x listener matrix is testable without exercising (or
// mocking) the full poll.
export async function maybeAutolaunchLocalChrome({
  endpoint,
  env = process.env,
  probePort = defaultProbePort,
  spawn = nodeSpawn,
  findChrome = defaultFindChrome,
  dataDir = resolvePaths().dataDir,
  log = (line) => process.stderr.write(`${line}\n`),
}) {
  if (!isCdpAutolaunchEnabled(env)) return null;
  if (!isLocalhostEndpoint(endpoint)) return null;

  // Bracket-stripped: URL#hostname keeps the brackets on a bracketed IPv6
  // literal, but net.connect's `host` option wants the bare address.
  const hostname = new URL(endpoint).hostname.replace(/^\[|\]$/g, '');
  const port = portOf(endpoint);
  const listening = await probePort(hostname, port);
  if (listening) return null;

  const userDataDir = profileDirFor(dataDir, port);
  const chromePath = await findChrome();

  let child;
  try {
    child = spawn(
      chromePath,
      [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
      ],
      { stdio: 'ignore', detached: true },
    );
  } catch (error) {
    // Fall through to the ordinary poll below, which times out into the
    // same SidecarUnreachableError a missing sidecar produces today -- one
    // failure path, not a new one just because the local launch attempt
    // itself failed to spawn.
    log(`fast-browser: cdp autolaunch failed to start chrome (${error.code ?? error.message}); `
      + 'falling back to the normal preflight wait');
    return null;
  }
  child.unref();

  log(`fast-browser: auto-launched local chrome for cdp autolaunch `
    + `(pid=${child.pid}, profile=${userDataDir})`);
  return { pid: child.pid, userDataDir };
}

export async function waitForSidecar({
  endpoint,
  fetchImpl = fetch,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  log = (line) => process.stderr.write(`${line}\n`),
  deadlineMs = DEFAULT_DEADLINE_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  attemptTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
  env = process.env,
  probePort = defaultProbePort,
  spawn = nodeSpawn,
  findChrome = defaultFindChrome,
  dataDir,
}) {
  // Opt-in absent (the mattcloud pod contract's default) short-circuits
  // before any of this runs, so the pod's SidecarUnreachableError path on a
  // dead endpoint stays byte-identical to before this function existed.
  await maybeAutolaunchLocalChrome({
    endpoint, env, probePort, spawn, findChrome, dataDir, log,
  });

  const url = `${endpoint.replace(/\/+$/, '')}/json/version`;
  const expiresAt = now() + deadlineMs;
  let lastCause = 'no attempt made';

  for (;;) {
    try {
      const budget = Math.min(attemptTimeoutMs, expiresAt - now());
      if (budget <= 0) {
        throw new SidecarUnreachableError(endpoint, deadlineMs, lastCause);
      }
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(budget) });
      if (!response.ok) {
        lastCause = `HTTP ${response.status}`;
      } else {
        const body = await response.json();
        if (body?.webSocketDebuggerUrl) {
          // The single most useful line in a pod log when a flow later
          // behaves oddly: which Chrome actually answered.
          log(`fast-browser: connected to ${body.Browser ?? 'unknown chrome'} at ${endpoint}`);
          return { browser: body.Browser ?? '', webSocketDebuggerUrl: body.webSocketDebuggerUrl };
        }
        lastCause = 'response carried no webSocketDebuggerUrl';
      }
    } catch (error) {
      lastCause = String(error?.message ?? error);
    }

    if (now() + intervalMs > expiresAt) {
      throw new SidecarUnreachableError(endpoint, deadlineMs, lastCause);
    }
    await sleep(intervalMs);
  }
}
