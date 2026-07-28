import { RADIX_SCALES } from '../annotate/palette.mjs';

const COMMANDS = new Set(['setup', 'doctor', 'configure', 'migrate', 'uninstall', 'annotate']);
const HOSTS = new Set(['claude', 'codex', 'both']);
const PROFILES = new Set(['safe', 'full']);
const CONNECTIONS = new Set(['manual', 'auto']);

function safeToken(token) {
  return typeof token === 'string' && /^--[a-z][a-z-]{0,63}$/.test(token)
    ? token
    : '<argument>';
}

export class UsageError extends Error {
  constructor(token, message = `unsupported argument: ${safeToken(token)}`) {
    super(message);
    this.name = 'UsageError';
    this.exitCode = 2;
  }
}

function requestFor(command) {
  return {
    command,
    hosts: [],
    profile: 'safe',
    source: 'm4ttheweric/mattstack',
    json: false,
    purgeData: false,
    dryRun: false,
    rollback: null,
    connection: null,
    recordSessions: null,
    retentionDays: null,
    runtimeLock: null,
    palette: null,
    config: null,
  };
}

function valueFor(argv, index, token) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new UsageError(token, `missing value for ${token}`);
  }
  return value;
}

function requireCommand(command, allowed, token) {
  if (!allowed.includes(command)) {
    throw new UsageError(token, `${token} is not valid for ${command}`);
  }
}

function addHosts(request, value, token) {
  if (!HOSTS.has(value)) {
    throw new UsageError(token, `invalid value for ${token}`);
  }
  const requestedHosts = value === 'both' ? ['claude', 'codex'] : [value];
  for (const host of requestedHosts) {
    if (!request.hosts.includes(host)) request.hosts.push(host);
  }
}

export function parseArgs(argv) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    const request = requestFor('doctor');
    Object.defineProperty(request, 'help', { value: true });
    return request;
  }
  if (argv.length === 1 && argv[0] === '--version') {
    const request = requestFor('doctor');
    Object.defineProperty(request, 'version', { value: true });
    return request;
  }

  const [command, ...arguments_] = argv;
  if (!COMMANDS.has(command)) {
    throw new UsageError(command ?? '<command>', 'expected a command');
  }

  const request = requestFor(command);
  if (
    arguments_.length === 1
    && (arguments_[0] === '--help' || arguments_[0] === '-h')
  ) {
    Object.defineProperty(request, 'help', { value: true });
    return request;
  }
  const seen = new Set();
  const explicitOptions = new Set();
  Object.defineProperty(request, 'explicitOptions', { value: explicitOptions });
  for (let index = 0; index < arguments_.length; index += 1) {
    const token = arguments_[index];
    // `annotate` is the only command taking a positional. Route it through
    // its own "exactly one config path" check *before* the shared
    // `seen`-duplicate guard below: that guard echoes the raw token back
    // in its message unsanitised, which is fine for a recognised flag but
    // not for a config path, which is user-supplied data. Handling the
    // positional here means a repeated path never reaches that guard.
    if (command === 'annotate' && !token.startsWith('--')) {
      if (request.config !== null) {
        throw new UsageError(token, 'annotate takes exactly one config path');
      }
      request.config = token;
      seen.add(token);
      explicitOptions.add(token);
      continue;
    }
    if (seen.has(token)) throw new UsageError(token, `duplicate option: ${token}`);
    seen.add(token);
    explicitOptions.add(token);
    switch (token) {
      case '--host': {
        requireCommand(command, ['setup', 'migrate', 'uninstall'], token);
        addHosts(request, valueFor(arguments_, index, token), token);
        index += 1;
        break;
      }
      case '--profile': {
        requireCommand(command, ['setup', 'configure'], token);
        const profile = valueFor(arguments_, index, token);
        if (!PROFILES.has(profile)) throw new UsageError(token, `invalid value for ${token}`);
        request.profile = profile;
        index += 1;
        break;
      }
      case '--source':
        // migrate installs the host plugin adapters exactly the way setup
        // does, so it needs the same source. Without it, migrate passes an
        // undefined source and Claude rejects the install as "configured from
        // a different source" against the marketplace setup already
        // registered -- which is every installation that has run setup, so
        // migration could never complete on a real machine.
        requireCommand(command, ['setup', 'migrate'], token);
        request.source = valueFor(arguments_, index, token);
        index += 1;
        break;
      case '--json':
        request.json = true;
        break;
      case '--purge-data':
        requireCommand(command, ['uninstall'], token);
        request.purgeData = true;
        break;
      case '--dry-run':
        requireCommand(command, ['migrate'], token);
        request.dryRun = true;
        break;
      case '--rollback':
        requireCommand(command, ['migrate'], token);
        request.rollback = valueFor(arguments_, index, token);
        index += 1;
        break;
      case '--connection': {
        requireCommand(command, ['configure'], token);
        const connection = valueFor(arguments_, index, token);
        if (!CONNECTIONS.has(connection)) {
          throw new UsageError(token, `invalid value for ${token}`);
        }
        request.connection = connection;
        index += 1;
        break;
      }
      case '--record-sessions':
        requireCommand(command, ['configure'], token);
        if (seen.has('--no-record-sessions')) {
          throw new UsageError(
            token,
            'conflicting options: --record-sessions and --no-record-sessions',
          );
        }
        request.recordSessions = true;
        break;
      case '--no-record-sessions':
        requireCommand(command, ['configure'], token);
        if (seen.has('--record-sessions')) {
          throw new UsageError(
            token,
            'conflicting options: --record-sessions and --no-record-sessions',
          );
        }
        request.recordSessions = false;
        break;
      case '--retention-days': {
        requireCommand(command, ['configure'], token);
        const value = valueFor(arguments_, index, token);
        if (!/^[1-9][0-9]*$/.test(value) || Number(value) > 365) {
          throw new UsageError(token, `invalid value for ${token}`);
        }
        request.retentionDays = Number(value);
        index += 1;
        break;
      }
      case '--runtime-lock':
        requireCommand(command, ['setup', 'doctor'], token);
        request.runtimeLock = valueFor(arguments_, index, token);
        index += 1;
        break;
      case '--palette': {
        requireCommand(command, ['configure'], token);
        const palette = valueFor(arguments_, index, token);
        if (!Object.hasOwn(RADIX_SCALES, palette)) {
          throw new UsageError(token, `invalid value for ${token}`);
        }
        request.palette = palette;
        index += 1;
        break;
      }
      default:
        throw new UsageError(token);
    }
  }
  if (command === 'annotate' && request.config === null) {
    throw new UsageError('<config>', 'annotate requires a config path');
  }
  if (request.dryRun && request.rollback) {
    throw new UsageError(
      '--rollback',
      'conflicting options: --dry-run and --rollback',
    );
  }
  return request;
}
