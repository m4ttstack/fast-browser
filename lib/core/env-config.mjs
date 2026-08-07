import { access as fsAccess } from 'node:fs/promises';
import { constants } from 'node:fs';

import { defaultConfig } from './config.mjs';

// Every engine this contract will accept. `cdp` is the only one today;
// a launch()-based local-headless engine would be added here and in
// lib/runtime/engine.mjs together.
const CLOUD_ENGINES = new Set(['cdp']);
const ENDPOINT_PROTOCOLS = new Set(['http:', 'https:']);

// Exit 78 is sysexits' EX_CONFIG: not retryable. Restarting a pod with a
// bad manifest just crash-loops, so the controller must stop and surface it
// rather than burn restarts. Contrast SidecarUnreachableError's 69.
export class EnvContractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EnvContractError';
    this.exitCode = 78;
  }
}

// The single fork point's predicate. Presence forks, not validity: an
// unknown engine value must fail loudly rather than fall through to the
// local path, because silently running a laptop-shaped launch inside a pod
// is a worse outcome than not starting. `!== undefined`, not `Boolean(...)`:
// a k8s manifest can set the variable to an EMPTY string (an ordinary
// `value: ""`, or an unset variable expansion) while still leaving the key
// present, and `Boolean('')` is false -- that used to fall through to the
// local path silently, which in a pod serving MCP in `--extension` mode
// with no extension present hangs on the first tool call, exactly the
// outcome preflight below exists to turn into a loud, named exit-78 failure
// instead.
export function isCloudInvocation(env) {
  return env.FAST_BROWSER_ENGINE !== undefined;
}

function requireEndpoint(value) {
  if (!value) {
    throw new EnvContractError('FAST_BROWSER_CDP_ENDPOINT is required when FAST_BROWSER_ENGINE is set');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new EnvContractError(`FAST_BROWSER_CDP_ENDPOINT is not a valid URL: ${value}`);
  }
  if (!ENDPOINT_PROTOCOLS.has(parsed.protocol)) {
    throw new EnvContractError(
      `FAST_BROWSER_CDP_ENDPOINT must be http or https, got ${parsed.protocol}`,
    );
  }
  return value;
}

export async function cloudConfig(env, dependencies = {}) {
  const access = dependencies.access ?? fsAccess;

  const engine = env.FAST_BROWSER_ENGINE;
  if (!CLOUD_ENGINES.has(engine)) {
    throw new EnvContractError(
      `FAST_BROWSER_ENGINE must be one of ${[...CLOUD_ENGINES].join(', ')}, got ${engine}`,
    );
  }

  const cdpEndpoint = requireEndpoint(env.FAST_BROWSER_CDP_ENDPOINT);

  // Readability only. The contents are the runtime's business, never this
  // process's: forwarding a path keeps credential values out of fast-browser
  // entirely, which is what makes the runtime's redaction guarantee hold end
  // to end.
  let secretsFile = null;
  if (env.FAST_BROWSER_SECRETS) {
    try {
      await access(env.FAST_BROWSER_SECRETS, constants.R_OK);
    } catch {
      throw new EnvContractError(
        `FAST_BROWSER_SECRETS is not readable: ${env.FAST_BROWSER_SECRETS}`,
      );
    }
    secretsFile = env.FAST_BROWSER_SECRETS;
  }

  // Deliberately no FAST_BROWSER_FLOWS_DIR. The runtime has no concept of
  // macros; the agent reads them from paths.macrosDir and passes scripts to
  // browser_run_code_unsafe. The controller bakes the composed set into
  // $HOME/.fast-browser/macros, which lib/macros/install.mjs already
  // hard-asserts is the only legal location.

  // One flag governs traces and session recording together. Two knobs that
  // can disagree is how customer data leaks onto a pod's disk by accident.
  const debugCapture = env.FAST_BROWSER_DEBUG_CAPTURE === '1'
    || env.FAST_BROWSER_DEBUG_CAPTURE === 'true';

  const base = defaultConfig();
  return {
    ...base,
    engine,
    cdpEndpoint,
    secretsFile,
    outputDir: env.FAST_BROWSER_OUTPUT_DIR || null,
    debugCapture,
    trace: debugCapture,
    sessions: { ...base.sessions, enabled: debugCapture },
    // Defence in depth. The entrypoint branch already keeps the cloud path
    // away from readToken; 'manual' means launchRuntime would not reach for
    // a Keychain token even if that branch were bypassed.
    connection: { mode: 'manual' },
  };
}
