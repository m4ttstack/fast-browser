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
    args: { timeoutMs: '<REDACTED: captured value not stored>' }, // I2: keys kept, values redacted
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
  assert.deepEqual(flow.steps[2].args, { timeoutMs: '<REDACTED: captured value not stored>' }); // I2

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

test('fix-round-2 N3: browser_wait_for with a present but non-finite-number time (e.g. a string) is invalid, never silently dropped', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
    record({ seq: 2, tool: 'browser_wait_for', params: { time: '2' } }),
  ];
  const result = compileSession({ records, meta });
  assert.deepEqual(result.flows, []);
  assert.deepEqual(result.report.skipped, [
    { reason: 'invalid: browser_wait_for has a non-finite params.time', seqRange: [1, 2] },
  ]);
});

test('fix-round-2 N3: browser_wait_for with time absent entirely (only text/textGone) still stays a plain observation, not invalid', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
    record({ seq: 2, tool: 'browser_wait_for', params: { textGone: 'Spinner' } }),
    record({ seq: 3, targets: [traceTarget({ name: 'Ok' })] }),
  ];
  const result = compileSession({ records, meta });
  assert.equal(result.flows.length, 1);
  assert.deepEqual(result.report.skipped, []);
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

// --- final whole-branch review, I1: browser_press_key is telemetry-blind
// for every key except plain 'Enter' -- the runtime only routes an Enter
// press through its network-observation wait, so any other key's own
// `record.mutating`/`network` always read false/[] by construction. A press
// key other than exactly 'Enter' must therefore be treated as
// mutating-by-identity regardless of what its own record says. ---

test('I1: a press key other than plain Enter is treated as mutating-by-identity even though its own record is telemetry-blind (mutating: false, network: [])', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
    record({ seq: 2, tool: 'browser_press_key', params: { key: 'e' } }),
  ];
  const result = compileSession({ records, meta });
  assert.equal(result.flows[0].sideEffects, 'mutating');
});

test('I1: a plain Enter press with mutating: false and GET-only network stays read-only -- its own telemetry is trustworthy', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
    record({
      seq: 2,
      tool: 'browser_press_key',
      params: { key: 'Enter' },
      mutating: false,
      network: [{ method: 'GET', url: 'https://example.com/api/search' }],
    }),
  ];
  const result = compileSession({ records, meta });
  assert.equal(result.flows[0].sideEffects, 'read-only');
});

test('I1: a plain Enter press with mutating: true (a network-observed POST) is mutating -- its structural flag still passes through', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
    record({
      seq: 2,
      tool: 'browser_press_key',
      params: { key: 'Enter' },
      mutating: true,
      network: [{ method: 'POST', url: 'https://example.com/api/submit' }],
    }),
  ];
  const result = compileSession({ records, meta });
  assert.equal(result.flows[0].sideEffects, 'mutating');
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

// --- final whole-branch review, I2: buildJsStep must never copy
// record.script.args verbatim into the artifact -- these are password-class
// captured values with zero replay utility (the flow-runner refuses every
// js step in v1), so a raw echo leaks a captured secret to disk (every
// compiled flow is persisted) and to the terminal (every `flows find`
// invocation echoes it). ---

test('I2: a js-step script arg value is redacted; the raw captured secret never appears anywhere in the serialized flow', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
    record({
      seq: 2,
      tool: 'browser_run_code_unsafe',
      script: { sha256: 'a'.repeat(64), args: { password: 'hunter2', username: 'alice' } },
    }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  const js = flow.steps.find((s) => s.op === 'js');
  // keys survive (shape stays legible); every value is the placeholder
  assert.deepEqual(js.args, {
    password: '<REDACTED: captured value not stored>',
    username: '<REDACTED: captured value not stored>',
  });
  assert.equal(JSON.stringify(flow).includes('hunter2'), false);
  assert.equal(JSON.stringify(flow).includes('alice'), false);
});

test('I2: non-object script.args (absent or positional) redacts to an empty set -- the segment still compiles and no captured value survives', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
    record({
      seq: 2,
      tool: 'browser_run_code_unsafe',
      script: { sha256: 'b'.repeat(64), args: ['positional', 'secret-value'] },
    }),
  ];
  const result = compileSession({ records, meta });
  assert.equal(result.flows.length, 1);
  const jsStep = result.flows[0].steps.find((step) => step.op === 'js');
  assert.deepEqual(jsStep.args, {});
  assert.equal(JSON.stringify(result.flows[0]).includes('secret-value'), false);
});

test('I2: a script recorded with no args at all compiles with args {} (the common no-args run_code shape must not skip)', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
    record({
      seq: 2,
      tool: 'browser_run_code_unsafe',
      script: { sha256: 'c'.repeat(64) },
    }),
  ];
  const result = compileSession({ records, meta });
  assert.equal(result.flows.length, 1);
  assert.deepEqual(result.flows[0].steps.find((step) => step.op === 'js').args, {});
  assert.deepEqual(result.report.skipped, []);
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

test('a goto URL query value matching an already-lifted fill literal is tokenized in the step url; urlPattern stays path-only (fix-round-2 N1)', () => {
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
  // urlPattern is for retrieval matching (Task 6, path-only convention) --
  // the tokenized query lives only in the step's own replay url.
  assert.equal(flow.urlPattern, '/search');
  assert.equal(flow.steps[0].url, '/search?q={couponCode}&sort=asc');
  assert.deepEqual(flow.args, { couponCode: { type: 'string', required: true } });
});

test('a lifted literal that is a prefix of an unrelated, longer query value is not partially replaced', () => {
  // MAT-136 task 7: the unrelated param uses key "ref" rather than "code"
  // here -- "code" is now a sensitive query key (SENSITIVE_QUERY_KEY) and
  // would legitimately lift "SAVE100" on its own, which would defeat this
  // test's actual point (substring-safety of the pre-existing lifted-
  // literal match, unrelated to the new sensitivity feature).
  const records = [
    record({
      seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/search?q=SAVE10&ref=SAVE100' },
    }),
    record({
      seq: 2, tool: 'browser_type', params: { text: 'SAVE10' }, targets: [traceTarget({ name: 'Coupon code' })],
    }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  assert.equal(flow.urlPattern, '/search');
  assert.equal(flow.steps[0].url, '/search?q={couponCode}&ref=SAVE100');
});

test('fix-round-2 N1: a query-bearing nav with no click names from the path root only, urlPattern excludes the query entirely', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/search?q=widgets' } }),
    record({ seq: 2, tool: 'browser_press_key', params: { key: 'Enter' } }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  assert.equal(flow.name, 'search'); // tier-2 path-root fallback, not 'search?q=:query'-derived
  assert.equal(flow.urlPattern, '/search');
  assert.equal(flow.steps[0].url, '/search?q=widgets');
});

// --- MAT-136 folded debt (Task 7): sensitive goto URL values (never seen
// in a fill/select) lift into required args instead of baking verbatim
// into the compiled artifact -- see the module-level Task 7 note in
// compile.mjs above `SENSITIVE_QUERY_KEY` for the full rule. ---

test('MAT-136 task 7: a sensitive query key ("token") lifts its never-filled value into a required arg; name still derives from the clean path root (N1 guard)', () => {
  const records = [
    record({
      seq: 1,
      tool: 'browser_navigate',
      params: { url: 'https://example.com/reset?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' },
    }),
    record({ seq: 2, tool: 'browser_press_key', params: { key: 'Enter' } }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  // N1 guard: a sensitive query lift must never contaminate urlPattern or
  // tier-2 naming -- the flow still names from the clean path root, and
  // urlPattern stays path-only, exactly as an ordinary (non-sensitive)
  // query-bearing nav does today.
  assert.equal(flow.name, 'reset');
  assert.equal(flow.urlPattern, '/reset');
  assert.equal(flow.steps[0].url, '/reset?token={token}');
  assert.deepEqual(flow.args, { token: { type: 'string', required: true } });
  assert.equal(JSON.stringify(flow).includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'), false);
});

test('MAT-136 task 7: a high-entropy path segment lifts into a positional-fallback arg (no query key to name from)', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/magic/dGhpc2lzYXNlY3JldDEyMw' } }),
    record({ seq: 2, tool: 'browser_press_key', params: { key: 'Enter' } }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  assert.equal(flow.urlPattern, '/magic/:value');
  assert.equal(flow.steps[0].url, '/magic/{value}');
  assert.deepEqual(flow.args, { value: { type: 'string', required: true } });
  assert.equal(JSON.stringify(flow).includes('dGhpc2lzYXNlY3JldDEyMw'), false);
});

test('MAT-136 task 7: a short numeric path segment ("/orders/42") is not sensitive and is left untouched', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/orders/42' } }),
    record({ seq: 2, tool: 'browser_press_key', params: { key: 'Enter' } }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  assert.equal(flow.urlPattern, '/orders/42');
  assert.equal(flow.steps[0].url, '/orders/42');
  assert.deepEqual(flow.args, {});
});

test('MAT-136 task 7: an ordinary query value under a non-sensitive key ("q") is left untouched', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/search?q=widgets' } }),
    record({ seq: 2, tool: 'browser_press_key', params: { key: 'Enter' } }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  assert.equal(flow.steps[0].url, '/search?q=widgets');
  assert.deepEqual(flow.args, {});
});

test('MAT-136 task 7: a sensitive query key with a SHORT value ("?code=abc123") still lifts -- the key rule alone is sufficient', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/verify?code=abc123' } }),
    record({ seq: 2, tool: 'browser_press_key', params: { key: 'Enter' } }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  assert.equal(flow.steps[0].url, '/verify?code={code}');
  assert.deepEqual(flow.args, { code: { type: 'string', required: true } });
});

test('MAT-136 task 7: a value already lifted from a fill reuses that arg name in a goto URL rather than re-lifting under the query-key/positional name', () => {
  const records = [
    record({
      seq: 1,
      tool: 'browser_navigate',
      params: { url: 'https://example.com/confirm?token=abcDEF1234567890ghijK' },
    }),
    record({
      seq: 2,
      tool: 'browser_type',
      params: { text: 'abcDEF1234567890ghijK' },
      targets: [traceTarget({ name: 'Confirmation code' })],
    }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  assert.deepEqual(flow.args, { confirmationCode: { type: 'string', required: true } });
  assert.equal(flow.steps[0].url, '/confirm?token={confirmationCode}');
});

// --- MAT-136 task 7, fix round 1: F1 (fragment lifting), F2 (key-branch
// eligibility guard), F3 (hyphenated-slug false positives), F5 (entropy
// boundary pins) ---

test('MAT-136 task 7 fix round 1, F1: an OAuth-implicit-grant redirect (#access_token=... in the fragment) lifts the token instead of baking it verbatim into the step url and description', () => {
  const accessToken = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const records = [
    record({
      seq: 1,
      tool: 'browser_navigate',
      params: { url: `https://example.com/callback#access_token=${accessToken}&token_type=Bearer&expires_in=3600` },
    }),
    record({ seq: 2, tool: 'browser_press_key', params: { key: 'Enter' } }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  // "access_token" is not an exact SENSITIVE_QUERY_KEY match, so this
  // lifts purely on the value's own entropy; "token_type"/"expires_in"
  // stay literal (neither a sensitive key nor a high-entropy value).
  assert.deepEqual(flow.args, { accessToken: { type: 'string', required: true } });
  assert.equal(flow.steps[0].url, '/callback#access_token={accessToken}&token_type=Bearer&expires_in=3600');
  assert.ok(flow.description.includes('navigates to /callback#access_token={accessToken}'));
  assert.equal(JSON.stringify(flow).includes(accessToken), false);
});

test('MAT-136 task 7 fix round 1, F1: a value already lifted from the query is reused for an identical value in the fragment -- ONE deduped arg, both occurrences substituted', () => {
  const records = [
    record({
      seq: 1,
      tool: 'browser_navigate',
      params: { url: 'https://example.com/confirm?token=abcDEF1234567890ghijK#t=abcDEF1234567890ghijK' },
    }),
    record({ seq: 2, tool: 'browser_press_key', params: { key: 'Enter' } }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  assert.deepEqual(flow.args, { token: { type: 'string', required: true } });
  assert.equal(flow.steps[0].url, '/confirm?token={token}#t={token}');
});

test('MAT-136 task 7 fix round 1, F1: a bare (non key=value) high-entropy fragment value lifts as a positional-fallback arg', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/app#dGhpc2lzYXNlY3JldDEyMw' } }),
    record({ seq: 2, tool: 'browser_press_key', params: { key: 'Enter' } }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  assert.deepEqual(flow.args, { value: { type: 'string', required: true } });
  assert.equal(flow.steps[0].url, '/app#{value}');
});

test('MAT-136 task 7 round-2 S4: an empty-key fragment pair ("#=<token>") lifts the value, mirroring the query tokenizer\'s "?=<token>" handling', () => {
  const secret = 'abcDEF1234567890ghijK';
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: `https://example.com/cb#=${secret}` } }),
    record({ seq: 2, tool: 'browser_press_key', params: { key: 'Enter' } }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  assert.deepEqual(flow.args, { value: { type: 'string', required: true } });
  assert.equal(flow.steps[0].url, '/cb#={value}');
  assert.equal(JSON.stringify(flow).includes(secret), false);
});

test('MAT-136 task 7 fix round 1, F1: a plain in-page anchor ("#overview") stays literal -- no special-case anchor detection needed', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/docs#overview' } }),
    record({ seq: 2, tool: 'browser_press_key', params: { key: 'Enter' } }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  assert.equal(flow.steps[0].url, '/docs#overview');
  assert.deepEqual(flow.args, {});
});

test('MAT-136 task 7 fix round 1, F2: a too-short value under a sensitive query key does not lift, and so cannot cross-contaminate a later, unrelated URL with the same short literal', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/verify?code=a' } }),
    record({ seq: 2, tool: 'browser_navigate', params: { url: 'https://example.com/a/list' } }),
    record({ seq: 3, tool: 'browser_press_key', params: { key: 'Enter' } }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  assert.equal(flow.steps[0].url, '/verify?code=a');
  assert.equal(flow.steps[1].url, '/a/list');
  assert.deepEqual(flow.args, {});
});

test('MAT-136 task 7 fix round 1, F3: hyphenated human-authored slugs are not high-entropy and stay fully literal', () => {
  const shapes = [
    '/blog/top-10-things-to-do-in-2026',
    '/p/nike-air-max-270-black',
    '/archive/2024-01-15-release-notes',
    '/downloads/annual-report-2024.pdf',
  ];
  for (const path of shapes) {
    const records = [
      record({ seq: 1, tool: 'browser_navigate', params: { url: `https://example.com${path}` } }),
      record({ seq: 2, tool: 'browser_press_key', params: { key: 'Enter' } }),
    ];
    const result = compileSession({ records, meta });
    const flow = result.flows[0];
    assert.equal(flow.steps[0].url, path, path);
    assert.deepEqual(flow.args, {}, path);
  }
});

test('MAT-136 task 7 fix round 1, F3: a dotted JWT (0-1 hyphens) still lifts despite the tightened hyphen discriminator', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: `https://example.com/session/${jwt}` } }),
    record({ seq: 2, tool: 'browser_press_key', params: { key: 'Enter' } }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  assert.deepEqual(flow.args, { value: { type: 'string', required: true } });
  assert.equal(flow.steps[0].url, '/session/{value}');
});

test('MAT-136 task 7 fix round 1, F5: a 19-char alphanumeric value (one under the length floor) is not high-entropy and stays literal', () => {
  const value = 'a1b2c3d4e5f6g7h8i9j'; // len 19, letter+digit, no hyphens
  assert.equal(value.length, 19);
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: `https://example.com/x/${value}` } }),
    record({ seq: 2, tool: 'browser_press_key', params: { key: 'Enter' } }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  assert.equal(flow.steps[0].url, `/x/${value}`);
  assert.deepEqual(flow.args, {});
});

test('MAT-136 task 7 fix round 1, F5: a 30-char all-letters value (no digit) is not high-entropy and stays literal', () => {
  const value = 'abcdefghijklmnopqrstuvwxyzabcd'; // len 30, letters only
  assert.equal(value.length, 30);
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: `https://example.com/x/${value}` } }),
    record({ seq: 2, tool: 'browser_press_key', params: { key: 'Enter' } }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  assert.equal(flow.steps[0].url, `/x/${value}`);
  assert.deepEqual(flow.args, {});
});

test('MAT-136 task 7 fix round 1, F5: a 24-char all-digits value (no letter) is not high-entropy and stays literal', () => {
  const value = '123456789012345678901234'; // len 24, digits only
  assert.equal(value.length, 24);
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: `https://example.com/x/${value}` } }),
    record({ seq: 2, tool: 'browser_press_key', params: { key: 'Enter' } }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  assert.equal(flow.steps[0].url, `/x/${value}`);
  assert.deepEqual(flow.args, {});
});

// --- MAT-136 task 7, fix round 2: N1 (UUID hyphen exemption), N3 (fragment
// classification, per-part rather than whole-fragment) ---

test('MAT-136 task 7 fix round 2, N1: a canonical UUID path segment lifts regardless of its four hyphens (the magic-link/reset shape the F3 hyphen discriminator regressed)', () => {
  const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: `https://example.com/reset/${uuid}` } }),
    record({ seq: 2, tool: 'browser_press_key', params: { key: 'Enter' } }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  assert.equal(flow.urlPattern, '/reset/:value');
  assert.equal(flow.steps[0].url, '/reset/{value}');
  assert.deepEqual(flow.args, { value: { type: 'string', required: true } });
  assert.equal(JSON.stringify(flow).includes(uuid), false);
});

test('MAT-136 task 7 fix round 2, N1: a canonical UUID as a bare fragment value also lifts', () => {
  const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: `https://example.com/magic#${uuid}` } }),
    record({ seq: 2, tool: 'browser_press_key', params: { key: 'Enter' } }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  assert.deepEqual(flow.args, { value: { type: 'string', required: true } });
  assert.equal(flow.steps[0].url, '/magic#{value}');
});

test('MAT-136 task 7 fix round 2, N1: the four F3 hyphenated-slug shapes still stay literal -- the UUID exemption is a narrow, rigid-shape match and does not reopen F3', () => {
  const shapes = [
    '/blog/top-10-things-to-do-in-2026',
    '/p/nike-air-max-270-black',
    '/archive/2024-01-15-release-notes',
    '/downloads/annual-report-2024.pdf',
  ];
  for (const path of shapes) {
    const records = [
      record({ seq: 1, tool: 'browser_navigate', params: { url: `https://example.com${path}` } }),
      record({ seq: 2, tool: 'browser_press_key', params: { key: 'Enter' } }),
    ];
    const result = compileSession({ records, meta });
    const flow = result.flows[0];
    assert.equal(flow.steps[0].url, path, path);
    assert.deepEqual(flow.args, {}, path);
  }
});

test('MAT-136 task 7 fix round 2, N3: a padded-base64 fragment value now correctly routes to the bare branch, but still can\'t lift on entropy -- the F4 residual extends to fragments (documented, not fixed)', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/share#dGhpc2lzYXNlY3JldDEyMzQ1Njc4OTA=' } }),
    record({ seq: 2, tool: 'browser_press_key', params: { key: 'Enter' } }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  assert.equal(flow.steps[0].url, '/share#dGhpc2lzYXNlY3JldDEyMzQ1Njc4OTA=');
  assert.deepEqual(flow.args, {});
});

test('MAT-136 task 7 fix round 2, N3: a "<high-entropy-token>=x" shaped fragment is textually ambiguous (real pair vs. a bare value with junk appended) and stays literal rather than guessing -- no crash, no partial output', () => {
  const records = [
    record({ seq: 1, tool: 'browser_navigate', params: { url: 'https://example.com/share#abcDEF1234567890ghijKLMN=x' } }),
    record({ seq: 2, tool: 'browser_press_key', params: { key: 'Enter' } }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  assert.equal(flow.steps[0].url, '/share#abcDEF1234567890ghijKLMN=x');
  assert.deepEqual(flow.args, {});
});

test('MAT-136 task 7 fix round 2, N3: the discriminating case -- a bare high-entropy value mixed with a real pair in the same fragment now lifts BOTH (round-1 code lifted only the pair, never entropy-checking the bare part)', () => {
  const accessToken = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const bareToken = 'ZZ11xx22yy33zz44AA55BB66CC77DD1';
  const records = [
    record({
      seq: 1,
      tool: 'browser_navigate',
      params: { url: `https://example.com/callback#access_token=${accessToken}&${bareToken}` },
    }),
    record({ seq: 2, tool: 'browser_press_key', params: { key: 'Enter' } }),
  ];
  const result = compileSession({ records, meta });
  const flow = result.flows[0];
  assert.deepEqual(flow.args, {
    accessToken: { type: 'string', required: true },
    value: { type: 'string', required: true },
  });
  assert.equal(flow.steps[0].url, '/callback#access_token={accessToken}&{value}');
  assert.equal(JSON.stringify(flow).includes(accessToken), false);
  assert.equal(JSON.stringify(flow).includes(bareToken), false);
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
  // Fix-round-2 N2: a non-finite seq renders as `null` in seqRange, not a
  // bare JS `undefined` sitting in the array.
  assert.deepEqual(result.report.skipped[0].seqRange, [null, null]);
});

test('fix-round-2 N2: a missing seq on a naturally-too-short segment also renders seqRange as [null, null]', () => {
  const records = [
    record({ seq: undefined, tool: 'browser_navigate', params: { url: 'https://example.com/app' } }),
  ];
  const result = compileSession({ records, meta });
  assert.deepEqual(result.report.skipped, [{ reason: 'too-short', seqRange: [null, null] }]);
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

// The no-navigate fallback (`resolveOriginAndPattern`, no `browser_navigate`
// record in the segment at all) used to build `urlPattern` from the first
// record's raw `urlBefore`/`urlAfter` pathname -- bypassing Task 7's
// sensitive-value lifting entirely, since that lifting only ran inside
// `tokenizePath`/`buildGotoStep` on the goto path. A segment that happens
// to START on a token-bearing URL with no navigate of its own (e.g. the
// user was already on a password-reset link when the capture began) would
// therefore bake the token into `urlPattern` verbatim. This routes the
// fallback pathname through the SAME `tokenizePath` the goto path uses.
test('a no-navigate segment starting on a token-bearing URL collapses the token out of urlPattern and out of the flow bytes', () => {
  const token = 'aB3fG7kL9mN2pQ5rS8tU1vW4'; // 24 chars, high-entropy per isHighEntropyValue
  const url = `https://example.com/reset/${token}`;
  const records = [
    record({
      seq: 1, urlBefore: url, urlAfter: url, targets: [traceTarget({ name: 'Confirm' })],
    }),
    record({
      seq: 2, urlBefore: url, urlAfter: url, targets: [traceTarget({ name: 'Cancel' })],
    }),
  ];
  const result = compileSession({ records, meta });
  assert.equal(result.flows.length, 1);
  const flow = result.flows[0];
  assert.equal(flow.origin, 'https://example.com');
  assert.equal(flow.urlPattern, '/reset/:value');
  assert.deepEqual(flow.args, { value: { type: 'string', required: true } });
  assert.equal(JSON.stringify(flow).includes(token), false);
});

// Regression guard for the fix above: an ORDINARY no-navigate segment (no
// sensitive segment in the fallback pathname) must keep its literal
// pattern -- the new tokenizePath call must be a no-op here, same as it is
// on the goto path for non-sensitive segments.
test('a no-navigate segment starting on an ordinary URL ("/dashboard") keeps its literal urlPattern', () => {
  const records = [
    record({
      seq: 1, urlBefore: 'https://example.com/dashboard', urlAfter: 'https://example.com/dashboard', targets: [traceTarget({ name: 'Open' })],
    }),
    record({
      seq: 2, urlBefore: 'https://example.com/dashboard', urlAfter: 'https://example.com/dashboard', targets: [traceTarget({ name: 'Close' })],
    }),
  ];
  const result = compileSession({ records, meta });
  assert.equal(result.flows.length, 1);
  const flow = result.flows[0];
  assert.equal(flow.origin, 'https://example.com');
  assert.equal(flow.urlPattern, '/dashboard');
  assert.deepEqual(flow.args, {});
});

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
