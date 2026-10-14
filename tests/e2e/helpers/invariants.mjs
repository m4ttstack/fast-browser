import assert from 'node:assert/strict';

export const intersects = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
export const inside = (a, b, slack = 0.5) => a[0] >= b[0] - slack && a[1] >= b[1] - slack && a[0] + a[2] <= b[0] + b[2] + slack && a[1] + a[3] <= b[1] + b[3] + slack;
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
// A copy of LEGEND_GAP in lib/compose/page-layout.js, kept apart for the same reason.
const LEGEND_GAP = 8;

const cross = ([ax, ay], [bx, by], [cx, cy], [dx, dy]) => {
  const side = (px, py, qx, qy, rx, ry) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  return side(ax, ay, bx, by, cx, cy) * side(ax, ay, bx, by, dx, dy) < 0 && side(cx, cy, dx, dy, ax, ay) * side(cx, cy, dx, dy, bx, by) < 0;
};
export const pathsCross = (a, b) => a.slice(1).some((p, i) => b.slice(1).some((q, j) => cross(a[i], p, b[j], q)));

// A line on a label's edge touches its text, so the rect is inflated by the 1px segmentHitsRect trims.
const inflate = (r) => [r[0] - 1, r[1] - 1, r[2] + 2, r[3] + 2];

// Lift sources, pads and the panel's frame are in that panel's capture pixels, so the numbers compared with them scale by its scale.
export function assertPanel(panel, stage) {
  const scale = panel.scale ?? 1;
  const pinned = (panel.pins?.length ?? 0) > 0;
  for (const label of panel.labels) {
    assert.equal(intersects(label.rect, panel.capture), false, 'a label overlaps the screenshot');
    assert.ok(inside(label.rect, stage), 'a label leaves the stage');
  }
  panel.labels.forEach((a, i) => panel.labels.slice(i + 1).forEach((b) => {
    assert.equal(intersects(a.rect, b.rect), false, 'two labels overlap');
  }));
  for (const lift of panel.lifts) assert.ok(inside(lift.rect, panel.capture), 'a lift leaves the frame');
  for (const lift of panel.lifts) {
    if (lift.clamped) continue;
    const [x, y, w, h] = lift.rect;
    assert.ok(inside([x - LIFT_RING, y - LIFT_RING, w + 2 * LIFT_RING, h + 2 * LIFT_RING], panel.capture), "a lift's ring leaves the frame");
  }
  const sized = panel.lifts.filter((lift) => !lift.tiny);
  assert.ok(sized.every((lift) => Math.abs(lift.k - sized[0].k) < 1e-6), 'lifts of one panel differ in scale');
  for (const lift of panel.lifts) {
    const [x, y, w, h] = lift.source; const [left, top, right, bottom] = lift.pad;
    assert.ok(inside([x - left, y - top, w + left + right, h + top + bottom], panel.frame, 0.5 * scale), 'a lift draws capture pixels outside the panel\'s shown region');
  }
  for (const r of panel.redactions) assert.ok(inside(r.rect, panel.capture), 'a redaction is drawn outside the screenshot');
  for (const slot of panel.slots ?? []) assert.ok(inside(slot.rect, panel.capture), 'a slot leaves the frame');
  for (const bracket of panel.brackets ?? []) {
    const gap = bracket.rect[0] - (bracket.rows[0] + bracket.rows[2]);
    assert.ok(gap >= 0 && gap <= (bracket.inMargin ? BRACKET_FAR : BRACKET_NEAR), 'a bracket sits away from its rows');
    assert.ok(Math.abs(bracket.rect[1] - bracket.rows[1]) <= 1 && Math.abs(bracket.rect[3] - bracket.rows[3]) <= 1, 'a bracket does not span its rows');
    for (const lift of panel.lifts) assert.equal(intersects(bracket.rect, lift.rect), false, 'a bracket is drawn over a lift');
    for (const r of panel.redactions) assert.equal(intersects(bracket.rect, r.rect), false, 'a bracket is drawn through a redaction');
  }
  for (const link of panel.links ?? []) {
    assert.equal(link.targets.length, 2, 'a link has two lifts');
    assert.ok(link.targets.every((i) => panel.targets[i].kind === 'lift' && !panel.lifts[panel.targets[i].lift].merged), 'a link merged its two lifts');
    if (pinned) {
      const pinsOfLink = panel.pins.filter((pin) => link.targets.includes(pin.target));
      assert.equal(pinsOfLink.length, 2, 'each lift of a link carries a pin');
      assert.equal(new Set(pinsOfLink.map((p) => p.number)).size, 1, "a link's two lifts carry one number");
      continue;
    }
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
    if (intersects([a.source[0] - 8 * scale, a.source[1] - 8 * scale, a.source[2] + 16 * scale, a.source[3] + 16 * scale], b.source)) return;
    assert.equal(intersects(a.rect, b.rect), false, 'two lifts of separate content overlap');
  }));
  const dotted = panel.leaders.filter((leader) => ['lift', 'slot'].includes(panel.targets[leader.target].kind)).length;
  if (!pinned) assert.equal(panel.dots.length, dotted + panel.connectors.length, 'every lift or slot leader and every connector has an anchor dot');
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
  for (const leader of panel.leaders) {
    for (let s = 1; s < leader.points.length - 2; s += 1) {
      const [[x1, y1], [x2, y2]] = [leader.points[s], leader.points[s + 1]];
      assert.ok(Math.hypot(x2 - x1, y2 - y1) >= 10 - 0.01, 'a leader steps a few pixels before its label');
    }
  }
  for (const pin of panel.pins ?? []) {
    const target = panel.targets[pin.target];
    assert.ok(rectDistance(pin.center, target.rect) <= pin.r + ringOf(target) + 1, 'a pin is detached from its target');
    // A bracket in the margin stands outside the frame, and so does its pin.
    const inMargin = target.kind === 'bracket' && !intersects(target.rect, panel.capture);
    assert.ok(inside([pin.center[0] - pin.r, pin.center[1] - pin.r, 2 * pin.r, 2 * pin.r], inMargin ? stage : panel.capture, 1), 'a pin leaves the frame');
    panel.targets.forEach((other, i) => {
      if (i === pin.target || other.mark === target.mark) return;
      assert.ok(rectDistance(pin.center, other.rect) >= pin.r - 0.5, "a pin sits on another mark's target");
    });
    // A fill a lift holds is drawn inside its card; one outside the pin's own target is never under a pin.
    for (const r of panel.redactions) {
      if (intersects(r.rect, target.rect)) continue;
      assert.ok(rectDistance(pin.center, r.rect) >= pin.r - 0.5, 'a pin sits on a redaction');
    }
    for (const label of panel.labels) assert.ok(rectDistance(pin.center, label.rect) >= pin.r, 'a pin sits on a label');
  }
  (panel.pins ?? []).forEach((a, i) => panel.pins.slice(i + 1).forEach((b) => {
    assert.ok(Math.hypot(a.center[0] - b.center[0], a.center[1] - b.center[1]) >= a.r + b.r - 0.5, 'two pins overlap');
  }));
  if (pinned) {
    for (const label of panel.labels) {
      assert.ok(Number.isInteger(label.number), 'a legend label carries its number');
      assert.ok(panel.pins.some((pin) => pin.number === label.number), 'a legend number has no pin');
    }
    const marked = new Set(panel.pins.map((pin) => panel.targets[pin.target].mark));
    const numbers = new Map(panel.pins.map((pin) => [panel.targets[pin.target].mark, pin.number]));
    assert.equal(new Set(numbers.values()).size, marked.size, 'two marks share a pin number');
    for (const pin of panel.pins) assert.equal(pin.number, numbers.get(panel.targets[pin.target].mark), 'the pins of one mark carry different numbers');
    assert.deepEqual(panel.legend.map((entry) => entry.number), [...new Set(panel.pins.map((pin) => pin.number))].sort((a, b) => a - b), 'the legend lists every pin number once, in order');
    for (const entry of panel.legend) {
      assert.equal(intersects(entry.rect, panel.capture), false, 'a legend number overlaps the screenshot');
      assert.ok(inside(entry.rect, stage), 'a legend number leaves the stage');
      // Its label, or the lens of a loupe that has none, starts LEGEND_GAP right of the number and stands level with it.
      const label = panel.labels.find((l) => l.number === entry.number);
      const lens = (panel.loupes ?? []).find((l) => panel.pins.some((pin) => pin.number === entry.number && pin.target === l.target))?.lens;
      const beside = lens ?? label?.rect;
      assert.ok(beside, 'a legend number stands alone');
      const [x, y, w, h] = entry.rect;
      assert.ok(Math.abs(beside[0] - (x + w + LEGEND_GAP)) <= 0.5, 'a legend number is not beside its label');
      assert.ok(y + h / 2 >= beside[1] && y + h / 2 <= beside[1] + beside[3], 'a legend number is not level with its label');
      for (const other of [...panel.labels.map((l) => l.rect), ...(panel.loupes ?? []).map((l) => l.lens)]) {
        assert.equal(intersects(entry.rect, other), false, 'a legend number is covered');
      }
    }
    panel.legend.forEach((a, i) => panel.legend.slice(i + 1).forEach((b) => {
      const below = b.rect[1] >= a.rect[1] + a.rect[3];
      assert.ok(below || (Math.abs(b.rect[1] - a.rect[1]) <= 0.5 && b.rect[0] >= a.rect[0] + a.rect[2]), 'the legend does not run in number order');
    }));
  } else {
    for (const label of panel.labels) assert.equal(label.number, undefined, 'a label on a leader carries a number');
    assert.equal((panel.legend ?? []).length, 0, 'a panel with leaders has a legend');
  }
}

export function assertInvariants(report) {
  assert.ok(Array.isArray(report.panels) && report.panels.length > 0, 'the report lists its panels');
  for (const panel of report.panels) assertPanel(panel, report.stage);
  for (const panel of report.panels) if (panel.extent) assert.ok(inside(panel.extent, report.stage), 'a panel leaves the stage');
  for (const panel of report.panels) {
    if (report.pinned) assert.equal(panel.leaders.length + panel.connectors.length + panel.dots.length, 0, 'a panel of a pinned board draws leaders');
    else assert.equal(panel.pins.length, 0, 'a panel of a board with leaders carries pins');
  }
  // Pins count through the board in panel order and never start again in a panel.
  const numbered = report.panels.flatMap((panel) => (panel.legend ?? []).map((entry) => entry.number));
  assert.deepEqual(numbered, numbered.map((_, n) => n + 1), 'the pins of a board do not count from 1 to n in panel order');
  if (!report.pinned) {
    for (const panel of report.panels) for (const leader of panel.leaders) {
      const [[x0, y0], [x1, y1]] = leader.points;
      const way = Math.abs(y1 - y0) < 0.01 && x1 > x0 ? 'right' : 'bottom';
      assert.equal(way, report.side, 'labels of one board leave by different sides');
    }
  }
  if (report.panels.length > 1) {
    const spread = (k) => { const values = report.panels.map((p) => p.capture[k]); return Math.max(...values) - Math.min(...values); };
    if (report.stacked) {
      assert.ok(spread(2) <= 0.5, 'stacked panels differ in width');
      assert.ok(spread(0) <= 0.5, 'stacked panels do not line up');
    } else {
      assert.ok(spread(3) <= 0.5, 'panels differ in height');
      assert.ok(spread(1) <= 0.5, 'panels do not line up');
    }
    assert.equal(new Set(report.panels.map((p) => p.wash)).size, 1, 'one panel is washed and another is not');
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
