// Pixel geometry shared by the renderer page and node --test. Plain script, no
// imports: page.mjs inlines this file's text ahead of page-layout.js, and the
// unit tests run it in a vm context. Pixels are { data: RGBA bytes, width,
// height }; boxes are [x, y, w, h] in the same pixel space.
(function () {
  const TOLERANCE = 24;
  // Letter gaps are a pixel or two; a gap between words or elements is wider.
  const BAND = 6;
  // Rounded corners antialias the first and last pixels of an edge line.
  const CORNER = 2;
  const SIDES = ['left', 'top', 'right', 'bottom'];
  const KEY_OF = { left: 'x0', top: 'y0', right: 'x1', bottom: 'y1' };
  // The 3px box-shadow ring page.mjs draws round a lift.
  const LIFT_RING = 3;
  // Rules out a 1-2px letter gap and accepts the 3-4px word space of 12-14px text.
  const LIFT_BAND = 3;

  const median = (values) => { values.sort((a, b) => a - b); return values[values.length >> 1]; };
  const hits = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
  const union = (boxes) => {
    const x = Math.min(...boxes.map((b) => b[0])); const y = Math.min(...boxes.map((b) => b[1]));
    return [x, y, Math.max(...boxes.map((b) => b[0] + b[2])) - x, Math.max(...boxes.map((b) => b[1] + b[3])) - y];
  };

  // The connected groups of `count` items joined by index pairs: ascending
  // indexes within a group, groups ordered by their first index.
  function components(count, pairs) {
    const parent = Array.from({ length: count }, (_, i) => i);
    const root = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
    for (const [i, j] of pairs) parent[root(j)] = root(i);
    const groups = new Map();
    for (let i = 0; i < count; i += 1) { const r = root(i); groups.set(r, [...(groups.get(r) || []), i]); }
    return [...groups.values()].sort((p, q) => p[0] - q[0]);
  }

  // A rule or card border is a thin line of one colour that a perpendicular
  // edge line merely crosses; it is not content. A glyph stroke is no longer
  // than a letter, and a filled area is not thin, so a run of RULE_THICKNESS
  // pixels or fewer counts as a rule only when its colour holds for RULE_LENGTH
  // pixels on both sides of the line with the pixels just outside the run a
  // different colour (more than SLIGHT off). A line holds at most RULE_RUNS.
  const RULE_THICKNESS = 2;
  const RULE_LENGTH = 24;
  const RULE_RUNS = 2;
  // A page background a shade off the rule's colour is still a different colour.
  const SLIGHT = 8;

  function isRule(pixels, horizontal, fixed, run) {
    const at = (along, across) => {
      const x = horizontal ? along : fixed + across; const y = horizontal ? fixed + across : along;
      return x < 0 || y < 0 || x >= pixels.width || y >= pixels.height ? -1 : (y * pixels.width + x) * 4;
    };
    const near = (a, b, within) => [0, 1, 2].every((c) => Math.abs(pixels.data[a + c] - pixels.data[b + c]) <= within);
    const first = run[0]; const last = run[run.length - 1];
    const ref = at(first, 0);
    return [1, -1].every((dir) => {
      for (let k = 1; k <= RULE_LENGTH; k += 1) {
        const inside = run.map((along) => at(along, dir * k));
        if (inside.some((px) => px < 0 || !near(px, ref, TOLERANCE))) return false;
        const outside = [at(first - 1, dir * k), at(last + 1, dir * k)];
        if (outside.some((px) => px >= 0 && near(px, ref, SLIGHT))) return false;
      }
      return true;
    });
  }

  // A line is clean when every pixel is within TOLERANCE of the line's median
  // colour: it crosses no glyph or badge. A thin rule crossing it (a card
  // border) does not count against it. The CORNER pixels at each end of a line
  // longer than 2 * CORNER and pixels inside an ignore rectangle are skipped; a
  // line made only of skipped pixels is clean.
  function lineIsClean(pixels, line, ignore) {
    const { horizontal, fixed, from, to } = line;
    const channels = [[], [], []]; const positions = [];
    const trim = to - from > 2 * CORNER ? CORNER : 0;
    for (let i = from + trim; i < to - trim; i += 1) {
      const x = horizontal ? i : fixed; const y = horizontal ? fixed : i;
      if (ignore.some((r) => x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3])) continue;
      const at = (y * pixels.width + x) * 4;
      for (let c = 0; c < 3; c += 1) channels[c].push(pixels.data[at + c]);
      positions.push(i);
    }
    const mids = channels.map((values) => median(values.slice()));
    let run = []; let rules = 0;
    const crossing = () => run.length <= RULE_THICKNESS && isRule(pixels, horizontal, fixed, run);
    for (let n = 0; n <= positions.length; n += 1) {
      const off = n < positions.length && channels.some((values, c) => Math.abs(values[n] - mids[c]) > TOLERANCE);
      if (off && (run.length === 0 || positions[n] === run[run.length - 1] + 1)) { run.push(positions[n]); continue; }
      if (run.length && (!crossing() || (rules += 1) > RULE_RUNS)) return false;
      run = off ? [positions[n]] : [];
    }
    return true;
  }

  // r is the integer rectangle { x0, y0, x1, y1 }. Offset 0 is the line just
  // inside an edge; a positive offset is that many pixels further out.
  function lineAt(r, side, offset) {
    if (side === 'left') return { horizontal: false, fixed: r.x0 - offset, from: r.y0, to: r.y1 };
    if (side === 'right') return { horizontal: false, fixed: r.x1 - 1 + offset, from: r.y0, to: r.y1 };
    if (side === 'top') return { horizontal: true, fixed: r.y0 - offset, from: r.x0, to: r.x1 };
    return { horizontal: true, fixed: r.y1 - 1 + offset, from: r.x0, to: r.x1 };
  }

  const stripOf = (line) => (line.horizontal ? [line.from, line.fixed, line.to - line.from, 1] : [line.fixed, line.from, 1, line.to - line.from]);

  function rectOf(box, bounds) {
    return {
      x0: Math.max(bounds.x0, Math.floor(box[0])), y0: Math.max(bounds.y0, Math.floor(box[1])),
      x1: Math.min(bounds.x1, Math.ceil(box[0] + box[2])), y1: Math.min(bounds.y1, Math.ceil(box[1] + box[3])),
    };
  }

  function boundsOf(pixels, bounds) {
    const b = bounds || [0, 0, pixels.width, pixels.height];
    return {
      x0: Math.max(0, Math.floor(b[0])), y0: Math.max(0, Math.floor(b[1])),
      x1: Math.min(pixels.width, Math.ceil(b[0] + b[2])), y1: Math.min(pixels.height, Math.ceil(b[1] + b[3])),
    };
  }

  const within = (bounds) => (line) => {
    const [x, y, w, h] = stripOf(line);
    return x >= bounds.x0 && y >= bounds.y0 && x + w <= bounds.x1 && y + h <= bounds.y1;
  };

  // An edge is held when its own line is clean and it sits in a run of `band`
  // clean lines (BAND unless told otherwise), so a gap between letters does not
  // pass. A run cut short by `reach` (the lines it may look at) counts.
  function held(pixels, r, side, reach, ignore, band) {
    const need = band || BAND;
    const clean = (offset) => lineIsClean(pixels, lineAt(r, side, offset), ignore);
    if (!clean(0)) return false;
    let run = 1;
    for (const direction of [1, -1]) {
      for (let k = 1; run < need; k += 1) {
        if (!reach(lineAt(r, side, direction * k))) return true;
        if (!clean(direction * k)) break;
        run += 1;
      }
    }
    return run >= need;
  }

  // How far outward the edge must move to start a run of `band` clean lines
  // (BAND by default), or 0 when none starts within `limit` pixels. A run cut
  // short by `reach` counts.
  function findBand(pixels, r, side, limit, reach, ignore, band) {
    const need = band || BAND;
    let start = 0; let run = 0;
    for (let p = 1; ; p += 1) {
      if (run === 0 && p > limit) return 0;
      const line = lineAt(r, side, p);
      if (!reach(line)) return run > 0 ? start : 0;
      if (lineIsClean(pixels, line, ignore)) {
        if (run === 0) start = p;
        run += 1;
        if (run >= need) return start;
      } else run = 0;
    }
  }

  function edgeIsClean(pixels, box, side, bounds, ignore) {
    const area = boundsOf(pixels, bounds);
    return held(pixels, rectOf(box, area), side, within(area), ignore || []);
  }

  // Moves each edge that is not held outward to the first line of a run of BAND
  // clean lines, so an edge stops between words and never between letters. A run cut
  // short by the bounds or an `avoid` box still counts. An edge that finds no
  // such run within `limit` pixels goes back to where it started, and `cut`
  // reports it. Edges re-test after any other edge moved, since a wider box
  // changes what the other lines span. An edge already sits well when it is held
  // by a run of `options.band` clean lines (BAND by default): a lift uses the
  // short LIFT_BAND, since a word space in running text is only a few lines wide.
  function growBox(pixels, box, limit, options) {
    const opts = options || {};
    const bounds = boundsOf(pixels, opts.bounds);
    const avoid = opts.avoid || [];
    const ignore = opts.ignore || [];
    const r = rectOf(box, bounds);
    if (r.x1 <= r.x0 || r.y1 <= r.y0) return { box: box.slice(), cut: false };
    const origin = { ...r };
    const grown = { left: 0, top: 0, right: 0, bottom: 0 };
    const reach = (line) => {
      const [x, y, w, h] = stripOf(line);
      return x >= bounds.x0 && y >= bounds.y0 && x + w <= bounds.x1 && y + h <= bounds.y1 && !avoid.some((a) => hits(a, [x, y, w, h]));
    };
    const shift = (side, d) => {
      if (side === 'left') r.x0 -= d; else if (side === 'top') r.y0 -= d; else if (side === 'right') r.x1 += d; else r.y1 += d;
      grown[side] += d;
    };
    const clean = (side) => held(pixels, r, side, reach, ignore, opts.band);
    let moved = true;
    while (moved) {
      moved = false;
      for (const side of SIDES) {
        if (clean(side)) continue;
        const d = findBand(pixels, r, side, limit - grown[side], reach, ignore, opts.band);
        if (d > 0) { shift(side, d); moved = true; }
      }
    }
    for (const side of SIDES) {
      if (grown[side] > 0 && !clean(side)) {
        r[KEY_OF[side]] = origin[KEY_OF[side]]; grown[side] = 0;
      }
    }
    const cut = SIDES.some((side) => !clean(side));
    if (SIDES.every((side) => grown[side] === 0)) return { box: box.slice(), cut };
    return { box: [r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0], cut };
  }

  // How far a lift's padding may extend on each side: up to `max` pixels, but
  // only over clean lines, and only while the line beyond the padding is clean
  // too. The lens resamples the capture, so an unclean neighbour line would
  // bleed a faint sliver of content into the padding's outer edge.
  function cleanPad(pixels, box, max, options) {
    const opts = options || {};
    const bounds = boundsOf(pixels, opts.bounds);
    const ignore = opts.ignore || [];
    const r = rectOf(box, bounds);
    const state = (side, offset) => {
      const line = lineAt(r, side, offset);
      const [x, y, w, h] = stripOf(line);
      if (x < bounds.x0 || y < bounds.y0 || x + w > bounds.x1 || y + h > bounds.y1) return 'outside';
      return lineIsClean(pixels, line, ignore) ? 'clean' : 'content';
    };
    return SIDES.map((side) => {
      let pad = 0;
      while (pad < max && state(side, pad + 1) === 'clean' && state(side, pad + 2) !== 'content') pad += 1;
      return pad;
    });
  }

  const CROP_MARGIN_X = 64;
  const CROP_MARGIN_Y = 48;
  const CROP_SNAP = 80;

  // A frame far larger than its marks buries them in unrelated page. The crop
  // is the marks plus a margin, each edge snapped outward to a clean band. An
  // edge that finds no band goes to the frame's own edge on that side, since a
  // crop edge through content is worse than a wider crop; the other edges are
  // then tested again on the wider crop until none moves. The crop replaces the
  // frame only when it still covers under half of it. `edges` names how each
  // side ended up, or is null when the frame is returned.
  function cropToMarks(pixels, frame, marksBox) {
    const whole = { box: frame.slice(), edges: null };
    if (!marksBox) return whole;
    const bounds = boundsOf(pixels, frame);
    const edge = { x0: bounds.x0, y0: bounds.y0, x1: bounds.x1, y1: bounds.y1 };
    const x0 = Math.max(edge.x0, Math.floor(marksBox[0] - CROP_MARGIN_X));
    const y0 = Math.max(edge.y0, Math.floor(marksBox[1] - CROP_MARGIN_Y));
    const x1 = Math.min(edge.x1, Math.ceil(marksBox[0] + marksBox[2] + CROP_MARGIN_X));
    const y1 = Math.min(edge.y1, Math.ceil(marksBox[1] + marksBox[3] + CROP_MARGIN_Y));
    if (x1 <= x0 || y1 <= y0) return whole;
    const [gx, gy, gw, gh] = growBox(pixels, [x0, y0, x1 - x0, y1 - y0], CROP_SNAP, { bounds: frame }).box;
    const r = { x0: gx, y0: gy, x1: gx + gw, y1: gy + gh };
    // Moving an edge out lengthens the lines the others are tested on, so the
    // others are tested again until none moves. Each move sends an edge to the
    // frame, so this ends after at most four.
    for (let moved = true; moved;) {
      moved = false;
      const current = [r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0];
      for (const side of SIDES) {
        const key = KEY_OF[side];
        if (r[key] === edge[key] || edgeIsClean(pixels, current, side, frame)) continue;
        r[key] = edge[key]; moved = true;
      }
    }
    const box = [r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0];
    if (box[2] * box[3] * 2 >= frame[2] * frame[3]) return whole;
    return { box, edges: Object.fromEntries(SIDES.map((side) => [side, r[KEY_OF[side]] === edge[KEY_OF[side]] ? 'frame' : 'snapped'])) };
  }

  const FRAME_REACH = 96;
  const FRAME_MARGIN = 16;
  // An edge moved inward lands this far inside the band, so the lens's
  // resampling never blends the content it just left into the first row.
  const FRAME_CUSHION = 2;

  // The capture frame is the macro's guess, and its edge can land mid-word. An
  // edge is clean when its line sits in a band of BAND clean lines (a run cut
  // short by the image counts), so a gap between letters does not pass. An
  // unclean edge moves inward first, which reveals nothing new, to the nearest
  // band that leaves FRAME_MARGIN pixels to the marks; failing that, outward to
  // the nearest band within FRAME_REACH; failing that it stays and is reported
  // `cut`. Edges are tested again after any move, since a moved edge changes the
  // lines the others span; each edge moves at most once each way. Untouched
  // coordinates keep their given values. `edges` names each side `clean`,
  // `inward`, `outward` (its last move) or `cut`. With no marks an edge has
  // nowhere to go inward.
  function cleanFrame(pixels, frame, marksBox, options) {
    const ignore = (options && options.ignore) || [];
    const image = boundsOf(pixels, null);
    const r = rectOf(frame, image);
    const lineClean = (side, offset) => lineIsClean(pixels, lineAt(r, side, offset), ignore);
    const inImage = (side, offset) => {
      const [x, y, w, h] = stripOf(lineAt(r, side, offset));
      return x >= image.x0 && y >= image.y0 && x + w <= image.x1 && y + h <= image.y1;
    };
    const isHeld = (side) => held(pixels, r, side, within(image), ignore);
    const room = (side) => {
      if (!marksBox) return 0;
      const [mx, my, mw, mh] = marksBox;
      if (side === 'left') return Math.floor(mx - FRAME_MARGIN) - r.x0;
      if (side === 'top') return Math.floor(my - FRAME_MARGIN) - r.y0;
      if (side === 'right') return r.x1 - Math.ceil(mx + mw + FRAME_MARGIN);
      return r.y1 - Math.ceil(my + mh + FRAME_MARGIN);
    };
    const inward = (side) => {
      const limit = room(side);
      let run = 0;
      for (let k = 1; inImage(side, -k); k += 1) {
        if (lineClean(side, -k)) run += 1; else run = 0;
        if ((run ? k - run + 1 : k + 1) + FRAME_CUSHION > limit) return 0;
        if (run >= BAND) return k - run + 1 + FRAME_CUSHION;
      }
      return 0;
    };
    const outward = (side) => findBand(pixels, r, side, FRAME_REACH, within(image), ignore);
    const shift = (side, d) => {
      r[KEY_OF[side]] += side === 'left' || side === 'top' ? d : -d;
    };
    const moved = {}; const last = {};
    const used = Object.fromEntries(SIDES.map((side) => [side, { inward: false, outward: false }]));
    for (let again = true; again;) {
      again = false;
      for (const side of SIDES) {
        if (isHeld(side)) continue;
        for (const way of ['inward', 'outward']) {
          if (used[side][way]) continue;
          const d = (way === 'inward' ? inward : outward)(side);
          if (!d) continue;
          shift(side, way === 'inward' ? d : -d);
          used[side][way] = true; moved[side] = true; last[side] = way; again = true;
          break;
        }
      }
    }
    const edges = Object.fromEntries(SIDES.map((side) => [side, isHeld(side) ? (last[side] || 'clean') : 'cut']));
    const out = frame.slice();
    const x0 = moved.left ? r.x0 : frame[0]; const y0 = moved.top ? r.y0 : frame[1];
    const x1 = moved.right ? r.x1 : frame[0] + frame[2]; const y1 = moved.bottom ? r.y1 : frame[1] + frame[3];
    if (Object.keys(moved).length) { out[0] = x0; out[1] = y0; out[2] = x1 - x0; out[3] = y1 - y0; }
    return { frame: out, edges, cut: SIDES.some((side) => edges[side] === 'cut') };
  }

  const CLUSTER_GAP = 12;
  const CLUSTER_HOLE = 0.25;

  const overlap = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0) > 0;
  const gapBetween = (a0, a1, b0, b1) => Math.max(b0 - a1, a0 - b1);

  function adjacent(a, b) {
    const xGap = gapBetween(a[0], a[0] + a[2], b[0], b[0] + b[2]);
    const yGap = gapBetween(a[1], a[1] + a[3], b[1], b[1] + b[3]);
    return (xGap <= CLUSTER_GAP && overlap(a[1], a[1] + a[3], b[1], b[1] + b[3]))
      || (yGap <= CLUSTER_GAP && overlap(a[0], a[0] + a[2], b[0], b[0] + b[2]));
  }

  // Area covered by at least one box; overlapping boxes count once.
  function coveredArea(boxes) {
    const xs = [...new Set(boxes.flatMap((b) => [b[0], b[0] + b[2]]))].sort((p, q) => p - q);
    const ys = [...new Set(boxes.flatMap((b) => [b[1], b[1] + b[3]]))].sort((p, q) => p - q);
    let area = 0;
    for (let i = 0; i < xs.length - 1; i += 1) {
      for (let j = 0; j < ys.length - 1; j += 1) {
        if (boxes.some((b) => b[0] <= xs[i] && xs[i + 1] <= b[0] + b[2] && b[1] <= ys[j] && ys[j + 1] <= b[1] + b[3])) {
          area += (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]);
        }
      }
    }
    return area;
  }

  // Boxes that sit next to each other in a row or a column are one thing and
  // share a cluster; a diagonal pair is two. A cluster whose bounding box is
  // more than CLUSTER_HOLE empty would sweep unrelated content into one lift,
  // so it splits into its members. Returns index lists, ascending within and
  // across clusters.
  function clusterBoxes(boxes) {
    const pairs = boxes.flatMap((a, i) => boxes.slice(i + 1).flatMap((b, k) => (adjacent(a, b) ? [[i, i + 1 + k]] : [])));
    return components(boxes.length, pairs).flatMap((members) => {
      if (members.length < 2) return [members];
      const list = members.map((i) => boxes[i]);
      const [, , w, h] = union(list);
      return (w * h - coveredArea(list)) / (w * h) > CLUSTER_HOLE ? members.map((i) => [i]) : [members];
    }).sort((p, q) => p[0] - q[0]);
  }

  // A route over one or two samples of stray antialiasing is not through
  // content, so a leader keeps its preferred side (index 0) unless it crosses
  // LEADER_THROUGH samples or more and another side crosses that many fewer.
  // `inks` are the sides' ink counts in preferred order; returns the index of
  // the side to use, or -1 for no sides.
  const LEADER_THROUGH = 3;
  function pickLeaderSide(inks) {
    if (!inks.length) return -1;
    const best = inks.reduce((at, ink, i) => (ink < inks[at] ? i : at), 0);
    return inks[0] >= LEADER_THROUGH && inks[0] - inks[best] >= LEADER_THROUGH ? best : 0;
  }

  // Two lifts of one mark that overlap or sit within LIFT_COLLIDE_GAP display
  // px of each other, at their final rects, read as a tangle rather than two
  // things; the caller merges them back into one lift. `items` are
  // { mark, rect }; returns the index pairs, ascending.
  const LIFT_COLLIDE_GAP = 8;
  function collidingLifts(items) {
    const pairs = [];
    items.forEach((a, i) => items.slice(i + 1).forEach((b, k) => {
      if (a.mark !== b.mark) return;
      const xGap = gapBetween(a.rect[0], a.rect[0] + a.rect[2], b.rect[0], b.rect[0] + b.rect[2]);
      const yGap = gapBetween(a.rect[1], a.rect[1] + a.rect[3], b.rect[1], b.rect[1] + b.rect[3]);
      if (xGap <= LIFT_COLLIDE_GAP && yGap <= LIFT_COLLIDE_GAP) pairs.push([i, i + 1 + k]);
    }));
    return pairs;
  }

  // A leader's dot sits at the middle of its lift's side unless that spot is on
  // page content. It then slides along the side [lo, hi] in DOT_STEP px steps,
  // centre outward both ways (the lower direction first), to the nearest spot
  // `isClean` accepts, never closer than DOT_INSET to either corner. Returns
  // that position, or null when no spot on the side is clean. A side too short
  // for the inset offers its centre alone.
  const DOT_STEP = 2;
  const DOT_INSET = 6;
  function slideDot(lo, hi, centre, isClean) {
    const min = lo + DOT_INSET; const max = hi - DOT_INSET;
    if (isClean(centre)) return centre;
    for (let k = 1; centre - k * DOT_STEP >= min || centre + k * DOT_STEP <= max; k += 1) {
      for (const p of [centre - k * DOT_STEP, centre + k * DOT_STEP]) {
        if (p >= min && p <= max && isClean(p)) return p;
      }
    }
    return null;
  }

  globalThis.__composeGeometry = { growBox, edgeIsClean, cleanPad, cropToMarks, cleanFrame, clusterBoxes, pickLeaderSide, collidingLifts, slideDot, hits, union, components, TOLERANCE, LIFT_RING, LIFT_BAND, LEADER_THROUGH };
}());
