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

test('parses configure profile and strict help or version requests', () => {
  assert.equal(parseArgs(['configure', '--profile', 'full']).profile, 'full');
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['--version']).version, true);
});

test('each command help request is parsed without command options or side effects', () => {
  for (const command of ['setup', 'doctor', 'configure', 'migrate', 'uninstall']) {
    const parsed = parseArgs([command, '--help']);
    assert.equal(parsed.command, command);
    assert.equal(parsed.help, true);
  }
});

test('per-command allowlists reject flags a command would otherwise ignore', () => {
  assert.throws(
    () => parseArgs(['configure', '--host', 'claude']),
    /--host.*not valid.*configure/i,
  );
  assert.throws(
    () => parseArgs(['doctor', '--host', 'claude']),
    /--host.*not valid.*doctor/i,
  );
});

test('rejects duplicate and conflicting options', () => {
  assert.throws(
    () => parseArgs(['setup', '--profile', 'safe', '--profile', 'full']),
    /duplicate.*--profile/i,
  );
  assert.throws(
    () => parseArgs(['configure', '--record-sessions', '--no-record-sessions']),
    /conflicting.*record-sessions/i,
  );
  assert.throws(
    () => parseArgs(['migrate', '--dry-run', '--rollback', 'manifest.json']),
    /conflicting.*--dry-run.*--rollback/i,
  );
  assert.throws(
    () => parseArgs(['setup', '--host', 'claude', '--host', 'claude']),
    /duplicate.*--host/i,
  );
});

test('usage errors never echo unknown or invalid secret-like values', () => {
  for (const argv of [
    ['setup', '--token=sk-do-not-print-this-secret'],
    ['setup', '--host', 'sk-do-not-print-this-secret'],
    ['setup', '--profile', 'sk-do-not-print-this-secret'],
    ['configure', '--retention-days', '999-secret'],
  ]) {
    assert.throws(
      () => parseArgs(argv),
      (error) => {
        assert.doesNotMatch(error.message, /sk-do-not-print-this-secret|999-secret/);
        return true;
      },
    );
  }
});
