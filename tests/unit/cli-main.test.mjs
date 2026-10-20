import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { main } from '../../lib/cli/main.mjs';
import { ConfigError } from '../../lib/core/config.mjs';
import { resolvePaths } from '../../lib/core/paths.mjs';

test('doctor shows unselected checks as skipped without claiming they passed', async () => {
  const writes = [];
  const exitCode = await main({ command: 'doctor' }, {
    write: (text) => writes.push(text),
    commands: {
      doctor: async () => ({
        ok: true,
        checks: [{ id: 'codex-plugin', status: 'skip', message: 'Codex is not selected.', remediation: null }],
      }),
    },
  });
  assert.equal(exitCode, 0);
  assert.match(writes.join(''), /SKIP codex-plugin/);
  assert.match(writes.join(''), /ran no checks/);
  assert.doesNotMatch(writes.join(''), /doctor passed/);
});

// safeFailure's allowlist decides which errors get to say anything about
// themselves on the way out of the CLI; everything off it collapses to the
// generic diagnostics-free message. These pin both halves of that contract
// through main() itself, not just the allowlist check in isolation.

function runWithThrowingCommand(error) {
  const writes = [];
  return main(
    { command: 'setup', json: true },
    {
      write: (text) => writes.push(text),
      commands: {
        setup: async () => {
          throw error;
        },
      },
    },
  ).then((exitCode) => ({ exitCode, writes }));
}

test('a ConfigError surfaces its own message through the CLI failure path', async () => {
  const error = new ConfigError('unable to read config: ENOENT ... config.json');
  const { exitCode, writes } = await runWithThrowingCommand(error);

  const payload = JSON.parse(writes[0]);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.message, 'unable to read config: ENOENT ... config.json');
  assert.equal(exitCode, 1);
});

test('a non-allowlisted error class still gets the generic wrapper', async () => {
  const error = new Error('leaks a real file path: /Users/matt/secret');
  const { exitCode, writes } = await runWithThrowingCommand(error);

  const payload = JSON.parse(writes[0]);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.message, 'The command failed without exposing external diagnostics.');
  assert.equal(exitCode, 1);
});

test('configure --json on a machine without setup names setup and keeps the error envelope', async (t) => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'fast-browser-test-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const paths = resolvePaths({ homeDir, pluginRoot: '/plugin' });
  const writes = [];

  const exitCode = await main({ command: 'configure', json: true }, {
    write: (text) => writes.push(text),
    paths,
  });

  const payload = JSON.parse(writes[0]);
  assert.equal(exitCode, 1);
  assert.deepEqual(Object.keys(payload.error), ['message', 'stage', 'partialState']);
  assert.match(payload.error.message, /not set up yet.*fast-browser setup/);
  assert.doesNotMatch(payload.error.message, /ENOENT|config\.json/);
});
