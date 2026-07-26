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

test('timeout kills a synthetic POSIX process group whose descendant retains stdio', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-process-group-'));
  const pidFile = path.join(temporaryRoot, 'descendant.pid');
  let descendantPid;
  t.after(async () => {
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
    'writeFileSync(process.argv[1], String(child.pid));',
    "process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1000);',
  ].join('');
  const startedAt = Date.now();

  await assert.rejects(
    run(process.execPath, ['-e', parent, pidFile], { timeoutMs: 80 }),
    { code: 'ETIMEDOUT' },
  );
  assert.ok(Date.now() - startedAt < 1000);

  descendantPid = Number.parseInt(await readFile(pidFile, 'utf8'), 10);
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 500;
    const check = () => {
      try {
        process.kill(descendantPid, 0);
        if (Date.now() >= deadline) {
          reject(new Error(`descendant ${descendantPid} survived process-group timeout`));
          return;
        }
        setTimeout(check, 10);
      } catch (error) {
        if (error.code === 'ESRCH') resolve();
        else reject(error);
      }
    };
    check();
  });
});
