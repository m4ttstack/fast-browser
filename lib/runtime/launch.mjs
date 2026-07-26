import { spawn as nodeSpawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { runtimeLockIdentity } from './lock.mjs';

export class RuntimeLaunchError extends Error {
  constructor(message) {
    super(message.replaceAll('\n', ' '));
    this.name = 'RuntimeLaunchError';
  }
}

function doctorError(message) {
  return new RuntimeLaunchError(`${message}; run fast-browser doctor`);
}

export function runtimeArgs({ config, paths, lock }) {
  const args = [
    '--extension',
    `--extension-id=${lock.extension.id}`,
    '--snapshot-mode=none',
    '--timeout-settle=200',
    `--output-dir=${paths.dataDir}`,
  ];
  if (config.profile === 'full') args.push('--save-session');
  return args;
}

function runtimeLocation(paths, lock) {
  const directory = path.join(paths.runtimeDir, lock.productVersion);
  return {
    cli: path.join(directory, 'fast-browser-mcp', 'cli.cjs'),
    marker: path.join(directory, 'installed.json'),
  };
}

async function validateInstalledRuntime(paths, lock) {
  const location = runtimeLocation(paths, lock);
  try {
    const [marker, cliState] = await Promise.all([
      readFile(location.marker, 'utf8').then(JSON.parse),
      stat(location.cli),
    ]);
    if (
      marker.schemaVersion !== 1
      || JSON.stringify(marker.lock) !== JSON.stringify(runtimeLockIdentity(lock))
      || !cliState.isFile()
    ) {
      throw new Error('invalid installed runtime state');
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw doctorError('fast-browser runtime is not installed');
    }
    throw doctorError('fast-browser runtime checksum or install state is invalid');
  }
  return location.cli;
}

function validateNodeVersion(requirement) {
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (requirement !== '>=20' || !Number.isInteger(major) || major < 20) {
    throw doctorError(`Node ${requirement} is required`);
  }
}

export async function launchRuntime({
  config,
  paths,
  lock,
  readToken = async () => null,
  spawn = nodeSpawn,
}) {
  validateNodeVersion(lock.runtime.node);
  const runtimeCli = await validateInstalledRuntime(paths, lock);
  let token = null;
  if (config.connection.mode === 'auto') {
    try {
      token = await readToken();
    } catch {
      throw doctorError('unable to read the fast-browser Keychain token');
    }
    if (!token) throw doctorError('fast-browser Keychain token is missing');
  }
  const env = token
    ? { ...process.env, PLAYWRIGHT_MCP_EXTENSION_TOKEN: token }
    : process.env;

  let child;
  try {
    child = spawn(
      process.execPath,
      [runtimeCli, ...runtimeArgs({ config, paths, lock })],
      {
        stdio: 'inherit',
        shell: false,
        env,
      },
    );
  } catch (error) {
    throw doctorError(`unable to start fast-browser runtime (${error.code ?? 'spawn failed'})`);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(doctorError(`unable to start fast-browser runtime (${error.code ?? 'spawn failed'})`));
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve(0);
        return;
      }
      const reason = code === null ? `signal ${signal}` : `code ${code}`;
      reject(doctorError(`fast-browser runtime exited with ${reason}`));
    });
  });
}
