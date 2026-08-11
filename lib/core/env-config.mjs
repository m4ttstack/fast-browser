import { access as fsAccess, mkdtemp as fsMkdtemp } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

// Every FAST_BROWSER_* variable the cloud contract recognizes. This has to
// live next to cloudConfig, not in a shared constants file: teaching
// cloudConfig to read a new variable and registering it here must be the
// same edit, or this allowlist drifts from what the parser actually reads
// and starts rejecting a variable that works. FAST_BROWSER_VOYAGE_API_KEY
// and FAST_BROWSER_REGISTRY_TOKEN are read elsewhere (flows/registry
// commands), not by cloudConfig itself, but a manifest that sets them
// alongside the cloud contract is still a legitimate manifest.
const KNOWN_CLOUD_ENV_VARS = new Set([
  'FAST_BROWSER_ENGINE',
  'FAST_BROWSER_CDP_ENDPOINT',
  'FAST_BROWSER_CDP_AUTOLAUNCH',
  'FAST_BROWSER_SECRETS',
  'FAST_BROWSER_OUTPUT_DIR',
  'FAST_BROWSER_DEBUG_CAPTURE',
  'FAST_BROWSER_VOYAGE_API_KEY',
  'FAST_BROWSER_REGISTRY_TOKEN',
]);

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

// Shared by every case-fold/trim boolean env flag this contract reads
// (FAST_BROWSER_DEBUG_CAPTURE below, FAST_BROWSER_CDP_AUTOLAUNCH). `TRUE`
// and `yes` are what a hand-written manifest or shell export actually
// contains; anything unrecognized reads as off, which is the safe default
// for both flags this guards (recording customer data, launching an extra
// browser process).
const TRUTHY_ENV_VALUES = new Set(['1', 'true', 'yes']);
function isTruthyEnvFlag(value) {
  return TRUTHY_ENV_VALUES.has(String(value ?? '').trim().toLowerCase());
}

// Local-dev-only opt-in, read by lib/runtime/preflight.mjs before it starts
// polling: when the cdp endpoint is localhost and nothing is listening on
// it, launch a dedicated local Chrome instead of failing straight into
// SidecarUnreachableError. The mattcloud pod contract never sets this
// variable, so isCdpAutolaunchEnabled(env) is false there and the launch
// branch this gates never runs -- the pod's SidecarUnreachableError path on
// a dead endpoint stays completely untouched.
export function isCdpAutolaunchEnabled(env) {
  return isTruthyEnvFlag(env.FAST_BROWSER_CDP_AUTOLAUNCH);
}

export async function cloudConfig(env, dependencies = {}) {
  const access = dependencies.access ?? fsAccess;
  const mkdtemp = dependencies.mkdtemp ?? fsMkdtemp;

  const engine = env.FAST_BROWSER_ENGINE;
  if (!CLOUD_ENGINES.has(engine)) {
    throw new EnvContractError(
      `FAST_BROWSER_ENGINE must be one of ${[...CLOUD_ENGINES].join(', ')}, got ${engine}`,
    );
  }

  const cdpEndpoint = requireEndpoint(env.FAST_BROWSER_CDP_ENDPOINT);

  // An early draft of this contract carried FAST_BROWSER_FLOWS_DIR. It was
  // removed before implementation because it could have no consumer: the
  // runtime has no concept of macros. A manifest written against that draft
  // would otherwise start a pod that runs with a flow set nobody chose, and
  // say nothing about it. Exit 78 rather than warn: this is a manifest bug,
  // and restarting into the same wrong flow set helps no one.
  if (env.FAST_BROWSER_FLOWS_DIR !== undefined) {
    throw new EnvContractError(
      'FAST_BROWSER_FLOWS_DIR is not part of this contract and nothing reads it; '
      + 'adapter flows bake into $HOME/.fast-browser/macros alongside the bundled '
      + 'macros. Unset the variable.',
    );
  }

  // Fail closed on any other typo'd or retired variable name: the cloud
  // contract is closed, so an unrecognized FAST_BROWSER_* variable is a
  // manifest bug, not a variable this parser should silently ignore. This
  // runs after the FLOWS_DIR check above so that specific, better-explained
  // rejection still fires for that one retired name.
  for (const key of Object.keys(env)) {
    if (key.startsWith('FAST_BROWSER_') && !KNOWN_CLOUD_ENV_VARS.has(key)) {
      throw new EnvContractError(
        `${key} is not a recognized FAST_BROWSER_* variable for the cloud contract; `
        + 'check for a typo, or register it in lib/core/env-config.mjs if it is new.',
      );
    }
  }

  // Readability only. The contents are the runtime's business, never this
  // process's: forwarding a path keeps credential values out of fast-browser
  // entirely, which is what makes the runtime's redaction guarantee hold end
  // to end.
  let secretsFile = null;
  if (env.FAST_BROWSER_SECRETS !== undefined) {
    // Presence is presence, exactly as for FAST_BROWSER_ENGINE. Reading an
    // empty value as "no secrets configured" is the dangerous interpretation:
    // with no secrets file resolved, an unmatched name is filled in literally,
    // so a login sequence types the secret NAME into the password field.
    if (env.FAST_BROWSER_SECRETS === '') {
      throw new EnvContractError(
        'FAST_BROWSER_SECRETS is set but empty; give it a path or unset it',
      );
    }
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
  // Case-folding/trimming is isTruthyEnvFlag's job (see above); anything
  // unrecognized stays off: a pod that records nothing is a better failure
  // than a pod that writes customer data to disk unasked.
  const debugCapture = isTruthyEnvFlag(env.FAST_BROWSER_DEBUG_CAPTURE);

  // A fresh tmpdir, not paths.dataDir. The pod bake does not set this variable,
  // and a baked $HOME can be read-only, so falling back to ~/.fast-browser
  // would fail at the first write rather than at startup -- the silent-late
  // failure this whole contract is shaped to avoid. A tmpdir is also the right
  // lifetime for cattle: always writable, always empty, gone with the pod.
  // The local path never reaches here and keeps using paths.dataDir.
  const outputDir = env.FAST_BROWSER_OUTPUT_DIR
    || await mkdtemp(path.join(os.tmpdir(), 'fast-browser-'));

  const base = defaultConfig();
  return {
    ...base,
    engine,
    cdpEndpoint,
    secretsFile,
    outputDir,
    debugCapture,
    trace: debugCapture,
    sessions: { ...base.sessions, enabled: debugCapture },
    // Defence in depth. The entrypoint branch already keeps the cloud path
    // away from readToken; 'manual' means launchRuntime would not reach for
    // a Keychain token even if that branch were bypassed.
    connection: { mode: 'manual' },
  };
}
