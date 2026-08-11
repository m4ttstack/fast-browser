import assert from 'node:assert/strict';
import test from 'node:test';

import { main } from '../../lib/cli/main.mjs';
import { ConfigError } from '../../lib/core/config.mjs';

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
