import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
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

// `trailingAfterFence` lets tests probe stray whitespace/newlines a model
// may emit after the closing fence (real hosts do this inconsistently).
function claudeFinalResultFenced(value, trailingAfterFence = '') {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: `\`\`\`json\n${JSON.stringify(value)}\n\`\`\`${trailingAfterFence}`,
  });
}

function claudeEventsWithFinalResult(resultValue, { toolCount = 1 } = {}) {
  const toolEvents = Array.from({ length: toolCount }, (_, index) => claudeToolUse(
    'mcp__plugin_fast-browser_fast-browser__browser_navigate',
    { url: `http://127.0.0.1:43111/${index}` },
  ));
  return [...toolEvents, claudeFinalResult(resultValue)].join('\n');
}

// Live host runs are flaky (real model variance in browser call counts). This
// wraps a run and its assertions so a single bad attempt doesn't fail the
// suite: the first failure is only logged as a diagnostic, and the second
// attempt's outcome (success or failure) is authoritative. Non-live parser
// tests never go through this.
async function withOneRetry(label, fn) {
  try {
    return await fn();
  } catch (firstError) {
    console.error(
      `[live-retry] ${label} failed on the first attempt, retrying once: ${firstError.message}`,
    );
    return await fn();
  }
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

test('Claude parser strips a trailing newline after the closing result fence', () => {
  const events = [
    claudeToolUse(
      'mcp__plugin_fast-browser_fast-browser__browser_navigate',
      { url: 'http://127.0.0.1:43111' },
    ),
    claudeFinalResultFenced(
      { host: 'claude', ok: true, orderId: 'CLAUDE-TRAILING-NL' },
      '\n',
    ),
  ].join('\n');

  assert.deepEqual(parseClaudeEvents(events, { elapsedMs: 3 }), {
    host: 'claude',
    ok: true,
    orderId: 'CLAUDE-TRAILING-NL',
    browserCalls: 1,
    elapsedMs: 3,
    tools: ['browser_navigate'],
  });
});

test('Claude parser strips a whitespace-only line after the closing result fence', () => {
  const events = [
    claudeToolUse(
      'mcp__plugin_fast-browser_fast-browser__browser_navigate',
      { url: 'http://127.0.0.1:43111' },
    ),
    claudeFinalResultFenced(
      { host: 'claude', ok: true, orderId: 'CLAUDE-TRAILING-WS' },
      '\n   \n',
    ),
  ].join('\n');

  assert.deepEqual(parseClaudeEvents(events, { elapsedMs: 3 }), {
    host: 'claude',
    ok: true,
    orderId: 'CLAUDE-TRAILING-WS',
    browserCalls: 1,
    elapsedMs: 3,
    tools: ['browser_navigate'],
  });
});

test('Claude parser extracts the JSON object when prose surrounds it', () => {
  const events = [
    claudeToolUse(
      'mcp__plugin_fast-browser_fast-browser__browser_navigate',
      { url: 'http://127.0.0.1:43111' },
    ),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: `Here is the result you asked for: ${JSON.stringify({
        host: 'claude',
        ok: true,
        orderId: 'CLAUDE-PROSE',
      })}. Let me know if you need anything else.`,
    }),
  ].join('\n');

  assert.deepEqual(parseClaudeEvents(events, { elapsedMs: 4 }), {
    host: 'claude',
    ok: true,
    orderId: 'CLAUDE-PROSE',
    browserCalls: 1,
    elapsedMs: 4,
    tools: ['browser_navigate'],
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

test('Claude parser tolerates unknown top-level events and content types while still counting tools', () => {
  const events = [
    JSON.stringify({ type: 'future_top_level_event', anything: 'ignored' }),
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'future_content_block', anything: 'ignored' },
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'mcp__plugin_fast-browser_fast-browser__browser_navigate',
            input: { url: 'http://127.0.0.1:43111' },
          },
        ],
      },
    }),
    claudeFinalResult({ host: 'claude', ok: true, orderId: 'CLAUDE-TOLERANT' }),
  ].join('\n');

  assert.deepEqual(parseClaudeEvents(events, { elapsedMs: 9 }), {
    host: 'claude',
    ok: true,
    orderId: 'CLAUDE-TOLERANT',
    browserCalls: 1,
    elapsedMs: 9,
    tools: ['browser_navigate'],
  });
});

test('Claude parser still rejects a forbidden tool when an unknown content type appears alongside it', () => {
  const events = [
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'future_content_block', anything: 'ignored' },
          {
            type: 'tool_use',
            id: 'wrong-namespace',
            name: 'mcp__fast_browser__browser_navigate',
            input: { url: 'http://127.0.0.1:43111' },
          },
        ],
      },
    }),
    claudeFinalResult({ host: 'claude', ok: true, orderId: 'CLAUDE-TEAM-5' }),
  ].join('\n');

  assert.throws(
    () => parseClaudeEvents(events, { elapsedMs: 1 }),
    { message: 'Claude non-Fast Browser browser tool use is forbidden' },
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

test('Codex parser tolerates an unknown item type while still parsing the rest of the run', () => {
  const events = [
    JSON.stringify({ type: 'thread.started', thread_id: 'synthetic-codex-thread' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'future-item', type: 'future_codex_item', status: 'completed' },
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
        id: 'item-final',
        type: 'agent_message',
        text: JSON.stringify({
          host: 'codex',
          ok: true,
          orderId: 'CODEX-TOLERANT',
        }),
      },
    }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n');

  assert.deepEqual(parseCodexEvents(events, { elapsedMs: 12 }), {
    host: 'codex',
    ok: true,
    orderId: 'CODEX-TOLERANT',
    browserCalls: 1,
    elapsedMs: 12,
    tools: ['browser_navigate'],
  });
});

test('Codex parser still rejects a side-channel command_execution among unknown item types', () => {
  const events = [
    JSON.stringify({ type: 'thread.started', thread_id: 'synthetic-codex-thread' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'future-item-1', type: 'future_codex_item_a', status: 'completed' },
    }),
    JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item-side-channel',
        type: 'command_execution',
        command: 'node --input-type=module -e "spawn fast-browser-mcp.mjs directly"',
        status: 'completed',
      },
    }),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'future-item-2', type: 'future_codex_item_b', status: 'completed' },
    }),
  ].join('\n');

  assert.throws(
    () => parseCodexEvents(events, { elapsedMs: 1 }),
    { message: 'Codex side-channel browser use is forbidden' },
  );
});

test('Codex parser tolerates an unknown top-level event type while still parsing the rest of the run', () => {
  const events = [
    JSON.stringify({ type: 'thread.started', thread_id: 'synthetic-codex-thread' }),
    JSON.stringify({ type: 'session.metadata', model: 'gpt-5-codex', anything: 'ignored' }),
    JSON.stringify({ type: 'turn.started' }),
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
        id: 'item-final',
        type: 'agent_message',
        text: JSON.stringify({
          host: 'codex',
          ok: true,
          orderId: 'CODEX-ENVELOPE-TOLERANT',
        }),
      },
    }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n');

  assert.deepEqual(parseCodexEvents(events, { elapsedMs: 15 }), {
    host: 'codex',
    ok: true,
    orderId: 'CODEX-ENVELOPE-TOLERANT',
    browserCalls: 1,
    elapsedMs: 15,
    tools: ['browser_navigate'],
  });
});

test('Codex parser does not fabricate completion from a signal buried inside an unknown event type', () => {
  // The only "completion-looking" data in this stream lives inside a
  // session.metadata event's own fields, never as a real top-level
  // turn.completed event. Tolerating unknown event types must not scan
  // their payloads for anything resembling completion.
  const events = [
    JSON.stringify({ type: 'thread.started', thread_id: 'synthetic-codex-thread' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({
      type: 'session.metadata',
      turn: { completed: true },
      status: 'turn.completed',
    }),
    JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item-final',
        type: 'agent_message',
        text: JSON.stringify({
          host: 'codex',
          ok: true,
          orderId: 'CODEX-NEVER-COMPLETES',
        }),
      },
    }),
  ].join('\n');

  assert.throws(
    () => parseCodexEvents(events, { elapsedMs: 1 }),
    { message: 'Codex host did not complete its turn' },
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

test('Codex parser tolerates an unknown top-level event type without leaking its content', () => {
  // Codex's outer event-type envelope is now tolerant, symmetric with
  // Claude's; a stream containing only a hostile unknown event still fails
  // for an unrelated, fixed reason, never echoing the hostile input.
  const secret = 'sk-hostile-event-type';
  assert.throws(
    () => parseCodexEvents(JSON.stringify({
      type: `future.tool.event.${secret}`,
    }), { elapsedMs: 1 }),
    (error) => {
      assert.equal(error.message, 'Codex host did not complete its turn');
      assert.doesNotMatch(error.message, /sk-hostile/);
      return true;
    },
  );
});

test('Claude parser tolerates an unknown top-level event type without leaking its content', () => {
  // Claude's outer event-type envelope is now tolerant (host stream drift);
  // a stream containing nothing else still fails for an unrelated, fixed
  // reason, never echoing the hostile input.
  const secret = 'sk-hostile-event-type';
  assert.throws(
    () => parseClaudeEvents(JSON.stringify({
      type: `future.tool.event.${secret}`,
    }), { elapsedMs: 1 }),
    (error) => {
      assert.equal(error.message, 'Claude host did not return a result');
      assert.doesNotMatch(error.message, /sk-hostile/);
      return true;
    },
  );
});

test('Codex parser tolerates an unknown item type without leaking its content', () => {
  // Codex's inner item types are now tolerant (host stream drift); a stream
  // containing only a hostile unknown item still fails for an unrelated,
  // fixed reason, never echoing the hostile input.
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
      assert.equal(error.message, 'Codex host did not complete its turn');
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

test('runClaudeHost writes host evidence to the OS tmpdir on a parse failure', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  const spawnImpl = () => child;

  const originalConsoleError = console.error;
  const logs = [];
  console.error = (...args) => {
    logs.push(args.join(' '));
  };

  // Not valid JSON at all, so this fails inside parseEventLines regardless
  // of any envelope-tolerance behavior; the exact error message is not the
  // point of this test, only that the raw stream gets persisted.
  const invalidStream = 'not-json-at-all\n';
  let evidencePath;
  try {
    // runClaudeHost awaits a real file read (the prompt template) before
    // runHostProcess attaches its 'close' listener; emitting synchronously
    // would race and drop the event. Wait for the listener to actually be
    // attached first.
    const closeListenerAttached = new Promise((resolve) => {
      child.on('newListener', function onNewListener(eventName) {
        if (eventName !== 'close') return;
        child.off('newListener', onNewListener);
        resolve();
      });
    });

    const pending = runClaudeHost({
      origin: 'http://127.0.0.1:43111',
      pluginRoot,
      cwd,
      spawnImpl,
    });
    await closeListenerAttached;
    child.stdout.write(invalidStream);
    child.emit('close', 0, null);

    await assert.rejects(pending, /is not valid JSON/);

    const evidenceLog = logs.find((line) => line.startsWith('[host-evidence] '));
    assert.ok(evidenceLog, 'expected a [host-evidence] log line');
    evidencePath = evidenceLog.slice('[host-evidence] '.length);
    assert.ok(evidencePath.startsWith(os.tmpdir()));
    // A fixed per-host filename (overwritten each run) caps accumulation,
    // rather than an unbounded epoch-timestamped file per failure.
    assert.equal(path.basename(evidencePath), 'fast-browser-host-claude-latest.jsonl');

    const contents = await readFile(evidencePath, 'utf8');
    assert.equal(contents, invalidStream);
  } finally {
    console.error = originalConsoleError;
    if (evidencePath) await rm(evidencePath, { force: true });
  }
});

test('withOneRetry returns the first attempt result without retrying on success', async () => {
  let calls = 0;
  const result = await withOneRetry('synthetic', async () => {
    calls += 1;
    return 'first-result';
  });
  assert.equal(result, 'first-result');
  assert.equal(calls, 1);
});

test('withOneRetry retries once after a failure and returns the second attempt result', async () => {
  let calls = 0;
  const result = await withOneRetry('synthetic', async () => {
    calls += 1;
    if (calls === 1) throw new Error('synthetic first failure');
    return 'second-result';
  });
  assert.equal(result, 'second-result');
  assert.equal(calls, 2);
});

test('withOneRetry rethrows the second failure when both attempts fail', async () => {
  let calls = 0;
  await assert.rejects(
    () => withOneRetry('synthetic', async () => {
      calls += 1;
      throw new Error(`synthetic failure ${calls}`);
    }),
    { message: 'synthetic failure 2' },
  );
  assert.equal(calls, 2);
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
  await withOneRetry('Claude Code completes the Fast Browser flow', async () => {
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
});

test('Codex completes the Fast Browser flow', {
  skip: !live,
  timeout: 1_260_000,
}, async (t) => {
  await withOneRetry('Codex completes the Fast Browser flow', async () => {
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
});
