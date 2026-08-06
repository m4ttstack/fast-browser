import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FLOW_SCHEMA_VERSION,
  FlowError,
  flowFileName,
  flowId,
  flowTier,
  parseFlow,
  serializeFlow,
} from '../../lib/flows/artifact.mjs';

// Filters out undefined-valued keys after merging overrides so callers can
// omit a field (e.g. role/name on a text-locator target) by passing
// `field: undefined` without leaving an own-key of value undefined behind
// -- Object.hasOwn(record, 'role') must see the field as absent, matching
// what JSON.stringify would do to the same literal.
function target(overrides = {}) {
  const built = {
    locators: [{ kind: 'role', selector: 'internal:role=button[name="Place order"i]' }],
    description: 'Place order',
    role: 'button',
    name: 'Place order',
    ...overrides,
  };
  return Object.fromEntries(Object.entries(built).filter(([, value]) => value !== undefined));
}

function baseFlow(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'a'.repeat(64),
    name: 'place-order',
    description: 'Fill the order form and place an order on http://localhost:4823',
    origin: 'http://localhost:4823',
    urlPattern: '/checkout/:plan',
    sideEffects: 'read-only',
    args: { customer: { type: 'string', required: true } },
    result: { kind: 'extracts', keys: ['confirmationText'] },
    steps: [
      { op: 'goto', url: '/checkout/{plan}' },
      {
        op: 'fill',
        target: target({
          locators: [{ kind: 'role', selector: 'internal:role=textbox[name="Customer"i]' }],
          description: 'Customer',
          role: 'textbox',
          name: 'Customer',
        }),
        value: '{customer}',
      },
      {
        op: 'click',
        target: target(),
        waitAfter: { networkSettled: true },
        mutating: true,
      },
      {
        op: 'expect',
        target: target({
          locators: [{ kind: 'text', selector: 'internal:text="Order placed"' }],
          description: 'Order placed',
          role: undefined,
          name: undefined,
        }),
        state: 'visible',
      },
      {
        op: 'extract',
        target: target({
          locators: [{ kind: 'css', selector: '.confirmation' }],
          description: 'Confirmation text',
          role: undefined,
          name: undefined,
        }),
        as: 'confirmationText',
      },
    ],
    provenance: {
      compiledAt: '2026-08-05T00:00:00.000Z',
      traceDir: 'trace-1754350000000',
      seqRange: [3, 9],
      productVersion: '0.1.0-alpha.10',
      successRuns: 0,
      failStreak: 0,
      lastHealed: null,
    },
    ...overrides,
  };
}

// Deterministic way to build an object whose keys are declared in the
// reverse of another object's insertion order, without hand-listing keys
// per test. Only reorders own enumerable string keys; leaves array order
// and nested values untouched, so it isolates key-order from content.
function reversedKeyOrder(value) {
  if (Array.isArray(value)) return value;
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).reverse());
}

// MAT-139 hardening: `canonicalize` (this module) already recurses into
// every nested level when computing `flowId` -- a target's own `locators`
// entries, a step's `waitAfter`, drag's `to` -- so this reorders those same
// depths rather than stopping at the target's own top-level keys, closing
// the gap between what the helper exercised and what `canonicalize` actually
// covers.
function reorderTargetDeep(targetValue) {
  if (!targetValue) return targetValue;
  const reordered = reversedKeyOrder(targetValue);
  if (Array.isArray(targetValue.locators)) {
    reordered.locators = targetValue.locators.map((locator) => reversedKeyOrder(locator));
  }
  return reordered;
}

function reorderDeep(flow) {
  return {
    ...reversedKeyOrder(flow),
    args: Object.fromEntries(
      Object.entries(flow.args).map(([key, entry]) => [key, reversedKeyOrder(entry)]),
    ),
    result: reversedKeyOrder(flow.result),
    steps: flow.steps.map((step) => {
      const reordered = reversedKeyOrder(step);
      if (step.target) reordered.target = reorderTargetDeep(step.target);
      // Drag's destination target -- distinct from `target` (the drag
      // source) -- reordered the same way rather than left untouched.
      if (step.to) reordered.to = reorderTargetDeep(step.to);
      if (step.waitAfter) reordered.waitAfter = reversedKeyOrder(step.waitAfter);
      return reordered;
    }),
    provenance: reversedKeyOrder(flow.provenance),
  };
}

// A flow whose steps exercise every shape `reorderDeep` above now reaches:
// a multi-key locator (`{kind, selector}`), a `waitAfter` object, and a
// drag step's `to` target -- `baseFlow`'s own steps are left alone since
// dozens of other tests in this file index into them by position
// (`steps[2]`, `steps.at(-1)`, ...) and inserting a step would shift those.
function flowWithDragStep(overrides = {}) {
  return baseFlow({
    steps: [
      ...baseFlow().steps,
      {
        op: 'drag',
        target: target({
          locators: [{ kind: 'role', selector: 'internal:role=listitem[name="Item"i]' }],
        }),
        to: target({
          locators: [{ kind: 'css', selector: '.drop-zone' }],
          description: 'Drop zone',
          role: undefined,
          name: undefined,
        }),
        waitAfter: { networkSettled: true },
        mutating: true,
      },
    ],
    ...overrides,
  });
}

test('parseFlow accepts a well-formed flow and round-trips through serializeFlow', () => {
  const parsed = parseFlow(baseFlow());
  const serialized = serializeFlow(parsed);
  assert.equal(typeof serialized, 'string');
  const reparsed = parseFlow(JSON.parse(serialized));
  assert.deepEqual(reparsed, parsed);
});

test('parseFlow discards nothing from a well-formed flow', () => {
  const input = baseFlow();
  const parsed = parseFlow(input);
  assert.deepEqual(parsed, input);
});

test('flowId is stable under key reordering at every level', () => {
  const original = parseFlow(flowWithDragStep());
  const reordered = reorderDeep(original);
  assert.deepEqual(reordered, original);
  assert.equal(flowId(reordered), flowId(original));
});

test('flowId is unstable under step edits', () => {
  const original = parseFlow(baseFlow());
  const edited = parseFlow(baseFlow({
    steps: [
      ...baseFlow().steps.slice(0, 1),
      { ...baseFlow().steps[1], value: '{customer}-edited' },
      ...baseFlow().steps.slice(2),
    ],
  }));
  assert.notEqual(flowId(edited), flowId(original));
});

test('flowId ignores id and provenance so replay counters do not churn identity', () => {
  const original = parseFlow(baseFlow());
  const differentId = parseFlow(baseFlow({ id: 'b'.repeat(64) }));
  const differentProvenance = parseFlow(baseFlow({
    provenance: { ...baseFlow().provenance, successRuns: 5, failStreak: 2 },
  }));
  assert.equal(flowId(differentId), flowId(original));
  assert.equal(flowId(differentProvenance), flowId(original));
});

test('flowTier is ready only for read-only flows with no js step', () => {
  assert.equal(flowTier(parseFlow(baseFlow({ sideEffects: 'read-only' }))), 'ready');
});

test('flowTier is pending when sideEffects is mutating', () => {
  const flow = baseFlow({ sideEffects: 'mutating' });
  assert.equal(flowTier(parseFlow(flow)), 'pending');
});

test('flowTier is pending when any step is a js step, even read-only', () => {
  const flow = baseFlow({
    sideEffects: 'read-only',
    steps: [...baseFlow().steps, { op: 'js', sha256: 'c'.repeat(64), args: {} }],
  });
  assert.equal(flowTier(parseFlow(flow)), 'pending');
});

test('flowTier is pending when both mutating and a js step are present', () => {
  const flow = baseFlow({
    sideEffects: 'mutating',
    steps: [...baseFlow().steps, { op: 'js', sha256: null, args: {} }],
  });
  assert.equal(flowTier(parseFlow(flow)), 'pending');
});

test('flowFileName derives from the flow name', () => {
  assert.equal(flowFileName(parseFlow(baseFlow())), 'place-order.flow.json');
  assert.equal(flowFileName(parseFlow(baseFlow({ name: 'log-in' }))), 'log-in.flow.json');
});

test('rejects unknown top-level keys, strict unlike config.mjs', () => {
  assert.throws(
    () => parseFlow({ ...baseFlow(), extraTopLevelField: true }),
    (error) => error instanceof FlowError && /extraTopLevelField/.test(error.message),
  );
});

test('rejects an unknown step op', () => {
  assert.throws(
    () => parseFlow(baseFlow({
      steps: [...baseFlow().steps, { op: 'teleport', target: target() }],
    })),
    (error) => error instanceof FlowError && /steps\[5\]\.op/.test(error.message),
  );
});

test('rejection messages name the offending path', () => {
  const broken = baseFlow();
  broken.steps[2].target.locators = 'not-an-array';
  assert.throws(
    () => parseFlow(broken),
    (error) => error instanceof FlowError && /steps\[2\]\.target\.locators/.test(error.message),
  );
});

test('rejects a goto step missing url', () => {
  const flow = baseFlow();
  delete flow.steps[0].url;
  assert.throws(() => parseFlow(flow), FlowError);
});

test('rejects a goto step whose url is not origin-relative', () => {
  const flow = baseFlow();
  flow.steps[0].url = 'http://localhost:4823/checkout/{plan}';
  assert.throws(() => parseFlow(flow), FlowError);
});

test('serializeFlow produces identical output regardless of input key order', () => {
  const original = parseFlow(baseFlow());
  const reordered = parseFlow(reorderDeep(original));
  assert.equal(serializeFlow(reordered), serializeFlow(original));
});

test('rejects unknown keys nested inside a target, not just at the top level', () => {
  const broken = baseFlow();
  broken.steps[2].target.unexpected = 'nope';
  assert.throws(
    () => parseFlow(broken),
    (error) => error instanceof FlowError && /steps\[2\]\.target\.unexpected/.test(error.message),
  );
});

test('rejects unknown keys inside a step', () => {
  const broken = baseFlow();
  broken.steps[2].bogus = true;
  assert.throws(
    () => parseFlow(broken),
    (error) => error instanceof FlowError && /steps\[2\]\.bogus/.test(error.message),
  );
});

test('rejects an unsupported schema version', () => {
  assert.throws(() => parseFlow(baseFlow({ schemaVersion: 2 })), FlowError);
});

test('FLOW_SCHEMA_VERSION is 1', () => {
  assert.equal(FLOW_SCHEMA_VERSION, 1);
});

test('rejects a malformed id', () => {
  assert.throws(() => parseFlow(baseFlow({ id: 'not-a-sha256' })), FlowError);
});

test('rejects a name that is not kebab-case', () => {
  for (const name of ['PlaceOrder', 'place_order', 'Place Order', '-place-order', 'place-order-', '']) {
    assert.throws(() => parseFlow(baseFlow({ name })), FlowError, name);
  }
});

test('rejects an origin that is not a bare origin', () => {
  for (const origin of ['http://localhost:4823/', 'http://localhost:4823/checkout', 'not-a-url', 'ftp://localhost']) {
    assert.throws(() => parseFlow(baseFlow({ origin })), FlowError, origin);
  }
});

test('rejects a urlPattern that is not origin-relative', () => {
  assert.throws(() => parseFlow(baseFlow({ urlPattern: 'checkout/:plan' })), FlowError);
});

test('rejects an unsupported sideEffects value', () => {
  assert.throws(() => parseFlow(baseFlow({ sideEffects: 'destructive' })), FlowError);
});

test('rejects an unsupported result.kind', () => {
  assert.throws(
    () => parseFlow(baseFlow({ result: { kind: 'summary', keys: [] } })),
    FlowError,
  );
});

test('rejects an unsupported arg type', () => {
  assert.throws(
    () => parseFlow(baseFlow({ args: { customer: { type: 'number', required: true } } })),
    FlowError,
  );
});

test('rejects a non-boolean arg required flag', () => {
  assert.throws(
    () => parseFlow(baseFlow({ args: { customer: { type: 'string', required: 'yes' } } })),
    FlowError,
  );
});

// MAT-149: flow-runner.js's `{arg}` substitution regex is
// `/\{([A-Za-z_][A-Za-z0-9_]*)\}/g` -- a digit-leading arg key can never
// match it, so a flow that somehow carries one (a stale compiler, a
// hand-edited/hand-authored artifact) would replay with the literal
// `{2faToken}` placeholder still in the URL rather than a real value. This
// is the other end of MAT-149's fix: the compiler now sanitizes at mint
// time (see flows-compile.test.mjs), but a pre-existing bad artifact must
// still fail loudly here rather than silently replaying wrong.
test('MAT-149: rejects a digit-leading arg key ("2faToken") instead of replaying a template the runner can never match, naming the offending key', () => {
  const flow = baseFlow({ args: { '2faToken': { type: 'string', required: true } } });
  assert.throws(
    () => parseFlow(flow),
    (error) => error instanceof FlowError && /args\.2faToken/.test(error.message),
  );
});

test('rejects an empty steps array', () => {
  assert.throws(() => parseFlow(baseFlow({ steps: [] })), FlowError);
});

test('rejects provenance with a descending seqRange', () => {
  assert.throws(
    () => parseFlow(baseFlow({
      provenance: { ...baseFlow().provenance, seqRange: [9, 3] },
    })),
    FlowError,
  );
});

test('rejects provenance with negative successRuns or failStreak', () => {
  assert.throws(
    () => parseFlow(baseFlow({
      provenance: { ...baseFlow().provenance, successRuns: -1 },
    })),
    FlowError,
  );
  assert.throws(
    () => parseFlow(baseFlow({
      provenance: { ...baseFlow().provenance, failStreak: -1 },
    })),
    FlowError,
  );
});

test('accepts a null provenance.lastHealed and a set one', () => {
  assert.equal(
    parseFlow(baseFlow({
      provenance: { ...baseFlow().provenance, lastHealed: null },
    })).provenance.lastHealed,
    null,
  );
  assert.equal(
    parseFlow(baseFlow({
      provenance: { ...baseFlow().provenance, lastHealed: '2026-08-06T00:00:00.000Z' },
    })).provenance.lastHealed,
    '2026-08-06T00:00:00.000Z',
  );
});

test('accepts a js step with a null sha256 (opaque escape step, refused only at replay)', () => {
  const flow = baseFlow({
    steps: [...baseFlow().steps, { op: 'js', sha256: null, args: { timeoutMs: 5000 } }],
  });
  const parsed = parseFlow(flow);
  assert.equal(parsed.steps.at(-1).sha256, null);
});

test('rejects a js step with a malformed sha256', () => {
  const flow = baseFlow({
    steps: [...baseFlow().steps, { op: 'js', sha256: 'not-hex', args: {} }],
  });
  assert.throws(() => parseFlow(flow), FlowError);
});

test('rejects an expect step with an unsupported state', () => {
  const broken = baseFlow();
  broken.steps[3].state = 'floating';
  assert.throws(() => parseFlow(broken), FlowError);
});

test('rejects a locator with an unsupported kind', () => {
  const broken = baseFlow();
  broken.steps[2].target.locators[0].kind = 'xpath';
  assert.throws(() => parseFlow(broken), FlowError);
});

test('accepts every locator kind in the closed set', () => {
  for (const kind of ['role', 'testid', 'text', 'css', 'other']) {
    const flow = baseFlow();
    flow.steps[2].target.locators = [{ kind, selector: 'anything' }];
    assert.doesNotThrow(() => parseFlow(flow), kind);
  }
});

test('accepts a target with no enriched locators, per the compiler fallback shape', () => {
  const flow = baseFlow();
  flow.steps[2].target = { locators: [] };
  assert.deepEqual(parseFlow(flow).steps[2].target, { locators: [] });
});

test('accepts a wait step with a bounded millisecond value', () => {
  const flow = baseFlow({ steps: [...baseFlow().steps, { op: 'wait', value: 1500 }] });
  assert.equal(parseFlow(flow).steps.at(-1).value, 1500);
});

test('rejects a wait step with a negative value', () => {
  const flow = baseFlow({ steps: [...baseFlow().steps, { op: 'wait', value: -1 }] });
  assert.throws(() => parseFlow(flow), FlowError);
});

test('accepts a press step with no target (keyboard-only)', () => {
  const flow = baseFlow({ steps: [...baseFlow().steps, { op: 'press', key: 'Enter' }] });
  assert.equal(parseFlow(flow).steps.at(-1).key, 'Enter');
});

test('rejects a press step missing key', () => {
  const flow = baseFlow({ steps: [...baseFlow().steps, { op: 'press', target: target() }] });
  assert.throws(() => parseFlow(flow), FlowError);
});

test('accepts a drag step with source and destination targets', () => {
  const flow = baseFlow({
    steps: [...baseFlow().steps, { op: 'drag', target: target(), to: target() }],
  });
  const step = parseFlow(flow).steps.at(-1);
  assert.deepEqual(step.target, target());
  assert.deepEqual(step.to, target());
});

test('rejects a drag step missing the destination target', () => {
  const flow = baseFlow({ steps: [...baseFlow().steps, { op: 'drag', target: target() }] });
  assert.throws(() => parseFlow(flow), FlowError);
});

// MAT-139: `waitAfter`/`mutating` are only ever attached via
// `withInteractionExtras`, which click/hover/fill/select/press/drag/upload
// each call -- goto, expect, extract, wait, and js never do, because none
// of them describes an interaction the trace's `mutating` flag or a
// post-action settle wait applies to. `rejectUnknownKeys` already enforces
// this per op (each op's own allowed-keys list simply omits both fields),
// but nothing pinned it until now.
test('rejects waitAfter/mutating on ops that have no per-step interaction extras', () => {
  const baseStepByOp = {
    goto: { op: 'goto', url: '/checkout/{plan}' },
    expect: { op: 'expect', target: target(), state: 'visible' },
    extract: { op: 'extract', target: target(), as: 'result' },
    wait: { op: 'wait', value: 100 },
    js: { op: 'js', sha256: null, args: {} },
  };
  const extraValueByKey = { waitAfter: { networkSettled: true }, mutating: true };

  for (const [op, step] of Object.entries(baseStepByOp)) {
    for (const [extraKey, extraValue] of Object.entries(extraValueByKey)) {
      const broken = baseFlow({ steps: [{ ...step, [extraKey]: extraValue }] });
      assert.throws(
        () => parseFlow(broken),
        (error) => error instanceof FlowError && new RegExp(`steps\\[0\\]\\.${extraKey}`).test(error.message),
        `${op}.${extraKey}`,
      );
    }
  }
});

test('accepts an upload step with a target and a non-empty files list', () => {
  const flow = baseFlow({
    steps: [...baseFlow().steps, { op: 'upload', target: target(), files: ['/tmp/a.png'] }],
  });
  const step = parseFlow(flow).steps.at(-1);
  assert.deepEqual(step.target, target());
  assert.deepEqual(step.files, ['/tmp/a.png']);
});

test('accepts an upload step with no target, since no capture path ever resolves one for this op', () => {
  const flow = baseFlow({
    steps: [...baseFlow().steps, { op: 'upload', files: ['/tmp/a.png'] }],
  });
  const step = parseFlow(flow).steps.at(-1);
  assert.equal(Object.hasOwn(step, 'target'), false);
  assert.deepEqual(step.files, ['/tmp/a.png']);
});

test('rejects an upload step with an empty files list', () => {
  const flow = baseFlow({
    steps: [...baseFlow().steps, { op: 'upload', target: target(), files: [] }],
  });
  assert.throws(() => parseFlow(flow), FlowError);
});

test('accepts a select step', () => {
  const flow = baseFlow({
    steps: [...baseFlow().steps, { op: 'select', target: target(), value: 'gold' }],
  });
  assert.equal(parseFlow(flow).steps.at(-1).value, 'gold');
});

test('accepts a hover step', () => {
  const flow = baseFlow({ steps: [...baseFlow().steps, { op: 'hover', target: target() }] });
  assert.equal(parseFlow(flow).steps.at(-1).op, 'hover');
});

test('rejects a non-object flow value', () => {
  for (const value of [null, undefined, 'flow', 42, []]) {
    assert.throws(() => parseFlow(value), FlowError, JSON.stringify(value));
  }
});

test('rejects a step that is not an object', () => {
  const flow = baseFlow({ steps: [...baseFlow().steps, 'not-a-step'] });
  assert.throws(() => parseFlow(flow), FlowError);
});

test('rejects an args entry with unknown keys', () => {
  const flow = baseFlow({
    args: { customer: { type: 'string', required: true, extra: true } },
  });
  assert.throws(
    () => parseFlow(flow),
    (error) => error instanceof FlowError && /args\.customer\.extra/.test(error.message),
  );
});

test('rejects provenance with unknown keys', () => {
  const flow = baseFlow({
    provenance: { ...baseFlow().provenance, extra: true },
  });
  assert.throws(
    () => parseFlow(flow),
    (error) => error instanceof FlowError && /provenance\.extra/.test(error.message),
  );
});

test('rejects a "__proto__" arg key instead of silently dropping it via prototype-pollution assignment', () => {
  // JSON.parse (unlike an object literal or bracket assignment) always
  // produces a genuine own key here -- this is exactly the shape a
  // malicious or corrupted flow file delivers on the wire, not an
  // already-corrupted prototype.
  const polluted = JSON.parse(
    '{"customer":{"type":"string","required":true},"__proto__":{"type":"string","required":true}}',
  );
  assert.equal(Object.getPrototypeOf(polluted), Object.prototype);
  assert.deepEqual(Object.keys(polluted).sort(), ['__proto__', 'customer']);

  const flow = baseFlow({ args: polluted });
  assert.throws(
    () => parseFlow(flow),
    (error) => error instanceof FlowError && /args\.__proto__/.test(error.message),
  );

  // No global corruption as a side effect of the rejected attempt: a
  // fresh plain object still inherits the real Object.prototype.
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
});
