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
