import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArgs } from '../../lib/cli/parse-args.mjs';

test('parses a two-host full setup', () => {
  assert.deepEqual(
    parseArgs(['setup', '--host', 'both', '--profile', 'full', '--source', '/tmp/mattstack']),
    {
      command: 'setup',
      hosts: ['claude', 'codex'],
      profile: 'full',
      source: '/tmp/mattstack',
      json: false,
      purgeData: false,
      dryRun: false,
      rollback: null,
      connection: null,
      recordSessions: null,
      retentionDays: null,
      runtimeLock: null,
    },
  );
});

test('defaults setup to detected hosts and safe profile', () => {
  assert.deepEqual(parseArgs(['setup']), {
    command: 'setup',
    hosts: [],
    profile: 'safe',
    source: 'm4ttheweric/mattstack',
    json: false,
    purgeData: false,
    dryRun: false,
    rollback: null,
    connection: null,
    recordSessions: null,
    retentionDays: null,
    runtimeLock: null,
  });
});

test('rejects unsupported platforms and flags through usage errors', () => {
  assert.throws(() => parseArgs(['setup', '--host', 'firefox']), /--host/);
  assert.throws(() => parseArgs(['uninstall', '--unknown']), /--unknown/);
});
