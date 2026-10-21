import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import { DEVLOGIN_NAME } from '../runtime/secrets-channel.mjs';

export const LOGIN_FILL_TIMEOUT_MS = 8000;
export const SAVED_LOGIN_TIMEOUT_MS = 1500;
export const LOGIN_FILL_MAX_RESPONSE_BYTES = 64 * 1024;

const UNAVAILABLE = Object.freeze({ refused: 'unavailable' });

export function rtPaths({ homeDir, env = process.env }) {
  const rtDir = path.join(homeDir, '.mattstack', 'rt');
  return {
    socketPath: env.RT_DAEMON_SOCK || path.join(rtDir, 'rt.sock'),
    tokenFile: path.join(rtDir, 'api-token'),
  };
}

function postJson({ socketPath, route, body, timeoutMs }) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const request = http.request(
      {
        socketPath,
        method: 'POST',
        path: route,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
        timeout: timeoutMs,
      },
      (response) => {
        const chunks = [];
        let received = 0;
        response.on('data', (chunk) => {
          received += chunk.length;
          if (received > LOGIN_FILL_MAX_RESPONSE_BYTES) {
            request.destroy();
            resolve(null);
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        response.on('error', () => resolve(null));
      },
    );
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
    request.end(payload);
  });
}

async function callDaemon({ homeDir, env, route, body, timeoutMs }) {
  const { socketPath, tokenFile } = rtPaths({ homeDir, env });
  let token;
  try {
    token = (await readFile(tokenFile, 'utf8')).trim();
  } catch {
    return null;
  }
  if (!token) return null;

  const text = await postJson({
    socketPath,
    route,
    body: { token, client: 'fast-browser', ...body },
    timeoutMs,
  });
  if (text === null) return null;
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    return null;
  }
  const data = envelope?.ok === true ? envelope.data : null;
  return typeof data === 'object' && data !== null ? data : null;
}

export async function requestLoginFill({
  name,
  frameOrigin,
  elementKind,
  homeDir,
  env = process.env,
  pid = process.pid,
  timeoutMs = LOGIN_FILL_TIMEOUT_MS,
}) {
  const data = await callDaemon({
    homeDir,
    env,
    route: '/logins:fill',
    body: { pid, name, frameOrigin, elementKind },
    timeoutMs,
  });
  return data ?? UNAVAILABLE;
}

export async function requestSavedLogin({
  origin,
  homeDir,
  env = process.env,
  pid = process.pid,
  timeoutMs = SAVED_LOGIN_TIMEOUT_MS,
}) {
  const data = await callDaemon({
    homeDir,
    env,
    route: '/logins:has',
    body: { pid, origin },
    timeoutMs,
  });
  if (data === null) return UNAVAILABLE;
  if (data.none === true) return { none: true };
  const { email, password } = data.fields ?? {};
  if (typeof email !== 'string' || typeof password !== 'string') return UNAVAILABLE;
  if (!DEVLOGIN_NAME.test(email) || !DEVLOGIN_NAME.test(password)) return UNAVAILABLE;
  return { fields: { email, password } };
}
