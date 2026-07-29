// tests/e2e/affordances.test.mjs
//
// page-affordances.js splits in half. The caller half (selector preference, id
// allowlist, bounds, skip accounting) runs in the macro's own scope and unit
// tests drive it against a fake page. The other half, `collect()`, is handed to
// `page.evaluate()` and runs inside the browser -- and every unit test's fake
// `evaluate` returns a canned payload without ever calling it, so visibility,
// `roleOf`, `kindOf`, the accessible-name walk, the uniqueness tally and the
// landmark rules execute nowhere in the suite.
//
// That is the same shape as the defect that made capture-annotated throw on
// every real call while 486 tests passed. This file closes it by running the
// real macro through the real runtime against a fixture page built to hit each
// of those branches.
//
// The strongest assertion here is not on the payload's shape but on its truth:
// every selector the macro emits is fed back to Playwright and must resolve to
// exactly one element. That is what pins the one known divergence -- the macro
// computes accessible names itself rather than asking Playwright -- because a
// name the two disagree on produces a `role=x[name="y"]` that resolves to zero.
//
// The macro is copied into outputDir rather than referenced in place: the
// runtime applies a path-containment check to `filename` and refuses an
// absolute path outside its allowed roots. See the file-level comment in
// tests/e2e/annotate.test.mjs for the full finding.
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { startAffordanceFixture } from '../fixtures/affordances/server.mjs';
import { startMcpClient } from './helpers/mcp-client.mjs';

const pluginRoot = fileURLToPath(new URL('../../', import.meta.url));

// Counting through page.locator is the point: it is Playwright resolving the
// macro's own output, not the macro checking its own work.
const COUNTER = `async (page, args) => {
  const counts = {};
  for (const selector of args.selectors) {
    counts[selector] = await page.locator(selector).count();
  }
  return counts;
}
`;

async function harness(t) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'fb-affordances-e2e-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }).catch(() => {}));
  const macroPath = path.join(outputDir, 'page-affordances.js');
  await copyFile(path.join(pluginRoot, 'builtins/macros/page-affordances.js'), macroPath);
  const counterPath = path.join(outputDir, 'count-selectors.js');
  await writeFile(counterPath, COUNTER);

  const fixture = await startAffordanceFixture();
  t.after(() => fixture.close().catch(() => {}));
  const client = await startMcpClient({ outputDir });
  t.after(() => client.close().catch(() => {}));

  await client.callTool('browser_navigate', { url: fixture.origin });
  const run = async (args) => {
    const result = await client.callTool('browser_run_code_unsafe', {
      filename: macroPath,
      args,
    });
    // The macro's own failure payload is `{ failedStep, error }`, which is also
    // an object and would otherwise slip past a bare typeof check and fail
    // later with no reference to the macro's error string.
    assert.equal(
      result?.schemaVersion,
      1,
      `macro did not return a schemaVersion-1 payload: ${JSON.stringify(result)}`,
    );
    return result;
  };
  const count = (selectors) => client.callTool('browser_run_code_unsafe', {
    filename: counterPath,
    args: { selectors },
  });
  return { fixture, run, count };
}

function skipCount(result, list, reason) {
  const entry = (result.skipped || []).find(
    (candidate) => candidate.list === list && candidate.reason === reason,
  );
  return entry ? entry.count : 0;
}

const labels = (entries) => entries.map((entry) => entry.label).sort();
const selectorOf = (entries, label) => entries.find((entry) => entry.label === label)?.selector;

test('every selector page-affordances emits resolves to exactly one element', async (t) => {
  const { run, count } = await harness(t);
  const result = await run({});

  const selectors = [...result.fields, ...result.buttons].map((entry) => entry.selector);
  assert.ok(selectors.length > 0, 'the fixture must produce selectors to verify');
  const counts = await count(selectors);

  const wrong = Object.entries(counts).filter(([, value]) => value !== 1);
  assert.deepEqual(
    wrong,
    [],
    'a selector that resolves to 0 is a name this macro and Playwright disagree on;'
      + ' one that resolves to more than 1 is a uniqueness rule that did not hold',
  );
});

test('page-affordances reads roles, names and structure off a real page', async (t) => {
  const { fixture, run } = await harness(t);
  const result = await run({});

  assert.equal(result.url, `${fixture.origin}/`);
  assert.equal(result.title, 'Affordances fixture');

  assert.deepEqual(labels(result.fields), [
    'Accept terms', 'Duplicate', 'Duplicate', 'Full name', 'Passphrase', 'Phone number', 'Plan',
  ]);
  assert.deepEqual(labels(result.buttons), [
    'Cancel', 'Custom action', 'Save', 'Save', 'Submit claim', 'Upload photo', 'Void claim',
  ]);

  // The accessible-name walk: through aria-labelledby, through a wrapping
  // label, and past a hidden subtree that must contribute nothing.
  assert.equal(
    selectorOf(result.fields, 'Accept terms'),
    'role=checkbox[name="Accept terms"]',
  );
  assert.equal(
    selectorOf(result.fields, 'Phone number'),
    'role=textbox[name="Phone number"]',
  );
  assert.equal(selectorOf(result.buttons, 'Cancel'), 'role=button[name="Cancel"]');

  // HTML-AAM gives a password input no role, so the role strategy has to be
  // skipped rather than producing role=textbox[name="Passphrase"], which would
  // match nothing. Same for an image button.
  assert.equal(selectorOf(result.fields, 'Passphrase'), '[name="secret"]');
  assert.equal(selectorOf(result.buttons, 'Upload photo'), '[name="upload"]');

  const plan = result.fields.find((entry) => entry.label === 'Plan');
  assert.equal(plan.type, 'select');
  assert.equal(plan.selector, 'role=combobox[name="Plan"]');

  const voidClaim = result.buttons.find((entry) => entry.label === 'Void claim');
  assert.equal(voidClaim.disabled, true);
  assert.equal(
    result.buttons.filter((entry) => entry.disabled === true).length,
    1,
    'only the disabled control is marked disabled',
  );

  // A hidden input is never a candidate at all, so it cannot appear under any
  // label or leave a skip behind.
  assert.equal(
    result.fields.some((entry) => entry.type === 'hidden'),
    false,
  );

  assert.deepEqual(result.links, [
    { label: 'Docs', href: `${fixture.origin}/docs` },
    { label: 'Pricing', href: `${fixture.origin}/pricing` },
  ]);

  assert.deepEqual(result.landmarks, [
    { role: 'banner' },
    { role: 'navigation', label: 'Primary' },
    { role: 'main' },
    { role: 'form', label: 'Claimant' },
    { role: 'region', label: 'Assessment' },
    { role: 'complementary', label: 'Related' },
    { role: 'contentinfo' },
  ]);
});

test('page-affordances refuses what it cannot address and says how much', async (t) => {
  const { run } = await harness(t);
  const result = await run({});

  // Two controls named "Save" with distinct testids: the role name collides, so
  // data-testid carries them. Two named "More" with only framework-minted ids:
  // nothing carries them and both are counted.
  assert.deepEqual(
    result.buttons.filter((entry) => entry.label === 'Save').map((entry) => entry.selector).sort(),
    ['[data-testid="save-bottom"]', '[data-testid="save-top"]'],
  );
  assert.equal(skipCount(result, 'buttons', 'generated-id'), 2);

  // Both "Duplicate" fields share a name and an aria-label, so the document-wide
  // tally refuses both attributes and only the authored ids are left.
  assert.deepEqual(
    result.fields.filter((entry) => entry.label === 'Duplicate')
      .map((entry) => entry.selector).sort(),
    ['#first-duplicate', '#second-duplicate'],
  );

  assert.equal(skipCount(result, 'fields', 'no-label'), 1);
  assert.equal(skipCount(result, 'buttons', 'no-label'), 1);
  assert.equal(skipCount(result, 'links', 'duplicate'), 1);

  // Three ways to be invisible, none of which may reach any list: a `hidden`
  // attribute, an aria-hidden ancestor, and a zero-area box. Invisibility is
  // not a refusal, so none of them may leave a skip behind either.
  const everything = [...result.fields, ...result.buttons, ...result.links];
  for (const label of ['Hidden link', 'Ghost', 'Invisible', 'Zero']) {
    assert.equal(
      everything.some((entry) => entry.label === label),
      false,
      `${label} is not visible and must not appear`,
    );
  }
  assert.equal(
    result.skipped.reduce((total, entry) => total + entry.count, 0),
    5,
    'the only refusals on this page are the labelled ones above',
  );
});

test('page-affordances reports every list bound it hit', async (t) => {
  const { run } = await harness(t);
  const full = await run({});
  const result = await run({
    maxFields: 1, maxButtons: 1, maxLinks: 1, maxLandmarks: 1,
  });

  for (const list of ['fields', 'buttons', 'links']) {
    assert.equal(result[list].length, 1, `${list} is trimmed to its cap`);
    assert.equal(
      skipCount(result, list, 'over-limit'),
      full[list].length - 1,
      `${list} counts exactly what the cap dropped`,
    );
  }

  // Landmarks are bounded twice and the inner bound fires first: the collector
  // stops examining nodes once it has four times the cap, so the over-limit
  // count is measured against what it collected rather than against the whole
  // page. Both bounds have to be reported, because between them they are the
  // difference between a partial list and a complete-looking one.
  assert.equal(result.landmarks.length, 1);
  assert.equal(skipCount(result, 'landmarks', 'over-limit'), 3);
  assert.ok(
    skipCount(result, 'landmarks', 'collect-limit') > 0,
    'the collector reports the landmark nodes it never examined',
  );
});

test('page-affordances reports the scan bound it hit', async (t) => {
  const { run } = await harness(t);
  const result = await run({ maxScan: 3 });

  // The cap applies before anything is classified, so the three examined
  // elements are the first three in document order: both nav links, of which
  // the second is a duplicate, and then the first field.
  assert.deepEqual(result.links.map((entry) => entry.label), ['Docs']);
  assert.deepEqual(result.fields.map((entry) => entry.label), ['Full name']);
  assert.deepEqual(result.buttons, []);
  assert.ok(
    skipCount(result, 'page', 'scan-limit') > 0,
    'the scan cap reports how much of the page it never reached',
  );
});
