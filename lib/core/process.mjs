import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const CAPTURE_LIMIT = 1024 * 1024;
const TRUNCATION_TEXT = '\n[output truncated at 1048576 bytes]\n';
const TRUNCATION_MARKER = Buffer.from(TRUNCATION_TEXT);
const DEFAULT_FORCE_KILL_MS = 100;
const DEFAULT_FINAL_SETTLEMENT_MS = 250;

function validUtf8Prefix(buffer, maximumBytes) {
  if (buffer.length <= maximumBytes) return buffer;
  let end = maximumBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end);
}

function createCapture() {
  const chunks = [];
  let length = 0;
  let truncated = false;

  return {
    append(chunk) {
      const buffer = Buffer.from(chunk);
      const available = CAPTURE_LIMIT - length;
      if (available > 0) {
        const kept = buffer.subarray(0, available);
        chunks.push(kept);
        length += kept.length;
      }
      if (buffer.length > available) truncated = true;
    },
    text() {
      const decoder = new StringDecoder('utf8');
      let decoded = decoder.write(Buffer.concat(chunks, length));
      if (!truncated) decoded += decoder.end();
      const normalized = Buffer.from(decoded, 'utf8');
      if (!truncated && normalized.length <= CAPTURE_LIMIT) return decoded;
      const content = validUtf8Prefix(
        normalized,
        CAPTURE_LIMIT - TRUNCATION_MARKER.length,
      );
      return content.toString('utf8') + TRUNCATION_TEXT;
    },
  };
}

function processError(message, code) {
  const error = new Error(message);
  error.name = 'ProcessRunError';
  error.code = code;
  return error;
}

function safeCode(error) {
  return typeof error?.code === 'string' ? error.code : 'unknown error';
}

export function createProcessRunner({
  spawnImplementation = spawn,
  killImplementation = process.kill.bind(process),
  forceKillMs = DEFAULT_FORCE_KILL_MS,
  finalSettlementMs = DEFAULT_FINAL_SETTLEMENT_MS,
  platform = process.platform,
} = {}) {
  return function runProcess(command, args, options = {}) {
    const {
      timeoutMs,
      signal: abortSignal,
      input = null,
      ...spawnOptions
    } = options;

    if (
      input !== null
      && !(
        typeof input === 'string'
        || Buffer.isBuffer(input)
        || ArrayBuffer.isView(input)
      )
    ) {
      return Promise.reject(processError(`invalid input for ${command}`, 'EINVAL'));
    }
    if (input !== null && Buffer.byteLength(input) > CAPTURE_LIMIT) {
      return Promise.reject(processError(`input for ${command} exceeds 1048576 bytes`, 'E2BIG'));
    }

    if (abortSignal?.aborted) {
      return Promise.reject(processError(`aborted before starting ${command}`, 'ABORT_ERR'));
    }

    return new Promise((resolve, reject) => {
      const stdout = createCapture();
      const stderr = createCapture();
      let child;
      try {
        child = spawnImplementation(command, args, {
          ...spawnOptions,
          detached: platform !== 'win32',
          shell: false,
          stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(processError(`unable to start ${command}: ${safeCode(error)}`, error?.code));
        return;
      }

      let settled = false;
      let stopReason;
      let timeout;
      let forceKillTimer;
      let finalSettlementTimer;

      const ignoreLateEvent = () => {};

      function terminate(signal) {
        if (platform !== 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
          try {
            killImplementation(-child.pid, signal);
            return;
          } catch {
            // Fall back to the direct child when process-group signaling is unavailable.
          }
        }
        try {
          child.kill(signal);
        } catch {
          // Final settlement is bounded even when the child cannot be signaled.
        }
      }

      function cleanup() {
        if (timeout) clearTimeout(timeout);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        if (finalSettlementTimer) clearTimeout(finalSettlementTimer);
        abortSignal?.removeEventListener('abort', abort);
        child.removeListener('error', childError);
        child.removeListener('close', childClose);
        child.stdout.removeListener('data', stdoutData);
        child.stderr.removeListener('data', stderrData);
        child.stdout.removeListener('error', streamError);
        child.stderr.removeListener('error', streamError);
        child.stdin?.removeListener('error', streamError);
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin?.destroy();
        child.on('error', ignoreLateEvent);
        child.stdout.on('error', ignoreLateEvent);
        child.stderr.on('error', ignoreLateEvent);
        child.stdin?.on('error', ignoreLateEvent);
      }

      function settle(action, value, terminateFirst = false) {
        if (settled) return;
        settled = true;
        if (terminateFirst) terminate('SIGKILL');
        cleanup();
        action(value);
      }

      function stop(reason) {
        if (stopReason || settled) return;
        stopReason = reason;
        terminate('SIGTERM');
        forceKillTimer = setTimeout(() => terminate('SIGKILL'), forceKillMs);
        finalSettlementTimer = setTimeout(
          () => settle(reject, stopReason, true),
          finalSettlementMs,
        );
      }

      function abort() {
        stop(processError(`aborted while running ${command}`, 'ABORT_ERR'));
      }

      function stdoutData(chunk) {
        stdout.append(chunk);
      }

      function stderrData(chunk) {
        stderr.append(chunk);
      }

      function streamError() {
        if (stopReason) return;
        settle(
          reject,
          processError(`${command} output stream failed`, 'EIO'),
          true,
        );
      }

      function childError(error) {
        if (stopReason) return;
        settle(
          reject,
          processError(`unable to start ${command}: ${safeCode(error)}`, error?.code),
          true,
        );
      }

      function childClose(exitCode, childSignal) {
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
        if (exitCode === null) {
          settle(
            reject,
            processError(`${command} closed without an exit status`, 'ECHILDCLOSE'),
          );
          return;
        }
        const result = {
          command,
          args,
          exitCode,
          stdout: stdout.text(),
          stderr: stderr.text(),
        };
        settle(resolve, result);
      }

      abortSignal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', stdoutData);
      child.stderr.on('data', stderrData);
      child.stdout.on('error', streamError);
      child.stderr.on('error', streamError);
      child.on('error', childError);
      child.once('close', childClose);

      if (input !== null) {
        child.stdin?.once('error', streamError);
        try {
          child.stdin.end(input);
        } catch {
          settle(
            reject,
            processError(`${command} input stream failed`, 'EIO'),
            true,
          );
          return;
        }
      }

      if (timeoutMs !== undefined) {
        timeout = setTimeout(
          () => stop(processError(`${command} timed out after ${timeoutMs}ms`, 'ETIMEDOUT')),
          timeoutMs,
        );
      }
    });
  };
}

export const run = createProcessRunner();
