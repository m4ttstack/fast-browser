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

  // How far a lift's padding may extend on each side: up to `max` pixels, but
  // only over clean lines, and only while the LIFT_CLEAR lines beyond the
  // padding are clean too. The lens resamples the capture, so an unclean
  // neighbour line would bleed a faint sliver of content into the padding's
  // outer edge. A hairline is a clean line, so a padding line must also be the
  // colour of the line HAIR beyond it: the padding ends a line short of a
  // hairline, which then never rides on the card. Running out of image or
  // bounds is not a neighbour.
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
      const spaced = (at) => Array.from({ length: LIFT_CLEAR }, (_, n) => state(side, at + 1 + n)).every((s) => s !== 'content');
      while (pad < max && state(side, pad + 1) === 'clean' && spaced(pad + 1) && groundBeyond(side, pad + 1)) pad += 1;
      return pad;
    });
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
  const frameViews = new WeakMap();
  const frameView = (pixels, frame) => {
    if (!frameViews.has(pixels)) frameViews.set(pixels, new Map());
    const views = frameViews.get(pixels); const key = frame.join(',');
    if (!views.has(key)) views.set(key, cssView(pixels, frame, NO_REACH));
    return views.get(key);
  };
  function contentUnder(pixels, frame, S, element, clear) {
    if (CSS_VIEW) {
      let under = null;
      return (card) => {
        if (!under) {
          const view = frameView(pixels, frame);
          under = atOne().contentUnder(view.pixels, view.to(frame), S * scale, element, clear == null ? clear : clear / scale);
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
      return contentIn(region, rules) - (iw > 0 && ih > 0 ? contentIn(rectOfCard(ix, iy, iw, ih), rules) : 0);
    };
  }

  // A card keeps its ring and 2 board px inside the frame's edge.
  const LIFT_EDGE = LIFT_RING + 2;
  // Board px a card keeps from the frame's right and bottom edges while its
  // element allows: a dot and its clear space.
  const DOT_ROOM = 16;

  // Where a card of `size` [W, H] sits for `element`, in a frame `room` [cw, ch]
  // board px: the position that hides the least by `hidden` (contentUnder),
  // looked for in whole board px along each axis between the two ends that
  // still cover the element, and those ends. A tie goes to the position nearest
  // the centred one, then to the lower. An axis on which the card is no larger
  // than the element stays centred. `clamped` says the frame cut short what
  // the rule wanted on either axis; giving up the dot's room is not a clamp.
  function liftSpot(hidden, room, element, size) {
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
  // crop edge through content is worse than a wider crop, or with `hold` stays
  // at its margin and is reported `held`, since on a dense page the frame's edge
  // is no cleaner and the crop would swell to the whole page; the other edges
  // are then tested again on the new crop until none moves. A snapped edge then
  // backs away from content until CROP_AIR clean lines lie inside it, stopping
  // at the first unclean line or the frame.
  function snapCrop(pixels, frame, edge, rect, hold, marksBox) {
    const start = { ...rect };
    const toMarks = (side) => {
      if (side === 'left') return marksBox[0] - start.x0;
      if (side === 'top') return marksBox[1] - start.y0;
      if (side === 'right') return start.x1 - (marksBox[0] + marksBox[2]);
      return start.y1 - (marksBox[1] + marksBox[3]);
    };
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
  // marks as { box, bracket, link } for the margins; `options.floor` (default
  // false) sets whether the crop is held to the context floor, and
  // `options.min` ([w, h]) is a least size that raises it.
  function cropToMarks(pixels, frame, marksBox, options) {
    const whole = { box: frame.slice(), edges: null, cut: false };
    if (!marksBox) return whole;
    const parts = (options && options.parts) || [];
    const bounds = boundsOf(pixels, frame);
    const edge = { x0: bounds.x0, y0: bounds.y0, x1: bounds.x1, y1: bounds.y1 };
    const margins = cropMargins(edge, marksBox, parts, Boolean(options && options.floor), options && options.min);
    if (!margins) return whole;
    const { r, fellBack, held } = snapCrop(pixels, frame, edge, margins.rect, Boolean(options && options.hold), marksBox);
    const box = [r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0];
    if (box[2] * box[3] * 2 >= frame[2] * frame[3]) return whole;
    return { box, edges: edgesOf(margins.atEdge, fellBack, held), cut: heldCut(pixels, frame, box, held) };
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
    const blank = (side, offset) => {
      const line = lineAt(r, side, -offset);
      let faint = 0;
      for (let i = line.from; i < line.to; i += 1) {
        const off = Math.max(...ground[side].map((v, c) => Math.abs(pixels.data[pixelAt(line, i) + c] - v)));
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
    const extent = { left: r.x1 - r.x0, right: r.x1 - r.x0, top: r.y1 - r.y0, bottom: r.y1 - r.y0 };
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
  // frame put it, so the fill is clipped there. With `options.stay` no edge
  // moves at all: each is named `clean`, `cut` or `image` where it stands.
  function cleanFrame(pixels, frame, marksBox, options) {
    const ignore = (options && options.ignore) || [];
    const keep = (options && options.keep) || [];
    const fixed = Boolean(options && options.fixed);
    const stay = Boolean(options && options.stay);
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
    const room = (side) => {
      if (!marksBox) return Infinity;
      if (side === 'left') return Math.floor(marksBox[0]) - r.x0;
      if (side === 'top') return Math.floor(marksBox[1]) - r.y0;
      if (side === 'right') return r.x1 - Math.ceil(marksBox[0] + marksBox[2]);
      return r.y1 - Math.ceil(marksBox[1] + marksBox[3]);
    };
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
    const inset = insetFor();
    if (inset) {
      const [x0, y0, x1, y1] = [base.x0 + inset, base.y0 + inset, base.x1 - inset, base.y1 - inset];
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

    return { growBox, edgeIsClean, cleanPad, tightenBox, adoptLeading, rulesAcross, lineMedian, contentUnder, liftSpot, LIFT_EDGE, cropToMarks, trimBlank, contentBox, cleanFrame, edgeSliver, edgeAir, edgeName, clusterBoxes, pickBoardSide, collidingLifts, cleanestSpot, pathsCross, hits, union, components, panelSizes, frameIsDark, TOLERANCE, LIFT_RING, LIFT_BAND, LIFT_CLEAR, AIR, LEADER_THROUGH };
  }

  globalThis.__composeGeometry = build(1);
  globalThis.__composeGeometry.withScale = build;
}());
