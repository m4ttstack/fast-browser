import { spawn as nodeSpawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { assertConfinedPath } from '../core/containment.mjs';
import { verifyRuntimeContentDigest } from './content.mjs';
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

// Distinct from doctorError: a content mismatch is not "something doctor
// needs to diagnose", it is the exact, already-known fix -- reinstall the
// pinned artifacts -- so the message points straight at setup instead of
// routing the user through another command first.
function setupError(message) {
  return new RuntimeLaunchError(`${message}; run fast-browser setup`);
}

export function runtimeArgs({ config, paths, lock }) {
  const args = [
    '--extension',
    `--extension-id=${lock.extension.id}`,
    '--snapshot-mode=none',
    '--timeout-settle=200',
    `--output-dir=${paths.dataDir}`,
  ];
  if (config.trace !== false) args.push('--save-trace');
  if (config.profile === 'full') args.push('--save-session');
  // The runtime records into the `videos` subdirectory of --output-dir, so
  // recordings land in ~/.fast-browser/videos where the `gif` command reads
  // them. Under the --extension mode this launcher always uses, the pinned
  // runtime carries the flag onto the relay-attached context, so the real
  // Chrome tabs Fast Browser drives are exactly what gets recorded.
  if (config.video) args.push(`--save-video=${config.video.width}x${config.video.height}`);
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
  let marker;
  try {
    await Promise.all([
      assertConfinedPath({
        dataDir: paths.dataDir,
        rootDir: paths.runtimeDir,
        candidate: location.cli,
      }),
      assertConfinedPath({
        dataDir: paths.dataDir,
        rootDir: paths.runtimeDir,
        candidate: location.marker,
      }),
    ]);
    const [readMarker, cliState] = await Promise.all([
      readFile(location.marker, 'utf8').then(JSON.parse),
      stat(location.cli),
    ]);
    marker = readMarker;
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
  // This is the literal entrypoint spawned on every session start
  // (bin/fast-browser-mcp.mjs -> launchRuntime), entirely independent of
  // setup and doctor. A marker that matches the lock in every recorded
  // field still proves nothing about the bytes actually on disk: recompute
  // the digest over the installed tree -- the exact same shared check
  // doctor's runtime-checksum, installRuntime's existingInstall, and the
  // upgrade classifier all use -- before ever executing it. Any failure to
  // verify (mismatch, missing digest, or an unexpected read error) fails
  // closed: never launch unverified bytes.
  let verified;
  try {
    verified = await verifyRuntimeContentDigest(path.dirname(location.cli), marker);
  } catch {
    verified = false;
  }
  if (!verified) {
    throw setupError('fast-browser runtime content does not match its installed marker');
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
