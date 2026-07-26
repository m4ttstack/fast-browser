import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_SERVICE,
  deleteToken,
  hasToken,
  readToken,
  writeMigratedToken,
  writeTokenFromPrompt,
} from '../../lib/keychain/keychain.mjs';

const READ_ARGS = [
  'find-generic-password',
  '-s', 'dev.mattstack.fast-browser',
  '-a', 'chrome-extension',
  '-w',
];
const FIND_ARGS = READ_ARGS.slice(0, -1);
const WRITE_ARGS = [
  'add-generic-password',
  '-U',
  '-s', 'dev.mattstack.fast-browser',
  '-a', 'chrome-extension',
  '-w',
];
const DELETE_ARGS = [
  'delete-generic-password',
  '-s', 'dev.mattstack.fast-browser',
  '-a', 'chrome-extension',
];

class FakeReadable extends EventEmitter {}

class FakeStdin extends EventEmitter {
  constructor(call, plan) {
    super();
    this.call = call;
    this.plan = plan;
  }

  end(value, callback) {
    this.call.stdin += String(value);
    if (this.plan.stdinError) {
      callback?.(new Error(this.plan.stdinError));
      return;
    }
    this.emit('finish');
    callback?.();
  }
}

function plannedSpawn(plans, calls = []) {
  return {
    calls,
    spawn(command, args, options) {
      const plan = plans.shift() ?? {};
      if (plan.throwOnSpawn) throw new Error(plan.throwOnSpawn);

      const call = {
        command,
        args,
        options,
        stdin: '',
      };
      calls.push(call);

      const child = new EventEmitter();
      if (options.stdio[0] === 'pipe') child.stdin = new FakeStdin(call, plan);
      if (options.stdio[1] === 'pipe') child.stdout = new FakeReadable();
      if (options.stdio[2] === 'pipe') child.stderr = new FakeReadable();

      process.nextTick(() => {
        if (plan.childError) {
          child.emit('error', new Error(plan.childError));
          return;
        }
        for (const chunk of plan.stdout ?? []) child.stdout?.emit('data', Buffer.from(chunk));
        for (const chunk of plan.stderr ?? []) child.stderr?.emit('data', Buffer.from(chunk));
        if (plan.stdoutError) child.stdout?.emit('error', new Error(plan.stdoutError));
        if (plan.stderrError) child.stderr?.emit('error', new Error(plan.stderrError));
        if (!plan.partialStdout) child.stdout?.emit('end');
        if (!plan.partialStderr) child.stderr?.emit('end');
        const code = Object.hasOwn(plan, 'code') ? plan.code : 0;
        child.emit('exit', code, plan.signal ?? null);
        child.emit('close', code, plan.signal ?? null);
      });
      return child;
    },
  };
}

async function capturedRejection(operation) {
  try {
    await operation();
    assert.fail('expected operation to reject');
  } catch (error) {
    return String(error?.stack ?? error);
  }
}

test('exports the exact Keychain identity', () => {
  assert.equal(KEYCHAIN_SERVICE, 'dev.mattstack.fast-browser');
  assert.equal(KEYCHAIN_ACCOUNT, 'chrome-extension');
});

test('readToken uses exact non-secret arguments and removes one terminal newline', async () => {
  const fake = plannedSpawn([{ stdout: ['secret-', 'value\n'] }]);

  assert.equal(await readToken({ spawn: fake.spawn }), 'secret-value');
  assert.deepEqual(fake.calls[0].args, READ_ARGS);
  assert.equal(fake.calls[0].command, '/usr/bin/security');
  assert.deepEqual(fake.calls[0].options, {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal('env' in fake.calls[0].options, false);
});

test('readToken returns null for exit 44 and rejects unsafe empty or invalid output', async () => {
  const fake = plannedSpawn([
    { code: 44 },
    { stdout: ['\n'] },
    { stdout: ['secret-value\n\n'] },
    { stdout: ['secret value\n'] },
  ]);

  assert.equal(await readToken({ spawn: fake.spawn }), null);
  await assert.rejects(() => readToken({ spawn: fake.spawn }), /invalid Keychain token/);
  await assert.rejects(() => readToken({ spawn: fake.spawn }), /invalid Keychain token/);
  await assert.rejects(() => readToken({ spawn: fake.spawn }), /invalid Keychain token/);
});

test('hasToken uses a non-revealing lookup and treats exit 44 as absent', async () => {
  const fake = plannedSpawn([{ code: 0 }, { code: 44 }]);

  assert.equal(await hasToken({ spawn: fake.spawn }), true);
  assert.equal(await hasToken({ spawn: fake.spawn }), false);
  assert.deepEqual(fake.calls.map((call) => call.args), [FIND_ARGS, FIND_ARGS]);
  assert.deepEqual(fake.calls[0].options, {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
});

test('deleteToken is idempotent and never requests password output', async () => {
  const fake = plannedSpawn([
    { code: 0, stdout: ['not-returned'] },
    { code: 44 },
  ]);

  assert.equal(await deleteToken({ spawn: fake.spawn }), true);
  assert.equal(await deleteToken({ spawn: fake.spawn }), false);
  assert.deepEqual(fake.calls.map((call) => call.args), [DELETE_ARGS, DELETE_ARGS]);
  assert.equal(fake.calls[0].args.includes('-w'), false);
});

test('writeMigratedToken sends the token only as one piped stdin line', async () => {
  const token = 'secret-value';
  const fake = plannedSpawn([{}]);

  await writeMigratedToken(token, { spawn: fake.spawn });

  const [call] = fake.calls;
  assert.deepEqual(call.args, WRITE_ARGS);
  assert.equal(call.args.at(-1), '-w');
  assert.equal(call.stdin, `${token}\n`);
  assert.equal(JSON.stringify(call.args).includes(token), false);
  assert.equal(JSON.stringify(call.options).includes(token), false);
  assert.deepEqual(call.options, {
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
});

test('writeTokenFromPrompt inherits stdin and stderr so security owns hidden input', async () => {
  const fake = plannedSpawn([{}]);

  await writeTokenFromPrompt({ spawn: fake.spawn });

  assert.deepEqual(fake.calls[0], {
    command: '/usr/bin/security',
    args: WRITE_ARGS,
    options: {
      shell: false,
      stdio: ['inherit', 'ignore', 'inherit'],
    },
    stdin: '',
  });
});

test('migrated writes reject unsafe tokens without spawning security', async () => {
  const fake = plannedSpawn([]);

  for (const token of ['', ' ', 'line\nbreak', 'tab\tvalue']) {
    await assert.rejects(
      () => writeMigratedToken(token, { spawn: fake.spawn }),
      /invalid Keychain token/,
    );
  }
  assert.equal(fake.calls.length, 0);
});

test('spawn and child errors never echo a supplied token', async () => {
  const token = 'supplied-secret-value';
  const spawnFailure = plannedSpawn([{ throwOnSpawn: `spawn failed: ${token}` }]);
  const childFailure = plannedSpawn([{ childError: `child failed: ${token}` }]);

  for (const fake of [spawnFailure, childFailure]) {
    const diagnostic = await capturedRejection(
      () => writeMigratedToken(token, { spawn: fake.spawn }),
    );
    assert.equal(diagnostic.includes(token), false, 'diagnostic must redact supplied token');
  }
});

test('invalid child accessors never expose fake spawn diagnostics', async () => {
  const token = 'child-accessor-secret-value';
  const child = new Proxy(new EventEmitter(), {
    get(target, property, receiver) {
      if (property === 'stdout') throw new Error(`unsafe child: ${token}`);
      return Reflect.get(target, property, receiver);
    },
  });

  const diagnostic = await capturedRejection(
    () => readToken({ spawn: () => child }),
  );
  assert.equal(diagnostic.includes(token), false, 'child setup diagnostic must be redacted');
});

test('nonzero and signal failures never echo returned stdout or stderr', async () => {
  const returnedToken = 'returned-secret-value';
  const fake = plannedSpawn([
    { code: 7, stdout: [`${returnedToken}\n`], stderr: [`failed ${returnedToken}`] },
    { code: null, signal: returnedToken, stdout: [`${returnedToken}\n`] },
  ]);

  for (let index = 0; index < 2; index += 1) {
    const diagnostic = await capturedRejection(() => readToken({ spawn: fake.spawn }));
    assert.equal(diagnostic.includes(returnedToken), false, 'diagnostic must redact command output');
  }
});

test('stream errors, early close, and stdin errors fail without leaking data', async () => {
  const token = 'stream-secret-value';
  const fake = plannedSpawn([
    { stdoutError: token },
    { stdout: [token], partialStdout: true },
    { stdinError: token },
  ]);

  const operations = [
    () => readToken({ spawn: fake.spawn }),
    () => readToken({ spawn: fake.spawn }),
    () => writeMigratedToken(token, { spawn: fake.spawn }),
  ];
  for (const operation of operations) {
    const diagnostic = await capturedRejection(operation);
    assert.equal(diagnostic.includes(token), false, 'stream diagnostic must redact token');
  }
});

test('captured stdout and stderr are bounded and never returned in failures', async () => {
  const marker = 'bounded-output-marker';
  const oversized = marker.repeat(100_000);
  const fake = plannedSpawn([
    { stdout: [oversized] },
    { code: 9, stderr: [oversized] },
  ]);

  const stdoutDiagnostic = await capturedRejection(() => readToken({ spawn: fake.spawn }));
  const stderrDiagnostic = await capturedRejection(() => hasToken({ spawn: fake.spawn }));
  assert.equal(stdoutDiagnostic.includes(marker), false);
  assert.equal(stderrDiagnostic.includes(marker), false);
});
