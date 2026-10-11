import assert from 'node:assert/strict';
import test from 'node:test';

import { validateSpec } from '../../lib/compose/spec.mjs';

const capture = (over = {}) => ({ boxes: { name: [10, 10, 50, 20], phone: [10, 40, 80, 20] }, missed: [], ...over });
const base = (marks) => ({
  state: 'AFTER', title: 'A board', layout: 'single', out: 'r-c-after.png',
  panels: [{ capture: 'r-c-after.c1.capture.json', marks }],
});

test('a valid lift and redact spec has no problems', () => {
  assert.deepEqual(validateSpec(base([
    { lift: 'name', title: 'Name', note: 'Shown', tag: 'NEW' },
    { redact: 'phone' },
  ]), [capture()]), []);
});

test('every problem is reported, by field and index, never by value', () => {
  const problems = validateSpec({
    state: 'DONE', title: '', layout: 'grid', out: '', panels: [{ capture: 'x.json', marks: [
      { lift: 'nope', title: 'X', tag: 'SHINY' }, { bracket: ['name'] }, {},
    ] }],
  }, [capture()]);
  assert.ok(problems.includes('state must be one of AFTER, BEFORE → AFTER, FLOW, FOUND'));
  assert.ok(problems.includes('title is required'));
  assert.ok(problems.includes('layout must be single in this version'));
  assert.ok(problems.includes('out is required'));
  assert.ok(problems.includes('panels[0].marks[0] names a key the capture did not measure'));
  assert.ok(problems.includes('panels[0].marks[0].tag must be one of NEW, CHANGED, REMOVED, ISSUE, PENDING, OK'));
  assert.ok(problems.includes('panels[0].marks[1] is not a supported mark in this version'));
  assert.ok(problems.includes('panels[0].marks[2] is not a supported mark in this version'));
  assert.equal(problems.some((p) => p.includes('nope') || p.includes('SHINY')), false);
});

test('a redact key the capture reported as missed is refused', () => {
  const problems = validateSpec(base([{ redact: 'email' }]),
    [capture({ missed: [{ key: 'email', reason: 'ambiguous' }] })]);
  assert.ok(problems.includes('panels[0].marks[0] redacts a key the capture missed; fix the selector and recapture'));
});

test('a panel with no marks and no capture is refused', () => {
  const problems = validateSpec({ ...base([]), panels: [{}] }, [null]);
  assert.ok(problems.includes('panels[0].capture is required'));
});

test('an empty panel list is refused', () => {
  assert.ok(validateSpec({ ...base([]), panels: [] }, []).includes('panels must list exactly one panel in this version'));
});

test('an out that is not a png is refused by field', () => {
  const problems = validateSpec({ ...base([]), out: 'board.jpg' }, [capture()]);
  assert.ok(problems.includes('out must end in .png'));
  assert.equal(problems.some((p) => p.includes('board')), false);
});

test('a mark key that is not text is refused, even beside a measured key', () => {
  const problems = validateSpec(base([{ redact: ['name', 99] }, { lift: 7 }]), [capture()]);
  assert.ok(problems.includes('panels[0].marks[0] names a key that is not text'));
  assert.ok(problems.includes('panels[0].marks[1] names a key that is not text'));
});

test('marks that are not a list are refused', () => {
  const problems = validateSpec(base({ lift: 'name' }), [capture()]);
  assert.ok(problems.includes('panels[0].marks must be a list'));
});

for (const [label, spec] of [['null', null], ['an array', []], ['text', 'spec']]) {
  test(`a spec that is ${label} is refused as a problem, not a crash`, () => {
    assert.deepEqual(validateSpec(spec, []), ['the spec must be a JSON object']);
  });
}
