import { spawn } from 'node:child_process';

const CAPTURE_LIMIT = 1024 * 1024;
const TRUNCATION_MARKER = Buffer.from('\n[output truncated at 1048576 bytes]\n');

function createCapture() {
  const chunks = [];
  let length = 0;
  let truncated = false;

  return {
    append(chunk) {
      const buffer = Buffer.from(chunk);
      const available = CAPTURE_LIMIT - length;
      if (length < CAPTURE_LIMIT) {
        const kept = buffer.subarray(0, available);
        chunks.push(kept);
        length += kept.length;
      }
      if (buffer.length > available) truncated = true;
    },
    text() {
      const captured = Buffer.concat(chunks, length);
      if (!truncated) return captured.toString('utf8');
      const contentLength = CAPTURE_LIMIT - TRUNCATION_MARKER.length;
      return Buffer.concat([
        captured.subarray(0, contentLength),
        TRUNCATION_MARKER,
      ], CAPTURE_LIMIT).toString('utf8');
    },
  };
}

function processError(message, code) {
  const error = new Error(message);
  error.name = 'ProcessRunError';
  error.code = code;
  return error;
}

export function run(command, args, options = {}) {
  const {
    timeoutMs,
    signal: abortSignal,
    ...spawnOptions
  } = options;

  if (abortSignal?.aborted) {
    return Promise.reject(processError(`aborted before starting ${command}`, 'ABORT_ERR'));
  }

  return new Promise((resolve, reject) => {
    const stdout = createCapture();
    const stderr = createCapture();
    const child = spawn(command, args, {
      ...spawnOptions,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    let stopReason;
    let forceKillTimer;

    const timeout = timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
        stopReason = processError(`${command} timed out after ${timeoutMs}ms`, 'ETIMEDOUT');
        child.kill('SIGTERM');
        forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 100);
        forceKillTimer.unref();
      }, timeoutMs);
    timeout?.unref();

    function cleanup() {
      if (timeout) clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      abortSignal?.removeEventListener('abort', abort);
    }

    function settle(action, value) {
      if (settled) return;
      settled = true;
      cleanup();
      action(value);
    }

    function abort() {
      stopReason = processError(`aborted while running ${command}`, 'ABORT_ERR');
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 100);
      forceKillTimer.unref();
    }

    abortSignal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => stdout.append(chunk));
    child.stderr.on('data', (chunk) => stderr.append(chunk));

    child.once('error', (error) => {
      settle(
        reject,
        processError(`unable to start ${command}: ${error.code ?? 'unknown error'}`, error.code),
      );
    });
    child.once('close', (exitCode, childSignal) => {
      if (stopReason) {
        settle(reject, stopReason);
        return;
      }
      if (childSignal) {
        settle(
          reject,
          processError(`${command} terminated by signal ${childSignal}`, 'ESIGNAL'),
        );
        return;
      }
      settle(resolve, {
        command,
        args,
        exitCode,
        stdout: stdout.text(),
        stderr: stderr.text(),
      });
    });
  });
}
