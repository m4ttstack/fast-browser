import assert from 'node:assert/strict';

import { assertInvariants } from './invariants.mjs';

export const near = (a, b, tolerance, what) => {
  assert.equal(a.length, b.length, `${what}: ${a} against ${b}`);
  a.forEach((value, i) => assert.ok(Math.abs(value - b[i]) <= tolerance, `${what}: ${a} against ${b}`));
};

const FIXED = 2;
const COUNTED = ['targets', 'lifts', 'labels', 'dots', 'leaders', 'connectors', 'pins', 'legend', 'redactions', 'slots', 'brackets', 'loupes', 'flats', 'links'];

// A panel's source and frame numbers are in its own capture pixels; they meet the twin's in CSS pixels.
export function assertSameLayout(one, other, scales) {
  const CLAMPED = 'a lift was clamped at the frame edge';
  assertInvariants(one);
  assertInvariants(other);
  assert.deepEqual(one.panels.map((p) => p.scale), scales.map(() => 1));
  assert.deepEqual(other.panels.map((p) => p.scale), scales);
  assert.equal(other.panels.length, one.panels.length);
  assert.deepEqual(other.imageSizes, one.imageSizes.map(([w, h], p) => [w * scales[p], h * scales[p]]), "each capture is its scale times its 1x twin's size");
  // Glyph antialiasing at 1x can spill a column past a box that sits at the frame edge, which 2x does not:
  // the clamp warning is the one a 2x board may lack, and every other warning must match.
  const expectedWarnings = other.warnings.includes(CLAMPED) ? one.warnings : one.warnings.filter((w) => w !== CLAMPED);
  assert.deepEqual(other.warnings, expectedWarnings, `warnings ${JSON.stringify(other.warnings)} against 1x warnings ${JSON.stringify(one.warnings)}`);
  assert.deepEqual([other.side, other.pinned], [one.side, one.pinned], 'the labels leave by the same side, pinned or not, at either scale');
  one.panels.forEach((a, p) => {
    for (const list of COUNTED) assert.equal(other.panels[p][list].length, a[list].length, `panel ${p} ${list} count`);
  });
  const css = (panel, list) => list.map((n) => n / panel.scale);
  // Board pixels: the same picture. Image pixels: a panel's scale times as many.
  // A 1x pixel can straddle a glyph edge that a 2x pixel resolves, so a lift's source may differ by a pixel,
  // and a lift drawn larger than its source carries that pixel into board space: only that lift, and what is
  // drawn for it, gets the slack.
  const liftSlacks = one.panels.map((a, p) => a.lifts.map((lift, i) => (lift.rect[2] / Math.max(lift.source[2], 1))
    * Math.max(...css(other.panels[p], other.panels[p].lifts[i].source).map((n, k) => Math.abs(n - lift.source[k])))));
  near(other.stage, one.stage, FIXED + Math.max(0, ...liftSlacks.flat()), 'stage');
  one.panels.forEach((a, p) => {
    const b = other.panels[p];
    const slackOf = (target) => (a.targets[target]?.kind === 'lift' ? liftSlacks[p][a.targets[target].lift] : 0);
    const leaderSlack = (leader) => Math.max(0, ...(a.leaders[leader]?.targets ?? []).map(slackOf));
    assert.deepEqual(b.frameEdges, a.frameEdges);
    assert.equal(b.cropped, a.cropped);
    assert.deepEqual(b.cropEdges, a.cropEdges);
    near(b.capture, a.capture, FIXED, 'capture');
    near(css(b, b.frame), a.frame, 1, 'frame');
    near(css(b, b.cleanFrame), a.cleanFrame, 1, 'cleanFrame');
    a.lifts.forEach((lift, i) => {
      near(b.lifts[i].rect, lift.rect, FIXED + liftSlacks[p][i], 'lift rect');
      near(css(b, b.lifts[i].source), lift.source, 1, 'lift source');
      near(css(b, b.lifts[i].grown), lift.grown, 1, 'lift growth');
      assert.ok(Math.abs(b.lifts[i].k - lift.k) < 0.05, 'lift zoom');
    });
    a.labels.forEach((label, i) => near(b.labels[i].rect, label.rect, FIXED + slackOf(label.target), 'label rect'));
    assert.deepEqual(b.labels.map((label) => label.number), a.labels.map((label) => label.number), 'label numbers');
    a.pins.forEach((pin, i) => {
      assert.deepEqual([b.pins[i].number, b.pins[i].target], [pin.number, pin.target], 'pin number and target');
      near(b.pins[i].center, pin.center, FIXED + slackOf(pin.target), 'pin');
    });
    a.legend.forEach((entry, i) => {
      assert.equal(b.legend[i].number, entry.number, 'legend number');
      near(b.legend[i].rect, entry.rect, FIXED + Math.max(0, ...liftSlacks[p]), 'legend number rect');
    });
    a.dots.forEach((dot, i) => near(b.dots[i].center, dot.center, FIXED + slackOf(dot.target), 'dot'));
    a.redactions.forEach((redaction, i) => near(b.redactions[i].rect, redaction.rect, FIXED, 'redaction'));
    a.slots.forEach((slot, i) => near(b.slots[i].rect, slot.rect, FIXED, 'slot'));
    a.brackets.forEach((bracket, i) => near(b.brackets[i].rect, bracket.rect, FIXED, 'bracket'));
    a.loupes.forEach((loupe, i) => {
      near(b.loupes[i].ring, loupe.ring, FIXED, 'loupe ring');
      near(b.loupes[i].lens, loupe.lens, FIXED, 'loupe lens');
    });
    for (const [list, slack] of [['leaders', (item) => leaderSlack(a.leaders.indexOf(item))], ['connectors', (item) => Math.max(slackOf(item.target), leaderSlack(item.leader))]]) {
      a[list].forEach((item, i) => {
        assert.equal(b[list][i].points.length, item.points.length, `${list} point count`);
        item.points.forEach((point, k) => near(b[list][i].points[k], point, FIXED + slack(item), `${list} point`));
      });
    }
  });
}
