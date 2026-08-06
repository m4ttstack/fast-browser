import assert from 'node:assert/strict';
import test from 'node:test';

import { encoderRanker, ENCODER_MIN_MARGIN, ENCODER_MIN_SCORE } from '../../lib/flows/encoder.mjs';
import {
  applyHeal,
  HEAL_MIN_MARGIN,
  HEAL_MIN_SCORE,
  parseFailurePayload,
  proposeHeal,
  rankCandidates,
  ROLE_MATCH_BONUS,
  TOKEN_OVERLAP_WEIGHT,
} from '../../lib/flows/heal.mjs';

const FAILURE_PREFIX = 'FLOW_RUNNER_FAILURE: ';

// --- fixtures ---

function baseTarget(overrides = {}) {
  const built = {
    locators: [{ kind: 'role', selector: 'internal:role=button[name="Place order"i]' }],
    description: 'Place order',
    role: 'button',
    name: 'Place order',
    ...overrides,
  };
  return Object.fromEntries(Object.entries(built).filter(([, value]) => value !== undefined));
}

// steps[0] goto (not locator-bearing), steps[1] click (the healable step
// every proposeHeal/applyHeal test targets), steps[2] drag (locator-bearing
// TWO targets -- deliberately excluded, see heal.mjs's own doc comment).
function baseFlow(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'a'.repeat(64),
    name: 'place-order',
    description: 'Fill the order form and place an order',
    origin: 'http://localhost:4823',
    urlPattern: '/checkout',
    sideEffects: 'mutating',
    args: {},
    result: { kind: 'completion', keys: [] },
    steps: [
      { op: 'goto', url: '/checkout' },
      { op: 'click', target: baseTarget(), mutating: true },
      {
        op: 'drag',
        target: baseTarget({ description: 'Drag handle', name: 'Handle', role: 'slider' }),
        to: baseTarget({ description: 'Drop zone', name: 'Zone', role: 'region' }),
      },
    ],
    provenance: {
      compiledAt: '2026-08-05T00:00:00.000Z',
      traceDir: 'trace-1',
      seqRange: [0, 3],
      productVersion: '0.1.0',
      successRuns: 0,
      failStreak: 1,
      lastHealed: null,
    },
    ...overrides,
  };
}

function candidate(overrides = {}) {
  return { role: '', name: '', testid: '', text: '', ...overrides };
}

function payloadFor(flow, stepIndex, candidates, extra = {}) {
  return {
    failedStep: stepIndex,
    error: 'no locator candidate matched',
    url: flow.origin,
    stepsCompleted: stepIndex,
    locatorFallbacks: [],
    candidates,
    ...extra,
  };
}

// ============================================================
// Step 1: parseFailurePayload
// ============================================================

test('parseFailurePayload parses a well-formed FLOW_RUNNER_FAILURE payload', () => {
  const payload = {
    failedStep: 2,
    error: 'no locator candidate matched',
    url: 'http://localhost:4823/checkout',
    stepsCompleted: 2,
    locatorFallbacks: [{ step: 1, usedKind: 'role', usedIndex: 1 }],
    candidates: [candidate({ role: 'button', name: 'Submit', testid: 'submit-v2', text: 'Submit order' })],
  };
  const errorString = `${FAILURE_PREFIX}${JSON.stringify(payload)}`;

  assert.deepEqual(parseFailurePayload(errorString), payload);
});

test('parseFailurePayload recovers the last complete candidate object from a truncated tail', () => {
  const payload = {
    failedStep: 2,
    error: 'no locator candidate matched',
    url: 'http://localhost:4823/checkout',
    stepsCompleted: 2,
    locatorFallbacks: [],
    candidates: [
      candidate({ role: 'button', name: 'Submit', testid: 'submit-v2', text: 'Submit order' }),
      candidate({ role: 'link', name: 'Help', text: 'Need help getting started?' }),
    ],
  };
  const fullText = `${FAILURE_PREFIX}${JSON.stringify(payload)}`;
  // Cut mid-way through the second candidate's "text" string value -- the
  // first candidate object is fully written by this point.
  const cutPoint = fullText.indexOf('Need help') + 4;
  const truncated = fullText.slice(0, cutPoint);
  assert.ok(truncated.length < fullText.length, 'test setup: truncated text really is shorter');

  const recovered = parseFailurePayload(truncated);

  assert.deepEqual(recovered, {
    ...payload,
    candidates: [payload.candidates[0]],
  });
});

test('parseFailurePayload drops the whole candidates key when no candidate object survives truncation', () => {
  const payload = {
    failedStep: 2,
    error: 'no locator candidate matched',
    url: 'http://localhost:4823/checkout',
    stepsCompleted: 2,
    locatorFallbacks: [],
    candidates: [candidate({ role: 'button', name: 'Submit', testid: 'submit-v2', text: 'Submit order' })],
  };
  const fullText = `${FAILURE_PREFIX}${JSON.stringify(payload)}`;
  // Cut inside the FIRST candidate object -- zero complete candidates.
  const cutPoint = fullText.indexOf('"role":"button"') + 5;
  const truncated = fullText.slice(0, cutPoint);

  const recovered = parseFailurePayload(truncated);

  assert.equal(recovered.failedStep, payload.failedStep);
  assert.equal(recovered.error, payload.error);
  assert.equal(recovered.stepsCompleted, payload.stepsCompleted);
  assert.deepEqual(recovered.locatorFallbacks, []);
  assert.equal(Object.hasOwn(recovered, 'candidates'), false);
});

test('parseFailurePayload returns null for garbage, non-object JSON, and truncation before the candidates key', () => {
  assert.equal(parseFailurePayload(`${FAILURE_PREFIX}{not valid json at all`), null);
  assert.equal(parseFailurePayload(`${FAILURE_PREFIX}[1,2,3]`), null);
  assert.equal(parseFailurePayload(`${FAILURE_PREFIX}"just a string"`), null);

  // Truncated before the recoverable "candidates" tail is ever reached --
  // nothing in this module knows how to repair that, so it returns null
  // rather than guessing.
  const fullText = `${FAILURE_PREFIX}${JSON.stringify(payloadFor(baseFlow(), 1, [candidate({ name: 'x' })]))}`;
  const truncated = fullText.slice(0, fullText.indexOf('"locatorFallbacks"') + 5);
  assert.equal(parseFailurePayload(truncated), null);
});

test('parseFailurePayload returns null when the marker never occurs, and tolerates non-string input', () => {
  assert.equal(parseFailurePayload('some other error: {"failedStep":0}'), null);
  assert.equal(parseFailurePayload(''), null);
  assert.equal(parseFailurePayload(null), null);
  assert.equal(parseFailurePayload(undefined), null);
  assert.equal(parseFailurePayload(42), null);
});

// Task 9 e2e finding (fix round): the trace-capture runtime records
// `record.error` as `String(error)`, which prepends the thrown Error's own
// `name` ahead of this macro's message -- `"Error: FLOW_RUNNER_FAILURE:
// {...}"` in practice, never the bare `"FLOW_RUNNER_FAILURE: {...}"` a
// position-0 check would require. `parseFailurePayload` locates the marker
// via `indexOf` specifically so this real wrapper still parses.
test('parseFailurePayload parses the "Error: "-wrapped form the real trace-capture runtime records', () => {
  const payload = {
    failedStep: 7,
    error: 'no locator candidate matched',
    url: 'http://127.0.0.1:1/',
    stepsCompleted: 7,
    locatorFallbacks: [],
    candidates: [candidate({ testid: 'submit-v2', text: 'Place order' })],
  };
  const wrapped = `Error: ${FAILURE_PREFIX}${JSON.stringify(payload)}`;

  assert.deepEqual(parseFailurePayload(wrapped), payload);
});

test('parseFailurePayload returns null for a string with no FLOW_RUNNER_FAILURE marker anywhere, wrapped or not', () => {
  assert.equal(parseFailurePayload('Error: something else entirely failed'), null);
  assert.equal(parseFailurePayload('TypeError: Cannot read properties of null'), null);
});

// ============================================================
// Step 2: rankCandidates determinism + pinned weights
// ============================================================

test('rankCandidates sorts by case-folded token overlap of name+text vs description+name, descending', () => {
  const target = { description: 'Place order button', name: 'Place order', role: 'button' };
  const candidates = [
    candidate({ role: 'button', name: 'Place order', testid: 'place-order-v2', text: 'Place your order now' }),
    candidate({ role: 'link', name: 'Cancel order', text: 'Cancel' }),
    candidate({ role: 'button', name: 'Help', text: 'Need assistance?' }),
  ];

  const ranked = rankCandidates({ target, candidates });

  // target tokens: {place, order, button} (3)
  const score0 = TOKEN_OVERLAP_WEIGHT * (2 / 5) + ROLE_MATCH_BONUS; // {place,order,your,now} vs target, role matches
  const score1 = TOKEN_OVERLAP_WEIGHT * (1 / 4); // {cancel,order} vs target, role mismatch
  const score2 = TOKEN_OVERLAP_WEIGHT * (0 / 6) + ROLE_MATCH_BONUS; // {help,need,assistance} vs target, role matches

  assert.deepEqual(ranked, [
    { index: 0, score: score0 },
    { index: 1, score: score1 },
    { index: 2, score: score2 },
  ]);
});

test('rankCandidates applies the role-match bonus only when target.role is set and matches case-folded, and breaks ties by original index (stable sort)', () => {
  const target = { description: 'Submit', name: 'Submit', role: 'Button' };
  const candidates = [
    candidate({ role: 'button', name: 'Submit' }),
    candidate({ role: 'BUTTON', name: 'Submit' }),
    candidate({ role: 'link', name: 'Submit' }),
    candidate({ role: '', name: 'Submit' }),
  ];

  const ranked = rankCandidates({ target, candidates });

  const withBonus = TOKEN_OVERLAP_WEIGHT * 1 + ROLE_MATCH_BONUS;
  const withoutBonus = TOKEN_OVERLAP_WEIGHT * 1;
  assert.deepEqual(ranked, [
    { index: 0, score: withBonus },
    { index: 1, score: withBonus },
    { index: 2, score: withoutBonus },
    { index: 3, score: withoutBonus },
  ]);
});

test('rankCandidates returns [] for no candidates', () => {
  assert.deepEqual(rankCandidates({ target: { name: 'x' }, candidates: [] }), []);
  assert.deepEqual(rankCandidates({ target: { name: 'x' } }), []);
});

// ============================================================
// Step 3: proposeHeal acceptance rule -- every null branch, then the
// clearing case.
// ============================================================

test('proposeHeal clears the acceptance rule and produces a decision (testid preferred over role+name)', () => {
  const flow = baseFlow({ steps: [
    { op: 'goto', url: '/checkout' },
    { op: 'click', target: baseTarget({ description: 'Place order', name: 'Place order' }) },
  ] });
  const candidates = [
    candidate({ role: 'button', name: 'Place order', testid: 'place-order-v2', text: '' }),
    candidate({ role: 'link', name: 'Cancel', text: 'Cancel order' }),
  ];
  const payload = payloadFor(flow, 1, candidates);

  const decision = proposeHeal({ flow, payload });

  const top = TOKEN_OVERLAP_WEIGHT * 1 + ROLE_MATCH_BONUS; // full overlap, role matches
  const runnerUp = TOKEN_OVERLAP_WEIGHT * (1 / 3); // {cancel,order} vs {place,order}, role mismatch
  assert.deepEqual(decision, {
    flowName: 'place-order',
    flowId: flow.id,
    stepIndex: 1,
    locator: { kind: 'testid', selector: 'internal:testid=[data-testid="place-order-v2"]' },
    score: top,
    runnerUp,
  });
});

test('proposeHeal falls back to role+name synthesis when the winning candidate has no testid', () => {
  const flow = baseFlow({ steps: [
    { op: 'goto', url: '/checkout' },
    {
      op: 'click',
      // Existing alternate deliberately differs from what synthesis will
      // produce below, so this test exercises the fallback path and not
      // the idempotence null-branch covered separately.
      target: baseTarget({
        description: 'Place order',
        name: 'Place order',
        locators: [{ kind: 'css', selector: '.place-order-btn' }],
      }),
    },
  ] });
  const candidates = [candidate({ role: 'button', name: 'Place order', text: '' })];
  const payload = payloadFor(flow, 1, candidates);

  const decision = proposeHeal({ flow, payload });

  // Deliberately 'other', not 'role' -- the plan's literally pinned kind
  // for a role+name fallback is a silent no-op against the flow-runner's
  // dedupe/resolution (see heal.mjs's DEVIATION doc comment; controller
  // ruling, Task 5 review round 1). 'other' takes the runner's verbatim
  // `page.locator(selector)` branch, so the synthesized selector string is
  // the one actually probed.
  assert.deepEqual(decision.locator, { kind: 'other', selector: 'internal:role=button[name="Place order"i]' });
});

test('proposeHeal escapes embedded quotes in a synthesized testid selector', () => {
  const flow = baseFlow({ steps: [
    { op: 'goto', url: '/checkout' },
    { op: 'click', target: baseTarget({ description: 'Place order', name: 'Place order' }) },
  ] });
  const candidates = [candidate({ role: 'button', name: 'Place order', testid: 'place"order', text: '' })];
  const payload = payloadFor(flow, 1, candidates);

  const decision = proposeHeal({ flow, payload });

  assert.equal(decision.locator.selector, 'internal:testid=[data-testid="place\\"order"]');
});

test('proposeHeal escapes embedded quotes in a synthesized role+name selector', () => {
  const flow = baseFlow({ steps: [
    { op: 'goto', url: '/checkout' },
    { op: 'click', target: baseTarget({ description: 'Place order now', name: 'Place order now' }) },
  ] });
  const candidates = [candidate({ role: 'button', name: 'Place "order" now', text: '' })];
  const payload = payloadFor(flow, 1, candidates);

  const decision = proposeHeal({ flow, payload });

  assert.equal(decision.locator.kind, 'other');
  assert.equal(
    decision.locator.selector,
    'internal:role=button[name="Place \\"order\\" now"i]',
  );
});

test("an applyHeal'd role+name fallback locator resolves through the runner's verbatim page.locator branch, distinct from the step's original role-kind alternate", () => {
  // Mirrors builtins/macros/flow-runner.js's `candidateKey` (:126-130) and
  // `candidateLocator` (:114-118) just enough to prove a heal actually gets
  // PROBED by the runner rather than silently deduped/ignored away -- the
  // gap that let the kind:'role' regression through review round 1. A
  // `kind: 'role'` candidate is keyed and resolved purely from
  // `target.role`/`target.name`, IGNORING its own `selector` entirely --
  // exactly why an appended `kind: 'role'` heal with the same role/name as
  // the step's existing captured locator would be a no-op (same dedupe
  // key, same getByRole() call, its own selector string never read).
  // `kind: 'other'` (what this module actually synthesizes for a role+name
  // fallback) always resolves via `page.locator(candidate.selector)`
  // verbatim, so it is the only kind that can never collide this way.
  const candidateKey = (target, candidateEntry) => (
    candidateEntry.kind === 'role' && target.role && target.name
      ? `role:${target.role}:${target.name}`
      : `${candidateEntry.kind}:${candidateEntry.selector}`
  );
  const candidateLocator = (target, candidateEntry, page) => (
    candidateEntry.kind === 'role' && target.role && target.name
      ? page.getByRole(target.role, { name: target.name })
      : page.locator(candidateEntry.selector)
  );

  const flow = baseFlow({ steps: [
    { op: 'goto', url: '/checkout' },
    {
      op: 'click',
      target: baseTarget({
        description: 'Place order',
        name: 'Place order',
        role: 'button',
        locators: [{ kind: 'role', selector: 'internal:role=button[name="Place order"i]' }],
      }),
    },
  ] });
  const candidates = [candidate({ role: 'button', name: 'Place order', text: '' })];
  const payload = payloadFor(flow, 1, candidates);

  const decision = proposeHeal({ flow, payload });
  assert.ok(decision, 'test setup: this scenario should clear the acceptance rule');
  assert.equal(decision.locator.kind, 'other');

  const healed = applyHeal(flow, decision);
  const target = healed.steps[1].target;
  const [originalEntry, appendedEntry] = target.locators;

  assert.notEqual(
    candidateKey(target, originalEntry),
    candidateKey(target, appendedEntry),
    "the appended heal must not dedupe away against the step's original locator",
  );

  const page = {
    getByRole: (role, opts) => ({ via: 'getByRole', role, name: opts.name }),
    locator: (selector) => ({ via: 'page.locator', selector }),
  };
  assert.deepEqual(
    candidateLocator(target, originalEntry, page),
    { via: 'getByRole', role: 'button', name: 'Place order' },
  );
  assert.deepEqual(
    candidateLocator(target, appendedEntry, page),
    { via: 'page.locator', selector: appendedEntry.selector },
    'a heal must reach the verbatim page.locator branch, not be silently ignored',
  );
});

test('proposeHeal returns null when the payload has no candidates', () => {
  const flow = baseFlow();
  assert.equal(proposeHeal({ flow, payload: payloadFor(flow, 1, []) }), null);
  assert.equal(proposeHeal({ flow, payload: { failedStep: 1 } }), null);
});

test('proposeHeal returns null when failedStep is out of range or not a step index', () => {
  const flow = baseFlow();
  const candidates = [candidate({ role: 'button', name: 'Place order' })];
  assert.equal(proposeHeal({ flow, payload: payloadFor(flow, 99, candidates) }), null);
  assert.equal(proposeHeal({ flow, payload: payloadFor(flow, 'args', candidates) }), null);
  assert.equal(proposeHeal({ flow, payload: payloadFor(flow, -1, candidates) }), null);
});

test('proposeHeal returns null when the failed step is not locator-bearing (goto, and drag\'s two-target ambiguity)', () => {
  const flow = baseFlow();
  const candidates = [candidate({ role: 'button', name: 'Place order' })];
  assert.equal(proposeHeal({ flow, payload: payloadFor(flow, 0, candidates) }), null); // goto
  assert.equal(proposeHeal({ flow, payload: payloadFor(flow, 2, candidates) }), null); // drag
});

test('proposeHeal returns null when the failed step\'s target has neither description nor name', () => {
  const flow = baseFlow({ steps: [
    { op: 'goto', url: '/checkout' },
    { op: 'click', target: baseTarget({ description: undefined, name: undefined }) },
  ] });
  const candidates = [
    candidate({ role: 'button', name: 'Place order', testid: 'place-order-v2', text: 'Place order' }),
  ];
  const payload = payloadFor(flow, 1, candidates);

  assert.equal(proposeHeal({ flow, payload }), null);
});

test('proposeHeal returns null when the top candidate does not clear HEAL_MIN_SCORE', () => {
  const flow = baseFlow({ steps: [
    { op: 'goto', url: '/checkout' },
    { op: 'click', target: baseTarget({ description: 'Place order', name: 'Place order' }) },
  ] });
  const candidates = [candidate({ role: 'link', name: '', text: 'order details maybe' })];
  const payload = payloadFor(flow, 1, candidates);

  const ranked = rankCandidates({
    target: { description: 'Place order', name: 'Place order', role: 'button' },
    candidates,
  });
  assert.ok(ranked[0].score < HEAL_MIN_SCORE, 'test setup: top score really is below threshold');

  assert.equal(proposeHeal({ flow, payload }), null);
});

test('proposeHeal returns null when the top candidate\'s margin over the runner-up does not clear HEAL_MIN_MARGIN', () => {
  const flow = baseFlow({ steps: [
    { op: 'goto', url: '/checkout' },
    { op: 'click', target: baseTarget({ description: 'Place your order now', name: '' }) },
  ] });
  const candidates = [
    candidate({ role: 'button', name: 'Place your order', testid: 'x', text: 'now' }),
    candidate({ role: 'link', name: 'Place your order', text: 'now' }),
  ];
  const payload = payloadFor(flow, 1, candidates);

  const ranked = rankCandidates({
    target: { description: 'Place your order now', name: '', role: 'button' },
    candidates,
  });
  assert.ok(ranked[0].score >= HEAL_MIN_SCORE, 'test setup: threshold clears');
  assert.ok(ranked[0].score - ranked[1].score < HEAL_MIN_MARGIN, 'test setup: margin really is too small');

  assert.equal(proposeHeal({ flow, payload }), null);
});

test('proposeHeal returns null when the winning candidate\'s only evidence is bare text (no synthesizable locator)', () => {
  const flow = baseFlow({ steps: [
    { op: 'goto', url: '/checkout' },
    { op: 'click', target: baseTarget({ description: 'Place order', name: 'Place order' }) },
  ] });
  const candidates = [
    candidate({ role: '', name: '', testid: '', text: 'Place order' }),
    candidate({ role: '', name: '', testid: '', text: '' }),
  ];
  const payload = payloadFor(flow, 1, candidates);

  assert.equal(proposeHeal({ flow, payload }), null);
});

test('proposeHeal returns null when the winning locator is already among the step\'s alternates (idempotence)', () => {
  const existing = { kind: 'testid', selector: 'internal:testid=[data-testid="place-order-v2"]' };
  const flow = baseFlow({ steps: [
    { op: 'goto', url: '/checkout' },
    {
      op: 'click',
      target: baseTarget({
        description: 'Place order',
        name: 'Place order',
        locators: [{ kind: 'role', selector: 'internal:role=button[name="Place order"i]' }, existing],
      }),
    },
  ] });
  const candidates = [candidate({ role: 'button', name: 'Place order', testid: 'place-order-v2', text: '' })];
  const payload = payloadFor(flow, 1, candidates);

  assert.equal(proposeHeal({ flow, payload }), null);
});

test('rankCandidates and proposeHeal do not mutate their inputs', () => {
  const flow = baseFlow({ steps: [
    { op: 'goto', url: '/checkout' },
    { op: 'click', target: baseTarget({ description: 'Place order', name: 'Place order' }) },
  ] });
  const candidates = [
    candidate({ role: 'button', name: 'Place order', testid: 'place-order-v2', text: '' }),
    candidate({ role: 'link', name: 'Cancel', text: 'Cancel order' }),
  ];
  const payload = payloadFor(flow, 1, candidates);
  const flowBefore = JSON.parse(JSON.stringify(flow));
  const payloadBefore = JSON.parse(JSON.stringify(payload));

  rankCandidates({ target: flow.steps[1].target, candidates });
  assert.deepEqual(flow, flowBefore, 'rankCandidates must not mutate the target it was given');
  assert.deepEqual(candidates, payloadBefore.candidates, 'rankCandidates must not mutate the candidates it was given');

  const decision = proposeHeal({ flow, payload });
  assert.ok(decision, 'test setup: this scenario should clear the acceptance rule');
  assert.deepEqual(flow, flowBefore, 'proposeHeal must not mutate the flow it was given');
  assert.deepEqual(payload, payloadBefore, 'proposeHeal must not mutate the payload it was given');
});

// ============================================================
// WS3b Task 7: injected ranker
// ============================================================

test('proposeHeal uses an injected ranker instead of the lexical default, pinning the call args it receives', () => {
  const flow = baseFlow({ steps: [
    { op: 'goto', url: '/checkout' },
    { op: 'click', target: baseTarget({ description: 'Place order', name: 'Place order', role: 'button' }) },
  ] });
  // Two candidates the LEXICAL scorer would clearly rank the second one
  // ahead of (full name/role match vs. no overlap at all) -- the stub
  // ranker below instead picks the FIRST one, so a passing test proves
  // proposeHeal actually deferred to the injected ranker's own ordering
  // rather than silently falling back to rankCandidates.
  const candidates = [
    candidate({ role: 'button', name: 'Nothing alike', testid: 'wrong-btn', text: '' }),
    candidate({ role: 'button', name: 'Place order', testid: 'place-order-v2', text: 'Place order' }),
  ];
  const payload = payloadFor(flow, 1, candidates);

  let capturedArgs = null;
  const ranker = (args) => {
    capturedArgs = args;
    return [{ index: 0, score: 1 }, { index: 1, score: 0 }];
  };

  const decision = proposeHeal({ flow, payload, ranker });

  assert.deepEqual(capturedArgs, {
    target: { description: 'Place order', name: 'Place order', role: 'button' },
    candidates,
  });
  assert.ok(decision);
  assert.equal(decision.locator.selector, 'internal:testid=[data-testid="wrong-btn"]');
});

test('proposeHeal defaults to the lexical rankCandidates when no ranker is supplied', () => {
  const flow = baseFlow({ steps: [
    { op: 'goto', url: '/checkout' },
    { op: 'click', target: baseTarget({ description: 'Place order', name: 'Place order', role: 'button' }) },
  ] });
  const candidates = [candidate({ role: 'button', name: 'Place order', testid: 'place-order-v2', text: 'Place order' })];
  const payload = payloadFor(flow, 1, candidates);

  const withoutRanker = proposeHeal({ flow, payload });
  const withExplicitLexicalRanker = proposeHeal({ flow, payload, ranker: rankCandidates });
  assert.deepEqual(withoutRanker, withExplicitLexicalRanker);
  assert.ok(withoutRanker);
});

test('proposeHeal degrades to lexical when a synchronous ranker throws', () => {
  const flow = baseFlow({ steps: [
    { op: 'goto', url: '/checkout' },
    { op: 'click', target: baseTarget({ description: 'Place order', name: 'Place order', role: 'button' }) },
  ] });
  const candidates = [candidate({ role: 'button', name: 'Place order', testid: 'place-order-v2', text: 'Place order' })];
  const payload = payloadFor(flow, 1, candidates);
  const brokenRanker = () => { throw new Error('encoder offline'); };

  const decision = proposeHeal({ flow, payload, ranker: brokenRanker });
  const lexicalDecision = proposeHeal({ flow, payload });
  assert.deepEqual(decision, lexicalDecision);
});

test('proposeHeal degrades to lexical when an asynchronous ranker rejects, returning a Promise', async () => {
  const flow = baseFlow({ steps: [
    { op: 'goto', url: '/checkout' },
    { op: 'click', target: baseTarget({ description: 'Place order', name: 'Place order', role: 'button' }) },
  ] });
  const candidates = [candidate({ role: 'button', name: 'Place order', testid: 'place-order-v2', text: 'Place order' })];
  const payload = payloadFor(flow, 1, candidates);
  const brokenAsyncRanker = () => Promise.reject(new Error('voyage embeddings request failed: HTTP 500'));

  const result = proposeHeal({ flow, payload, ranker: brokenAsyncRanker });
  assert.equal(typeof result.then, 'function', 'an async ranker must make proposeHeal return a Promise');
  const decision = await result;
  const lexicalDecision = proposeHeal({ flow, payload });
  assert.deepEqual(decision, lexicalDecision);
});

test('proposeHeal returns a Promise end to end when a well-behaved asynchronous ranker is supplied', async () => {
  const flow = baseFlow({ steps: [
    { op: 'goto', url: '/checkout' },
    { op: 'click', target: baseTarget({ description: 'Place order', name: 'Place order', role: 'button' }) },
  ] });
  const candidates = [candidate({ role: 'button', name: 'Place order', testid: 'place-order-v2', text: 'Place order' })];
  const payload = payloadFor(flow, 1, candidates);
  const asyncRanker = async ({ candidates: given }) => given.map((_, index) => ({ index, score: 1 }));

  const result = proposeHeal({ flow, payload, ranker: asyncRanker });
  assert.equal(typeof result.then, 'function');
  const decision = await result;
  assert.ok(decision);
  assert.equal(decision.locator.selector, 'internal:testid=[data-testid="place-order-v2"]');
});

// ============================================================
// Fix round 1 (controller ruling, direction b): ranker-supplied
// acceptance thresholds
// ============================================================

// Builds a real `encoderRanker` over a stubbed `encoder` whose `embed`
// returns hand-picked 1-dimensional vectors, indexed by POSITION rather
// than by text content -- `encoder.mjs`'s own doc comment pins the batch
// order as `[targetText, candidate0Text, candidate1Text, ...]`, so
// `texts.map((_, index) => ...)` is both simpler than a text-keyed lookup
// and exactly matches the real contract (a text-keyed map would also risk
// key collisions whenever a fixture's target and top candidate happen to
// render the same string). `cosineSimilarity` is a plain dot product, so a
// 1-D vector IS its own cosine score against a target vector of `[1]`,
// letting these tests pin exact score/margin numbers without going through
// a real normalization step. Target/candidates below carry no `role`
// field, so `encoderRanker`'s role bonus (Folded Minor 1, tested
// separately in flows-encoder.test.mjs) never fires here -- these tests
// are about the threshold gate alone.
function positionalEncoderRanker(vectorsByPosition) {
  return encoderRanker({
    active: true,
    kind: 'voyage',
    embed: async (texts) => texts.map((_, index) => vectorsByPosition[index]),
  });
}

test('encoder-ranked proposeHeal accepts a heal at cosine 0.8 with a 0.07 margin (clears ENCODER_MIN_SCORE/MARGIN)', async () => {
  assert.equal(ENCODER_MIN_SCORE, 0.75);
  assert.equal(ENCODER_MIN_MARGIN, 0.05);

  const flow = baseFlow({ steps: [
    { op: 'goto', url: '/checkout' },
    { op: 'click', target: baseTarget({ description: 'Place order', name: 'Place order', role: undefined }) },
  ] });
  const candidates = [
    candidate({ name: 'Place order', testid: 'top-btn', text: 'Place order' }),
    candidate({ name: 'Almost place order', testid: 'runner-up-btn', text: 'Almost place order' }),
  ];
  const payload = payloadFor(flow, 1, candidates);

  // vectors[0] = target, vectors[1] = top candidate (cosine 0.8),
  // vectors[2] = runner-up (cosine 0.73 -- a 0.07 margin under the top).
  const ranker = positionalEncoderRanker([[1], [0.8], [0.73]]);

  const decision = await proposeHeal({ flow, payload, ranker });
  assert.ok(decision, 'a 0.8/0.73 pair (margin 0.07) must clear ENCODER_MIN_SCORE/ENCODER_MIN_MARGIN');
  assert.equal(decision.score, 0.8);
  assert.ok(Math.abs(decision.score - decision.runnerUp - 0.07) < 1e-9);
  assert.equal(decision.locator.selector, 'internal:testid=[data-testid="top-btn"]');
});

test('encoder-ranked proposeHeal rejects a heal at cosine 0.8 with only a 0.03 margin (below ENCODER_MIN_MARGIN)', async () => {
  const flow = baseFlow({ steps: [
    { op: 'goto', url: '/checkout' },
    { op: 'click', target: baseTarget({ description: 'Place order', name: 'Place order', role: undefined }) },
  ] });
  const candidates = [
    candidate({ name: 'Place order', testid: 'top-btn', text: 'Place order' }),
    candidate({ name: 'Almost place order', testid: 'runner-up-btn', text: 'Almost place order' }),
  ];
  const payload = payloadFor(flow, 1, candidates);

  // vectors[0] = target, vectors[1] = top candidate (cosine 0.8, still
  // clears ENCODER_MIN_SCORE), vectors[2] = runner-up (cosine 0.77 -- only
  // a 0.03 margin, below ENCODER_MIN_MARGIN).
  const ranker = positionalEncoderRanker([[1], [0.8], [0.77]]);

  const decision = await proposeHeal({ flow, payload, ranker });
  assert.equal(decision, null, 'a 0.03 margin must NOT clear ENCODER_MIN_MARGIN even though the top score clears ENCODER_MIN_SCORE');
});

test('the threshold source is pinned: a stub ranker\'s own custom minScore/minMargin are honored over both the lexical and encoder defaults', async () => {
  const flow = baseFlow({ steps: [
    { op: 'goto', url: '/checkout' },
    { op: 'click', target: baseTarget({ description: 'Place order', name: 'Place order', role: 'button' }) },
  ] });
  const candidates = [candidate({ role: 'button', name: 'Place order', testid: 'place-order-v2', text: 'Place order' })];
  const payload = payloadFor(flow, 1, candidates);

  // Score 0.8 clears HEAL_MIN_SCORE (0.6) AND ENCODER_MIN_SCORE (0.75), but
  // a custom minScore of 0.9 on the ranker itself must still reject it --
  // proving proposeHeal reads the threshold off the ranker, not off either
  // module's own constants.
  const strictStub = ({ candidates: given }) => given.map((_, index) => ({ index, score: 0.8 }));
  strictStub.minScore = 0.9;
  strictStub.minMargin = 0.5;

  assert.equal(proposeHeal({ flow, payload, ranker: strictStub }), null);

  // The SAME 0.8 score with a lenient custom threshold (below both module
  // defaults) is accepted -- confirms the custom threshold is genuinely
  // read both ways, not just capable of rejecting.
  const lenientStub = ({ candidates: given }) => given.map((_, index) => ({ index, score: 0.8 }));
  lenientStub.minScore = 0.1;
  lenientStub.minMargin = 0;

  const decision = proposeHeal({ flow, payload, ranker: lenientStub });
  assert.ok(decision);
  assert.equal(decision.score, 0.8);
});

test('a ranker with no minScore/minMargin properties (the lexical default, or a plain stub) uses HEAL_MIN_SCORE/HEAL_MIN_MARGIN unchanged', () => {
  const flow = baseFlow({ steps: [
    { op: 'goto', url: '/checkout' },
    { op: 'click', target: baseTarget({ description: 'Place order', name: 'Place order', role: 'button' }) },
  ] });
  // Score 0.65 clears HEAL_MIN_SCORE (0.6) but a plain stub carries no
  // threshold overrides, so HEAL_MIN_SCORE/HEAL_MIN_MARGIN apply exactly as
  // they did before fix round 1.
  const candidates = [candidate({ role: 'button', name: 'Place order', testid: 'a', text: '' })];
  const payload = payloadFor(flow, 1, candidates);
  const plainStub = ({ candidates: given }) => given.map((_, index) => ({ index, score: 0.65 }));

  const decision = proposeHeal({ flow, payload, ranker: plainStub });
  assert.ok(decision, 'a bare score of 0.65 with no runner-up (margin 0.65) must clear the unmodified lexical thresholds');
  assert.equal(HEAL_MIN_SCORE, 0.6);
  assert.equal(HEAL_MIN_MARGIN, 0.2);
});

// ============================================================
// Fix round 2 (final review, MUST-FIX): NaN threshold guard
// ============================================================

test('a NaN minScore/minMargin on the ranker falls back to HEAL_MIN_SCORE/HEAL_MIN_MARGIN (Number.isFinite, not typeof)', () => {
  const flow = baseFlow({ steps: [
    { op: 'goto', url: '/checkout' },
    { op: 'click', target: baseTarget({ description: 'Place order', name: 'Place order', role: 'button' }) },
  ] });
  const candidates = [candidate({ role: 'button', name: 'Place order', testid: 'weak-match', text: '' })];
  const payload = payloadFor(flow, 1, candidates);
  // `typeof NaN === 'number'` is true, so the pre-fix-round-2 guard would
  // have accepted NaN as a "real" threshold -- and `x < NaN` is ALWAYS
  // false for any real `x`, so both acceptance gates below would have
  // silently passed regardless of how weak this 0.1 score actually is,
  // healing a candidate the unmodified lexical thresholds (0.1 < 0.6)
  // correctly reject. Number.isFinite(NaN) is false, so this must fall
  // back to HEAL_MIN_SCORE and reject.
  const nanStub = ({ candidates: given }) => given.map((_, index) => ({ index, score: 0.1 }));
  nanStub.minScore = NaN;
  nanStub.minMargin = NaN;

  const decision = proposeHeal({ flow, payload, ranker: nanStub });
  assert.equal(decision, null, 'a NaN threshold must fall back to HEAL_MIN_SCORE (0.6), rejecting a 0.1 score');
});

// ============================================================
// Fix round 2 (final review, NEW Important): degrade-path threshold
// mismatch -- a lexical FALLBACK ranking must be gated by LEXICAL
// thresholds, never by the failed ranker's own (possibly encoder-scale)
// thresholds
// ============================================================

// Hand-picked token counts so the real lexical `rankCandidates` (not a
// stub) produces an exact, known margin: target tokens {alpha, beta,
// gamma, delta, epsilon} (5); the top candidate's 4-token name is a
// subset (jaccard 4/5 = 0.8, role matches -> 0.85*0.8+0.15 = 0.83); the
// runner-up's 3-token name is also a subset with a matching role
// (jaccard 3/5 = 0.6 -> 0.85*0.6+0.15 = 0.66). Margin = 0.17: clears
// ENCODER_MIN_MARGIN (0.05) but NOT HEAL_MIN_MARGIN (0.2) -- exactly the
// "ambiguous lexical pair" the review flagged as wrongly healing when
// gated by the failed ranker's own (encoder-scale) thresholds instead of
// the lexical ones the fallback ranking was actually computed on.
function ambiguousLexicalPairFixture() {
  const flow = baseFlow({ steps: [
    { op: 'goto', url: '/checkout' },
    {
      op: 'click',
      target: baseTarget({
        description: 'alpha beta gamma delta epsilon', name: '', role: 'button',
      }),
    },
  ] });
  const candidates = [
    candidate({
      role: 'button', name: 'alpha beta gamma delta', testid: 'top-btn', text: '',
    }),
    candidate({
      role: 'button', name: 'alpha beta gamma', testid: 'runner-up-btn', text: '',
    }),
  ];
  return { flow, payload: payloadFor(flow, 1, candidates) };
}

test('the ambiguous lexical pair fixture itself scores 0.83/0.66 under the real lexical rankCandidates (sanity check for the tests below)', () => {
  const { flow, payload } = ambiguousLexicalPairFixture();
  const target = flow.steps[1].target;
  const ranked = rankCandidates({
    target: { description: target.description, name: target.name, role: target.role },
    candidates: payload.candidates,
  });
  assert.ok(Math.abs(ranked[0].score - 0.83) < 1e-9, `expected 0.83, got ${ranked[0].score}`);
  assert.ok(Math.abs(ranked[1].score - 0.66) < 1e-9, `expected 0.66, got ${ranked[1].score}`);
  const margin = ranked[0].score - ranked[1].score;
  assert.ok(margin > ENCODER_MIN_MARGIN && margin < HEAL_MIN_MARGIN, `margin ${margin} must sit strictly between the two thresholds`);
});

test('when an injected encoder-shaped ranker REJECTS, the lexical fallback ranking is gated by LEXICAL thresholds, not the failed ranker\'s own -- the ambiguous pair does NOT heal', async () => {
  const { flow, payload } = ambiguousLexicalPairFixture();

  // An encoder-ranker-shaped stub: carries the SAME threshold properties a
  // real `encoderRanker(encoder)` instance would (ENCODER_MIN_SCORE/
  // ENCODER_MIN_MARGIN), but its function body always rejects -- exactly
  // what a Voyage outage looks like from proposeHeal's point of view.
  const failingEncoderRanker = async () => { throw new Error('voyage embeddings request failed: HTTP 500'); };
  failingEncoderRanker.minScore = ENCODER_MIN_SCORE;
  failingEncoderRanker.minMargin = ENCODER_MIN_MARGIN;

  const decision = await proposeHeal({ flow, payload, ranker: failingEncoderRanker });
  assert.equal(
    decision,
    null,
    'a 0.17 margin must be rejected under LEXICAL thresholds (0.2) even though the failed ranker '
      + 'carried a looser encoder threshold (0.05) -- the fallback ranking is on the lexical scale, '
      + 'so it must be judged by lexical thresholds',
  );
});

test('when the SAME injected encoder-shaped ranker instead SUCCEEDS, its own (looser) thresholds apply and the ambiguous pair DOES heal', async () => {
  const { flow, payload } = ambiguousLexicalPairFixture();

  // Mirrors the real lexical scores from the sanity-check test above
  // (0.83/0.66, margin 0.17) so this is a genuine contrast with the
  // rejecting case: the SAME numeric ranking, gated by the SAME ranker's
  // thresholds, differs only in whether that ranker actually produced the
  // ranking (accept) or failed and fell back to lexical (reject, tested
  // above).
  const succeedingEncoderRanker = async ({ candidates: given }) => given.map((_, index) => ({
    index,
    score: index === 0 ? 0.83 : 0.66,
  }));
  succeedingEncoderRanker.minScore = ENCODER_MIN_SCORE;
  succeedingEncoderRanker.minMargin = ENCODER_MIN_MARGIN;

  const decision = await proposeHeal({ flow, payload, ranker: succeedingEncoderRanker });
  assert.ok(decision, 'a 0.17 margin clears ENCODER_MIN_MARGIN (0.05) when the ranker that produced it actually succeeded');
  assert.equal(decision.locator.selector, 'internal:testid=[data-testid="top-btn"]');
});

// ============================================================
// WS3b Task 8: heal synthesis widening (role + text)
// ============================================================
//
// Task 5 (this branch) made `collectCandidates` derive implicit roles
// (button/a-with-href/select/input types), so a plain `<button>Place
// order</button>` now collects `{ role: 'button', text: 'Place order' }`
// with no `name`. Per the plan's Scope ruling (binding): for a candidate
// that CARRIES a role, visible text IS the ARIA accessible name for
// name-from-content roles, so synthesis accepts `name ?? text` as the
// accessible-name evidence -- kind 'other', same selector syntax/escaping
// as the role+name path, NAME wins when both exist. Bare text with no role
// at all remains too weak (unchanged, covered above at
// "returns null when the winning candidate's only evidence is bare text").
// These fixtures are deliberately local to this section, not shared with
// Task 5's own fixtures (per the Task 5 review carry-forward: candidate
// survival counts near the 8KB truncation boundary are not stable to
// couple tests to).

test('proposeHeal synthesizes a role+text locator when the winning candidate has a role and text but no name', () => {
  const flow = baseFlow({ steps: [
    { op: 'goto', url: '/checkout' },
    { op: 'click', target: baseTarget({ description: 'Place order', name: 'Place order', role: 'button' }) },
  ] });
  const candidates = [candidate({ role: 'button', name: '', testid: '', text: 'Place order' })];
  const payload = payloadFor(flow, 1, candidates);

  const decision = proposeHeal({ flow, payload });

  assert.ok(decision, 'test setup: this scenario should clear the acceptance rule');
  assert.deepEqual(decision.locator, { kind: 'other', selector: 'internal:role=button[name="Place order"i]' });
});

test('proposeHeal still returns null when the winning candidate has text but no role at all', () => {
  const flow = baseFlow({ steps: [
    { op: 'goto', url: '/checkout' },
    { op: 'click', target: baseTarget({ description: 'Place order', name: 'Place order' }) },
  ] });
  const candidates = [candidate({ role: '', name: '', testid: '', text: 'Place order' })];
  const payload = payloadFor(flow, 1, candidates);

  assert.equal(proposeHeal({ flow, payload }), null);
});

test('proposeHeal prefers testid over a role+text winner', () => {
  const flow = baseFlow({ steps: [
    { op: 'goto', url: '/checkout' },
    { op: 'click', target: baseTarget({ description: 'Place order', name: 'Place order', role: 'button' }) },
  ] });
  const candidates = [candidate({ role: 'button', name: '', testid: 'place-order-v2', text: 'Place order' })];
  const payload = payloadFor(flow, 1, candidates);

  const decision = proposeHeal({ flow, payload });

  assert.deepEqual(decision.locator, { kind: 'testid', selector: 'internal:testid=[data-testid="place-order-v2"]' });
});

test('proposeHeal prefers name over text when a role+name+text candidate wins (name takes precedence)', () => {
  const flow = baseFlow({ steps: [
    { op: 'goto', url: '/checkout' },
    { op: 'click', target: baseTarget({ description: 'Submit order now', name: 'Submit order now', role: 'button' }) },
  ] });
  // name and text both feed the target-token overlap used by ranking (so
  // this single candidate clears HEAL_MIN_SCORE/MARGIN on its own), but
  // synthesis must pick NAME ("Submit order"), never TEXT ("Submit order
  // now"), for the actual selector string.
  const candidates = [candidate({ role: 'button', name: 'Submit order', testid: '', text: 'Submit order now' })];
  const payload = payloadFor(flow, 1, candidates);

  const decision = proposeHeal({ flow, payload });

  assert.ok(decision, 'test setup: this scenario should clear the acceptance rule');
  assert.deepEqual(decision.locator, { kind: 'other', selector: 'internal:role=button[name="Submit order"i]' });
});

test('proposeHeal escapes embedded quotes in a synthesized role+text selector', () => {
  const flow = baseFlow({ steps: [
    { op: 'goto', url: '/checkout' },
    { op: 'click', target: baseTarget({ description: 'Place order now', name: 'Place order now', role: 'button' }) },
  ] });
  const candidates = [candidate({ role: 'button', name: '', testid: '', text: 'Place "order" now' })];
  const payload = payloadFor(flow, 1, candidates);

  const decision = proposeHeal({ flow, payload });

  assert.equal(decision.locator.kind, 'other');
  assert.equal(
    decision.locator.selector,
    'internal:role=button[name="Place \\"order\\" now"i]',
  );
});

test('proposeHeal returns null when a role-only winner\'s text is whitespace-only (nothing to synthesize from)', () => {
  const flow = baseFlow({ steps: [
    { op: 'goto', url: '/checkout' },
    { op: 'click', target: baseTarget({ description: 'Place order', name: 'Place order', role: 'button' }) },
  ] });
  const candidates = [candidate({ role: 'button', name: '', testid: '', text: '   ' })];
  const payload = payloadFor(flow, 1, candidates);
  // Forces this sole candidate to win regardless of its (deliberately
  // near-zero) lexical score, so the null result below is proven to come
  // from synthesis rejecting whitespace-only text, not from the
  // acceptance-rule threshold rejecting a weak candidate.
  const forceWinner = ({ candidates: given }) => given.map((_, index) => ({ index, score: 1 }));

  assert.equal(proposeHeal({ flow, payload, ranker: forceWinner }), null);
});

test('proposeHeal returns null for a role "textbox" candidate whose name and text are both empty (Task 5 hidden-input guard)', () => {
  // Task 5's tag map derives role 'textbox' for input[type=hidden|file|image]
  // -- a hidden input can never be probed successfully, so it must never be
  // blindly minted into a heal. Its candidate never carries a name or text,
  // so this is the general "nothing to build a selector from" case above,
  // pinned here against the specific scenario the Task 5 review flagged.
  const flow = baseFlow({ steps: [
    { op: 'goto', url: '/checkout' },
    { op: 'click', target: baseTarget({ description: 'Place order', name: 'Place order', role: 'button' }) },
  ] });
  const candidates = [candidate({ role: 'textbox', name: '', testid: '', text: '' })];
  const payload = payloadFor(flow, 1, candidates);
  const forceWinner = ({ candidates: given }) => given.map((_, index) => ({ index, score: 1 }));

  assert.equal(proposeHeal({ flow, payload, ranker: forceWinner }), null);
});

test("an applyHeal'd role+text fallback locator resolves through the runner's verbatim page.locator branch (Task 8 mirror of the role+name proof above)", () => {
  // Same runner-precedence mirror as the role+name test above (see that
  // test's own comment for the full rationale) -- this one confirms the
  // SAME guarantee holds for a role+TEXT synthesized selector: 'other'
  // always resolves via `page.locator(candidate.selector)` verbatim, never
  // deduped away against the step's existing `kind: 'role'` alternate.
  const candidateKey = (target, candidateEntry) => (
    candidateEntry.kind === 'role' && target.role && target.name
      ? `role:${target.role}:${target.name}`
      : `${candidateEntry.kind}:${candidateEntry.selector}`
  );
  const candidateLocator = (target, candidateEntry, page) => (
    candidateEntry.kind === 'role' && target.role && target.name
      ? page.getByRole(target.role, { name: target.name })
      : page.locator(candidateEntry.selector)
  );

  const flow = baseFlow({ steps: [
    { op: 'goto', url: '/checkout' },
    {
      op: 'click',
      target: baseTarget({
        description: 'Place order',
        name: 'Place order',
        role: 'button',
        locators: [{ kind: 'role', selector: 'internal:role=button[name="Place order"i]' }],
      }),
    },
  ] });
  const candidates = [candidate({ role: 'button', name: '', testid: '', text: 'Place order' })];
  const payload = payloadFor(flow, 1, candidates);

  const decision = proposeHeal({ flow, payload });
  assert.ok(decision, 'test setup: this scenario should clear the acceptance rule');
  assert.equal(decision.locator.kind, 'other');

  const healed = applyHeal(flow, decision);
  const target = healed.steps[1].target;
  const [originalEntry, appendedEntry] = target.locators;

  assert.notEqual(
    candidateKey(target, originalEntry),
    candidateKey(target, appendedEntry),
    "the appended heal must not dedupe away against the step's original locator",
  );

  const page = {
    getByRole: (role, opts) => ({ via: 'getByRole', role, name: opts.name }),
    locator: (selector) => ({ via: 'page.locator', selector }),
  };
  assert.deepEqual(
    candidateLocator(target, appendedEntry, page),
    { via: 'page.locator', selector: appendedEntry.selector },
    'a role+text heal must reach the verbatim page.locator branch, not be silently ignored',
  );
});

// ============================================================
// Step 5: applyHeal purity
// ============================================================

test('applyHeal appends the winning locator at the last position of the step\'s alternates, without mutating the input', () => {
  const flow = baseFlow();
  const before = JSON.parse(JSON.stringify(flow));
  const decision = {
    flowName: flow.name,
    flowId: flow.id,
    stepIndex: 1,
    locator: { kind: 'testid', selector: 'internal:testid=[data-testid="place-order-v2"]' },
    score: 1,
    runnerUp: 0,
  };

  const healed = applyHeal(flow, decision);

  assert.deepEqual(flow, before, 'input flow must not be mutated');
  assert.notEqual(healed, flow, 'a new flow object is returned');
  assert.deepEqual(
    healed.steps[1].target.locators,
    [...before.steps[1].target.locators, decision.locator],
  );
  assert.deepEqual(healed.steps[0], before.steps[0]);
  assert.deepEqual(healed.steps[2], before.steps[2]);
  assert.equal(healed.id, before.id, 'applyHeal does not recompute flowId -- the caller does');
  assert.equal(
    healed.provenance.lastHealed,
    before.provenance.lastHealed,
    'lastHealed is stamped by the sweep with its own clock, not set here',
  );
  assert.deepEqual(healed.provenance, before.provenance);
});
