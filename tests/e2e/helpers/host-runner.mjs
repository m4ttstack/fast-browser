import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const HOST_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
// The real Claude Code tool identity for Fast Browser MCP tools; see
// task-3-harness-fix-brief.md ground truth.
const CLAUDE_FAST_BROWSER_TOOL_PREFIX = 'mcp__plugin_fast-browser_fast-browser__';
const CLAUDE_EVENT_TYPES = new Set([
  'assistant',
  'rate_limit_event',
  'result',
  'system',
  'user',
]);
const CLAUDE_CONTENT_TYPES = new Set([
  'redacted_thinking',
  'text',
  'thinking',
  'tool_result',
  'tool_use',
]);
const CODEX_EVENT_TYPES = new Set([
  'error',
  'item.completed',
  'item.started',
  'item.updated',
  'thread.started',
  'turn.completed',
  'turn.failed',
  'turn.started',
]);
const CODEX_ITEM_TYPES = new Set([
  'agent_message',
  'collab_tool_call',
  'command_execution',
  'file_change',
  'mcp_tool_call',
  'reasoning',
  'todo_list',
  'web_search',
]);
const REQUIRED_RESULT_KEYS = new Set(['host', 'ok', 'orderId']);
// The model may also report these, but the harness always overwrites them
// with its own observed values, so their presence and shape are not
// validated here.
const OPTIONAL_RESULT_KEYS = new Set(['browserCalls', 'elapsedMs', 'tools']);
const ALLOWED_RESULT_KEYS = new Set([
  ...REQUIRED_RESULT_KEYS,
  ...OPTIONAL_RESULT_KEYS,
]);

function labelFor(host) {
  return host === 'claude' ? 'Claude' : 'Codex';
}

function eventError(line, detail) {
  return new Error(`host event line ${line} ${detail}`);
}

function parseEventLines(text) {
  if (typeof text !== 'string') throw new TypeError('host events must be a string');
  const events = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim() === '') continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw eventError(index + 1, 'is not valid JSON');
    }
    if (
      event === null
      || typeof event !== 'object'
      || Array.isArray(event)
      || typeof event.type !== 'string'
    ) {
      throw eventError(index + 1, 'is not a valid host event');
    }
    events.push({ event, line: index + 1 });
  }
  return events;
}

function finalToolSegment(name) {
  if (typeof name !== 'string' || name.length === 0) return null;
  return name.split('__').at(-1);
}

// Real final messages arrive wrapped in a markdown code fence (for example
// "```json\n{...}\n```"); strip at most one leading and one trailing fence
// line before parsing.
function stripResultFence(value) {
  const lines = value.split(/\r?\n/);
  let start = 0;
  let end = lines.length;
  if (start < end && /^```(json)?$/.test(lines[start].trim())) {
    start += 1;
  }
  if (end > start && lines[end - 1].trim() === '```') {
    end -= 1;
  }
  return lines.slice(start, end).join('\n').trim();
}

function structuredResult(value, host) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    throw new Error(`${labelFor(host)} host did not return a JSON result`);
  }
  try {
    const parsed = JSON.parse(stripResultFence(value));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error();
    }
    return parsed;
  } catch {
    throw new Error(`${labelFor(host)} host did not return a JSON result`);
  }
}

function validateResult(value, host) {
  const keys = Object.keys(value);
  if (
    keys.some((key) => !ALLOWED_RESULT_KEYS.has(key))
    || value.host !== host
    || value.ok !== true
    || typeof value.orderId !== 'string'
    || value.orderId.length === 0
  ) {
    throw new Error(`${labelFor(host)} host returned an invalid result`);
  }
  return value;
}

function observedResult(value, host, tools, elapsedMs) {
  validateResult(value, host);
  if (tools.length < 1) {
    throw new Error(`${labelFor(host)} host used no Fast Browser tools`);
  }
  return {
    ...value,
    browserCalls: tools.length,
    elapsedMs,
    tools,
  };
}

function assertKnownType(type, allowed) {
  if (!allowed.has(type)) {
    throw new Error('unsupported host event type');
  }
}

export function parseClaudeEvents(text, { elapsedMs = 0 } = {}) {
  const tools = [];
  let result = null;
  for (const { event, line } of parseEventLines(text)) {
    assertKnownType(event.type, CLAUDE_EVENT_TYPES);
    if (event.type === 'assistant' || event.type === 'user') {
      if (
        event.message === null
        || typeof event.message !== 'object'
        || !Array.isArray(event.message.content)
      ) {
        throw eventError(line, 'has an invalid Claude message');
      }
      for (const content of event.message.content) {
        if (
          content === null
          || typeof content !== 'object'
          || !CLAUDE_CONTENT_TYPES.has(content.type)
        ) {
          throw eventError(line, 'has an unsupported Claude content block');
        }
        if (content.type !== 'tool_use') continue;
        if (typeof content.name !== 'string') {
          throw eventError(line, 'has an invalid Claude tool event');
        }
        const normalized = content.name.toLowerCase().replaceAll('_', '-');
        if (normalized.includes('claude-in-chrome')) {
          throw new Error('Claude in Chrome tool use is forbidden');
        }
        const tool = finalToolSegment(content.name);
        if (tool?.startsWith('browser_')) {
          if (content.name !== `${CLAUDE_FAST_BROWSER_TOOL_PREFIX}${tool}`) {
            throw new Error(
              'Claude non-Fast Browser browser tool use is forbidden',
            );
          }
          tools.push(tool);
        }
      }
    }
    if (event.type === 'result') {
      if (result !== null) throw new Error('Claude host returned multiple results');
      if (event.is_error === true || event.subtype !== 'success') {
        throw new Error('Claude host reported an error');
      }
      result = structuredResult(event.structured_output ?? event.result, 'claude');
    }
  }
  if (result === null) throw new Error('Claude host did not return a result');
  return observedResult(result, 'claude', tools, elapsedMs);
}

function codexItem(event, line) {
  if (
    event.item === null
    || typeof event.item !== 'object'
    || Array.isArray(event.item)
    || typeof event.item.type !== 'string'
  ) {
    throw eventError(line, 'has an invalid Codex item');
  }
  return event.item;
}

function forbiddenCodexTool(item) {
  const identity = [
    item.type,
    item.name,
    item.server,
    item.tool,
  ].filter((value) => typeof value === 'string').join(' ').toLowerCase();
  return (
    identity.includes('browser-use')
    || identity.includes('browser_use')
    || identity.includes('computer-use')
    || identity.includes('computer_use')
    || identity.includes('computer tool')
  );
}

function forbiddenCodexSideChannel(item) {
  return (
    item.type === 'command_execution'
    && typeof item.command === 'string'
    && (
      item.command.includes('fast-browser-mcp')
      || item.command.includes('@modelcontextprotocol')
    )
  );
}

export function parseCodexEvents(text, { elapsedMs = 0 } = {}) {
  const tools = [];
  // Codex emits multiple agent_message items (preamble prose, then the
  // final message); only the last completed one is the result candidate.
  // Earlier ones are validated as strings but never JSON-parsed.
  let lastAgentMessageText = null;
  let completed = false;
  for (const { event, line } of parseEventLines(text)) {
    assertKnownType(event.type, CODEX_EVENT_TYPES);
    if (event.type === 'error' || event.type === 'turn.failed') {
      throw new Error('Codex host reported an error');
    }
    if (event.type === 'turn.completed') completed = true;
    if (
      event.type !== 'item.started'
      && event.type !== 'item.updated'
      && event.type !== 'item.completed'
    ) continue;
    const item = codexItem(event, line);
    if (forbiddenCodexTool(item)) {
      throw new Error('Codex browser-use and computer-use tools are forbidden');
    }
    if (forbiddenCodexSideChannel(item)) {
      throw new Error('Codex side-channel browser use is forbidden');
    }
    if (!CODEX_ITEM_TYPES.has(item.type)) {
      throw eventError(line, 'has an unsupported Codex item type');
    }
    if (
      item.type === 'mcp_tool_call'
      && typeof item.tool === 'string'
      && item.tool.startsWith('browser_')
      && item.server !== 'fast_browser'
    ) {
      throw new Error(
        'Codex non-Fast Browser browser tool use is forbidden',
      );
    }
    if (event.type !== 'item.completed') continue;
    if (item.type === 'mcp_tool_call') {
      if (
        typeof item.server !== 'string'
        || typeof item.tool !== 'string'
        || item.status !== 'completed'
      ) {
        throw eventError(line, 'has an invalid Codex MCP tool event');
      }
      if (
        item.server === 'fast_browser'
        && item.tool.startsWith('browser_')
      ) {
        tools.push(item.tool);
      }
    }
    if (item.type === 'agent_message') {
      if (typeof item.text !== 'string') {
        throw eventError(line, 'has an invalid Codex agent message');
      }
      lastAgentMessageText = item.text;
    }
  }
  if (!completed) throw new Error('Codex host did not complete its turn');
  if (lastAgentMessageText === null) throw new Error('Codex host did not return a result');
  const result = structuredResult(lastAgentMessageText, 'codex');
  return observedResult(result, 'codex', tools, elapsedMs);
}

export function buildClaudeCommand({ pluginRoot, prompt }) {
  return {
    command: 'claude',
    args: [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', 'sonnet',
      '--effort', 'medium',
      '--permission-mode', 'auto',
      '--no-chrome',
      '--no-session-persistence',
      '--plugin-dir', pluginRoot,
      '--max-budget-usd', '1.00',
      prompt,
    ],
  };
}

export function buildCodexCommand({ cwd, prompt }) {
  return {
    command: 'codex',
    args: [
      'exec',
      '--json',
      '--ephemeral',
      '--sandbox', 'read-only',
      '--cd', cwd,
      prompt,
    ],
  };
}

export function runHostProcess({
  host,
  command,
  args,
  cwd,
  timeoutMs = HOST_TIMEOUT_MS,
  spawnImpl = spawn,
}) {
  const label = labelFor(host);
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    let child;
    try {
      child = spawnImpl(command, args, {
        cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      reject(new Error(`${label} host failed to start`));
      return;
    }
    let stdout = '';
    let stderrBytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
    };
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error(`${label} host timed out after ${timeoutMs}ms`));
      const forceKill = setTimeout(() => child.kill('SIGKILL'), 1_000);
      forceKill.unref?.();
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
        child.kill('SIGTERM');
        finish(new Error(`${label} host output exceeded the limit`));
      }
    });
    child.stderr?.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_OUTPUT_BYTES) {
        child.kill('SIGTERM');
        finish(new Error(`${label} host output exceeded the limit`));
      }
    });
    child.once('error', () => finish(new Error(`${label} host failed to start`)));
    child.once('close', (code, signal) => {
      if (code !== 0) {
        finish(new Error(
          `${label} host exited unsuccessfully`
          + (signal ? ` (${signal})` : ''),
        ));
        return;
      }
      finish(null, {
        stdout,
        elapsedMs: Math.round(performance.now() - startedAt),
      });
    });
  });
}

function requireAbsoluteDirectory(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute path`);
  }
}

function requireLocalOrigin(origin) {
  if (
    typeof origin !== 'string'
    || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)
  ) {
    throw new TypeError('origin must be a loopback HTTP origin');
  }
}

async function promptFor(host, origin) {
  const promptPath = fileURLToPath(new URL(`../prompts/${host}.txt`, import.meta.url));
  return (await readFile(promptPath, 'utf8')).replaceAll('{{ORIGIN}}', origin);
}

export async function runClaudeHost({
  origin,
  pluginRoot,
  cwd,
  timeoutMs = HOST_TIMEOUT_MS,
  spawnImpl = spawn,
}) {
  requireLocalOrigin(origin);
  requireAbsoluteDirectory(pluginRoot, 'pluginRoot');
  requireAbsoluteDirectory(cwd, 'cwd');
  const prompt = await promptFor('claude', origin);
  const command = buildClaudeCommand({ pluginRoot, prompt });
  const processResult = await runHostProcess({
    host: 'claude',
    ...command,
    cwd,
    timeoutMs,
    spawnImpl,
  });
  return parseClaudeEvents(processResult.stdout, {
    elapsedMs: processResult.elapsedMs,
  });
}

export async function runCodexHost({
  origin,
  cwd,
  timeoutMs = HOST_TIMEOUT_MS,
  spawnImpl = spawn,
}) {
  requireLocalOrigin(origin);
  requireAbsoluteDirectory(cwd, 'cwd');
  const prompt = await promptFor('codex', origin);
  const command = buildCodexCommand({ cwd, prompt });
  const processResult = await runHostProcess({
    host: 'codex',
    ...command,
    cwd,
    timeoutMs,
    spawnImpl,
  });
  return parseCodexEvents(processResult.stdout, {
    elapsedMs: processResult.elapsedMs,
  });
}
