import { RADIX_SCALES } from '../annotate/palette.mjs';

const COMMANDS = new Set(['setup', 'doctor', 'configure', 'migrate', 'uninstall', 'annotate', 'gif']);
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
    // No profile default here. An omitted --profile must reach setup as an
    // omission so it can keep the configured profile; defaulting to safe at
    // this layer is what silently downgraded a full-profile machine on a
    // routine rerun even after setup itself learned to carry (the fix landed
    // one layer below the bug, twice on the same day). Setup owns the
    // first-install fallback to safe.
    profile: null,
    source: 'm4ttstack/fast-browser',
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
    video: null,
    out: null,
    fps: null,
    width: null,
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
    // `annotate` and `gif` are the only commands taking a positional. Route
    // it through its own "exactly one" check *before* the shared
    // `seen`-duplicate guard below: that guard echoes the raw token back
    // in its message unsanitised, which is fine for a recognised flag but
    // not for a config path or a video name, which is user-supplied data.
    // Handling the positional here means a repeated one never reaches that
    // guard.
    if (command === 'annotate' && !token.startsWith('--')) {
      if (request.config !== null) {
        throw new UsageError(token, 'annotate takes exactly one config path');
      }
      request.config = token;
      seen.add(token);
      explicitOptions.add(token);
      continue;
    }
    if (command === 'gif' && !token.startsWith('--')) {
      if (request.video !== null) {
        throw new UsageError(token, 'gif takes exactly one video name');
      }
      request.video = token;
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
      case '--video': {
        requireCommand(command, ['configure'], token);
        const value = valueFor(arguments_, index, token);
        if (value === 'off') {
          request.video = 'off';
          index += 1;
          break;
        }
        // Strict WxH: two plain decimal integers, bounded to what a real
        // capture viewport can be. Anything else is refused by naming the
        // flag, never echoing the value.
        const match = /^([1-9][0-9]{2,3})x([1-9][0-9]{2,3})$/.exec(value);
        const width = match ? Number(match[1]) : 0;
        const height = match ? Number(match[2]) : 0;
        if (width < 320 || width > 3840 || height < 240 || height > 2160) {
          throw new UsageError(token, `invalid value for ${token}`);
        }
        request.video = { width, height };
        index += 1;
        break;
      }
      case '--out':
        requireCommand(command, ['gif'], token);
        request.out = valueFor(arguments_, index, token);
        index += 1;
        break;
      case '--fps': {
        requireCommand(command, ['gif'], token);
        const value = valueFor(arguments_, index, token);
        if (!/^[1-9][0-9]*$/.test(value) || Number(value) > 30) {
          throw new UsageError(token, `invalid value for ${token}`);
        }
        request.fps = Number(value);
        index += 1;
        break;
      }
      case '--width': {
        requireCommand(command, ['gif'], token);
        const value = valueFor(arguments_, index, token);
        if (!/^[1-9][0-9]*$/.test(value) || Number(value) < 100 || Number(value) > 1200) {
          throw new UsageError(token, `invalid value for ${token}`);
        }
        request.width = Number(value);
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
  if (command === 'gif' && request.video === null) {
    throw new UsageError('<video>', 'gif requires a video name');
  }
  if (request.dryRun && request.rollback) {
    throw new UsageError(
      '--rollback',
      'conflicting options: --dry-run and --rollback',
    );
  }
  return request;
}
