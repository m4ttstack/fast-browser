const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_OUTPUT_CAP_BYTES = 1024 * 1024;

export const DOCTOR_CHECK_IDS = Object.freeze([
  'platform',
  'node',
  'chrome',
  'claude-cli',
  'codex-cli',
  'claude-plugin',
  'codex-plugin',
  'claude-routing',
  'codex-routing',
  'browser-driver',
  'runtime-checksum',
  'extension-artifact',
  'extension-installed',
  'extension-loaded',
  'pairing',
  'data-permissions',
  'mcp-handshake',
  'tool-contract',
]);

const REQUIRED_TOOLS = Object.freeze([
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_run_code_unsafe',
]);

function result(status, message, remediation = null) {
  return { status, message, remediation };
}

// Fixed remediation for every tool-contract failure: whether the runtime
// never returned a catalog or returned an incomplete one, the fix is the
// same pinned reinstall. Pointing at `setup` (which upgrades when eligible
// and only refuses on genuine drift) instead of `doctor` avoids the closed
// loop where doctor tells the user to rerun the command that found nothing
// to fix.
const RUNTIME_CONTRACT_REMEDIATION = 'Run `fast-browser setup` to install the pinned runtime.';

export function checkToolContract(tools) {
  if (!Array.isArray(tools)) {
    return result(
      'fail',
      'The runtime returned a malformed tool catalog.',
      RUNTIME_CONTRACT_REMEDIATION,
    );
  }
  const byName = new Map();
  for (const tool of tools) {
    if (
      tool
      && typeof tool === 'object'
      && !Array.isArray(tool)
      && typeof tool.name === 'string'
      && !byName.has(tool.name)
    ) byName.set(tool.name, tool);
  }
  const missing = REQUIRED_TOOLS.filter((name) => !byName.has(name));
  const unsafe = byName.get('browser_run_code_unsafe');
  const annotationsValid = (
    unsafe?.annotations?.destructiveHint === true
    && unsafe?.annotations?.openWorldHint === true
  );
  if (missing.length > 0 || !annotationsValid) {
    return result(
      'fail',
      'The Fast Browser tool contract does not match the pinned release.',
      RUNTIME_CONTRACT_REMEDIATION,
    );
  }
  return result('pass', 'The Fast Browser tool contract is complete.');
}

function bounded(value, limit) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new Error('MCP response was malformed');
  }
  if (Buffer.byteLength(text, 'utf8') > limit) {
    throw new Error('MCP response exceeded the output limit');
  }
  return value;
}

function timeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`MCP handshake timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

function responseResult(response, method, id, outputCapBytes) {
  bounded(response, outputCapBytes);
  if (
    response === null
    || typeof response !== 'object'
    || Array.isArray(response)
    || response.jsonrpc !== '2.0'
    || response.id !== id
    || Object.hasOwn(response, 'error')
    || response.result === null
    || typeof response.result !== 'object'
    || Array.isArray(response.result)
  ) {
    throw new Error(`MCP ${method} response was malformed`);
  }
  return response.result;
}

export async function performMcpHandshake({
  openTransport,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  outputCapBytes = DEFAULT_OUTPUT_CAP_BYTES,
} = {}) {
  if (typeof openTransport !== 'function') {
    throw new Error('MCP transport is unavailable');
  }
  const started = Date.now();
  const remaining = () => Math.max(1, timeoutMs - (Date.now() - started));
  const boundedWait = (promise) => timeout(promise, remaining());
  let transport;
  try {
    transport = await boundedWait(Promise.resolve().then(() => openTransport({
      outputCapBytes,
    })));
    if (
      !transport
      || typeof transport.request !== 'function'
      || typeof transport.notify !== 'function'
      || typeof transport.close !== 'function'
    ) throw new Error('MCP transport was malformed');
    const initialized = responseResult(
      await boundedWait(
        transport.request({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'fast-browser-doctor', version: '1' },
          },
        }),
      ),
      'initialize',
      1,
      outputCapBytes,
    );
    if (typeof initialized.protocolVersion !== 'string') {
      throw new Error('MCP initialize response was malformed');
    }
    await boundedWait(transport.notify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    }));
    const listed = responseResult(
      await boundedWait(
        transport.request({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {},
        }),
      ),
      'tools/list',
      2,
      outputCapBytes,
    );
    if (!Array.isArray(listed.tools)) {
      throw new Error('MCP tools/list response was malformed');
    }
    bounded(listed.tools, outputCapBytes);
    return { protocolVersion: initialized.protocolVersion, tools: listed.tools };
  } finally {
    if (transport?.close) {
      await Promise.resolve(transport.close({ descendants: true })).catch(() => {});
    }
  }
}

export function defaultCheck(id, dependencies = {}) {
  if (id === 'platform') {
    return async () => (
      (dependencies.platform ?? process.platform) === 'darwin'
        ? result('pass', 'macOS is supported.')
        : result(
          'fail',
          'Fast Browser supports macOS only.',
          'Run Fast Browser on macOS with Google Chrome.',
        )
    );
  }
  if (id === 'node') {
    return async () => (
      Number.parseInt((dependencies.nodeVersion ?? process.versions.node).split('.')[0], 10) >= 20
        ? result('pass', 'Node 20 or newer is available.')
        : result('fail', 'Node 20 or newer is required.', 'Install Node 20 or newer.')
    );
  }
  if (id === 'mcp-handshake') {
    return async (context) => {
      let handshake;
      try {
        handshake = await performMcpHandshake({
          openTransport: dependencies.openMcpTransport,
          timeoutMs: dependencies.handshakeTimeoutMs,
          outputCapBytes: dependencies.handshakeOutputCapBytes,
        });
      } catch {
        // A handshake failure is most often the runtime not being installed
        // yet at the currently pinned version (a fresh install or a pending
        // upgrade); point at `setup`, not another `doctor` run, so the
        // remediation is never a closed loop back to the command that just
        // found nothing to fix.
        return result(
          'fail',
          'The Fast Browser runtime did not complete the MCP handshake.',
          RUNTIME_CONTRACT_REMEDIATION,
        );
      }
      context.tools = handshake.tools;
      return result('pass', 'MCP initialize and tools/list completed.');
    };
  }
  if (id === 'tool-contract') {
    return async (context) => checkToolContract(context.tools);
  }
  return async () => {
    const implementation = dependencies[`check:${id}`];
    if (typeof implementation === 'function') return implementation();
    return result(
      'warn',
      `${id} was not verified.`,
      `Run \`fast-browser doctor\` after configuring ${id}.`,
    );
  };
}
