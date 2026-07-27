// Live-only helper: starts a DIRECT MCP client (same transport shape as
// tests/e2e/helpers/mcp-client.mjs) but in --extension mode against the
// paired real Chrome, carrying the identity a real Claude Code or Codex
// session would present. Only imported by the FAST_BROWSER_LIVE_E2E-gated
// test in simultaneous.test.mjs, which this task's brief forbids running.
//
// Mechanism this mirrors (see task-3-simultaneous-report.md for the full
// derivation and file:line citations):
//   - packages/extension/src/background.ts (_connectTab) computes the
//     Chrome tab-group title from the workspace folder basename (derived
//     from the MCP `roots` capability) first, falling back to the MCP
//     clientInfo.name only when no workspace root was advertised.
//   - Both Claude Code and Codex implement the MCP `roots` capability, so
//     the workspace root (not clientInfo.name) is the mechanism actually
//     exercised here. clientInfo.name below is documented best-effort
//     metadata; it is never decisive while a workspace root is supplied.
//
// Two environment prerequisites, both required before this helper (or the
// live test that uses it) can do anything:
//   1. FAST_BROWSER_LIVE_EXTENSION_TOKEN: a token-bypass token for the
//      paired real Chrome extension (see startIdentityClient below).
//   2. FAST_BROWSER_LIVE_CDP_URL: only needed for queryGroupLabels (see
//      queryGroupLabelsViaExtensionDebugger below) and NOT set up by
//      production's own launch path (plugins/fast-browser/lib/runtime/launch.mjs
//      never opens a debug port), so it requires the paired Chrome to have
//      been started manually with a remote-debugging port.
// If either is missing or wrong, the affected call throws instead of
// fabricating a result; this file never swallows that failure.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { loadRuntimeLock } from '../../../lib/runtime/lock.mjs';
import { runtimeCliFor, textResult } from './mcp-client.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const IDENTITY_CLIENT_INFO = {
  claude: { name: 'claude-code', version: '0.0.0-live-e2e' },
  codex: { name: 'codex', version: '0.0.0-live-e2e' },
};

export async function startIdentityClient({
  identity,
  outputDir,
  workspaceDir,
  releaseDir,
  extensionToken = process.env.FAST_BROWSER_LIVE_EXTENSION_TOKEN,
}) {
  if (identity !== 'claude' && identity !== 'codex') {
    throw new TypeError('identity must be "claude" or "codex"');
  }
  if (!outputDir || !workspaceDir) {
    throw new TypeError('outputDir and workspaceDir are required');
  }
  if (!extensionToken) {
    throw new Error(
      'FAST_BROWSER_LIVE_EXTENSION_TOKEN is required (token-bypass connection to the '
      + 'paired real Chrome extension, matching tests/extension/multi-connection.spec.ts '
      + 'in the runtime reference worktree). If this test also needs group-label '
      + 'verification, FAST_BROWSER_LIVE_CDP_URL must be set too; see '
      + 'queryGroupLabelsViaExtensionDebugger below for how to launch Chrome so that works.',
    );
  }

  const lock = await loadRuntimeLock({ bundledPath: path.join(pluginRoot, 'runtime-lock.json') });
  const cli = await runtimeCliFor({ outputDir, releaseDir });

  const client = new Client(IDENTITY_CLIENT_INFO[identity], { capabilities: { roots: {} } });
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    // "workspace" mirrors the root name used in the reference worktree's own
    // multi-connection.spec.ts fixture; only the URI's basename is decisive
    // for the resulting tab-group label.
    roots: [{ uri: pathToFileURL(workspaceDir).href, name: 'workspace' }],
  }));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      cli,
      // Matches plugins/fast-browser/lib/runtime/launch.mjs's runtimeArgs
      // exactly (minus --save-session, which only applies to the "full"
      // profile), so this test exercises the real production invocation.
      '--extension',
      `--extension-id=${lock.extension.id}`,
      '--snapshot-mode=none',
      '--timeout-settle=200',
      `--output-dir=${outputDir}`,
    ],
    cwd: outputDir,
    stderr: 'pipe',
    env: { ...process.env, PLAYWRIGHT_MCP_EXTENSION_TOKEN: extensionToken },
  });
  transport.stderr?.resume();
  await client.connect(transport);

  return {
    identity,
    pid: transport.pid,
    callTool: async (name, args) => textResult(await client.callTool({ name, arguments: args })),
    close: () => client.close(),
    // SIGKILLs the child and resolves only once it has actually exited (the
    // SDK's StdioClientTransport fires transport.onclose from the child
    // process's own 'close' event; see node_modules/@modelcontextprotocol/sdk's
    // client/stdio.js), never immediately after issuing the signal. A caller
    // that checks another client right after kill() must not race the OS.
    // Falls back to a bounded timeout so a missed/coalesced close event can
    // never hang the live test forever; chains any onclose handler the SDK
    // Client itself already installed rather than clobbering it.
    kill: () => new Promise((resolve) => {
      if (!transport.pid) {
        resolve();
        return;
      }
      const previousOnClose = transport.onclose;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        transport.onclose = previousOnClose;
        resolve();
      };
      transport.onclose = () => {
        previousOnClose?.();
        settle();
      };
      process.kill(transport.pid, 'SIGKILL');
      const timeout = setTimeout(settle, 5_000);
      timeout.unref?.();
    }),
    queryGroupLabels: () => queryGroupLabelsViaExtensionDebugger({ extensionId: lock.extension.id }),
  };
}

// Chrome tab-group titles are extension-internal state (chrome.tabGroups)
// and are never surfaced through any Fast Browser MCP tool: browser_tabs
// only returns per-tab title/url/index (see
// packages/playwright-core/src/tools/backend/tabs.ts and response.ts's
// renderTabsMarkdown in the runtime reference worktree), and
// browser_run_code_unsafe only exposes the connected content `page`, never
// the extension service worker (packages/playwright-core/src/tools/backend/runCode.ts).
// The only way to observe the real label is to evaluate inside the
// extension's own service worker over CDP, mirroring how the runtime's own
// tests do it via browserContext.serviceWorkers() in
// tests/extension/multi-connection.spec.ts.
//
// PREREQUISITE (undocumented by production, so stated explicitly here):
// production's own launch path (plugins/fast-browser/lib/runtime/launch.mjs's
// runtimeArgs) never opens a CDP debug port on the paired Chrome, so this
// only works if whoever un-gates this test first launches that Chrome
// themselves with one, e.g.:
//   open -a "Google Chrome" --args --remote-debugging-port=9222 \
//     --user-data-dir=<the paired profile's user-data-dir>
// then set FAST_BROWSER_LIVE_CDP_URL to that port's HTTP origin (default
// assumed here: http://127.0.0.1:9222). This also requires a global
// WebSocket implementation (Node >= 21; the plugin's own floor is Node >= 20).
// If the endpoint is unreachable, the extension service worker target is
// missing, or chrome.tabGroups.query throws inside it, THIS FUNCTION THROWS.
// Callers must let that propagate and fail the test loudly rather than catch
// it and fabricate groupLabelsDistinct or any other evidence field.
async function queryGroupLabelsViaExtensionDebugger({
  extensionId,
  cdpHttpUrl = process.env.FAST_BROWSER_LIVE_CDP_URL ?? 'http://127.0.0.1:9222',
}) {
  const targets = await (await fetch(`${cdpHttpUrl}/json/list`)).json();
  const worker = targets.find((target) => (
    target.type === 'service_worker'
    && typeof target.url === 'string'
    && target.url.startsWith(`chrome-extension://${extensionId}/`)
  ));
  if (!worker) {
    throw new Error('fast-browser extension service worker was not found on the CDP endpoint');
  }
  const socket = new WebSocket(worker.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  try {
    const evaluated = await sendCdpCommand(socket, 'Runtime.evaluate', {
      expression: 'JSON.stringify((await chrome.tabGroups.query({})).map(g => g.title))',
      awaitPromise: true,
      returnByValue: true,
    });
    if (evaluated.exceptionDetails) {
      throw new Error('chrome.tabGroups.query failed inside the extension service worker');
    }
    return JSON.parse(evaluated.result.value);
  } finally {
    socket.close();
  }
}

function sendCdpCommand(socket, method, params) {
  const id = Math.floor(Math.random() * 1_000_000);
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        reject(error);
        return;
      }
      if (message.id !== id) return;
      socket.removeEventListener('message', onMessage);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    };
    socket.addEventListener('message', onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });
}
