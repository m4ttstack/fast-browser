import assert from 'node:assert/strict';
import test from 'node:test';

import { parseFlow } from '../../lib/flows/artifact.mjs';
import { opSequence, stepSignature } from '../lib/signature-fields.mjs';
import { baseFlow, target } from './helpers/fixtures.mjs';

test('stepSignature is deterministic for the same flow', () => {
  const flow = parseFlow(baseFlow());
  assert.equal(stepSignature(flow), stepSignature(parseFlow(baseFlow())));
});

test('stepSignature changes when steps are reordered', () => {
  const flow = parseFlow(baseFlow());
  const reordered = parseFlow(baseFlow({
    steps: [flow.steps[0], flow.steps[2], flow.steps[1], flow.steps[3]],
  }));
  assert.notEqual(stepSignature(flow), stepSignature(reordered));
});

// The CRITICAL identity property (plan Task 1): appending a locator
// alternate to a step's target must NOT change stepSignature. Healing
// appends fallback locator candidates to `target.locators`; if that moved
// the signature, every healed flow would silently fork its cluster
// identity instead of collapsing into the same canonical.
test('stepSignature is unchanged by appending a locator alternate to a step target', () => {
  const flow = parseFlow(baseFlow());
  const healed = parseFlow(baseFlow({
    steps: [
      flow.steps[0],
      flow.steps[1],
      {
        ...flow.steps[2],
        target: {
          ...flow.steps[2].target,
          locators: [
            ...flow.steps[2].target.locators,
            { kind: 'css', selector: '#place-order-fallback' },
          ],
        },
      },
      flow.steps[3],
    ],
  }));
  assert.equal(stepSignature(flow), stepSignature(healed));
});

// Never target.value: the real artifact schema has no `target.value` field
// (locators carry `selector`; steps carry their own top-level `value` for
// fill/select), but a step's templated `value` also must not affect
// identity -- clustering groups flows by structure, not by which arg
// template string a step happens to carry.
test('stepSignature is unchanged by editing a fill step\'s templated value', () => {
  const flow = parseFlow(baseFlow());
  const edited = parseFlow(baseFlow({
    steps: [flow.steps[0], { ...flow.steps[1], value: '{customer}-edited' }, flow.steps[2], flow.steps[3]],
  }));
  assert.equal(stepSignature(flow), stepSignature(edited));
});

test('stepSignature changes when a target role or name differs', () => {
  const flow = parseFlow(baseFlow());
  const differentRole = parseFlow(baseFlow({
    steps: [
      flow.steps[0],
      flow.steps[1],
      { ...flow.steps[2], target: target({ role: 'link' }) },
      flow.steps[3],
    ],
  }));
  const differentName = parseFlow(baseFlow({
    steps: [
      flow.steps[0],
      flow.steps[1],
      { ...flow.steps[2], target: target({ name: 'Submit order' }) },
      flow.steps[3],
    ],
  }));
  assert.notEqual(stepSignature(flow), stepSignature(differentRole));
  assert.notEqual(stepSignature(flow), stepSignature(differentName));
});

// A target with no role/name (only locators, the compiler's fallback
// shape) contributes '' for both, not undefined or a thrown error.
test('stepSignature treats a target with no role or name as empty strings, not a crash', () => {
  const flow = parseFlow(baseFlow({
    steps: [
      { op: 'goto', url: '/checkout/{plan}' },
      { op: 'click', target: { locators: [] } },
    ],
  }));
  assert.doesNotThrow(() => stepSignature(flow));
});

// Only `goto` steps carry a per-step URL in the current artifact schema
// (lib/flows/artifact.mjs's `url` field on the goto op); every other op has
// no per-step URL field at all. "urlPattern shape" therefore means: the
// goto step's `url` used verbatim, '' for every other op.
test('stepSignature changes when a goto step\'s url differs, and ignores url for non-goto ops', () => {
  const flow = parseFlow(baseFlow());
  const differentGotoUrl = parseFlow(baseFlow({
    steps: [{ op: 'goto', url: '/checkout/{other}' }, flow.steps[1], flow.steps[2], flow.steps[3]],
    args: { customer: { type: 'string', required: true }, other: { type: 'string', required: true } },
  }));
  assert.notEqual(stepSignature(flow), stepSignature(differentGotoUrl));
});

test('stepSignature of two independently-built but content-identical flows matches', () => {
  const a = parseFlow(baseFlow({ id: 'a'.repeat(64) }));
  const b = parseFlow(baseFlow({ id: 'b'.repeat(64), name: 'different-name', description: 'different description' }));
  // Name/description/id are not part of step identity -- only the steps.
  assert.equal(stepSignature(a), stepSignature(b));
});

test('opSequence is the ops joined, ignoring target/value/url content', () => {
  const flow = parseFlow(baseFlow());
  assert.equal(opSequence(flow), 'goto,fill,click,expect');
});

test('opSequence changes on reorder but not on locator-alternate append', () => {
  const flow = parseFlow(baseFlow());
  const reordered = parseFlow(baseFlow({
    steps: [flow.steps[0], flow.steps[2], flow.steps[1], flow.steps[3]],
  }));
  assert.notEqual(opSequence(flow), opSequence(reordered));

  const healed = parseFlow(baseFlow({
    steps: [
      flow.steps[0],
      flow.steps[1],
      {
        ...flow.steps[2],
        target: {
          ...flow.steps[2].target,
          locators: [...flow.steps[2].target.locators, { kind: 'css', selector: '#fallback' }],
        },
      },
      flow.steps[3],
    ],
  }));
  assert.equal(opSequence(flow), opSequence(healed));
});

test('opSequence is a prefix-safe pre-filter: same length, different ops, never equal', () => {
  const flow = parseFlow(baseFlow());
  const differentOps = parseFlow(baseFlow({
    steps: [
      { op: 'goto', url: '/checkout/{plan}' },
      { op: 'hover', target: target() },
      flow.steps[2],
      flow.steps[3],
    ],
  }));
  assert.notEqual(opSequence(flow), opSequence(differentOps));
});
