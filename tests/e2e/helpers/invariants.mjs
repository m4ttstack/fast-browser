import assert from 'node:assert/strict';

export const intersects = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
export const inside = (a, b) => a[0] >= b[0] - 0.5 && a[1] >= b[1] - 0.5 && a[0] + a[2] <= b[0] + b[2] + 0.5 && a[1] + a[3] <= b[1] + b[3] + 0.5;
export const segmentHitsRect = ([x1, y1], [x2, y2], r) => {
  const minX = Math.min(x1, x2); const maxX = Math.max(x1, x2); const minY = Math.min(y1, y2); const maxY = Math.max(y1, y2);
  return intersects([minX, minY, Math.max(maxX - minX, 0.01), Math.max(maxY - minY, 0.01)], [r[0] + 1, r[1] + 1, r[2] - 2, r[3] - 2]);
};

// A copy of LIFT_RING in lib/compose/page-geometry.js, kept apart so the check does not read the code it checks.
const LIFT_RING = 3;
export const rectDistance = ([x, y], r) => Math.hypot(Math.max(r[0] - x, 0, x - r[0] - r[2]), Math.max(r[1] - y, 0, y - r[1] - r[3]));
// Copies of BRACKET_GAP + BRACKET_REACH, and of that plus BRACKET_ARM, BRACKET_EDGE and BRACKET_GAP, in lib/compose/page-layout.js, kept apart so the check does not read the code it checks.
const BRACKET_NEAR = 30;
const BRACKET_FAR = 46;
const ringOf = (target) => (target.kind === 'lift' ? LIFT_RING : 0);

const cross = ([ax, ay], [bx, by], [cx, cy], [dx, dy]) => {
  const side = (px, py, qx, qy, rx, ry) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  return side(ax, ay, bx, by, cx, cy) * side(ax, ay, bx, by, dx, dy) < 0 && side(cx, cy, dx, dy, ax, ay) * side(cx, cy, dx, dy, bx, by) < 0;
};
export const pathsCross = (a, b) => a.slice(1).some((p, i) => b.slice(1).some((q, j) => cross(a[i], p, b[j], q)));

// A line on a label's edge touches its text, so the rect is inflated by the 1px segmentHitsRect trims.
const inflate = (r) => [r[0] - 1, r[1] - 1, r[2] + 2, r[3] + 2];

export function assertPanel(panel, stage) {
  for (const label of panel.labels) {
    assert.equal(intersects(label.rect, panel.capture), false, 'a label overlaps the screenshot');
    assert.ok(inside(label.rect, stage), 'a label leaves the stage');
  }
  panel.labels.forEach((a, i) => panel.labels.slice(i + 1).forEach((b) => {
    assert.equal(intersects(a.rect, b.rect), false, 'two labels overlap');
  }));
  for (const lift of panel.lifts) assert.ok(inside(lift.rect, panel.capture), 'a lift leaves the frame');
  for (const lift of panel.lifts) {
    const [x, y, w, h] = lift.source; const [left, top, right, bottom] = lift.pad;
    assert.ok(inside([x - left, y - top, w + left + right, h + top + bottom], panel.frame), 'a lift draws capture pixels outside the panel\'s shown region');
  }
  for (const r of panel.redactions) assert.ok(inside(r.rect, panel.capture), 'a redaction is drawn outside the screenshot');
  for (const slot of panel.slots ?? []) assert.ok(inside(slot.rect, panel.capture), 'a slot leaves the frame');
  for (const bracket of panel.brackets ?? []) {
    const gap = bracket.rect[0] - (bracket.rows[0] + bracket.rows[2]);
    assert.ok(gap >= 0 && gap <= (bracket.inMargin ? BRACKET_FAR : BRACKET_NEAR), 'a bracket sits away from its rows');
    assert.ok(Math.abs(bracket.rect[1] - bracket.rows[1]) <= 1 && Math.abs(bracket.rect[3] - bracket.rows[3]) <= 1, 'a bracket does not span its rows');
    for (const lift of panel.lifts) assert.equal(intersects(bracket.rect, lift.rect), false, 'a bracket is drawn over a lift');
  }
  for (const link of panel.links ?? []) {
    assert.equal(link.targets.length, 2, 'a link has two lifts');
    assert.ok(link.targets.every((i) => panel.targets[i].kind === 'lift' && !panel.lifts[panel.targets[i].lift].merged), 'a link merged its two lifts');
    const leaders = panel.leaders.filter((l) => panel.targets[l.target].mark === link.mark);
    assert.equal(leaders.length, 1, 'a link has one leader');
    assert.deepEqual([...leaders[0].targets].sort(), [...link.targets].sort(), "a link's leader serves both lifts");
    assert.equal(panel.connectors.filter((c) => link.targets.includes(c.target)).length, 1, 'a link has one connector');
  }
  for (const loupe of panel.loupes ?? []) {
    assert.ok(inside(loupe.ring, panel.capture), 'a loupe ring leaves the frame');
    assert.equal(intersects(loupe.lens, panel.capture), false, 'a lens covers the screenshot');
    assert.ok(inside(loupe.lens, stage), 'a lens leaves the stage');
    for (const label of panel.labels) assert.equal(intersects(loupe.lens, label.rect), false, 'a lens covers a label');
    for (const line of [...panel.leaders.filter((l) => l.target !== loupe.target), ...panel.connectors]) {
      for (let s = 0; s < line.points.length - 1; s += 1) {
        assert.equal(segmentHitsRect(line.points[s], line.points[s + 1], inflate(loupe.lens)), false, "a leader or connector runs through another mark's lens");
      }
    }
  }
  (panel.loupes ?? []).forEach((a, i) => panel.loupes.slice(i + 1).forEach((b) => {
    assert.equal(intersects(a.lens, b.lens), false, 'two lenses overlap');
  }));
  panel.lifts.forEach((a, i) => panel.lifts.slice(i + 1).forEach((b) => {
    // Lifts closer than their two paddings cannot be kept apart.
    if (intersects([a.source[0] - 8, a.source[1] - 8, a.source[2] + 16, a.source[3] + 16], b.source)) return;
    assert.equal(intersects(a.rect, b.rect), false, 'two lifts of separate content overlap');
  }));
  const dotted = panel.leaders.filter((leader) => ['lift', 'slot'].includes(panel.targets[leader.target].kind)).length;
  assert.equal(panel.dots.length, dotted + panel.connectors.length, 'every lift or slot leader and every connector has an anchor dot');
  // A marker never hides what it points at.
  for (const dot of panel.dots) {
    panel.targets.forEach((target, i) => {
      const gap = rectDistance(dot.center, target.rect) - dot.r - ringOf(target);
      assert.ok(gap >= -0.5, 'an anchor dot overlaps a target');
      if (i === dot.target) assert.ok(gap <= 1, 'an anchor dot is detached from its target');
    });
  }
  for (const leader of panel.leaders) {
    panel.targets.forEach((target, i) => {
      if (leader.targets.includes(i)) return;
      for (let s = 0; s < leader.points.length - 1; s += 1) {
        assert.equal(segmentHitsRect(leader.points[s], leader.points[s + 1], target.rect), false, 'a leader crosses another lift');
      }
    });
    assert.equal(new Set(leader.targets.map((i) => panel.targets[i].mark)).size, 1, 'a leader serves the targets of one mark');
  }
  // Only a leader's own label may meet it, and only where it ends.
  for (const leader of panel.leaders) {
    for (const label of panel.labels) {
      if (label.target === leader.target) continue;
      for (let s = 0; s < leader.points.length - 1; s += 1) {
        assert.equal(segmentHitsRect(leader.points[s], leader.points[s + 1], inflate(label.rect)), false, "a leader runs through another mark's label");
      }
    }
  }
  for (const connector of panel.connectors) {
    for (const label of panel.labels) {
      for (let s = 0; s < connector.points.length - 1; s += 1) {
        assert.equal(segmentHitsRect(connector.points[s], connector.points[s + 1], inflate(label.rect)), false, 'a connector runs through a label');
      }
    }
  }
  // A mark's connectors may pass its own lifts but never another mark's.
  for (const connector of panel.connectors) {
    const own = panel.targets[connector.target].mark;
    assert.ok(panel.leaders[connector.leader].targets.includes(connector.target), 'a connector belongs to its leader');
    panel.targets.forEach((target) => {
      if (target.mark === own) return;
      for (let s = 0; s < connector.points.length - 1; s += 1) {
        assert.equal(segmentHitsRect(connector.points[s], connector.points[s + 1], target.rect), false, "a mark's connector crosses another mark's lift");
      }
    });
  }
  panel.dots.forEach((a, i) => panel.dots.slice(i + 1).forEach((b) => {
    assert.ok(Math.hypot(a.center[0] - b.center[0], a.center[1] - b.center[1]) >= a.r + b.r, 'two anchor dots overlap');
  }));
  for (const dot of panel.dots) {
    for (const label of panel.labels) assert.ok(rectDistance(dot.center, label.rect) >= dot.r, 'an anchor dot sits on a label');
    const [x, y, w, h] = panel.targets[dot.target].rect;
    const onRight = dot.center[0] > x + w;
    const [lo, span, at] = onRight ? [y, h, dot.center[1]] : [x, w, dot.center[0]];
    if (dot.slid !== 0 && span >= 12) assert.ok(at >= lo + 6 - 0.5 && at <= lo + span - 6 + 0.5, 'a slid dot sits in a corner');
  }
  panel.leaders.forEach((a, i) => panel.leaders.slice(i + 1).forEach((b) => {
    assert.equal(pathsCross(a.points, b.points), false, 'two leaders cross');
  }));
  for (const [i, leader] of panel.leaders.entries()) {
    for (let s = 0; s < leader.points.length - 1; s += 1) {
      const [[x1, y1], [x2, y2]] = [leader.points[s], leader.points[s + 1]];
      assert.ok(Math.abs(x1 - x2) < 0.01 || Math.abs(y1 - y2) < 0.01, 'a leader segment is not horizontal or vertical');
    }
    const lens = (panel.loupes ?? []).find((l) => l.target === leader.target)?.lens;
    const end = lens ?? panel.labels.find((l) => l.target === leader.target)?.rect;
    assert.ok(end, 'a leader ends at a label or a lens');
    assert.ok(rectDistance(leader.points[leader.points.length - 1], end) <= 8, 'a leader stops short of its label');
    const dot = panel.dots.find((d) => d.target === leader.target && d.center[0] === leader.points[0][0] && d.center[1] === leader.points[0][1]);
    if (['lift', 'slot'].includes(panel.targets[leader.target].kind)) assert.ok(dot, `leader ${i} starts at its dot`);
  }
}

export function assertInvariants(report) {
  assert.ok(Array.isArray(report.panels) && report.panels.length > 0, 'the report lists its panels');
  for (const panel of report.panels) assertPanel(panel, report.stage);
  for (const panel of report.panels) if (panel.extent) assert.ok(inside(panel.extent, report.stage), 'a panel leaves the stage');
  if (report.panels.length > 1) {
    const heights = report.panels.map((p) => p.capture[3]); const tops = report.panels.map((p) => p.capture[1]);
    assert.ok(Math.max(...heights) - Math.min(...heights) <= 0.5, 'panels differ in height');
    assert.ok(Math.max(...tops) - Math.min(...tops) <= 0.5, 'panels do not line up');
    report.panels.forEach((a, i) => report.panels.slice(i + 1).forEach((b) => {
      assert.equal(intersects(a.extent, b.extent), false, 'two panels overlap');
    }));
    for (const arrow of report.arrows) {
      assert.ok(inside(arrow, report.stage), 'an arrow leaves the stage');
      for (const panel of report.panels) assert.equal(intersects(arrow, panel.extent), false, 'an arrow covers a panel');
    }
    assert.equal(report.arrows.length, report.layout === 'steps' ? report.panels.length - 1 : 0, 'steps are joined by arrows, pairs are not');
  }
}
