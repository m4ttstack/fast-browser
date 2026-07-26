const COMMANDS = new Set(['setup', 'doctor', 'configure', 'migrate', 'uninstall']);
const HOSTS = new Set(['claude', 'codex', 'both']);
const PROFILES = new Set(['safe', 'full']);
const CONNECTIONS = new Set(['manual', 'auto']);

export class UsageError extends Error {
  constructor(token, message = `unsupported argument: ${token}`) {
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
    throw new UsageError(token, `invalid value for ${token}: ${value}`);
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

  const [command, ...arguments_] = argv;
  if (!COMMANDS.has(command)) {
    throw new UsageError(command ?? '<command>', 'expected a command');
  }

  const request = requestFor(command);
  for (let index = 0; index < arguments_.length; index += 1) {
    const token = arguments_[index];
    switch (token) {
      case '--host': {
        addHosts(request, valueFor(arguments_, index, token), token);
        index += 1;
        break;
      }
      case '--profile': {
        requireCommand(command, ['setup'], token);
        const profile = valueFor(arguments_, index, token);
        if (!PROFILES.has(profile)) throw new UsageError(token, `invalid value for ${token}: ${profile}`);
        request.profile = profile;
        index += 1;
        break;
      }
      case '--source':
        requireCommand(command, ['setup'], token);
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
          throw new UsageError(token, `invalid value for ${token}: ${connection}`);
        }
        request.connection = connection;
        index += 1;
        break;
      }
      case '--record-sessions':
        requireCommand(command, ['configure'], token);
        request.recordSessions = true;
        break;
      case '--no-record-sessions':
        requireCommand(command, ['configure'], token);
        request.recordSessions = false;
        break;
      case '--retention-days': {
        requireCommand(command, ['configure'], token);
        const value = valueFor(arguments_, index, token);
        if (!/^[1-9][0-9]*$/.test(value) || Number(value) > 365) {
          throw new UsageError(token, `invalid value for ${token}: ${value}`);
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
      default:
        throw new UsageError(token);
    }
  }
  return request;
}
