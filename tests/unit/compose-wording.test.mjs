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

const warns = (title, mark) => wordingWarnings(board(title, [{ lift: 'a', ...mark }]), [live]).includes(TITLE_WARNING);

test('a short callout that names the same record or fact as the title does not warn', () => {
  const plan = "The leased van is on the fleet plan; the rental van's cover is unknown";
  assert.equal(warns(plan, { title: 'Leased van (LV)', note: 'Van on plan' }), false);
  assert.equal(warns('A plan lookup enriched the leased van\'s record', { title: 'Enriched by plan lookup' }), false);
  assert.equal(warns('Three plan checks sit together on the driver card', { title: 'Plan checks' }), false);
  assert.equal(warns('The project carries the pinned badge', { title: 'Pinned' }), false);
  assert.equal(warns('Ana leads the release', { title: 'Owner', note: 'Ana leads it' }), false);
});

test('a label that copies the title warns', () => {
  const title = 'Ana leads the release';
  assert.equal(warns(title, { title }), true, 'the title itself');
  assert.equal(warns(title, { note: 'ana leads the release.' }), true, 'in another case and with a stop');
  assert.equal(warns(title, { title: 'Ana leads release' }), true, 'with its article dropped');
  assert.equal(warns('Ana leads release', { title: 'Ana leads the release' }), true, 'with an article added');
  assert.equal(warns('Plan checks', { title: 'Plan checks' }), true, 'a short title copied whole');
});

test('a label of four counted words that runs in the title\'s order warns', () => {
  const title = "The leased van is on the fleet plan; the rental van's cover is unknown";
  assert.equal(warns(title, { note: 'Leased van on fleet plan' }), true);
  assert.equal(warns(title, { note: 'Rental van cover unknown' }), true);
  assert.equal(warns(title, { note: 'Fleet plan, leased van' }), false, 'out of order');
  assert.equal(warns(title, { note: 'Leased van on fleet' }), false, 'three counted words');
  assert.equal(warns(title, { note: 'Leased van on the new fleet plan' }), false, 'a word the title lacks');
});

test('a repeat in many marks warns once', () => {
  const spec = board('Ana leads the release', [{ lift: 'a', title: 'Ana leads release' }, { lift: 'b', note: 'Ana leads the release' }]);
  assert.deepEqual(wordingWarnings(spec, [live]), [TITLE_WARNING]);
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
