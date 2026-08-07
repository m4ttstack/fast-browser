export const DEFAULT_ENGINE = 'attached';

// Same sysexits reasoning as EnvContractError: an engine name this build
// does not know is a manifest bug, not a transient condition.
export class UnknownEngineError extends Error {
  constructor(engine) {
    super(`unsupported engine: ${engine}`);
    this.name = 'UnknownEngineError';
    this.exitCode = 78;
  }
}

// Descriptors carry ONLY the flags that differ by engine. Anything that
// shapes observation size (--snapshot-mode, --timeout-settle) lives in the
// shared block in runtimeArgs, so no engine can widen it.
export const ENGINES = {
  attached: {
    name: 'attached',
    args: ({ lock }) => ['--extension', `--extension-id=${lock.extension.id}`],
  },
  cdp: {
    name: 'cdp',
    // No --headless: with --cdp-endpoint, headlessness is a property of how
    // the sidecar's Chrome was started, and this flag would do nothing.
    args: ({ config }) => [`--cdp-endpoint=${config.cdpEndpoint}`],
  },
};

export function engineFor(config) {
  const name = config.engine ?? DEFAULT_ENGINE;
  const engine = ENGINES[name];
  if (!engine) throw new UnknownEngineError(name);
  return engine;
}
