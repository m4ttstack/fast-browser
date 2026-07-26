import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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

const CLAUDE_SUCCESS = [
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: 'synthetic-claude-session',
  }),
  JSON.stringify({
    type: 'assistant',
    message: {
      content: [{
        type: 'tool_use',
        id: 'tool-1',
        name: 'mcp__fast_browser__browser_navigate',
        input: { url: 'http://127.0.0.1:43111' },
      }],
    },
  }),
  JSON.stringify({
    type: 'assistant',
    message: {
      content: [{
        type: 'tool_use',
        id: 'tool-2',
        name: 'mcp__fast_browser__browser_snapshot',
        input: {},
      }],
    },
  }),
  JSON.stringify({
    type: 'assistant',
    message: {
      content: [{
        type: 'tool_use',
        id: 'tool-3',
        name: 'mcp__fast_browser__browser_run_code_unsafe',
        input: { code: 'async page => ({ orderId: await page.title() })' },
      }],
    },
  }),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: JSON.stringify({
      host: 'claude',
      ok: true,
      orderId: 'CLAUDE-TEAM-5',
      browserCalls: 999,
      elapsedMs: 999,
      tools: [],
    }),
  }),
].join('\n');

const CODEX_SUCCESS = [
  JSON.stringify({ type: 'thread.started', thread_id: 'synthetic-codex-thread' }),
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
      id: 'item-4',
      type: 'agent_message',
      text: JSON.stringify({
        host: 'codex',
        ok: true,
        orderId: 'CODEX-TEAM-5',
        browserCalls: 999,
        elapsedMs: 999,
        tools: [],
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

test('Claude parser rejects Claude in Chrome tool use', () => {
  const events = [
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'wrong-tool',
          name: 'mcp__claude-in-chrome__navigate',
          input: {},
        }],
      },
    }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: JSON.stringify({
        host: 'claude',
        ok: true,
        orderId: 'CLAUDE-TEAM-5',
        browserCalls: 0,
        elapsedMs: 0,
        tools: [],
      }),
    }),
  ].join('\n');

  assert.throws(
    () => parseClaudeEvents(events, { elapsedMs: 1 }),
    /Claude in Chrome tool use is forbidden/,
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

test('host parsers fail closed on unknown event types', () => {
  for (const parse of [parseClaudeEvents, parseCodexEvents]) {
    assert.throws(
      () => parse('{"type":"future.tool.event"}', { elapsedMs: 1 }),
      /unsupported host event type: future\.tool\.event/,
    );
  }
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

test('Claude Code completes the Fast Browser flow', {
  skip: !live,
  timeout: 330_000,
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
  timeout: 330_000,
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
