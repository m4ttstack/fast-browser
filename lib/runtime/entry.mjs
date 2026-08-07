import { loadConfig as loadLocalConfig } from '../core/config.mjs';
import { cloudConfig as parseCloudConfig, isCloudInvocation } from '../core/env-config.mjs';
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
  return launchRuntime({ config, paths, lock, readToken });
}
