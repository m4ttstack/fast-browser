#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../lib/core/config.mjs';
import { resolvePaths } from '../lib/core/paths.mjs';
import { launchRuntime } from '../lib/runtime/launch.mjs';
import { loadRuntimeLock } from '../lib/runtime/lock.mjs';

const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const paths = resolvePaths({ pluginRoot });

async function readKeychainToken() {
  const { readToken } = await import('../lib/keychain/keychain.mjs');
  return readToken();
}

try {
  const [config, lock] = await Promise.all([
    loadConfig(paths),
    loadRuntimeLock({ bundledPath: path.join(pluginRoot, 'runtime-lock.json') }),
  ]);
  process.exitCode = await launchRuntime({
    config,
    paths,
    lock,
    readToken: readKeychainToken,
  });
} catch (error) {
  const message = String(error?.message ?? error).replaceAll('\n', ' ');
  process.stderr.write(`fast-browser-mcp: ${message}\n`);
  process.exitCode = error?.exitCode ?? 1;
}
