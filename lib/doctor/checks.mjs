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

export function checkToolContract(tools) {
  if (!Array.isArray(tools)) {
    return result(
      'fail',
      'The runtime returned a malformed tool catalog.',
      'Reinstall the pinned Fast Browser runtime.',
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
      'Reinstall the pinned runtime and run `fast-browser doctor`.',
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

function responseResult(response, method, outputCapBytes) {
  bounded(response, outputCapBytes);
  if (
    response === null
    || typeof response !== 'object'
    || Array.isArray(response)
    || response.error
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
  runSession,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  outputCapBytes = DEFAULT_OUTPUT_CAP_BYTES,
} = {}) {
  if (typeof runSession === 'function') {
    const messages = [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'fast-browser-doctor', version: '1' },
        },
      },
      {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      },
    ];
    const session = await timeout(
      Promise.resolve().then(() => runSession(
        messages,
        { timeoutMs, outputCapBytes },
      )),
      timeoutMs,
    );
    if (
      !session
      || session.exitCode !== 0
      || typeof session.stdout !== 'string'
      || Buffer.byteLength(session.stdout, 'utf8') > outputCapBytes
    ) throw new Error('MCP pinned runtime session failed');
    const responses = [];
    for (const line of session.stdout.split(/\r?\n/).filter(Boolean)) {
      try {
        responses.push(JSON.parse(line));
      } catch {
        throw new Error('MCP session output was malformed');
      }
    }
    const initialize = responses.find(({ id }) => id === 1);
    const tools = responses.find(({ id }) => id === 2);
    const initialized = responseResult(initialize, 'initialize', outputCapBytes);
    const listed = responseResult(tools, 'tools/list', outputCapBytes);
    if (typeof initialized.protocolVersion !== 'string' || !Array.isArray(listed.tools)) {
      throw new Error('MCP session response was malformed');
    }
    bounded(listed.tools, outputCapBytes);
    return { protocolVersion: initialized.protocolVersion, tools: listed.tools };
  }
  if (typeof openTransport !== 'function') {
    throw new Error('MCP transport is unavailable');
  }
  let transport;
  try {
    transport = await timeout(Promise.resolve().then(openTransport), timeoutMs);
    if (
      !transport
      || typeof transport.request !== 'function'
      || typeof transport.close !== 'function'
    ) throw new Error('MCP transport was malformed');
    const initialized = responseResult(
      await timeout(
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
        timeoutMs,
      ),
      'initialize',
      outputCapBytes,
    );
    if (typeof initialized.protocolVersion !== 'string') {
      throw new Error('MCP initialize response was malformed');
    }
    const listed = responseResult(
      await timeout(
        transport.request({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {},
        }),
        timeoutMs,
      ),
      'tools/list',
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
      const handshake = await performMcpHandshake({
        openTransport: dependencies.openMcpTransport,
        runSession: dependencies.runMcpSession,
        timeoutMs: dependencies.handshakeTimeoutMs,
        outputCapBytes: dependencies.handshakeOutputCapBytes,
      });
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
