import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArgs, UsageError } from '../../lib/cli/parse-args.mjs';

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
      palette: null,
      config: null,
      video: null,
      out: null,
      fps: null,
      width: null,
    },
  );
});

// profile defaults to null, not 'safe': an omitted --profile has to reach
// setup as an omission so setup can keep the configured profile. A 'safe'
// default at this layer is what downgraded a full-profile machine on a
// routine rerun, twice in one day, the second time after setup itself had
// learned to carry.
test('defaults setup to detected hosts and no profile choice', () => {
  assert.deepEqual(parseArgs(['setup']), {
    command: 'setup',
    hosts: [],
    profile: null,
    source: 'm4ttheweric/mattstack',
    json: false,
    purgeData: false,
    dryRun: false,
    rollback: null,
    connection: null,
    recordSessions: null,
    retentionDays: null,
    runtimeLock: null,
    palette: null,
    config: null,
    video: null,
    out: null,
    fps: null,
    width: null,
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

// migrate reinstalls the host adapters through the same code path as setup,
// so it needs the same --source. Rejecting the flag left migrate passing an
// undefined source, which Claude refuses as "configured from a different
// source" against the marketplace setup already registered. Every machine
// that had run setup therefore could not migrate.
test('migrate accepts --source, like setup', () => {
  assert.equal(
    parseArgs(['migrate', '--host', 'both', '--source', '/repo/mattstack']).source,
    '/repo/mattstack',
  );
});

test('doctor still rejects --source', () => {
  assert.throws(() => parseArgs(['doctor', '--source', '/repo/mattstack']), /--source/);
});

test('--palette is accepted for configure and validated', () => {
  assert.equal(parseArgs(['configure', '--palette', 'teal']).palette, 'teal');
  assert.throws(() => parseArgs(['configure', '--palette', 'burgundy']), UsageError);
  assert.throws(() => parseArgs(['setup', '--palette', 'teal']), UsageError);
});

test('--video is accepted for configure and parsed strictly', () => {
  assert.deepEqual(
    parseArgs(['configure', '--video', '1280x720']).video,
    { width: 1280, height: 720 },
  );
  assert.deepEqual(
    parseArgs(['configure', '--video', '320x240']).video,
    { width: 320, height: 240 },
  );
  assert.deepEqual(
    parseArgs(['configure', '--video', '3840x2160']).video,
    { width: 3840, height: 2160 },
  );
  assert.equal(parseArgs(['configure', '--video', 'off']).video, 'off');
  for (const value of [
    'on',
    '1280',
    '1280x',
    'x720',
    '1280x720x2',
    '1280 x 720',
    '319x240', // below the width floor
    '3841x2160', // above the width ceiling
    '320x239', // below the height floor
    '320x2161', // above the height ceiling
    '01280x720', // leading zero is not a plain decimal integer
    '1280x-720',
    '1.5x720',
    '0x0',
  ]) {
    assert.throws(() => parseArgs(['configure', '--video', value]), UsageError, value);
  }
  assert.throws(() => parseArgs(['setup', '--video', '1280x720']), UsageError);
});

test('an invalid --video value is named by flag, never echoed', () => {
  assert.throws(
    () => parseArgs(['configure', '--video', 'sk-do-not-print-this-secret']),
    (error) => error instanceof UsageError
      && !error.message.includes('sk-do-not-print-this-secret')
      && /--video/.test(error.message),
  );
});

test('gif takes exactly one positional video name with bounded options', () => {
  const request = parseArgs(['gif', 'flow.webm', '--out', 'flow.gif', '--fps', '12', '--width', '800']);
  assert.equal(request.command, 'gif');
  assert.equal(request.video, 'flow.webm');
  assert.equal(request.out, 'flow.gif');
  assert.equal(request.fps, 12);
  assert.equal(request.width, 800);

  assert.throws(() => parseArgs(['gif']), UsageError);
  assert.throws(() => parseArgs(['gif', 'a.webm', 'b.webm']), UsageError);
  assert.throws(() => parseArgs(['gif', '--nope']), UsageError);
  for (const argv of [
    ['gif', 'flow.webm', '--fps', '0'],
    ['gif', 'flow.webm', '--fps', '31'],
    ['gif', 'flow.webm', '--fps', 'fast'],
    ['gif', 'flow.webm', '--width', '99'],
    ['gif', 'flow.webm', '--width', '1201'],
    ['gif', 'flow.webm', '--width', '800px'],
  ]) {
    assert.throws(() => parseArgs(argv), UsageError, argv.join(' '));
  }
  assert.throws(() => parseArgs(['annotate', 'a.json', '--fps', '8']), UsageError);
  assert.throws(() => parseArgs(['configure', '--out', 'x.gif']), UsageError);
});

test('a duplicated gif video name never echoes the name', () => {
  assert.throws(
    () => parseArgs(['gif', '/Users/secret/x.webm', '/Users/secret/x.webm']),
    (error) => error instanceof UsageError
      && !error.message.includes('/Users/secret')
      && /exactly one video name/.test(error.message),
  );
});

test('annotate takes exactly one positional config path', () => {
  const request = parseArgs(['annotate', 'shot.json']);
  assert.equal(request.command, 'annotate');
  assert.equal(request.config, 'shot.json');
});

test('annotate accepts --json alongside the positional', () => {
  const request = parseArgs(['annotate', 'shot.json', '--json']);
  assert.equal(request.config, 'shot.json');
  assert.equal(request.json, true);
});

test('annotate rejects a missing, duplicated, or flag-like positional', () => {
  assert.throws(() => parseArgs(['annotate']), UsageError);
  assert.throws(() => parseArgs(['annotate', 'a.json', 'b.json']), UsageError);
  assert.throws(() => parseArgs(['annotate', '--nope']), UsageError);
});

test('other commands still reject positional arguments', () => {
  assert.throws(() => parseArgs(['doctor', 'extra']), UsageError);
});

test('a duplicated config path never echoes the path', () => {
  assert.throws(
    () => parseArgs(['annotate', '/Users/secret/x.json', '/Users/secret/x.json']),
    (error) => error instanceof UsageError
      && !error.message.includes('/Users/secret')
      && /exactly one config path/.test(error.message),
  );
});

test('annotate parses the same request regardless of flag/positional order', () => {
  const beforeJson = parseArgs(['annotate', 'shot.json', '--json']);
  const afterJson = parseArgs(['annotate', '--json', 'shot.json']);
  assert.equal(beforeJson.config, 'shot.json');
  assert.equal(beforeJson.json, true);
  assert.equal(afterJson.config, 'shot.json');
  assert.equal(afterJson.json, true);
});
