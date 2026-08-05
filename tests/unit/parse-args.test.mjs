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
      sub: null,
      intent: null,
      origin: null,
      url: null,
      name: null,
      verb: null,
      selector: null,
      description: null,
      urlPattern: null,
      ttlHours: null,
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
    source: 'm4ttstack/fast-browser',
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
    sub: null,
    intent: null,
    origin: null,
    url: null,
    name: null,
    verb: null,
    selector: null,
    description: null,
    urlPattern: null,
    ttlHours: null,
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

test('flows requires and validates its subcommand', () => {
  assert.throws(() => parseArgs(['flows']), UsageError);
  assert.throws(() => parseArgs(['flows', 'bogus']), UsageError);
  assert.equal(parseArgs(['flows', 'list']).sub, 'list');
  assert.equal(parseArgs(['flows', 'compile']).sub, 'compile');
  assert.equal(parseArgs(['flows', 'find', '--intent', 'log in']).sub, 'find');
});

test('flows --help is parsed without requiring a subcommand', () => {
  const parsed = parseArgs(['flows', '--help']);
  assert.equal(parsed.command, 'flows');
  assert.equal(parsed.help, true);
});

test('flows approve and reject require exactly one name; other subcommands forbid one', () => {
  assert.throws(() => parseArgs(['flows', 'approve']), UsageError);
  assert.throws(() => parseArgs(['flows', 'reject']), UsageError);
  assert.equal(parseArgs(['flows', 'approve', 'my-flow']).name, 'my-flow');
  assert.equal(parseArgs(['flows', 'reject', 'my-flow']).name, 'my-flow');
  assert.throws(() => parseArgs(['flows', 'approve', 'my-flow', 'extra']), UsageError);
  assert.throws(() => parseArgs(['flows', 'list', 'extra']), UsageError);
  assert.throws(() => parseArgs(['flows', 'compile', 'extra']), UsageError);
  assert.throws(() => parseArgs(['flows', 'find', '--intent', 'x', 'extra']), UsageError);
});

test('a duplicated flows name never echoes the name', () => {
  assert.throws(
    () => parseArgs(['flows', 'approve', '/Users/secret/x', '/Users/secret/x']),
    (error) => error instanceof UsageError
      && !error.message.includes('/Users/secret')
      && /exactly one name argument/.test(error.message),
  );
});

test('flows find requires --intent; other subcommands do not', () => {
  assert.throws(() => parseArgs(['flows', 'find']), UsageError);
  assert.throws(() => parseArgs(['flows', 'find', '--intent', '   ']), UsageError);
  const request = parseArgs([
    'flows', 'find', '--intent', 'log in', '--origin', 'https://example.com', '--url', '/login',
  ]);
  assert.equal(request.intent, 'log in');
  assert.equal(request.origin, 'https://example.com');
  assert.equal(request.url, '/login');
  assert.doesNotThrow(() => parseArgs(['flows', 'list']));
  assert.doesNotThrow(() => parseArgs(['flows', 'compile']));
});

// Fix round 1, M10: this title used to say "allowlisted to flows only",
// which stopped being accurate the moment --origin/--url were extended to
// sites too (see the dedicated 'allowlisted to both flows and sites' test
// below) -- --intent is still flows-only, but --origin/--url here are only
// being checked against commands that get NEITHER, not against sites.
test('--intent is flows-only; --origin and --url are rejected by commands outside flows and sites', () => {
  assert.throws(() => parseArgs(['setup', '--intent', 'x']), UsageError);
  assert.throws(() => parseArgs(['configure', '--origin', 'https://example.com']), UsageError);
  assert.throws(() => parseArgs(['doctor', '--url', '/x']), UsageError);
});

// --- sites ---

test('sites requires and validates its subcommand', () => {
  assert.throws(() => parseArgs(['sites']), UsageError);
  assert.throws(() => parseArgs(['sites', 'bogus']), UsageError);
  assert.equal(parseArgs(['sites', 'show', 'https://example.com']).sub, 'show');
  assert.equal(parseArgs(['sites', 'affordances', '--url', 'https://example.com/x']).sub, 'affordances');
  assert.equal(parseArgs(['sites', 'quirk', 'list', '--origin', 'https://example.com']).sub, 'quirk');
});

test('sites --help is parsed without requiring a subcommand', () => {
  const parsed = parseArgs(['sites', '--help']);
  assert.equal(parsed.command, 'sites');
  assert.equal(parsed.help, true);
});

test('sites show takes exactly one origin positional', () => {
  const request = parseArgs(['sites', 'show', 'https://example.com']);
  assert.equal(request.origin, 'https://example.com');

  assert.throws(() => parseArgs(['sites', 'show']), UsageError);
  assert.throws(
    () => parseArgs(['sites', 'show', 'https://example.com', 'https://other.example']),
    UsageError,
  );
});

test('a duplicated sites show origin never echoes the origin', () => {
  assert.throws(
    () => parseArgs(['sites', 'show', 'https://secret.example', 'https://secret.example']),
    (error) => error instanceof UsageError
      && !error.message.includes('secret.example')
      && /exactly one origin argument/.test(error.message),
  );
});

test('sites show accepts --json alongside the origin positional', () => {
  const request = parseArgs(['sites', 'show', 'https://example.com', '--json']);
  assert.equal(request.origin, 'https://example.com');
  assert.equal(request.json, true);
});

test('sites affordances and digest require --url', () => {
  assert.throws(() => parseArgs(['sites', 'affordances']), UsageError);
  assert.throws(() => parseArgs(['sites', 'affordances', '--url', '   ']), UsageError);
  assert.throws(() => parseArgs(['sites', 'digest']), UsageError);

  const affordances = parseArgs(['sites', 'affordances', '--url', 'https://example.com/cart']);
  assert.equal(affordances.url, 'https://example.com/cart');

  const digest = parseArgs(['sites', 'digest', '--url', 'https://example.com/cart', '--ttl-hours', '48']);
  assert.equal(digest.url, 'https://example.com/cart');
  assert.equal(digest.ttlHours, 48);
});

test('sites affordances and digest reject a positional argument', () => {
  assert.throws(() => parseArgs(['sites', 'affordances', '--url', 'https://example.com', 'extra']), UsageError);
  assert.throws(() => parseArgs(['sites', 'digest', '--url', 'https://example.com', 'extra']), UsageError);
});

test('--ttl-hours is a bounded positive integer', () => {
  for (const value of ['0', '-1', '8761', 'soon', '3.5']) {
    assert.throws(
      () => parseArgs(['sites', 'digest', '--url', 'https://example.com', '--ttl-hours', value]),
      UsageError,
    );
  }
  assert.equal(
    parseArgs(['sites', 'digest', '--url', 'https://example.com', '--ttl-hours', '8760']).ttlHours,
    8760,
  );
});

test('sites quirk requires a verb, then a name for add/remove but not list', () => {
  assert.throws(() => parseArgs(['sites', 'quirk']), UsageError);
  assert.throws(() => parseArgs(['sites', 'quirk', 'bogus']), UsageError);
  assert.throws(() => parseArgs(['sites', 'quirk', 'add']), UsageError);
  assert.throws(() => parseArgs(['sites', 'quirk', 'remove']), UsageError);

  const add = parseArgs([
    'sites', 'quirk', 'add', 'cookie-banner', '--origin', 'https://example.com', '--selector', '#accept',
  ]);
  assert.equal(add.verb, 'add');
  assert.equal(add.name, 'cookie-banner');
  assert.equal(add.selector, '#accept');

  const remove = parseArgs(['sites', 'quirk', 'remove', 'cookie-banner', '--origin', 'https://example.com']);
  assert.equal(remove.verb, 'remove');
  assert.equal(remove.name, 'cookie-banner');

  const list = parseArgs(['sites', 'quirk', 'list', '--origin', 'https://example.com']);
  assert.equal(list.verb, 'list');
  assert.equal(list.name, null);

  assert.throws(() => parseArgs(['sites', 'quirk', 'list', 'extra']), UsageError);
  assert.throws(
    () => parseArgs(['sites', 'quirk', 'add', 'a-name', 'b-name', '--origin', 'https://example.com', '--selector', 'x']),
    UsageError,
  );
});

test('a duplicated sites quirk name never echoes the name', () => {
  assert.throws(
    () => parseArgs(['sites', 'quirk', 'add', '/Users/secret/x', '/Users/secret/x']),
    (error) => error instanceof UsageError
      && !error.message.includes('/Users/secret')
      && /exactly one name argument/.test(error.message),
  );
});

test('sites quirk requires --origin for add, list, and remove', () => {
  assert.throws(() => parseArgs(['sites', 'quirk', 'add', 'cookie-banner', '--selector', '#accept']), UsageError);
  assert.throws(() => parseArgs(['sites', 'quirk', 'list']), UsageError);
  assert.throws(() => parseArgs(['sites', 'quirk', 'remove', 'cookie-banner']), UsageError);
});

test('sites quirk add requires --selector', () => {
  assert.throws(
    () => parseArgs(['sites', 'quirk', 'add', 'cookie-banner', '--origin', 'https://example.com']),
    UsageError,
  );
});

test('sites quirk add accepts optional --description and --url-pattern', () => {
  const request = parseArgs([
    'sites', 'quirk', 'add', 'cookie-banner',
    '--origin', 'https://example.com',
    '--selector', '#accept',
    '--description', 'Accept all cookies',
    '--url-pattern', '/cart',
  ]);
  assert.equal(request.description, 'Accept all cookies');
  assert.equal(request.urlPattern, '/cart');
});

test('--selector, --description, --url-pattern, and --ttl-hours are allowlisted to sites only', () => {
  assert.throws(() => parseArgs(['flows', 'find', '--intent', 'x', '--selector', '#y']), UsageError);
  assert.throws(() => parseArgs(['setup', '--description', 'x']), UsageError);
  assert.throws(() => parseArgs(['configure', '--url-pattern', '/x']), UsageError);
  assert.throws(() => parseArgs(['doctor', '--ttl-hours', '10']), UsageError);
});

test('--origin and --url are allowlisted to both flows and sites', () => {
  assert.doesNotThrow(() => parseArgs(['flows', 'find', '--intent', 'x', '--origin', 'https://example.com']));
  assert.doesNotThrow(() => parseArgs(['sites', 'quirk', 'list', '--origin', 'https://example.com']));
  assert.doesNotThrow(() => parseArgs(['sites', 'affordances', '--url', 'https://example.com/x']));
});
