import assert from 'node:assert/strict';
import test from 'node:test';

import { parseFlow } from '../../lib/flows/artifact.mjs';
import {
  LEXICAL_TOKEN_SCORE,
  MAX_RESULTS,
  MIN_SCORE,
  NAME_TOKEN_MATCH_SCORE,
  QUARANTINE_SCORE_MULTIPLIER,
  URL_PATTERN_MATCH_SCORE,
  matchFlows,
} from '../../lib/flows/match.mjs';

// --- fixture builders (mirrors flows-artifact.test.mjs's `target()`/
// `baseFlow()` helper style: minimal-but-valid flow objects round-tripped
// through parseFlow so every fixture is a real, schema-legal artifact) ---

function target({ name, description = name, role = 'button' } = {}) {
  return {
    locators: [{ kind: 'text', selector: `internal:text="${name}"` }],
    description,
    role,
    name,
  };
}

function baseProvenance(overrides = {}) {
  return {
    compiledAt: '2026-08-05T00:00:00.000Z',
    traceDir: 'trace-1754350000000',
    seqRange: [0, 1],
    productVersion: '0.1.0-alpha.10',
    successRuns: 0,
    failStreak: 0,
    lastHealed: null,
    ...overrides,
  };
}

function baseFlow(overrides = {}) {
  return parseFlow({
    schemaVersion: 1,
    id: 'a'.repeat(64),
    name: 'place-order',
    description: 'Fill the order form and place an order on http://localhost:4823',
    origin: 'http://localhost:4823',
    urlPattern: '/checkout/:plan',
    sideEffects: 'read-only',
    args: {},
    result: { kind: 'completion', keys: [] },
    steps: [
      { op: 'goto', url: '/checkout/{plan}' },
      { op: 'click', target: target({ name: 'Place order' }) },
    ],
    provenance: baseProvenance(),
    ...overrides,
  });
}

// Entries are always [{ flow, tier }] pairs, per the contract Task 7
// assembles by reading flowsDir ('ready') vs flowsPendingDir ('pending').
function entry(flow, tier = 'ready') {
  return { flow, tier };
}

test('matchFlows returns [] for an empty flows list', () => {
  assert.deepEqual(matchFlows({ flows: [], intent: 'place an order' }), []);
});

test('expected miss returns [] rather than a wild guess: zero token overlap', () => {
  const flow = baseFlow();
  const result = matchFlows({
    flows: [entry(flow)],
    intent: 'completely unrelated request about nothing here',
  });
  assert.deepEqual(result, []);
});

test('expected miss returns [] rather than a wild guess: one incidental shared word stays below MIN_SCORE', () => {
  // "form" appears once in baseFlow()'s default description ("Fill the
  // order form...") but not in its name or step target text, so it can
  // only ever earn the lexical layer's flat LEXICAL_TOKEN_SCORE (10) --
  // never the name-token boost. That single token's score must sit below
  // MIN_SCORE (20): a lone coincidental word must never surface a
  // candidate on its own.
  assert.ok(LEXICAL_TOKEN_SCORE < MIN_SCORE, 'test assumes a lone token cannot reach MIN_SCORE');
  const flow = baseFlow();
  const result = matchFlows({
    flows: [entry(flow)],
    intent: 'form some completely different unrelated thing entirely',
  });
  assert.deepEqual(result, []);
});

test('exact origin+urlPattern match beats a lexical-only competitor', () => {
  const exact = baseFlow({
    name: 'exact-match-flow',
    description: 'Totally unrelated wording sharing nothing with the request.',
    origin: 'http://localhost:4823',
    urlPattern: '/checkout/:plan',
  });
  // Shares four lexical tokens with the intent (40 points) but does not
  // match the urlPattern and has no name-token overlap -- strictly less
  // than the exact match's flat URL_PATTERN_MATCH_SCORE (100).
  const lexicalOnly = baseFlow({
    name: 'lexical-only-flow',
    description: 'Renew a membership subscription plan today.',
    origin: 'http://localhost:4823',
    urlPattern: '/account/settings',
  });

  const result = matchFlows({
    flows: [entry(lexicalOnly), entry(exact)],
    origin: 'http://localhost:4823',
    url: 'http://localhost:4823/checkout/gold',
    intent: 'renew a membership subscription plan',
  });

  assert.equal(result.length, 2);
  assert.equal(result[0].flow.name, 'exact-match-flow');
  assert.equal(result[0].score, URL_PATTERN_MATCH_SCORE);
  assert.equal(result[1].flow.name, 'lexical-only-flow');
  assert.equal(result[1].score, LEXICAL_TOKEN_SCORE * 4);
  assert.ok(result[0].score > result[1].score);
});

test('urlPattern :param segments match any single path segment value', () => {
  const flow = baseFlow({ urlPattern: '/checkout/:plan' });
  const result = matchFlows({
    flows: [entry(flow)],
    url: 'http://localhost:4823/checkout/anything-goes-here',
    intent: '',
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].score, URL_PATTERN_MATCH_SCORE);
});

test('urlPattern does not match when the path segment count differs', () => {
  const flow = baseFlow({ urlPattern: '/checkout/:plan' });
  const result = matchFlows({
    flows: [entry(flow)],
    url: 'http://localhost:4823/checkout/gold/extra',
    intent: '',
  });
  assert.deepEqual(result, []);
});

test('urlPattern literal segments must match exactly outside of :param tokens', () => {
  const flow = baseFlow({ urlPattern: '/checkout/:plan' });
  const result = matchFlows({
    flows: [entry(flow)],
    url: 'http://localhost:4823/cart/gold',
    intent: '',
  });
  assert.deepEqual(result, []);
});

test('name-token equality with intent is a flat strong boost, not per-token', () => {
  const flow = baseFlow({ name: 'book-flight', description: 'Book air travel.' });
  const result = matchFlows({ flows: [entry(flow)], intent: 'book a flight' });
  assert.equal(result.length, 1);
  // Both "book" and "flight" overlap the name, but the name-token layer is
  // a flat one-time boost -- not NAME_TOKEN_MATCH_SCORE * 2. The lexical
  // layer still separately counts both tokens (they're also part of the
  // corpus), so the exact total is the flat boost plus two lexical hits.
  assert.equal(result[0].score, NAME_TOKEN_MATCH_SCORE + LEXICAL_TOKEN_SCORE * 2);
  assert.ok(result[0].score < NAME_TOKEN_MATCH_SCORE * 2);
});

test('origin mismatch filters the flow out entirely, even when it would otherwise score highest', () => {
  const wrongOrigin = baseFlow({
    name: 'wrong-origin-flow',
    origin: 'http://other.example:9999',
    urlPattern: '/checkout/:plan',
  });
  const result = matchFlows({
    flows: [entry(wrongOrigin)],
    origin: 'http://localhost:4823',
    url: 'http://localhost:4823/checkout/gold',
    intent: 'place an order',
  });
  assert.deepEqual(result, []);
});

test('origin filter is host case-insensitive and ignores unrelated URL parts', () => {
  const flow = baseFlow({ origin: 'http://localhost:4823' });
  const result = matchFlows({
    flows: [entry(flow)],
    origin: 'HTTP://LocalHost:4823',
    url: 'http://localhost:4823/checkout/gold',
    intent: '',
  });
  assert.equal(result.length, 1);
});

test('quarantine (failStreak >= 3) halves the score and can drop a flow below a healthy competitor', () => {
  const quarantined = baseFlow({
    name: 'legacy-checkout',
    description: 'wordone wordtwo wordthree wordfour wordfive wordsix wordseven',
    steps: [
      { op: 'goto', url: '/checkout' },
      {
        op: 'click',
        target: target({ name: 'wordeight wordnine wordten wordeleven', description: 'wordtwelve wordthirteen wordfourteen' }),
      },
    ],
    provenance: baseProvenance({ failStreak: 3 }),
  });
  const healthy = baseFlow({
    name: 'healthyword-flow',
    description: 'A simple healthyword flow description.',
  });

  const intent = [
    'wordone', 'wordtwo', 'wordthree', 'wordfour', 'wordfive', 'wordsix', 'wordseven',
    'wordeight', 'wordnine', 'wordten', 'wordeleven', 'wordtwelve', 'wordthirteen', 'wordfourteen',
    'healthyword',
  ].join(' ');

  const result = matchFlows({ flows: [entry(quarantined), entry(healthy)], intent });

  const quarantinedResult = result.find((candidate) => candidate.flow.name === 'legacy-checkout');
  const healthyResult = result.find((candidate) => candidate.flow.name === 'healthyword-flow');

  assert.ok(quarantinedResult, 'quarantined flow still surfaces (downweighted, not silently dropped)');
  assert.ok(healthyResult);

  // Pre-quarantine, the "legacy-checkout" flow shares 14 lexical tokens
  // (140 raw points) -- more than the healthy flow's name-token boost plus
  // one lexical token (110). Quarantine must invert that ordering.
  assert.equal(quarantinedResult.score, 14 * LEXICAL_TOKEN_SCORE * QUARANTINE_SCORE_MULTIPLIER);
  assert.equal(healthyResult.score, NAME_TOKEN_MATCH_SCORE + LEXICAL_TOKEN_SCORE);
  assert.ok(quarantinedResult.score < healthyResult.score);
  assert.equal(result[0].flow.name, 'healthyword-flow');
  assert.ok(quarantinedResult.reasons.includes('quarantined: re-record likely cheaper'));
  assert.deepEqual(healthyResult.reasons, []);
});

test('pending-tier flows are returned but not runnable, with the approve-command reason', () => {
  const flow = baseFlow({ name: 'send-invite' });
  const result = matchFlows({
    flows: [entry(flow, 'pending')],
    intent: 'send invite',
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].runnable, false);
  assert.deepEqual(result[0].reasons, ['pending approval: fast-browser flows approve send-invite']);
});

test('ready-tier flow with no js steps is runnable with empty reasons', () => {
  const flow = baseFlow({ name: 'send-invite' });
  const result = matchFlows({
    flows: [entry(flow, 'ready')],
    intent: 'send invite',
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].runnable, true);
  assert.deepEqual(result[0].reasons, []);
});

test('a flow containing any js step is not runnable, even on the ready tier', () => {
  const flowWithHashedJsStep = baseFlow({
    name: 'run-script-flow',
    steps: [
      { op: 'goto', url: '/checkout' },
      { op: 'js', sha256: 'b'.repeat(64), args: {} },
    ],
  });
  const flowWithOpaqueJsStep = baseFlow({
    name: 'run-opaque-script-flow',
    steps: [
      { op: 'goto', url: '/checkout' },
      { op: 'js', sha256: null, args: {} },
    ],
  });

  for (const flow of [flowWithHashedJsStep, flowWithOpaqueJsStep]) {
    const result = matchFlows({
      flows: [entry(flow, 'ready')],
      intent: flow.name.replace(/-/g, ' '),
    });
    assert.equal(result.length, 1, flow.name);
    assert.equal(result[0].runnable, false, flow.name);
    assert.ok(result[0].reasons.includes('contains js step: not replayable in v1'), flow.name);
  }
});

test('a pending flow with a js step carries both non-runnable reasons', () => {
  const flow = baseFlow({
    name: 'run-script-flow',
    steps: [
      { op: 'goto', url: '/checkout' },
      { op: 'js', sha256: 'b'.repeat(64), args: {} },
    ],
  });
  const result = matchFlows({
    flows: [entry(flow, 'pending')],
    intent: 'run script flow',
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].runnable, false);
  assert.deepEqual(result[0].reasons, [
    'pending approval: fast-browser flows approve run-script-flow',
    'contains js step: not replayable in v1',
  ]);
});

test('ties are broken by flow name ascending', () => {
  const flowB = baseFlow({ name: 'bravo-flow', description: 'shared description text.' });
  const flowA = baseFlow({ name: 'alpha-flow', description: 'shared description text.' });
  const flowC = baseFlow({ name: 'charlie-flow', description: 'shared description text.' });

  const result = matchFlows({
    flows: [entry(flowB), entry(flowA), entry(flowC)],
    intent: 'shared description text',
  });

  assert.deepEqual(result.map((candidate) => candidate.flow.name), ['alpha-flow', 'bravo-flow', 'charlie-flow']);
  assert.equal(result[0].score, result[1].score);
  assert.equal(result[1].score, result[2].score);
});

test('results are capped at MAX_RESULTS, keeping the highest scores', () => {
  // Seven candidates, each named after its own dominant word and sharing a
  // strictly decreasing-size prefix of the word list with the intent --
  // every candidate clears MIN_SCORE (each earns at least the name-token
  // boost from its own word), so this isolates the MAX_RESULTS cap itself:
  // only the 5 highest-scoring names come back, in score order.
  const words = ['tango', 'uniform', 'victor', 'whiskey', 'xray', 'yankee', 'zulu'];
  const flows = words.map((_, index) => {
    const sharedCount = words.length - index; // 7, 6, 5, 4, 3, 2, 1
    const shared = words.slice(0, sharedCount).join(' ');
    return baseFlow({ name: `${words[index]}-flow`, description: `${shared}.` });
  });

  const result = matchFlows({
    flows: flows.map((flow) => entry(flow)),
    intent: words.join(' '),
  });

  assert.equal(result.length, MAX_RESULTS);
  assert.deepEqual(
    result.map((candidate) => candidate.flow.name),
    ['tango-flow', 'uniform-flow', 'victor-flow', 'whiskey-flow', 'xray-flow'],
  );
  for (let i = 1; i < result.length; i += 1) {
    assert.ok(result[i - 1].score >= result[i].score);
  }
});

test('lexical layer counts step target name and description tokens, deduped per flow', () => {
  const flow = baseFlow({
    name: 'unrelated-name',
    description: 'unrelated description text.',
    steps: [
      { op: 'goto', url: '/checkout' },
      {
        op: 'click',
        target: target({ name: 'delta echo', description: 'foxtrot golf' }),
      },
      {
        op: 'expect',
        target: target({ name: 'delta echo', description: 'foxtrot golf' }),
        state: 'visible',
      },
    ],
  });
  const result = matchFlows({
    flows: [entry(flow)],
    intent: 'delta echo foxtrot golf',
  });
  assert.equal(result.length, 1);
  // 4 distinct tokens (delta, echo, foxtrot, golf), each counted once even
  // though the same target text appears on two steps.
  assert.equal(result[0].score, 4 * LEXICAL_TOKEN_SCORE);
});

test('an absent origin skips the hard filter entirely', () => {
  const flow = baseFlow({ origin: 'http://anything.example:1' });
  const result = matchFlows({
    flows: [entry(flow)],
    url: flow.origin + '/checkout/gold',
    intent: '',
  });
  assert.equal(result.length, 1);
});

test('an absent url skips the urlPattern layer entirely', () => {
  const flow = baseFlow();
  const result = matchFlows({ flows: [entry(flow)], intent: '' });
  assert.deepEqual(result, []);
});

test('score is always a number and reasons is always an array', () => {
  const flow = baseFlow();
  const result = matchFlows({
    flows: [entry(flow)],
    origin: flow.origin,
    url: `${flow.origin}/checkout/gold`,
    intent: 'place an order',
  });
  assert.equal(result.length, 1);
  assert.equal(typeof result[0].score, 'number');
  assert.ok(Array.isArray(result[0].reasons));
});

// --- band flags (WS3b Task 7): additive booleans find's rerank stage reads
// to keep an encoder-backed reorder from ever crossing an exact-first
// boundary. Pinned independently of `score` itself, since score also mixes
// in the lexical layer. ---

test('urlPatternHit/nameTokenHit are both true for a candidate that earns both exact-first layers', () => {
  const flow = baseFlow({ name: 'place-order' });
  const result = matchFlows({
    flows: [entry(flow)],
    origin: flow.origin,
    url: `${flow.origin}/checkout/gold`,
    intent: 'place order now',
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].urlPatternHit, true);
  assert.equal(result[0].nameTokenHit, true);
});

test('urlPatternHit/nameTokenHit are both false for a lexical-only match', () => {
  const flow = baseFlow({
    name: 'unrelated-flow-name',
    description: 'Renew a membership subscription plan today.',
  });
  const result = matchFlows({
    flows: [entry(flow)],
    intent: 'renew a membership subscription plan',
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].urlPatternHit, false);
  assert.equal(result[0].nameTokenHit, false);
});

test('urlPatternHit and nameTokenHit are independent -- a name-token hit with no url given', () => {
  const flow = baseFlow({ name: 'place-order' });
  const result = matchFlows({ flows: [entry(flow)], intent: 'place order' });
  assert.equal(result.length, 1);
  assert.equal(result[0].urlPatternHit, false);
  assert.equal(result[0].nameTokenHit, true);
});
