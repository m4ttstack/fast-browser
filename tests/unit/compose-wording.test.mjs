import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const sandbox = {};
vm.runInNewContext(await readFile(new URL('../../lib/compose/wording.js', import.meta.url), 'utf8'), sandbox);
const wordingWarnings = (...args) => [...sandbox.__composeWording.wordingWarnings(...args)];

const TITLE_WARNING = "a label repeats the board's title";
const ORIGIN_WARNING = 'a panel label repeats where the image came from';
const live = { source: 'live' };
const imported = { source: 'import' };
const board = (title, marks, panel = {}) => ({ title, panels: [{ ...panel, marks }] });

test('a note whose words sit inside the title warns', () => {
  const spec = board('Ana leads the release', [{ lift: 'a', title: 'Owner', note: 'Ana leads it' }]);
  assert.deepEqual(wordingWarnings(spec, [live]), [TITLE_WARNING]);
});

test('a repeat in many marks warns once', () => {
  const spec = board('Ana leads the release', [{ lift: 'a', title: 'Ana leads release' }, { lift: 'b', note: 'The release, Ana leads' }]);
  assert.deepEqual(wordingWarnings(spec, [live]), [TITLE_WARNING]);
});

test('a note that adds new words does not warn', () => {
  const spec = board('Ana leads the release', [{ lift: 'a', title: 'Owner', note: 'Since the 3rd' }]);
  assert.deepEqual(wordingWarnings(spec, [live]), []);
});

test('a mark with no words or only short words does not warn', () => {
  const spec = board('Ana leads the release', [{ lift: 'a' }, { lift: 'b', title: 'It is' }]);
  assert.deepEqual(wordingWarnings(spec, [live]), []);
});

test('an imported panel labelled with a ticket warns, in any case', () => {
  assert.deepEqual(wordingWarnings(board('Board', [], { label: 'Ticket: map blank' }), [imported]), [ORIGIN_WARNING]);
  assert.deepEqual(wordingWarnings(board('Board', [], { label: 'see TICKET' }), [imported]), [ORIGIN_WARNING]);
});

test('other labels and live panels do not warn', () => {
  assert.deepEqual(wordingWarnings(board('Board', [], { label: 'BEFORE' }), [imported]), []);
  assert.deepEqual(wordingWarnings(board('Board', [], { label: 'Ticket: map blank' }), [live]), []);
});
