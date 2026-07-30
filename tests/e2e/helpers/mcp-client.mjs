import { execFile as execFileCallback } from 'node:child_process';
import crypto from 'node:crypto';
import {
  access,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { createMetrics } from './metrics.mjs';

const execFile = promisify(execFileCallback);
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RUNTIME_DIST = path.join(
  'playwright', '.worktrees', 'fast-browser-runtime', 'fast-browser-dist',
);
const INTEGRITY_ERROR = 'the local fast-browser runtime artifact failed integrity validation';
const EXTRACTION_ERROR = 'the validated local fast-browser runtime artifact could not be extracted';
const CLEANUP_ERROR = 'the validated local fast-browser runtime artifact could not be cleaned up';

function integrityError() {
  return new Error(INTEGRITY_ERROR);
}

// Found by walking up from the plugin rather than by a fixed number of `..`
// segments. The old fixed path assumed this plugin lived two directories deeper
// than it does in a plain checkout -- it was written from a worktree under
// `.worktrees/` -- so every e2e suite failed on ENOENT the moment the same code
// was run from the repository itself. Which sibling checkout holds the runtime
// is the stable fact here; how deep this plugin happens to sit is not.
export async function resolveReleaseDir() {
  const fromEnvironment = process.env.FAST_BROWSER_RELEASE_DIR;
  if (fromEnvironment) return fromEnvironment;
  let directory = pluginRoot;
  for (;;) {
    const candidate = path.join(directory, RUNTIME_DIST);
    try {
      await access(candidate);
      return candidate;
    } catch {
      const parent = path.dirname(directory);
      if (parent === directory) {
        throw new Error(
          `no local fast-browser runtime found in any ancestor of ${pluginRoot};`
          + ' set FAST_BROWSER_RELEASE_DIR to the release directory',
        );
      }
      directory = parent;
    }
  }
}

// Exported (in addition to startMcpClient below) so tests/e2e/helpers/identity-client.mjs
// can launch the same integrity-checked runtime in --extension mode without
// duplicating the checksum/extraction logic.
export async function runtimeCliFor({ outputDir, releaseDir: requested }) {
  const releaseDir = requested ?? await resolveReleaseDir();
  // Derived from the bundled lock rather than hardcoded: a pinned filename
  // here silently validates the previous release against the current lock's
  // checksum after every re-pin, which reads as an integrity failure.
  const pinnedLock = JSON.parse(await readFile(
    new URL('../../../runtime-lock.json', import.meta.url),
  ));
  const manifestName = `fast-browser-release-${pinnedLock.productVersion}.json`;
  const manifest = JSON.parse(await readFile(path.join(releaseDir, manifestName)));
  if (manifest.schemaVersion !== 1 || manifest.protocolVersion !== 2 || !manifest.runtime?.file) {
    throw new Error('the local fast-browser release manifest is not compatible with this fixture');
  }
  const archive = path.join(releaseDir, manifest.runtime.file);
  let acceptedLock;
  let archiveBytes;
  try {
    [acceptedLock, archiveBytes] = await Promise.all([
      readFile(path.join(pluginRoot, 'runtime-lock.json'), 'utf8').then(JSON.parse),
      readFile(archive),
    ]);
  } catch {
    throw integrityError();
  }
  const acceptedSha256 = acceptedLock?.runtime?.sha256;
  const manifestSha256 = manifest.runtime.sha256;
  const actualSha256 = crypto.createHash('sha256').update(archiveBytes).digest('hex');
  if (
    typeof acceptedSha256 !== 'string'
    || typeof manifestSha256 !== 'string'
    || manifestSha256 !== acceptedSha256
    || actualSha256 !== acceptedSha256
  ) {
    throw integrityError();
  }
  const runtimeDir = path.join(outputDir, '.runtime');
  const validatedArchive = path.join(
    outputDir,
    `.runtime-archive-${crypto.randomUUID()}.tar.gz`,
  );
  let extractionError = null;
  try {
    await writeFile(validatedArchive, archiveBytes, { flag: 'wx', mode: 0o600 });
    await mkdir(runtimeDir, { recursive: true });
    await execFile('/usr/bin/tar', ['-xzf', validatedArchive, '-C', runtimeDir]);
  } catch {
    extractionError = new Error(EXTRACTION_ERROR);
  }
  try {
    await rm(validatedArchive, { force: true });
  } catch {
    throw new Error(CLEANUP_ERROR);
  }
  if (extractionError) throw extractionError;
  const cli = path.join(runtimeDir, 'fast-browser-mcp', 'cli.cjs');
  await access(cli);
  return cli;
}

// Exported alongside runtimeCliFor for the same reason: the identity-client
// helper reuses this envelope parsing rather than re-implementing it.
export function textResult(response) {
  if (response.isError) {
    throw new Error(response.content.find((item) => item.type === 'text')?.text ?? 'MCP tool failed');
  }
  const text = response.content.find((item) => item.type === 'text')?.text;
  if (!text) return undefined;
  const result = text.match(/^### Result\s*\n([\s\S]*?)(?:\n\n### |$)/m)?.[1]?.trim() ?? text.trim();
  try {
    return JSON.parse(result);
  } catch {
    return result;
  }
}

// `extraArgs` lets a suite opt one launch into additional runtime flags (the
// video suite passes --save-video) without every other suite inheriting them.
export async function startMcpClient({ outputDir, releaseDir, extraArgs = [] } = {}) {
  if (!outputDir) throw new Error('outputDir is required');
  const cli = await runtimeCliFor({ outputDir, releaseDir });
  const client = new Client(
    { name: 'fast-browser-direct-parity', version: '1.0.0' },
    { capabilities: { roots: {} } },
  );
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: pathToFileURL(outputDir).href, name: 'fast-browser-e2e-output' }],
  }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      cli,
      '--headless',
      '--browser', 'chrome',
      '--snapshot-mode=none',
      '--timeout-settle=200',
      `--output-dir=${outputDir}`,
      ...extraArgs,
    ],
    cwd: outputDir,
    stderr: 'pipe',
  });
  transport.stderr?.resume();
  await client.connect(transport);
  const recorder = createMetrics();

  return {
    callTool: (name, args) => recorder.measure(name, async () => textResult(
      await client.callTool({ name, arguments: args }),
    )),
    metrics: () => recorder.summary(),
    close: () => client.close(),
  };
}
