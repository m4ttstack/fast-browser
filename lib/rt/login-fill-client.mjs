import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

export const LOGIN_FILL_TIMEOUT_MS = 8000;
export const LOGIN_FILL_MAX_RESPONSE_BYTES = 64 * 1024;

const UNAVAILABLE = Object.freeze({ refused: 'unavailable' });

export function rtPaths({ homeDir, env = process.env }) {
  const rtDir = path.join(homeDir, '.mattstack', 'rt');
  return {
    socketPath: env.RT_DAEMON_SOCK || path.join(rtDir, 'rt.sock'),
    tokenFile: path.join(rtDir, 'api-token'),
  };
}

function postJson({ socketPath, body, timeoutMs }) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const request = http.request(
      {
        socketPath,
        method: 'POST',
        path: '/logins:fill',
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

export async function requestLoginFill({
  name,
  frameOrigin,
  elementKind,
  homeDir,
  env = process.env,
  pid = process.pid,
  timeoutMs = LOGIN_FILL_TIMEOUT_MS,
}) {
  const { socketPath, tokenFile } = rtPaths({ homeDir, env });
  let token;
  try {
    token = (await readFile(tokenFile, 'utf8')).trim();
  } catch {
    return UNAVAILABLE;
  }
  if (!token) return UNAVAILABLE;

  const text = await postJson({
    socketPath,
    body: { token, client: 'fast-browser', pid, name, frameOrigin, elementKind },
    timeoutMs,
  });
  if (text === null) return UNAVAILABLE;
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    return UNAVAILABLE;
  }
  if (envelope?.ok !== true || typeof envelope.data !== 'object' || envelope.data === null) return UNAVAILABLE;
  return envelope.data;
}
