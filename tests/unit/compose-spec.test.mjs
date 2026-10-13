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
      { lift: 'nope', title: 'X', tag: 'SHINY' }, { sparkle: ['name'] }, {},
    ] }],
  }, [capture()]);
  assert.ok(problems.includes('state must be one of AFTER, BEFORE → AFTER, FLOW, FOUND'));
  assert.ok(problems.includes('title is required'));
  assert.ok(problems.includes('layout must be one of single, pair, steps'));
  assert.ok(problems.includes('out is required'));
  assert.ok(problems.includes('panels[0].marks[0] names a key the capture did not measure'));
  assert.ok(problems.includes('panels[0].marks[0].tag must be one of NEW, CHANGED, REMOVED, ISSUE, PENDING, OK'));
  assert.ok(problems.includes('panels[0].marks[1] is not a supported mark in this version'));
  assert.ok(problems.includes('panels[0].marks[2] is not a supported mark in this version'));
  assert.equal(problems.some((p) => p.includes('nope') || p.includes('SHINY')), false);
});

test('a bracket groups one or more keys and must say what it groups', () => {
  assert.deepEqual(validateSpec(base([{ bracket: ['name', 'phone'], title: 'Two rows', note: 'Both changed' }]), [capture()]), []);
  assert.ok(validateSpec(base([{ bracket: ['name', 'phone'] }]), [capture()]).includes('panels[0].marks[0].title is required'));
});

test('a link joins exactly two different keys under one title', () => {
  assert.deepEqual(validateSpec(base([{ link: ['name', 'phone'], title: 'Same fact, two places' }]), [capture()]), []);
  const problems = validateSpec(base([{ link: ['name'], title: 'One' }, { link: ['name', 'name'], title: 'Twice' }, { link: ['name', 'phone'] }]), [capture()]);
  assert.ok(problems.includes('panels[0].marks[0] takes exactly two different keys'));
  assert.ok(problems.includes('panels[0].marks[1] takes exactly two different keys'));
  assert.ok(problems.includes('panels[0].marks[2].title is required'));
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
  assert.ok(validateSpec({ ...base([]), panels: [] }, []).includes('a single layout takes exactly one panel'));
});

test('an out that is not a png is refused by field', () => {
  const problems = validateSpec({ ...base([]), out: 'board.jpg' }, [capture()]);
  assert.ok(problems.includes('out must end in .png'));
  assert.equal(problems.some((p) => p.includes('board')), false);
});

test('an out shaped like a redaction crop or record is refused by field', () => {
  for (const out of ['board.redact-1.png', 'sub/Board.REDACT-12.png', 'board.redactions.json']) {
    const problems = validateSpec({ ...base([]), out }, [capture()]);
    assert.ok(problems.some((p) => /^out must not be named like a redaction/.test(p)), out);
    assert.equal(problems.some((p) => p.includes('board') || p.includes('Board')), false, 'the value is not echoed');
  }
  assert.deepEqual(validateSpec({ ...base([]), out: 'board.redacted.png' }, [capture()]), []);
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

test('ghost and empty take one key and optional words', () => {
  assert.deepEqual(validateSpec(base([
    { empty: 'name', text: 'Nothing rendered here' },
    { ghost: 'phone', tag: 'REMOVED', title: 'Gone', note: 'Removed in this change' },
  ]), [capture()]), []);
});

test('a slot refuses a key list, long text and words that are not text', () => {
  const problems = validateSpec(base([
    { empty: ['name', 'phone'] }, { ghost: 'name', title: '' }, { empty: 'name', text: 'x'.repeat(81) },
    { ghost: 'name', note: 7 }, { ghost: 'name', tag: 'SHINY' }, { empty: 'nowhere' },
  ]), [capture()]);
  assert.ok(problems.includes('panels[0].marks[0] takes exactly one key'));
  assert.ok(problems.includes('panels[0].marks[1].title must not be empty'));
  assert.ok(problems.includes('panels[0].marks[2].text must be text of at most 80 characters'));
  assert.ok(problems.includes('panels[0].marks[3].note must be text'));
  assert.ok(problems.includes('panels[0].marks[4].tag must be one of NEW, CHANGED, REMOVED, ISSUE, PENDING, OK'));
  assert.ok(problems.includes('panels[0].marks[5] names a key the capture did not measure'));
});

test('redact takes no words', () => {
  assert.deepEqual(validateSpec(base([{ redact: 'phone', title: 'ignored' }]), [capture()]), []);
});

test('a loupe takes one key and a zoom from 2 to 8', () => {
  assert.deepEqual(validateSpec(base([{ loupe: 'name', zoom: 4, title: 'Tiny' }, { loupe: 'phone' }]), [capture()]), []);
  const problems = validateSpec(base([{ loupe: 'name', zoom: 12 }, { loupe: 'name', zoom: '4' }, { loupe: ['name', 'phone'] }]), [capture()]);
  assert.ok(problems.includes('panels[0].marks[0].zoom must be a number from 2 to 8'));
  assert.ok(problems.includes('panels[0].marks[1].zoom must be a number from 2 to 8'));
  assert.ok(problems.includes('panels[0].marks[2] takes exactly one key'));
});

const two = (layout, panels) => ({ state: 'BEFORE → AFTER', title: 'A board', layout, out: 'b.png', panels });
const panel = (over = {}) => ({ capture: 'c.capture.json', marks: [], ...over });

test('a pair takes two labelled panels and steps takes two to four', () => {
  assert.deepEqual(validateSpec(two('pair', [panel({ label: 'BEFORE' }), panel({ label: 'AFTER' })]), [capture(), capture()]), []);
  assert.deepEqual(validateSpec(two('steps', [panel(), panel({ label: 'Open the menu' }), panel()]), [capture(), capture(), capture()]), []);
  assert.ok(validateSpec(two('pair', [panel({ label: 'BEFORE' })]), [capture()]).includes('a pair layout takes exactly two panels'));
  assert.ok(validateSpec(two('pair', [panel({ label: 'BEFORE' }), panel()]), [capture(), capture()]).includes('panels[1].label is required in a pair layout'));
  assert.ok(validateSpec(two('steps', [panel()]), [capture()]).includes('a steps layout takes two to four panels'));
  assert.ok(validateSpec(two('steps', [panel(), panel(), panel(), panel(), panel()]), Array(5).fill(capture())).includes('a steps layout takes two to four panels'));
});

test('a panel label is short text, and each panel checks its own capture', () => {
  const problems = validateSpec(two('pair', [panel({ label: 'x'.repeat(49) }), panel({ label: 7, marks: [{ lift: 'phone' }] })]),
    [capture(), capture({ boxes: { name: [0, 0, 5, 5] } })]);
  assert.ok(problems.includes('panels[0].label must be text of at most 48 characters'));
  assert.ok(problems.includes('panels[1].label must be text of at most 48 characters'));
  assert.ok(problems.includes('panels[1].marks[0] names a key the capture did not measure'));
});

test('a layout must be text, not a list that spells a layout name', () => {
  const problems = validateSpec(two(['pair'], [panel({ label: 'BEFORE' }), panel({ label: 'AFTER' })]), [capture(), capture()]);
  assert.ok(problems.includes('layout must be one of single, pair, steps'));
});

test('a layout name is its own key, never one inherited from Object', () => {
  for (const layout of ['constructor', 'toString']) {
    assert.ok(validateSpec(two(layout, [panel()]), [capture()]).includes('layout must be one of single, pair, steps'));
  }
});

const imported = (over = {}) => ({ source: 'import', size: [800, 600], boxes: {}, missed: [], ...over });
const importPanel = (over = {}) => ({ capture: 'r-before.c1.capture.json', frame: [100, 100, 400, 300], boxes: { map: [120, 120, 200, 100], address: [120, 300, 180, 30] },
  marks: [{ empty: 'map' }, { redact: 'address' }], ...over });
const single = (panel) => ({ state: 'FOUND', title: 'A board', layout: 'single', out: 'b.png', panels: [panel] });

test('an imported panel names its frame and boxes in image pixels', () => {
  assert.deepEqual(validateSpec(single(importPanel()), [imported()]), []);
});

test('an imported panel must give a frame, inside the image', () => {
  assert.ok(validateSpec(single(importPanel({ frame: undefined })), [imported()]).includes('panels[0].frame is required for an imported panel'));
  for (const frame of [[700, 100, 400, 300], [-1, 0, 10, 10], [0, 0, 0, 10], [0, 0, 10], 'all', [0, 0, 10, Number.NaN]]) {
    assert.ok(validateSpec(single(importPanel({ frame })), [imported()]).includes('panels[0].frame must be four numbers inside the image'), JSON.stringify(frame));
  }
});

test('every box of an imported panel lies inside its frame', () => {
  assert.ok(validateSpec(single(importPanel({ boxes: { map: [90, 120, 50, 50] } })), [imported()]).includes('panels[0].boxes has a box outside the frame'));
  assert.ok(validateSpec(single(importPanel({ boxes: { map: [120, 120, 200] } })), [imported()]).includes('panels[0].boxes must map keys to boxes of four numbers'));
  assert.ok(validateSpec(single(importPanel({ boxes: [] })), [imported()]).includes('panels[0].boxes must map keys to boxes of four numbers'));
  assert.ok(validateSpec(single(importPanel({ boxes: null })), [imported()]).includes('panels[0].boxes must map keys to boxes of four numbers'));
});

test('a mark on an imported panel names a key in the panel boxes, redactions included', () => {
  const problems = validateSpec(single(importPanel({ marks: [{ redact: 'phone' }, { lift: 'map' }] })), [imported()]);
  assert.deepEqual(problems, ["panels[0].marks[0] names a key that is not in the panel's boxes"]);
});

test('inspection geometry on a live panel is refused', () => {
  const problems = validateSpec(base([]), [capture()]);
  assert.deepEqual(problems, []);
  const withFrame = { ...base([]), panels: [{ capture: 'c.json', frame: [0, 0, 10, 10], marks: [] }] };
  assert.ok(validateSpec(withFrame, [capture()]).includes('panels[0].frame and panels[0].boxes are only for an imported panel'));
  const withBoxes = { ...base([]), panels: [{ capture: 'c.json', boxes: { name: [0, 0, 10, 10] }, marks: [{ lift: 'name' }] }] };
  assert.ok(validateSpec(withBoxes, [capture()]).includes('panels[0].frame and panels[0].boxes are only for an imported panel'));
});
