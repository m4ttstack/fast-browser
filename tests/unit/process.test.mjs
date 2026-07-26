import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { createProcessRunner, run } from '../../lib/core/process.mjs';

const CAPTURE_LIMIT = 1024 * 1024;
const TRUNCATION_MARKER = '\n[output truncated at 1048576 bytes]\n';

test('returns the command result without throwing for a nonzero exit', async () => {
  const result = await run(process.execPath, [
    '-e',
    "process.stdout.write('visible'); process.stderr.write('diagnostic'); process.exit(7)",
  ], {
    env: {
      ...process.env,
      FAST_BROWSER_TEST_SECRET: 'must-not-appear',
    },
  });

  assert.deepEqual(result, {
    command: process.execPath,
    args: [
      '-e',
      "process.stdout.write('visible'); process.stderr.write('diagnostic'); process.exit(7)",
    ],
    exitCode: 7,
    stdout: 'visible',
    stderr: 'diagnostic',
  });
  assert.doesNotMatch(JSON.stringify(result), /must-not-appear/);
});

test('writes bounded explicit stdin without changing the process result contract', async () => {
  const result = await run(process.execPath, [
    '-e',
    "let text=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => text += c); process.stdin.on('end', () => process.stdout.write(text));",
  ], {
    input: '{"jsonrpc":"2.0"}\n',
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '{"jsonrpc":"2.0"}\n');
  assert.equal(result.stderr, '');
});

test('caps stdout and stderr independently and marks each truncation', async () => {
  const result = await run(process.execPath, [
    '-e',
    [
      `process.stdout.write('o'.repeat(${CAPTURE_LIMIT + 1000}));`,
      `process.stderr.write('e'.repeat(${CAPTURE_LIMIT + 1000}));`,
    ].join(''),
  ]);

  assert.equal(Buffer.byteLength(result.stdout), CAPTURE_LIMIT);
  assert.equal(Buffer.byteLength(result.stderr), CAPTURE_LIMIT);
  assert.ok(result.stdout.endsWith(TRUNCATION_MARKER));
  assert.ok(result.stderr.endsWith(TRUNCATION_MARKER));
  assert.equal(
    result.stdout.slice(0, -TRUNCATION_MARKER.length),
    'o'.repeat(CAPTURE_LIMIT - Buffer.byteLength(TRUNCATION_MARKER)),
  );
  assert.equal(
    result.stderr.slice(0, -TRUNCATION_MARKER.length),
    'e'.repeat(CAPTURE_LIMIT - Buffer.byteLength(TRUNCATION_MARKER)),
  );
});

test('keeps 2, 3, and 4-byte UTF-8 valid at both stream boundaries', async () => {
  const cases = [
    { character: 'é', prefix: '' },
    { character: '€', prefix: 'x' },
    { character: '😀', prefix: '' },
  ];

  for (const { character, prefix } of cases) {
    const result = await run(process.execPath, [
      '-e',
      [
        `const output = ${JSON.stringify(prefix)} + ${JSON.stringify(character)}.repeat(${CAPTURE_LIMIT});`,
        'process.stdout.write(output);',
        'process.stderr.write(output);',
      ].join(''),
    ]);

    for (const output of [result.stdout, result.stderr]) {
      assert.ok(output.endsWith(TRUNCATION_MARKER));
      assert.ok(Buffer.byteLength(output, 'utf8') <= CAPTURE_LIMIT);
      assert.doesNotMatch(output, /\uFFFD/);
    }
  }
});

test('bounds replacement text produced by invalid UTF-8 bytes', async () => {
  const result = await run(process.execPath, [
    '-e',
    [
      `const output = Buffer.alloc(${CAPTURE_LIMIT + 1000}, 0xff);`,
      'process.stdout.write(output);',
      'process.stderr.write(output);',
    ].join(''),
  ]);

  for (const output of [result.stdout, result.stderr]) {
    assert.ok(output.endsWith(TRUNCATION_MARKER));
    assert.ok(Buffer.byteLength(output, 'utf8') <= CAPTURE_LIMIT);
  }
});

test('reports a missing executable without exposing environment values', async () => {
  await assert.rejects(
    run('fast-browser-command-that-does-not-exist', [], {
      env: {
        ...process.env,
        FAST_BROWSER_TEST_SECRET: 'spawn-secret',
      },
    }),
    (error) => {
      assert.equal(error.code, 'ENOENT');
      assert.match(error.message, /unable to start fast-browser-command-that-does-not-exist/);
      assert.doesNotMatch(error.message, /spawn-secret/);
      assert.doesNotMatch(JSON.stringify(error), /spawn-secret/);
      return true;
    },
  );
});

test('terminates a timed-out child and returns no captured environment values', async () => {
  await assert.rejects(
    run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      env: {
        ...process.env,
        FAST_BROWSER_TEST_SECRET: 'timeout-secret',
      },
      timeoutMs: 25,
    }),
    (error) => {
      assert.equal(error.code, 'ETIMEDOUT');
      assert.match(error.message, /timed out after 25ms/);
      assert.doesNotMatch(error.message, /timeout-secret/);
      assert.doesNotMatch(JSON.stringify(error), /timeout-secret/);
      return true;
    },
  );
});

function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

test('settles on a fixed deadline and ignores late child events after group termination', async () => {
  const child = fakeChild();
  const signals = [];
  const fakeRun = createProcessRunner({
    spawnImplementation: () => child,
    killImplementation: (pid, signal) => signals.push([pid, signal]),
    forceKillMs: 5,
    finalSettlementMs: 15,
    platform: 'darwin',
  });

  await assert.rejects(
    fakeRun('synthetic-command', [], { timeoutMs: 1 }),
    {
      code: 'ETIMEDOUT',
      message: 'synthetic-command timed out after 1ms',
    },
  );
  assert.deepEqual(signals, [
    [-4242, 'SIGTERM'],
    [-4242, 'SIGKILL'],
    [-4242, 'SIGKILL'],
  ]);
  assert.doesNotThrow(() => {
    child.emit('error', new Error('late child diagnostic'));
    child.stdout.emit('error', new Error('late stdout diagnostic'));
    child.stderr.emit('error', new Error('late stderr diagnostic'));
    child.emit('close', 0, null);
  });
});

function stopRaceFixture() {
  const child = fakeChild();
  const destroyCalls = { stdout: 0, stderr: 0 };
  for (const streamName of ['stdout', 'stderr']) {
    const stream = child[streamName];
    const destroy = stream.destroy.bind(stream);
    stream.destroy = (...args) => {
      destroyCalls[streamName] += 1;
      return destroy(...args);
    };
  }
  const signals = [];
  const fakeRun = createProcessRunner({
    spawnImplementation: () => child,
    killImplementation: (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === 'SIGTERM') {
        queueMicrotask(() => {
          child.stdout.write('stdout during grace');
          child.stderr.write('stderr during grace');
          child.stdout.emit('error', new Error('grace stdout diagnostic'));
          child.stderr.emit('error', new Error('grace stderr diagnostic'));
          child.emit('error', Object.assign(new Error('grace child diagnostic'), {
            code: 'EGRACE',
          }));
        });
      }
    },
    forceKillMs: 5,
    finalSettlementMs: 15,
    platform: 'darwin',
  });
  return { child, destroyCalls, fakeRun, signals };
}

async function assertGraceErrorsPreserveStopReason({
  expected,
  start,
}) {
  const fixture = stopRaceFixture();
  const startedAt = Date.now();
  await assert.rejects(start(fixture.fakeRun), expected);
  assert.ok(Date.now() - startedAt < 100);
  assert.deepEqual(fixture.signals, [
    [-4242, 'SIGTERM'],
    [-4242, 'SIGKILL'],
    [-4242, 'SIGKILL'],
  ]);
  assert.deepEqual(fixture.destroyCalls, { stdout: 1, stderr: 1 });
  assert.doesNotThrow(() => {
    fixture.child.stdout.emit('error', new Error('late stdout diagnostic'));
    fixture.child.stderr.emit('error', new Error('late stderr diagnostic'));
    fixture.child.emit('error', new Error('late child diagnostic'));
  });
}

test('timeout reason survives child and stream errors during the grace window', {
  timeout: 1000,
}, async () => {
  await assertGraceErrorsPreserveStopReason({
    expected: {
      code: 'ETIMEDOUT',
      message: 'grace-command timed out after 1ms',
    },
    start: (fakeRun) => fakeRun('grace-command', [], { timeoutMs: 1 }),
  });
});

test('abort reason survives child and stream errors during the grace window', {
  timeout: 1000,
}, async () => {
  const controller = new AbortController();
  await assertGraceErrorsPreserveStopReason({
    expected: {
      code: 'ABORT_ERR',
      message: 'aborted while running grace-command',
    },
    start: (fakeRun) => {
      const promise = fakeRun('grace-command', [], { signal: controller.signal });
      controller.abort();
      return promise;
    },
  });
});

async function waitForPidFile(pidFile, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const value = JSON.parse(await readFile(pidFile, 'utf8'));
      if (
        Number.isInteger(value.groupPid)
        && value.groupPid > 0
        && Number.isInteger(value.descendantPid)
        && value.descendantPid > 0
      ) {
        return value;
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`synthetic process group was not ready after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForProcessTargetToDisappear(target, description, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      process.kill(target, 0);
      if (Date.now() >= deadline) {
        throw new Error(`${description} survived process-group abort`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
  }
}

test('abort kills a ready synthetic POSIX process group whose descendant retains stdio', {
  timeout: 10000,
}, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-process-group-'));
  const pidFile = path.join(temporaryRoot, 'descendant.pid');
  let groupPid;
  let descendantPid;
  t.after(async () => {
    if (groupPid) {
      try {
        process.kill(-groupPid, 'SIGKILL');
      } catch {
        // It was terminated by the abort path.
      }
    }
    if (descendantPid) {
      try {
        process.kill(descendantPid, 'SIGKILL');
      } catch {
        // It was terminated with its process group.
      }
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const descendant = [
    "process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1000);',
  ].join('');
  const parent = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}],`,
    "  { stdio: ['ignore', 'inherit', 'inherit'] });",
    'writeFileSync(process.argv[1], JSON.stringify({',
    '  groupPid: process.pid,',
    '  descendantPid: child.pid,',
    '}));',
    "process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1000);',
  ].join('');
  const controller = new AbortController();
  const startedAt = Date.now();

  const stopped = assert.rejects(
    run(process.execPath, ['-e', parent, pidFile], {
      signal: controller.signal,
      timeoutMs: 5000,
    }),
    { code: 'ABORT_ERR' },
  );
  try {
    ({ groupPid, descendantPid } = await waitForPidFile(pidFile, 3000));
    controller.abort();
    await stopped;
  } finally {
    controller.abort();
    await stopped.catch(() => {});
  }
  assert.ok(Date.now() - startedAt < 5000);

  await Promise.all([
    waitForProcessTargetToDisappear(
      descendantPid,
      `descendant ${descendantPid}`,
      1000,
    ),
    waitForProcessTargetToDisappear(
      -groupPid,
      `process group ${groupPid}`,
      1000,
    ),
  ]);
  groupPid = undefined;
  descendantPid = undefined;
});
