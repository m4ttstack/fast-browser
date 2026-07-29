export class LifecycleError extends Error {
  constructor(message, {
    stage = null,
    partialState = null,
    exitCode = 1,
    code = null,
  } = {}) {
    super(message.replaceAll('\n', ' '));
    this.name = 'LifecycleError';
    this.stage = stage;
    this.partialState = partialState;
    this.exitCode = exitCode;
    if (code) this.code = code;
  }
}

export const HOST_ORDER = Object.freeze(['claude', 'codex']);

export function orderedHosts(hosts = []) {
  const selected = new Set(hosts);
  return HOST_ORDER.filter((host) => selected.has(host));
}

export function hostFlags(hosts) {
  const selected = new Set(hosts);
  return {
    claude: selected.has('claude'),
    codex: selected.has('codex'),
  };
}

export function selectedConfigHosts(config) {
  return HOST_ORDER.filter((host) => config.hosts[host]);
}

export function routingState(config) {
  return {
    profile: config.profile,
    files: structuredClone(config.managed.files),
    blocks: structuredClone(config.managed.blocks),
  };
}

export function managedConfig(state) {
  return {
    files: structuredClone(state?.files ?? []),
    blocks: structuredClone(state?.blocks ?? []),
  };
}

export function profileDefaults(profile) {
  if (profile !== 'safe' && profile !== 'full') {
    throw new LifecycleError('Profile must be `safe` or `full`.', {
      stage: 'validate',
      exitCode: 2,
    });
  }
  return {
    enabled: profile === 'full',
    retentionDays: 30,
  };
}

export function retentionDays(value) {
  if (!Number.isInteger(value) || value < 1 || value > 365) {
    throw new LifecycleError('Session retention must be an integer from 1 to 365.', {
      stage: 'validate',
      exitCode: 2,
    });
  }
  return value;
}

export function safeError(message, options) {
  return new LifecycleError(message, options);
}

// Thrown-error names whose `message` we may quote back to the user. Every
// message these types carry is assembled from our own literals: a fixed
// sentence, a subcommand name we chose, a process exit code, or a Node error
// code such as ENOENT. None of them interpolates a path, a token, or any
// other user-supplied value, which is what makes them printable at all.
//
// ConfigError and PathConfinementError are deliberately absent: both wrap a
// resolved path ("unable to read config: <fs error>", "unable to resolve
// confinement root <target>"), as does every bare fs error. Quoting those
// would leak exactly what confinedName in annotate.mjs and the duplicate
// positional fix in parse-args.mjs go out of their way to withhold.
const REPORTABLE_ERROR_NAMES = new Set([
  'CodexBrowserDriverSmokeError',
  'HostInstallError',
  'LifecycleError',
  'PairingError',
  'RoutingTransactionError',
]);

// Returns the thrown error's own message when it is one of ours, and null
// otherwise. Null means "withheld", never "there was no error": callers must
// still report the failure, just without a cause.
export function reportableCause(error) {
  if (!REPORTABLE_ERROR_NAMES.has(error?.name)) return null;
  const message = typeof error.message === 'string'
    ? error.message.replaceAll('\n', ' ').trim()
    : '';
  return message === '' ? null : message;
}
