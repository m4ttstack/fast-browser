// Pixel geometry shared by the renderer page and node --test. Plain script, no
// imports: page.mjs inlines this file's text ahead of page-layout.js, and the
// unit tests run it in a vm context. Pixels are { data: RGBA bytes, width,
// height }; boxes are [x, y, w, h] in the same pixel space.
(function () {
function build(scale) {
  const TOLERANCE = 24;
  // Letter gaps are a pixel or two; a gap between words or elements is wider.
  const BAND = 6 * scale;
  // A rounded corner of radius R device pixels leaves R - 1 off-colour pixels at each end of an edge line; CORNER covers a radius of 3 CSS px.
  const CORNER = 3 * scale - 1;
  const SIDES = ['left', 'top', 'right', 'bottom'];
  const KEY_OF = { left: 'x0', top: 'y0', right: 'x1', bottom: 'y1' };
  // The 3px box-shadow ring page.mjs draws round a lift.
  const LIFT_RING = 3;
  // Rules out a 1-2px letter gap and accepts the 3-4px word space of 12-14px text.
  const LIFT_BAND = 3 * scale;
  // Capture pixels. A lift's padding keeps this many clean lines beyond it, so
  // ground shows between the card and a neighbour instead of the card touching it.
  const LIFT_CLEAR = 3 * scale;
  // Capture pixels. A card's border or a divider is a line of one colour no
  // thicker than this; neither lineIsClean nor contentUnder counts one as content.
  const RULE_THICKNESS = 2 * scale;
  // Capture pixels, whole: one CSS px, the thickness of a hairline.
  const HAIR = Math.max(1, Math.round(scale));

  const median = (values) => { values.sort((a, b) => a - b); return values[values.length >> 1]; };
  const hits = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
  const inRect = (r, x, y) => x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3];
  const inset = (box, by) => [box[0] + by.left, box[1] + by.top, box[2] - by.left - by.right, box[3] - by.top - by.bottom];
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
  // 2 * RULE_LENGTH (48 at scale 1) pixels in all across the line with at least
  // RULE_MIN_SIDE (4 at scale 1) on the shorter side, or for RULE_LENGTH (24 at
  // scale 1) on one side when the other runs off the image. A border cut near
  // its corner is still a border; a stem cut near its end is not. A line holds
  // at most RULE_RUNS.
  const RULE_LENGTH = 24 * scale;
  const RULE_MIN_SIDE = 4 * scale;
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
  // line made only of skipped pixels is clean. A line that runs into a block's
  // `content` ({ rect, colour }, see acrossStrips) is not clean whatever its pixels,
  // unless the block is the line's own colour: then it is the line's ground.
  function lineIsClean(pixels, line, ignore, content) {
    const { horizontal, fixed, from, to } = line;
    const channels = [[], [], []]; const positions = [];
    const trim = to - from > 2 * CORNER ? CORNER : 0;
    for (let i = from + trim; i < to - trim; i += 1) {
      const x = horizontal ? i : fixed; const y = horizontal ? fixed : i;
      if (ignore.some((r) => inRect(r, x, y))) continue;
      const at = (y * pixels.width + x) * 4;
      for (let c = 0; c < 3; c += 1) channels[c].push(pixels.data[at + c]);
      positions.push(i);
    }
    const mids = channels.map((values) => median(values.slice()));
    if (positions.length && content && content.some((c) => hits(stripOf(line), c.rect) && !sameColour(c.colour, mids, TOLERANCE))) return false;
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

  const pixelOf = (pixels, line, i) => ((line.horizontal ? line.fixed : i) * pixels.width + (line.horizontal ? i : line.fixed)) * 4;
  const inRects = (rects, line, i) => {
    const x = line.horizontal ? i : line.fixed; const y = line.horizontal ? line.fixed : i;
    return rects.some((r) => x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3]);
  };
  // The line's median colour, pixels inside a `skip` rectangle aside; null for a line made only of those.
  function lineMedian(pixels, line, skip) {
    const channels = [[], [], []];
    for (let i = line.from; i < line.to; i += 1) {
      if (skip && skip.length && inRects(skip, line, i)) continue;
      const at = pixelOf(pixels, line, i);
      for (let c = 0; c < 3; c += 1) channels[c].push(pixels.data[at + c]);
    }
    return channels[0].length ? channels.map((values) => median(values)) : null;
  }
  // Every pixel of the line within `within` of `colour`, pixels inside a `skip` rectangle aside. Unless `strict`, the CORNER pixels at each end of a line longer than 2 * CORNER are skipped.
  function lineIs(pixels, line, colour, within, strict, skip) {
    const trim = !strict && line.to - line.from > 2 * CORNER ? CORNER : 0;
    for (let i = line.from + trim; i < line.to - trim; i += 1) {
      if (skip && skip.length && inRects(skip, line, i)) continue;
      const at = pixelOf(pixels, line, i);
      if (colour.some((v, c) => Math.abs(pixels.data[at + c] - v) > within)) return false;
    }
    return true;
  }
  const sameColour = (a, b, within) => a.every((v, c) => Math.abs(v - b[c]) <= within);
  const lineInImage = (pixels, line) => {
    const [x, y, w, h] = stripOf(line);
    return x >= 0 && y >= 0 && x + w <= pixels.width && y + h <= pixels.height;
  };

  // The colour that holds along at least half the line's pixels (within SLIGHT
  // of its median), pixels inside an `ignore` rect aside; null for a line that
  // leaves the image, that no colour holds along half of, or made only of those.
  function heldColour(pixels, line, ignore) {
    if (!lineInImage(pixels, line)) return null;
    const colour = lineMedian(pixels, line, ignore);
    if (!colour) return null;
    let read = 0; let held = 0;
    for (let i = line.from; i < line.to; i += 1) {
      if (ignore.length && inRects(ignore, line, i)) continue;
      read += 1;
      const at = pixelOf(pixels, line, i);
      if (colour.every((v, c) => Math.abs(pixels.data[at + c] - v) <= SLIGHT)) held += 1;
    }
    return 2 * held >= read ? colour : null;
  }

  // A rule is RULE_THICKNESS lines or fewer, from `line` on in the direction
  // `step` (1 or -1 across the line), each held by one colour along half its
  // length (heldColour), a colour more than SLIGHT off the line just past them
  // and off `ground` where given. Returns { thickness, colour }, or null.
  function edgeRuleAt(pixels, line, { step = 1, ground = null, ignore = [] } = {}) {
    const nth = (k) => ({ ...line, fixed: line.fixed + k * step });
    const colour = heldColour(pixels, line, ignore);
    if (!colour || (ground && sameColour(ground, colour, SLIGHT))) return null;
    let thickness = 1;
    while (thickness <= RULE_THICKNESS) {
      const next = heldColour(pixels, nth(thickness), ignore);
      if (!next || !sameColour(next, colour, SLIGHT)) break;
      thickness += 1;
    }
    if (thickness > RULE_THICKNESS) return null;
    const past = nth(thickness);
    const beyond = lineInImage(pixels, past) ? lineMedian(pixels, past, ignore) : null;
    return beyond && !sameColour(beyond, colour, SLIGHT) ? { thickness, colour } : null;
  }

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
  function held(pixels, r, side, reach, ignore, band, content) {
    const need = band || BAND;
    const clean = (offset) => lineIsClean(pixels, lineAt(r, side, offset), ignore, content);
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

  // Capture pixels: how far outward a held crop edge or a cut frame edge looks for a word space.
  const WORD_REACH = 48 * scale;

  // Where an edge through running text settles, or null: in the first run of LIFT_BAND clean lines (a space
  // between words or between lines), looked for over the `inward` lines inside the edge, nearest first, then
  // over the `outward` lines beyond it, never past `bounds`. The edge goes to the middle of the run, read
  // within those lines, rounded to a whole CSS px, so a 2x capture settles where its 1x twin does.
  function wordGap(pixels, r, side, inward, outward, bounds, ignore, content) {
    const reach = within(bounds);
    // The limits are whole CSS px, so a run they cut short covers the same CSS px at 2x as at 1x.
    const lo = 1 - Math.round((Math.max(0, Math.floor(inward / scale)) + 1) * scale);
    const hi = Math.round(Math.max(0, Math.floor(outward / scale)) * scale);
    const seen = new Map();
    const clean = (o) => {
      if (o < lo || o > hi) return false;
      if (!seen.has(o)) seen.set(o, reach(lineAt(r, side, o)) && lineIsClean(pixels, lineAt(r, side, o), ignore || [], content));
      return seen.get(o);
    };
    const runAt = (o) => { let a = o; let b = o; while (clean(a - 1)) a -= 1; while (clean(b + 1)) b += 1; return [a, b]; };
    let run = null;
    for (let o = 0; o >= lo && !run; o -= 1) {
      if (!clean(o)) continue;
      const [a, b] = runAt(o);
      if (b - a + 1 >= LIFT_BAND) run = [a, b]; else o = a;
    }
    for (let o = 1; o <= hi && !run; o += 1) {
      if (!clean(o)) continue;
      const [a, b] = runAt(o);
      if (b - a + 1 >= LIFT_BAND) run = [a, b]; else o = b;
    }
    if (!run) return null;
    const at = run.map((o) => lineAt(r, side, o).fixed);
    const first = Math.min(...at); const last = Math.max(...at);
    const middle = Math.round(Math.round((first + last + 1) / 2 / scale) * scale);
    // A left or top edge is the first line it keeps; a right or bottom edge lies just past it.
    const past = side === 'right' || side === 'bottom' ? 1 : 0;
    return Math.min(last + past, Math.max(first + past, middle));
  }

  // An edge that sits in a word space: its line clean, in a run of LIFT_BAND clean lines (a run cut short by
  // `bounds` counts), pixels inside an `ignore` rect aside and none running into a `content` rect.
  function edgeInGap(pixels, box, side, bounds, ignore, content) {
    const area = boundsOf(pixels, bounds);
    return held(pixels, rectOf(box, area), side, within(area), ignore || [], LIFT_BAND, content);
  }

  // How far inward from `r`'s edge on `side` the far side of `marksBox` lies; with no marks, the whole of `r`.
  function pastMarks(r, side, marksBox) {
    if (!marksBox) return side === 'left' || side === 'right' ? r.x1 - r.x0 : r.y1 - r.y0;
    const [mx, my, mw, mh] = marksBox;
    if (side === 'left') return Math.ceil(mx + mw) - r.x0;
    if (side === 'top') return Math.ceil(my + mh) - r.y0;
    if (side === 'right') return r.x1 - Math.floor(mx);
    return r.y1 - Math.floor(my);
  }

  // A sidebar or rail across an edge crosses every line an edge search reads, so no band or word space there is
  // ever clean. On the edge's lines from offset `lo` to `hi` (outward positive) across `bounds`, a strip is a
  // stretch more than TOLERANCE off those lines' ground (their median on a STRIP_GRID square grid: the edge's own
  // line may run along content) that holds within SLIGHT over every one of them and runs to within AIR of one end
  // of `through` (the image, or an imported frame) and to within AIR of the other or WORD_REACH past the lines: a
  // button ends short of both. Callers start `lo` past the far side of `marksBox`; a stretch in line with the marks
  // is theirs, and one RULE_THICKNESS wide or less (a rule, or on a dense page the ground between glyphs) is left to
  // lineIsClean. Pixels inside a `skip` rect are not read. Returns the strips as `ignore` rects, and as `content`
  // ({ rect, colour }) each stretch between two strips within TOLERANCE of one colour that a line joins in it: a
  // banner's label, whose glyphs may be the ground's colour.
  const STRIP_GRID = 64;
  function acrossStrips(pixels, r, side, lo, hi, bounds, skip, marksBox, through) {
    const none = { ignore: [], content: [] };
    const horizontal = side === 'top' || side === 'bottom';
    const [t0, t1] = horizontal ? [through.y0, through.y1] : [through.x0, through.x1];
    const [a0, a1] = horizontal ? [through.x0, through.x1] : [through.y0, through.y1];
    const [from, to] = horizontal ? [bounds.x0, bounds.x1] : [bounds.y0, bounds.y1];
    const [m0, m1] = !marksBox ? [Infinity, -Infinity] : horizontal ? [marksBox[0], marksBox[0] + marksBox[2]] : [marksBox[1], marksBox[1] + marksBox[3]];
    const inBounds = within(bounds);
    const lines = [];
    for (let o = Math.floor(lo); o <= Math.floor(hi); o += 1) {
      const line = { ...lineAt(r, side, o), from, to };
      if (inBounds(line)) lines.push(line);
    }
    if (lines.length < 2) return none;
    const channels = [[], [], []];
    for (let a = 0; a < STRIP_GRID; a += 1) {
      const line = lines[Math.floor(((a + 0.5) * lines.length) / STRIP_GRID)];
      for (let b = 0; b < STRIP_GRID; b += 1) {
        const i = from + Math.floor(((b + 0.5) * (to - from)) / STRIP_GRID);
        if (skip.length && inRects(skip, line, i)) continue;
        const at = pixelOf(pixels, line, i);
        for (let c = 0; c < 3; c += 1) channels[c].push(pixels.data[at + c]);
      }
    }
    if (!channels[0].length) return none;
    const ground = channels.map((values) => median(values));
    const fixed = lines.map((line) => line.fixed);
    const [f0, f1] = [Math.min(...fixed), Math.max(...fixed) + 1];
    const colourAt = (line, i) => { const at = pixelOf(pixels, line, i); return [0, 1, 2].map((c) => pixels.data[at + c]); };
    const runsAcross = (i, colour) => {
      if (i < a0 || i >= a1) return false;
      const across = { horizontal: !horizontal, fixed: i };
      const holds = (k) => (skip.length && inRects(skip, across, k)) || sameColour(colourAt(across, k), colour, SLIGHT);
      for (let k = f0; k < f1; k += 1) if (!holds(k)) return false;
      let e0 = f0; while (e0 > t0 && holds(e0 - 1)) e0 -= 1;
      let e1 = f1; while (e1 < t1 && holds(e1)) e1 += 1;
      const start = e0 - t0 <= AIR; const end = t1 - e1 <= AIR;
      return (start && (end || e1 - f1 >= WORD_REACH)) || (end && f0 - e0 >= WORD_REACH);
    };
    const strips = [];
    const push = (a, b) => {
      if (b - a > RULE_THICKNESS && (b <= m0 || a >= m1)) strips.push({ a, b });
    };
    let start = null;
    for (let i = from; i <= to; i += 1) {
      let strip = false;
      if (i < to && !(skip.length && inRects(skip, lines[0], i))) {
        const colour = colourAt(lines[0], i);
        strip = colour.some((v, c) => Math.abs(v - ground[c]) > TOLERANCE) && runsAcross(i, colour);
      }
      if (strip && start === null) start = i;
      if (strip && start !== null && i > start && !sameColour(colourAt(lines[0], start), colourAt(lines[0], i), SLIGHT)) {
        push(start, i);
        start = i;
      }
      if (!strip && start !== null) {
        push(start, i);
        start = null;
      }
    }
    const rectOn = (a, b) => (horizontal ? [a, f0, b - a, f1 - f0] : [f0, a, f1 - f0, b - a]);
    // From the strip before `a` to the one at `b`, each pixel within SLIGHT of the one before it, so a block whose
    // colour drifts along the edge still joins them.
    const joins = (line, a, b) => {
      for (let i = a; i <= b; i += 1) if (!sameColour(colourAt(line, i - 1), colourAt(line, i), SLIGHT)) return false;
      return true;
    };
    const content = [];
    for (let n = 1; n < strips.length; n += 1) {
      const [p, q] = [strips[n - 1], strips[n]];
      const colour = colourAt(lines[0], p.b - 1);
      if (p.b < q.a && sameColour(colour, colourAt(lines[0], q.a), TOLERANCE) && lines.some((line) => joins(line, p.b, q.a))) content.push({ rect: rectOn(p.b, q.a), colour });
    }
    return { ignore: strips.map(({ a, b }) => rectOn(a, b)), content };
  }

  // The ground along `box`'s edge on `side`: the median colour of the `depth` lines just inside it, whole pixels
  // in, pixels inside a `skip` rect aside. An edge through text runs through its glyphs, so its own line alone
  // can be more ink than ground. Null for lines made only of skipped pixels.
  function edgeGround(pixels, box, side, skip, depth) {
    const r = { x0: Math.ceil(box[0]), y0: Math.ceil(box[1]), x1: Math.floor(box[0] + box[2]), y1: Math.floor(box[1] + box[3]) };
    const extent = side === 'left' || side === 'right' ? r.x1 - r.x0 : r.y1 - r.y0;
    if (r.x1 <= r.x0 || r.y1 <= r.y0) return null;
    const channels = [[], [], []];
    for (let k = 0; k < Math.min(extent, Math.max(1, Math.round(depth))); k += 1) {
      const line = lineAt(r, side, -k);
      for (let i = line.from; i < line.to; i += 1) {
        if (skip.length && inRects(skip, line, i)) continue;
        const at = pixelOf(pixels, line, i);
        for (let c = 0; c < 3; c += 1) channels[c].push(pixels.data[at + c]);
      }
    }
    return channels[0].length ? channels.map((values) => median(values)) : null;
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
        if (d > 0) {
          // A 2x clean run starts a source pixel later; take that line only where it is in reach.
          let extra = 0;
          while (extra < scale - 1 && d + extra + 1 <= limit - grown[side] && reach(lineAt(r, side, d + extra + 1))) extra += 1;
          shift(side, d + extra); moved = true;
        }
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

  // How far past `side` of `box` a lift reaches to take in whole the line its ring would cut: the offset of that
  // line's last content line, where the first content line is within `reach` lines of the edge and LIFT_BAND clean
  // lines end the line within `tallest` lines of where it starts. 0 when no line lies within reach, or it runs on
  // past `tallest`, or past `options.bounds`.
  function cutLine(pixels, box, side, reach, tallest, options) {
    const opts = options || {};
    const inArea = within(boundsOf(pixels, opts.bounds));
    const ignore = opts.ignore || [];
    const r = rectOf(box, boundsOf(pixels, opts.bounds));
    const clean = (o) => lineIsClean(pixels, lineAt(r, side, o), ignore);
    let first = 0;
    for (let o = 1; o <= reach && !first; o += 1) {
      if (!inArea(lineAt(r, side, o))) return 0;
      if (!clean(o)) first = o;
    }
    if (!first) return 0;
    let run = 0;
    for (let o = first + 1; o < first + tallest + LIFT_BAND; o += 1) {
      if (!inArea(lineAt(r, side, o))) return 0;
      run = clean(o) ? run + 1 : 0;
      if (run >= LIFT_BAND) return o - run;
    }
    return 0;
  }

  // How far a lift's padding may extend on each side: up to `max` pixels, but
  // only over clean lines, and only while the LIFT_CLEAR lines beyond the
  // padding are clean too. The lens resamples the capture, so an unclean
  // neighbour line would bleed a faint sliver of content into the padding's
  // outer edge. A hairline is a clean line, so a padding line must also be the
  // colour of the line HAIR beyond it: the padding ends a line short of a
  // hairline, which then never rides on the card. Running out of image or
  // bounds is not a neighbour. `clear` asks for more clean lines than
  // LIFT_CLEAR past the padding.
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
    const groundBeyond = (side, at) => {
      if (state(side, at + HAIR) === 'outside') return true;
      const own = lineMedian(pixels, lineAt(r, side, at), ignore); const next = lineMedian(pixels, lineAt(r, side, at + HAIR), ignore);
      return !own || !next || sameColour(own, next, SLIGHT);
    };
    return SIDES.map((side) => {
      let pad = 0;
      const spaced = (at) => Array.from({ length: Math.max(LIFT_CLEAR, opts.clear ?? 0) }, (_, n) => state(side, at + 1 + n)).every((s) => s !== 'content');
      while (pad < max && state(side, pad + 1) === 'clean' && spaced(pad + 1) && groundBeyond(side, pad + 1)) pad += 1;
      return pad;
    });
  }

  // Capture px: an outline line this many lines inside a lift's box or fewer is that side's.
  const OUTLINE_REACH = 4 * scale;
  const INWARD = { left: 1, top: 1, right: -1, bottom: -1 };

  // How far in from each side of r an outline is looked for: OUTLINE_REACH
  // lines, or that many inside `element` (the box a lift grew from), whose own
  // outline a lift grown past it still carries.
  const outlineReach = (pixels, r, element) => {
    const e = element ? rectOf(element, boundsOf(pixels, null)) : r;
    const past = { left: e.x0 - r.x0, top: e.y0 - r.y0, right: r.x1 - e.x1, bottom: r.y1 - e.y1 };
    return Object.fromEntries(SIDES.map((side) => [side, OUTLINE_REACH + Math.max(0, past[side])]));
  };

  // The rule (edgeRuleAt) along `side` within `reach` lines inside r, as
  // { depth, thickness }, or null. The line before a rule is another colour, so
  // the inside of a thicker bar, or ground ending on one, is no rule. A side
  // shorter than RULE_LENGTH carries none: a glyph's stem holds half of it.
  function outlineOn(pixels, r, side, reach, ignore) {
    const extent = side === 'left' || side === 'right' ? r.x1 - r.x0 : r.y1 - r.y0;
    const length = side === 'left' || side === 'right' ? r.y1 - r.y0 : r.x1 - r.x0;
    if (length < RULE_LENGTH) return null;
    for (let depth = 0; depth < Math.min(reach, extent); depth += 1) {
      const before = lineAt(r, side, 1 - depth);
      const ground = lineInImage(pixels, before) ? lineMedian(pixels, before, ignore) : null;
      const found = edgeRuleAt(pixels, lineAt(r, side, -depth), { step: INWARD[side], ground, ignore });
      if (found) return { depth, thickness: found.thickness, colour: found.colour };
    }
    return null;
  }

  // The box with each of `sides` moved in past its outline (outlineOn, within
  // outlineReach) to the first line beyond that is one colour (within SLIGHT) to
  // its ends, so a corner's arc, its faint antialiased edge, or a line that
  // crosses past the outline goes too. Lines are tested again after any side
  // moved, since each side's line spans the others. Null when the sides meet
  // before such a line.
  function pastOutline(pixels, box, sides, options) {
    const opts = options || {}; const ignore = opts.ignore || [];
    const r = rectOf(box, boundsOf(pixels, null));
    const reach = outlineReach(pixels, r, opts.element);
    const moves = sides.flatMap((side) => {
      const rule = outlineOn(pixels, r, side, reach[side], ignore);
      return rule ? [[side, rule]] : [];
    });
    const moveIn = (side, d) => { if (side === 'left') r.x0 += d; else if (side === 'top') r.y0 += d; else if (side === 'right') r.x1 -= d; else r.y1 -= d; };
    for (const [side, { depth, thickness }] of moves) moveIn(side, depth + thickness);
    const open = () => r.x1 > r.x0 && r.y1 > r.y0;
    const bare = (line) => {
      const colour = lineMedian(pixels, line, ignore);
      return !colour || lineIs(pixels, line, colour, SLIGHT, true, ignore);
    };
    for (let moved = true; moved && open();) {
      moved = false;
      for (const [side] of moves) {
        while (open() && !bare(lineAt(r, side, 0))) { moveIn(side, 1); moved = true; }
      }
    }
    if (!open()) return null;
    const on = new Set(moves.map(([side]) => side));
    const x0 = on.has('left') ? r.x0 : box[0]; const y0 = on.has('top') ? r.y0 : box[1];
    const x1 = on.has('right') ? r.x1 : box[0] + box[2]; const y1 = on.has('bottom') ? r.y1 : box[1] + box[3];
    return [x0, y0, x1 - x0, y1 - y0];
  }

  // The outline a lift drops: rules on some of its sides (outlineOn), a
  // vertical and a horizontal one among them, since a rule on one side or on
  // two facing sides is a divider, an underline or the long sides of an
  // outline whose short ones are too short to tell; not all four, since a
  // whole outline is the element's own card; and all of one colour (within
  // TOLERANCE), since an accent bar beside a rule of another colour is a
  // design. Returns the box inside it (pastOutline) and, per outlined side,
  // the rule's colour and the ground of the line that box ends on; or null.
  function droppedOutline(pixels, box, options) {
    const opts = options || {}; const ignore = opts.ignore || [];
    const r = rectOf(box, boundsOf(pixels, null));
    const reach = outlineReach(pixels, r, opts.element);
    const rules = Object.fromEntries(SIDES.flatMap((side) => {
      const rule = outlineOn(pixels, r, side, reach[side], ignore);
      return rule ? [[side, rule]] : [];
    }));
    const sides = Object.keys(rules);
    const corner = (rules.left || rules.right) && (rules.top || rules.bottom);
    if (!corner || sides.length === SIDES.length) return null;
    if (!sides.every((side) => sameColour(rules[side].colour, rules[sides[0]].colour, TOLERANCE))) return null;
    const inner = pastOutline(pixels, box, sides, opts);
    if (!inner) return null;
    const ir = rectOf(inner, boundsOf(pixels, null));
    // The lines the rule lies on: columns for an upright side, rows for a level one, [from, to).
    const linesOf = (side, { depth, thickness }) => {
      const near = { left: r.x0 + depth, top: r.y0 + depth, right: r.x1 - depth - thickness, bottom: r.y1 - depth - thickness }[side];
      return [near, near + thickness];
    };
    const outlined = Object.fromEntries(sides.map((side) => [side, { colour: rules[side].colour, ground: lineMedian(pixels, lineAt(ir, side, 0), ignore), lines: linesOf(side, rules[side]) }]));
    return Object.values(outlined).every((side) => side.ground) ? { box: inner, sides: outlined } : null;
  }

  // A pixel that is `ground`, `colour` or a blend of the two: within SLIGHT on
  // every channel of the nearest point between them. A rule's antialiased edge
  // is such a blend; a glyph's is not, being another hue.
  function onRule(data, at, ground, colour) {
    const d = [0, 1, 2].map((c) => colour[c] - ground[c]);
    const p = [0, 1, 2].map((c) => data[at + c] - ground[c]);
    const span = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    const t = span ? Math.min(1, Math.max(0, (p[0] * d[0] + p[1] * d[1] + p[2] * d[2]) / span)) : 0;
    return [0, 1, 2].every((c) => Math.abs(p[c] - t * d[c]) <= SLIGHT);
  }

  // Capture px: how far from where two of its lines cross an outline's rounded corner reaches.
  const ARC = 12 * scale;

  // Where a card that drops `dropped` (droppedOutline) over the footprint
  // `rect` draws ground in place of the outline: per outlined side, the band
  // from `rect`'s edge to the box inside the outline, along the side only as
  // far as `element` reaches on a side the outline leaves open, so the page
  // beyond an open side is never painted. A pixel off the ground there is the
  // outline's only when it is on the rule (onRule) and lies on a line of it:
  // an outlined side's own rule, or a rule (edgeRuleAt) that runs the length
  // or the breadth of a band, or of its part outside the outline, as a
  // divider beside it or the flare of its foot into a baseline does; or
  // within ARC of where an upright and a level such line cross, as a corner's
  // arc does. Any other pixel off the ground, a pin, a grip or a
  // badge of whatever colour, outside `ignore`, gives the cover up: null.
  function coverBands(pixels, dropped, rect, element, ignore) {
    const R = rectOf(rect, boundsOf(pixels, null)); const E = rectOf(element, boundsOf(pixels, null));
    const I = rectOf(dropped.box, boundsOf(pixels, null));
    const open = (side) => !dropped.sides[side];
    const y0 = open('top') ? Math.max(R.y0, E.y0) : R.y0; const y1 = open('bottom') ? Math.min(R.y1, E.y1) : R.y1;
    const x0 = open('left') ? Math.max(R.x0, E.x0) : R.x0; const x1 = open('right') ? Math.min(R.x1, E.x1) : R.x1;
    const spans = { left: [R.x0, y0, I.x0, y1], top: [x0, R.y0, x1, I.y0], right: [I.x1, y0, R.x1, y1], bottom: [x0, I.y1, x1, R.y1] };
    const bands = Object.entries(dropped.sides).flatMap(([side, { colour, ground, lines }]) => {
      const [bx0, by0, bx1, by1] = spans[side];
      if (bx1 <= bx0 || by1 <= by0) return [];
      const outside = { left: [bx0, by0, lines[0], by1], top: [bx0, by0, bx1, lines[0]], right: [lines[1], by0, bx1, by1], bottom: [bx0, lines[1], bx1, by1] }[side];
      return [{ rect: [bx0, by0, bx1 - bx0, by1 - by0], outside, ground, colour }];
    });
    const columns = new Set(); const rows = new Set();
    const add = (set, [from, to]) => { for (let at = from; at < to; at += 1) set.add(at); };
    for (const [side, { lines }] of Object.entries(dropped.sides)) add(side === 'left' || side === 'right' ? columns : rows, lines);
    // A line the colour of the one before it is the inside of a thicker bar, as in outlineOn.
    const scan = (set, line, count, ground) => {
      for (let k = 0; k < count; k += 1) {
        const at = { ...line, fixed: line.fixed + k };
        const before = k ? lineMedian(pixels, { ...line, fixed: line.fixed + k - 1 }, ignore) : ground;
        const found = edgeRuleAt(pixels, at, { step: 1, ground: before, ignore });
        if (found) { add(set, [at.fixed, at.fixed + found.thickness]); k += found.thickness - 1; }
      }
    };
    const scanAcross = ([ax0, ay0, ax1, ay1], ground) => {
      if (ax1 <= ax0 || ay1 <= ay0) return;
      scan(columns, { horizontal: false, fixed: ax0, from: ay0, to: ay1 }, ax1 - ax0, ground);
      scan(rows, { horizontal: true, fixed: ay0, from: ax0, to: ax1 }, ay1 - ay0, ground);
    };
    for (const { rect: [bx, by, bw, bh], outside, ground } of bands) {
      scanAcross([bx, by, bx + bw, by + bh], ground);
      scanAcross(outside, ground);
    }
    const near = (set, at) => { for (let d = 0; d <= ARC; d += 1) if (set.has(at - d) || set.has(at + d)) return true; return false; };
    const onLine = (x, y) => columns.has(x) || rows.has(y) || (near(columns, x) && near(rows, y));
    for (const { rect: [bx, by, bw, bh], ground, colour } of bands) {
      for (let y = by; y < by + bh; y += 1) {
        for (let x = bx; x < bx + bw; x += 1) {
          if (ignore.some((f) => inRect(f, x, y))) continue;
          const at = (y * pixels.width + x) * 4;
          if (sameColour([pixels.data[at], pixels.data[at + 1], pixels.data[at + 2]], ground, SLIGHT)) continue;
          if (!onRule(pixels.data, at, ground, colour) || !onLine(x, y)) return null;
        }
      }
    }
    return bands.map(({ rect, ground, colour }) => ({ rect, ground, colour }));
  }

  // A 2x capture resolves the half px of a glyph's edge that its 1x twin rounds
  // out to a whole one, so a rule that looks for where ink begins would find
  // two boxes. At a whole device scale tightenBox, adoptLeading, contentUnder, trimBlank,
  // edgeSliver and edgeAir read the capture averaged down to CSS px and apply as at 1x. `cssView` is that
  // picture of the box and `reach` CSS px around it (what the rules read beyond
  // a box), cut off where the image ends, with the maps into it and back.
  const CSS_VIEW = Number.isInteger(scale) && scale > 1;
  let one = null;
  const atOne = () => { one = one || build(1); return one; };
  function cssView(pixels, box, reach) {
    const x0 = Math.max(0, Math.floor(box[0] / scale) - reach.left); const y0 = Math.max(0, Math.floor(box[1] / scale) - reach.top);
    const width = Math.min(Math.floor(pixels.width / scale), Math.ceil((box[0] + box[2]) / scale) + reach.right) - x0;
    const height = Math.min(Math.floor(pixels.height / scale), Math.ceil((box[1] + box[3]) / scale) + reach.bottom) - y0;
    const data = new Uint8ClampedArray(Math.max(0, width) * Math.max(0, height) * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        for (let c = 0; c < 4; c += 1) {
          let sum = 0;
          for (let dy = 0; dy < scale; dy += 1) for (let dx = 0; dx < scale; dx += 1) sum += pixels.data[(((y0 + y) * scale + dy) * pixels.width + (x0 + x) * scale + dx) * 4 + c];
          data[(y * width + x) * 4 + c] = Math.round(sum / (scale * scale));
        }
      }
    }
    return {
      pixels: { data, width: Math.max(0, width), height: Math.max(0, height) },
      to: (b) => [b[0] / scale - x0, b[1] / scale - y0, b[2] / scale, b[3] / scale],
      from: (b) => [(b[0] + x0) * scale, (b[1] + y0) * scale, b[2] * scale, b[3] * scale],
    };
  }
  // CSS px. tightenBox reads RULE_THICKNESS + 1 lines beyond a box at 1x.
  const TIGHT_VIEW = 4;
  const NO_REACH = { left: 0, top: 0, right: 0, bottom: 0 };

  const TIGHT_MIN = 4 * scale;
  const NEXT_TO = { left: ['top', 'bottom'], right: ['top', 'bottom'], top: ['left', 'right'], bottom: ['left', 'right'] };

  // A box given by an element can be far larger than what it shows (a block
  // spans its container) and can carry a divider that belongs to the list, not
  // to the row. A flat line is one colour: every pixel within SLIGHT of its
  // median. Each side reads its flat lines from the edge inward as runs of one
  // colour. A run is ground when its colour is also the colour of the line just
  // outside the box (or of the line beyond a rule lying there), so the ground is
  // never guessed from a line that cuts a glyph, and an element's own
  // background, which ends at the box, keeps its padding. A side moves in over
  // its ground run. A first run of RULE_THICKNESS lines or fewer with ground
  // behind it is a rule: dropped with that ground when no rule on a
  // neighbouring side joins it (a divider), kept when one does (a border). A
  // wider run of another colour is a border or a block and stays. A side the
  // image ends at has no line outside: it takes the ground another side found.
  // Content that runs on past an edge (the edge line is not flat, nor clean for
  // 2 * HAIR lines beyond it: a glyph's overhang is less) means the box will
  // grow that way over rows or columns it does not hold yet, so the two sides
  // beside that edge stay: tightened to the part inside, they would hug a solid
  // bar so closely that the cut through it reads as a clean line.
  // `options.ignore` rectangles (redaction fills as drawn) are not read: a line
  // made only of their pixels says nothing, and goes with the run it lies in or
  // before. No side moves in past an `options.keep` box (a redaction's fill,
  // inside the box it was captured with) that reaches a CSS px into the box on
  // both axes: a fill is not ground, and one over the end of a lift stays in it.
  function tightenBox(pixels, box, options) {
    const opts = options || {}; const keep = opts.keep || []; const ignore = opts.ignore || [];
    const kept = { box: box.slice(), moved: { left: 0, top: 0, right: 0, bottom: 0 } };
    if (CSS_VIEW) {
      const view = cssView(pixels, box, { left: TIGHT_VIEW, top: TIGHT_VIEW, right: TIGHT_VIEW, bottom: TIGHT_VIEW });
      const found = atOne().tightenBox(view.pixels, view.to(box), { keep: keep.map(view.to), ignore: ignore.map(view.to) });
      const moved = Object.fromEntries(SIDES.map((side) => [side, found.moved[side] * scale]));
      if (SIDES.every((side) => moved[side] === 0)) return kept;
      const [x, y, w, h] = view.from(found.box);
      const x0 = moved.left ? x : box[0]; const y0 = moved.top ? y : box[1];
      const x1 = moved.right ? x + w : box[0] + box[2]; const y1 = moved.bottom ? y + h : box[1] + box[3];
      return { box: [x0, y0, x1 - x0, y1 - y0], moved };
    }
    const r = rectOf(box, boundsOf(pixels, null));
    const extent = { left: r.x1 - r.x0, right: r.x1 - r.x0, top: r.y1 - r.y0, bottom: r.y1 - r.y0 };
    if (extent.left < TIGHT_MIN || extent.top < TIGHT_MIN) return kept;
    const runsOf = (side) => {
      const runs = []; let unread = 0;
      for (let depth = 0; depth < extent[side]; depth += 1) {
        const line = lineAt(r, side, -depth);
        const colour = lineMedian(pixels, line, ignore);
        if (!colour) { unread += 1; continue; }
        if (!lineIs(pixels, line, colour, SLIGHT, false, ignore)) break;
        const last = runs[runs.length - 1];
        if (last && sameColour(last.colour, colour, SLIGHT)) last.count += unread + 1;
        else if (runs.length === 2) break;
        else if (last) { last.count += unread; runs.push({ colour, count: 1 }); } else runs.push({ colour, count: unread + 1 });
        unread = 0;
      }
      return runs;
    };
    // Null where the image ends at the side, or an ignored rectangle covers the line outside it.
    const continues = (side, colour) => {
      for (let k = 1; k <= RULE_THICKNESS + 1; k += 1) {
        const line = lineAt(r, side, k);
        const beside = lineInImage(pixels, line) ? lineMedian(pixels, line, ignore) : null;
        if (!beside) return k === 1 ? null : false;
        if (sameColour(beside, colour, SLIGHT)) return true;
        if (!lineIs(pixels, line, beside, SLIGHT, false, ignore)) return false;
      }
      return false;
    };
    const runsOn = (side) => Array.from({ length: 2 * HAIR }, (_, n) => lineAt(r, side, n + 1)).every((line) => lineInImage(pixels, line) && !lineIsClean(pixels, line, ignore));
    const scan = Object.fromEntries(SIDES.map((side) => {
      const [lead, next] = runsOf(side);
      if (!lead) return [side, { rule: 0, blank: 0, open: false, crossed: runsOn(side) }];
      const open = continues(side, lead.colour);
      if (open !== false) return [side, { rule: 0, blank: lead.count, ground: lead.colour, open }];
      if (lead.count > RULE_THICKNESS) return [side, { rule: 0, blank: 0, open: false }];
      if (next && continues(side, next.colour)) return [side, { rule: lead.count, blank: next.count, ground: next.colour, open: true }];
      return [side, { rule: lead.count, blank: 0, open: false }];
    }));
    const grounds = SIDES.filter((side) => scan[side].open).map((side) => scan[side].ground);
    const open = (side) => scan[side].open ?? grounds.some((ground) => sameColour(ground, scan[side].ground, SLIGHT));
    const ruled = (side) => scan[side].rule > 0;
    const reaches = (k) => Math.min(k[0] + k[2], r.x1) - Math.max(k[0], r.x0) >= HAIR && Math.min(k[1] + k[3], r.y1) - Math.max(k[1], r.y0) >= HAIR;
    const held = keep.filter(reaches).map((k) => rectOf(k, r));
    const room = {
      left: Math.min(...held.map((k) => k.x0 - r.x0)), top: Math.min(...held.map((k) => k.y0 - r.y0)),
      right: Math.min(...held.map((k) => r.x1 - k.x1)), bottom: Math.min(...held.map((k) => r.y1 - k.y1)),
    };
    const moved = Object.fromEntries(SIDES.map((side) => {
      const { rule, blank } = scan[side];
      const stays = NEXT_TO[side].some((beside) => scan[beside].crossed || (rule > 0 && ruled(beside)));
      return [side, open(side) && !stays ? Math.min(rule + blank, room[side]) : 0];
    }));
    if (extent.left - moved.left - moved.right < TIGHT_MIN || extent.top - moved.top - moved.bottom < TIGHT_MIN || SIDES.every((side) => moved[side] === 0)) return kept;
    // A side that stays keeps the coordinate it was given, fraction and all.
    const x0 = moved.left ? r.x0 + moved.left : box[0]; const y0 = moved.top ? r.y0 + moved.top : box[1];
    const x1 = moved.right ? r.x1 - moved.right : box[0] + box[2]; const y1 = moved.bottom ? r.y1 - moved.bottom : box[1] + box[3];
    return { box: [x0, y0, x1 - x0, y1 - y0], moved };
  }

  const ADOPT_GAP_MIN = 5 * scale;
  const ADOPT_GAP_MAX = 12 * scale;
  const ADOPT_MAX = 28 * scale;
  // CSS px. adoptLeading reads at most its gap, its icon, then the gap and LIFT_BAND again left of a box at 1x.
  const ADOPT_VIEW = 64;

  // A tick or icon that leads a line is part of the line, but the element that
  // holds the words does not hold it. Left of the box: ground for
  // ADOPT_GAP_MIN to ADOPT_GAP_MAX px (a word space is narrower), then at most
  // ADOPT_MAX px of something, then ground again for LIFT_BAND px more than
  // that gap (a short word in large type stands a word space from the word
  // before it too), and none of it reaching above or below the rows it may
  // stand in. Those are the box's own rows, or with `options.element` the rows
  // of the element the box was tightened from: an icon is as tall as its line,
  // and words without a descender are not. Ground is the colour of the column
  // beside the box, since a solid icon is a clean column too. Returns the box
  // grown to take the icon in, or unchanged.
  function adoptLeading(pixels, box, options) {
    const opts = options || {};
    if (CSS_VIEW) {
      const tall = opts.element ? union([box, opts.element]) : box;
      const view = cssView(pixels, [box[0], tall[1], box[2], tall[3]], { left: ADOPT_VIEW, top: 1, right: 0, bottom: 1 });
      const mapped = { bounds: view.to(opts.bounds || [0, 0, pixels.width, pixels.height]), element: opts.element && view.to(opts.element), avoid: (opts.avoid || []).map(view.to), ignore: (opts.ignore || []).map(view.to) };
      const found = atOne().adoptLeading(view.pixels, view.to(box), mapped);
      return found[0] < view.to(box)[0] ? view.from(found) : box.slice();
    }
    const bounds = boundsOf(pixels, opts.bounds); const ignore = opts.ignore || []; const avoid = opts.avoid || [];
    const r = rectOf(box, bounds);
    if (r.x1 <= r.x0 || r.y1 <= r.y0 || r.x0 - 1 < bounds.x0) return box.slice();
    const tall = opts.element ? rectOf(opts.element, bounds) : r;
    const y0 = Math.min(r.y0, tall.y0); const y1 = Math.max(r.y1, tall.y1);
    const ground = lineMedian(pixels, { horizontal: false, fixed: r.x0 - 1, from: y0, to: y1 });
    const isGround = (line) => lineIsClean(pixels, line, ignore) && sameColour(lineMedian(pixels, line), ground, TOLERANCE);
    const blank = (x) => isGround({ horizontal: false, fixed: x, from: y0, to: y1 });
    let x = r.x0 - 1; let gap = 0;
    while (x >= bounds.x0 && gap <= ADOPT_GAP_MAX && blank(x)) { x -= 1; gap += 1; }
    if (x < bounds.x0 || gap < ADOPT_GAP_MIN || gap > ADOPT_GAP_MAX) return box.slice();
    const end = x + 1; let width = 0;
    while (x >= bounds.x0 && width <= ADOPT_MAX && !blank(x)) { x -= 1; width += 1; }
    if (x < bounds.x0 || width > ADOPT_MAX) return box.slice();
    for (let k = 0; k < gap + LIFT_BAND; k += 1) if (x - k >= bounds.x0 && !blank(x - k)) return box.slice();
    const x0 = x + 1;
    const row = (y) => ({ horizontal: true, fixed: y, from: x0, to: end });
    for (const y of [y0 - 1, y1]) if (y >= bounds.y0 && y < bounds.y1 && !isGround(row(y))) return box.slice();
    const inked = (y) => !lineIs(pixels, row(y), ground, TOLERANCE, true);
    let top = y0; while (top < r.y0 && !inked(top)) top += 1;
    let bottom = y1; while (bottom > r.y1 && !inked(bottom - 1)) bottom -= 1;
    if (avoid.some((a) => hits(a, [x0, top, r.x0 - x0, bottom - top]))) return box.slice();
    const upper = Math.min(box[1], top);
    return [x0, upper, box[0] + box[2] - x0, Math.max(box[1] + box[3], bottom) - upper];
  }

  // The rows of `rect` ([x0, y0, x1, y1]) that are a horizontal rule the rect
  // merely crosses: at most RULE_THICKNESS rows of one colour, which holds from
  // RULE_LENGTH left of the rect to RULE_LENGTH right of it (or to `bounds`),
  // between rows that are not that colour. A dash or the bar of a letter is
  // shorter than that, and a block is thicker. With `upright`, the columns that
  // are a vertical rule, by the same test turned a quarter.
  function rulesAcross(pixels, rect, bounds, upright) {
    const area = boundsOf(pixels, bounds);
    const [low, high, start, stop] = upright ? [area.y0, area.y1, area.x0, area.x1] : [area.x0, area.x1, area.y0, area.y1];
    const from = Math.max(low, rect[upright ? 1 : 0] - RULE_LENGTH); const to = Math.min(high, rect[upright ? 3 : 2] + RULE_LENGTH);
    const flat = new Map();
    const colourOf = (at) => {
      if (at < start || at >= stop || to <= from) return null;
      if (!flat.has(at)) {
        const line = { horizontal: !upright, fixed: at, from, to };
        const colour = lineMedian(pixels, line);
        flat.set(at, lineIs(pixels, line, colour, SLIGHT, true) ? colour : null);
      }
      return flat.get(at);
    };
    const is = (at, colour) => { const other = colourOf(at); return Boolean(other) && sameColour(other, colour, SLIGHT); };
    const found = new Set();
    for (let at = Math.max(start, rect[upright ? 0 : 1]); at < Math.min(stop, rect[upright ? 2 : 3]); at += 1) {
      const colour = colourOf(at);
      if (!colour) continue;
      let first = at; let last = at;
      while (last - first < RULE_THICKNESS && is(first - 1, colour)) first -= 1;
      while (last - first < RULE_THICKNESS && is(last + 1, colour)) last += 1;
      if (last - first < RULE_THICKNESS) found.add(at);
    }
    return found;
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
  // px, the frame in capture px; S board px per capture px. `clear` is capture
  // px. Where a card's edge falls within a CSS px, a 2x capture sees which half
  // and its 1x twin does not: at a whole device scale the count is taken on
  // the capture averaged down to CSS px, each as scale squared capture pixels.
  // `exact` counts a pixel the rect only partly covers by the part it covers,
  // so two rects that hide the same area count the same wherever their edges fall.
  const frameViews = new WeakMap();
  const frameView = (pixels, frame) => {
    if (!frameViews.has(pixels)) frameViews.set(pixels, new Map());
    const views = frameViews.get(pixels); const key = frame.join(',');
    if (!views.has(key)) views.set(key, cssView(pixels, frame, NO_REACH));
    return views.get(key);
  };
  function contentUnder(pixels, frame, S, element, clear, exact = false) {
    if (CSS_VIEW) {
      let under = null;
      return (card) => {
        if (!under) {
          const view = frameView(pixels, frame);
          under = atOne().contentUnder(view.pixels, view.to(frame), S * scale, element, clear == null ? clear : clear / scale, exact);
        }
        return under(card) * scale * scale;
      };
    }
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
    const at = (px, py) => sums[(py - area.y0) * (width + 1) + px - area.x0];
    // The summed counts are bilinear between whole pixels, so this reads them at a fractional corner exactly.
    const atFraction = (px, py) => {
      const ix = Math.min(Math.floor(px), area.x1 - 1); const iy = Math.min(Math.floor(py), area.y1 - 1);
      const fx = px - ix; const fy = py - iy;
      return (1 - fx) * (1 - fy) * at(ix, iy) + fx * (1 - fy) * at(ix + 1, iy) + (1 - fx) * fy * at(ix, iy + 1) + fx * fy * at(ix + 1, iy + 1);
    };
    const countIn = ([x0, y0, x1, y1]) => {
      if (x1 <= x0 || y1 <= y0) return 0;
      const read = exact ? atFraction : at;
      return read(x1, y1) - read(x0, y1) - read(x1, y0) + read(x0, y0);
    };
    const rectOfCard = (x, y, w, h) => {
      const [x0, x1] = span(frame[0] + x / S, frame[0] + (x + w) / S, area.x0, area.x1);
      const [y0, y1] = span(frame[1] + y / S, frame[1] + (y + h) / S, area.y0, area.y1);
      return [x0, y0, x1, y1];
    };
    const clampTo = (value, low, high) => Math.min(high, Math.max(low, value));
    const fineOfCard = (x, y, w, h) => [clampTo(frame[0] + x / S, area.x0, area.x1), clampTo(frame[1] + y / S, area.y0, area.y1),
      clampTo(frame[0] + (x + w) / S, area.x0, area.x1), clampTo(frame[1] + (y + h) / S, area.y0, area.y1)];
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
    const near = LIFT_RING + (clear ?? LIFT_CLEAR) * S;
    return (card) => {
      if (!sums) build();
      const [x, y, w, h] = [card[0] - near, card[1] - near, card[2] + 2 * near, card[3] + 2 * near];
      const [ex, ey, ew, eh] = element;
      const ix = Math.max(x, ex); const iy = Math.max(y, ey);
      const iw = Math.min(x + w, ex + ew) - ix; const ih = Math.min(y + h, ey + eh) - iy;
      const region = rectOfCard(x, y, w, h);
      if (region[2] <= region[0] || region[3] <= region[1]) return 0;
      const rules = down ? rulesIn(region) : [];
      const of = exact ? fineOfCard : rectOfCard;
      return contentIn(of(x, y, w, h), rules) - (iw > 0 && ih > 0 ? contentIn(of(ix, iy, iw, ih), rules) : 0);
    };
  }

  // A card keeps its ring and 2 board px inside the frame's edge.
  const LIFT_EDGE = LIFT_RING + 2;
  // Board px a card keeps from the frame's right and bottom edges while its
  // element allows: a dot and its clear space.
  const DOT_ROOM = 16;

  // Capture px: what float error leaves between two equal exact counts.
  const FACE_SLACK = 1e-6;

  // Where a card of `size` [W, H] sits for `element`, in a frame `room` [cw, ch]
  // board px: the position that hides the least by `ranks` (contentUnder
  // counts, or one), compared in order so a later one only parts positions the
  // earlier ones tie, looked for in whole board px along each axis between the
  // two ends that still cover the element, and those ends. A tie goes to the
  // position nearest the centred one, then to the lower. An axis on which the
  // card is no larger than the element stays centred. `face`, when given,
  // counts what the card itself hides: no position hides more by it than the
  // centred one, so a card that cannot clear a row never takes it whole to
  // move another out of its margin. `clamped` says the frame cut short what
  // the rule wanted on either axis; giving up the dot's room is not a clamp.
  function liftSpot(ranks, room, element, size, face) {
    const measures = [].concat(ranks);
    const axis = (start, extent, card, limit) => {
      const centred = start + extent / 2 - card / 2;
      const floor = LIFT_EDGE; const ceil = limit - card - LIFT_EDGE;
      const held = Math.min(Math.max(centred, floor), ceil);
      if (card <= extent) return { pinned: held, spots: [held], cut: () => held !== centred };
      const ideal = [start + extent - card, start];
      const lo = Math.max(ideal[0], floor); const hard = Math.min(ideal[1], ceil);
      if (lo > hard) return { pinned: held, spots: [held], cut: () => true };
      const roomy = limit - card - DOT_ROOM;
      // The dot's room is kept only where it leaves the card a board px to move: a card held to less has an
      // element that sits where the room ends, which a 2x capture and its 1x twin measure a fraction apart.
      const hi = roomy >= lo + 1 ? Math.min(hard, roomy) : hard;
      const pinned = Math.min(Math.max(centred, lo), hi);
      const spots = new Set([lo, hi, pinned]);
      for (let at = Math.ceil(lo); at <= hi; at += 1) spots.add(at);
      return { pinned, spots: [...spots].sort((a, b) => a - b), cut: (at) => (lo > ideal[0] && at === lo) || (hard < ideal[1] && at === hard) };
    };
    const across = axis(element[0], element[2], size[0], room[0]);
    const down = axis(element[1], element[3], size[1], room[1]);
    let best = null;
    const most = face && face([across.pinned, down.pinned, size[0], size[1]]);
    const consider = (L, T) => {
      if (face && face([L, T, size[0], size[1]]) > most + FACE_SLACK) return false;
      const spent = [];
      const rank = (n) => (spent[n] ??= measures[n]([L, T, size[0], size[1]]));
      const away = (L - across.pinned) ** 2 + (T - down.pinned) ** 2;
      let order = 0;
      for (let n = 0; best && n < measures.length && !order; n += 1) order = Math.sign(rank(n) - best.rank(n));
      if (!best || order < 0 || (!order && away < best.away)) best = { L, T, rank, away };
      return away === 0 && measures.every((_, n) => rank(n) === 0);
    };
    if (!consider(across.pinned, down.pinned)) {
      for (const L of across.spots) for (const T of down.spots) consider(L, T);
    }
    return { L: best.L, T: best.T, clamped: across.cut(best.L) || down.cut(best.T) };
  }

  // Capture pixels: the crop margins, the margin above a link, the least an
  // edge that looks inward leaves to the marks, the smallest crop, the margin
  // along a bracket's rows, and how much ground a trimmed frame keeps outside
  // its first content.
  const CROP_MARGIN_X = 64 * scale;
  const CROP_MARGIN_Y = 48 * scale;
  const CROP_MARGIN_LINK = 96 * scale;
  const CROP_MARGIN_MIN = 24 * scale;
  const CROP_MARGIN_TIGHT = 16 * scale;
  const CROP_MIN_W = 320 * scale;
  const CROP_MIN_H = 200 * scale;
  const TRIM_PAD = 12 * scale;
  const CROP_SNAP = 80 * scale;
  // A snapped edge sits on the first clean line past the content, which reads
  // as text cut off at the border. It backs away until this many clean lines
  // lie inside it.
  const CROP_AIR = 12 * scale;

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
  // CROP_MIN_W by CROP_MIN_H when `floor` is set and at least `min` ([w, h])
  // when that is given, inside `edge`. A bracket's rows run top to bottom, so
  // when every part bounding the top (or bottom) of the marks is a bracket,
  // that edge takes CROP_MARGIN_TIGHT instead of CROP_MARGIN_Y. A top that is
  // not tight takes CROP_MARGIN_LINK when a part is a link's. `atEdge` names
  // the sides that sit on the edge.
  function cropMargins(edge, marksBox, parts, floor, min) {
    const [minW, minH] = [floor ? CROP_MIN_W : 0, floor ? CROP_MIN_H : 0].map((least, k) => Math.max(least, min ? min[k] : 0));
    const bounding = (key, pick) => {
      const ends = parts.map((part) => key(part.box));
      const extreme = pick(...ends);
      return parts.filter((part) => key(part.box) === extreme).every((part) => part.bracket);
    };
    const tightTop = parts.length > 0 && bounding((b) => b[1], Math.min);
    const tightBottom = parts.length > 0 && bounding((b) => b[1] + b[3], Math.max);
    const top = tightTop ? CROP_MARGIN_TIGHT : parts.some((part) => part.link) ? CROP_MARGIN_LINK : CROP_MARGIN_Y;
    const [x0, x1] = growSpan(
      Math.max(edge.x0, Math.floor(marksBox[0] - CROP_MARGIN_X)), Math.min(edge.x1, Math.ceil(marksBox[0] + marksBox[2] + CROP_MARGIN_X)),
      minW, edge.x0, edge.x1,
    );
    const [y0, y1] = growSpan(
      Math.max(edge.y0, Math.floor(marksBox[1] - top)), Math.min(edge.y1, Math.ceil(marksBox[1] + marksBox[3] + (tightBottom ? CROP_MARGIN_TIGHT : CROP_MARGIN_Y))),
      minH, edge.y0, edge.y1,
    );
    if (x1 <= x0 || y1 <= y0) return null;
    const rect = { x0, y0, x1, y1 };
    return { rect, atEdge: { left: x0 === edge.x0, top: y0 === edge.y0, right: x1 === edge.x1, bottom: y1 === edge.y1 } };
  }

  // Each edge of `rect` that is off the frame and cuts content snaps to a clean
  // band: inward when one starts no further in than the nearest one outward and
  // leaves CROP_MARGIN_MIN to `marksBox`, landing FRAME_CUSHION inside it as a
  // frame edge does, and outward otherwise. The inward look runs twice, since
  // an edge that moved changes the lines the others span. An
  // edge that finds no band goes to the frame's own edge on that side, since a
  // crop edge through content is worse than a wider crop, or with `hold` settles
  // in a word space near its margin (wordGap, reported in `word`) or stays at its
  // margin and is reported `held`, since on a dense page the frame's edge
  // is no cleaner and the crop would swell to the whole page; the other edges
  // are then tested again on the new crop until none moves. A snapped edge then
  // backs away from content until CROP_AIR clean lines lie inside it, stopping
  // at the first unclean line or the frame.
  function snapCrop(pixels, frame, edge, rect, hold, marksBox, through) {
    const start = { ...rect };
    const toMarks = (side, from = start) => {
      if (side === 'left') return marksBox[0] - from.x0;
      if (side === 'top') return marksBox[1] - from.y0;
      if (side === 'right') return from.x1 - (marksBox[0] + marksBox[2]);
      return from.y1 - (marksBox[1] + marksBox[3]);
    };
    // Strips count only for the word step: a band snap reaching CROP_SNAP out reads plain lines, so a sidebar never
    // pulls a crop further out than a word space may.
    const strips = Object.fromEntries(SIDES.map((side) => [side, acrossStrips(pixels, rect, side, -pastMarks(rect, side, marksBox), WORD_REACH, edge, [], marksBox, through)]));
    for (let pass = 0; pass < 2; pass += 1) {
      for (const side of SIDES) {
        const key = KEY_OF[side];
        if (start[key] === edge[key] || edgeIsClean(pixels, [start.x0, start.y0, start.x1 - start.x0, start.y1 - start.y0], side, frame)) continue;
        const most = Math.floor(toMarks(side) - CROP_MARGIN_MIN);
        let run = 0; let inward = 0;
        for (let d = 1; d <= most && !inward; d += 1) {
          run = lineIsClean(pixels, lineAt(start, side, -d), []) ? run + 1 : 0;
          if (run >= BAND) inward = d - run + 1 + FRAME_CUSHION;
        }
        const outward = findBand(pixels, start, side, CROP_SNAP, within(edge), []);
        if (inward && (!outward || inward <= outward)) start[key] += side === 'left' || side === 'top' ? inward : -inward;
      }
    }
    const [gx, gy, gw, gh] = growBox(pixels, [start.x0, start.y0, start.x1 - start.x0, start.y1 - start.y0], CROP_SNAP, { bounds: frame }).box;
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
    // others are tested again until none moves. Each edge moves at most twice
    // (to the frame; or to a word space once and back to its margin), so this ends.
    const fellBack = {}; const held = {}; const word = {}; const looked = {};
    for (let moved = true; moved;) {
      moved = false;
      const current = [r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0];
      for (const side of SIDES) {
        const key = KEY_OF[side];
        if (r[key] === edge[key] || (word[side] ? edgeInGap(pixels, current, side, frame, strips[side].ignore, strips[side].content) : edgeIsClean(pixels, current, side, frame))) continue;
        if (hold && !looked[side]) {
          looked[side] = true;
          const margin = { ...r, [key]: rect[key] };
          const at = wordGap(pixels, margin, side, toMarks(side, margin) - CROP_MARGIN_MIN, WORD_REACH, edge, strips[side].ignore, strips[side].content);
          if (at !== null) { r[key] = at; word[side] = true; moved = true; continue; }
        }
        if (hold) {
          word[side] = false; held[side] = true;
          if (r[key] === rect[key]) continue;
          r[key] = rect[key];
        } else { r[key] = edge[key]; fellBack[side] = true; }
        moved = true;
      }
    }
    return { r, fellBack, held, word };
  }

  const edgesOf = (atEdge, fellBack, held, word) => Object.fromEntries(SIDES.map((side) => [side, atEdge[side] ? 'clamped' : word[side] ? 'word' : held[side] ? 'margin' : fellBack[side] ? 'frame' : 'snapped']));
  // A held edge that still runs through content.
  const heldCut = (pixels, frame, box, held) => SIDES.some((side) => held[side] && !edgeIsClean(pixels, box, side, frame));

  // A frame far larger than its marks buries them in unrelated page. The crop
  // is the marks plus a margin (see cropMargins), each edge snapped (see
  // snapCrop). The crop replaces the frame only when it still covers under half
  // of it. `edges` names each side `snapped`, `frame` (no clean band, so it fell
  // back to the frame), `margin` (held at its margin, with `options.hold`; `cut`
  // says one runs through content), `word` (settled in a word space near its
  // margin, with `options.hold`) or `clamped` (the margin already reached the
  // frame), or is null when the frame is returned. `options.parts` lists the
  // marks as { box, bracket, link } for the margins; `options.floor` (default
  // false) sets whether the crop is held to the context floor, `options.stripBounds`
  // is what a strip must run through (acrossStrips; the whole image by default),
  // `options.min` ([w, h]) is a least size that raises it, and `options.keep` and
  // `options.ignore` are the fills a snapped edge's shed keeps and does not read
  // (shedEdgeRules).
  function cropToMarks(pixels, frame, marksBox, options) {
    const whole = { box: frame.slice(), edges: null, cut: false };
    if (!marksBox) return whole;
    const parts = (options && options.parts) || [];
    const bounds = boundsOf(pixels, frame);
    const edge = { x0: bounds.x0, y0: bounds.y0, x1: bounds.x1, y1: bounds.y1 };
    const margins = cropMargins(edge, marksBox, parts, Boolean(options && options.floor), options && options.min);
    if (!margins) return whole;
    const { r, fellBack, held, word } = snapCrop(pixels, frame, edge, margins.rect, Boolean(options && options.hold), marksBox, boundsOf(pixels, options && options.stripBounds));
    const snapped = [r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0];
    if (snapped[2] * snapped[3] * 2 >= frame[2] * frame[3]) return whole;
    const edges = edgesOf(margins.atEdge, fellBack, held, word);
    const { shed } = shedEdgeRules(pixels, snapped, marksBox, { keep: (options && options.keep) || [], ignore: (options && options.ignore) || [] });
    const by = Object.fromEntries(SIDES.map((side) => [side, edges[side] === 'snapped' ? shed[side] : 0]));
    const box = [snapped[0] + by.left, snapped[1] + by.top, snapped[2] - by.left - by.right, snapped[3] - by.top - by.bottom];
    return { box, edges, cut: heldCut(pixels, frame, box, held) };
  }

  // Blank ground at the edges of a frame that shows everything is dead space,
  // and it differs from one panel to the next. Each edge moves inward over the
  // lines that are wholly ground: no pixel more than TOLERANCE off the edge
  // line's colour, and no run of RULE_LENGTH pixels more than SLIGHT off it, so
  // no content and no rule (a card's faint border on a page of nearly the same
  // shade is a rule, which TOLERANCE alone would read as ground). A shorter
  // faint run is the antialiased fringe of a glyph, which a 1x capture and its
  // 2x twin draw a line apart: the trim is measured from the ink itself, keeping
  // TRIM_PAD of them outside the first line that has anything on it and outside
  // `marksBox`, and never entering `keep`. An axis that is ground from end to
  // end stays as it is. Returns the new box and how far each side moved.
  function trimBlank(pixels, frame, marksBox, keep) {
    if (CSS_VIEW) {
      const view = cssView(pixels, frame, NO_REACH);
      const found = atOne().trimBlank(view.pixels, view.to(frame), marksBox && view.to(marksBox), keep && view.to(keep));
      const trimmed = Object.fromEntries(SIDES.map((side) => [side, found.trimmed[side] * scale]));
      const [x, y, w, h] = view.from(found.box);
      const x0 = trimmed.left ? x : frame[0]; const y0 = trimmed.top ? y : frame[1];
      const x1 = trimmed.right ? x + w : frame[0] + frame[2]; const y1 = trimmed.bottom ? y + h : frame[1] + frame[3];
      return { box: [x0, y0, x1 - x0, y1 - y0], trimmed };
    }
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
    const offAt = (side, line, i) => {
      const at = pixelAt(line, i);
      return Math.max(...ground[side].map((v, c) => Math.abs(pixels.data[at + c] - v)));
    };
    const extent = { left: r.x1 - r.x0, right: r.x1 - r.x0, top: r.y1 - r.y0, bottom: r.y1 - r.y0 };
    // A hairline across the dead space (a row's divider running out to the frame edge) crosses every line the trim
    // passes, so the points where one meets the edge line are set aside while it runs on unbroken. Only a thin run
    // that holds for RULE_LENGTH inward is one: a glyph's stroke cut by the frame is shorter.
    const crossing = Object.fromEntries(SIDES.map((side) => {
      const line = lineAt(r, side, 0);
      const runs = new Set();
      for (let i = line.from; i < line.to;) {
        if (offAt(side, line, i) <= TOLERANCE) { i += 1; continue; }
        let end = i;
        while (end < line.to && offAt(side, line, end) > TOLERANCE) end += 1;
        const thin = end - i <= RULE_THICKNESS;
        const holds = (p) => { for (let o = 0; o < Math.min(RULE_LENGTH, extent[side]); o += 1) if (offAt(side, lineAt(r, side, -o), p) <= SLIGHT) return false; return true; };
        for (let p = i; p < end; p += 1) if (thin && holds(p)) runs.add(p);
        i = end;
      }
      return [side, runs];
    }));
    const blank = (side, offset) => {
      const line = lineAt(r, side, -offset);
      const rules = crossing[side];
      let faint = 0;
      for (let i = line.from; i < line.to; i += 1) {
        const off = offAt(side, line, i);
        if (rules.has(i)) {
          if (off > SLIGHT) { faint = 0; continue; }
          rules.delete(i);
        }
        if (off > TOLERANCE) return false;
        faint = off > SLIGHT ? faint + 1 : 0;
        if (faint >= RULE_LENGTH) return false;
      }
      return true;
    };
    const roomTo = (box) => ({
      left: box ? Math.floor(box[0]) - r.x0 : Infinity, top: box ? Math.floor(box[1]) - r.y0 : Infinity,
      right: box ? r.x1 - Math.ceil(box[0] + box[2]) : Infinity, bottom: box ? r.y1 - Math.ceil(box[1] + box[3]) : Infinity,
    });
    const room = roomTo(marksBox); const kept = roomTo(keep);
    const trimmed = {};
    for (const side of SIDES) {
      let run = 0;
      while (run < extent[side] && blank(side, run)) run += 1;
      trimmed[side] = run >= extent[side] ? 0 : Math.max(0, Math.min(run - TRIM_PAD, room[side] - TRIM_PAD, kept[side]));
    }
    if (trimmed.left + trimmed.right >= extent.left || trimmed.top + trimmed.bottom >= extent.top) return { box: frame.slice(), trimmed: Object.fromEntries(SIDES.map((side) => [side, 0])) };
    const box = [r.x0 + trimmed.left, r.y0 + trimmed.top, extent.left - trimmed.left - trimmed.right, extent.top - trimmed.top - trimmed.bottom];
    return { box: trimmed.left || trimmed.top || trimmed.right || trimmed.bottom ? box : frame.slice(), trimmed };
  }

  // The box less the lines at each edge that are the colour of the edge line
  // from end to end (strictly: no corner is skipped, and no rule is forgiven).
  // A fill drawn on what is left hides every pixel that differs from its line,
  // so shrinking the fill this way can show nothing. A side that is one colour
  // throughout leaves the box whole: a box with nothing to find keeps its fill.
  function contentBox(pixels, box) {
    const r = rectOf(box, boundsOf(pixels, null));
    if (r.x1 <= r.x0 || r.y1 <= r.y0) return box.slice();
    const cut = {};
    for (const side of SIDES) {
      const extent = side === 'left' || side === 'right' ? r.x1 - r.x0 : r.y1 - r.y0;
      const ground = lineMedian(pixels, lineAt(r, side, 0));
      let run = 0;
      while (run < extent && lineIs(pixels, lineAt(r, side, -run), ground, SLIGHT, true)) run += 1;
      if (run >= extent) return box.slice();
      cut[side] = run;
    }
    // Runs from two sides that meet read every line as ground: nothing to find, as above.
    if (cut.left + cut.right >= r.x1 - r.x0 || cut.top + cut.bottom >= r.y1 - r.y0) return box.slice();
    return [r.x0 + cut.left, r.y0 + cut.top, r.x1 - r.x0 - cut.left - cut.right, r.y1 - r.y0 - cut.top - cut.bottom];
  }

  // The rect a redaction fill paints over `box`: the box and its `reach`, out to whole pixels so none is half
  // covered and clamped to the image, less the lines of ground at its edges (contentBox), then `back` again and
  // never past the reach.
  function fillRect(pixels, box, { reach, back }) {
    const [bx, by, bw, bh] = box;
    const x0 = Math.max(0, Math.floor(bx - reach)); const y0 = Math.max(0, Math.floor(by - reach));
    const x1 = Math.min(pixels.width, Math.ceil(bx + bw + reach)); const y1 = Math.min(pixels.height, Math.ceil(by + bh + reach));
    // A box wholly outside the image has nothing to cover; a canvas would paint a negative size backwards.
    if (x1 <= x0 || y1 <= y0) return [x0, y0, 0, 0];
    const outer = [x0, y0, x1 - x0, y1 - y0];
    const [x, y, w, h] = contentBox(pixels, outer);
    const fx = Math.max(x - back, x0); const fy = Math.max(y - back, y0);
    return [fx, fy, Math.min(x + w + back, x1) - fx, Math.min(y + h + back, y1) - fy];
  }

  // An imported image records no density, so it is read from the value: image px of its body (its x-height, or its
  // cap height when it has no lowercase), and of a box drawn by eye round one line, per device px per CSS px. The
  // body of 12px text is over 6 CSS px, so rounding up reads a 2x or 3x image as no less than it is; a 1x image of
  // larger text may read as 2x, which only widens what the fill looks through.
  const DENSITY_INK = 8;
  const DENSITY_BOX = 24;
  // Image px of a line's inked rows per density: a line of 12px capitals, about 9 CSS px tall, reads no less than its
  // density at 2x and 3x.
  const DENSITY_LINE = 12;
  // CSS px, times the density. A run of GROW_GAP plain lines ends a fill's growth: a word space or the leading
  // between lines. A run of lines each the colour of the one before that outlasts GROW_REGION is ground of another
  // colour (a chart, a card), which shows nothing of a value, where an underline or a border is at most 4 CSS px. A
  // side along the value's own line grows at most GROW_LIMIT past the reach it first looks through for ink: a long
  // surname. Ink still running on there is the value going on past its box.
  const GROW_GAP = 3;
  // Along a line, a run of plain columns shorter than this is a space between its words, not its end.
  const GROW_WORD = 6;
  const GROW_REGION = 6;
  const GROW_LIMIT = 64;
  // Heights of the value's body: a wrapped line of it starts within this many past the fill, which a line-height of
  // twice the font over lowercase text needs.
  const WRAP_LEAD = 2.5;
  // Image px: a line of 3x text that a box's pad only touches runs on this far past the pad.
  const LINE_RUN = 48;
  // CSS px: how far a glyph's antialiased edge reaches past its ink.
  const HAIR_EDGE = 2;

  // The fill of a redaction on an imported image, never smaller than the fill of its box and `pad` (fillRect, both
  // image px at 1x). It then grows each side, line by line, over ink that reaches its edge: an underline, a border, a
  // wrapped line, a trailing word. Beside the value's own line it looks `pad` times the density past the box for that
  // ink, and above and below a wrapped line's lead. It stops at ground, at ground of another colour, at a rule that
  // runs past it, at a `keep` box it does not already reach (another mark's target), at `bounds` (what is not shown
  // hides nothing), or, along the value's own line, at the limit. `rects` is what is painted: one rectangle per line
  // of ink the growth covered, over that line's own ink and the pad, and `rect` their bounding box. `capped` lists
  // the sides where ink still reaches the edge, `why` at the limit, at another mark's box or at the frame, and
  // `refuse` when that board must not be written; `extended` lists the sides grown along another line past the
  // limit; `near` the sides whose walk stopped at a gap with ink just past it; `grew` says it grew.
  function importFill(pixels, box, { pad, back, bounds = null, keep = [] }) {
    const base = fillRect(pixels, box, { reach: pad, back });
    if (base[2] <= 0 || base[3] <= 0) return { rect: base, rects: [base], density: 1, grew: false, capped: [], extended: [], near: [], bridged: [], peek: base };
    const ringGround = (r) => [0, 1, 2].map((c) => median(SIDES.flatMap((side) => {
      const line = lineAt(r, side, 0);
      return Array.from({ length: line.to - line.from }, (_, i) => pixels.data[pixelOf(pixels, line, line.from + i) + c]);
    })));
    const [bx, by, bw, bh] = box;
    const img = boundsOf(pixels, null);
    const outer = rectOf([bx - pad, by - pad, bw + 2 * pad, bh + 2 * pad], img);
    const inBox = rectOf(box, img);
    const near = ringGround(outer);
    const inked = (y, across) => across.x1 > across.x0 && !lineIs(pixels, { horizontal: true, fixed: y, from: across.x0, to: across.x1 }, near, SLIGHT, true);
    // The lines of ink on the rows of `within`, read across `across`: the rows that hold ink and the rows of ink that
    // run on from them past `within`, as far as `reach`, as runs of rows with the ink each row holds. Null for none.
    const read = (within, across, reach) => {
      let top = within.y0; while (top < within.y1 && !inked(top, across)) top += 1;
      let bottom = within.y1 - 1; while (bottom >= top && !inked(bottom, across)) bottom -= 1;
      if (top > bottom) return null;
      while (top > reach.y0 && inked(top - 1, across)) top -= 1;
      while (bottom < reach.y1 - 1 && inked(bottom + 1, across)) bottom += 1;
      const lines = []; let run = null;
      for (let y = top; y <= bottom; y += 1) {
        let n = 0;
        for (let x = across.x0; x < across.x1; x += 1) { const at = (y * pixels.width + x) * 4; if (near.some((v, c) => Math.abs(pixels.data[at + c] - v) > SLIGHT)) n += 1; }
        if (n === 0) { run = null; continue; }
        if (!run) { run = { y0: y, y1: y + 1, counts: [] }; lines.push(run); }
        run.y1 = y + 1; run.counts.push(n);
      }
      return { top, bottom, lines };
    };
    // The body of a line: the rows of it that hold at least half the most ink any of them holds. On lowercase text
    // that is the x-height, which caps and ascenders leave out. A bar across the line (the foot of an L, the top of a
    // 7 or a T) can be its inkiest row by far, so the rows past half of that may be one stroke: the body is never
    // taken as less than half the line's inked rows.
    const measure = ({ counts }) => {
      const most = Math.max(0, ...counts);
      const body = counts.flatMap((n, i) => (n * 2 >= most ? [i] : []));
      const height = Math.max(body[body.length - 1] - body[0] + 1, Math.ceil(counts.length / 2));
      return { height, density: Math.max(1, Math.ceil(height / DENSITY_INK), Math.ceil(counts.length / DENSITY_LINE)) };
    };
    const inkiest = (lines) => lines.reduce((a, l) => (l.counts.reduce((p, q) => p + q, 0) > a.counts.reduce((p, q) => p + q, 0) ? l : a));
    const start = { x0: base[0], y0: base[1], x1: base[0] + base[2], y1: base[1] + base[3] };
    const lim = boundsOf(pixels, bounds);
    const kept = keep.filter((k) => !hits(k, base));
    const ground = ringGround(start);
    const offAt = (x, y) => { const at = (y * pixels.width + x) * 4; return ground.some((v, c) => Math.abs(pixels.data[at + c] - v) > SLIGHT); };
    // An upright hairline, a card's side or a divider between columns: ink no wider than a rule that runs straight
    // up and down at least RULE_LENGTH, which no glyph's stroke does.
    const uprights = new Map();
    const upright = (x, y, density) => {
      const key = y * pixels.width + x;
      if (!uprights.has(key)) {
        const wide = RULE_THICKNESS * density; const tall = RULE_LENGTH * density;
        let a = x; while (a > img.x0 && x - a <= wide && offAt(a - 1, y)) a -= 1;
        let b = x + 1; while (b < img.x1 && b - x <= wide && offAt(b, y)) b += 1;
        let t = y; while (t > img.y0 && y - t < tall && offAt(x, t - 1)) t -= 1;
        let u = y + 1; while (u < img.y1 && u - t < tall && offAt(x, u)) u += 1;
        uprights.set(key, offAt(x, y) && b - a <= wide && u - t >= tall);
      }
      return uprights.get(key);
    };
    // A line of ground, an upright hairline it crosses aside: a row beside a card's side is no line of text.
    const plain = (line, density) => {
      for (let i = line.from; i < line.to; i += 1) {
        const x = line.horizontal ? i : line.fixed; const y = line.horizontal ? line.fixed : i;
        if (offAt(x, y) && !(line.horizontal && upright(x, y, density))) return false;
      }
      return true;
    };
    // A column whose only ink is an upright hairline: a card's side or a divider, which nothing grows onto.
    const sideOn = (line, density) => {
      if (line.horizontal) return false;
      let any = false;
      for (let y = line.from; y < line.to; y += 1) if (offAt(line.fixed, y)) { if (!upright(line.fixed, y, density)) return false; any = true; }
      return any;
    };
    const same = (a, b) => {
      for (let i = a.from; i < a.to; i += 1) {
        const p = pixelOf(pixels, a, i); const q = pixelOf(pixels, b, i);
        for (let c = 0; c < 3; c += 1) if (Math.abs(pixels.data[p + c] - pixels.data[q + c]) > SLIGHT) return false;
      }
      return true;
    };
    // Grows the 1x fill over the value whose own line is the rows `own`, of a body `height` tall at `density`.
    // `watch` says the value is known, so a gap may be covered through to its ink past it.
    const grow = (own, height, density, watch) => {
      uprights.clear();
      const r = { ...start };
      const ownX = { x0: start.x0, x1: start.x1 };
      const gap = GROW_GAP * density; const word = GROW_WORD * density; const region = GROW_REGION * density; const limit = GROW_LIMIT * density;
      // A line of one colour that runs on past both ends of the fill, a card's border or a divider, bounds what holds
      // the value: no wrapped line or trailing word of it lies beyond.
      const crossing = (line) => {
        const colour = lineMedian(pixels, line);
        if (sameColour(colour, ground, SLIGHT) || !lineIs(pixels, line, colour, SLIGHT, true)) return false;
        const past = (from, to) => from >= to || lineIs(pixels, { ...line, from, to }, colour, SLIGHT, true);
        const end = line.horizontal ? lim.x1 : lim.y1; const begin = line.horizontal ? lim.x0 : lim.y0;
        return past(Math.max(begin, line.from - gap), line.from) && past(line.to, Math.min(end, line.to + gap));
      };
      // So does a hairline across the walk at its k-th line, though it starts or bends within the fill: rows no thicker
      // than a rule, one unbroken run of ink (an upright hairline aside) at least RULE_LENGTH long, under or over the
      // value's columns and running on past them by more than a word space, set off from the ink before it by a clean
      // gap. An underline runs no wider than its text, and a line of text is thicker. Returns the columns of the walk
      // under the rule's straight length, or false.
      const hairline = (at, k) => {
        const line = at(k);
        if (!line.horizontal || line.fixed < img.y0 || line.fixed >= img.y1) return false;
        const y = line.fixed;
        let x0 = -1; let x1 = -1;
        for (let x = line.from; x < line.to; x += 1) {
          if (!offAt(x, y) || upright(x, y, density)) continue;
          if (x0 >= 0 && x > x1) return false;
          if (x0 < 0) x0 = x;
          x1 = x + 1;
        }
        if (x0 < 0) return false;
        while (x0 > lim.x0 && offAt(x0 - 1, y)) x0 -= 1;
        while (x1 < lim.x1 && offAt(x1, y)) x1 += 1;
        if (x1 - x0 < RULE_LENGTH * density || Math.min(x1, ownX.x1) <= Math.max(x0, ownX.x0) || (x1 - ownX.x1 <= word && ownX.x0 - x0 <= word)) return false;
        // The gap is read under the rule's straight length, clear of a rounded corner's arc at either end.
        const from = Math.max(line.from, x0 + ARC * density); const to = Math.min(line.to, x1 - ARC * density);
        if (to <= from) return false;
        for (let j = 1; j <= gap; j += 1) if (!plain({ ...at(k - j), from, to }, density)) return false;
        // The share of a row's pixels along the run within `tolerance` of `colour`. A rule holds one colour along
        // nearly all of its length, and the row past it is ground, or a card's fill, but for a rounded corner at an
        // end; the bottom or top row of a line of text holds neither.
        const run = { ...line, from: x0, to: x1 };
        const share = (row, colour, tolerance) => {
          if (row < img.y0 || row >= img.y1 || !colour) return 0;
          let n = 0;
          for (let x = x0; x < x1; x += 1) if (sameColour([0, 1, 2].map((c) => pixels.data[(row * pixels.width + x) * 4 + c]), colour, tolerance)) n += 1;
          return n / (x1 - x0);
        };
        const colour = lineMedian(pixels, run);
        if (share(y, colour, TOLERANCE) < 0.9) return false;
        let thick = 1;
        while (thick <= RULE_THICKNESS * density && share(at(k + thick).fixed, colour, TOLERANCE) >= 0.5) thick += 1;
        if (thick > RULE_THICKNESS * density) return false;
        const past = at(k + thick).fixed;
        const beyond = lineMedian(pixels, { ...run, fixed: past });
        if (past < img.y0 || past >= img.y1 || share(past, beyond, SLIGHT) < 0.9) return false;
        // A card's border has padding past it too; an underline hugs the text it underlines, which may be the value's
        // other line. The far side is read as the near one, for twice the gap, against the ground or fill past it.
        for (let j = k + thick; j < k + thick + 2 * gap; j += 1) {
          const row = at(j).fixed;
          if (row < img.y0 || row >= img.y1) break;
          for (let x = from; x < to; x += 1) if (!sameColour([0, 1, 2].map((c) => pixels.data[(row * pixels.width + x) * 4 + c]), beyond, SLIGHT) && !upright(x, row, density)) return false;
        }
        // Nor is a rule set further off a line of text that runs its length: that line's underline.
        const rows = [];
        for (let j = k + thick + 2 * gap, inked = false; j < k + thick + 2 * gap + Math.ceil(WRAP_LEAD * height) + gap; j += 1) {
          const row = at(j).fixed;
          if (row < img.y0 || row >= img.y1) break;
          let any = false;
          for (let x = from; x < to && !any; x += 1) any = offAt(x, row) && !upright(x, row, density);
          if (any) { rows.push(row); inked = true; } else if (inked) break;
        }
        if (rows.length) {
          const inkAt = (x) => rows.some((row) => offAt(x, row) && !upright(x, row, density));
          let a = from; while (a < to && !inkAt(a)) a += 1;
          let b = to; while (b > a && !inkAt(b - 1)) b -= 1;
          for (let x = a - 1, blank = 0; x >= lim.x0 && blank < word; x -= 1) { if (inkAt(x)) { a = x; blank = 0; } else blank += 1; }
          for (let x = b, blank = 0; x < lim.x1 && blank < word; x += 1) { if (inkAt(x)) { b = x + 1; blank = 0; } else blank += 1; }
          if (Math.abs(a - x0) <= word && Math.abs(b - x1) <= word) return false;
        }
        return { from, to, thick };
      };
      // Whether ink lies within `lead` lines past a hairline at line k, outside the pad: the gate is told of it.
      const pastRule = (at, k, rule, lead, space) => {
        for (let j = Math.max(1, k + rule.thick); j <= Math.min(space, k + rule.thick + lead); j += 1) if (!plain(at(j), density)) return true;
        return false;
      };
      const room = (side) => ({ left: start.x0 - lim.x0, top: start.y0 - lim.y0, right: lim.x1 - start.x1, bottom: lim.y1 - start.y1 }[side]);
      // How many lines past the edge to cover (`at(k)` is the k-th). A walk along the value's own line (`onValue`)
      // stops at the limit, and is capped if ink still reaches the edge there. Any other line may be the value
      // wrapped, so it is followed to its end, however far, and `extended` says it went past the limit. A walk that
      // meets another mark's box with ink is capped there, and `refuse` says that board is not written: the ink was
      // on the value's own line, or past the limit. So is one that reaches the frame with ink on its last line,
      // refusing on the value's own line. Past an underline or a border, a band no thicker than `region`, a wrapped
      // line may follow; after a line, a gap of `join` ends the walk unless (when `watch`) ink resumes within another
      // lead past it, and `fits` says that ink is the value's: the walk then covers through to it. `near` says ink
      // resumes there that it did not cover through to.
      const walk = (at, space, lead, onValue, join = gap, watching = false, fits = null) => {
        const bound = lead + limit;
        const reach = onValue ? Math.min(bound, space) : space;
        let last = 0; let plainRun = 0; let repeat = 0; let band = 0; let line = false;
        let bridgeTo = 0; let bridged = false;
        const done = (result) => ({ extended: result.cover > bound, ...result, bridged });
        // The first line of ink, not a rule, from `from` up to `to` lines past the edge; 0 for none.
        const inkAt = (from, to) => {
          for (let j = from; j <= Math.min(space, to); j += 1) {
            const there = at(j);
            if (!plain(there, density) && !crossing(there) && !hairline(at, j)) return j;
          }
          return 0;
        };
        for (let k = 1; k <= reach; k += 1) {
          const here = at(k);
          if (kept.some((b) => hits(stripOf(here), b))) {
            // Capped when the walk would have gone on into ink there.
            const ends = Math.min(space, Math.max(bridgeTo, k + (line ? join : lead) - plainRun - 1));
            let inked = false;
            for (let j = k; !inked && j <= ends; j += 1) inked = !plain(at(j), density);
            return done(inked ? { cover: last, capped: { why: 'mark', refuse: onValue || k > bound } } : { cover: last });
          }
          const blank = plain(here, density);
          if (blank) {
            repeat = 0; plainRun += 1; band = 0;
            if (plainRun >= (line ? join : lead) && k > bridgeTo) {
              // Above and below, ink that resumes within another lead may be the value going on: the walk covers
              // through to it. Ink a lead further still is named.
              const resumed = watching ? inkAt(k + 1, k + lead) : 0;
              if (!resumed || (fits && !fits(resumed))) return done({ cover: last, near: watching && (resumed > 0 || inkAt(k + lead + 1, k + 2 * lead) > 0) });
              bridgeTo = resumed; bridged = true;
            }
            continue;
          }
          const rule = hairline(at, k);
          if (rule) {
            // Lines with ink only beside the rule's straight length are its rounded corners: the fill stops short.
            let clear = last;
            while (clear > 0 && plain({ ...at(clear), from: rule.from, to: rule.to }, density)) clear -= 1;
            return done({ cover: clear, near: pastRule(at, k, rule, lead, space) });
          }
          if (crossing(here) || sideOn(here, density)) return done({ cover: last });
          band += 1; if (band > region) line = true;
          plainRun = 0;
          repeat = same(here, at(k - 1)) ? repeat + 1 : 0;
          if (repeat >= region) return done({ cover: Math.min(last, k - repeat - 1) });
          last = k;
        }
        // A walk that reaches the frame with ink on its last line leaves that ink's line unread past it.
        if (reach >= space) return done({ cover: last, capped: last > 0 && last === reach && { why: 'frame', refuse: onValue } });
        if (!onValue) return done({ cover: last });
        const ends = line ? join : lead;
        let capped = false;
        for (let k = reach + 1; !capped && k <= Math.min(space, reach + ends - plainRun); k += 1) capped = !plain(at(k), density);
        return done({ cover: last, capped: capped && { why: 'limit', refuse: true } });
      };
      // Each band of rows with ink at the edge is followed sideways on its own, so one line's words end at its own
      // spaces and a rule elsewhere in the fill joins no lines. Beside the value's line the fill looks `pad` times the
      // density and a word space past the box for ink, whatever the 1x fill found.
      const sideways = (side) => {
        const e = { ...r, ...(side === 'left' ? { x0: start.x0 } : { x1: start.x1 }) };
        const at = side === 'left' ? e.x0 : e.x1;
        const lead = Math.max(word, side === 'left' ? at - Math.floor(bx - pad * density) + word : Math.ceil(bx + bw + pad * density) - at + word);
        const strip = side === 'left' ? { from: Math.max(lim.x0, at - lead), to: Math.min(lim.x1, at + gap) } : { from: Math.max(lim.x0, at - gap), to: Math.min(lim.x1, at + lead) };
        // Bands of rows with ink in `across`, merged over gaps shorter than `gap`.
        const bandsIn = (across) => {
          const found = []; let open = null; let blank = 0;
          for (let y = r.y0; y < r.y1; y += 1) {
            if (across.to > across.from && !plain({ horizontal: true, fixed: y, ...across }, density)) {
              if (open && blank < gap) open.y1 = y + 1; else { open = { y0: y, y1: y + 1 }; found.push(open); }
              blank = 0;
            } else blank += 1;
          }
          return found;
        };
        const walks = bandsIn(strip).map((band) => {
          const onValue = band.y0 < own[1] && own[0] < band.y1;
          return { ...walk((k) => lineAt({ ...e, y0: band.y0, y1: band.y1 }, side, k), room(side), lead, onValue, word), onValue };
        });
        const ownCover = Math.max(0, ...walks.filter((w) => w.onValue).map((w) => w.cover));
        if (side === 'left') ownX.x0 = Math.min(ownX.x0, start.x0 - ownCover); else ownX.x1 = Math.max(ownX.x1, start.x1 + ownCover);
        // A line with ink just past where the fill now stands, which it grew to reach, is followed from there.
        const grownBy = side === 'left' ? start.x0 - r.x0 : r.x1 - start.x1;
        if (grownBy > 0) {
          const now = side === 'left' ? r.x0 : r.x1;
          const past = side === 'left' ? { from: Math.max(lim.x0, now - gap), to: now } : { from: now, to: Math.min(lim.x1, now + gap) };
          for (const band of bandsIn(past)) {
            const fromNow = walk((k) => lineAt({ ...r, y0: band.y0, y1: band.y1 }, side, k), room(side) - grownBy, word, false, word);
            walks.push({ ...fromNow, cover: fromNow.cover > 0 ? fromNow.cover + grownBy : 0 });
          }
        }
        const caps = walks.flatMap((w) => (w.capped ? [w.capped] : []));
        return { cover: Math.max(0, ...walks.map((w) => w.cover)), extended: walks.some((w) => w.extended), capped: caps.find((c) => c.refuse) ?? caps[0] };
      };
      // A wrapped line of the value starts within WRAP_LEAD of its body's height past the fill, or past the line before
      // it: a line-height of twice the font over lowercase text. Line after line is followed to the value's last.
      const across = (side) => {
        const e = { ...r, ...(side === 'top' ? { y0: start.y0 } : { y1: start.y1 }) };
        const lead = gap + Math.ceil(WRAP_LEAD * height);
        // Ink past a gap is the value going on only when its line lies under or over the value's own: half the
        // narrower of their runs of columns overlaps. The line is read whole, out through its word spaces past the
        // fill's columns, so a wide heading is not taken for the value by the part of it under the fill. A heading or
        // a label set off from the value is left to the gate.
        const under = (j) => {
          const rows = [];
          for (let k = j; k < j + lead && k <= room(side); k += 1) {
            const line = lineAt(e, side, k);
            if (plain(line, density)) { if (k > j) break; continue; }
            if (crossing(line)) break;
            rows.push(line.fixed);
          }
          const inkAt = (x) => rows.some((y) => offAt(x, y) && !upright(x, y, density));
          let x0 = Infinity; let x1 = -Infinity;
          for (let x = e.x0; x < e.x1; x += 1) if (inkAt(x)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x + 1); }
          if (x1 <= x0) return false;
          for (let x = x0 - 1, blank = 0; x >= lim.x0 && blank < word; x -= 1) { if (inkAt(x)) { x0 = x; blank = 0; } else blank += 1; }
          for (let x = x1, blank = 0; x < lim.x1 && blank < word; x += 1) { if (inkAt(x)) { x1 = x + 1; blank = 0; } else blank += 1; }
          return 2 * (Math.min(x1, ownX.x1) - Math.max(x0, ownX.x0)) >= Math.min(x1 - x0, ownX.x1 - ownX.x0);
        };
        const at = (k) => lineAt(e, side, k);
        // A hairline between the value's line and the pad's edge, which the pad already covers, is still the edge of
        // what holds the value: the walk does not go out past it.
        for (let k = side === 'top' ? start.y0 - own[0] + 1 : own[1] - start.y1 + 1; k <= 0; k += 1) {
          const rule = hairline(at, k);
          if (rule) return { cover: 0, extended: false, bridged: false, near: pastRule(at, k, rule, lead, room(side)) };
        }
        return walk(at, room(side), lead, false, lead, watch, under);
      };
      // A side that covered through a gap in any round did so: a later round may find that ink within its lead.
      let capped = []; let extended = []; let resumed = []; const gapped = new Set();
      for (let round = 0, moved = true; moved && round < 8; round += 1) {
        moved = false; capped = []; extended = []; resumed = [];
        for (const side of SIDES) {
          const walked = side === 'top' || side === 'bottom' ? across(side) : sideways(side);
          if (walked.capped) capped.push({ side, ...walked.capped });
          if (walked.extended) extended.push(side);
          if (walked.near) resumed.push(side);
          if (walked.bridged) gapped.add(side);
          if (walked.cover <= 0) continue;
          const step = Math.min(walked.cover + back * density, room(side));
          const was = { ...r };
          if (side === 'left') r.x0 = Math.min(r.x0, start.x0 - step); else if (side === 'top') r.y0 = Math.min(r.y0, start.y0 - step);
          else if (side === 'right') r.x1 = Math.max(r.x1, start.x1 + step); else r.y1 = Math.max(r.y1, start.y1 + step);
          if (r.x0 !== was.x0 || r.y0 !== was.y0 || r.x1 !== was.x1 || r.y1 !== was.y1) moved = true;
        }
      }
      return { r, crossing, capped, extended, resumed, bridged: SIDES.filter((side) => gapped.has(side)), gap, word };
    };
    const grew = (r) => r.x0 < start.x0 || r.y0 < start.y0 || r.x1 > start.x1 || r.y1 > start.y1;
    // The value's line: the rows of the box that hold ink, and the rows of ink that run on from them past its edges.
    // A box drawn just off its value holds none, but its pad may, and the 1x fill covers that ink: the value's line
    // is then the ink under the pad, read across the pad and run on to the line's end. A box with no ink under it
    // or its pad reads its own height as one line's, and takes as the value's line the line nearest it that its
    // lead reaches: that line is read for the density, and the fill grows again from it, as from a box drawn on it.
    let found = read(inBox, inBox, outer);
    if (!found) found = read(outer, outer, rectOf([outer.x0, outer.y0 - LINE_RUN, outer.x1 - outer.x0, outer.y1 - outer.y0 + 2 * LINE_RUN], img));
    let own = found ? [found.top, found.bottom + 1] : [inBox.y0, inBox.y1];
    const blank = DENSITY_INK * Math.max(1, Math.ceil(bh / DENSITY_BOX));
    let { height, density } = found ? measure(inkiest(found.lines)) : { height: blank, density: Math.max(1, Math.ceil(blank / DENSITY_INK)) };
    let grown = grow(own, height, density, Boolean(found));
    if (!found && grew(grown.r)) {
      // Read past the fill as grown: at the height of a blank box the walk may have stopped inside the line.
      const reached = read(grown.r, grown.r, rectOf([grown.r.x0, grown.r.y0 - LINE_RUN, grown.r.x1 - grown.r.x0, grown.r.y1 - grown.r.y0 + 2 * LINE_RUN], img));
      if (reached) {
        const line = reached.lines.reduce((a, l) => (Math.max(0, l.y0 - inBox.y1, inBox.y0 - l.y1) < Math.max(0, a.y0 - inBox.y1, inBox.y0 - a.y1) ? l : a));
        own = [line.y0, line.y1]; ({ height, density } = measure(line));
        grown = grow(own, height, density, true);
      }
    }
    const { r, crossing, capped, extended, resumed, bridged, gap, word } = grown;
    // What is painted: the 1x fill whole, and one rectangle per piece of a line within the grown fill: the ink joined
    // across its letter and word spaces, so a line, or the part of one up to a wider space, is one piece, and the
    // next column's words another. A piece is covered when it lies within the sideways lead of the box, or of a
    // covered piece on its own rows or on the line before it, walking up from the value's line and down from it and
    // never back: a line reached above the value leads to no line below it. A label on the value's line past a clean
    // gap of the lead, or the next column's rows, stays readable; what lies between covered pieces is ground. The
    // walk reads only under the fill's columns, so the pieces are read a wrap's reach past it, two leads above and
    // below (and a line more) across the frame: a line within that reach wholly left of a covered line on the line
    // below it is the value wrapped to its container's edge, and one wholly right on the line above is its first
    // line's tail. Such a line is covered too, and lines under it within a lead follow, unless a rule runs between
    // them or another mark's box holds them.
    const lane = pad * density + word;
    const leadV = 2 * (gap + Math.ceil(WRAP_LEAD * height));
    // Two leads past the walk's rect, and as much again so a line that starts there is read whole.
    const region = { x0: lim.x0, x1: lim.x1, y0: Math.max(lim.y0, r.y0 - 2 * leadV), y1: Math.min(lim.y1, r.y1 + 2 * leadV) };
    const W = Math.max(0, region.x1 - region.x0); const H = Math.max(0, region.y1 - region.y0);
    // Ink is what differs from the ground by TOLERANCE, as content does to lineIsClean, with the fainter pixels
    // touching it (a glyph's antialiased edge): noise and a dithered ground, a few levels off, form no piece.
    const off = new Uint8Array(W * H);
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
      const at = ((region.y0 + y) * pixels.width + region.x0 + x) * 4;
      const most = Math.max(...ground.map((v, c) => Math.abs(pixels.data[at + c] - v)));
      off[y * W + x] = most > TOLERANCE ? 2 : most > SLIGHT ? 1 : 0;
    }
    // The fainter pixels taken in are those within a glyph's edge of the ink, HAIR_EDGE px at this density: a page a
    // few levels off the card it holds is not taken in whole from the card's border.
    const ink = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i += 1) if (off[i] === 2) ink[i] = 1;
    for (let step = 0; step < HAIR_EDGE * density; step += 1) {
      const grown = ink.slice();
      for (let i = 0; i < W * H; i += 1) {
        if (!ink[i]) continue;
        const x = i % W; const y = (i - x) / W;
        if (x > 0 && off[i - 1] === 1) grown[i - 1] = 1; if (x + 1 < W && off[i + 1] === 1) grown[i + 1] = 1;
        if (y > 0 && off[i - W] === 1) grown[i - W] = 1; if (y + 1 < H && off[i + W] === 1) grown[i + W] = 1;
      }
      ink.set(grown);
    }
    // A rule, a card's border or a divider, is a run of ink at least RULE_LENGTH long and no thicker than a rule
    // at this density, with the edge taken in round it. Its pixels are pieces of their own, so a border is thin
    // pieces along its sides and never one piece with every line it rounds; a glyph's stroke is never that long.
    const along = (horizontal) => {
      const extent = new Uint16Array(W * H);
      const outer = horizontal ? H : W; const inner = horizontal ? W : H;
      for (let a = 0; a < outer; a += 1) {
        for (let b = 0, from = 0; b <= inner; b += 1) {
          const i = horizontal ? a * W + b : b * W + a;
          if (b < inner && ink[i]) continue;
          for (let k = from; k < b; k += 1) extent[horizontal ? a * W + k : k * W + a] = b - from;
          from = b + 1;
        }
      }
      return extent;
    };
    const across = along(true); const down = along(false);
    const longest = RULE_LENGTH * density; const thin = (RULE_THICKNESS + 2 * HAIR_EDGE) * density;
    const rule = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i += 1) if (ink[i] && ((across[i] >= longest && down[i] <= thin) || (down[i] >= longest && across[i] <= thin))) rule[i] = 1;
    // The text, closed over its letter and word spaces. Text too faint to seed a piece (within TOLERANCE of the
    // ground, past SLIGHT) is read the same way inside the grown fill, which the walk reads at SLIGHT: a piece of
    // it is kept when it is more than specks, at least a tenth ink over a bbox of some glyphs.
    const closed = (take) => {
      const mask = new Uint8Array(W * H);
      for (let y = 0; y < H; y += 1) {
        for (let x = 0, last = -1; x < W; x += 1) {
          if (!take(y * W + x)) continue;
          if (last >= 0 && x - last - 1 < word) mask.fill(1, y * W + last, y * W + x);
          mask[y * W + x] = 1; last = x;
        }
      }
      return mask;
    };
    const inR = (x, y) => x >= r.x0 - region.x0 && x < r.x1 - region.x0 && y >= r.y0 - region.y0 && y < r.y1 - region.y0;
    const mask = closed((i) => ink[i] && !rule[i]);
    const faint = closed((i) => off[i] === 1 && !ink[i] && inR(i % W, (i - (i % W)) / W));
    const pieces = [];
    for (const [of, kind] of [[mask, 'text'], [rule, 'rule'], [faint, 'faint']]) {
      const isFaint = kind === 'faint';
      const seen = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i += 1) {
        if (!of[i] || seen[i]) continue;
        const piece = { x0: W, x1: 0, y0: H, y1: 0, up: false, down: false };
        let count = 0;
        for (const stack = [i]; stack.length;) {
          const j = stack.pop();
          if (seen[j] || !of[j]) continue;
          seen[j] = 1;
          const x = j % W; const y = (j - x) / W;
          if (!isFaint || off[j] === 1) count += 1;
          piece.x0 = Math.min(piece.x0, x); piece.x1 = Math.max(piece.x1, x + 1); piece.y0 = Math.min(piece.y0, y); piece.y1 = Math.max(piece.y1, y + 1);
          if (x > 0) stack.push(j - 1); if (x + 1 < W) stack.push(j + 1); if (y > 0) stack.push(j - W); if (y + 1 < H) stack.push(j + W);
        }
        const area = (piece.x1 - piece.x0) * (piece.y1 - piece.y0);
        if (isFaint && (area < 16 * density * density || count * 10 < area)) continue;
        const placed = { ...piece, x0: piece.x0 + region.x0, x1: piece.x1 + region.x0, y0: piece.y0 + region.y0, y1: piece.y1 + region.y0 };
        const box = [placed.x0, placed.y0, placed.x1 - placed.x0, placed.y1 - placed.y0];
        pieces.push({ ...placed, kind, area, inside: hits(box, [r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0]), held: kept.some((b) => hits(box, b)) });
      }
    }
    const xGap = (a, b) => Math.max(0, a.x0 - b.x1, b.x0 - a.x1);
    const ruledRows = new Map();
    const ruledBetween = (y0, y1) => {
      for (let y = y0; y < y1; y += 1) {
        if (!ruledRows.has(y)) ruledRows.set(y, crossing({ horizontal: true, fixed: y, from: lim.x0, to: lim.x1 }));
        if (ruledRows.get(y)) return true;
      }
      return false;
    };
    // A hairline between a line of the value and another piece, across both, that runs on past the value's line by
    // more than a word space, with no text within twice the gap of it on either side under its straight length and no
    // line within a lead that runs its length: a card's border, as the walk reads one. An underline hugs its text.
    const fenced = (a, b) => pieces.some((q) => q.kind === 'rule' && q.y1 - q.y0 < q.x1 - q.x0 && q.y0 >= Math.min(a.y1, b.y1) && q.y1 <= Math.max(a.y0, b.y0)
      && Math.min(q.x1, a.x1) > Math.max(q.x0, a.x0) && Math.min(q.x1, b.x1) > Math.max(q.x0, b.x0) && (q.x1 - a.x1 > word || a.x0 - q.x0 > word)
      && !pieces.some((t) => {
        if (t.kind === 'rule') return false;
        const apart = Math.max(0, t.y0 - q.y1, q.y0 - t.y1);
        const straight = Math.min(t.x1, q.x1 - ARC * density) > Math.max(t.x0, q.x0 + ARC * density);
        return (straight && apart < 2 * gap) || (apart < leadV / 2 && Math.abs(t.x0 - q.x0) <= word && Math.abs(t.x1 - q.x1) <= word);
      }));
    // The box and its 1x fill are where the walks set out from: a piece beside them on their rows, or within the
    // lead above or below them, is covered as one beside a covered piece is.
    const origin = { x0: Math.min(start.x0, inBox.x0), x1: Math.max(start.x1, inBox.x1), y0: start.y0, y1: start.y1, up: true, down: true, inside: true, kind: 'text' };
    // The next line of text below (or above) a piece: no line of text lies between them over the piece's columns.
    const next = (from, piece, below) => !pieces.some((q) => q !== piece && q.kind !== 'rule' && (below ? q.y0 >= from.y1 && q.y1 <= piece.y0 : q.y1 <= from.y0 && q.y0 >= piece.y1) && xGap(q, piece) < lane);
    const onOwn = (piece) => piece === origin || (piece.y0 < own[1] && own[0] < piece.y1);
    // A piece hanging off a rule far longer than itself is a rounded corner's arc, not a word.
    const edgeOf = HAIR_EDGE * density + 1;
    const arc = (piece) => pieces.some((q) => q.kind === 'rule' && (q.x1 - q.x0 >= 2 * (piece.x1 - piece.x0) || q.y1 - q.y0 >= 2 * (piece.y1 - piece.y0)) && xGap(q, piece) <= edgeOf && Math.max(0, q.y0 - piece.y1, piece.y0 - q.y1) <= edgeOf);
    const text = (piece) => piece.kind !== 'rule' && !piece.held;
    const sameRows = (a, b) => 2 * (Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)) >= Math.min(a.y1 - a.y0, b.y1 - b.y0);
    const spans = (a, b) => Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0);
    let tailLeft = false;
    for (let moved = true; moved;) {
      moved = false;
      for (const piece of pieces) {
        if (piece.held) continue;
        for (const from of [origin, ...pieces]) {
          // A rule is covered but leads nowhere: a border rounds every line of its card.
          if (from === piece || !(from.up || from.down) || from.kind === 'rule') continue;
          const above = piece.y1 <= from.y0; const below = piece.y0 >= from.y1;
          const ygap = Math.max(0, piece.y0 - from.y1, from.y0 - piece.y1);
          let up = piece.up; let down = piece.down;
          // Beside a covered piece within the walk's rect, as the walk reads. Past the walk's rect, only the next
          // line of text within two leads of a line reached there, never straight out of the rect.
          const beside = xGap(piece, from) < lane && ygap <= leadV && (piece.inside && from.inside ? true : !piece.inside && !from.inside ? piece.kind !== 'rule' && (above || below) && next(from, piece, below) : false);
          if (beside) {
            up ||= above ? from.up : !below && from.up;
            down ||= below ? from.down : !above && from.down;
          }
          // From the value's own line: the next line of text below it that starts left of it is the value wrapped
          // to its container's edge, and so is one wholly right of it in text that runs right to left, when the
          // value's own row is empty under it; the next line above it wholly right of it is its first line's tail.
          // A tail wholly left of it, in text that runs right to left, is covered when it stands alone on its line,
          // and named and shown to the gate otherwise: a card's row of cells to the upper left is no tail. At least a
          // short word, not a rounded corner's arc, with no rule between.
          const wrap = onOwn(from) && piece.kind !== 'rule' && piece.x1 - piece.x0 >= DENSITY_INK * density && piece.y1 - piece.y0 >= 4 * density && ygap <= leadV && !arc(piece);
          const free = (q) => !pieces.some((p) => p !== q && text(p) && sameRows(p, origin) && spans(p, q));
          if (wrap && below && from.down && (piece.x0 < from.x0 || (piece.x0 >= from.x1 && free(piece))) && next(from, piece, true) && !ruledBetween(from.y1, piece.y0) && !fenced(from, piece)) down = true;
          if (wrap && above && from.up && next(from, piece, false) && !ruledBetween(piece.y1, from.y0) && !fenced(from, piece)) {
            if (piece.x0 >= from.x1 && free(piece)) up = true;
            else if (piece.x1 <= from.x0 && free(piece)) { if (pieces.filter((q) => text(q) && sameRows(q, piece)).length === 1) up = true; else tailLeft = true; }
          }
          if (up !== piece.up || down !== piece.down) { piece.up = up; piece.down = down; moved = true; }
        }
      }
    }
    if (tailLeft && !resumed.includes('top')) resumed.push('top');
    const covered = [[start.x0, start.y0, start.x1 - start.x0, start.y1 - start.y0], ...pieces.filter((piece) => piece.up || piece.down).map((piece) => {
      const within = piece.inside ? r : lim;
      const x0 = Math.max(within.x0, piece.x0 - back * density); const x1 = Math.min(within.x1, piece.x1 + back * density);
      const y0 = Math.max(within.y0, piece.y0 - back * density); const y1 = Math.min(within.y1, piece.y1 + back * density);
      return [x0, y0, x1 - x0, y1 - y0];
    })];
    // A rect inside another adds nothing; the 1x fill stays first.
    const holds = (a, b) => a[0] <= b[0] && a[1] <= b[1] && a[0] + a[2] >= b[0] + b[2] && a[1] + a[3] >= b[1] + b[3];
    const rects = covered.filter((rect, i) => i === 0 || !covered.some((other, j) => j !== i && holds(other, rect) && (j < i || !holds(rect, other))));
    const whole = union(rects);
    const painted = { x0: whole[0], y0: whole[1], x1: whole[0] + whole[2], y1: whole[1] + whole[3] };
    // What the gate shows past the fill: on each side with ink, not a rule, within three leads (the gap that ends a
    // walk, the one it covers through, and one more) or 40 CSS px of where the fill stopped, that much more, within
    // the frame. Above and below, the rows are read across the frame, and the view takes in the ink found there,
    // so a line beside the fill's columns is shown too. Whoever confirms then sees what lies just beyond.
    const glance = Math.max(3 * (gap + Math.ceil(WRAP_LEAD * height)), 40 * density);
    const seenX = { x0: painted.x0, x1: painted.x1 };
    const beyond = (side) => {
      const space = { left: painted.x0 - lim.x0, top: painted.y0 - lim.y0, right: lim.x1 - painted.x1, bottom: lim.y1 - painted.y1 }[side];
      const wide = side === 'top' || side === 'bottom' ? { ...painted, x0: lim.x0, x1: lim.x1 } : painted;
      let found = 0;
      for (let k = 1; k <= Math.min(space, glance); k += 1) {
        const there = lineAt(wide, side, k);
        if (lineIs(pixels, there, ground, SLIGHT, true) || crossing(there)) continue;
        found = Math.min(space, glance);
        if (!there.horizontal) break;
        for (let x = there.from; x < there.to; x += 1) {
          const at = pixelOf(pixels, there, x);
          if (ground.some((v, c) => Math.abs(pixels.data[at + c] - v) > SLIGHT)) { seenX.x0 = Math.min(seenX.x0, x); seenX.x1 = Math.max(seenX.x1, x + 1); }
        }
      }
      return found;
    };
    const [pl, pt, pr, pb] = SIDES.map(beyond);
    const peek = [Math.min(painted.x0 - pl, seenX.x0), painted.y0 - pt, Math.max(painted.x1 + pr, seenX.x1) - Math.min(painted.x0 - pl, seenX.x0), painted.y1 - painted.y0 + pt + pb];
    // A line the walk followed to its end past the limit was covered only where the paint reached the walk's edge.
    const reached = { left: painted.x0 <= r.x0, top: painted.y0 <= r.y0, right: painted.x1 >= r.x1, bottom: painted.y1 >= r.y1 };
    return { rect: whole, rects, density, grew: grew(painted), capped, extended: extended.filter((side) => reached[side]), near: resumed, bridged, peek };
  }

  // Whether any line across the box crosses content (lineIsClean): a glyph, an icon, a fill. A blank holds none.
  function holdsContent(pixels, box) {
    const r = rectOf(box, boundsOf(pixels, null));
    for (let y = r.y0; y < r.y1; y += 1) if (!lineIsClean(pixels, { horizontal: true, fixed: y, from: r.x0, to: r.x1 }, [])) return true;
    return false;
  }

  // Capture px a slot's edge may move, either way, onto the edge of the blank it outlines.
  const SLOT_SNAP = 8 * scale;
  // Capture px: a slot narrower than this on a side has no inside to read, and none snaps to it.
  const SLOT_LEAST = 2 * scale;
  // A slot outlines a blank when this share of its interior is one ground colour; text is far less.
  const SLOT_BLANK = 0.9;

  // A slot drawn by eye round a blank: each edge moves to the nearest line within SLOT_SNAP, either way, where the
  // blank's ground inside meets another colour, one that holds, outside along at least half the edge. Pixels under an
  // `options.keep` fill are not read, and no edge moves to cover more of one. A box that is no blank stays as given.
  function snapSlot(pixels, box, options) {
    const keep = (options && options.keep) || [];
    const r = rectOf(box, boundsOf(pixels, null));
    if (r.x1 - r.x0 < SLOT_LEAST || r.y1 - r.y0 < SLOT_LEAST) return box.slice();
    const inKeep = (x, y) => keep.some((k) => inRect(k, x, y));
    const at = (x, y) => (y * pixels.width + x) * 4;
    const inner = (lo, hi) => (hi - lo > 4 * SLOT_SNAP ? [lo + SLOT_SNAP, hi - SLOT_SNAP] : [lo, hi]);
    const [ix0, ix1] = inner(r.x0, r.x1); const [iy0, iy1] = inner(r.y0, r.y1);
    const stride = Math.max(1, Math.ceil(Math.max(ix1 - ix0, iy1 - iy0) / 128));
    const samples = [];
    for (let y = iy0; y < iy1; y += stride) for (let x = ix0; x < ix1; x += stride) if (!inKeep(x, y)) samples.push(at(x, y));
    if (!samples.length) return box.slice();
    const ground = [0, 1, 2].map((c) => median(samples.map((p) => pixels.data[p + c])));
    const isGround = (x, y) => [0, 1, 2].every((c) => Math.abs(pixels.data[at(x, y) + c] - ground[c]) <= SLIGHT);
    if (samples.filter((p) => [0, 1, 2].every((c) => Math.abs(pixels.data[p + c] - ground[c]) <= SLIGHT)).length < SLOT_BLANK * samples.length) return box.slice();
    const kept = (x0, y0, x1, y1) => keep.reduce((sum, [kx, ky, kw, kh]) => sum + Math.max(0, Math.min(x1, kx + kw) - Math.max(x0, kx)) * Math.max(0, Math.min(y1, ky + kh) - Math.max(y0, ky)), 0);
    const given = kept(r.x0, r.y0, r.x1, r.y1);
    // `edge` is the line just inside the side; the line just outside it is a step out.
    const meets = (side, edge) => {
      const horizontal = side === 'top' || side === 'bottom';
      const out = side === 'left' || side === 'top' ? edge - 1 : edge + 1;
      if (edge < 0 || out < 0 || edge >= (horizontal ? pixels.height : pixels.width) || out >= (horizontal ? pixels.height : pixels.width)) return false;
      const [from, to] = horizontal ? [r.x0, r.x1] : [r.y0, r.y1];
      let read = 0; let met = 0; const outside = [];
      for (let i = from; i < to; i += 1) {
        const [ix, iy, ox, oy] = horizontal ? [i, edge, i, out] : [edge, i, out, i];
        if (inKeep(ix, iy) || inKeep(ox, oy)) continue;
        read += 1; outside.push(at(ox, oy));
        if (isGround(ix, iy) && !isGround(ox, oy)) met += 1;
      }
      if (4 * read < to - from || 2 * met < read) return false;
      // The other colour is one that holds, a border or another ground; the glyphs of a neighbouring line are not.
      const colour = [0, 1, 2].map((c) => median(outside.map((p) => pixels.data[p + c])));
      const holding = outside.filter((p) => [0, 1, 2].every((c) => Math.abs(pixels.data[p + c] - colour[c]) <= SLIGHT)).length;
      return 2 * holding >= read && !sameColour(colour, ground, SLIGHT);
    };
    const snapped = { ...r };
    for (const side of SIDES) {
      const inward = side === 'left' || side === 'top' ? 1 : -1;
      const first = { left: r.x0, top: r.y0, right: r.x1 - 1, bottom: r.y1 - 1 }[side];
      for (let d = 0; d <= SLOT_SNAP; d += 1) {
        const found = [first + inward * d, first - inward * d].find((edge) => {
          // Against the rect as the earlier edges left it: two edges moving out together may not take a fill's corner.
          const moved = { ...snapped, [KEY_OF[side]]: side === 'left' || side === 'top' ? edge : edge + 1 };
          if (moved.x1 - moved.x0 < SLOT_LEAST || moved.y1 - moved.y0 < SLOT_LEAST) return false;
          return kept(moved.x0, moved.y0, moved.x1, moved.y1) <= given && meets(side, edge);
        });
        if (found === undefined) continue;
        snapped[KEY_OF[side]] = side === 'left' || side === 'top' ? found : found + 1;
        break;
      }
    }
    const x0 = snapped.x0 !== r.x0 ? snapped.x0 : box[0]; const y0 = snapped.y0 !== r.y0 ? snapped.y0 : box[1];
    const x1 = snapped.x1 !== r.x1 ? snapped.x1 : box[0] + box[2]; const y1 = snapped.y1 !== r.y1 ? snapped.y1 : box[1] + box[3];
    return [x0, y0, x1 - x0, y1 - y0];
  }

  const FRAME_REACH = 96 * scale;
  const FRAME_MARGIN = 16 * scale;
  // An edge moved inward lands this far inside the band, so the lens's
  // resampling never blends the content it just left into the first row.
  const FRAME_CUSHION = 2 * scale;

  // The frame is the capture's guess, and its edge can land mid-word. An
  // edge is clean when its line sits in a band of BAND clean lines (a run cut
  // short by the image counts), so a gap between letters does not pass. An
  // unclean edge moves inward first, which reveals nothing new, to the nearest
  // band that leaves FRAME_MARGIN pixels to the marks; failing that, outward to
  // the nearest band within FRAME_REACH; failing that it settles in a word space
  // (wordGap: inward to CROP_MARGIN_MIN of the marks, then outward within
  // WORD_REACH) and is reported `word`, or stays and is reported
  // `cut`. Edges are tested again after any move, since a moved edge changes the
  // lines the others span; each edge moves at most once each way. Untouched
  // coordinates keep their given values. `edges` names each side for where it
  // ended up against where it started: `clean`, `inward`, `outward`, `word`, `cut`, or
  // `image` when an edge that is not held sits on the image's own boundary,
  // where flush content cannot be told from cut content and there is nowhere to
  // move. An edge through a `keep` box (a redaction fill) moves out to its far
  // side first. With no marks an edge has nowhere to go inward. With
  // `options.fixed` the frame is a boundary the caller drew to hide what lies
  // beside it: no edge moves outward, and an edge a fill cuts stays where the
  // frame put it, so the fill is clipped there. With `options.stay` no edge
  // moves at all: each is named `clean`, `cut` or `image` where it stands.
  // `options.stripOut` lists the sides a word step may take outward past a strip
  // (one only acrossStrips lets it find), every side when it is not given;
  // `stripOut` in the result names the sides that took one. `options.noWord`
  // lists the sides that take no word step: such an edge stays, `cut`.
  function cleanFrame(pixels, frame, marksBox, options) {
    const ignore = (options && options.ignore) || [];
    const keep = (options && options.keep) || [];
    const fixed = Boolean(options && options.fixed);
    const stay = Boolean(options && options.stay);
    const noWord = (options && options.noWord) || [];
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
    // Strips count only for the word step, which reaches WORD_REACH out; an imported edge reads LIFT_BAND beyond
    // itself to judge a word space.
    const strips = Object.fromEntries(SIDES.map((side) => [side, acrossStrips(pixels, r, side, -pastMarks(r, side, marksBox), fixed ? LIFT_BAND : WORD_REACH, image, ignore, marksBox, fixed ? origin : image)]));
    const ignoreOf = (side) => [...ignore, ...strips[side].ignore];
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
    if (!stay) for (const side of SIDES) clearKeep(side);
    const used = Object.fromEntries(SIDES.map((side) => [side, { inward: false, outward: false }]));
    for (let again = !stay; again;) {
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
    const toMarks = (side) => room(side) + FRAME_MARGIN - CROP_MARGIN_MIN;
    const inGap = (side) => held(pixels, r, side, within(image), ignoreOf(side), LIFT_BAND, strips[side].content);
    const word = {};
    const stripOut = {};
    const outwardOf = (side, at) => (side === 'left' || side === 'top' ? at < r[KEY_OF[side]] : at > r[KEY_OF[side]]);
    for (const side of stay ? [] : SIDES) {
      if (isHeld(side) || onImage(side) || noWord.includes(side)) continue;
      const look = (lines, content) => wordGap(pixels, r, side, marksBox ? toMarks(side) : 0, fixed ? 0 : WORD_REACH, limit, lines, content);
      let at = look(ignoreOf(side), strips[side].content);
      if (at !== null && outwardOf(side, at) && at !== look(ignore)) {
        if (options && options.stripOut && !options.stripOut.includes(side)) at = look(ignore);
        else stripOut[side] = true;
      }
      if (at === null) continue;
      word[side] = { from: r[KEY_OF[side]], moved: Boolean(moved[side]) };
      r[KEY_OF[side]] = at; moved[side] = true; clearKeep(side);
    }
    // A word space another edge's move closed, or a fill pushed the edge out of, leaves the edge where it was.
    for (const side of Object.keys(word)) {
      if (inGap(side)) continue;
      r[KEY_OF[side]] = word[side].from;
      delete stripOut[side];
      if (!word[side].moved) delete moved[side];
      delete word[side];
    }
    const edges = Object.fromEntries(SIDES.map((side) => {
      const isIn = isHeld(side);
      if (word[side]) return [side, 'word'];
      if (!isIn && onImage(side)) return [side, 'image'];
      return [side, edgeName(side, origin[KEY_OF[side]], r[KEY_OF[side]], isIn)];
    }));
    const out = frame.slice();
    const x0 = moved.left ? r.x0 : frame[0]; const y0 = moved.top ? r.y0 : frame[1];
    const x1 = moved.right ? r.x1 : frame[0] + frame[2]; const y1 = moved.bottom ? r.y1 : frame[1] + frame[3];
    if (Object.keys(moved).length) { out[0] = x0; out[1] = y0; out[2] = x1 - x0; out[3] = y1 - y0; }
    return { frame: out, edges, cut: SIDES.some((side) => edges[side] === 'cut'), stripOut };
  }

  function edgeName(side, origin, final, isHeld) {
    if (!isHeld) return 'cut';
    const inwardBy = side === 'left' || side === 'top' ? final - origin : origin - final;
    return inwardBy > 0 ? 'inward' : inwardBy < 0 ? 'outward' : 'clean';
  }

  const SLIVER = 6 * scale;
  const AIR = 12 * scale;
  // The capture pads the element it frames by 12 CSS px of whatever lies beside it.
  const FRAME_PAD = 12 * scale;

  // A frame carries a strip of the page beside the element it was captured
  // round, and inside that the card's border: one-colour lines that read as a
  // stray rule on a board. Two things go. First the strip: the lines at an edge
  // that are one colour (corners aside), FRAME_PAD of them or fewer, when the
  // line that ends them is one colour too and another one, a border or the
  // card's own ground. That line is read between the strips of the two sides
  // beside it, so the four sides are settled together. Then a sliver: lines of
  // one colour up to such a line, SLIVER or fewer in all; twice, for a strip
  // and the border after it. A rule of RULE_THICKNESS lines or fewer goes
  // when the line after it is of another colour, one colour or not. Wider
  // lines that end at content are that content's margin and stay, and so
  // does a card with corners rounder than CORNER, whose border line is not
  // one colour, unless the whole card can be entered (below). An edge never
  // reaches `marksBox`. With `options.fixed` the frame may only move onto
  // ground that needs no air.
  function edgeSliver(pixels, frame, marksBox, options) {
    if (CSS_VIEW) {
      const view = cssView(pixels, frame, NO_REACH);
      const given = view.to(frame);
      const found = atOne().edgeSliver(view.pixels, given, marksBox && view.to(marksBox), options);
      const [x, y, w, h] = view.from(found);
      // A side that stays keeps the coordinate it was given, fraction and all.
      const x0 = found[0] !== given[0] ? x : frame[0]; const y0 = found[1] !== given[1] ? y : frame[1];
      const x1 = found[0] + found[2] !== given[0] + given[2] ? x + w : frame[0] + frame[2]; const y1 = found[1] + found[3] !== given[1] + given[3] ? y + h : frame[1] + frame[3];
      return [x0, y0, x1 - x0, y1 - y0];
    }
    const r = rectOf(frame, boundsOf(pixels, null));
    const room = (side) => roomTo(r, marksBox, side);
    const extentOf = (side) => (side === 'left' || side === 'right' ? r.x1 - r.x0 : r.y1 - r.y0);
    // How many lines from the edge are the colour `first`, or 0 when there are more than `most`: a band of its own.
    const runOf = (side, first, most) => {
      let depth = 0;
      while (depth <= most && lineIs(pixels, lineAt(r, side, -depth), first, SLIGHT)) depth += 1;
      return depth > most ? 0 : depth;
    };
    // A run ends at a line that is one colour too, and another one.
    const endsAtAnother = (line, first) => {
      const colour = line.to > line.from ? lineMedian(pixels, line) : null;
      return Boolean(colour) && lineIs(pixels, line, colour, SLIGHT) && !sameColour(colour, first, SLIGHT);
    };
    const moved = {};
    const cut = (side, depth) => { r[KEY_OF[side]] += side === 'left' || side === 'top' ? depth : -depth; moved[side] = true; };

    const edgeColour = Object.fromEntries(SIDES.map((side) => [side, extentOf(side) > 0 ? lineMedian(pixels, lineAt(r, side, 0)) : null]));
    const strip = Object.fromEntries(SIDES.map((side) => [side, edgeColour[side] ? runOf(side, edgeColour[side], Math.min(FRAME_PAD, extentOf(side) - 1, room(side) - 1)) : 0]));

    // A card with round corners. Inside the strips its edge is straight but for
    // its corners: the middle of each of the four lines there is one colour.
    // The four edges then move in together, a line at a time and FRAME_PAD at
    // most, to the first rectangle whose four edge lines are each wholly the
    // card's ground: past the border and as far into the corners as the arcs
    // reach. Something must lie between, on every side: a border, or a strip of
    // another colour. Content within that distance of the border on any side
    // leaves no such rectangle, and the card keeps its outline whole.
    const base = { x0: r.x0 + strip.left, y0: r.y0 + strip.top, x1: r.x1 - strip.right, y1: r.y1 - strip.bottom };
    const middleOf = (line) => { const ends = Math.min(2 * FRAME_PAD, (line.to - line.from) >> 2); return { ...line, from: line.from + ends, to: line.to - ends }; };
    const straight = Object.fromEntries(SIDES.map((side) => {
      const line = middleOf(lineAt(base, side, 0));
      const colour = line.to > line.from ? lineMedian(pixels, line) : null;
      return [side, colour && lineIs(pixels, line, colour, SLIGHT, true) ? colour : null];
    }));
    const insetFor = () => {
      if (SIDES.some((side) => !straight[side])) return 0;
      for (let k = 0; k <= FRAME_PAD; k += 1) {
        const inner = { x0: base.x0 + k, y0: base.y0 + k, x1: base.x1 - k, y1: base.y1 - k };
        if (inner.x1 - inner.x0 <= 2 * AIR || inner.y1 - inner.y0 <= 2 * AIR || SIDES.some((side) => strip[side] + k >= room(side))) return 0;
        const ground = lineMedian(pixels, lineAt(inner, 'top', 0));
        if (!SIDES.every((side) => lineIs(pixels, lineAt(inner, side, 0), ground, SLIGHT, true))) continue;
        const between = SIDES.every((side) => !sameColour(straight[side], ground, SLIGHT) || (strip[side] > 0 && !sameColour(edgeColour[side], ground, SLIGHT)));
        // A frame that is all that hides what lies beside it gets no air, so it moves only onto AIR of ground.
        const roomy = !(options && options.fixed) || SIDES.every((side) => Array.from({ length: AIR }, (_, n) => lineAt(inner, side, -n)).every((line) => lineIs(pixels, line, ground, SLIGHT)));
        return k > 0 && between && roomy ? k : 0;
      }
      return 0;
    };
    const entered = insetFor();
    if (entered) {
      const [x0, y0, x1, y1] = [base.x0 + entered, base.y0 + entered, base.x1 - entered, base.y1 - entered];
      return [x0, y0, x1 - x0, y1 - y0];
    }

    for (let again = true; again;) {
      again = false;
      const inner = { x0: r.x0 + strip.left, y0: r.y0 + strip.top, x1: r.x1 - strip.right, y1: r.y1 - strip.bottom };
      for (const side of SIDES) {
        if (!strip[side] || endsAtAnother(lineAt(inner, side, 0), edgeColour[side])) continue;
        strip[side] = 0; again = true;
      }
    }
    for (const side of SIDES) if (strip[side]) cut(side, strip[side]);

    for (const side of SIDES) {
      let total = 0;
      for (let pass = 0; pass < 2; pass += 1) {
        const most = Math.min(SLIVER - total, extentOf(side) - 1, room(side) - 1);
        const first = extentOf(side) > 0 ? lineMedian(pixels, lineAt(r, side, 0)) : null;
        const depth = first ? runOf(side, first, most) : 0;
        if (!depth) break;
        const end = lineAt(r, side, -depth);
        // Content may stand flush against a rule, so the line after one need only be of another colour.
        if (depth <= RULE_THICKNESS ? sameColour(lineMedian(pixels, end), first, SLIGHT) : !endsAtAnother(end, first)) break;
        cut(side, depth); total += depth;
      }
    }
    if (!Object.keys(moved).length) return frame.slice();
    const x0 = moved.left ? r.x0 : frame[0]; const y0 = moved.top ? r.y0 : frame[1];
    const x1 = moved.right ? r.x1 : frame[0] + frame[2]; const y1 = moved.bottom ? r.y1 : frame[1] + frame[3];
    return [x0, y0, x1 - x0, y1 - y0];
  }

  // How much ground lies just inside each edge of the frame, counted up to AIR,
  // and that ground's colour. Ground is a clean line (a rule may cross it) of
  // the edge line's colour. An edge line that is not clean has no ground inside
  // it: content stands flush against the edge when the line just outside is
  // one colour, so nothing crosses, and its ground is then the edge line's
  // median, which the next line in shares (a border's line shares it with
  // neither side). `ground` is null when content crosses the edge, and when the edge's
  // colour ends within SLIVER lines at a line of another colour, which is a
  // sliver the marks kept at the edge: painting more of it would draw a bar.
  function edgeAir(pixels, frame) {
    if (CSS_VIEW) {
      const view = cssView(pixels, frame, { left: 1, top: 1, right: 1, bottom: 1 });
      const found = atOne().edgeAir(view.pixels, view.to(frame));
      return Object.fromEntries(SIDES.map((side) => [side, { have: found[side].have * scale, ground: found[side].ground }]));
    }
    const r = rectOf(frame, boundsOf(pixels, null));
    return Object.fromEntries(SIDES.map((side) => {
      const none = [side, { have: 0, ground: null }];
      const extent = side === 'left' || side === 'right' ? r.x1 - r.x0 : r.y1 - r.y0;
      const ground = extent > 0 ? lineMedian(pixels, lineAt(r, side, 0)) : null;
      if (!ground) return none;
      if (!lineIsClean(pixels, lineAt(r, side, 0), [])) {
        const beside = lineAt(r, side, 1);
        const flush = lineInImage(pixels, beside) && lineIs(pixels, beside, lineMedian(pixels, beside), SLIGHT)
          && extent > 1 && sameColour(lineMedian(pixels, lineAt(r, side, -1)), ground, SLIGHT);
        return flush ? [side, { have: 0, ground }] : none;
      }
      const most = Math.min(AIR, extent);
      let have = 1;
      while (have < most && lineIsClean(pixels, lineAt(r, side, -have), []) && sameColour(lineMedian(pixels, lineAt(r, side, -have)), ground, SLIGHT)) have += 1;
      if (have <= SLIVER && have < most && !sameColour(lineMedian(pixels, lineAt(r, side, -have)), ground, SLIGHT)) return none;
      return [side, { have, ground }];
    }));
  }

  // A divider a few lines inside an edge reads as the edge of a crop gone
  // wrong. A side comes off one when, from its edge inward, there are AIR or
  // fewer lines of one ground colour (none when the rule lies on the edge),
  // then a rule (edgeRuleAt), then BAND clean lines of one colour before any
  // content. The edge moves past the rule and FRAME_CUSHION lines on, so the
  // rule lies that far outside it. It never comes within CROP_MARGIN_MIN of
  // `marksBox` nor crosses an `options.keep` rect; pixels inside an
  // `options.ignore` rect are not read. Every side is read on the box as given.
  // `shed` is how far each side moved in. `takes[side][depth]` says whether the
  // side could lose that many lines instead, up to the deepest shed there is:
  // lines of its ground, and its rule only whole, under the same two limits.
  // A panel of a pair takes a depth the others shed, so they keep one rectangle.
  const SHED_MOST = AIR + RULE_THICKNESS + FRAME_CUSHION;
  const extentsOf = (r) => ({ left: r.x1 - r.x0, right: r.x1 - r.x0, top: r.y1 - r.y0, bottom: r.y1 - r.y0 });
  // Lines between the side of integer rect r and `marksBox`, Infinity without one.
  function roomTo(r, marksBox, side) {
    if (!marksBox) return Infinity;
    if (side === 'left') return Math.floor(marksBox[0]) - r.x0;
    if (side === 'top') return Math.floor(marksBox[1]) - r.y0;
    if (side === 'right') return r.x1 - Math.ceil(marksBox[0] + marksBox[2]);
    return r.y1 - Math.ceil(marksBox[1] + marksBox[3]);
  }
  // The `depth` lines of integer rect r along `side`.
  function stripIn(r, side, depth) {
    if (side === 'left') return [r.x0, r.y0, depth, r.y1 - r.y0];
    if (side === 'top') return [r.x0, r.y0, r.x1 - r.x0, depth];
    if (side === 'right') return [r.x1 - depth, r.y0, depth, r.y1 - r.y0];
    return [r.x0, r.y1 - depth, r.x1 - r.x0, depth];
  }
  // A side's `takes` from a CSS view, in the capture px of a whole scale: whole CSS px of the 1x answer.
  const takesAtScale = (found) => Array.from({ length: (found.length - 1) * scale + 1 }, (_, depth) => depth % scale === 0 && Boolean(found[depth / scale]));
  // shedEdgeRules or orphanBands (`name`) on the CSS view of `box`, with its depths per side (`key`) in capture px.
  function sidesAtCss(name, key, pixels, box, marksBox, keep, ignore) {
    const view = cssView(pixels, box, NO_REACH);
    const found = atOne()[name](view.pixels, view.to(box), marksBox && view.to(marksBox), { keep: keep.map(view.to), ignore: ignore.map(view.to) });
    const by = Object.fromEntries(SIDES.map((side) => [side, found[key][side] * scale]));
    return { box: inset(box, by), [key]: by, takes: Object.fromEntries(SIDES.map((side) => [side, takesAtScale(found.takes[side])])) };
  }
  function shedEdgeRules(pixels, box, marksBox, options) {
    const keep = (options && options.keep) || []; const ignore = (options && options.ignore) || [];
    if (CSS_VIEW) return sidesAtCss('shedEdgeRules', 'shed', pixels, box, marksBox, keep, ignore);
    const r = rectOf(box, boundsOf(pixels, null));
    const extent = extentsOf(r);
    const room = (side) => roomTo(r, marksBox, side);
    const strip = (side, depth) => stripIn(r, side, depth);
    const sideOf = (side) => {
      const step = side === 'left' || side === 'top' ? 1 : -1;
      const lineIn = (depth) => lineAt(r, side, -depth);
      const ground = (depth) => (depth < extent[side] && lineIsClean(pixels, lineIn(depth), ignore) ? lineMedian(pixels, lineIn(depth), ignore) : null);
      const edge = ground(0);
      // The first rule from the edge; `banded` when BAND clean lines of one colour follow it.
      let rule = null;
      for (let lead = 0; lead <= AIR && lead < extent[side]; lead += 1) {
        if (lead > 0) {
          const own = ground(lead - 1);
          if (!edge || !own || !sameColour(own, edge, SLIGHT)) break;
        }
        const found = edgeRuleAt(pixels, lineIn(lead), { step, ground: lead ? edge : null, ignore });
        if (!found) continue;
        const end = lead + found.thickness;
        const beyond = ground(end);
        const banded = Boolean(beyond) && Array.from({ length: BAND }, (_, n) => ground(end + n)).every((own) => Boolean(own) && sameColour(own, beyond, SLIGHT));
        rule = rule || { start: lead, end, beyond, banded };
        if (banded) { rule = { start: lead, end, beyond, banded }; break; }
      }
      const takes = [true];
      for (let depth = 1, lines = true; depth <= SHED_MOST; depth += 1) {
        const k = depth - 1;
        const inRule = rule && k >= rule.start && k < rule.end;
        const own = inRule ? null : ground(k);
        lines = lines && (inRule || (Boolean(own) && sameColour(own, rule && k >= rule.end ? rule.beyond : edge, SLIGHT)));
        takes.push(lines && (!rule || depth >= rule.end) && depth <= room(side) - CROP_MARGIN_MIN && !keep.some((b) => hits(b, strip(side, depth))));
      }
      const depth = rule && rule.banded ? rule.end + FRAME_CUSHION : 0;
      return { shed: depth && takes[depth] ? depth : 0, takes };
    };
    const sides = Object.fromEntries(SIDES.map((side) => [side, sideOf(side)]));
    const shed = Object.fromEntries(SIDES.map((side) => [side, sides[side].shed]));
    return { box: inset(box, shed), shed, takes: Object.fromEntries(SIDES.map((side) => [side, sides[side].takes])) };
  }

  // How far, in CSS px, each side of a pair of one size comes in: the deepest
  // shed of any of its `panels` ({ shed, takes, scale }, from shedEdgeRules)
  // that every panel can take, or the deepest that all can, 0 at the least.
  // The depths looked at are those a panel can take; at a fractional scale a
  // depth in CSS px is a whole number of capture px in only some panels.
  function sharedShed(panels) {
    const whole = (n) => Math.abs(n - Math.round(n)) < 1e-6;
    const takenBy = (src, side, css) => whole(css * src.scale) && Boolean(src.takes?.[side][Math.round(css * src.scale)]);
    return Object.fromEntries(SIDES.map((side) => {
      const most = Math.max(...panels.map((src) => src.shed[side] / src.scale));
      const depths = panels.flatMap((src) => (src.takes?.[side] || []).flatMap((ok, k) => (ok && k > 0 && k / src.scale <= most + 1e-9 ? [k / src.scale] : [])));
      const deepest = depths.sort((a, b) => b - a).find((css) => panels.every((src) => takenBy(src, side, css)));
      return [side, deepest ?? 0];
    }));
  }

  // A side is cut past a lone small item: the first content in from its edge,
  // ORPHAN or less on both axes, with ORPHAN_GAP lines of the edge's ground
  // before the next content, which keeps AIR lines. A line of another colour
  // (a strip, a divider) spans the edge and is never such an item. On a left
  // or right side an item with ink anywhere in its own rows past the gap shares
  // a row with text and stays. The item lies ORPHAN_CLEAR or more from
  // `marksBox` and is no keep rect; the edge stays CROP_MARGIN_MIN off
  // `marksBox` and crosses no keep rect; `options.ignore` pixels are not read.
  // `takes[side][depth]` is shedEdgeRules' shape for sharedShed: ground, the
  // item only whole, AIR left inside.
  const ORPHAN = 16 * scale;
  const ORPHAN_GAP = 12 * scale;
  const ORPHAN_CLEAR = 32 * scale;
  function orphanBands(pixels, box, marksBox, options) {
    const keep = (options && options.keep) || []; const ignore = (options && options.ignore) || [];
    if (CSS_VIEW) return sidesAtCss('orphanBands', 'cut', pixels, box, marksBox, keep, ignore);
    const r = rectOf(box, boundsOf(pixels, null));
    const extent = extentsOf(r);
    const air = Math.ceil(AIR);
    const sideOf = (side) => {
      const limit = extent[side];
      const lineIn = (depth) => lineAt(r, side, -depth);
      const edge = limit > 0 ? lineMedian(pixels, lineIn(0), ignore) : null;
      if (!edge) return { cut: 0, takes: [true] };
      const grounds = [];
      const isGround = (depth) => {
        if (grounds[depth] === undefined) {
          const own = lineMedian(pixels, lineIn(depth), ignore);
          grounds[depth] = Boolean(own) && sameColour(own, edge, SLIGHT) && lineIsClean(pixels, lineIn(depth), ignore);
        }
        return grounds[depth];
      };
      let start = 0;
      while (start < limit && isGround(start)) start += 1;
      // The item's lines, a letter gap (under BAND lines of ground) within them joined.
      let end = start;
      for (;;) {
        while (end < limit && !isGround(end)) end += 1;
        let next = end;
        while (next < limit && next - end < BAND && isGround(next)) next += 1;
        if (end - start > ORPHAN || next >= limit || next - end >= BAND) break;
        end = next;
      }
      let next = end;
      while (next < limit && isGround(next)) next += 1;
      const item = start < limit && end - start <= ORPHAN && next < limit && next - end >= ORPHAN_GAP ? itemRect(side, start, end, next, edge) : null;
      const orphan = item && !(marksBox && hits([item[0] - ORPHAN_CLEAR, item[1] - ORPHAN_CLEAR, item[2] + 2 * ORPHAN_CLEAR, item[3] + 2 * ORPHAN_CLEAR], marksBox)) && !keep.some((b) => hits(b, item));
      const takes = [true];
      for (let depth = 1; depth + air <= (orphan ? next : start); depth += 1) {
        const lines = depth + air <= start || (orphan && depth >= end);
        takes.push(lines && depth <= roomTo(r, marksBox, side) - CROP_MARGIN_MIN && !keep.some((b) => hits(b, stripIn(r, side, depth))));
      }
      const deepest = takes.lastIndexOf(true);
      return { cut: orphan && deepest >= end ? deepest : 0, takes };
    };
    // The item between lines `start` and `end` in from `side`: its ink, where pixels differ from the edge's ground
    // by more than TOLERANCE. A rule crossing those lines is not ink: it crosses the ground line past them too.
    // Null when it is no lone item: too long along the edge, or on a left or right side with ink in its own rows
    // anywhere from `next`, the next content, on.
    function itemRect(side, start, end, next, ground) {
      const lineIn = (depth) => lineAt(r, side, -depth);
      const first = lineIn(0);
      const trim = first.to - first.from > 2 * CORNER ? CORNER : 0;
      const inkAt = (line, i) => !inRects(ignore, line, i) && ground.some((v, c) => Math.abs(pixels.data[pixelOf(pixels, line, i) + c] - v) > TOLERANCE);
      let lo = Infinity; let hi = -Infinity;
      for (let i = first.from + trim; i < first.to - trim; i += 1) {
        if (inkAt(lineIn(end), i)) continue;
        for (let depth = start; depth < end; depth += 1) {
          if (inkAt(lineIn(depth), i)) { lo = Math.min(lo, i); hi = Math.max(hi, i); break; }
        }
      }
      if (hi < lo || hi - lo + 1 > ORPHAN) return null;
      if (side === 'left' || side === 'right') {
        for (let depth = next; depth < extent[side]; depth += 1) {
          for (let i = lo; i <= hi; i += 1) if (inkAt(lineIn(depth), i)) return null;
        }
      }
      const across = { left: r.x0 + start, top: r.y0 + start, right: r.x1 - end, bottom: r.y1 - end }[side];
      return side === 'left' || side === 'right' ? [across, lo, end - start, hi - lo + 1] : [lo, across, hi - lo + 1, end - start];
    }
    const sides = Object.fromEntries(SIDES.map((side) => [side, sideOf(side)]));
    const cut = Object.fromEntries(SIDES.map((side) => [side, sides[side].cut]));
    return { box: inset(box, cut), cut, takes: Object.fromEntries(SIDES.map((side) => [side, sides[side].takes])) };
  }

  const CLUSTER_GAP = 12 * scale;
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
  // content: it is from LEADER_THROUGH samples on.
  const LEADER_THROUGH = 3;

  // One side for every label of a board: the side that is open and not hard
  // for every panel, and far for none if there is such a side. A far side has
  // a long run over clean ground, which reads worse than a short one and
  // better than pins, so it is taken before the board gives up. Of two, the
  // one striking LEADER_THROUGH fewer samples if they differ by that much;
  // else the right, which keeps a label beside its mark and the board short,
  // unless the runs to the bottom total under half of those to the right.
  // With no such side the board is pinned and its legend takes `fallback`.
  // Each survey is { right, bottom }, a side being { open, hard, far, ink, run }.
  function pickBoardSide(surveys, options) {
    const total = (name) => surveys.reduce((sum, s) => ({
      side: name, open: sum.open && s[name].open, hard: sum.hard || s[name].hard, far: sum.far || Boolean(s[name].far), ink: sum.ink + s[name].ink, run: sum.run + s[name].run,
    }), { side: name, open: true, hard: false, far: false, ink: 0, run: 0 });
    const clean = (options.forced ? [options.forced] : ['right', 'bottom']).map(total).filter((s) => s.open && !s.hard);
    const easy = clean.some((s) => !s.far) ? clean.filter((s) => !s.far) : clean;
    if (!easy.length) return { side: options.forced || options.fallback, pinned: true };
    const [first, second] = easy;
    if (!second) return { side: first.side, pinned: false };
    const cleaner = Math.abs(first.ink - second.ink) >= LEADER_THROUGH ? (first.ink < second.ink ? first : second) : null;
    return { side: (cleaner ?? (second.run < first.run / 2 ? second : first)).side, pinned: false };
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

  // The one size the panels of a pair or steps board share, however different
  // the frames (in CSS px). In a row it is a height: the board's width budget
  // shared by their shapes, never enlarging the shortest frame past
  // PANEL_MAX_S and never under PANEL_MIN_H. A row more than STACK_OVER times
  // as wide as it is high is a strip nothing can be read in: its panels are
  // stacked in a column at one width, STACK_WIDTH or the narrowest frame at
  // PANEL_MAX_S.
  const PANEL_BUDGET = 1120;
  const PANEL_MIN_H = 96;
  const PANEL_MAX_H = 360;
  const PANEL_MAX_S = 1;
  const STACK_OVER = 9;
  const STACK_WIDTH = 720;
  function panelSizes(frames) {
    const shapes = frames.reduce((sum, f) => sum + f[2] / f[3], 0);
    if (shapes > STACK_OVER) return { stacked: true, width: Math.round(Math.min(STACK_WIDTH, ...frames.map((f) => f[2] * PANEL_MAX_S))) };
    const shortest = Math.min(...frames.map((f) => f[3]));
    const wanted = Math.min(PANEL_MAX_H, PANEL_MAX_S * shortest, PANEL_BUDGET / shapes);
    return { stacked: false, height: Math.max(PANEL_MIN_H, Math.round(wanted)) };
  }

  // Steps read as one page walked through, so frames that one size would draw at zooms more than ZOOM_SPREAD apart
  // are drawn at one zoom instead (board px per CSS px): the most the budget, the height cap or, stacked, the
  // stack's width allows, never past PANEL_MAX_S. null where the zooms stay close, or that zoom is below ZOOM_MIN.
  const ZOOM_SPREAD = 1.25;
  const ZOOM_MIN = 0.55;
  function sharedZoom(frames, sizes) {
    const own = frames.map((f) => (sizes.stacked ? sizes.width / f[2] : sizes.height / f[3]));
    if (Math.max(...own) <= ZOOM_SPREAD * Math.min(...own)) return null;
    const zoom = sizes.stacked
      ? Math.min(PANEL_MAX_S, STACK_WIDTH / Math.max(...frames.map((f) => f[2])))
      : Math.min(PANEL_MAX_S, PANEL_BUDGET / frames.reduce((sum, f) => sum + f[2], 0), PANEL_MAX_H / Math.max(...frames.map((f) => f[3])));
    return zoom >= ZOOM_MIN ? zoom : null;
  }

  // A loupe's lens shows the circle `radius` capture px about `centre`. A glyph the circle cuts to a sliver reads
  // as an artefact at its edge. The circle moves, in whole CSS px and the least it can, to take every glyph it
  // cuts in whole; failing that, to take in whole each glyph it shows nearly whole (half its core or more), so that
  // it cuts nothing but slivers. Either way `target` stays inside it a CSS px clear of its edge, and a glyph it
  // showed whole stays whole. Where no move does, the circle stays on its target. `hide` names the pixels of each
  // sliver left and the pixels round them, which the lens paints `paint`: the ground either side on their row.
  // A glyph is a run of core ink, past half the contrast of the region beside the target, with the antialiased
  // ink round it, read only inside `bounds`: one the circle could hold whole that touches neither the target nor
  // a `keep` rect. Antialiasing joins neighbouring letters; their cores stand apart. Longer ink reads as running
  // on past the lens. A pixel within a px of the circle shows, since the lens resamples across it; only a core
  // pixel past the circle cuts a glyph.
  function lensView(pixels, centre, radius, target, { bounds, keep = [] }) {
    const b = boundsOf(pixels, bounds);
    const reach = 2 * radius + 2;
    const x0 = Math.max(b.x0, Math.floor(centre[0] - reach)); const x1 = Math.min(b.x1, Math.ceil(centre[0] + reach));
    const y0 = Math.max(b.y0, Math.floor(centre[1] - reach)); const y1 = Math.min(b.y1, Math.ceil(centre[1] + reach));
    const stay = { centre, hide: [], paint: [] };
    if (x1 <= x0 || y1 <= y0) return stay;
    const w = x1 - x0; const h = y1 - y0;
    const at = (x, y) => (y * pixels.width + x) * 4;
    const rim = [[], [], []];
    const r0 = Math.round(radius);
    for (let i = -r0; i <= r0; i += 1) {
      for (const [x, y] of [[i, -r0], [i, r0], [-r0, i], [r0, i]]) {
        const px = Math.floor(centre[0]) + x; const py = Math.floor(centre[1]) + y;
        if (px < x0 || py < y0 || px >= x1 || py >= y1) continue;
        rim.forEach((values, c) => values.push(pixels.data[at(px, py) + c]));
      }
    }
    if (!rim[0].length) return stay;
    const ground = rim.map(median);
    const onTarget = (n) => hits([x0 + (n % w), y0 + Math.floor(n / w), 1, 1], target);
    const diff = new Uint8Array(w * h);
    let most = 0;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const n = (y - y0) * w + x - x0;
        diff[n] = Math.max(...ground.map((v, c) => Math.abs(pixels.data[at(x, y) + c] - v)));
        if (!onTarget(n)) most = Math.max(most, diff[n]);
      }
    }
    const core = Math.max(TOLERANCE, most / 2);
    const label = new Int32Array(w * h).fill(-1);
    const members = new Uint8Array(w * h);
    const near = (i, visit) => {
      const x = i % w; const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) if ((dx || dy) && x + dx >= 0 && y + dy >= 0 && x + dx < w && y + dy < h) visit((y + dy) * w + x + dx);
      }
    };
    const glyphs = [];
    for (let start = 0; start < w * h; start += 1) {
      if (diff[start] <= core || label[start] >= 0) continue;
      const id = glyphs.length; const run = [start]; label[start] = id;
      for (let k = 0; k < run.length; k += 1) near(run[k], (n) => { if (diff[n] > core && label[n] < 0) { label[n] = id; run.push(n); } });
      const edge = new Set();
      for (const i of run) near(i, (n) => { if (diff[n] > TOLERANCE && diff[n] <= core) edge.add(n); });
      const all = [...run, ...edge];
      for (const i of all) members[i] += 1;
      let [lx, ly, hx, hy] = [w, h, 0, 0];
      for (const i of all) { const x = i % w; const y = (i - x) / w; lx = Math.min(lx, x); ly = Math.min(ly, y); hx = Math.max(hx, x); hy = Math.max(hy, y); }
      const box = [x0 + lx, y0 + ly, hx - lx + 1, hy - ly + 1];
      const onEdge = (box[0] === x0 && x0 > b.x0) || (box[1] === y0 && y0 > b.y0) || (box[0] + box[2] === x1 && x1 < b.x1) || (box[1] + box[3] === y1 && y1 < b.y1);
      glyphs.push({ run, all, box, glyph: !onEdge && Math.max(box[2], box[3]) <= radius && !hits(box, target) && !keep.some((k) => hits(box, k)) });
    }
    const candidates = glyphs.filter((g) => g.glyph);
    const away = (c, i) => Math.hypot(x0 + (i % w) + 0.5 - c[0], y0 + Math.floor(i / w) + 0.5 - c[1]);
    const whole = (c, g) => g.run.every((i) => away(c, i) + Math.SQRT1_2 < radius);
    const seen = (c, g) => {
      const [bx, by, bw, bh] = g.box;
      const nearest = Math.hypot(Math.max(bx + 0.5 - c[0], 0, c[0] - bx - bw + 0.5), Math.max(by + 0.5 - c[1], 0, c[1] - by - bh + 0.5));
      return nearest < radius + 1 && g.all.some((i) => away(c, i) < radius + 1);
    };
    const cut = (c, g) => seen(c, g) && !whole(c, g);
    const sliver = (c, g) => cut(c, g) && 2 * g.run.filter((i) => away(c, i) < radius).length < g.run.length;
    const cuts = candidates.filter((g) => cut(centre, g));
    if (!cuts.length) return stay;
    const shown = candidates.filter((g) => seen(centre, g) && whole(centre, g));
    const nearly = cuts.filter((g) => !sliver(centre, g));
    const [tx, ty, tw, th] = target;
    const holds = (c) => [[tx, ty], [tx + tw, ty], [tx, ty + th], [tx + tw, ty + th]].every(([x, y]) => Math.hypot(x - c[0], y - c[1]) <= radius - scale);
    const steps = Math.floor(radius / scale);
    const moves = [];
    for (let i = -steps; i <= steps; i += 1) for (let j = -steps; j <= steps; j += 1) if (i || j) moves.push([i * scale, j * scale]);
    moves.sort((p, q) => Math.hypot(...p) - Math.hypot(...q));
    const keeps = (c) => shown.every((g) => whole(c, g));
    const leaving = (c, slivers) => {
      const hidden = new Uint8Array(w * h);
      for (const g of slivers) for (const i of g.all) { hidden[i] += 1; near(i, (n) => { if (!members[n]) hidden[n] = Math.max(hidden[n], 1); }); }
      const hide = [];
      for (let n = 0; n < w * h; n += 1) if (hidden[n] && hidden[n] >= members[n] && !onTarget(n)) hide.push(n);
      const isGround = (n) => !members[n] && !hidden[n] && !onTarget(n);
      const paint = hide.map((n) => {
        const x = n % w; const row = n - x;
        let l = x - 1; while (l >= 0 && !isGround(row + l)) l -= 1;
        let r = x + 1; while (r < w && !isGround(row + r)) r += 1;
        const colour = (k) => [0, 1, 2].map((ch) => pixels.data[at(x0 + k, y0 + row / w) + ch]);
        if (l < 0 && r >= w) return ground.slice();
        if (l < 0) return colour(r);
        if (r >= w) return colour(l);
        const t = (x - l) / (r - l);
        return colour(l).map((v, ch) => Math.round(v + (colour(r)[ch] - v) * t));
      });
      return { centre: c, hide: hide.map((n) => (y0 + Math.floor(n / w)) * pixels.width + x0 + (n % w)), paint };
    };
    for (const [dx, dy] of moves) {
      const c = [centre[0] + dx, centre[1] + dy];
      if (holds(c) && keeps(c) && cuts.every((g) => whole(c, g)) && !candidates.some((g) => cut(c, g))) return { centre: c, hide: [], paint: [] };
    }
    for (const [dx, dy] of [[0, 0], ...moves]) {
      const c = [centre[0] + dx, centre[1] + dy];
      if ((dx || dy) && !holds(c)) continue;
      if (keeps(c) && nearly.every((g) => whole(c, g)) && candidates.every((g) => !cut(c, g) || sliver(c, g))) return leaving(c, candidates.filter((g) => cut(c, g)));
    }
    return leaving(centre, cuts.filter((g) => sliver(centre, g)));
  }

  const LANCZOS_A = 3;
  const lanczos = (t) => {
    if (t === 0) return 1;
    if (t <= -LANCZOS_A || t >= LANCZOS_A) return 0;
    const p = Math.PI * t;
    return (LANCZOS_A * Math.sin(p) * Math.sin(p / LANCZOS_A)) / (p * p);
  };
  // For each of `n` samples across `span` source px from `from`: its taps, each clamped into the pixels [lo, hi),
  // their weights summing to 1, and the source pixels that bound it (`near`): the two either side of its centre,
  // or, for a sample covering more than a source px, every one in its footprint, so a line it covers is kept. A
  // sample covering more than a source px widens the kernel to match.
  function lanczosTaps(from, span, n, lo, hi) {
    const step = span / n; const widen = Math.max(1, step); const reach = LANCZOS_A * widen;
    const at = (j) => Math.min(hi - 1, Math.max(lo, j));
    return Array.from({ length: n }, (_, i) => {
      const centre = from + (i + 0.5) * step - 0.5;
      const first = Math.floor(centre - reach) + 1; const last = Math.floor(centre + reach);
      const index = new Int32Array(last - first + 1); const weight = new Float64Array(last - first + 1);
      let sum = 0;
      for (let j = first; j <= last; j += 1) {
        index[j - first] = at(j);
        weight[j - first] = lanczos((j - centre) / widen);
        sum += weight[j - first];
      }
      for (let k = 0; k < weight.length; k += 1) weight[k] /= sum;
      const [a, b] = widen > 1 ? [Math.ceil(centre - widen / 2), Math.floor(centre + widen / 2)] : [Math.floor(centre), Math.floor(centre) + 1];
      const near = Int32Array.from({ length: b - a + 1 }, (_, k) => at(a + k));
      return { index, weight, near };
    });
  }

  // `src` ([x, y, w, h], capture px, fractional allowed) resampled to outW by outH with a separable Lanczos-3
  // kernel. A tap outside `clip` reads the nearest pixel inside it, so no pixel beyond `clip` reaches the output.
  // Colour is filtered premultiplied by its alpha. Each pass holds every channel within the source values that
  // bound its sample, so the kernel's negative lobes sharpen an edge without ringing a halo round it.
  function resampleLanczos(pixels, src, outW, outH, clip) {
    const out = new Uint8ClampedArray(outW * outH * 4);
    const x0 = Math.max(0, Math.ceil(clip[0])); const y0 = Math.max(0, Math.ceil(clip[1]));
    const x1 = Math.min(pixels.width, Math.floor(clip[0] + clip[2])); const y1 = Math.min(pixels.height, Math.floor(clip[1] + clip[3]));
    if (x1 <= x0 || y1 <= y0) return { data: out, width: outW, height: outH };
    const { data, width } = pixels;
    const cols = lanczosTaps(src[0], src[2], outW, x0, x1);
    const rows = lanczosTaps(src[1], src[3], outH, y0, y1);
    const reach = (taps) => {
      let a = Infinity; let b = -Infinity;
      for (const { index, near } of taps) for (const list of [index, near]) { a = Math.min(a, list[0]); b = Math.max(b, list[list.length - 1]); }
      return [a, b];
    };
    const [c0, c1] = reach(cols); const [r0, r1] = reach(rows);
    const span = c1 - c0 + 1; const rowCount = r1 - r0 + 1;
    const premultiplied = new Float64Array(span * rowCount * 4);
    for (let y = r0; y <= r1; y += 1) {
      for (let x = c0; x <= c1; x += 1) {
        const from = (y * width + x) * 4; const to = ((y - r0) * span + x - c0) * 4; const alpha = data[from + 3];
        premultiplied[to] = data[from] * alpha; premultiplied[to + 1] = data[from + 1] * alpha;
        premultiplied[to + 2] = data[from + 2] * alpha; premultiplied[to + 3] = alpha;
      }
    }
    const across = new Float64Array(outW * rowCount * 4);
    for (let row = 0; row < rowCount; row += 1) {
      const base = row * span;
      for (let ox = 0; ox < outW; ox += 1) {
        const { index, weight, near } = cols[ox];
        const to = (row * outW + ox) * 4;
        for (let c = 0; c < 4; c += 1) {
          let sum = 0;
          for (let k = 0; k < index.length; k += 1) sum += weight[k] * premultiplied[(base + index[k] - c0) * 4 + c];
          let lo = Infinity; let hi = -Infinity;
          for (let k = 0; k < near.length; k += 1) { const v = premultiplied[(base + near[k] - c0) * 4 + c]; if (v < lo) lo = v; if (v > hi) hi = v; }
          across[to + c] = Math.min(hi, Math.max(lo, sum));
        }
      }
    }
    const value = new Float64Array(4);
    for (let oy = 0; oy < outH; oy += 1) {
      const { index, weight, near } = rows[oy];
      for (let ox = 0; ox < outW; ox += 1) {
        for (let c = 0; c < 4; c += 1) {
          let sum = 0;
          for (let k = 0; k < index.length; k += 1) sum += weight[k] * across[((index[k] - r0) * outW + ox) * 4 + c];
          let lo = Infinity; let hi = -Infinity;
          for (let k = 0; k < near.length; k += 1) { const v = across[((near[k] - r0) * outW + ox) * 4 + c]; if (v < lo) lo = v; if (v > hi) hi = v; }
          value[c] = Math.min(hi, Math.max(lo, sum));
        }
        const alpha = value[3];
        if (alpha <= 0) continue;
        const to = (oy * outW + ox) * 4;
        out[to] = value[0] / alpha; out[to + 1] = value[1] / alpha; out[to + 2] = value[2] / alpha; out[to + 3] = alpha;
      }
    }
    return { data: out, width: outW, height: outH };
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
        if (skip.some((s) => inRect(s, x, y))) continue;
        const at = (y * pixels.width + x) * 4;
        values.push(0.299 * pixels.data[at] + 0.587 * pixels.data[at + 1] + 0.114 * pixels.data[at + 2]);
      }
    }
    return median(values) < DARK_BELOW;
  }

    return { lensView, cutLine, growBox, edgeIsClean, cleanPad, tightenBox, adoptLeading, rulesAcross, lineMedian, contentUnder, liftSpot, LIFT_EDGE, cropToMarks, trimBlank, contentBox, fillRect, importFill, snapSlot, holdsContent, cleanFrame, edgeSliver, edgeAir, edgeRuleAt, edgeGround, edgeInGap, shedEdgeRules, sharedShed, orphanBands, pastOutline, droppedOutline, coverBands, onRule, resampleLanczos, edgeName, clusterBoxes, pickBoardSide, collidingLifts, cleanestSpot, pathsCross, hits, inRect, inset, union, components, panelSizes, sharedZoom, frameIsDark, TOLERANCE, LIFT_RING, LIFT_BAND, LIFT_CLEAR, AIR, LEADER_THROUGH };
  }

  globalThis.__composeGeometry = build(1);
  globalThis.__composeGeometry.withScale = build;
}());
