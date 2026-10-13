import http from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { loadRuntimeLock } from '../../../lib/runtime/lock.mjs';

const pagesDir = path.resolve('tests/fixtures/evidence/pages');

export function runtimeCli(renderer) {
  return process.env.FAST_BROWSER_TEST_RUNTIME_CLI
    ?? path.join(path.dirname(path.dirname(renderer.playwrightCore)), 'cli.cjs');
}

// The synthetic fixture pages over http: the runtime does not navigate to file URLs.
// `inline` maps a page name to html a test builds itself, served in place of a fixture file.
export async function servePages({ inline = {} } = {}) {
  const server = http.createServer(async (request, response) => {
    try {
      const name = path.basename(new URL(request.url, 'http://localhost').pathname);
      const body = name.endsWith('.html') && Object.hasOwn(inline, name.slice(0, -5)) ? inline[name.slice(0, -5)] : await readFile(path.join(pagesDir, name));
      response.writeHead(200, { 'content-type': 'text/html' }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  // A browser keeps its connection open for as long as its tab lives; close() must not wait for it.
  return {
    url: (page) => `http://127.0.0.1:${server.address().port}/${page}.html`,
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
  };
}

// mode 'headless' launches the pinned renderer; mode 'extension' attaches to the real Chrome through the relay.
export async function startCaptureTool({ home, renderer, mode = 'headless', env = {} }) {
  const outputDir = path.join(home, '.fast-browser', 'output');
  const captureDir = path.join(home, '.fast-browser', 'screenshots');
  await mkdir(outputDir, { recursive: true });
  const lock = await loadRuntimeLock({ bundledPath: path.resolve('runtime-lock.json') });
  const engine = mode === 'extension'
    ? ['--extension', `--extension-id=${lock.extension.id}`]
    : ['--headless', '--isolated', `--executable-path=${renderer.executablePath}`, '--viewport-size=1000x700'];
  const client = new Client({ name: 'capture-evidence-test', version: '0.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [runtimeCli(renderer), ...engine, '--snapshot-mode=none', '--codegen=none', '--timeout-settle=200',
      `--output-dir=${outputDir}`, `--capture-dir=${captureDir}`],
    cwd: outputDir, stderr: 'pipe', env: { ...process.env, ...env },
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close().catch(() => {});
    throw new Error(`the capture runtime did not start (${runtimeCli(renderer)}): ${error.message}${stderr ? `\n${stderr.trim()}` : ''}`, { cause: error });
  }
  const text = (result) => result.content.find((c) => c.type === 'text')?.text ?? '';
  // A hung call must fail the test, not sit until the suite's timeout.
  const call = async (name, args, withinMs = 30_000) => {
    let timer;
    try {
      return await Promise.race([
        client.callTool({ name, arguments: args }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} did not return within ${withinMs}ms`)), withinMs); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  return {
    captureDir, outputDir, call, text,
    capture: async (args) => {
      const result = await call('browser_capture_evidence', args);
      const body = text(result);
      if (result.isError) throw new Error(body);
      return JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1));
    },
    close: () => client.close(),
  };
}
