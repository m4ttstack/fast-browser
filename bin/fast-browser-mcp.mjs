#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolvePaths } from '../lib/core/paths.mjs';
import { startRuntime } from '../lib/runtime/entry.mjs';
import { loadRuntimeLock } from '../lib/runtime/lock.mjs';

const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const paths = resolvePaths({ pluginRoot });

try {
  const lock = await loadRuntimeLock({
    bundledPath: path.join(pluginRoot, 'runtime-lock.json'),
  });
  process.exitCode = await startRuntime({ env: process.env, paths, lock });
} catch (error) {
  const message = String(error?.message ?? error).replaceAll('\n', ' ');
  process.stderr.write(`fast-browser-mcp: ${message}\n`);
  // 69 EX_UNAVAILABLE (sidecar unreachable, retryable) and 78 EX_CONFIG
  // (bad env contract, not retryable) let the sandbox controller decide
  // remediation from exit status alone, without parsing this log line.
  process.exitCode = error?.exitCode ?? 1;
}
