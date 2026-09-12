import { loadConfig as loadLocalConfig } from '../core/config.mjs';
import { cloudConfig as parseCloudConfig, isCloudInvocation } from '../core/env-config.mjs';
import { pruneSessions as defaultPruneSessions } from '../sessions/retention.mjs';
import { launchRuntime as defaultLaunchRuntime } from './launch.mjs';
import { waitForSidecar as defaultWaitForSidecar } from './preflight.mjs';

async function defaultReadToken() {
  const { readToken } = await import('../keychain/keychain.mjs');
  return readToken();
}

// THE fork point. This is the only place in the codebase that reads
// FAST_BROWSER_ENGINE, and the only place that decides cloud versus local.
// Everything downstream is handed a config object and reads config.engine
// off it. If a second module ever branches on "am I in cloud mode", the two
// paths have begun to drift and that is a bug, not a convenience.
export async function startRuntime({ env, paths, lock, deps = {} }) {
  const loadConfig = deps.loadConfig ?? loadLocalConfig;
  const cloudConfig = deps.cloudConfig ?? parseCloudConfig;
  const waitForSidecar = deps.waitForSidecar ?? defaultWaitForSidecar;
  const launchRuntime = deps.launchRuntime ?? defaultLaunchRuntime;
  const readToken = deps.readToken ?? defaultReadToken;
  const pruneSessions = deps.pruneSessions ?? defaultPruneSessions;
  const warn = deps.warn ?? ((line) => process.stderr.write(`${line}\n`));

  if (isCloudInvocation(env)) {
    const config = await cloudConfig(env);
    // Fail before serving MCP. A misconfigured endpoint that surfaced as a
    // hanging first tool call would be far worse to debug from a pod log.
    await waitForSidecar({ endpoint: config.cdpEndpoint });
    // No readToken: cattle never pair, and omitting it here is what makes
    // that structural rather than conventional.
    return launchRuntime({ config, paths, lock });
  }

  const config = await loadConfig(paths);
  // Not awaited: the MCP handshake is latency-sensitive and the prune is
  // housekeeping. Its failure is reported, never propagated, so retention
  // can never be the reason the browser did not start.
  const retention = pruneSessions({
    paths,
    now: new Date(),
    retentionDays: config.sessions.retentionDays,
  }).catch((error) => {
    warn(`fast-browser-mcp: output retention skipped: ${error?.message ?? error}`);
  });
  const code = await launchRuntime({ config, paths, lock, readToken });
  await retention;
  return code;
}
