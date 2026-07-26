import assert from 'node:assert/strict';
import test from 'node:test';

import { run } from '../../lib/core/process.mjs';

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
