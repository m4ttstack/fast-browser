import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { startOrderFixture } from '../fixtures/order-flow/server.mjs';
import {
  buildClaudeCommand,
  buildCodexCommand,
  parseClaudeEvents,
  parseCodexEvents,
  runClaudeHost,
  runCodexHost,
  runHostProcess,
} from './helpers/host-runner.mjs';

const pluginRoot = fileURLToPath(new URL('../../', import.meta.url));
const cwd = path.resolve(pluginRoot, '../..');
const live = process.env.FAST_BROWSER_LIVE_E2E === '1';

function claudeToolUse(name, input = {}) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [{
        type: 'tool_use',
        id: `tool-${name}`,
        name,
        input,
      }],
    },
  });
}

function claudeFinalResult(value) {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: JSON.stringify(value),
  });
}

function claudeEventsWithFinalResult(resultValue, { toolCount = 1 } = {}) {
  const toolEvents = Array.from({ length: toolCount }, (_, index) => claudeToolUse(
    'mcp__plugin_fast-browser_fast-browser__browser_navigate',
    { url: `http://127.0.0.1:43111/${index}` },
  ));
  return [...toolEvents, claudeFinalResult(resultValue)].join('\n');
}

// Real Claude Code events observed live: the final `result` field arrives as a
// STRING wrapped in a markdown code fence, and a benign ToolSearch tool_use
// appears alongside the real namespaced Fast Browser tool_use events.
const CLAUDE_SUCCESS = [
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: 'synthetic-claude-session',
  }),
  claudeToolUse('ToolSearch', { query: 'select:browser_navigate' }),
  claudeToolUse(
    'mcp__plugin_fast-browser_fast-browser__browser_navigate',
    { url: 'http://127.0.0.1:43111' },
  ),
  claudeToolUse('mcp__plugin_fast-browser_fast-browser__browser_snapshot'),
  claudeToolUse(
    'mcp__plugin_fast-browser_fast-browser__browser_run_code_unsafe',
    { code: 'async page => ({ orderId: await page.title() })' },
  ),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: [
      '```json',
      JSON.stringify({
        host: 'claude',
        ok: true,
        orderId: 'CLAUDE-TEAM-5',
      }, null, 2),
      '```',
    ].join('\n'),
  }),
].join('\n');

// Real Codex events observed live: multiple agent_message items appear
// (preamble prose, then the final pure-JSON message), and a collab_tool_call
// item type appears alongside the whitelisted item types.
const CODEX_SUCCESS = [
  JSON.stringify({ type: 'thread.started', thread_id: 'synthetic-codex-thread' }),
  JSON.stringify({ type: 'turn.started' }),
  JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'item-preamble',
      type: 'agent_message',
      text: 'Navigating to the order form now.',
    },
  }),
  JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'item-1',
      type: 'mcp_tool_call',
      server: 'fast_browser',
      tool: 'browser_navigate',
      status: 'completed',
    },
  }),
  JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'item-2',
      type: 'mcp_tool_call',
      server: 'fast_browser',
      tool: 'browser_snapshot',
      status: 'completed',
    },
  }),
  JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'item-collab',
      type: 'collab_tool_call',
      name: 'plan_update',
      status: 'completed',
    },
  }),
  JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'item-3',
      type: 'mcp_tool_call',
      server: 'fast_browser',
      tool: 'browser_run_code_unsafe',
      status: 'completed',
    },
  }),
  JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'item-final',
      type: 'agent_message',
      text: JSON.stringify({
        host: 'codex',
        ok: true,
        orderId: 'CODEX-TEAM-5',
      }),
    },
  }),
  JSON.stringify({
    type: 'turn.completed',
    usage: {
      input_tokens: 100,
      cached_input_tokens: 0,
      output_tokens: 50,
    },
  }),
].join('\n');

test('Claude parser returns the model result with observed Fast Browser metrics', () => {
  assert.deepEqual(parseClaudeEvents(CLAUDE_SUCCESS, { elapsedMs: 4321 }), {
    host: 'claude',
    ok: true,
    orderId: 'CLAUDE-TEAM-5',
    browserCalls: 3,
    elapsedMs: 4321,
    tools: [
      'browser_navigate',
      'browser_snapshot',
      'browser_run_code_unsafe',
    ],
  });
});

test('Codex parser returns the model result with observed Fast Browser metrics', () => {
  assert.deepEqual(parseCodexEvents(CODEX_SUCCESS, { elapsedMs: 5432 }), {
    host: 'codex',
    ok: true,
    orderId: 'CODEX-TEAM-5',
    browserCalls: 3,
    elapsedMs: 5432,
    tools: [
      'browser_navigate',
      'browser_snapshot',
      'browser_run_code_unsafe',
    ],
  });
});

test('Claude parser accepts a minimal three-key model result', () => {
  const parsed = parseClaudeEvents(
    claudeEventsWithFinalResult({ host: 'claude', ok: true, orderId: 'CLAUDE-MIN-1' }),
    { elapsedMs: 7 },
  );
  assert.deepEqual(parsed, {
    host: 'claude',
    ok: true,
    orderId: 'CLAUDE-MIN-1',
    browserCalls: 1,
    elapsedMs: 7,
    tools: ['browser_navigate'],
  });
});

test('Claude parser rejects a model result with an unknown extra key', () => {
  assert.throws(
    () => parseClaudeEvents(
      claudeEventsWithFinalResult({
        host: 'claude',
        ok: true,
        orderId: 'CLAUDE-MIN-1',
        note: 'unexpected',
      }),
      { elapsedMs: 1 },
    ),
    { message: 'Claude host returned an invalid result' },
  );
});

test('Claude parser throws when no Fast Browser tool calls were observed', () => {
  const events = claudeFinalResult({
    host: 'claude',
    ok: true,
    orderId: 'CLAUDE-NO-TOOLS',
  });

  assert.throws(
    () => parseClaudeEvents(events, { elapsedMs: 1 }),
    { message: 'Claude host used no Fast Browser tools' },
  );
});

test('Codex parser throws when no Fast Browser tool calls were observed', () => {
  const events = [
    JSON.stringify({ type: 'thread.started', thread_id: 'synthetic-codex-thread' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item-final',
        type: 'agent_message',
        text: JSON.stringify({
          host: 'codex',
          ok: true,
          orderId: 'CODEX-NO-TOOLS',
        }),
      },
    }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n');

  assert.throws(
    () => parseCodexEvents(events, { elapsedMs: 1 }),
    { message: 'Codex host used no Fast Browser tools' },
  );
});

test('Codex parser rejects side-channel Fast Browser MCP server spawning', () => {
  const forbiddenCommands = [
    'node --input-type=module -e "spawn fast-browser-mcp.mjs directly"',
    'node -e "import(\'@modelcontextprotocol/sdk/client/index.js\')"',
  ];
  for (const command of forbiddenCommands) {
    for (const type of ['item.started', 'item.updated', 'item.completed']) {
      const events = JSON.stringify({
        type,
        item: {
          id: 'item-side-channel',
          type: 'command_execution',
          command,
          status: 'completed',
        },
      });
      assert.throws(
        () => parseCodexEvents(events, { elapsedMs: 1 }),
        { message: 'Codex side-channel browser use is forbidden' },
      );
    }
  }
});

test('Claude parser rejects Claude in Chrome tool use', () => {
  const events = [
    claudeToolUse('mcp__claude-in-chrome__navigate'),
    claudeFinalResult({ host: 'claude', ok: true, orderId: 'CLAUDE-TEAM-5' }),
  ].join('\n');

  assert.throws(
    () => parseClaudeEvents(events, { elapsedMs: 1 }),
    /Claude in Chrome tool use is forbidden/,
  );
});

test('Claude parser rejects browser tools from a non-Fast Browser MCP server', () => {
  // The old expected namespace `mcp__fast_browser__<tool>` is not the real
  // Claude Code tool identity and must remain forbidden.
  const events = [
    claudeToolUse(
      'mcp__fast_browser__browser_navigate',
      { url: 'http://127.0.0.1:43111' },
    ),
    claudeFinalResult({ host: 'claude', ok: true, orderId: 'CLAUDE-TEAM-5' }),
  ].join('\n');

  assert.throws(
    () => parseClaudeEvents(events, { elapsedMs: 1 }),
    {
      message: 'Claude non-Fast Browser browser tool use is forbidden',
    },
  );
});

test('Codex parser rejects browser-use and computer-use tool events', () => {
  const cases = [
    {
      type: 'item.completed',
      item: {
        id: 'wrong-browser',
        type: 'mcp_tool_call',
        server: 'browser-use',
        tool: 'browser_navigate',
        status: 'completed',
      },
    },
    {
      type: 'item.completed',
      item: {
        id: 'wrong-computer',
        type: 'computer_use',
        status: 'completed',
      },
    },
  ];

  for (const event of cases) {
    assert.throws(
      () => parseCodexEvents(JSON.stringify(event), { elapsedMs: 1 }),
      /browser-use and computer-use tools are forbidden/,
    );
  }
});

test('Codex parser rejects browser tools from a non-Fast Browser MCP server', () => {
  const events = [
    JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'wrong-browser-server',
        type: 'mcp_tool_call',
        server: 'playwright',
        tool: 'browser_snapshot',
        status: 'completed',
      },
    }),
    JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'final-message',
        type: 'agent_message',
        text: JSON.stringify({
          host: 'codex',
          ok: true,
          orderId: 'CODEX-TEAM-5',
        }),
      },
    }),
    JSON.stringify({
      type: 'turn.completed',
      usage: {
        input_tokens: 10,
        cached_input_tokens: 0,
        output_tokens: 10,
      },
    }),
  ].join('\n');

  assert.throws(
    () => parseCodexEvents(events, { elapsedMs: 1 }),
    {
      message: 'Codex non-Fast Browser browser tool use is forbidden',
    },
  );
});

test('host parsers reject malformed JSON without echoing its contents', () => {
  const secret = 'sk-synthetic-do-not-echo';
  for (const parse of [parseClaudeEvents, parseCodexEvents]) {
    assert.throws(
      () => parse(`{"type":"result","secret":"${secret}"`, { elapsedMs: 1 }),
      (error) => {
        assert.equal(error.message, 'host event line 1 is not valid JSON');
        assert.doesNotMatch(error.message, /sk-synthetic/);
        return true;
      },
    );
  }
});

test('host parsers redact hostile unknown event types', () => {
  const secret = 'sk-hostile-event-type';
  for (const parse of [parseClaudeEvents, parseCodexEvents]) {
    assert.throws(
      () => parse(JSON.stringify({
        type: `future.tool.event.${secret}`,
      }), { elapsedMs: 1 }),
      (error) => {
        assert.equal(error.message, 'unsupported host event type');
        assert.doesNotMatch(error.message, /sk-hostile/);
        return true;
      },
    );
  }
});

test('Codex parser redacts hostile unknown item types', () => {
  const secret = 'sk-hostile-item-type';
  assert.throws(
    () => parseCodexEvents(JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'hostile-item',
        type: `future_tool_${secret}`,
        status: 'completed',
      },
    }), { elapsedMs: 1 }),
    (error) => {
      assert.equal(
        error.message,
        'host event line 1 has an unsupported Codex item type',
      );
      assert.doesNotMatch(error.message, /sk-hostile/);
      return true;
    },
  );
});

test('host parsers reject host error events', () => {
  assert.throws(
    () => parseClaudeEvents(JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'synthetic failure',
    }), { elapsedMs: 1 }),
    /Claude host reported an error/,
  );
  assert.throws(
    () => parseCodexEvents(JSON.stringify({
      type: 'turn.failed',
      error: { message: 'synthetic failure' },
    }), { elapsedMs: 1 }),
    /Codex host reported an error/,
  );
});

test('host command builders emit the verified non-bypass flags', () => {
  assert.deepEqual(
    buildClaudeCommand({
      pluginRoot: '/tmp/plugin',
      prompt: 'synthetic prompt',
    }),
    {
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
        '--plugin-dir', '/tmp/plugin',
        '--max-budget-usd', '1.00',
        'synthetic prompt',
      ],
    },
  );
  assert.deepEqual(
    buildCodexCommand({
      cwd: '/tmp/workspace',
      prompt: 'synthetic prompt',
    }),
    {
      command: 'codex',
      args: [
        'exec',
        '--json',
        '--ephemeral',
        '--sandbox', 'read-only',
        '--cd', '/tmp/workspace',
        'synthetic prompt',
      ],
    },
  );
});

test('host process uses no shell and terminates on timeout', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let spawnCall;
  let killedWith;
  child.kill = (signal) => {
    killedWith = signal;
    queueMicrotask(() => child.emit('exit', null, signal));
    return true;
  };
  const spawnImpl = (command, args, options) => {
    spawnCall = { command, args, options };
    return child;
  };

  await assert.rejects(
    runHostProcess({
      host: 'codex',
      command: 'codex',
      args: ['exec'],
      cwd: '/tmp/workspace',
      timeoutMs: 10,
      spawnImpl,
    }),
    /Codex host timed out after 10ms/,
  );
  assert.equal(killedWith, 'SIGTERM');
  assert.deepEqual(spawnCall, {
    command: 'codex',
    args: ['exec'],
    options: {
      cwd: '/tmp/workspace',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  });
});

test('host process waits for final stdout after exit until streams close', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;

  const pending = runHostProcess({
    host: 'claude',
    command: 'claude',
    args: ['-p'],
    cwd: '/tmp/workspace',
    spawnImpl: () => child,
  });
  child.emit('exit', 0, null);
  child.stdout.write('final JSONL line\n');
  child.emit('close', 0, null);

  assert.equal((await pending).stdout, 'final JSONL line\n');
});

test(
  'order fixture close() resolves quickly despite a held-open keep-alive connection',
  { timeout: 5_000 },
  async () => {
    const fixture = await startOrderFixture();
    const url = new URL(fixture.origin);
    const socket = net.connect(Number(url.port), url.hostname);
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    // A connected-but-idle socket, the way Chrome leaves one behind for a
    // live tab, must not block close(). If it does, force it closed after a
    // bounded wait so this test fails fast instead of hanging the suite.
    const startedAt = performance.now();
    const closed = fixture.close();
    const forceUnblock = setTimeout(() => socket.destroy(), 3_000);
    await closed;
    clearTimeout(forceUnblock);
    const elapsedMs = performance.now() - startedAt;
    socket.destroy();
    assert.ok(
      elapsedMs < 1_000,
      `expected close() to resolve under 1000ms, took ${elapsedMs}ms`,
    );
  },
);

test('Claude Code completes the Fast Browser flow', {
  skip: !live,
  timeout: 660_000,
}, async (t) => {
  const fixture = await startOrderFixture();
  t.after(fixture.close);
  const result = await runClaudeHost({
    origin: fixture.origin,
    pluginRoot,
    cwd,
  });
  assert.equal(result.ok, true);
  assert.equal(result.orderId, 'CLAUDE-TEAM-5');
  assert.ok(result.browserCalls <= 8);
});

test('Codex completes the Fast Browser flow', {
  skip: !live,
  timeout: 660_000,
}, async (t) => {
  const fixture = await startOrderFixture();
  t.after(fixture.close);
  const result = await runCodexHost({
    origin: fixture.origin,
    cwd,
  });
  assert.equal(result.ok, true);
  assert.equal(result.orderId, 'CODEX-TEAM-5');
  assert.ok(result.browserCalls <= 8);
});
