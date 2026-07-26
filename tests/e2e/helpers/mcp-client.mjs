import { execFile as execFileCallback } from 'node:child_process';
import { access, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { createMetrics } from './metrics.mjs';

const execFile = promisify(execFileCallback);
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const defaultReleaseDir = path.resolve(
  pluginRoot,
  '../../../../../playwright/.worktrees/fast-browser-runtime/fast-browser-dist',
);

async function runtimeCliFor({ outputDir, releaseDir = process.env.FAST_BROWSER_RELEASE_DIR ?? defaultReleaseDir }) {
  const manifest = JSON.parse(await readFile(path.join(releaseDir, 'fast-browser-release-0.1.0-alpha.1.json')));
  if (manifest.schemaVersion !== 1 || manifest.protocolVersion !== 2 || !manifest.runtime?.file) {
    throw new Error('the local fast-browser release manifest is not compatible with this fixture');
  }
  const archive = path.join(releaseDir, manifest.runtime.file);
  await access(archive);
  const runtimeDir = path.join(outputDir, '.runtime');
  await mkdir(runtimeDir, { recursive: true });
  await execFile('/usr/bin/tar', ['-xzf', archive, '-C', runtimeDir]);
  const cli = path.join(runtimeDir, 'fast-browser-mcp', 'cli.cjs');
  await access(cli);
  return cli;
}

function textResult(response) {
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

export async function startMcpClient({ outputDir, releaseDir } = {}) {
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
