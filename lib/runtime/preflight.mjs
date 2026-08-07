const DEFAULT_DEADLINE_MS = 30_000;
const DEFAULT_INTERVAL_MS = 500;

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

export async function waitForSidecar({
  endpoint,
  fetchImpl = fetch,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  log = (line) => process.stderr.write(`${line}\n`),
  deadlineMs = DEFAULT_DEADLINE_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
}) {
  const url = `${endpoint.replace(/\/+$/, '')}/json/version`;
  const expiresAt = now() + deadlineMs;
  let lastCause = 'no attempt made';

  for (;;) {
    try {
      const response = await fetchImpl(url);
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
