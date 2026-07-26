import { spawn as nodeSpawn } from 'node:child_process';

export const KEYCHAIN_SERVICE = 'dev.mattstack.fast-browser';
export const KEYCHAIN_ACCOUNT = 'chrome-extension';

const SECURITY = '/usr/bin/security';
const NOT_FOUND_EXIT = 44;
const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 16 * 1024;

const IDENTITY_ARGS = [
  '-s', KEYCHAIN_SERVICE,
  '-a', KEYCHAIN_ACCOUNT,
];
const READ_ARGS = ['find-generic-password', ...IDENTITY_ARGS, '-w'];
const FIND_ARGS = ['find-generic-password', ...IDENTITY_ARGS];
const WRITE_ARGS = ['add-generic-password', '-U', ...IDENTITY_ARGS, '-w'];
const DELETE_ARGS = ['delete-generic-password', ...IDENTITY_ARGS];

export class KeychainError extends Error {
  constructor(message) {
    super(message);
    this.name = 'KeychainError';
  }
}

function safeFailure(operation) {
  return new KeychainError(`unable to ${operation} Keychain token`);
}

function validToken(token) {
  return typeof token === 'string'
    && token.length > 0
    && Buffer.byteLength(token, 'utf8') <= MAX_TOKEN_BYTES
    && !/[\s\u0000-\u001f\u007f]/u.test(token);
}

function invalidToken() {
  return new KeychainError('invalid Keychain token');
}

function capture(readable, abort, active) {
  if (!readable || typeof readable.on !== 'function') {
    return { missing: true, ended: false, overflow: false, chunks: [] };
  }
  const state = {
    missing: false,
    ended: false,
    overflow: false,
    chunks: [],
    bytes: 0,
  };
  readable.on('data', (value) => {
    if (!active()) return;
    let chunk;
    try {
      chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    } catch {
      abort();
      return;
    }
    const remaining = Math.max(0, MAX_CAPTURE_BYTES - state.bytes);
    if (remaining > 0) state.chunks.push(chunk.subarray(0, remaining));
    state.bytes += chunk.length;
    if (state.bytes > MAX_CAPTURE_BYTES) {
      state.overflow = true;
      abort();
    }
  });
  readable.once('end', () => {
    state.ended = true;
  });
  readable.once('close', () => {
    state.ended = true;
  });
  readable.once('error', abort);
  return state;
}

function stopChild(child) {
  for (const name of ['stdin', 'stdout', 'stderr']) {
    try {
      const stream = child?.[name];
      if (stream && typeof stream.destroy === 'function') stream.destroy();
    } catch {
      // Resource shutdown is best effort and must not replace the safe error.
    }
  }
  try {
    if (typeof child?.kill === 'function') child.kill();
  } catch {
    // Resource shutdown is best effort and must not replace the safe error.
  }
}

async function runSecurity(
  args,
  {
    spawn = nodeSpawn,
    stdio = ['ignore', 'pipe', 'pipe'],
    input = null,
    operation,
  },
) {
  let child;
  try {
    child = spawn(SECURITY, args, { shell: false, stdio });
  } catch {
    throw safeFailure(operation);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let inputComplete = input === null;
    const fail = ({ terminate = false } = {}) => {
      if (settled) return;
      settled = true;
      if (terminate) stopChild(child);
      reject(safeFailure(operation));
    };
    const abort = () => fail({ terminate: true });
    if (!child || typeof child.once !== 'function') {
      abort();
      return;
    }
    let stdout;
    let stderr;
    try {
      stdout = stdio[1] === 'pipe'
        ? capture(child.stdout, abort, () => !settled)
        : null;
      stderr = stdio[2] === 'pipe'
        ? capture(child.stderr, abort, () => !settled)
        : null;
      child.once('error', fail);
      child.once('close', (code, signal) => {
        if (settled) return;
        if (
          (stdout && (stdout.missing || !stdout.ended || stdout.overflow))
          || (stderr && (stderr.missing || !stderr.ended || stderr.overflow))
          || !inputComplete
        ) {
          fail();
          return;
        }
        settled = true;
        resolve({
          code,
          signal,
          stdout: stdout ? Buffer.concat(stdout.chunks) : Buffer.alloc(0),
        });
      });
    } catch {
      abort();
      return;
    }

    if (input !== null) {
      let stdin;
      try {
        stdin = child.stdin;
      } catch {
        abort();
        return;
      }
      if (!stdin || typeof stdin.end !== 'function') {
        abort();
        return;
      }
      try {
        stdin.once?.('error', abort);
        stdin.end(input, (error) => {
          if (error) {
            abort();
            return;
          }
          inputComplete = true;
        });
      } catch {
        abort();
      }
    }
  });
}

function successful(result, operation) {
  if (result.code === 0 && result.signal === null) return;
  throw safeFailure(operation);
}

export async function hasToken({ spawn = nodeSpawn } = {}) {
  const result = await runSecurity(FIND_ARGS, {
    spawn,
    operation: 'find',
  });
  if (result.code === NOT_FOUND_EXIT && result.signal === null) return false;
  successful(result, 'find');
  return true;
}

export async function readToken({ spawn = nodeSpawn } = {}) {
  const result = await runSecurity(READ_ARGS, {
    spawn,
    operation: 'read',
  });
  if (result.code === NOT_FOUND_EXIT && result.signal === null) return null;
  successful(result, 'read');

  let token;
  try {
    token = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
  } catch {
    throw invalidToken();
  }
  if (token.endsWith('\n')) token = token.slice(0, -1);
  if (!validToken(token)) throw invalidToken();
  return token;
}

export async function writeTokenFromPrompt({ spawn = nodeSpawn } = {}) {
  const result = await runSecurity(WRITE_ARGS, {
    spawn,
    stdio: ['inherit', 'ignore', 'inherit'],
    operation: 'write',
  });
  successful(result, 'write');
}

export async function writeMigratedToken(token, { spawn = nodeSpawn } = {}) {
  if (!validToken(token)) throw invalidToken();
  const result = await runSecurity(WRITE_ARGS, {
    spawn,
    stdio: ['pipe', 'pipe', 'pipe'],
    input: `${token}\n`,
    operation: 'write',
  });
  successful(result, 'write');
}

export async function deleteToken({ spawn = nodeSpawn } = {}) {
  const result = await runSecurity(DELETE_ARGS, {
    spawn,
    operation: 'delete',
  });
  if (result.code === NOT_FOUND_EXIT && result.signal === null) return false;
  successful(result, 'delete');
  return true;
}
