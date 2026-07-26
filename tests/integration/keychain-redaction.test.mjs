import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultConfig } from '../../lib/core/config.mjs';
import { configure } from '../../lib/commands/configure.mjs';
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

  const tokenStates = [false, true];
  const result = await pairAutoConnect(original, {
    print(line) {
      printed.push(line);
    },
    async writeTokenFromPrompt() {
      events.push('write');
    },
    async hasToken() {
      events.push('verify');
      return tokenStates.shift();
    },
    async updateConfig(config) {
      events.push('update');
      updated = config;
    },
  });

  assert.deepEqual(printed, INSTRUCTIONS);
  assert.deepEqual(events, ['verify', 'write', 'verify', 'update']);
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

  const tokenStates = [false, false];
  await assert.rejects(
    () => pairAutoConnect(defaultConfig(), {
      print(line) {
        printed.push(line);
      },
      async writeTokenFromPrompt() {},
      async hasToken() {
        return tokenStates.shift();
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

test('existing automatic-pairing item requires explicit replacement confirmation', async () => {
  const secret = 'existing-token-must-not-appear';
  for (const fixture of [
    { interactive: false, json: false, answer: true },
    { interactive: true, json: true, answer: true },
    { interactive: true, json: false, answer: false },
  ]) {
    const events = [];
    const diagnostic = await (async () => {
      try {
        await pairAutoConnect(defaultConfig(), {
          interactive: fixture.interactive,
          json: fixture.json,
          async hasToken() {
            events.push('has-token');
            return true;
          },
          async confirmReplaceToken() {
            events.push('confirm');
            return fixture.answer;
          },
          print(line) {
            events.push(`print:${line}`);
          },
          async writeTokenFromPrompt() {
            events.push('write');
            throw new Error(secret);
          },
          async updateConfig() {
            events.push('update');
          },
        });
        assert.fail('expected replacement to be declined');
      } catch (error) {
        return String(error?.stack ?? error);
      }
    })();
    assert.equal(events.includes('write'), false);
    assert.equal(events.includes('update'), false);
    assert.equal(events.some((event) => event.startsWith('print:')), false);
    assert.equal(diagnostic.includes(secret), false);
    if (!fixture.interactive || fixture.json) assert.equal(events.includes('confirm'), false);
  }
});

test('configure uses its TTY replacement handler before any routing or credential write', async () => {
  const events = [];
  await assert.rejects(
    configure(
      {
        profile: 'safe',
        connection: 'auto',
        recordSessions: null,
        retentionDays: null,
        json: false,
      },
      {
        loadConfig: async () => defaultConfig(),
        hasToken: async () => {
          events.push('has-token');
          return true;
        },
        interactive: true,
        input: { isTTY: true },
        output: { isTTY: true },
        createInterface: () => ({
          question: async () => {
            events.push('prompt');
            return 'no';
          },
          close: () => events.push('close'),
        }),
        installRouting: async () => events.push('routing'),
        writeTokenFromPrompt: async () => events.push('write-token'),
        saveConfig: async () => events.push('save-config'),
        paths: {},
      },
    ),
    /replacement confirmation/i,
  );
  assert.deepEqual(events, ['has-token', 'prompt', 'close']);
});

test('configure redacts replacement-confirmation failures before any write', async () => {
  const secret = 'replacement-confirmation-secret';
  const events = [];
  const diagnostic = await (async () => {
    try {
      await configure(
        {
          profile: 'safe',
          connection: 'auto',
          recordSessions: null,
          retentionDays: null,
          json: false,
        },
        {
          loadConfig: async () => defaultConfig(),
          hasToken: async () => true,
          interactive: true,
          confirmReplaceToken: async () => {
            throw new Error(secret);
          },
          installRouting: async () => events.push('routing'),
          writeTokenFromPrompt: async () => events.push('write-token'),
          saveConfig: async () => events.push('save-config'),
          paths: {},
        },
      );
      assert.fail('expected confirmation to reject');
    } catch (error) {
      return String(error?.stack ?? error);
    }
  })();
  assert.equal(diagnostic.includes(secret), false);
  assert.match(diagnostic, /unable to confirm.*replacement/i);
  assert.deepEqual(events, []);
});

test('pairAutoConnect requires persistence before printing or writing a credential', async () => {
  const events = [];

  await assert.rejects(
    () => pairAutoConnect(defaultConfig(), {
      print() {
        events.push('print');
      },
      async writeTokenFromPrompt() {
        events.push('write');
      },
      async hasToken() {
        events.push('verify');
        return true;
      },
    }),
    /requires config persistence/,
  );

  assert.deepEqual(events, []);
});

test('pairAutoConnect preserves the Keychain item and returns fixed remediation on save failure', async () => {
  const token = 'pair-save-secret-fixture';
  const original = defaultConfig();
  const events = [];
  const tokenStates = [false, true];

  const diagnostic = await (async () => {
    try {
      await pairAutoConnect(original, {
        print() {},
        async writeTokenFromPrompt() {
          events.push('write');
        },
        async hasToken() {
          events.push('verify');
          return tokenStates.shift();
        },
        async updateConfig() {
          events.push('update');
          throw new Error(token);
        },
        async deleteToken() {
          events.push('delete');
        },
      });
      assert.fail('expected pairing to reject');
    } catch (error) {
      return String(error?.stack ?? error);
    }
  })();

  assert.deepEqual(events, ['verify', 'write', 'verify', 'update']);
  assert.equal(diagnostic.includes(token), false);
  assert.match(diagnostic, /Keychain token was preserved/);
  assert.deepEqual(original.connection, { mode: 'manual' });
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
      async updateConfig(config) {
        events.push('update');
        assert.deepEqual(config.connection, { mode: 'manual' });
      },
    },
  );

  assert.deepEqual(events, ['confirm', 'update', 'delete']);
  assert.deepEqual(result.connection, { mode: 'manual' });
});

test('confirmed manual mode never deletes when persistence fails', async () => {
  const token = 'manual-save-secret-fixture';
  const original = { ...defaultConfig(), connection: { mode: 'auto' } };
  const events = [];

  const diagnostic = await (async () => {
    try {
      await setManualConnection(original, {
        async confirmDeleteToken() {
          events.push('confirm');
          return true;
        },
        async updateConfig() {
          events.push('update');
          throw new Error(token);
        },
        async deleteToken() {
          events.push('delete');
        },
      });
      assert.fail('expected manual transition to reject');
    } catch (error) {
      return String(error?.stack ?? error);
    }
  })();

  assert.deepEqual(events, ['confirm', 'update']);
  assert.equal(diagnostic.includes(token), false);
  assert.match(diagnostic, /automatic connection remains configured/);
  assert.deepEqual(original.connection, { mode: 'auto' });
});

test('delete failure leaves the persisted manual config and returns fixed remediation', async () => {
  const token = 'manual-delete-secret-fixture';
  const original = { ...defaultConfig(), connection: { mode: 'auto' } };
  const events = [];
  let persisted;

  const diagnostic = await (async () => {
    try {
      await setManualConnection(original, {
        async confirmDeleteToken() {
          events.push('confirm');
          return true;
        },
        async updateConfig(config) {
          events.push('update');
          persisted = config;
        },
        async deleteToken() {
          events.push('delete');
          throw new Error(token);
        },
      });
      assert.fail('expected manual transition to reject');
    } catch (error) {
      return String(error?.stack ?? error);
    }
  })();

  assert.deepEqual(events, ['confirm', 'update', 'delete']);
  assert.deepEqual(persisted.connection, { mode: 'manual' });
  assert.deepEqual(original.connection, { mode: 'auto' });
  assert.equal(diagnostic.includes(token), false);
  assert.match(diagnostic, /manual connection was saved/);
});
