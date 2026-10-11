import assert from 'node:assert/strict';

export const intersects = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
export const inside = (a, b) => a[0] >= b[0] - 0.5 && a[1] >= b[1] - 0.5 && a[0] + a[2] <= b[0] + b[2] + 0.5 && a[1] + a[3] <= b[1] + b[3] + 0.5;
export const segmentHitsRect = ([x1, y1], [x2, y2], r) => {
  const minX = Math.min(x1, x2); const maxX = Math.max(x1, x2); const minY = Math.min(y1, y2); const maxY = Math.max(y1, y2);
  return intersects([minX, minY, Math.max(maxX - minX, 0.01), Math.max(maxY - minY, 0.01)], [r[0] + 1, r[1] + 1, r[2] - 2, r[3] - 2]);
};

// A copy of LIFT_RING in lib/compose/page-geometry.js, kept apart so the check does not read the code it checks.
const LIFT_RING = 3;
const rectDistance = ([x, y], r) => Math.hypot(Math.max(r[0] - x, 0, x - r[0] - r[2]), Math.max(r[1] - y, 0, y - r[1] - r[3]));

export function assertInvariants(report) {
  for (const label of report.labels) {
    assert.equal(intersects(label.rect, report.capture), false, 'a label overlaps the screenshot');
    assert.ok(inside(label.rect, report.stage), 'a label leaves the stage');
  }
  report.labels.forEach((a, i) => report.labels.slice(i + 1).forEach((b) => {
    assert.equal(intersects(a.rect, b.rect), false, 'two labels overlap');
  }));
  for (const lift of report.lifts) assert.ok(inside(lift.rect, report.capture), 'a lift leaves the frame');
  report.lifts.forEach((a, i) => report.lifts.slice(i + 1).forEach((b) => {
    // Lifts closer than their two paddings cannot be kept apart.
    if (intersects([a.source[0] - 8, a.source[1] - 8, a.source[2] + 16, a.source[3] + 16], b.source)) return;
    assert.equal(intersects(a.rect, b.rect), false, 'two lifts of separate content overlap');
  }));
  // A marker must never hide what it points at: every anchor dot stays clear
  // of every lift and its 3px ring (page.mjs), and touches its own lift's ring.
  assert.equal((report.dots ?? []).length, report.labels.length + report.connectors.length, 'every label and every connector has an anchor dot');
  for (const dot of report.dots) {
    report.lifts.forEach((lift, i) => {
      const gap = rectDistance(dot.center, lift.rect) - dot.r - LIFT_RING;
      assert.ok(gap >= -0.5, 'an anchor dot overlaps a lift');
      if (i === dot.lift) assert.ok(gap <= 1, 'an anchor dot is detached from its lift');
    });
  }
  for (const leader of report.leaders) {
    report.lifts.forEach((lift, i) => {
      if (i === leader.lift) return;
      for (let s = 0; s < leader.points.length - 1; s += 1) {
        assert.equal(segmentHitsRect(leader.points[s], leader.points[s + 1], lift.rect), false, 'a leader crosses another lift');
      }
    });
  }
  // A point's connectors run to its leader and may pass its own lifts' ring,
  // never another point's lift.
  for (const connector of report.connectors) {
    const own = report.lifts[connector.lift].mark;
    assert.ok(report.leaders[connector.leader].lifts.includes(connector.lift), 'a connector belongs to its leader');
    report.lifts.forEach((lift) => {
      if (lift.mark === own) return;
      for (let s = 0; s < connector.points.length - 1; s += 1) {
        assert.equal(segmentHitsRect(connector.points[s], connector.points[s + 1], lift.rect), false, "a mark's connector crosses another mark's lift");
      }
    });
  }
  for (const leader of report.leaders) {
    assert.ok(new Set(leader.lifts.map((i) => report.lifts[i].mark)).size === 1, 'a leader serves the lifts of one mark');
  }
}
