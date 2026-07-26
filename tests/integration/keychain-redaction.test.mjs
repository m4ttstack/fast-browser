import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultConfig } from '../../lib/core/config.mjs';
import {
  pairAutoConnect,
  setManualConnection,
} from '../../lib/keychain/pair.mjs';

const INSTRUCTIONS = [
  '1. Open the Fast Browser extension status page.',
  '2. Copy the raw reconnect token.',
  '3. Paste it into the secure macOS Keychain prompt below.',
];

test('pairAutoConnect prints only the prescribed instructions and returns a parsed auto config', async () => {
  const original = defaultConfig();
  const printed = [];
  const events = [];
  let updated;

  const result = await pairAutoConnect(original, {
    print(line) {
      printed.push(line);
    },
    async writeTokenFromPrompt() {
      events.push('write');
    },
    async hasToken() {
      events.push('verify');
      return true;
    },
    async updateConfig(config) {
      events.push('update');
      updated = config;
    },
  });

  assert.deepEqual(printed, INSTRUCTIONS);
  assert.deepEqual(events, ['write', 'verify', 'update']);
  assert.deepEqual(result, {
    ...defaultConfig(),
    connection: { mode: 'auto' },
  });
  assert.deepEqual(updated, result);
  assert.notEqual(result, original);
  assert.deepEqual(original.connection, { mode: 'manual' });
});

test('pairAutoConnect verifies token presence before updating config', async () => {
  const printed = [];
  let updates = 0;

  await assert.rejects(
    () => pairAutoConnect(defaultConfig(), {
      print(line) {
        printed.push(line);
      },
      async writeTokenFromPrompt() {},
      async hasToken() {
        return false;
      },
      async updateConfig() {
        updates += 1;
      },
    }),
    /Keychain token is missing/,
  );

  assert.deepEqual(printed, INSTRUCTIONS);
  assert.equal(updates, 0);
});

test('manual mode preserves the Keychain item without an explicit confirmation dependency', async () => {
  const automatic = {
    ...defaultConfig(),
    connection: { mode: 'auto' },
  };
  let deletes = 0;

  const result = await setManualConnection(automatic, {
    async deleteToken() {
      deletes += 1;
      return true;
    },
  });

  assert.deepEqual(result.connection, { mode: 'manual' });
  assert.equal(deletes, 0);
  assert.deepEqual(automatic.connection, { mode: 'auto' });
});

test('manual mode deletes only after an explicit confirmation dependency approves', async () => {
  const events = [];
  const result = await setManualConnection(
    { ...defaultConfig(), connection: { mode: 'auto' } },
    {
      async confirmDeleteToken() {
        events.push('confirm');
        return true;
      },
      async deleteToken() {
        events.push('delete');
        return true;
      },
      async updateConfig() {
        events.push('update');
      },
    },
  );

  assert.deepEqual(events, ['confirm', 'delete', 'update']);
  assert.deepEqual(result.connection, { mode: 'manual' });
});
