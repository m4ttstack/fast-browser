import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_LOCATOR_CANDIDATES, expandLocatorCandidates, probeKey,
} from '../../lib/flows/locators.mjs';

// The DOA flow measured in the MAT-330 spike: one over-specified captured
// locator, no alternates. Its accessible name appears on two links on the
// live page (the thumbnail anchor and the title anchor), which is why
// flow-runner's role+name resolution -- which drops the `[description=...]`
// qualifier -- resolved to two elements and missed.
const DOA_SELECTOR = 'internal:role=link[name="It\'s Only the Himalayas"i][description="It\'s Only the Himalayas"i]';

function doaTarget() {
  return {
    locators: [{ kind: 'role', selector: DOA_SELECTOR }],
    description: "It's Only the Himalayas",
    role: 'link',
    name: "It's Only the Himalayas",
  };
}

test('a single over-specified role locator gains ranked fallback candidates', () => {
  const expanded = expandLocatorCandidates(doaTarget());

  assert.ok(expanded.length > 1, 'the DOA shape must no longer compile to a single candidate');
  assert.deepEqual(expanded[0], { kind: 'role', selector: DOA_SELECTOR }, 'the captured locator stays first, verbatim');
  assert.deepEqual(
    expanded[1],
    { kind: 'other', selector: DOA_SELECTOR },
    'the captured selector is probed verbatim next, recovering the precision role+name resolution drops',
  );
  assert.deepEqual(expanded.map((candidate) => candidate.kind).slice(2), ['other', 'text', 'css']);
});

test('the synthesized ladder breaks ambiguity, then leaves the role vocabulary', () => {
  const selectors = expandLocatorCandidates(doaTarget()).map((candidate) => candidate.selector);

  // No plain `role=link[name=...]` rung: the captured candidate above is
  // already resolved as role+name by flow-runner, so that query has been
  // probed (and missed) by the time the ladder gets here.
  assert.deepEqual(selectors.slice(2), [
    'internal:role=link[name="It\'s Only the Himalayas"i] >> nth=0',
    'internal:text="It\'s Only the Himalayas"i >> nth=0',
    'a:has-text("It\'s Only the Himalayas") >> nth=0',
  ]);
});

test('every captured candidate is preserved, in order, ahead of every synthesized one', () => {
  const expanded = expandLocatorCandidates({
    locators: [
      { kind: 'role', selector: 'internal:role=link[name="Travel"i]' },
      { kind: 'role', selector: 'internal:role=link >> nth=3' },
    ],
    role: 'link',
    name: 'Travel',
  });

  assert.deepEqual(expanded.slice(0, 2), [
    { kind: 'role', selector: 'internal:role=link[name="Travel"i]' },
    { kind: 'role', selector: 'internal:role=link >> nth=3' },
  ]);
  // The structural alternate the capture layer recorded is dead weight as a
  // `role` candidate: flow-runner resolves EVERY role candidate from the
  // target's own role+name, so it probes the same query as the one above it
  // and is deduped away. Its verbatim twin is what actually gets probed.
  assert.ok(
    expanded.some((candidate) => candidate.kind === 'other' && candidate.selector === 'internal:role=link >> nth=3'),
    'a captured role candidate whose selector is not the plain role+name form gains a verbatim twin',
  );
});

test('a captured role candidate that is already the plain role+name form gains no redundant twin', () => {
  const expanded = expandLocatorCandidates({
    locators: [{ kind: 'role', selector: 'internal:role=link[name="next"i]' }],
    role: 'link',
    name: 'next',
  });

  const plainForm = expanded.filter((candidate) => candidate.selector === 'internal:role=link[name="next"i]');
  assert.equal(plainForm.length, 1, 'the runner already probes exactly this query for the captured candidate');
});

test('a target with no captured locators still gets a full synthesized ladder', () => {
  const expanded = expandLocatorCandidates({ locators: [], role: 'button', name: 'Place order' });

  assert.deepEqual(expanded, [
    { kind: 'other', selector: 'internal:role=button[name="Place order"i]' },
    { kind: 'other', selector: 'internal:role=button[name="Place order"i] >> nth=0' },
    { kind: 'text', selector: 'internal:text="Place order"i >> nth=0' },
    { kind: 'css', selector: 'button:has-text("Place order") >> nth=0' },
  ]);
});

test('a name with no role synthesizes the text rung only', () => {
  const expanded = expandLocatorCandidates({
    locators: [{ kind: 'css', selector: '#confirm' }],
    name: 'Confirm',
  });

  assert.deepEqual(expanded, [
    { kind: 'css', selector: '#confirm' },
    { kind: 'text', selector: 'internal:text="Confirm"i >> nth=0' },
  ]);
});

test('a role whose tag is unknown skips the structural rung', () => {
  const expanded = expandLocatorCandidates({ locators: [], role: 'textbox', name: 'Username' });

  assert.deepEqual(expanded.map((candidate) => candidate.kind), ['other', 'other', 'text']);
});

test('quotes and backslashes in a name are escaped for every synthesized selector', () => {
  const expanded = expandLocatorCandidates({ locators: [], role: 'button', name: 'Say "hi"\\now' });

  for (const candidate of expanded) {
    assert.ok(candidate.selector.includes('\\"hi\\"'), `unescaped quote in ${candidate.selector}`);
    assert.ok(candidate.selector.includes('\\\\now'), `unescaped backslash in ${candidate.selector}`);
  }
});

test('a target with nothing to synthesize from is returned untouched', () => {
  const locators = [{ kind: 'css', selector: '#confirm' }];
  assert.deepEqual(expandLocatorCandidates({ locators }), locators);
  assert.deepEqual(expandLocatorCandidates({ locators: [] }), []);
  assert.deepEqual(expandLocatorCandidates(null), []);
});

test('a name that cannot be expressed as a selector literal synthesizes nothing', () => {
  const multiline = expandLocatorCandidates({ locators: [], role: 'button', name: 'line one\nline two' });
  assert.deepEqual(multiline, []);

  const huge = expandLocatorCandidates({ locators: [], role: 'button', name: 'x'.repeat(201) });
  assert.deepEqual(huge, []);

  const blank = expandLocatorCandidates({ locators: [], role: 'button', name: '   ' });
  assert.deepEqual(blank, []);
});

test('a non-token role is never spliced into a selector', () => {
  const expanded = expandLocatorCandidates({ locators: [], role: 'link[name="x"]', name: 'Travel' });

  assert.deepEqual(expanded, [{ kind: 'text', selector: 'internal:text="Travel"i >> nth=0' }]);
});

test('the ladder is bounded, and the bound never drops a captured candidate', () => {
  const locators = Array.from({ length: MAX_LOCATOR_CANDIDATES + 3 }, (unused, index) => ({
    kind: 'css',
    selector: `#c${index}`,
  }));
  const expanded = expandLocatorCandidates({ locators, role: 'button', name: 'Go' });

  assert.deepEqual(expanded, locators, 'captured candidates are never dropped, and leave no room for synthesis');

  const nearBound = Array.from({ length: MAX_LOCATOR_CANDIDATES - 1 }, (unused, index) => ({
    kind: 'css',
    selector: `#c${index}`,
  }));
  const partial = expandLocatorCandidates({ locators: nearBound, role: 'button', name: 'Go' });
  assert.equal(partial.length, MAX_LOCATOR_CANDIDATES);
});

test('probeKey mirrors flow-runner candidateKey, so the ladder never carries two candidates it would collapse', () => {
  const target = { role: 'link', name: 'Travel' };
  assert.equal(probeKey(target, { kind: 'role', selector: 'anything' }), 'role:link:Travel');
  assert.equal(probeKey(target, { kind: 'other', selector: '#a' }), 'other:#a');
  assert.equal(probeKey({ role: 'link' }, { kind: 'role', selector: '#a' }), 'role:#a');

  const keys = expandLocatorCandidates(doaTarget()).map((candidate) => probeKey(doaTarget(), candidate));
  assert.equal(new Set(keys).size, keys.length, 'no two candidates in a ladder share a probe key');
});
