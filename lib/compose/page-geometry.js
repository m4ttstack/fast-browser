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
  // Capture pixels. A lift's padding keeps this many clean lines beyond it, so
  // ground shows between the card and a neighbour instead of the card touching it.
  const LIFT_CLEAR = 3;
  // Capture pixels. A card's border or a divider is a line of one colour no
  // thicker than this; neither lineIsClean nor contentUnder counts one as content.
  const RULE_THICKNESS = 2;

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
  // pixels or fewer counts as a rule only when its colour holds, with the
  // pixels just outside the run a different colour (more than SLIGHT off), for
  // 2 * RULE_LENGTH (48) pixels in all across the line with at least
  // RULE_MIN_SIDE (4) on the shorter side, or for RULE_LENGTH (24) on one side
  // when the other runs off the image. A border cut near its corner is still a
  // border; a stem cut near its end is not. A line holds at most RULE_RUNS.
  const RULE_LENGTH = 24;
  const RULE_MIN_SIDE = 4;
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
    // How far the run's colour holds on one side of the line, with the pixels
    // beside it a different colour. `open` says the probe ran off the image.
    const holds = (dir) => {
      for (let k = 1; k <= 2 * RULE_LENGTH; k += 1) {
        const inside = run.map((along) => at(along, dir * k));
        if (inside.some((px) => px < 0)) return { n: k - 1, open: true };
        if (inside.some((px) => !near(px, ref, TOLERANCE))) return { n: k - 1, open: false };
        const outside = [at(first - 1, dir * k), at(last + 1, dir * k)];
        if (outside.some((px) => px >= 0 && near(px, ref, SLIGHT))) return { n: k - 1, open: false };
      }
      return { n: 2 * RULE_LENGTH, open: false };
    };
    const a = holds(1); const b = holds(-1);
    if (a.open || b.open) return Math.max(a.n, b.n) >= RULE_LENGTH;
    return Math.min(a.n, b.n) >= RULE_MIN_SIDE && a.n + b.n >= 2 * RULE_LENGTH;
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
    const x0 = grown.left ? r.x0 : box[0]; const y0 = grown.top ? r.y0 : box[1];
    const x1 = grown.right ? r.x1 : box[0] + box[2]; const y1 = grown.bottom ? r.y1 : box[1] + box[3];
    return { box: [x0, y0, x1 - x0, y1 - y0], cut };
  }

  // How far a lift's padding may extend on each side: up to `max` pixels, but
  // only over clean lines, and only while the LIFT_CLEAR lines beyond the
  // padding are clean too. The lens resamples the capture, so an unclean
  // neighbour line would bleed a faint sliver of content into the padding's
  // outer edge. Running out of image or bounds is not a neighbour.
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
      const spaced = (at) => Array.from({ length: LIFT_CLEAR }, (_, n) => state(side, at + 1 + n)).every((s) => s !== 'content');
      while (pad < max && state(side, pad + 1) === 'clean' && spaced(pad + 1)) pad += 1;
      return pad;
    });
  }

  // Division by S leaves a rect edge a hair off the pixel boundary it sits on.
  const EDGE_SLACK = 1e-6;

  // An enlarged lift's card may sit anywhere that still covers its element's
  // box as drawn, so the element never shows twice. `contentUnder` counts the
  // capture's pixels that a card hides outside the element, or leaves within
  // its ring and LIFT_CLEAR capture px of its edge: those that differ from the
  // ground (the median colour round the element's box) by more than TOLERANCE.
  // A rule is not content: a run of at most RULE_THICKNESS columns (or rows) that
  // each hold one colour, within TOLERANCE as in lineIsClean, along the whole
  // counted region and differ from the ground, so a card's border or a divider
  // beside a lift never pushes it off its element. A glyph, an icon or a chip
  // is not a line that long, and a chip is wider than RULE_THICKNESS. The runs below
  // give each column's and row's extent of one colour so a region is tested in
  // O(its width + height); lineIsClean walks the line's pixels and would be
  // asked that for every candidate card. The card and the element are in board
  // px, the frame in capture px; S board px per capture px.
  function contentUnder(pixels, frame, S, element) {
    const area = boundsOf(pixels, frame);
    const width = area.x1 - area.x0; const height = area.y1 - area.y0;
    let sums = null; let down = null; let across = null; let ground = null;
    const build = () => {
      const rim = rectOf([frame[0] + element[0] / S, frame[1] + element[1] / S, element[2] / S, element[3] / S], area);
      const channels = [[], [], []];
      const sample = (x, y) => { const at = (y * pixels.width + x) * 4; channels.forEach((values, c) => values.push(pixels.data[at + c])); };
      for (let x = rim.x0; x < rim.x1; x += 1) { sample(x, rim.y0); sample(x, rim.y1 - 1); }
      for (let y = rim.y0; y < rim.y1; y += 1) { sample(rim.x0, y); sample(rim.x1 - 1, y); }
      sums = new Int32Array((width + 1) * (height + 1));
      if (!channels[0].length) return;
      ground = channels.map((values) => median(values));
      down = new Int32Array(width * height); across = new Int32Array(width * height);
      const same = (a, b) => [0, 1, 2].every((c) => Math.abs(pixels.data[a + c] - pixels.data[b + c]) <= TOLERANCE);
      const offset = (x, y) => ((area.y0 + y) * pixels.width + area.x0 + x) * 4;
      for (let y = height - 1; y >= 0; y -= 1) {
        for (let x = width - 1; x >= 0; x -= 1) {
          const own = y * width + x;
          down[own] = y + 1 < height && same(offset(x, y), offset(x, y + 1)) ? down[own + width] + 1 : 1;
          across[own] = x + 1 < width && same(offset(x, y), offset(x + 1, y)) ? across[own + 1] + 1 : 1;
        }
      }
      for (let y = 0; y < height; y += 1) {
        let row = 0;
        for (let x = 0; x < width; x += 1) {
          const at = ((area.y0 + y) * pixels.width + area.x0 + x) * 4;
          if (ground.some((v, c) => Math.abs(pixels.data[at + c] - v) > TOLERANCE)) row += 1;
          sums[(y + 1) * (width + 1) + x + 1] = sums[y * (width + 1) + x + 1] + row;
        }
      }
    };
    // A pixel counts when any of it lies in the rect, so the margin is never
    // short of LIFT_CLEAR px by a half pixel.
    const span = (from, to, low, high) => [Math.min(high, Math.max(low, Math.floor(from + EDGE_SLACK))), Math.min(high, Math.max(low, Math.ceil(to - EDGE_SLACK)))];
    const countIn = ([x0, y0, x1, y1]) => {
      if (x1 <= x0 || y1 <= y0) return 0;
      const at = (px, py) => sums[(py - area.y0) * (width + 1) + px - area.x0];
      return at(x1, y1) - at(x0, y1) - at(x1, y0) + at(x0, y0);
    };
    const rectOfCard = (x, y, w, h) => {
      const [x0, x1] = span(frame[0] + x / S, frame[0] + (x + w) / S, area.x0, area.x1);
      const [y0, y1] = span(frame[1] + y / S, frame[1] + (y + h) / S, area.y0, area.y1);
      return [x0, y0, x1, y1];
    };
    const differs = (px, py) => ground.some((v, c) => Math.abs(pixels.data[(py * pixels.width + px) * 4 + c] - v) > TOLERANCE);
    // The runs of at most RULE_THICKNESS columns, and of rows, that are a rule along
    // the whole of `region`, as rects. The line just outside a run, inside the
    // frame, must be another colour, or the run is the edge of a block.
    const rulesIn = ([x0, y0, x1, y1]) => {
      const found = [];
      const pixelAt = (x, y) => (y * pixels.width + x) * 4;
      const runs = (from, to, low, high, isRule, rect, colourAt) => {
        const sameAsRun = (at, beside) => beside >= low && beside < high
          && [0, 1, 2].every((c) => Math.abs(pixels.data[colourAt(at) + c] - pixels.data[colourAt(beside) + c]) <= SLIGHT);
        for (let at = from; at < to;) {
          if (!isRule(at)) { at += 1; continue; }
          let end = at; while (end < to && isRule(end)) end += 1;
          if (end - at <= RULE_THICKNESS && !sameAsRun(at, at - 1) && !sameAsRun(end - 1, end)) found.push(rect(at, end));
          at = end;
        }
      };
      runs(x0, x1, area.x0, area.x1, (x) => down[(y0 - area.y0) * width + x - area.x0] >= y1 - y0 && differs(x, y0), (a, b) => [a, y0, b, y1], (x) => pixelAt(x, y0));
      runs(y0, y1, area.y0, area.y1, (y) => across[(y - area.y0) * width + x0 - area.x0] >= x1 - x0 && differs(x0, y), (a, b) => [x0, a, x1, b], (y) => pixelAt(x0, y));
      return found;
    };
    // The pixels of `region` that differ from the ground, less those in a rule.
    // A vertical and a horizontal rule share their crossing, taken off once.
    const contentIn = (region, rules) => {
      const inside = rules.map((rule) => [Math.max(rule[0], region[0]), Math.max(rule[1], region[1]), Math.min(rule[2], region[2]), Math.min(rule[3], region[3])]);
      let total = countIn(region) - inside.reduce((sum, rule) => sum + countIn(rule), 0);
      inside.forEach((a, i) => inside.slice(i + 1).forEach((b) => {
        total += countIn([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
      }));
      return total;
    };
    const near = LIFT_RING + LIFT_CLEAR * S;
    return (card) => {
      if (!sums) build();
      const [x, y, w, h] = [card[0] - near, card[1] - near, card[2] + 2 * near, card[3] + 2 * near];
      const [ex, ey, ew, eh] = element;
      const ix = Math.max(x, ex); const iy = Math.max(y, ey);
      const iw = Math.min(x + w, ex + ew) - ix; const ih = Math.min(y + h, ey + eh) - iy;
      const region = rectOfCard(x, y, w, h);
      if (region[2] <= region[0] || region[3] <= region[1]) return 0;
      const rules = down ? rulesIn(region) : [];
      return contentIn(region, rules) - (iw > 0 && ih > 0 ? contentIn(rectOfCard(ix, iy, iw, ih), rules) : 0);
    };
  }

  // A card keeps this many board px from the frame's edge.
  const LIFT_EDGE = 2;

  // Where a card of `size` [W, H] sits for `element`, in a frame `room` [cw, ch]
  // board px: the position that hides the least by `hidden` (contentUnder),
  // looked for in whole board px along each axis between the two ends that
  // still cover the element, and those ends. A tie goes to the position nearest
  // the centred one, then to the lower. An axis on which the card is no larger
  // than the element stays centred. `clamped` says the frame cut short what
  // the rule wanted on either axis.
  function liftSpot(hidden, room, element, size) {
    const axis = (start, extent, card, limit) => {
      const centred = start + extent / 2 - card / 2;
      const high = limit - card - LIFT_EDGE;
      const pinned = Math.min(Math.max(centred, LIFT_EDGE), high);
      const ideal = [start + extent - card, start];
      const lo = Math.max(ideal[0], LIFT_EDGE); const hi = Math.min(ideal[1], high);
      if (card <= extent) return { pinned, spots: [pinned], cut: () => pinned !== centred };
      if (lo > hi) return { pinned, spots: [pinned], cut: () => true };
      const spots = new Set([lo, hi, pinned]);
      for (let at = Math.ceil(lo); at <= hi; at += 1) spots.add(at);
      return { pinned, spots: [...spots].sort((a, b) => a - b), cut: (at) => (lo > ideal[0] && at === lo) || (hi < ideal[1] && at === hi) };
    };
    const across = axis(element[0], element[2], size[0], room[0]);
    const down = axis(element[1], element[3], size[1], room[1]);
    let best = null;
    const consider = (L, T) => {
      const spent = hidden([L, T, size[0], size[1]]);
      const away = (L - across.pinned) ** 2 + (T - down.pinned) ** 2;
      if (!best || spent < best.spent || (spent === best.spent && away < best.away)) best = { L, T, spent, away };
      return spent === 0 && away === 0;
    };
    if (!consider(across.pinned, down.pinned)) {
      for (const L of across.spots) for (const T of down.spots) consider(L, T);
    }
    return { L: best.L, T: best.T, clamped: across.cut(best.L) || down.cut(best.T) };
  }

  // Capture pixels: the crop margins, the smallest crop, the margin along a
  // bracket's rows, and how much ground a trimmed frame keeps outside its first
  // content.
  const CROP_MARGIN_X = 64;
  const CROP_MARGIN_Y = 48;
  const CROP_MARGIN_TIGHT = 16;
  const CROP_MIN_W = 320;
  const CROP_MIN_H = 200;
  const TRIM_PAD = 2;
  const CROP_SNAP = 80;
  // A snapped edge sits on the first clean line past the content, which reads
  // as text cut off at the border. It backs away until this many clean lines
  // lie inside it.
  const CROP_AIR = 12;

  // The span [lo, hi) grown evenly to `min`, then slid back inside [from, to):
  // a span pushed against the frame keeps its size.
  function growSpan(lo, hi, min, from, to) {
    const short = min - (hi - lo);
    if (short <= 0) return [lo, hi];
    lo -= Math.floor(short / 2); hi += Math.ceil(short / 2);
    if (lo < from) { hi += from - lo; lo = from; }
    if (hi > to) { lo -= hi - to; hi = to; }
    return [Math.max(from, lo), hi];
  }

  // The crop before its edges snap: the marks plus a margin, at least
  // CROP_MIN_W by CROP_MIN_H when `floor` is set, inside `edge`. A bracket's
  // rows run top to bottom, so when every part bounding the top (or bottom) of
  // the marks is a bracket, that edge takes CROP_MARGIN_TIGHT instead of
  // CROP_MARGIN_Y. `atEdge` names the sides that sit on the edge.
  function cropMargins(edge, marksBox, parts, floor) {
    const bounding = (key, pick) => {
      const ends = parts.map((part) => key(part.box));
      const extreme = pick(...ends);
      return parts.filter((part) => key(part.box) === extreme).every((part) => part.bracket);
    };
    const tightTop = parts.length > 0 && bounding((b) => b[1], Math.min);
    const tightBottom = parts.length > 0 && bounding((b) => b[1] + b[3], Math.max);
    const [x0, x1] = growSpan(
      Math.max(edge.x0, Math.floor(marksBox[0] - CROP_MARGIN_X)), Math.min(edge.x1, Math.ceil(marksBox[0] + marksBox[2] + CROP_MARGIN_X)),
      floor ? CROP_MIN_W : 0, edge.x0, edge.x1,
    );
    const [y0, y1] = growSpan(
      Math.max(edge.y0, Math.floor(marksBox[1] - (tightTop ? CROP_MARGIN_TIGHT : CROP_MARGIN_Y))), Math.min(edge.y1, Math.ceil(marksBox[1] + marksBox[3] + (tightBottom ? CROP_MARGIN_TIGHT : CROP_MARGIN_Y))),
      floor ? CROP_MIN_H : 0, edge.y0, edge.y1,
    );
    if (x1 <= x0 || y1 <= y0) return null;
    const rect = { x0, y0, x1, y1 };
    return { rect, atEdge: { left: x0 === edge.x0, top: y0 === edge.y0, right: x1 === edge.x1, bottom: y1 === edge.y1 } };
  }

  // Each edge of `rect` that is off the frame snaps outward to a clean band. An
  // edge that finds no band goes to the frame's own edge on that side, since a
  // crop edge through content is worse than a wider crop, or with `hold` stays
  // at its margin and is reported `held`, since on a dense page the frame's edge
  // is no cleaner and the crop would swell to the whole page; the other edges
  // are then tested again on the new crop until none moves. A snapped edge then
  // backs away from content until CROP_AIR clean lines lie inside it, stopping
  // at the first unclean line or the frame.
  function snapCrop(pixels, frame, edge, rect, hold) {
    const [gx, gy, gw, gh] = growBox(pixels, [rect.x0, rect.y0, rect.x1 - rect.x0, rect.y1 - rect.y0], CROP_SNAP, { bounds: frame }).box;
    const r = { x0: gx, y0: gy, x1: gx + gw, y1: gy + gh };
    for (const side of SIDES) {
      if (r[KEY_OF[side]] === edge[KEY_OF[side]]) continue;
      const lineClean = (offset) => lineIsClean(pixels, lineAt(r, side, offset), []);
      let air = 0;
      while (air < CROP_AIR && lineClean(-air)) air += 1;
      while (air > 0 && air < CROP_AIR && within(edge)(lineAt(r, side, 1)) && lineClean(1)) {
        r[KEY_OF[side]] += side === 'left' || side === 'top' ? -1 : 1;
        air += 1;
      }
    }
    // Moving an edge out lengthens the lines the others are tested on, so the
    // others are tested again until none moves. Each edge moves at most once
    // (to the frame, or back to its margin), so this ends after at most four.
    const fellBack = {}; const held = {};
    for (let moved = true; moved;) {
      moved = false;
      const current = [r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0];
      for (const side of SIDES) {
        const key = KEY_OF[side];
        if (r[key] === edge[key] || edgeIsClean(pixels, current, side, frame)) continue;
        if (hold) {
          held[side] = true;
          if (r[key] === rect[key]) continue;
          r[key] = rect[key];
        } else { r[key] = edge[key]; fellBack[side] = true; }
        moved = true;
      }
    }
    return { r, fellBack, held };
  }

  const edgesOf = (atEdge, fellBack, held) => Object.fromEntries(SIDES.map((side) => [side, atEdge[side] ? 'clamped' : held[side] ? 'margin' : fellBack[side] ? 'frame' : 'snapped']));
  // A held edge that still runs through content.
  const heldCut = (pixels, frame, box, held) => SIDES.some((side) => held[side] && !edgeIsClean(pixels, box, side, frame));

  // A frame far larger than its marks buries them in unrelated page. The crop
  // is the marks plus a margin (see cropMargins), each edge snapped (see
  // snapCrop). The crop replaces the frame only when it still covers under half
  // of it. `edges` names each side `snapped`, `frame` (no clean band, so it fell
  // back to the frame), `margin` (held at its margin, with `options.hold`; `cut`
  // says one runs through content) or `clamped` (the margin already reached the
  // frame), or is null when the frame is returned. `options.parts` lists the
  // marks as { box, bracket } for the bracket margin; `options.floor` (default
  // false) sets whether the crop is held to the context floor.
  function cropToMarks(pixels, frame, marksBox, options) {
    const whole = { box: frame.slice(), edges: null, cut: false };
    if (!marksBox) return whole;
    const parts = (options && options.parts) || [];
    const bounds = boundsOf(pixels, frame);
    const edge = { x0: bounds.x0, y0: bounds.y0, x1: bounds.x1, y1: bounds.y1 };
    const margins = cropMargins(edge, marksBox, parts, Boolean(options && options.floor));
    if (!margins) return whole;
    const { r, fellBack, held } = snapCrop(pixels, frame, edge, margins.rect, Boolean(options && options.hold));
    const box = [r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0];
    if (box[2] * box[3] * 2 >= frame[2] * frame[3]) return whole;
    return { box, edges: edgesOf(margins.atEdge, fellBack, held), cut: heldCut(pixels, frame, box, held) };
  }

  // Blank ground at the edges of a frame that shows everything is dead space,
  // and it differs from one panel to the next. Each edge moves inward over the
  // lines that are wholly ground (every pixel within SLIGHT of the edge line's
  // colour, so no content and no rule: a card's faint border on a page of nearly
  // the same shade is a rule, which TOLERANCE would read as ground), keeping
  // TRIM_PAD of them outside the first line that has anything on it, and never
  // past `marksBox`. An axis that is ground from end to end stays as it is.
  // Returns the new box and how far each side moved.
  function trimBlank(pixels, frame, marksBox) {
    const r = rectOf(frame, boundsOf(pixels, null));
    const pixelAt = (line, i) => ((line.horizontal ? line.fixed : i) * pixels.width + (line.horizontal ? i : line.fixed)) * 4;
    const ground = Object.fromEntries(SIDES.map((side) => {
      const line = lineAt(r, side, 0);
      const channels = [0, 1, 2].map((c) => {
        const values = [];
        for (let i = line.from; i < line.to; i += 1) values.push(pixels.data[pixelAt(line, i) + c]);
        return median(values);
      });
      return [side, channels];
    }));
    const blank = (side, offset) => {
      const line = lineAt(r, side, -offset);
      for (let i = line.from; i < line.to; i += 1) {
        if (ground[side].some((v, c) => Math.abs(pixels.data[pixelAt(line, i) + c] - v) > SLIGHT)) return false;
      }
      return true;
    };
    const room = {
      left: marksBox ? Math.floor(marksBox[0]) - r.x0 : Infinity, top: marksBox ? Math.floor(marksBox[1]) - r.y0 : Infinity,
      right: marksBox ? r.x1 - Math.ceil(marksBox[0] + marksBox[2]) : Infinity, bottom: marksBox ? r.y1 - Math.ceil(marksBox[1] + marksBox[3]) : Infinity,
    };
    const extent = { left: r.x1 - r.x0, right: r.x1 - r.x0, top: r.y1 - r.y0, bottom: r.y1 - r.y0 };
    const trimmed = {};
    for (const side of SIDES) {
      let run = 0;
      while (run < extent[side] && blank(side, run)) run += 1;
      trimmed[side] = run >= extent[side] ? 0 : Math.max(0, Math.min(run - TRIM_PAD, room[side] - TRIM_PAD));
    }
    if (trimmed.left + trimmed.right >= extent.left || trimmed.top + trimmed.bottom >= extent.top) return { box: frame.slice(), trimmed: Object.fromEntries(SIDES.map((side) => [side, 0])) };
    const box = [r.x0 + trimmed.left, r.y0 + trimmed.top, extent.left - trimmed.left - trimmed.right, extent.top - trimmed.top - trimmed.bottom];
    return { box: trimmed.left || trimmed.top || trimmed.right || trimmed.bottom ? box : frame.slice(), trimmed };
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
  // coordinates keep their given values. `edges` names each side for where it
  // ended up against where it started: `clean`, `inward`, `outward`, `cut`, or
  // `image` when an edge that is not held sits on the image's own boundary,
  // where flush content cannot be told from cut content and there is nowhere to
  // move. An edge through a `keep` box (a redaction fill) moves out to its far
  // side first. With no marks an edge has nowhere to go inward. With
  // `options.fixed` the frame is a boundary the caller drew to hide what lies
  // beside it: no edge moves outward, and an edge a fill cuts stays where the
  // frame put it, so the fill is clipped there.
  function cleanFrame(pixels, frame, marksBox, options) {
    const ignore = (options && options.ignore) || [];
    const keep = (options && options.keep) || [];
    const fixed = Boolean(options && options.fixed);
    const image = boundsOf(pixels, null);
    const r = rectOf(frame, image);
    const origin = { ...r };
    const limit = fixed ? origin : image;
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
    const moved = {};
    // A fill hides what is under it, so an edge through one cuts nothing; it
    // still reads as a torn redaction. The edge moves out to the fill's far side.
    const clearKeep = (side) => {
      for (const [kx, ky, kw, kh] of keep) {
        const spansX = kx < r.x1 && kx + kw > r.x0; const spansY = ky < r.y1 && ky + kh > r.y0;
        if (side === 'left' && spansY && kx < r.x0 && kx + kw > r.x0) { r.x0 = Math.max(limit.x0, Math.floor(kx)); moved.left = true; }
        if (side === 'right' && spansY && kx < r.x1 && kx + kw > r.x1) { r.x1 = Math.min(limit.x1, Math.ceil(kx + kw)); moved.right = true; }
        if (side === 'top' && spansX && ky < r.y0 && ky + kh > r.y0) { r.y0 = Math.max(limit.y0, Math.floor(ky)); moved.top = true; }
        if (side === 'bottom' && spansX && ky < r.y1 && ky + kh > r.y1) { r.y1 = Math.min(limit.y1, Math.ceil(ky + kh)); moved.bottom = true; }
      }
    };
    for (const side of SIDES) clearKeep(side);
    const used = Object.fromEntries(SIDES.map((side) => [side, { inward: false, outward: false }]));
    for (let again = true; again;) {
      again = false;
      for (const side of SIDES) {
        if (isHeld(side)) continue;
        for (const way of fixed ? ['inward'] : ['inward', 'outward']) {
          if (used[side][way]) continue;
          const d = (way === 'inward' ? inward : outward)(side);
          if (!d) continue;
          shift(side, way === 'inward' ? d : -d);
          used[side][way] = true; moved[side] = true; clearKeep(side); again = true;
          break;
        }
      }
    }
    const onImage = (side) => r[KEY_OF[side]] === image[KEY_OF[side]];
    const edges = Object.fromEntries(SIDES.map((side) => {
      const isIn = isHeld(side);
      if (!isIn && onImage(side)) return [side, 'image'];
      return [side, edgeName(side, origin[KEY_OF[side]], r[KEY_OF[side]], isIn)];
    }));
    const out = frame.slice();
    const x0 = moved.left ? r.x0 : frame[0]; const y0 = moved.top ? r.y0 : frame[1];
    const x1 = moved.right ? r.x1 : frame[0] + frame[2]; const y1 = moved.bottom ? r.y1 : frame[1] + frame[3];
    if (Object.keys(moved).length) { out[0] = x0; out[1] = y0; out[2] = x1 - x0; out[3] = y1 - y0; }
    return { frame: out, edges, cut: SIDES.some((side) => edges[side] === 'cut') };
  }

  function edgeName(side, origin, final, isHeld) {
    if (!isHeld) return 'cut';
    const inwardBy = side === 'left' || side === 'top' ? final - origin : origin - final;
    return inwardBy > 0 ? 'inward' : inwardBy < 0 ? 'outward' : 'clean';
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

  const crosses = ([ax, ay], [bx, by], [cx, cy], [dx, dy]) => {
    const side = (px, py, qx, qy, rx, ry) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
    return side(ax, ay, bx, by, cx, cy) * side(ax, ay, bx, by, dx, dy) < 0 && side(cx, cy, dx, dy, ax, ay) * side(cx, cy, dx, dy, bx, by) < 0;
  };
  // Whether two polylines properly cross; touching at an endpoint is not crossing.
  const pathsCross = (a, b) => a.slice(1).some((p, i) => b.slice(1).some((q, j) => crosses(a[i], p, b[j], q)));

  // A leader's dot takes the cheapest spot along its lift's side [lo, hi]: the
  // spot `accept` allows whose `cost` is least, walking the side from `centre`
  // outward in SPOT_STEP px steps, never closer than DOT_INSET to either corner.
  // A tie goes to the spot nearest the centre, and of two equally near to the
  // lower one. Returns { at, cost }, or null when no spot is acceptable. A side
  // too short for the inset offers its centre alone.
  const SPOT_STEP = 0.5;
  const DOT_INSET = 6;
  function cleanestSpot(lo, hi, centre, accept, cost) {
    const min = lo + DOT_INSET; const max = hi - DOT_INSET;
    let best = null;
    const consider = (at) => {
      if (!accept(at)) return;
      const spent = cost(at);
      if (!best || spent < best.cost) best = { at, cost: spent };
    };
    consider(centre);
    for (let k = 1; best?.cost !== 0 && (centre - k * SPOT_STEP >= min || centre + k * SPOT_STEP <= max); k += 1) {
      for (const at of [centre - k * SPOT_STEP, centre + k * SPOT_STEP]) {
        if (at >= min && at <= max) consider(at);
      }
    }
    return best;
  }

  // The one height every panel of a pair or steps board is drawn at, however
  // different the frames: the board's width budget shared by their shapes,
  // never enlarging the shortest frame past PANEL_MAX_S. `floored` says the
  // shapes needed less than PANEL_MIN_H, so the board runs wide.
  const PANEL_BUDGET = 1120;
  const PANEL_MIN_H = 96;
  const PANEL_MAX_H = 360;
  const PANEL_MAX_S = 1.25;
  function commonHeight(frames) {
    const shapes = frames.reduce((sum, f) => sum + f[2] / f[3], 0);
    const shortest = Math.min(...frames.map((f) => f[3]));
    const wanted = Math.min(PANEL_MAX_H, PANEL_MAX_S * shortest, PANEL_BUDGET / shapes);
    return { height: Math.max(PANEL_MIN_H, Math.round(wanted)), floored: PANEL_BUDGET / shapes < PANEL_MIN_H };
  }

  const DARK_BELOW = 110;
  // The capture rule's luminance test, taken over a 16 by 16 grid of the
  // frame's pixels: an imported image has no page to ask for its background.
  // Points under a `skip` rect are not read: a fill says nothing about the ground.
  function frameIsDark(pixels, frame, skip = []) {
    const b = boundsOf(pixels, frame);
    const values = [];
    for (let i = 0; i < 16; i += 1) {
      for (let j = 0; j < 16; j += 1) {
        const x = Math.min(b.x1 - 1, Math.floor(b.x0 + ((b.x1 - b.x0) * (i + 0.5)) / 16));
        const y = Math.min(b.y1 - 1, Math.floor(b.y0 + ((b.y1 - b.y0) * (j + 0.5)) / 16));
        if (skip.some(([sx, sy, sw, sh]) => x >= sx && x < sx + sw && y >= sy && y < sy + sh)) continue;
        const at = (y * pixels.width + x) * 4;
        values.push(0.299 * pixels.data[at] + 0.587 * pixels.data[at + 1] + 0.114 * pixels.data[at + 2]);
      }
    }
    return median(values) < DARK_BELOW;
  }

  globalThis.__composeGeometry = { growBox, edgeIsClean, cleanPad, contentUnder, liftSpot, cropToMarks, trimBlank, cleanFrame, edgeName, clusterBoxes, pickLeaderSide, collidingLifts, cleanestSpot, pathsCross, hits, union, components, commonHeight, frameIsDark, TOLERANCE, LIFT_RING, LIFT_BAND, LIFT_CLEAR, LEADER_THROUGH };
}());
