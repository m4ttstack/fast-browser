import { readFile } from 'node:fs/promises';

import { RADIX_SCALES } from '../annotate/palette.mjs';

const SCHEMA_VERSION = 1;
const PROFILES = new Set(['safe', 'full']);
const CONNECTION_MODES = new Set(['manual', 'auto']);

export class ConfigError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'ConfigError';
    if (code) this.code = code;
  }
}

export function defaultConfig() {
  return {
    schemaVersion: SCHEMA_VERSION,
    productVersion: '0.1.0-alpha.1',
    profile: 'safe',
    hosts: { claude: false, codex: false },
    connection: { mode: 'manual' },
    sessions: { enabled: false, retentionDays: 30 },
    runtime: { version: null, sha256: null, sourceCommit: null },
    managed: { files: [], blocks: [] },
    annotation: { palette: null },
    video: null,
    trace: true,
  };
}

function object(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(`${field} must be an object`);
  }
  return value;
}

function string(value, field, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') throw new ConfigError(`${field} must be a string`);
  return value;
}

function boolean(value, field) {
  if (typeof value !== 'boolean') throw new ConfigError(`${field} must be a boolean`);
  return value;
}

// Absent means "the user has not chosen a palette yet", which is distinct from
// any valid scale name. No schemaVersion bump is needed: parseConfig rebuilds
// its result from known keys, so a stored v1 config that predates this field
// simply reads as unset.
function annotationPalette(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !Object.hasOwn(RADIX_SCALES, value)) {
    throw new ConfigError(`${field} must be a Radix colour scale name`);
  }
  return value;
}

// Null means "recording is off", the default. Like annotation.palette above,
// absence needs no schemaVersion bump: parseConfig rebuilds its result from
// known keys, so a stored v1 config that predates this field reads as off.
// The bounds match what the runtime's own resolution parsing accepts for a
// real capture: anything below is unreadable, anything above is not a
// browser viewport.
function videoSize(value, field) {
  if (value === null || value === undefined) return null;
  const record = object(value, field);
  if (!Number.isInteger(record.width) || record.width < 320 || record.width > 3840) {
    throw new ConfigError(`${field}.width must be an integer from 320 to 3840`);
  }
  if (!Number.isInteger(record.height) || record.height < 240 || record.height > 2160) {
    throw new ConfigError(`${field}.height must be an integer from 240 to 2160`);
  }
  return { width: record.width, height: record.height };
}

// Absent means "record traces", this field's default (true). Like
// annotation.palette and video above, absence needs no schemaVersion bump:
// parseConfig rebuilds its result from known keys, so a stored v1 config
// that predates this field simply reads as enabled.
function traceEnabled(value, field) {
  if (value === undefined) return true;
  return boolean(value, field);
}

function managedFileArray(value, field) {
  if (!Array.isArray(value)) throw new ConfigError(`${field} must be an array`);
  return value.map((entry, index) => {
    if (typeof entry === 'string') return entry;
    const record = object(entry, `${field}[${index}]`);
    const sha256 = string(record.sha256, `${field}[${index}].sha256`);
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new ConfigError(`${field}[${index}].sha256 must be a SHA-256 digest`);
    }
    return {
      path: string(record.path, `${field}[${index}].path`),
      sha256,
    };
  });
}

function managedBlockArray(value, field) {
  if (!Array.isArray(value)) throw new ConfigError(`${field} must be an array`);
  return value.map((entry, index) => {
    if (typeof entry === 'string') return entry;
    const record = object(entry, `${field}[${index}]`);
    const kind = string(record.kind, `${field}[${index}].kind`);
    if (kind !== 'toml' && kind !== 'markdown') {
      throw new ConfigError(`${field}[${index}].kind must be toml or markdown`);
    }
    const sha256 = string(record.sha256, `${field}[${index}].sha256`);
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new ConfigError(`${field}[${index}].sha256 must be a SHA-256 digest`);
    }
    const parsed = {
      path: string(record.path, `${field}[${index}].path`),
      id: string(record.id, `${field}[${index}].id`),
      kind,
      sha256,
    };
    if (Object.hasOwn(record, 'containerCreated')) {
      parsed.containerCreated = boolean(
        record.containerCreated,
        `${field}[${index}].containerCreated`,
      );
    }
    if (Object.hasOwn(record, 'removeIfEmpty')) {
      parsed.removeIfEmpty = boolean(
        record.removeIfEmpty,
        `${field}[${index}].removeIfEmpty`,
      );
    }
    return parsed;
  });
}

export function parseConfig(value) {
  const config = object(value, 'config');
  if (config.schemaVersion !== SCHEMA_VERSION) {
    throw new ConfigError(`unsupported schema version: ${config.schemaVersion}`);
  }
  const productVersion = string(config.productVersion, 'productVersion');
  if (!PROFILES.has(config.profile)) throw new ConfigError(`unsupported profile: ${config.profile}`);

  const hosts = object(config.hosts, 'hosts');
  const connection = object(config.connection, 'connection');
  if (!CONNECTION_MODES.has(connection.mode)) {
    throw new ConfigError(`unsupported connection mode: ${connection.mode}`);
  }

  const sessions = object(config.sessions, 'sessions');
  const retentionDays = sessions.retentionDays;
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
    throw new ConfigError('sessions.retentionDays must be an integer from 1 to 365');
  }

  const runtime = object(config.runtime, 'runtime');
  const managed = object(config.managed, 'managed');
  const annotation = config.annotation === undefined
    ? {}
    : object(config.annotation, 'annotation');

  return {
    schemaVersion: SCHEMA_VERSION,
    productVersion,
    profile: config.profile,
    hosts: {
      claude: boolean(hosts.claude, 'hosts.claude'),
      codex: boolean(hosts.codex, 'hosts.codex'),
    },
    connection: { mode: connection.mode },
    sessions: {
      enabled: boolean(sessions.enabled, 'sessions.enabled'),
      retentionDays,
    },
    runtime: {
      version: string(runtime.version, 'runtime.version', { nullable: true }),
      sha256: string(runtime.sha256, 'runtime.sha256', { nullable: true }),
      sourceCommit: string(runtime.sourceCommit, 'runtime.sourceCommit', { nullable: true }),
    },
    managed: {
      files: managedFileArray(managed.files, 'managed.files'),
      blocks: managedBlockArray(managed.blocks, 'managed.blocks'),
    },
    annotation: {
      palette: annotationPalette(annotation.palette, 'annotation.palette'),
    },
    video: videoSize(config.video, 'video'),
    trace: traceEnabled(config.trace, 'trace'),
  };
}

export async function loadConfig(paths) {
  let value;
  try {
    value = JSON.parse(await readFile(paths.configFile, 'utf8'));
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`unable to read config: ${error.message}`, { code: error?.code });
  }
  return parseConfig(value);
}
