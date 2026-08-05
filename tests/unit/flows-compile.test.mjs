import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { listTraceSessions, readTraceRecords } from '../../lib/flows/trace-reader.mjs';
import { CompileError, compileSession } from '../../lib/flows/compile.mjs';

const fixturesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/traces',
);
const basicDir = path.join(fixturesDir, 'trace-1754350000000');
const hostileDir = path.join(fixturesDir, 'trace-1754350100000');
const readOnlyDir = path.join(fixturesDir, 'trace-1754350200000');

// --- synthetic record builders (mirrors flows-artifact.test.mjs's `target()`
// helper style: a minimal valid TraceRecord, overridden per test) ---

function record(overrides) {
  return {
    v: 1,
    seq: 1,
    tool: 'browser_click',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:00.100Z',
    params: {},
    urlBefore: 'https://example.com/app',
    urlAfter: 'https://example.com/app',
    targets: [],
    network: [],
    mutating: false,
    waits: { settleMs: 0, awaitedNavigation: false, awaitedRequests: 0 },
    code: [],
    ...overrides,
  };
}

function traceTarget({ name, role = 'button' } = {}) {
  return {
    ref: 'e1',
    resolved: `getByRole('${role}', { name: '${name}' })`,
    alternates: [{ kind: 'role', selector: `internal:role=${role}[name="${name}"i]` }],
    role,
    name,
    description: name,
  };
}

const meta = {
  schemaVersion: 1,
  productVersion: '0.1.0-test',
  protocolVersion: 2,
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: '2026-01-01T00:10:00.000Z',
};

// --- golden fixture tests (Task 2's fixtures, plus the read-only fixture
// this task adds) -- exact output pinned, per the brief's "pin them
// exactly" instruction ---

test('session-basic compiles to exactly one mutating flow with lifted args, tokenized-if-applicable urlPattern, and waitAfter on the click', async () => {
  const { records } = await readTraceRecords(basicDir);
  const sessionMeta = JSON.parse(await readFile(path.join(basicDir, 'meta.json'), 'utf8'));
  const result = compileSession({ records, meta: sessionMeta, traceDir: basicDir });

  assert.equal(result.flows.length, 1);
  const flow = result.flows[0];

  assert.match(flow.id, /^[0-9a-f]{64}$/);
  const secondResult = compileSession({ records, meta: sessionMeta, traceDir: basicDir });
  assert.equal(secondResult.flows[0].id, flow.id); // deterministic across repeated compiles

  assert.equal(flow.name, 'place-order');
  assert.equal(
    flow.description,
    'On https://example.com, this flow navigates to /cart, clicks "Place order", fills "Email", fills "Card number", runs a script.',
  );
  assert.equal(flow.origin, 'https://example.com');
  assert.equal(flow.urlPattern, '/cart'); // no lifted literal appears in the nav URL -- untouched
  assert.equal(flow.sideEffects, 'mutating');
  assert.deepEqual(flow.args, {
    email: { type: 'string', required: true },
    cardNumber: { type: 'string', required: true },
  });
  assert.deepEqual(flow.result, { kind: 'completion', keys: [] });

  assert.equal(flow.steps.length, 5);
  assert.deepEqual(flow.steps[0], { op: 'goto', url: '/cart' });
  assert.equal(flow.steps[1].op, 'click');
  assert.deepEqual(flow.steps[1].waitAfter, { networkSettled: true });
  assert.equal(flow.steps[1].mutating, true);
  assert.equal(flow.steps[1].target.name, 'Place order');
  assert.equal(flow.steps[2].op, 'fill');
  assert.equal(flow.steps[2].value, '{email}');
  assert.equal(flow.steps[2].target.name, 'Email');
  assert.equal(flow.steps[3].op, 'fill');
  assert.equal(flow.steps[3].value, '{cardNumber}');
  assert.equal(flow.steps[3].target.name, 'Card number');
  assert.deepEqual(flow.steps[4], {
    op: 'js',
    sha256: '7df3adde491b71e6f010dc825dbe3a2c74e25f8e4e9b8e2c105dc87327bac85e',
    args: { timeoutMs: 5000 },
  });

  assert.deepEqual(flow.provenance.seqRange, [1, 5]);
  assert.equal(flow.provenance.traceDir, basicDir);
  assert.equal(flow.provenance.compiledAt, '2026-08-05T00:05:00.000Z'); // from meta.endedAt
  assert.equal(flow.provenance.productVersion, '0.1.0-alpha.10');
  assert.equal(flow.provenance.successRuns, 0);
  assert.equal(flow.provenance.failStreak, 0);
  assert.equal(flow.provenance.lastHealed, null);

  // The error record (seq 6, browser_click) ends the segment at the
  // previous record and is reported as its own always-too-short,
  // always-error-truncated unit (rule 1).
  assert.deepEqual(result.report.skipped, [{ reason: 'error-truncated', seqRange: [6, 6] }]);
  assert.equal(result.report.segments, 2); // 1 flow + 1 skip
});

test('the read-only fixture (nav + GET-only click + run_code) compiles to a read-only flow', async () => {
  const sessions = await listTraceSessions(fixturesDir);
  const session = sessions.find((s) => s.dir === readOnlyDir);
  const { records } = await readTraceRecords(readOnlyDir);
  const result = compileSession({ records, meta: session.meta, traceDir: readOnlyDir });

  assert.equal(result.flows.length, 1);
  const flow = result.flows[0];

  assert.equal(flow.name, 'view-details');
  assert.equal(
    flow.description,
    'On https://example.com, this flow navigates to /dashboard, clicks "View details", runs a script.',
  );
  assert.equal(flow.origin, 'https://example.com');
  assert.equal(flow.urlPattern, '/dashboard');
  assert.equal(flow.sideEffects, 'read-only');
  assert.deepEqual(flow.args, {});
  assert.deepEqual(flow.result, { kind: 'completion', keys: [] });

  assert.equal(flow.steps.length, 3);
  assert.deepEqual(flow.steps[0], { op: 'goto', url: '/dashboard' });
  assert.equal(flow.steps[1].op, 'click');
  assert.equal(flow.steps[1].mutating, false);
  assert.deepEqual(flow.steps[1].waitAfter, { networkSettled: true }); // waits.awaitedRequests: 1
  assert.equal(flow.steps[2].op, 'js');
  assert.match(flow.steps[2].sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(flow.steps[2].args, { timeoutMs: 5000 });

  assert.deepEqual(result.report.skipped, []);
});

test('the opaque-script hostile fixture compiles a js step with sha256: null', async () => {
  const sessions = await listTraceSessions(fixturesDir);
  const session = sessions.find((s) => s.dir === hostileDir);
  const { records, skipped } = await readTraceRecords(hostileDir);
  assert.equal(skipped, 2); // invalid JSON line + v:99 line, per Task 2's reader tests

  const result = compileSession({ records, meta: session.meta, traceDir: hostileDir });

  assert.equal(result.flows.length, 1);
  const flow = result.flows[0];
  assert.equal(flow.name, 'retry');
  assert.equal(flow.sideEffects, 'read-only');
  assert.equal(flow.steps.length, 2);
  assert.equal(flow.steps[0].op, 'click');
  assert.deepEqual(flow.steps[1], { op: 'js', sha256: null, args: {} });
  assert.deepEqual(result.report.skipped, []);
});

// --- synthetic-record tests: individual rules the golden fixtures don't
// (or can't) exercise on their own ---

test('a browser_navigate that changes origin splits the session into two flows', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://a.example/page1' } }),
    record({ seq: 2, targets: [traceTarget({ name: 'Open' })] }),
    record({ seq: 3, tool: 'browser_navigate', params: { url: 'https://b.example/page2' } }),
    record({ seq: 4, targets: [traceTarget({ name: 'Close' })] }),
  ];
  const result = compileSession({ records, meta });

  assert.equal(result.flows.length, 2);
  assert.equal(result.flows[0].origin, 'https://a.example');
  assert.equal(result.flows[1].origin, 'https://b.example');
  assert.deepEqual(result.report.skipped, []);
  assert.equal(result.report.segments, 2);
});

test('fix-round-1 F4: an origin that only resolves mid-segment latches without splitting, but a later real origin change still splits', () => {
  const records = [
    // First record is not a navigate and its urlBefore/urlAfter are both
    // unparseable -- currentOrigin starts out null (unresolved), not
    // "resolved to something".
    record({
      seq: 1, urlBefore: 'not-a-url', urlAfter: 'not-a-url', targets: [traceTarget({ name: 'Start' })],
    }),
    record({ seq: 2, tool: 'browser_navigate', params: { url: 'https://a.example/page' } }), // re-latches, no split
    record({ seq: 3, targets: [traceTarget({ name: 'Mid' })] }),
    record({ seq: 4, tool: 'browser_navigate', params: { url: 'https://b.example/page' } }), // genuine change -- splits
    record({ seq: 5, targets: [traceTarget({ name: 'End' })] }),
  ];
  const result = compileSession({ records, meta });

  assert.deepEqual(result.report.skipped, []);
  assert.equal(result.flows.length, 2);
  assert.equal(result.flows[0].origin, 'https://a.example');
  assert.deepEqual(result.flows[0].provenance.seqRange, [1, 3]);
  assert.equal(result.flows[1].origin, 'https://b.example');
  assert.deepEqual(result.flows[1].provenance.seqRange, [4, 5]);
});

test('a segment with fewer than 2 action records is skipped as too-short', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
  ];
  const result = compileSession({ records, meta });

  assert.deepEqual(result.flows, []);
  assert.deepEqual(result.report.skipped, [{ reason: 'too-short', seqRange: [1, 1] }]);
});

test('an error record ends the segment at the previous record and is reported separately, mid-trace processing continues after it', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
    record({
      seq: 2, targets: [traceTarget({ name: 'Save' })], mutating: true, error: 'boom',
    }),
    record({ seq: 3, targets: [traceTarget({ name: 'Retry' })] }),
    record({ seq: 4, targets: [traceTarget({ name: 'Confirm' })] }),
  ];
  const result = compileSession({ records, meta });

  // Fix-round-1 F5: the fragment preceding the error (just the lone
  // navigate) is left too-short BY the error's truncation, so rule 1's own
  // text applies -- its reason is 'error-truncated', not the generic
  // 'too-short' a naturally-short segment would get. The error record's own
  // zero-action unit is always 'error-truncated' regardless.
  assert.deepEqual(result.report.skipped, [
    { reason: 'error-truncated', seqRange: [1, 1] }, // just the navigate, error excluded record 2
    { reason: 'error-truncated', seqRange: [2, 2] },
  ]);
  assert.equal(result.flows.length, 1);
  assert.equal(result.flows[0].origin, 'https://example.com');
  assert.deepEqual(result.flows[0].steps.map((s) => s.op), ['click', 'click']);
});

for (const tool of [
  'browser_drop',
  'browser_handle_dialog',
  'browser_navigate_back',
  'browser_evaluate',
  'browser_network_request',
]) {
  test(`a segment containing ${tool} is skipped wholesale, not just that record`, () => {
    const records = [
      record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
      record({ seq: 2, tool, params: {} }),
      record({ seq: 3, targets: [traceTarget({ name: 'Ok' })] }),
    ];
    const result = compileSession({ records, meta });
    assert.deepEqual(result.flows, []);
    assert.deepEqual(result.report.skipped, [{ reason: `unsupported: ${tool}`, seqRange: [1, 3] }]);
  });
}

test('browser_tabs with a non-list action is unsupported; action: "list" is a plain observation', () => {
  const badRecords = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
    record({ seq: 2, tool: 'browser_tabs', params: { action: 'select', index: 1 } }),
    record({ seq: 3, targets: [traceTarget({ name: 'Ok' })] }),
  ];
  assert.deepEqual(
    compileSession({ records: badRecords, meta }).report.skipped,
    [{ reason: 'unsupported: browser_tabs', seqRange: [1, 3] }],
  );

  const okRecords = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
    record({ seq: 2, tool: 'browser_tabs', params: { action: 'list' } }),
    record({ seq: 3, targets: [traceTarget({ name: 'Ok' })] }),
  ];
  const okResult = compileSession({ records: okRecords, meta });
  assert.equal(okResult.flows.length, 1);
  assert.deepEqual(okResult.report.skipped, []);
});

test('browser_select_option with more than one value skips the whole segment as unsupported: multi-select', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
    record({
      seq: 2,
      tool: 'browser_select_option',
      params: { values: ['gold', 'silver'] },
      targets: [traceTarget({ name: 'Plan', role: 'combobox' })],
    }),
    record({ seq: 3, targets: [traceTarget({ name: 'Ok' })] }),
  ];
  const result = compileSession({ records, meta });
  assert.deepEqual(result.flows, []);
  assert.deepEqual(result.report.skipped, [{ reason: 'unsupported: multi-select', seqRange: [1, 3] }]);
});

test('browser_select_option with exactly one value compiles a select step with the value lifted, and forces mutating by identity', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
    record({
      seq: 2,
      tool: 'browser_select_option',
      params: { values: ['gold'] },
      targets: [traceTarget({ name: 'Plan', role: 'combobox' })],
      mutating: false, // structurally blind per TRACE.md -- identity gating must still mark mutating
    }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  assert.equal(flow.sideEffects, 'mutating');
  const select = flow.steps.find((s) => s.op === 'select');
  assert.equal(select.value, '{plan}');
  assert.deepEqual(flow.args, { plan: { type: 'string', required: true } });
});

test('browser_wait_for with params.time compiles a wait step, value converted from seconds to milliseconds', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
    record({ seq: 2, tool: 'browser_wait_for', params: { time: 2 } }),
    record({ seq: 3, targets: [traceTarget({ name: 'Ok' })] }),
  ];
  const result = compileSession({ records, meta });
  const wait = result.flows[0].steps.find((s) => s.op === 'wait');
  assert.deepEqual(wait, { op: 'wait', value: 2000 });
});

test('browser_wait_for with only text/textGone is an observation: no step, segment continues', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
    record({ seq: 2, tool: 'browser_wait_for', params: { text: 'Loaded' } }),
    record({ seq: 3, targets: [traceTarget({ name: 'Ok' })] }),
  ];
  const result = compileSession({ records, meta });
  assert.deepEqual(result.flows[0].steps.map((s) => s.op), ['goto', 'click']);
});

test('a segment made only of observation-only waits clears the action-record threshold but produces zero steps, and is reported too-short', () => {
  const records = [
    record({ seq: 1, tool: 'browser_wait_for', params: { text: 'Loaded' } }),
    record({ seq: 2, tool: 'browser_wait_for', params: { textGone: 'Spinner' } }),
  ];
  const result = compileSession({ records, meta });
  assert.deepEqual(result.flows, []);
  assert.deepEqual(result.report.skipped, [{ reason: 'too-short', seqRange: [1, 2] }]);
});

test('browser_drag compiles target (source) and to (destination) from the two enriched targets, and forces mutating by identity', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
    record({
      seq: 2,
      tool: 'browser_drag',
      targets: [traceTarget({ name: 'Card A' }), traceTarget({ name: 'Slot 2' })],
    }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  assert.equal(flow.sideEffects, 'mutating');
  const drag = flow.steps.find((s) => s.op === 'drag');
  assert.equal(drag.target.name, 'Card A');
  assert.equal(drag.to.name, 'Slot 2');
});

test('browser_press_key compiles a press step with no target key at all (keyboard-only)', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
    record({ seq: 2, tool: 'browser_press_key', params: { key: 'Enter' } }),
  ];
  const result = compileSession({ records, meta });
  const press = result.flows[0].steps.find((s) => s.op === 'press');
  assert.equal(press.key, 'Enter');
  assert.equal(Object.hasOwn(press, 'target'), false);
});

test('literals shorter than 2 characters and the checkbox boolean strings "true"/"false" are not lifted', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
    record({
      seq: 2, tool: 'browser_type', params: { text: 'x' }, targets: [traceTarget({ name: 'Confirm' })],
    }),
    record({
      seq: 3,
      tool: 'browser_fill_form',
      params: { fields: [{ value: 'true' }] },
      targets: [traceTarget({ name: 'Subscribe', role: 'checkbox' })],
    }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  assert.deepEqual(flow.steps.filter((s) => s.op === 'fill').map((s) => s.value), ['x', 'true']);
  assert.deepEqual(flow.args, {});
});

test('fix-round-1 "ADOPTED F7": a fill literal with no nameable target is still lifted, under a positional value/value2/... fallback -- never leaked verbatim', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
    record({ seq: 2, tool: 'browser_type', params: { text: 'SecretPass123' }, targets: [] }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  assert.deepEqual(flow.args, { value: { type: 'string', required: true } });
  assert.equal(flow.steps.find((s) => s.op === 'fill').value, '{value}');
  // the raw captured literal must not appear anywhere in the compiled flow
  assert.equal(JSON.stringify(flow).includes('SecretPass123'), false);
});

test('two positional-fallback lifts in the same flow get value and value2', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
    record({ seq: 2, tool: 'browser_type', params: { text: 'first-secret' }, targets: [] }),
    record({ seq: 3, tool: 'browser_type', params: { text: 'second-secret' }, targets: [] }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  assert.deepEqual(flow.args, {
    value: { type: 'string', required: true },
    value2: { type: 'string', required: true },
  });
  assert.deepEqual(flow.steps.filter((s) => s.op === 'fill').map((s) => s.value), ['{value}', '{value2}']);
});

test('a name collision between two different literals is deduped with a numeric suffix', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
    record({
      seq: 2, tool: 'browser_type', params: { text: 'Alice' }, targets: [traceTarget({ name: 'Name' })],
    }),
    record({
      seq: 3, tool: 'browser_type', params: { text: 'Bob' }, targets: [traceTarget({ name: 'Name' })],
    }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  assert.deepEqual(flow.args, {
    name: { type: 'string', required: true },
    name2: { type: 'string', required: true },
  });
  assert.deepEqual(flow.steps.filter((s) => s.op === 'fill').map((s) => s.value), ['{name}', '{name2}']);
});

test('the same literal value under two different target labels reuses one arg instead of minting two', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
    record({
      seq: 2, tool: 'browser_type', params: { text: 'SAVE10' }, targets: [traceTarget({ name: 'Coupon' })],
    }),
    record({
      seq: 3, tool: 'browser_type', params: { text: 'SAVE10' }, targets: [traceTarget({ name: 'Promo code' })],
    }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  assert.deepEqual(flow.args, { coupon: { type: 'string', required: true } });
  assert.deepEqual(flow.steps.filter((s) => s.op === 'fill').map((s) => s.value), ['{coupon}', '{coupon}']);
});

test('a goto URL path segment matching an already-lifted fill literal is tokenized in both the step url and urlPattern', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/promo/SAVE10' } }),
    record({
      seq: 2, tool: 'browser_type', params: { text: 'SAVE10' }, targets: [traceTarget({ name: 'Coupon code' })],
    }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  assert.equal(flow.urlPattern, '/promo/:couponCode');
  assert.equal(flow.steps[0].url, '/promo/{couponCode}');
  assert.equal(flow.steps[1].value, '{couponCode}');
  assert.deepEqual(flow.args, { couponCode: { type: 'string', required: true } });
});

test('a goto URL with no matching lifted literal is left untouched in both the step url and urlPattern', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/checkout/gold' } }),
    record({
      seq: 2, tool: 'browser_type', params: { text: 'buyer@example.com' }, targets: [traceTarget({ name: 'Email' })],
    }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  assert.equal(flow.urlPattern, '/checkout/gold');
  assert.equal(flow.steps[0].url, '/checkout/gold');
});

test('a goto URL query value matching an already-lifted fill literal is tokenized (fix-round-1 F3), other query pairs untouched', () => {
  const records = [
    record({
      seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/search?q=SAVE10&sort=asc' },
    }),
    record({
      seq: 2, tool: 'browser_type', params: { text: 'SAVE10' }, targets: [traceTarget({ name: 'Coupon code' })],
    }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  assert.equal(flow.urlPattern, '/search?q=:couponCode&sort=asc');
  assert.equal(flow.steps[0].url, '/search?q={couponCode}&sort=asc');
  assert.deepEqual(flow.args, { couponCode: { type: 'string', required: true } });
});

test('a lifted literal that is a prefix of an unrelated, longer query value is not partially replaced', () => {
  const records = [
    record({
      seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/search?q=SAVE10&code=SAVE100' },
    }),
    record({
      seq: 2, tool: 'browser_type', params: { text: 'SAVE10' }, targets: [traceTarget({ name: 'Coupon code' })],
    }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  assert.equal(flow.urlPattern, '/search?q=:couponCode&code=SAVE100');
  assert.equal(flow.steps[0].url, '/search?q={couponCode}&code=SAVE100');
});

test('browser_file_upload paths are always lifted into sequential file/file2/... args, never baked as literal paths', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
    record({ seq: 2, tool: 'browser_file_upload', params: { paths: ['/tmp/a.png'] } }),
    record({ seq: 3, tool: 'browser_file_upload', params: { paths: ['/tmp/b.png'] } }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  assert.equal(flow.sideEffects, 'mutating');
  const uploads = flow.steps.filter((s) => s.op === 'upload');
  assert.deepEqual(uploads[0].files, ['{file}']);
  assert.deepEqual(uploads[1].files, ['{file2}']);
  assert.equal(Object.hasOwn(uploads[0], 'target'), false);
  assert.deepEqual(flow.args, {
    file: { type: 'string', required: true },
    file2: { type: 'string', required: true },
  });
});

test('a single browser_file_upload call with multiple paths also gets sequential file/file2/... names', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
    record({ seq: 2, tool: 'browser_file_upload', params: { paths: ['/tmp/a.png', '/tmp/b.png'] } }),
  ];
  const result = compileSession({ records, meta });
  const upload = result.flows[0].steps.find((s) => s.op === 'upload');
  assert.deepEqual(upload.files, ['{file}', '{file2}']);
});

test('an upload path routes through the same claim registry as every other lift, so it cannot collide with a pre-existing "file" arg', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
    record({
      seq: 2, tool: 'browser_type', params: { text: 'resume.pdf' }, targets: [traceTarget({ name: 'File' })],
    }),
    record({ seq: 3, tool: 'browser_file_upload', params: { paths: ['/tmp/a.png'] } }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  // The text field claims 'file' first; the upload, routed through the same
  // registry (fix-round-1 F2), must be deduped to 'file2' rather than
  // silently overwriting the text field's arg.
  assert.deepEqual(flow.args, {
    file: { type: 'string', required: true },
    file2: { type: 'string', required: true },
  });
  assert.equal(flow.steps.find((s) => s.op === 'fill').value, '{file}');
  assert.deepEqual(flow.steps.find((s) => s.op === 'upload').files, ['{file2}']);
});

test('a degraded enriched target with a resolved locator string (enrichment failure, alternates empty) falls back to a kind: "other" locator', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
    record({ seq: 2, targets: [{ ref: 'e9', resolved: "locator('div')", alternates: [] }] }),
  ];
  const result = compileSession({ records, meta });
  const click = result.flows[0].steps.find((s) => s.op === 'click');
  assert.deepEqual(click.target, { locators: [{ kind: 'other', selector: "locator('div')" }] });
});

test('a degraded enriched target with no resolved string either compiles to locators: [] with no other keys', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
    record({ seq: 2, targets: [{ ref: 'e9', alternates: [] }] }),
  ];
  const result = compileSession({ records, meta });
  const click = result.flows[0].steps.find((s) => s.op === 'click');
  assert.deepEqual(click.target, { locators: [] });
});

test('a target with non-empty alternates keeps the current verbatim mapping even if resolved is also present', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
    record({
      seq: 2,
      targets: [{
        ref: 'e9',
        resolved: "locator('div')",
        alternates: [{ kind: 'css', selector: '.item' }],
      }],
    }),
  ];
  const result = compileSession({ records, meta });
  const click = result.flows[0].steps.find((s) => s.op === 'click');
  assert.deepEqual(click.target, { locators: [{ kind: 'css', selector: '.item' }] });
});

test('flow name falls back to the origin path root when there is no click to name it after', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/reports/summary' } }),
    record({ seq: 2, tool: 'browser_press_key', params: { key: 'Enter' } }),
    record({ seq: 3, tool: 'browser_wait_for', params: { time: 1 } }),
  ];
  const result = compileSession({ records, meta });
  assert.equal(result.flows[0].name, 'reports');
});

test('flow name falls back to flow-<epochMs>-<segmentIndex> when neither a click nor a meaningful path root is available', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/' } }),
    record({ seq: 2, tool: 'browser_press_key', params: { key: 'Enter' } }),
    record({ seq: 3, tool: 'browser_wait_for', params: { time: 1 } }),
  ];
  const result = compileSession({ records, meta });
  assert.equal(result.flows[0].name, `flow-${Date.parse(meta.startedAt)}-0`);
});

test('compiledAt comes from a caller-supplied now() clock when meta.endedAt is unavailable', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
    record({ seq: 2, targets: [traceTarget({ name: 'Ok' })] }),
  ];
  const result = compileSession({
    records,
    meta: null,
    now: () => new Date('2026-02-02T00:00:00.000Z'),
  });
  assert.equal(result.flows[0].provenance.compiledAt, '2026-02-02T00:00:00.000Z');
});

test('compileSession throws CompileError when neither meta.endedAt nor a now clock is available', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
    record({ seq: 2, targets: [traceTarget({ name: 'Ok' })] }),
  ];
  assert.throws(() => compileSession({ records, meta: null }), CompileError);
});

test('report.segments counts every outcome: produced flows plus every skip', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://a.example/page' } }),
    record({ seq: 2, targets: [traceTarget({ name: 'Open' })] }), // flow 1
    record({ seq: 3, tool: 'browser_navigate', params: { url: 'https://b.example/page' } }), // too-short (alone)
  ];
  const result = compileSession({ records, meta });
  assert.equal(result.flows.length, 1);
  assert.equal(result.report.skipped.length, 1);
  assert.equal(result.report.segments, result.flows.length + result.report.skipped.length);
});

test('compileSession tolerates missing/empty input without throwing', () => {
  assert.deepEqual(compileSession({ records: [], meta }), { flows: [], report: { segments: 0, skipped: [] } });
  assert.deepEqual(compileSession({ meta }), { flows: [], report: { segments: 0, skipped: [] } });
});

// --- fix-round-1: compileSession must never throw on hostile trace input
// (F1), and must never fabricate a step from degenerate params (F8) ---

test('fix-round-1 F1: a browser_navigate to about:blank compiles to a skip, not a crash', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'about:blank' } }),
    record({ seq: 2, targets: [traceTarget({ name: 'Open' })] }),
  ];
  const result = compileSession({ records, meta });
  assert.deepEqual(result.flows, []);
  assert.equal(result.report.skipped.length, 1);
  assert.match(result.report.skipped[0].reason, /^invalid:/);
  assert.deepEqual(result.report.skipped[0].seqRange, [1, 2]);
});

test('fix-round-1 F1: a segment with no resolvable origin at all (about:blank urlBefore, present verbatim in this repo\'s own golden fixture) compiles to a skip, not a crash', () => {
  const records = [
    record({
      seq: 1, urlBefore: 'about:blank', urlAfter: 'about:blank', targets: [traceTarget({ name: 'Open' })],
    }),
    record({
      seq: 2, urlBefore: 'about:blank', urlAfter: 'about:blank', targets: [traceTarget({ name: 'Close' })],
    }),
  ];
  const result = compileSession({ records, meta });
  assert.deepEqual(result.flows, []);
  assert.match(result.report.skipped[0].reason, /^invalid:/);
});

test('fix-round-1 F1: a parseFlow rejection (negative/NaN wait_for value) lands in report.skipped, never throws', () => {
  for (const time of [-5, NaN]) {
    const records = [
      record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
      record({ seq: 2, tool: 'browser_wait_for', params: { time } }),
    ];
    const result = compileSession({ records, meta });
    assert.deepEqual(result.flows, [], String(time));
    assert.match(result.report.skipped[0].reason, /^invalid:/, String(time));
  }
});

test('fix-round-1 F1: a record with a missing seq compiles to a skip, not a crash', () => {
  const records = [
    record({ seq: undefined, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
    record({ seq: undefined, targets: [traceTarget({ name: 'Open' })] }),
  ];
  assert.doesNotThrow(() => compileSession({ records, meta }));
  const result = compileSession({ records, meta });
  assert.deepEqual(result.flows, []);
  assert.match(result.report.skipped[0].reason, /^invalid:/);
});

test('fix-round-1 "ADOPTED F8": a browser_navigate with missing params.url skips the segment as invalid, never fabricates goto /', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: {} }),
    record({ seq: 2, targets: [traceTarget({ name: 'Open' })] }),
  ];
  const result = compileSession({ records, meta });
  assert.deepEqual(result.flows, []);
  assert.deepEqual(result.report.skipped, [
    { reason: 'invalid: browser_navigate missing or unparseable params.url', seqRange: [1, 2] },
  ]);
});

test('fix-round-1 "ADOPTED F8": browser_select_option with missing/empty params.values skips the segment as invalid, never fabricates value: \'\'', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
    record({
      seq: 2,
      tool: 'browser_select_option',
      params: {},
      targets: [traceTarget({ name: 'Plan', role: 'combobox' })],
    }),
  ];
  const result = compileSession({ records, meta });
  assert.deepEqual(result.flows, []);
  assert.deepEqual(result.report.skipped, [
    { reason: 'invalid: browser_select_option missing or empty params.values', seqRange: [1, 2] },
  ]);
});

test('fix-round-1 "ADOPTED F8": browser_type with missing params.text skips the segment as invalid, never fabricates value: \'\'', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
    record({
      seq: 2, tool: 'browser_type', params: {}, targets: [traceTarget({ name: 'Email' })],
    }),
  ];
  const result = compileSession({ records, meta });
  assert.deepEqual(result.flows, []);
  assert.deepEqual(result.report.skipped, [
    { reason: 'invalid: browser_type missing params.text', seqRange: [1, 2] },
  ]);
});

test('fix-round-1 "ADOPTED F8": an empty-string fill value is not degenerate (a legitimate "clear this field") and compiles normally', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
    record({
      seq: 2, tool: 'browser_type', params: { text: '' }, targets: [traceTarget({ name: 'Email' })],
    }),
  ];
  const result = compileSession({ records, meta });
  assert.equal(result.flows.length, 1);
  assert.equal(result.flows[0].steps.find((s) => s.op === 'fill').value, '');
});

// --- remaining test gaps: the `origin` fallback option, browser_hover ---

test('the origin option seeds the flow origin when a segment has no navigate and no resolvable urlBefore/urlAfter', () => {
  const records = [
    record({
      seq: 1, urlBefore: undefined, urlAfter: undefined, targets: [traceTarget({ name: 'Open' })],
    }),
    record({
      seq: 2, urlBefore: undefined, urlAfter: undefined, targets: [traceTarget({ name: 'Close' })],
    }),
  ];
  const result = compileSession({ records, meta, origin: 'https://fallback.example' });
  assert.equal(result.flows.length, 1);
  assert.equal(result.flows[0].origin, 'https://fallback.example');
  assert.equal(result.flows[0].urlPattern, '/');
});

test('browser_hover compiles a hover step with no value, and does not force mutating (deliberately excluded from MUTATING_BY_IDENTITY)', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
    record({ seq: 2, tool: 'browser_hover', targets: [traceTarget({ name: 'Menu' })] }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  const hover = flow.steps.find((s) => s.op === 'hover');
  assert.equal(hover.op, 'hover');
  assert.equal(hover.target.name, 'Menu');
  assert.equal(Object.hasOwn(hover, 'value'), false);
  assert.equal(flow.sideEffects, 'read-only');
});
