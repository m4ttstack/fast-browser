// Runs inside the headless renderer page. Plain script, no imports: page.mjs
// inlines this file's text. window.__composeLayout() returns a Promise that
// resolves once every image is decoded and layout is final.
//
// Every rect, points, center and anchor in the report is in board CSS pixels;
// frame, cleanFrame, wholeFrame, air, source, grown and pad are in that panel's
// own capture pixels, at the scale its panel.scale gives.
(function () {
  const TONES = { AFTER: '#15803D', 'BEFORE → AFTER': '#4F46E5', FLOW: '#1F1A3D', FOUND: '#B91C1C' };
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, cls, parent, text) => {
    const e = document.createElement(tag); if (cls) e.className = cls;
    if (text != null) e.textContent = text; if (parent) parent.appendChild(e); return e;
  };
  const place = (e, x, y, w, h) => {
    e.style.left = `${x}px`; e.style.top = `${y}px`;
    if (w != null) { e.style.width = `${w}px`; e.style.height = `${h}px`; }
  };
  const loadImage = (src) => new Promise((resolve, reject) => {
    const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = src;
  });

  // These work in board pixels or ratios and do not change with a capture's scale.
  const { liftSpot, pickBoardSide, collidingLifts, cleanestSpot, pathsCross, hits, inRect, inset, union, components, panelSizes, sharedZoom, frameIsDark, resampleLanczos, TOLERANCE, LIFT_RING, LIFT_EDGE, LEADER_THROUGH } = globalThis.__composeGeometry;
  // The rest work in a capture's own pixels, so each capture takes the geometry of its scale.
  const geometries = new Map();
  const geometryFor = (scale) => {
    if (!geometries.has(scale)) geometries.set(scale, globalThis.__composeGeometry.withScale(scale));
    return geometries.get(scale);
  };
  // A redaction looks this far past its box for what it hides: a measured box
  // is tight to its text, an inspected one is drawn by eye. Its fill then
  // stands REDACT_GROW capture px off what it found there.
  const REDACT_GROW = 2;
  // Image px: an imported fill's pad, and beside the value's line how far, times the density it reads from the
  // value, it looks for ink to grow over (importFill).
  const IMPORT_REDACT_PAD = 12;
  const CROP_MARGIN = 24;
  const MIN_LIFT_HEIGHT = 24;
  const MAX_K = 3;
  const BASE_K = 1.06;
  // A lift wants LIFT_CSS board px per CSS px of the page and gives way, K_STEP at
  // a time, to no less than 1x of the capture (or what fits the frame).
  const LIFT_CSS = 1.15;
  const K_STEP = 0.02;
  // CSS px squared of stray edge pixels a card may cover: the antialiased tail of a glyph reaches further at 2x than at 1x.
  const STRAY_CSS = 12;
  // CSS px squared past which a card hides content beside it: a glyph's antialiased edge reads a few px apart at 2x
  // and at 1x, so twice the strays.
  const HIDES_CSS = 2 * STRAY_CSS;
  // Board px off the frame edge, beyond a card's ring, that are not counted as covered: the page's own border sits there.
  const COVER_INSET = 3;
  // Board px an edge of a fill under a card may stand inside where the page draws it.
  const FILL_SHIFT = 2;
  const FIRST_WIDTH = 560;
  const SINGLE_WIDTH = 640;
  const MIN_S = 0.55;
  const MAX_S = 1;
  // A lone panel has the board to itself, so a narrow frame may be drawn past CSS size.
  const SINGLE_MAX_S = 1.25;
  // The dot's outer radius includes its 2px stroke. The dot sits just outside
  // its target's ring so it never covers the content it points at.
  const DOT_R = 4.5;
  const DOT_OUTER = DOT_R + 1;
  // A dot's footprint is its full diameter plus this much clear space on every
  // side; no page content may sit under it.
  const FOOT_CLEAR = 6;
  const FOOT_R = DOT_OUTER + FOOT_CLEAR;
  // Centres of two dots are never closer than this: their outer circles and 2px of ground between.
  const DOT_APART = 2 * DOT_OUTER + 2;
  // The distance between neighbouring leader tracks and label columns.
  const LANE_PITCH = 8;
  const LEADER_WIDTH = 1.5;
  // A leader that bends runs at least LEADER_STEP_MIN before it turns to its label: a shorter step reads as a kink.
  const LEADER_STEP_MIN = 10;
  // A first run longer than LEADER_LONG_MIN, and than half the frame it crosses, makes its side a hard one.
  const LEADER_LONG_MIN = 160;
  const STROKE = '#6E56CF';
  // The accent is lost against a dark page: the part of a line inside a dark frame is drawn in this.
  const DARK_STROKE = '#C4B5FD';
  // Page content within this many board px of a leader's stroke counts as struck.
  const LEADER_CLEAR = 2;
  // A ring or bracket has no padding to read its ground from, so a leader
  // leaving it is measured against the median of the first GROUND_RUN samples
  // of its path, which a stray pixel just outside the target cannot become.
  const GROUND_RUN = 5;
  // A bracket stands BRACKET_GAP from its rows and slides right in BRACKET_STEP
  // steps, up to BRACKET_REACH further, to find ground clear of content for its
  // arm plus BRACKET_CLEAR either side. Rows that leave less than BRACKET_EDGE
  // between the arm and the frame put it in the margin, BRACKET_GUTTER clear of
  // the lanes. BRACKET_PROBE is the width in capture pixels of the column read
  // for the ground beside the rows.
  const BRACKET_GAP = 6;
  const BRACKET_ARM = 6;
  const BRACKET_REACH = 24;
  const BRACKET_STEP = 2;
  const BRACKET_GUTTER = 14;
  const BRACKET_EDGE = 4;
  const BRACKET_CLEAR = 2;
  const BRACKET_PROBE = 1;
  const BRACKET_WIDTH = 2;
  // A loupe's lens is LENS_D across inside a LENS_RING edge, LENS_GAP from its
  // label. The ring on the target stands LOUPE_PAD outside the target,
  // and a target never fills more than LOUPE_FILL of the lens. A leader stops
  // LENS_CLEAR short of the lens's ring, and a lens block leaves LENS_STACK
  // below it in a stack. The zoom chip sits ZTAG_INSET_X and ZTAG_INSET_Y in
  // from the lens's right and bottom edges.
  const LENS_D = 110;
  const LENS_RING = 4;
  const LENS_GAP = 12;
  const LENS_CLEAR = 2;
  const LENS_STACK = 16;
  const ZTAG_INSET_X = 30;
  const ZTAG_INSET_Y = 14;
  const LOUPE_PAD = 5;
  const LOUPE_FILL = 0.55;
  const LOUPE_ZOOM = 4;
  // A zoom the mark asked for that the fill caps below LOUPE_WARN of itself is worth a warning; a smaller cap is not.
  const LOUPE_WARN = 0.75;
  // Past its corners a pin may stand along an edge of its target, PIN_STEP from spot to spot. A spot that covers
  // PIN_STRAY board px squared of page content or less is on clear ground, and one spot hides less than another
  // only by more than that.
  const PIN_STEP = 20;
  const PIN_STRAY = 3;
  // A legend's number stands LEGEND_GAP from what it names, an entry LEGEND_APART from the next in its row and
  // LEGEND_STACK from the one below.
  const LEGEND_GAP = 8;
  const LEGEND_APART = 24;
  const LEGEND_STACK = 10;
  // These five mirror the page CSS in page.mjs (the .panel gap, the .phead
  // height, the .arrow size, and the radius of a .pin's disc and the width of
  // its white ring) and change together with it.
  const PANEL_GAP = 8;
  const HEAD_H = 22;
  const ARROW_D = 40;
  const PIN_R = 9;
  const PIN_RING = 2;
  // Board px: a ghost smaller than this on a side grows to it, and a slot side stands this far short of a fill.
  const GHOST_MIN = 24;
  const SLOT_FILL_GAP = 4;
  // Below this panel scale (drawn height over frame height) text is unreadable.
  const PANEL_SMALL_S = 0.4;

  // CSS px of the page a trimmed frame keeps beside a lift for a card that hangs to one side of its element.
  const LIFT_HANG = 12;
  // Board px: how far in from an edge that runs through content its fade reaches.
  const FADE = 12;
  // The scale a lift wants on a page drawn at `css` board px per CSS px.
  const wantedK = (css) => Math.min(MAX_K, Math.max(BASE_K, LIFT_CSS / css));

  // Capture px a lift's card may reach past a side of its box `size` long, on a page drawn at S board px per
  // capture px: its padding, what the scale it wants adds on that side (half of it for a centred card, all of it
  // up to LIFT_HANG CSS px for one that hangs off a neighbour), and the card's margin to the frame edge and a board px.
  const cardReach = (size, S, scale, pad) => {
    const added = (wantedK(S * scale) - 1) * (size + 2 * pad);
    return pad + Math.max(added / 2, Math.min(added, LIFT_HANG * scale)) + (LIFT_EDGE + 1) / S;
  };
  // Whole CSS px, so a 2x capture keeps the room its 1x twin does.
  const cardRoom = ([x, y, w, h], S, scale, pad) => {
    const out = (from, to) => [Math.floor(from / scale) * scale, Math.ceil(to / scale) * scale];
    const [x0, x1] = out(x - cardReach(w, S, scale, pad), x + w + cardReach(w, S, scale, pad)); const [y0, y1] = out(y - cardReach(h, S, scale, pad), y + h + cardReach(h, S, scale, pad));
    return [x0, y0, x1 - x0, y1 - y0];
  };

  // Pair and steps boards only start from this scale: their panels are then drawn at the shared size.
  const singleScale = (scale, alone) => (frame) => Math.min(alone ? SINGLE_MAX_S : MAX_S, Math.max(MIN_S, (alone ? SINGLE_WIDTH : FIRST_WIDTH) / (frame[2] / scale))) / scale;

  // Redaction is applied once, to the source pixels, before any layer reads
  // them: every layer below draws from this redacted copy, so no lift can
  // ever show what a redaction hides, and lift growth reads these same pixels.
  // `fillsFor` turns the pixels as captured into each redaction's fill rects, so every fill
  // is measured before any is painted: a fill never reads its neighbour's.
  async function redactedSource(capture, fillsFor, fill) {
    const img = await loadImage(capture.uri);
    const canvas = document.createElement('canvas');
    canvas.width = capture.size[0]; canvas.height = capture.size[1];
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const read = () => { const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height); return { data, width, height }; };
    const fills = fillsFor(read());
    ctx.fillStyle = fill;
    for (const [x, y, w, h] of fills.flat()) ctx.fillRect(x, y, w, h);
    return { canvas, ctx, read, fills };
  }

  const clampTo = ([x, y, w, h], [ox, oy, ow, oh]) => {
    const x0 = Math.max(x, ox); const y0 = Math.max(y, oy);
    return [x0, y0, Math.min(x + w, ox + ow) - x0, Math.min(y + h, oy + oh) - y0];
  };
  const encloses = (outer, inner) => outer[0] <= inner[0] && outer[1] <= inner[1] && outer[0] + outer[2] >= inner[0] + inner[2] && outer[1] + outer[3] >= inner[1] + inner[3];

  const SIDES = ['left', 'top', 'right', 'bottom'];
  const keysOf = (mark, kind) => [].concat(mark[kind]);
  const liftKind = (mark) => ('lift' in mark ? 'lift' : 'link' in mark ? 'link' : null);

  // `edges` says how far the frame's edges may move: 'settled' (cleaned, then slivers, rules and air), 'cleaned',
  // or 'given', the frame as the capture gave it. See the pair rules in __composeLayout. `airAt`, CSS px per side,
  // is the air a settled frame takes in place of what its own edges want; `shedAt`, CSS px per side, how far a
  // settled edge comes in off a rule in place of its own shed (a depth its `takes` allows), and `cutAt` past a lone
  // small item in place of its own cut (a depth its `cutTakes` allows). `stripOut` lists the sides
  // cleaning may take a word step outward past a strip (see cleanFrame), every side when null, and `noWord` the
  // sides it takes no word step on at all.
  async function sourceOf(panel, capture, redactFill, edges = 'settled', { airAt = null, shedAt = null, cutAt = null, stripOut = null, noWord = null } = {}) {
    const plain = edges !== 'settled';
    const marks = panel.marks || [];
    const imported = capture.source === 'import';
    const scale = capture.scale || 1;
    const geo = geometryFor(scale);
    const { growBox, cleanFrame, edgeSliver, shedEdgeRules, orphanBands, edgeAir, clusterBoxes, tightenBox, adoptLeading, LIFT_BAND, AIR } = geo;
    const GROW_LIMIT = 96 * scale;
    const PAD = 4 * scale;
    const keepClear = (o) => [o[0] - 2 * PAD, o[1] - 2 * PAD, o[2] + 4 * PAD, o[3] + 4 * PAD];
    const back = REDACT_GROW * scale;
    const captured = capture.boxes;

    // A fill covers what its box holds (fillRect). An imported box is drawn by eye on an image of unknown density, so
    // its fill reads the density from the value and grows over ink that reaches its edge (importFill): no reading of
    // the pixels tells the value's own ink from a neighbour's, so all of it stays. A live fill is one rect; an
    // imported one is a rect per line it covers (`fillSets`), and `fillRects` is every rect of every redaction.
    const redactMarks = marks.filter((m) => 'redact' in m);
    const redactBoxes = redactMarks.map((m) => union(keysOf(m, 'redact').map((k) => captured[k])));
    let fillNotes = redactMarks.map(() => null);
    const fillsFor = (original) => {
      if (!imported) return redactBoxes.map((box) => [geo.fillRect(original, box, { reach: REDACT_GROW * scale, back })]);
      // Growth leaves the other marks' targets to them: what the board points at is not the value.
      const keep = marks.filter((m) => !('redact' in m)).flatMap((m) => MARK_KINDS.filter((kind) => kind in m).flatMap((kind) => keysOf(m, kind).map((k) => captured[k]))).filter(Boolean);
      // An empty slot's blank, snapped to its edges, holds nothing of a value: a fill never grows into it.
      const blanks = marks.filter((m) => 'empty' in m).map((m) => captured[m.empty]).filter(Boolean).map((box) => geo.snapSlot(original, box, { keep: [] }));
      const fills = redactBoxes.map((box) => geo.importFill(original, box, { pad: IMPORT_REDACT_PAD, back, bounds: capture.frame, keep, blanks }));
      fillNotes = fills.map(({ grew, capped, extended, near, bridged, spared, peek }, i) => ({ mark: keysOf(redactMarks[i], 'redact').join(', '), grew, capped, extended, near, bridged, spared, peek }));
      return fills.map((fill) => fill.rects);
    };
    const source = await redactedSource(capture, fillsFor, redactFill);
    const fillSets = source.fills;
    const fillRects = fillSets.flat();
    let pixels = source.read();

    const liftMarks = marks.flatMap((mark, markIndex) => (liftKind(mark) ? [{ mark, markIndex, kind: liftKind(mark) }] : []));
    const slotMarks = marks.flatMap((mark, markIndex) => {
      const kind = ['empty', 'ghost'].find((k) => k in mark);
      return kind ? [{ mark, markIndex, kind, box: captured[mark[kind]] }] : [];
    });
    const slotBoxes = slotMarks.map((slot) => slot.box);
    const loupeMarks = marks.flatMap((mark, markIndex) => ('loupe' in mark ? [{ mark, markIndex, box: captured[mark.loupe] }] : []));
    const contextBoxes = marks.flatMap((mark) => ('context' in mark ? [union(keysOf(mark, 'context').map((k) => captured[k]))] : []));

    // A lift's or a bracket's box is its content before it is anything else: it
    // shrinks over blank ground, then takes in a tick or icon that leads its
    // line. An icon is never another target's element (one whose box holds this
    // one is no icon), a redaction, a slot or a loupe's target; those three keep
    // the boxes the capture gave. An edge that moved keeps one CSS px of ground
    // outside the content, so it lies on a clean line and growBox judges it the
    // same on a 2x capture as on its 1x twin.
    const shrinks = new Set(marks.flatMap((m) => (liftKind(m) ? keysOf(m, liftKind(m)) : 'bracket' in m ? keysOf(m, 'bracket') : [])));
    const heldFills = fillSets.flatMap((rects, i) => rects.filter((fill) => hits(fill, redactBoxes[i])).map((fill) => clampTo(fill, redactBoxes[i])));
    const adopted = new Set();
    const boxes = Object.fromEntries(Object.entries(captured).map(([key, box]) => {
      if (!shrinks.has(key)) return [key, box];
      const { box: tight, moved } = tightenBox(pixels, box, { keep: heldFills, ignore: fillRects });
      const others = Object.entries(captured).flatMap(([k, b]) => (k === key || encloses(b, box) ? [] : [b]));
      const led = adoptLeading(pixels, tight, { bounds: capture.frame, element: box, avoid: [...redactBoxes, ...slotBoxes, ...loupeMarks.map((l) => l.box), ...others], ignore: fillRects });
      const took = led[0] < tight[0];
      if (took) adopted.add(key);
      const x0 = led[0] - (moved.left || took ? scale : 0); const y0 = led[1] - (moved.top || led[1] < tight[1] ? scale : 0);
      const x1 = led[0] + led[2] + (moved.right ? scale : 0); const y1 = led[1] + led[3] + (moved.bottom || led[1] + led[3] > tight[1] + tight[3] ? scale : 0);
      return [key, [x0, y0, x1 - x0, y1 - y0]];
    }));
    const bracketMarks = marks.flatMap((mark, markIndex) => ('bracket' in mark
      ? [{ mark, markIndex, original: union(keysOf(mark, 'bracket').map((k) => boxes[k])), given: union(keysOf(mark, 'bracket').map((k) => captured[k])) }] : []));

    // The captured frame's edges can land mid-word; they move off content
    // before anything is bounded by the frame. The marks are the boxes as
    // captured, with any icon a lift or bracket took in beside its own, and a
    // redaction wholly outside the frame is not a mark.
    // An imported frame may be all that hides what lies beside it, so it only shrinks.
    const sourceMarks = [...liftMarks.flatMap(({ mark, kind }) => keysOf(mark, kind).flatMap((k) => [captured[k], boxes[k]])), ...slotBoxes, ...bracketMarks.flatMap((b) => [b.given, b.original]), ...loupeMarks.map((l) => l.box), ...contextBoxes, ...redactBoxes]
      .filter((b) => hits(b, capture.frame));
    const keptFills = fillRects.filter((f) => hits(f, capture.frame));
    const cleaned = cleanFrame(pixels, capture.frame, sourceMarks.length ? union(sourceMarks) : null, { ignore: fillRects, keep: keptFills, fixed: imported, stay: edges === 'given', ...(stripOut ? { stripOut } : {}), ...(noWord ? { noWord } : {}) });

    // A clean edge can still carry a border or a strip of the page behind a
    // card, a round card its whole outline, and a divider just inside it; those
    // go, but never a line of a mark or of a fill. Then an edge on
    // clean ground with less than AIR of it inside is given the rest, painted
    // over the page beside the frame in that ground's colour, so content flush
    // against the frame does not touch the board's edge, and so is an edge
    // nearer a lift than its card reaches. The fills are painted again after
    // the air, so air never covers one. An imported frame never grows: it may
    // be all that hides what lies beside it.
    // A lift's card wants room beside its box too. The scale the panel is drawn at is not known yet (a pair or
    // steps board sets it from every panel), so the room is the most a card can want, at MAX_K. A live edge that
    // moved into that room is given it back as air, never more than it lost: the frame does not grow for a
    // card's sake, and the trim, which knows the scale, takes back what the card does not need. An imported
    // edge, which gets no air, does not move into it.
    // The lifts are not clustered yet (that reads the frame): a lift's elements count as one card, a link's as one each.
    const liftRooms = liftMarks.flatMap(({ mark, kind }) => {
      const each = keysOf(mark, kind).map((k) => union([captured[k], boxes[k]]));
      return (kind === 'link' ? each : [union(each)]).map((box) => cardRoom(box, LIFT_CSS / MAX_K / scale, scale, PAD));
    });
    const guarded = [...sourceMarks, ...keptFills, ...(imported ? liftRooms : [])];
    const guard = guarded.length ? union(guarded) : null;
    const slivered = plain ? cleaned.frame : edgeSliver(pixels, cleaned.frame, guard, { fixed: imported });
    const ruled = plain ? null : shedEdgeRules(pixels, slivered, guard, { keep: keptFills, ignore: fillRects });
    const shedOn = (side) => {
      if (!ruled) return 0;
      return shedAt ? Math.max(0, Math.round(shedAt[side] * scale)) : ruled.shed[side];
    };
    const shed = Object.fromEntries(SIDES.map((side) => [side, shedOn(side)]));
    const shedded = inset(slivered, shed);
    const orphans = plain ? null : orphanBands(pixels, shedded, guard, { keep: keptFills, ignore: fillRects });
    const cut = Object.fromEntries(SIDES.map((side) => [side, !orphans ? 0 : cutAt ? Math.max(0, Math.round(cutAt[side] * scale)) : orphans.cut[side]]));
    let shown = inset(shedded, cut);
    const air = { left: 0, top: 0, right: 0, bottom: 0 };
    if (!imported && !plain) {
      const found = edgeAir(pixels, shown);
      const r = { x0: Math.max(0, Math.floor(shown[0])), y0: Math.max(0, Math.floor(shown[1])), x1: Math.min(capture.size[0], Math.ceil(shown[0] + shown[2])), y1: Math.min(capture.size[1], Math.ceil(shown[1] + shown[3])) };
      const rooms = liftRooms.length ? union(liftRooms) : null;
      const [cx, cy, cw, ch] = cleaned.frame;
      const lost = { left: r.x0 - cx, top: r.y0 - cy, right: cx + cw - r.x1, bottom: cy + ch - r.y1 };
      const wanted = rooms ? { left: r.x0 - rooms[0], top: r.y0 - rooms[1], right: rooms[0] + rooms[2] - r.x1, bottom: rooms[1] + rooms[3] - r.y1 } : lost;
      // Whole CSS px, as the air for ground is.
      const short = Object.fromEntries(Object.keys(lost).map((side) => [side, rooms ? Math.floor(Math.min(lost[side], wanted[side]) / scale) * scale : 0]));
      for (const side of SIDES) {
        const { have, ground } = found[side];
        if (!ground) continue;
        const give = Math.min(airAt ? airAt[side] * scale : Math.max(AIR - have, short[side]), { left: r.x0, top: r.y0, right: capture.size[0] - r.x1, bottom: capture.size[1] - r.y1 }[side]);
        if (give <= 0) continue;
        source.ctx.fillStyle = `rgb(${ground.join(',')})`;
        if (side === 'left') { r.x0 -= give; source.ctx.fillRect(r.x0, r.y0, give, r.y1 - r.y0); }
        if (side === 'top') { r.y0 -= give; source.ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, give); }
        if (side === 'right') { source.ctx.fillRect(r.x1, r.y0, give, r.y1 - r.y0); r.x1 += give; }
        if (side === 'bottom') { source.ctx.fillRect(r.x0, r.y1, r.x1 - r.x0, give); r.y1 += give; }
        air[side] = give;
      }
      if (Object.values(air).some((n) => n > 0)) {
        source.ctx.fillStyle = redactFill;
        for (const [x, y, w, h] of fillRects) source.ctx.fillRect(x, y, w, h);
        pixels = source.read();
        // A side that took air sits on a whole pixel; the others keep the coordinate they had.
        const x0 = air.left ? r.x0 : shown[0]; const y0 = air.top ? r.y0 : shown[1];
        const x1 = air.right ? r.x1 : shown[0] + shown[2]; const y1 = air.bottom ? r.y1 : shown[1] + shown[3];
        shown = [x0, y0, x1 - x0, y1 - y0];
      }
    }
    const dark = imported ? frameIsDark(pixels, shown, fillRects) : Boolean(capture.dark);
    const notes = cleaned.cut ? ['a frame edge cuts through content'] : [];

    // A lift whose box ends inside content (a name without its value) grows
    // out to the nearest clean edges. It never grows into a redaction, a slot or into
    // another lift unless the two boxes already overlapped as named. The
    // redaction fill's 2px margin often sits inside a lift box already, so
    // those pixels are ignored when testing an edge rather than walled off.
    const growAvoiding = (box, avoid, bounds = shown, limit = GROW_LIMIT) => growBox(pixels, box, limit, { bounds, avoid: [...avoid, ...redactBoxes, ...slotBoxes], ignore: fillRects, band: LIFT_BAND });

    for (const b of bracketMarks) {
      const { box, cut } = growAvoiding(b.original, []);
      b.rows = box;
      if (cut) notes.push('a bracket edge cuts through content');
    }

    // A point over elements that sit apart is one lift per cluster of elements.
    // Keys cluster by where each grows to on its own, so a union never sweeps
    // the content between them into the lift. A link's keys never cluster.
    // Elements cluster as the capture gave them: two rows that touch are one
    // thing, though the words of two lines of text never do.
    const groups = liftMarks.flatMap(({ mark, markIndex, kind }) => {
      const keys = keysOf(mark, kind);
      let clusters = kind === 'link' ? keys.map((_, i) => [i]) : [keys.map((_, i) => i)];
      if (kind === 'lift' && keys.length > 1) {
        const others = liftMarks.filter((l) => l.mark !== mark).flatMap((l) => keysOf(l.mark, l.kind).map((k) => captured[k]));
        const alone = keys.map((k) => growAvoiding(captured[k], others.filter((o) => !hits(captured[k], o)).map(keepClear)).box);
        clusters = clusterBoxes(alone);
      }
      return clusters.map((members) => {
        const own = members.map((i) => keys[i]);
        return { mark, markIndex, keys: own, original: union(own.map((k) => boxes[k])), captured: union(own.map((k) => captured[k])), ...(kind === 'link' ? { separate: true } : {}) };
      });
    });

    return { panel, capture, imported, scale, geo, PAD, keepClear, marks, boxes, adopted, dark, canvas: source.canvas, pixels, redactBoxes, fillSets, fillRects, fillNotes, shown, slivered, shed, takes: ruled?.takes, cut, cutTakes: orphans?.takes, air, cleaned, liftMarks, slotMarks, bracketMarks, loupeMarks, contextBoxes, groups, growAvoiding, redactFill, notes };
  }

  const NO_TRIM = { left: 0, top: 0, right: 0, bottom: 0 };
  const marksBoxOf = (parts) => (parts.length ? union(parts.map((part) => part.box)) : null);

  // A panel that shows its whole frame loses the blank ground at the frame's
  // edges, so panels of one card start where it starts. The ground beside a
  // lift stays as far as its card may reach (cardReach). Without it the trim
  // would clamp a card the untrimmed frame had room for. `roomAt` is the scale
  // S (board px per capture px) the room was reckoned for: it holds at that
  // scale and any larger, and a region with no room to keep holds at every scale.
  function roomRegion(src, parts, S) {
    const rooms = parts.filter((part) => part.lift).map((part) => cardRoom(part.box, S, src.scale, src.PAD));
    const { box, trimmed } = src.geo.trimBlank(src.pixels, src.shown, marksBoxOf(parts), rooms.length ? union(rooms) : null);
    return { box, cropped: false, trimmed, roomAt: rooms.length ? S : 0 };
  }
  const untrimmed = (src) => ({ box: src.shown.slice(), cropped: false, trimmed: NO_TRIM, roomAt: 0 });
  // How many times a trim is taken again for a smaller scale before the frame keeps all its ground.
  const ROOM_ROUNDS = 8;
  // How many times steps crops are grown to a shared size before the panels keep the sizes they have.
  const SHARE_ROUNDS = 8;

  // The scale follows from how wide the trimmed frame is, and the room from
  // the scale: the trim starts from a page drawn at CSS size and is taken
  // again while the frame it leaves is drawn smaller than its room was
  // reckoned for. A smaller scale only widens the room, so each round the
  // frame grows or the scale has settled. A frame that has not settled in
  // ROOM_ROUNDS keeps all its ground, so a trim never clamps a card.
  function wholeRegion(src, parts, scaleFor) {
    let region = roomRegion(src, parts, MAX_S / src.scale);
    for (let n = 0; scaleFor(region.box) < region.roomAt - 1e-9; n += 1) region = n < ROOM_ROUNDS ? roomRegion(src, parts, scaleFor(region.box)) : untrimmed(src);
    return region;
  }

  // Two frames of one size are one region in two states. Each panel's own trim
  // would stop at whatever its state happens to hold, so they show different
  // rectangles at different scales: both take the smaller trim on each side.
  // Frames and trims are in each panel's capture pixels, so they are compared
  // in CSS pixels, and a trim that is not a whole capture pixel rounds down.
  function sharedTrims(sources, regions) {
    const [first] = sources;
    const css = (src, n) => n / src.scale;
    if (!sources.every((src) => css(src, src.shown[2]) === css(first, first.shown[2]) && css(src, src.shown[3]) === css(first, first.shown[3]))) return regions;
    const least = Object.fromEntries(SIDES.map((side) => [side, Math.min(...regions.map((region, i) => css(sources[i], region.trimmed[side])))]));
    return regions.map((region, i) => {
      const [x, y, w, h] = sources[i].shown;
      const trimmed = Object.fromEntries(Object.entries(least).map(([side, n]) => [side, Math.floor(n * sources[i].scale + 1e-9)]));
      return { ...region, trimmed, box: [x + trimmed.left, y + trimmed.top, w - trimmed.left - trimmed.right, h - trimmed.top - trimmed.bottom] };
    });
  }

  // What a panel shows: its marks with context, or the whole frame when the
  // crop would cover half of it. A pair's frame is the region being compared,
  // so a pair panel is never cropped. A steps panel is held to the context
  // floor and keeps a crop edge at its margin where the page leaves no clean
  // band, so a dense page does not swell the crop to the whole frame. `src.min`
  // is the least size, in capture px, the steps of a board hold a crop to.
  function regionOf(src, parts, scaleFor) {
    if (!src.crops) return wholeRegion(src, parts, scaleFor);
    const crop = src.geo.cropToMarks(src.pixels, src.shown, marksBoxOf(parts), { parts, floor: src.floor, hold: src.hold, min: src.min, keep: src.fillRects, ignore: src.fillRects, ...(src.imported ? { stripBounds: src.capture.frame } : {}) });
    return crop.edges ? { box: crop.box, edges: crop.edges, cut: crop.cut, cropped: true, trimmed: NO_TRIM } : wholeRegion(src, parts, scaleFor);
  }

  // A redaction never grows a crop: the crop is chosen by the other marks, and a redaction whose box or fill
  // meets it is taken in whole, fill and all, so no crop edge runs through a value. One wholly outside it is not
  // shown. A panel of redactions alone, or one shown whole, holds every part as before.
  function cropOf(src, marked, redacted, scaleFor) {
    const every = [...marked, ...redacted];
    if (!src.crops || !marked.length) return { parts: every, region: regionOf(src, every, scaleFor) };
    // A blank on an imported image is evidence only by where it sits, so blanks alone never crop it.
    if (src.imported && marked.every((part) => part.blank)) return { parts: every, region: wholeRegion(src, every, scaleFor) };
    const met = new Set();
    for (;;) {
      const parts = [...marked, ...[...met].map((part) => ({ ...part, box: part.whole }))];
      const region = regionOf(src, parts, scaleFor);
      if (!region.cropped) return { parts: every, region: regionOf(src, every, scaleFor) };
      const more = redacted.filter((part) => !met.has(part) && hits(part.whole, region.box));
      if (!more.length) return { parts, region };
      for (const part of more) met.add(part);
    }
  }

  // Everything below the groups follows from them: the grown boxes, the
  // frame, the scale and every lift's final rect. So a merge solves again.
  // `taken` maps a group's keys to the box it holds once it took in the line
  // its ring cut (lineTaken).
  function solve(src, groups, scaleFor, taken = new Map()) {
    const { pixels, shown, redactBoxes, slotMarks, bracketMarks, loupeMarks, contextBoxes, fillSets, fillRects, growAvoiding, PAD, keepClear } = src;
    const { cleanPad, contentUnder, droppedOutline, coverBands, cutLine, contentBox, LIFT_CLEAR } = src.geo;
    const originals = groups.map((g) => g.original);
    // A pinned region was cropped for the first solve's groups; a lift that
    // merged since may not grow past it, or its card would show what the crop left out.
    const reach = src.region ? src.region.box : shown;
    const grownBoxes = []; const cutLifts = []; const avoids = [];
    groups.forEach((_, i) => {
      const avoid = originals.flatMap((o, j) => (j === i || hits(originals[i], o) ? [] : [keepClear(j < i ? grownBoxes[j] : o)]));
      const { box, cut } = growAvoiding(originals[i], avoid, reach);
      grownBoxes.push(box); cutLifts.push(cut); avoids.push(avoid);
    });

    // The frame shrinks to its marks before the scale is chosen, so the scale,
    // the lifts, the labels and the leaders all work on the frame that is
    // shown. A redaction or a slot wholly outside the original frame is not a mark.
    // A lift or a bracket counts here with the box the capture gave it: where
    // its ink begins differs by a px between a 2x capture and its 1x twin, and
    // a crop edge that snaps to a clean band turns that px into a row.
    const marked = [
      ...grownBoxes.map((box, i) => ({ box: union([box, groups[i].captured]), bracket: false, lift: true, link: Boolean(groups[i].separate) })),
      ...[...slotMarks.map((slot) => ({ box: slot.box, bracket: false, blank: slot.kind === 'empty' })), ...bracketMarks.map((b) => ({ box: union([b.rows, b.given]), bracket: true })), ...loupeMarks.map((l) => ({ box: l.box, bracket: false })), ...contextBoxes.map((box) => ({ box, bracket: false }))].filter((part) => hits(part.box, shown)),
    ];
    // A fill reaches past its box, and an empty fill (a box wholly off the capture) reaches nowhere.
    const redacted = redactBoxes.map((box, i) => {
      const sized = fillSets[i].filter((fill) => fill[2] > 0 && fill[3] > 0);
      return { box, bracket: false, whole: sized.length ? union([box, ...sized]) : box };
    })
      .filter((part) => hits(part.box, shown));
    const { parts, region } = src.region ? { parts: [...marked, ...redacted], region: src.region } : cropOf(src, marked, redacted, scaleFor);
    const { box: frame, edges: cropEdges } = region;
    const [fx, fy, fw, fh] = frame;
    const S = scaleFor(frame);
    const cw = Math.round(fw * S); const ch = Math.round(fh * S);
    const map = (b) => [(b[0] - fx) * S, (b[1] - fy) * S, b[2] * S, b[3] * S];

    const css = S * src.scale;
    const STRAY = STRAY_CSS * src.scale ** 2;
    const want = wantedK(css);
    // A dropped outline needs a corner (droppedOutline): a lone rule is a
    // divider or an underline. The card keeps its footprint and takes in the
    // element's whole box (`given`), or the outline's ends would show past it;
    // and it must still hold what the element holds inside its own outline.
    const offOutline = (b, element) => {
      const dropped = droppedOutline(pixels, b, { element, ignore: fillRects });
      if (!dropped) return null;
      const own = droppedOutline(pixels, element, { ignore: fillRects });
      return encloses(dropped.box, own ? own.box : element) ? dropped : null;
    };
    const plans = groups.map((group, i) => {
      const b = taken.get(group.keys.join()) ?? grownBoxes[i]; const given = group.captured;
      // How far the lift reaches past the box the capture gave; a side tightened inside it reports none.
      const grown = [given[0] - b[0], given[1] - b[1], b[0] + b[2] - given[0] - given[2], b[1] + b[3] - given[1] - given[3]]
        .map((g) => Math.max(0, Math.round(g)));
      // Padding keeps clear of the neighbouring content, so a lift never shows
      // a sliver of the neighbouring word and never sits hard against it. The
      // card's opaque ring is LIFT_RING board px, which is more than LIFT_CLEAR
      // of the page on a board drawn below CSS size: the clear lines past the
      // padding then leave room for the ring as drawn. A ring within a
      // twentieth of a px of a whole CSS px asks for that px, not the next.
      const pad = cleanPad(pixels, b, PAD, { bounds: frame, ignore: fillRects, clear: Math.ceil(LIFT_RING / css - 0.05) * src.scale });
      const padded = [b[0] - pad[0], b[1] - pad[1], b[2] + pad[0] + pad[2], b[3] + pad[1] + pad[3]];
      const dropped = offOutline(b, group.original);
      const footprint = dropped && clampTo(union([padded, given]), frame);
      const bands = dropped && coverBands(pixels, dropped, footprint, given, fillRects);
      const cover = bands ? { bands } : null;
      // The edges it shows are judged again as growBox judged them, without growing.
      if (cover) cutLifts[i] = growAvoiding(dropped.box, avoids[i], reach, 0).cut;
      const bb = cover ? footprint : padded;
      const [x, y, w, h] = map(bb);
      const fit = Math.min((cw - 2 * LIFT_EDGE) / w, (ch - 2 * LIFT_EDGE) / h);
      const tiny = h * want < MIN_LIFT_HEIGHT;
      // A card is placed by what lies under it, its ring and LIFT_CLEAR past the ring, so it stands off the words beside it; of
      // spots that hide as much, one whose own edge keeps LIFT_CLEAR of the page wins, though it falls between whole board px.
      // `face` keeps it from hiding more under itself than a centred card would.
      // `covered` counts only what lies under the card and its ring, half a CSS px in from their edge: a pixel of a 1x capture by its centre.
      // `hidden` counts what lies a whole CSS px in, so a card whose edge grazes an antialiased rim at one scale and not the other hides nothing.
      const under = (clear, exact) => contentUnder(pixels, frame, S, [x, y, w, h], clear, exact);
      const crowds = under(LIFT_CLEAR - LIFT_RING / S);
      const ranks = [under(), (card) => (crowds(card) > 0 ? 1 : 0)];
      return { group, b, grown, pad, bb, cover, x, y, w, h, fit, tiny, ranks, face: under(-LIFT_RING / S, true), covered: under(-0.5 * src.scale), hidden: under(-src.scale), spots: new Map() };
    });
    // Two lines of one height side by side, one either side of the tiny height, would be drawn at scales far apart. Lifts
    // share a row when the boxes the capture gave overlap by half the taller one's height, so only lines of about one
    // height do, and a lift joins a row only beside every lift already in it.
    const sameRow = (a, c) => Math.min(a[1] + a[3], c[1] + c[3]) - Math.max(a[1], c[1]) >= Math.max(a[3], c[3]) / 2;
    const rows = [];
    plans.forEach((p, i) => {
      const row = rows.find((r) => r.every((j) => sameRow(p.group.captured, plans[j].group.captured)));
      if (row) row.push(i); else rows.push([i]);
    });
    const fitted = (p, kk) => {
      const k = Math.min(kk, p.fit);
      if (!p.spots.has(k)) {
        const W = p.w * k; const H = p.h * k;
        p.spots.set(k, { k, W, H, ...liftSpot(p.ranks, [cw, ch], [p.x, p.y, p.w, p.h], [W, H], p.face) });
      }
      return p.spots.get(k);
    };
    const rectOf = ({ L, T, W, H }) => [L, T, W, H];
    const separate = (i, j) => !hits(grownBoxes[i], grownBoxes[j]);
    // A tiny lift beside a sized one in its row counts as sized, so every lift outside a row of tiny ones shares the panel's one K.
    const sized = plans.flatMap((p, i) => (rows.find((r) => r.includes(i)).some((j) => !plans[j].tiny) ? [i] : []));
    // One scale for every lift of the panel: the largest at which no card hides content, none moves a fill and no two overlap.
    // A page's own border sits within a couple of board px of the frame's edge, half under a card's ring at 2x and not at 1x:
    // what lies in that strip is not counted.
    const counted = ([x, y, w, h]) => {
      const reach = LIFT_RING + COVER_INSET;
      const x0 = Math.max(x, reach); const y0 = Math.max(y, reach);
      return [x0, y0, Math.max(0, Math.min(x + w, cw - reach) - x0), Math.max(0, Math.min(y + h, ch - reach) - y0)];
    };
    // A card draws the fills it holds enlarged from where it stands, so they drift off their places on the page, which are
    // what the report gives and where the crops a person confirms are cut: no edge of a fill is drawn more than FILL_SHIFT inside its place.
    const heldBy = plans.map((p) => fillRects.filter((fill) => hits(fill, p.bb)).map((fill) => clampTo(fill, p.bb)));
    const fillsStay = (i, K) => {
      const { bb } = plans[i]; const { L, T, k } = fitted(plans[i], K);
      return heldBy[i].every((fill) => {
        const [x, y, w, h] = map(fill);
        const [dx, dy] = [L + (fill[0] - bb[0]) * S * k, T + (fill[1] - bb[1]) * S * k];
        return dx <= x + FILL_SHIFT && dy <= y + FILL_SHIFT && dx + w * k >= x + w - FILL_SHIFT && dy + h * k >= y + h - FILL_SHIFT;
      });
    };
    const holds = (K) => sized.every((i) => plans[i].covered(counted(rectOf(fitted(plans[i], K)))) <= STRAY && fillsStay(i, K))
      && sized.every((i, n) => sized.slice(n + 1).every((j) => !separate(i, j) || !hits(rectOf(fitted(plans[i], K)), rectOf(fitted(plans[j], K)))));
    // The panel's one K never exceeds what the least roomy sized lift fits at, or that lift would be drawn smaller than its siblings.
    const ceiling = Math.min(want, ...sized.map((i) => plans[i].fit));
    const least = Math.min(1, ceiling);
    let K = ceiling;
    while (K > least + 1e-9 && !holds(K)) K = Math.max(least, K - K_STEP);

    const finals = new Array(plans.length); const notes = region.cut ? ['a crop edge cuts through content'] : [];
    for (const i of sized) {
      const spot = fitted(plans[i], K);
      finals[i] = { rect: rectOf(spot), clamped: spot.clamped, k: spot.k, tiny: false };
      if (spot.k < 1 - 1e-9) notes.push('a lift was scaled down to fit the frame');
    }
    // A row shares one scale, the largest from `from` down to `floor` that every lift of it holds as a sized lift holds the
    // panel's K, apart from every card placed outside it. Its lifts are placed at that scale.
    const placeRow = (row, from, floor) => {
      const fits = (kk) => row.every((i, n) => {
        const rect = rectOf(fitted(plans[i], kk));
        return finals.every((f, j) => !f || row.includes(j) || !separate(i, j) || !hits(f.rect, rect))
          && row.slice(0, n).every((j) => !separate(i, j) || !hits(rectOf(fitted(plans[j], kk)), rect))
          && plans[i].covered(counted(rect)) <= STRAY && fillsStay(i, kk);
      });
      let k = from;
      while (k > floor + 1e-9 && !fits(k)) k = Math.max(floor, k - K_STEP);
      for (const i of row) {
        const spot = fitted(plans[i], k);
        finals[i] = { rect: rectOf(spot), clamped: spot.clamped, k: spot.k, tiny: true };
        if (spot.k < BASE_K - 1e-9) notes.push('a lift was scaled down to fit the frame');
      }
    };
    // A row of tiny lifts is enlarged at one scale, to a readable height for its tallest.
    for (const row of rows.filter((r) => r.every((i) => plans[i].tiny))) {
      const from = Math.min(...row.map((i) => Math.min(MAX_K, MIN_LIFT_HEIGHT / plans[i].h, plans[i].fit)));
      placeRow(row, from, Math.min(...row.map((i) => Math.min(BASE_K, plans[i].fit))));
    }
    plans.forEach((p, i) => {
      if (cutLifts[i]) notes.push('a lift edge cuts through content');
      if (finals[i].clamped) notes.push('a lift was clamped at the frame edge');
    });
    finals.forEach((a, i) => finals.slice(i + 1).forEach((b, k) => {
      if (!hits(grownBoxes[i], grownBoxes[i + 1 + k]) && hits(a.rect, b.rect)) notes.push('two lifts overlap');
    }));
    // A card that still hides content takes in whole the line its ring cuts on top or bottom, and the panel
    // solves again. A line that runs past the card or touches a redaction or another mark stays where it is.
    const hides = (i) => plans[i].hidden(counted(finals[i].rect)) > HIDES_CSS * src.scale ** 2;
    const marks = (i) => [...redactBoxes, ...fillRects, ...originals.filter((_, j) => j !== i), ...plans.flatMap((p, j) => (j === i ? [] : [p.b])),
      ...slotMarks.map((slot) => slot.box), ...bracketMarks.map((m) => union([m.rows, m.given])), ...loupeMarks.map((l) => l.box)];
    const whole = (n) => Math.ceil(n / src.scale - 0.05) * src.scale;
    const lineTaken = (i) => {
      const { b } = plans[i]; const [L, T, W, H] = finals[i].rect;
      const card = [fx + (L - LIFT_RING) / S, fx + (L + W + LIFT_RING) / S];
      const past = { top: whole(b[1] - fy - (T - LIFT_RING) / S), bottom: whole(fy + (T + H + LIFT_RING) / S - b[1] - b[3]) };
      let box = b;
      for (const side of ['top', 'bottom']) {
        const by = past[side] > 0 ? cutLine(pixels, b, side, past[side], grownBoxes[i][3], { bounds: frame, ignore: fillRects }) : 0;
        if (!by) continue;
        const rows = side === 'top' ? [b[1] - by, by] : [b[1] + b[3], by];
        const ink = contentBox(pixels, clampTo([card[0] - 4 * PAD, rows[0], card[1] - card[0] + 8 * PAD, rows[1]], frame));
        const strip = [card[0], rows[0], card[1] - card[0], rows[1]];
        if (ink[0] < card[0] || ink[0] + ink[2] > card[1] || marks(i).some((m) => hits(m, strip))) continue;
        box = union([box, [ink[0], rows[0], ink[2], rows[1]]]);
      }
      return box;
    };
    const more = new Map();
    plans.forEach((p, i) => {
      const key = p.group.keys.join();
      if (p.cover || taken.has(key) || !hides(i)) return;
      const box = lineTaken(i);
      if (box !== p.b) more.set(key, box);
    });
    if (more.size) return solve(src, groups, scaleFor, new Map([...taken, ...more]));
    if (plans.some((_, i) => hides(i))) notes.push('a lift hides content beside it');
    return { groups, plans, finals, notes, frame, cropEdges, cropped: region.cropped, trimmed: region.trimmed, region, parts, S, cw, ch, map };
  }

  // Lifts of one point that would collide at their final rects are one thing
  // again: those clusters merge and the layout is solved once more.
  const mergeColliding = (groups, pairs) => {
    return components(groups.length, pairs).map((indexes) => {
      const members = indexes.map((i) => groups[i]);
      if (members.length === 1) return members[0];
      return { ...members[0], keys: members.flatMap((m) => m.keys), original: union(members.map((m) => m.original)), captured: union(members.map((m) => m.captured)), merged: true };
    });
  };

  function settle(src, scaleFor) {
    let solved = solve(src, src.groups, scaleFor);
    // A merge that would cover another mark's box is refused, and stays
    // refused, so the loop ends.
    const refused = new Set();
    const idOf = (groups, [i, j]) => `${groups[i].keys.join()}|${groups[j].keys.join()}`;
    const sweeps = (groups, [i, j]) => {
      const merged = union([groups[i].original, groups[j].original]);
      return groups.some((g) => g.markIndex !== groups[i].markIndex && hits(merged, g.original)
        && !hits(groups[i].original, g.original) && !hits(groups[j].original, g.original));
    };
    for (;;) {
      const allowed = [];
      for (const pair of collidingLifts(solved.finals.map((f, i) => ({ mark: solved.groups[i].markIndex, rect: f.rect })))) {
        const id = idOf(solved.groups, pair);
        if (solved.groups[pair[0]].separate || solved.groups[pair[1]].separate || refused.has(id)) continue;
        if (sweeps(solved.groups, pair)) refused.add(id); else allowed.push(pair);
      }
      if (!allowed.length) break;
      solved = solve(src, mergeColliding(solved.groups, allowed), scaleFor);
    }
    return solved;
  }

  // The capture's pixels, read against a ground colour. A colour is [r, g, b];
  // `px` is a pixel's byte offset in the capture.
  function probes(src, solved) {
    const { pixels, fillRects } = src;
    const { frame: [fx, fy], S, cw, ch } = solved;
    // A redaction fill as drawn is flat colour on the redacted copy, so a leader
    // reads it as content by position, and it is no ground to measure content against.
    const onFill = (sx, sy) => fillRects.some((fill) => inRect(fill, sx, sy));
    const colourAt = (px) => [pixels.data[px], pixels.data[px + 1], pixels.data[px + 2]];
    const differs = (px, ref) => ref.some((v, c) => Math.abs(pixels.data[px + c] - v) > TOLERANCE);
    // The colour its leader and dot are measured against: the median of the
    // clean padding line beside a target's side, or of the box's own edge line
    // when there is no padding. A median, so a stray antialiased pixel on the
    // line cannot become the ground.
    const groundOf = (target, side) => {
      const { source: [bx, by, bw, bh], pad } = target;
      const out = pad[side === 'right' ? 2 : 3] > 0 ? 1 : 0;
      const right = side === 'right';
      const fixed = Math.floor(right ? bx + bw - 1 + out : by + bh - 1 + out);
      const [from, to] = right ? [Math.floor(by), Math.ceil(by + bh)] : [Math.floor(bx), Math.ceil(bx + bw)];
      const clear = [[], [], []]; const all = [[], [], []];
      for (let i = Math.max(0, from); i < Math.min(right ? pixels.height : pixels.width, to); i += 1) {
        const x = right ? fixed : i; const y = right ? i : fixed;
        if (x < 0 || y < 0 || x >= pixels.width || y >= pixels.height) continue;
        const px = colourAt((y * pixels.width + x) * 4);
        (onFill(x, y) ? [all] : [all, clear]).forEach((lists) => lists.forEach((values, c) => values.push(px[c])));
      }
      const channels = clear[0].length ? clear : all;
      return channels.map((values) => values.sort((a, b) => a - b)[values.length >> 1]);
    };
    // The capture pixels whose centre lies in `rect` (board px) that `counts` (sx, sy) takes; by default those that differ from `ref`.
    const inkIn = ([x, y, w, h], ref, counts) => {
      let ink = 0;
      for (let sy = Math.floor(fy + y / S); sy <= Math.ceil(fy + (y + h) / S); sy += 1) {
        for (let sx = Math.floor(fx + x / S); sx <= Math.ceil(fx + (x + w) / S); sx += 1) {
          const dx = (sx + 0.5 - fx) * S; const dy = (sy + 0.5 - fy) * S;
          if (dx < x || dy < y || dx > x + w || dy > y + h || dx < 0 || dy < 0 || dx > cw || dy > ch) continue;
          if (sx < 0 || sy < 0 || sx >= pixels.width || sy >= pixels.height) continue;
          if (counts ? counts(sx, sy) : differs((sy * pixels.width + sx) * 4, ref)) ink += 1;
        }
      }
      return ink;
    };
    // Content in `rect` beside a bracket's rows. A divider between rows that the
    // rect merely crosses is not content; a redaction fill is, whatever colour
    // the ground is, so a bracket is never drawn through one.
    const inkBesideRows = (rect, ref) => {
      const [x, y, w, h] = rect;
      const rules = src.geo.rulesAcross(pixels, [Math.floor(fx + x / S), Math.floor(fy + y / S), Math.ceil(fx + (x + w) / S) + 1, Math.ceil(fy + (y + h) / S) + 1], solved.frame);
      return inkIn(rect, ref, (sx, sy) => onFill(sx, sy) || (!rules.has(sy) && differs((sy * pixels.width + sx) * 4, ref)));
    };
    return { colourAt, differs, groundOf, inkIn, inkBesideRows, onFill };
  }

  // The redacted source cut to `rect` (capture px) rounded outward to whole pixels and
  // held inside the shown frame rounded inward; `offset` is where `rect` starts inside the cut.
  // With `cover` (from solve), each of its bands' pixels on the dropped rule (onRule) takes
  // the band's ground; a fill's pixels are left as they are, the fill being that colour too.
  function cropUrl(src, rect, cover) {
    const [sx, sy, sw, sh] = src.shown;
    const x0 = Math.max(Math.floor(rect[0]), Math.ceil(sx)); const y0 = Math.max(Math.floor(rect[1]), Math.ceil(sy));
    const x1 = Math.min(Math.ceil(rect[0] + rect[2]), Math.floor(sx + sw), src.canvas.width); const y1 = Math.min(Math.ceil(rect[1] + rect[3]), Math.floor(sy + sh), src.canvas.height);
    const w = Math.max(1, x1 - x0); const h = Math.max(1, y1 - y0);
    const cut = document.createElement('canvas'); cut.width = w; cut.height = h;
    const ctx = cut.getContext('2d');
    ctx.drawImage(src.canvas, x0, y0, w, h, 0, 0, w, h);
    if (cover) {
      const image = ctx.getImageData(0, 0, w, h);
      const inFill = (x, y) => src.fillRects.some((fill) => inRect(fill, x, y));
      for (const { rect: [bx, by, bw, bh], ground, colour } of cover.bands) {
        for (let y = Math.max(by, y0); y < Math.min(by + bh, y1); y += 1) {
          for (let x = Math.max(bx, x0); x < Math.min(bx + bw, x1); x += 1) {
            const at = ((y - y0) * w + x - x0) * 4;
            if (!inFill(x, y) && src.geo.onRule(image.data, at, ground, colour)) image.data.set(ground, at);
          }
        }
      }
      ctx.putImageData(image, 0, 0);
    }
    return { url: cut.toDataURL('image/png'), size: [w, h], offset: [rect[0] - x0, rect[1] - y0] };
  }

  // A clean edge line between two letters still cuts a word, so the lines beyond the edge are read too. A fade
  // never tints a fill: its ground skips fill pixels, and it is cut into `parts` around every fill it meets.
  function fadesOf(src, solved, fills) {
    const { frame, cropEdges, cropped, cw, ch, S } = solved;
    const cut = (side) => src.cleaned.edges[side] === 'cut';
    const through = (side) => (cropped ? cropEdges[side] === 'margin' || (['clamped', 'frame'].includes(cropEdges[side]) && cut(side)) : cut(side))
      && !src.geo.edgeInGap(src.pixels, frame, side, null, src.fillRects);
    const strips = { left: [0, 0, FADE, ch], top: [0, 0, cw, FADE], right: [cw - FADE, 0, FADE, ch], bottom: [0, ch - FADE, cw, FADE] };
    return SIDES.flatMap((side) => {
      const ground = through(side) ? src.geo.edgeGround(src.pixels, frame, side, src.fillRects, FADE / S) : null;
      if (!ground) return [];
      const rect = strips[side];
      const across = side === 'top' || side === 'bottom';
      const [from, to] = across ? [rect[0], rect[0] + rect[2]] : [rect[1], rect[1] + rect[3]];
      const blocked = fills.filter((fill) => hits(fill, rect)).map((fill) => (across ? [Math.floor(fill[0]), Math.ceil(fill[0] + fill[2])] : [Math.floor(fill[1]), Math.ceil(fill[1] + fill[3])]))
        .sort((a, b) => a[0] - b[0]);
      const spans = [];
      let at = from;
      for (const [a, b] of blocked) { if (a > at) spans.push([at, a]); at = Math.max(at, b); }
      if (at < to) spans.push([at, to]);
      const parts = spans.map(([a, b]) => (across ? [a, rect[1], b - a, rect[3]] : [rect[0], a, rect[2], b - a]));
      return [{ side, rect, ground: [...ground], parts }];
    });
  }

  // A rect less than `min` board px on a side grows to it about its centre, kept inside the cw by ch capture.
  const atLeast = ([x, y, w, h], min, cw, ch) => {
    const grow = (at, size, room) => {
      if (size >= min) return [at, size];
      const to = Math.min(min, room);
      return [Math.min(Math.max(0, at - (to - size) / 2), room - to), to];
    };
    const [gx, gw] = grow(x, w, cw); const [gy, gh] = grow(y, h, ch);
    return [gx, gy, gw, gh];
  };
  // A side of `rect` that meets a fill, or comes within SLOT_FILL_GAP of it, moves back to stand SLOT_FILL_GAP short
  // of it: the side that moves least. With `capture` ([cw, ch]), a side that would leave the rect under `min` on that
  // axis may move the whole rect instead, inside the capture and only to where it stands SLOT_FILL_GAP off every fill;
  // with no such move the side moves as it would without `min`, since a fill wins over a slot. A fill deep inside the
  // rect meets no side, and a slot no side can clear stays.
  const standOff = (rect, fills, min = 1, capture = null) => {
    let r = [rect[0], rect[1], rect[0] + rect[2], rect[1] + rect[3]];
    const g = SLOT_FILL_GAP;
    const near = ([x0, y0, x1, y1], [fx, fy, fw, fh]) => fx < x1 + g && fx + fw > x0 - g && fy < y1 + g && fy + fh > y0 - g;
    const AXIS = { x0: [0, 2], y0: [1, 3], x1: [2, 0], y1: [3, 1] };
    const step = (key, by, shift) => {
      const [moved, opposite] = AXIS[key]; const sign = key === 'x0' || key === 'y0' ? 1 : -1;
      const next = r.slice(); next[moved] += sign * by; next[opposite] += sign * shift;
      return next;
    };
    for (const fill of fills) {
      const [fx, fy, fw, fh] = fill; const [x0, y0, x1, y1] = r;
      const deep = fx >= x0 + g && fx + fw <= x1 - g && fy >= y0 + g && fy + fh <= y1 - g;
      if (!near(r, fill) || deep) continue;
      const room = capture ? [capture[0] - x1, capture[1] - y1, x0, y0] : [0, 0, 0, 0];
      // [side, how far it moves inward, the size left, the room past the opposite side to move the rect instead]
      const moves = [['x0', fx + fw + g - x0, x1 - (fx + fw + g), room[0]], ['y0', fy + fh + g - y0, y1 - (fy + fh + g), room[1]],
        ['x1', x1 - (fx - g), fx - g - x0, room[2]], ['y1', y1 - (fy - g), fy - g - y0, room[3]]]
        .filter(([, by, left]) => by > 0 && left >= 1).sort((a, b) => a[1] - b[1]);
      const kept = moves.map(([key, by, left, past]) => {
        if (left >= min) return step(key, by, 0);
        if (by > past) return null;
        const next = step(key, by, by);
        return fills.every((other) => !near(next, other)) ? next : null;
      }).find(Boolean);
      if (kept) r = kept;
      else if (moves.length) r = step(moves[0][0], moves[0][1], 0);
    }
    return [r[0], r[1], r[2] - r[0], r[3] - r[1]];
  };

  function drawPanel(src, solved, host, head) {
    const { dark, redactFill } = src;
    const { groups, plans, finals, frame, cropEdges, cropped, trimmed, S, cw, ch, map } = solved;
    const [fx, fy] = frame;
    const notes = [...src.notes, ...solved.notes];
    const warn = (message) => notes.push(message);
    const crops = new Map();
    const crop = (rect, cover) => {
      const key = cover ? `${rect.join(',')}|${cover.bands.map((band) => band.rect.join(',')).join('|')}` : rect.join(',');
      if (!crops.has(key)) crops.set(key, cropUrl(src, rect, cover));
      return crops.get(key);
    };
    // A layer shows only its own rect, cut at whole pixels: a layer positioned at a
    // fractional device pixel then has no neighbouring row of the capture to blend in.
    const bg = (node, x, y, k, rect, cover) => {
      const { url: cut, size, offset } = crop(rect, cover);
      node.style.backgroundImage = `url(${cut})`;
      node.style.backgroundSize = `${size[0] * S * k}px ${size[1] * S * k}px`;
      node.style.backgroundPosition = `${-(offset[0] + x - rect[0]) * S * k}px ${-(offset[1] + y - rect[1]) * S * k}px`;
    };

    const col = el('div', 'panel', host);
    let phead = null; let pnote = null;
    if (head.headed) {
      phead = el('div', 'phead', col);
      if (head.number) el('span', 'num', phead, String(head.number));
      if (src.panel.label) el('span', 'plabel', phead, src.panel.label);
      if (src.panel.tag) el('span', `tag ${src.panel.tag}`, phead, src.panel.tag);
      if (src.imported) el('span', 'origin', phead, 'From the ticket');
      if (head.noted) pnote = el('div', 'pnote', col, src.panel.note || '');
    }
    const comp = el('div', 'comp', col);
    const cap = el('div', 'capture', comp); place(cap, 0, 0, cw, ch);
    bg(el('div', 'fill', cap), fx, fy, 1, frame);
    const clip = ([x, y, w, h]) => {
      const x0 = Math.max(0, x); const y0 = Math.max(0, y); const x1 = Math.min(cw, x + w); const y1 = Math.min(ch, y + h);
      return x1 > x0 && y1 > y0 ? [x0, y0, x1 - x0, y1 - y0] : null;
    };
    const drawnSets = src.fillSets.map((rects) => rects.flatMap((fill) => { const drawn = clip(map(fill)); return drawn ? [drawn] : []; }));
    const drawnFills = drawnSets.flat();
    const fades = fadesOf(src, solved, drawnFills);
    for (const { side, ground, parts } of fades) {
      for (const part of parts) {
        const node = el('div', 'fade', cap); place(node, ...part);
        node.style.background = `linear-gradient(to ${side}, rgba(${ground.join(',')},0), rgb(${ground.join(',')}))`;
      }
    }
    const washed = groups.length > 0 || Boolean(src.washAll);
    if (washed) el('div', `wash${dark ? ' dark' : ''}`, cap);

    const panel = {
      source: src.imported ? 'import' : 'live',
      dark,
      capture: [0, 0, cw, ch],
      scale: src.scale,
      frame,
      cleanFrame: src.cleaned.frame,
      frameEdges: src.cleaned.edges,
      wholeFrame: src.shown,
      air: { ...src.air },
      cropped,
      ...(cropped ? { cropEdges } : {}),
      trimmed: { ...trimmed },
      fades,
      wash: washed,
      targets: [], lifts: [], links: [], slots: [], brackets: [], loupes: [], flats: [], labels: [], leaders: [], connectors: [], dots: [], redactions: [],
    };
    const { targets } = panel;
    const probe = probes(src, solved);
    const anchors = [];
    const glyphs = [];
    let gutter = 0;
    // An imported slot is drawn by eye, so it snaps to its blank. A ghost grows to be seen, and a fill wins over any slot.
    for (const slot of src.slotMarks) {
      const box = src.imported ? src.geo.snapSlot(src.pixels, slot.box, { keep: src.fillRects }) : slot.box;
      const drawn = clip(map(box));
      if (!drawn) continue;
      const rect = slot.kind === 'ghost' ? standOff(atLeast(drawn, GHOST_MIN, cw, ch), drawnFills, GHOST_MIN, [cw, ch]) : standOff(drawn, drawnFills);
      // A ghost hatches a blank; over content, or inside a fill, it is an outline alone, so the content stays readable.
      // It is read where it is drawn, grown and stood off.
      const under = clampTo([fx + rect[0] / S, fy + rect[1] / S, rect[2] / S, rect[3] / S], frame);
      const hatched = slot.kind === 'ghost' && !src.fillRects.some((fill) => encloses(fill, under)) && !src.geo.holdsContent(src.pixels, under);
      const node = el('div', `slot ${slot.kind}${dark ? ' dark' : ''}${slot.kind === 'ghost' && !hatched ? ' over' : ''}`, cap); place(node, ...rect);
      let text = null; let { title } = slot.mark;
      if (slot.kind === 'empty') {
        const words = slot.mark.text ?? 'Nothing rendered here';
        // A driver's own text is a callout like any mark's, so it is a label and not words on the image as well.
        if (slot.mark.text !== undefined && !title) { text = 'label'; title = words; } else {
          const span = el('span', null, node, words); const size = span.getBoundingClientRect();
          if (size.width + 16 <= rect[2] && size.height + 8 <= rect[3]) text = 'inside';
          else {
            span.remove(); text = title ? 'dropped' : 'label';
            if (title) warn('an empty slot is too small for its text'); else title = words;
          }
        }
      }
      panel.slots.push({ kind: slot.kind, mark: slot.markIndex, rect, text, ...(slot.kind === 'ghost' ? { hatched } : {}) });
      const target = targets.push({ kind: 'slot', mark: slot.markIndex, rect, ring: 0, dot: true, source: box, pad: [0, 0, 0, 0] }) - 1;
      if (title) anchors.push({ mark: slot.mark, markIndex: slot.markIndex, label: { title, note: slot.mark.note, tag: slot.mark.tag }, members: [target] });
    }
    plans.forEach((p, i) => {
      const { group, b, grown, pad, bb, cover } = p;
      const { rect: [L, T, W, H], clamped, k: kEff, tiny } = finals[i];
      // bg() positions the source at -bb * S * k, so a clamped lift still
      // shows its own region wherever it ends up.
      const lift = el('div', `lift${dark ? ' dark' : ''}`, comp); place(lift, L, T, W, H);
      bg(lift, bb[0], bb[1], kEff, bb, cover);
      panel.lifts.push({ keys: group.keys, mark: group.markIndex, rect: [L, T, W, H], clamped, grown, pad, source: b, k: kEff, tiny, adopted: group.keys.some((key) => src.adopted.has(key)), ...(group.merged ? { merged: true } : {}) });
      targets.push({ kind: 'lift', mark: group.markIndex, rect: [L, T, W, H], lift: panel.lifts.length - 1, ring: LIFT_RING, dot: true, source: b, pad });
      if (group.mark.title) {
        const entry = anchors.find((a) => a.mark === group.mark)
          || anchors[anchors.push({ mark: group.mark, markIndex: group.markIndex, label: { title: group.mark.title, note: group.mark.note, tag: group.mark.tag }, members: [] }) - 1];
        entry.members.push(targets.length - 1);
      }
    });

    for (const { markIndex, kind } of src.liftMarks) {
      if (kind !== 'link') continue;
      panel.links.push({ mark: markIndex, targets: targets.flatMap((t, i) => (t.kind === 'lift' && t.mark === markIndex ? [i] : [])) });
    }

    for (const b of src.bracketMarks) {
      let rowsRect = clip(map(b.rows));
      if (!rowsRect) continue;
      const edge = [fx + (rowsRect[0] + rowsRect[2]) / S - BRACKET_PROBE, fy + rowsRect[1] / S, BRACKET_PROBE, rowsRect[3] / S];
      const ref = probe.groundOf({ source: edge, pad: [0, 0, 0, 0] }, 'right');
      let x = null; let slid = 0; let inMargin = false;
      // With no clear spot a bracket stands on the content beside its rows, but
      // never on a fill: its rows then run to the fill's far side and it looks
      // again from there. Each pass ends further right, so the frame's edge ends it.
      for (let blocked = true; blocked;) {
        const right = rowsRect[0] + rowsRect[2];
        for (let d = 0; d <= BRACKET_REACH; d += BRACKET_STEP) {
          const at = right + BRACKET_GAP + d;
          if (at + BRACKET_ARM > cw - BRACKET_EDGE) { inMargin = true; break; }
          const strip = [at - BRACKET_CLEAR, rowsRect[1], BRACKET_ARM + 2 * BRACKET_CLEAR, rowsRect[3]];
          if (probe.inkBesideRows(strip, ref) === 0 && !targets.some((t) => t.kind === 'lift' && hits(strip, t.rect))) { x = at; slid = d; break; }
        }
        const across = x === null && !inMargin ? drawnFills.filter((fill) => hits([right + BRACKET_GAP, rowsRect[1], BRACKET_ARM, rowsRect[3]], fill)) : [];
        blocked = across.length > 0;
        if (blocked) rowsRect = [rowsRect[0], rowsRect[1], Math.max(...across.map((fill) => fill[0] + fill[2])) - rowsRect[0], rowsRect[3]];
      }
      const right = rowsRect[0] + rowsRect[2];
      if (panel.wash) {
        const flat = el('div', 'flat', cap); place(flat, ...rowsRect);
        bg(flat, fx + rowsRect[0] / S, fy + rowsRect[1] / S, 1, [fx + rowsRect[0] / S, fy + rowsRect[1] / S, rowsRect[2] / S, rowsRect[3] / S]);
        panel.flats.push({ mark: b.markIndex, rect: rowsRect });
      }
      if (inMargin) { x = cw + BRACKET_GAP; gutter = BRACKET_GUTTER; }
      if (x === null) { x = right + BRACKET_GAP; warn('a bracket sits on page content'); }
      const rect = [x, rowsRect[1], BRACKET_ARM, rowsRect[3]];
      glyphs.push(rect);
      panel.brackets.push({ mark: b.markIndex, rows: rowsRect, rect, slid, inMargin });
      const source = [fx + x / S, fy + rect[1] / S, BRACKET_ARM / S, rect[3] / S];
      const target = targets.push({ kind: 'bracket', mark: b.markIndex, rect, ring: 0, dot: false, source, pad: [0, 0, 0, 0] }) - 1;
      anchors.push({ mark: b.mark, markIndex: b.markIndex, label: { title: b.mark.title, note: b.mark.note, tag: b.mark.tag }, members: [target] });
    }

    for (const l of src.loupeMarks) {
      const box = clip(map(l.box));
      if (!box) continue;
      const r = Math.min(Math.max(box[2], box[3]) / 2 + LOUPE_PAD, cw / 2, ch / 2);
      const cx = Math.min(Math.max(box[0] + box[2] / 2, r), cw - r); const cy = Math.min(Math.max(box[1] + box[3] / 2, r), ch - r);
      const ring = [cx - r, cy - r, 2 * r, 2 * r];
      const patch = el('div', 'patch', cap); place(patch, ...ring); bg(patch, fx + ring[0] / S, fy + ring[1] / S, 1, [fx + ring[0] / S, fy + ring[1] / S, ring[2] / S, ring[3] / S]);
      place(el('div', 'ring', cap), ...ring);
      const asked = l.mark.zoom ?? LOUPE_ZOOM;
      const zoom = Math.max(1, Math.min(asked, (LOUPE_FILL * LENS_D) / Math.max(box[2], box[3])));
      if (l.mark.zoom != null && zoom < LOUPE_WARN * asked) warn('a loupe was zoomed out to fit its target');
      const target = targets.push({ kind: 'ring', mark: l.markIndex, rect: ring, ring: 0, dot: false, source: l.box, pad: [0, 0, 0, 0] }) - 1;
      anchors.push({
        mark: l.mark, markIndex: l.markIndex, members: [target],
        label: l.mark.title ? { title: l.mark.title, note: l.mark.note, tag: l.mark.tag } : null,
        lens: { centre: [box[0] + box[2] / 2, box[1] + box[3] / 2], box: [fx + box[0] / S, fy + box[1] / S, box[2] / S, box[3] / S], zoom, asked },
      });
    }

    // A redaction is its rects, drawn where the board shows them, and `rect` their bounding box.
    for (const rects of drawnSets) if (rects.length) panel.redactions.push({ rect: union(rects), rects, fill: redactFill });
    // What each redaction's gate crop takes in besides its fill: the ink just past it, within the shown frame.
    const glances = drawnSets.flatMap((rects, i) => {
      if (!rects.length) return [];
      const drawn = union(rects);
      const peek = src.fillNotes[i]?.peek;
      return [union([drawn, peek ? clip(map(peek)) ?? drawn : drawn])];
    });

    // The capped sides of a fill the board leaves out past which, along its own rows or columns out to the frame,
    // the crop shows: that value's ink runs into the board.
    const runsIn = (i) => {
      if (drawnSets[i].length) return [];
      const [x, y, w, h] = union(src.fillSets[i]); const [bx, by, bw, bh] = src.capture.frame;
      const past = { left: [bx, y, x - bx, h], right: [x + w, y, bx + bw - x - w, h], top: [x, by, w, y - by], bottom: [x, y + h, w, by + bh - y - h] };
      return src.fillNotes[i].capped.filter(({ side, refuse }) => refuse && past[side][2] > 0 && past[side][3] > 0 && hits(past[side], frame)).map(({ side }) => side);
    };

    panel.pins = []; panel.legend = [];
    return { col, phead, pnote, number: head.number, comp, panel, notes, glances, unseen: drawnSets.filter((rects) => !rects.length).length, fillNotes: src.fillNotes.flatMap((note, i) => (note ? [{ ...note, shown: drawnSets[i].length > 0, runsIn: runsIn(i) }] : [])), router: router({ comp, src, solved, targets, anchors, report: panel, warn, probe, glyphs, gutter }) };
  }

  // `survey` says what each side would cost this panel's labels, and `draw` routes them once the board has chosen.
  function router(ctx) {
    const { comp, src, solved, targets, anchors, report, warn, probe, glyphs, gutter } = ctx;
    const { pixels } = src;
    const { colourAt, differs, groundOf, onFill } = probe;
    // Whether a pixel differs from every one of `grounds`.
    const unlike = (px, grounds) => grounds.every((ground) => differs(px, ground));
    const { frame, S, cw, ch } = solved;
    const [fx, fy] = frame;
    const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'ov'); comp.appendChild(svg);
    const stroke = (runs, colour, width, join) => {
      if (!runs.length) return;
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', runs.map((run) => `M ${run.map((q) => q.join(' ')).join(' L ')}`).join(' '));
      p.setAttribute('fill', 'none'); p.setAttribute('stroke', colour); p.setAttribute('stroke-width', width);
      if (join) p.setAttribute('stroke-linejoin', join);
      svg.appendChild(p);
    };
    // The stretch of a segment that lies inside the capture, as [from, to] along it, or null.
    const withinCapture = ([x0, y0], [x1, y1]) => {
      let from = 0; let to = 1;
      for (const [p, q] of [[x0 - x1, x0], [x1 - x0, cw - x0], [y0 - y1, y0], [y1 - y0, ch - y0]]) {
        if (p === 0) { if (q < 0) return null; continue; }
        if (p < 0) from = Math.max(from, q / p); else to = Math.min(to, q / p);
      }
      return from < to ? [from, to] : null;
    };
    // On a dark frame a line is two paths, split where it crosses the capture's edge: light inside, the accent outside.
    const line = (points, { width = LEADER_WIDTH, join } = {}) => {
      if (!src.dark) { stroke([points], STROKE, width, join); return; }
      const runs = { inside: [], outside: [] };
      const add = (where, a, b) => {
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-9) return;
        const last = runs[where].at(-1); const end = last?.at(-1);
        if (end && Math.hypot(end[0] - a[0], end[1] - a[1]) < 1e-9) last.push(b); else runs[where].push([a, b]);
      };
      for (let k = 0; k < points.length - 1; k += 1) {
        const [a, b] = [points[k], points[k + 1]];
        const at = (t) => (t <= 0 ? a : t >= 1 ? b : [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        const span = withinCapture(a, b);
        if (!span) { add('outside', a, b); continue; }
        add('outside', a, at(span[0])); add('inside', at(span[0]), at(span[1])); add('outside', at(span[1]), b);
      }
      stroke(runs.inside, DARK_STROKE, width, join); stroke(runs.outside, STROKE, width, join);
    };
    const placed = [];
    const dot = ([cx, cy], target, slid) => {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', DOT_R);
      c.setAttribute('fill', STROKE); c.setAttribute('stroke', '#fff'); c.setAttribute('stroke-width', 2);
      svg.appendChild(c); report.dots.push({ center: [cx, cy], r: DOT_OUTER, target, slid });
    };
    const makeLabel = ({ title, note, tag }) => {
      const lab = el('div', 'label', comp); const row = el('div', 'lrow', lab);
      if (tag) el('span', `tag ${tag}`, row, tag);
      el('span', 'ltitle', row, title);
      if (note) el('div', 'lnote', lab, note);
      return lab;
    };

    // The lens is resampled at device pixels from the redacted copy (src.pixels, read after every fill and
    // the air were painted), and only from the shown frame cut inward to whole pixels: no tap reads page that
    // the crop left out or a redaction hides. A device pixel whose centre falls outside that frame stays
    // bare, so the lens's own ground shows there, as it does round a frame drawn whole.
    const lensFrame = (() => {
      const [sx, sy, sw, sh] = src.shown;
      const x0 = Math.ceil(Math.max(fx, sx)); const y0 = Math.ceil(Math.max(fy, sy));
      const x1 = Math.floor(Math.min(fx + frame[2], sx + sw)); const y1 = Math.floor(Math.min(fy + frame[3], sy + sh));
      return [x0, y0, x1 - x0, y1 - y0];
    })();
    const drawLens = (a, lx, ly) => {
      const lens = el('div', `lens${src.dark ? ' dark' : ''}`, comp); place(lens, lx, ly, LENS_D, LENS_D);
      const z = a.lens.zoom;
      const dpr = window.devicePixelRatio || 1;
      const n = Math.round(LENS_D * dpr);
      const k = n / (LENS_D / (S * z));
      const from = [fx + a.lens.centre[0] / S, fy + a.lens.centre[1] / S];
      const win = src.geo.lensView(src.pixels, from, LENS_D / (2 * S * z), a.lens.box, { bounds: lensFrame, keep: src.fillRects });
      const rx = win.centre[0] - n / (2 * k); const ry = win.centre[1] - n / (2 * k);
      const span = (start, lo, size) => [Math.max(0, Math.ceil((lo - start) * k - 0.5)), Math.min(n - 1, Math.floor((lo + size - start) * k - 0.5))];
      const [i0, i1] = span(rx, lensFrame[0], lensFrame[2]); const [j0, j1] = span(ry, lensFrame[1], lensFrame[3]);
      if (i1 >= i0 && j1 >= j0) {
        const w = i1 - i0 + 1; const h = j1 - j0 + 1;
        const source = [rx + i0 / k, ry + j0 / k, w / k, h / k];
        let read = src.pixels; let at = [0, 0]; let clip = lensFrame;
        if (win.hide.length) {
          // A copy of the source the kernel reads, the window and its reach, with the slivers painted out.
          const margin = Math.ceil(3 * Math.max(1, 1 / k)) + 2;
          const cx0 = Math.max(lensFrame[0], Math.floor(source[0] - margin)); const cy0 = Math.max(lensFrame[1], Math.floor(source[1] - margin));
          const cx1 = Math.min(lensFrame[0] + lensFrame[2], Math.ceil(source[0] + source[2] + margin)); const cy1 = Math.min(lensFrame[1] + lensFrame[3], Math.ceil(source[1] + source[3] + margin));
          const cutW = cx1 - cx0; const copy = new Uint8ClampedArray(cutW * (cy1 - cy0) * 4);
          for (let y = cy0; y < cy1; y += 1) copy.set(src.pixels.data.subarray((y * src.pixels.width + cx0) * 4, (y * src.pixels.width + cx1) * 4), (y - cy0) * cutW * 4);
          win.hide.forEach((i, m) => {
            const x = i % src.pixels.width; const y = (i - x) / src.pixels.width;
            if (x >= cx0 && x < cx1 && y >= cy0 && y < cy1) copy.set([...win.paint[m], 255], ((y - cy0) * cutW + x - cx0) * 4);
          });
          read = { width: cutW, height: cy1 - cy0, data: copy }; at = [cx0, cy0]; clip = [0, 0, cutW, cy1 - cy0];
        }
        const { data } = resampleLanczos(read, [source[0] - at[0], source[1] - at[1], source[2], source[3]], w, h, clip);
        const view = el('canvas', 'lensview', lens); view.width = w; view.height = h;
        view.getContext('2d').putImageData(new ImageData(data, w, h), 0, 0);
        place(view, i0 / dpr, j0 / dpr, w / dpr, h / dpr);
      }
      place(el('div', 'ztag', comp, `${Math.round(z * 10) / 10}×`), lx + LENS_D - ZTAG_INSET_X, ly + LENS_D - ZTAG_INSET_Y);
      report.loupes.push({ mark: a.markIndex, target: a.primary, ring: targets[a.primary].rect, lens: [lx, ly, LENS_D, LENS_D], zoom: z, asked: a.lens.asked,
        moved: [0, 1].map((d) => (win.centre[d] - from[d]) / src.scale), hidden: win.hide.length });
    };

    const hitsOther = (index, x0, y0, x1, y1) => targets.some((t, i) => {
      if (i === index || t.kind === 'bracket') return false;
      const [lx, ly, lw, lh] = t.rect;
      return lx <= x1 && lx + lw >= x0 && ly <= y1 && ly + lh >= y0;
    });
    const dotOff = (index) => (targets[index].dot ? DOT_OUTER + targets[index].ring : 0);
    // Where a leader leaves a side when nothing moves it: the middle, but under a bracket the foot of its upright, so the leader carries the upright on and does not jog off its arm.
    const middleOf = (index, side) => {
      const { kind, rect: [x, y, w, h] } = targets[index];
      return side === 'right' ? y + h / 2 : kind === 'bracket' ? x + w : x + w / 2;
    };
    // A path is as wide as its dot, ring included, so a side is clear only if
    // the dot also stays off every other mark's target but a bracket.
    const clearOf = (index, side, along) => {
      const [x, y, w, h] = targets[index].rect;
      const off = dotOff(index);
      const at = along ?? middleOf(index, side);
      return side === 'right'
        ? !hitsOther(index, x + w, at - off, cw + 2 * off, at + off)
        : !hitsOther(index, at - off, y + h, at + off, ch + 2 * off);
    };
    const reach = (index, side) => { const [x, y, w, h] = targets[index].rect; return side === 'right' ? x + w : y + h; };
    // The strip a card leaves between its ring and the frame edge: a crop edge puts a border pixel there at one device
    // scale and not at another, so it is not counted as page content under a dot.
    const FRAME_SLACK = LIFT_EDGE - LIFT_RING;
    // The page just outside a target along `path`: the median colour of its
    // first GROUND_RUN samples, null where the path starts outside the capture.
    const pageBeside = ([[x0, y0], [x1, y1]]) => {
      const len = Math.hypot(x1 - x0, y1 - y0); const n = Math.max(1, Math.ceil(len / 2));
      const channels = [[], [], []];
      for (let t = 0; t < Math.min(GROUND_RUN, n + 1); t += 1) {
        const sx = Math.floor(fx + (x0 + ((x1 - x0) * t) / n) / S); const sy = Math.floor(fy + (y0 + ((y1 - y0) * t) / n) / S);
        if (sx < 0 || sy < 0 || sx >= pixels.width || sy >= pixels.height || onFill(sx, sy)) continue;
        colourAt((sy * pixels.width + sx) * 4).forEach((v, c) => channels[c].push(v));
      }
      return channels[0].length ? channels.map((values) => values.sort((a, b) => a - b)[values.length >> 1]) : null;
    };
    // A target on a pill or a card of its own stands on that ground, and its leader leaves it for the frame's: a
    // step from the one flat ground to the other is not content. So a first run is read against `near`, the
    // ground it starts on, and the ground of the frame on the side it leaves by: the median of the line
    // FRAME_SLACK inside that edge, which a block that ends at the edge cannot become. A fill is no ground.
    const edgeGrounds = new Map();
    const edgeGround = (side) => {
      if (!edgeGrounds.has(side)) {
        const right = side === 'right';
        const fixed = Math.min(Math.floor(right ? fx + (cw - FRAME_SLACK) / S : fy + (ch - FRAME_SLACK) / S), (right ? pixels.width : pixels.height) - 1);
        const [from, to] = right ? [Math.max(0, Math.floor(fy)), Math.min(pixels.height, Math.ceil(fy + ch / S))] : [Math.max(0, Math.floor(fx)), Math.min(pixels.width, Math.ceil(fx + cw / S))];
        edgeGrounds.set(side, src.geo.lineMedian(pixels, { horizontal: !right, fixed, from, to }, src.fillRects));
      }
      return edgeGrounds.get(side);
    };
    const groundsFor = (near, side) => [near, edgeGround(side)].filter(Boolean);
    // Samples along a route where the capture's pixels differ from every colour
    // of `fixed` (by default the route's own first sample, the clean padding beside
    // a lift): how much page content the route would strike through.
    // With `wide`, a sample also counts when a capture pixel beside the centre
    // line differs, as far as the drawn stroke and LEADER_CLEAR reach. A sample
    // on a redaction fill counts whatever its colour. A sample `skip` (sx, sy)
    // takes is not counted.
    const inkAlong = (points, fixed, wide = false, skip = null) => {
      const capturePoint = ([x, y]) => [Math.floor(fx + x / S), Math.floor(fy + y / S)];
      const at = (point) => {
        const [sx, sy] = capturePoint(point);
        return sx < 0 || sy < 0 || sx >= pixels.width || sy >= pixels.height ? -1 : (sy * pixels.width + sx) * 4;
      };
      const reachPixels = wide ? Math.ceil((LEADER_WIDTH / 2 + LEADER_CLEAR) / S) : 0;
      const beside = (x, y, nx, ny, reach, ref) => {
        for (let j = 1; j <= reach; j += 1) {
          for (const d of [-j * S, j * S]) {
            const near = [x + nx * d, y + ny * d];
            const side = at(near);
            if (side >= 0 && (unlike(side, ref) || onFill(...capturePoint(near)))) return true;
          }
        }
        return false;
      };
      let ref = fixed?.length ? fixed : null; let ink = 0;
      for (let k = 0; k < points.length - 1; k += 1) {
        const [x0, y0] = points[k]; const [x1, y1] = points[k + 1];
        const len = Math.hypot(x1 - x0, y1 - y0);
        const n = Math.ceil(len / 2);
        const nx = len ? -(y1 - y0) / len : 0; const ny = len ? (x1 - x0) / len : 0;
        for (let t = 0; t <= n; t += 1) {
          const x = x0 + ((x1 - x0) * t) / n; const y = y0 + ((y1 - y0) * t) / n;
          const px = at([x, y]);
          if (px < 0 || x > cw || y > ch) continue;
          if (onFill(...capturePoint([x, y]))) ink += 1;
          else if (skip && skip(...capturePoint([x, y]))) continue;
          else if (!ref) ref = [colourAt(px)];
          else if (unlike(px, ref)) ink += 1;
          else if (reachPixels && beside(x, y, nx, ny, reachPixels, ref)) ink += 1;
        }
      }
      return ink;
    };
    // Every source pixel whose centre falls inside the dot's footprint, so a
    // thin stroke between two sample points cannot slip through. The clear
    // space reaches under the lift's own ring, where the board shows the lift
    // and not the page, so what a lift covers is not counted.
    const footprintInk = ([x, y], grounds, radius = FOOT_R, own = null) => {
      const r = radius / S; const ux = fx + x / S; const uy = fy + y / S;
      let ink = 0;
      for (let sy = Math.floor(uy - r); sy <= Math.ceil(uy + r); sy += 1) {
        for (let sx = Math.floor(ux - r); sx <= Math.ceil(ux + r); sx += 1) {
          if (Math.hypot(sx + 0.5 - ux, sy + 0.5 - uy) > r || sx < 0 || sy < 0 || sx >= pixels.width || sy >= pixels.height) continue;
          const dx = (sx + 0.5 - fx) * S; const dy = (sy + 0.5 - fy) * S;
          if (dx < FRAME_SLACK || dy < FRAME_SLACK || dx > cw - FRAME_SLACK || dy > ch - FRAME_SLACK) continue;
          if (targets.some(({ kind, rect: [lx, ly, lw, lh], ring }) => kind === 'lift' && dx >= lx - ring && dx <= lx + lw + ring && dy >= ly - ring && dy <= ly + lh + ring)) continue;
          if (own && dx >= own[0] && dx <= own[0] + own[2] && dy >= own[1] && dy <= own[1] + own[3]) continue;
          if (onFill(sx, sy) || unlike((sy * pixels.width + sx) * 4, grounds)) ink += 1;
        }
      }
      return ink;
    };
    // A leader's first segment runs from its target to the capture's edge, and
    // the survey scores a side by the content over its middle: against
    // the clean padding at the lift's own edge for a dot, against the page just
    // beside the target for a ring or bracket, which also counts content within
    // the stroke and LEADER_CLEAR of it. A bracket's leader, like its arm,
    // merely crosses the dividers and the border of the rows it stands beside:
    // a rule across its route is not content. Samples two board px apart catch a
    // hairline at one device scale and miss it at another.
    const ruleAcross = ([[x0, y0], [x1, y1]], side) => {
      const reach = Math.ceil((LEADER_WIDTH / 2 + LEADER_CLEAR) / S);
      const [sx0, sy0, sx1, sy1] = [Math.floor(fx + x0 / S), Math.floor(fy + y0 / S), Math.floor(fx + x1 / S), Math.floor(fy + y1 / S)];
      const rules = src.geo.rulesAcross(pixels, [sx0 - (side === 'right' ? 0 : reach), sy0 - (side === 'right' ? reach : 0), sx1 + 1 + (side === 'right' ? 0 : reach), sy1 + 1 + (side === 'right' ? reach : 0)], solved.frame, side === 'right');
      return (sx, sy) => rules.has(side === 'right' ? sx : sy);
    };
    const scores = new Map();
    const leaderInk = (index, side) => {
      const key = `${index}:${side}`;
      if (!scores.has(key)) {
        const [x, y, w, h] = targets[index].rect;
        const off = dotOff(index);
        const mid = middleOf(index, side);
        const path = side === 'right' ? [[x + w + off, mid], [cw, mid]] : [[mid, y + h + off], [mid, ch]];
        const grounds = groundsFor(targets[index].dot ? groundOf(targets[index], side) : pageBeside(path), side);
        scores.set(key, targets[index].dot ? inkAlong(path, grounds) : inkAlong(path, grounds, true, targets[index].kind === 'bracket' ? ruleAcross(path, side) : null));
      }
      return scores.get(key);
    };
    // Where a dot sits on one side of its target: the spot along the side with
    // the least ink within LEADER_CLEAR of its first segment, the one nearest
    // the middle on a tie. `clean` says the spot meets every hard requirement
    // and its first segment strikes fewer than LEADER_THROUGH samples; with
    // none that does, the dot takes the least-ink spot that meets the hard
    // requirements, or the least-ink spot at all. `slid` is the
    // offset from the middle.
    const dotOn = (index, side) => {
      const [x, y, w, h] = targets[index].rect;
      const off = dotOff(index);
      const grounds = groundsFor(groundOf(targets[index], side), side);
      const [lo, span] = side === 'right' ? [y, h] : [x, w];
      const centre = lo + span / 2;
      const pointAt = (p) => (side === 'right' ? [x + w + off, p] : [p, y + h + off]);
      const cost = (p) => inkAlong([pointAt(p), side === 'right' ? [cw, p] : [p, ch]], grounds, true);
      const accept = (p) => {
        if (!clearOf(index, side, p)) return false;
        const point = pointAt(p);
        return !placed.some(([px, py]) => Math.hypot(px - point[0], py - point[1]) < DOT_APART) && footprintInk(point, grounds) === 0;
      };
      const allowed = cleanestSpot(lo, lo + span, centre, accept, cost);
      const clean = allowed && allowed.cost < LEADER_THROUGH ? allowed : null;
      const found = clean ?? allowed ?? cleanestSpot(lo, lo + span, centre, () => true, cost);
      return { at: found.at, slid: Math.round((found.at - centre) * 1000) / 1000, clean: clean !== null };
    };
    const primaryOf = (a, side) => a.members.filter((i) => clearOf(i, side)).reduce((best, i) => (reach(i, side) > reach(best, side) ? i : best));
    const firstRun = (index, name) => { const [x, y, w, h] = targets[index].rect; return name === 'right' ? cw - (x + w) : ch - (y + h); };
    // A run is long past LEADER_LONG_MIN and half the frame it crosses.
    const isLong = (run, name) => run > Math.max(LEADER_LONG_MIN, (name === 'right' ? cw : ch) / 2);
    // How far the connector of a point's other lift would run: over the page to the side's edge, then along its track to the leader's.
    const connectorRun = (index, primary, name) => firstRun(index, name) + Math.abs(middleOf(index, name) - middleOf(primary, name));
    // What leaving by each side costs this panel: `open` when every point has a lift clear to it, `ink` and `run`
    // the content its first runs strike and their length, `far` when a leader's first run is long, and `hard` when
    // a dot or a ring's leader has no clean way out, another lift of a point would need a lane, or its connector
    // would run long. It runs before any dot is placed.
    const survey = () => Object.fromEntries(['right', 'bottom'].map((name) => {
      const out = { open: true, hard: false, far: false, ink: 0, run: 0 };
      for (const a of anchors) {
        if (!a.members.some((i) => clearOf(i, name))) { out.open = false; continue; }
        const primary = primaryOf(a, name);
        const run = firstRun(primary, name);
        out.ink += leaderInk(primary, name); out.run += run;
        if (isLong(run, name)) out.far = true;
        const strung = a.members.some((i) => i !== primary && isLong(connectorRun(i, primary, name), name));
        const dirty = targets[primary].dot ? !dotOn(primary, name).clean : leaderInk(primary, name) > 0;
        const laned = a.members.some((i) => i !== primary && (!clearOf(i, name) || !dotOn(i, name).clean));
        if (strung || dirty || laned) out.hard = true;
      }
      return [name, out];
    }));

    // A margin item is its label, or its lens, or a lens with the label beside it.
    const blockOf = (a) => {
      const lab = a.label ? makeLabel(a.label) : null;
      const size = lab ? lab.getBoundingClientRect() : { width: 0, height: 0 };
      const lensWide = a.lens ? LENS_D + (lab ? LENS_GAP : 0) : 0;
      return { lab, size, block: { width: lensWide + size.width, height: Math.max(a.lens ? LENS_D : 0, size.height) } };
    };

    // Every label leaves by `side`, which the survey found open and clean for every lift of every point, to its
    // own place in the margin there. A dot placed since the survey can still take another's clean spot. Returns
    // how far right and down the labels reach.
    const lead = (side) => {
      let dotOnContent = false;
      for (const a of anchors) {
        a.primary = primaryOf(a, side);
        const spot = targets[a.primary].dot ? dotOn(a.primary, side) : null;
        a.at = spot ? spot.at : middleOf(a.primary, side);
        a.slid = spot ? spot.slid : 0;
        if (spot && !spot.clean) dotOnContent = true;
        a.rect = targets[a.primary].rect;
        if (targets[a.primary].dot) placed.push(side === 'right' ? [a.rect[0] + a.rect[2] + dotOff(a.primary), a.at] : [a.at, a.rect[1] + a.rect[3] + dotOff(a.primary)]);
      }

      const leaderFor = (a, points) => {
        line(points);
        if (targets[a.primary].dot) dot(points[0], a.primary, a.slid);
        report.leaders.push({ points, target: a.primary, targets: [a.primary, ...a.members.filter((i) => i !== a.primary)] });
      };
      // Every other lift of the mark joins the leader's own track by the same side: a connector from its dot to `join`.
      const connect = (a, join) => {
        for (const s of a.members.filter((i) => i !== a.primary)) {
          const [sx, sy, sw, sh] = targets[s].rect;
          const spot = dotOn(s, side);
          const from = side === 'right' ? [sx + sw + dotOff(s), spot.at] : [spot.at, sy + sh + dotOff(s)];
          const points = [from, side === 'right' ? [join[0], from[1]] : [from[0], join[1]], join];
          if (!spot.clean) dotOnContent = true;
          placed.push(from);
          line(points); dot(from, s, spot.slid);
          report.connectors.push({ points, target: s, leader: report.leaders.length - 1 });
        }
      };

      let maxR = cw; let maxB = ch;
      const count = anchors.length;
      // A straight leader keeps the point its connectors join.
      const joinOf = (a, join) => (a.members.length > 1 ? [join] : []);
      const ordered = [...anchors].sort((p, q) => p.at - q.at);
      if (side === 'right') {
        let nextY = 0;
        ordered.forEach((a, i) => {
          const { lab, size, block } = blockOf(a);
          // The label stands with its first line on the leader's own line, or steps down to clear the label above.
          const half = a.lens ? block.height / 2 : Math.min(size.height / 2, 11);
          let y = Math.max(nextY, a.at - half, 0);
          const step = y + half - a.at;
          if (step > 0.01 && step < LEADER_STEP_MIN) y += LEADER_STEP_MIN - step;
          nextY = y + block.height + (a.lens ? LENS_STACK : 10);
          const x = cw + gutter + 18 + LANE_PITCH * count;
          const p1 = [a.rect[0] + a.rect[2] + dotOff(a.primary), a.at]; const xm = cw + gutter + 10 + LANE_PITCH * (count - 1 - i);
          const ey = y + half; const end = x - (a.lens ? LENS_RING + LENS_CLEAR : 6);
          if (a.lens) drawLens(a, x, y + (block.height - LENS_D) / 2);
          leaderFor(a, Math.abs(ey - a.at) < 0.01 ? [p1, ...joinOf(a, [xm, a.at]), [end, a.at]] : [p1, [xm, a.at], [xm, ey], [end, ey]]);
          connect(a, [xm, a.at]);
          if (lab) {
            const lx = x + (a.lens ? LENS_D + LENS_GAP : 0); const ly = y + block.height / 2 - size.height / 2;
            place(lab, lx, ly); report.labels.push({ rect: [lx, ly, size.width, size.height], anchor: p1, target: a.primary });
          }
          maxR = Math.max(maxR, x + block.width); maxB = Math.max(maxB, y + block.height);
        });
      } else {
        let nextX = 0;
        ordered.forEach((a, i) => {
          const { lab, size, block } = blockOf(a);
          // The label stands under its dot, or steps right to clear the label before it.
          const indent = a.lens ? LENS_D / 2 : 12;
          let x = Math.max(nextX, a.at - indent, 0);
          const step = x + indent - a.at;
          if (step > 0.01 && step < LEADER_STEP_MIN) x += LEADER_STEP_MIN - step;
          nextX = x + block.width + 20;
          const y = ch + 18 + LANE_PITCH * count;
          const p1 = [a.at, a.rect[1] + a.rect[3] + dotOff(a.primary)]; const ym = ch + 10 + LANE_PITCH * (count - 1 - i);
          if (a.lens) drawLens(a, x, y);
          const bend = x + indent; const stop = y - (a.lens ? LENS_RING + LENS_CLEAR : 6);
          leaderFor(a, Math.abs(bend - a.at) < 0.01 ? [p1, ...joinOf(a, [a.at, ym]), [a.at, stop]] : [p1, [a.at, ym], [bend, ym], [bend, stop]]);
          connect(a, [a.at, ym]);
          if (lab) {
            const lx = x + (a.lens ? LENS_D + LENS_GAP : 0); const ly = y + block.height / 2 - size.height / 2;
            place(lab, lx, ly); report.labels.push({ rect: [lx, ly, size.width, size.height], anchor: p1, target: a.primary });
          }
          maxR = Math.max(maxR, x + block.width); maxB = Math.max(maxB, y + block.height);
        });
      }
      const lines = [...report.leaders, ...report.connectors].map(({ points, target }) => ({ points, mark: targets[target].mark }));
      if (lines.some((p, i) => lines.slice(i + 1).some((q) => p.mark !== q.mark && pathsCross(p.points, q.points)))) warn('a connector crosses another leader');
      if (dotOnContent) warn('a leader dot sits on page content');
      return [maxR, maxB];
    };

    const gapTo = ([px, py], [x, y, w, h]) => Math.hypot(Math.max(x - px, 0, px - x - w), Math.max(y - py, 0, py - y - h));
    // Where a pin may stand on a target, the best first. On a lift or a slot: its corners, top left first, then
    // along its top edge and its bottom edge, PIN_STEP apart, or at their middles on a card too narrow for a step;
    // a lift's pin stands far enough out that its ring clears the words inside the card's padding. A loupe's pin
    // touches its ring from outside, since the ring is drawn close round what it shows: at the four diagonals, then
    // above, right, below and left. A bracket's stands against its upright so both arms show: at the middle, where
    // its leader would leave, then level with either arm; failing those it caps the upright.
    const pinSpots = (index) => {
      const { kind, rect: [x, y, w, h], pad, lift } = targets[index];
      const stand = PIN_R + PIN_RING;
      if (kind === 'bracket') {
        const beside = x + w + PIN_R + 1;
        const arms = h > 2 * PIN_R ? [[beside, y + PIN_R], [beside, y + h - PIN_R]] : [];
        return [[beside, y + h / 2], ...arms, [x + w, y], [x + w, y + h]];
      }
      if (kind === 'ring') {
        const out = w / 2 + stand; const d = out * Math.SQRT1_2;
        return [[-d, -d], [d, -d], [-d, d], [d, d], [0, -out], [out, 0], [0, out], [-out, 0]].map(([dx, dy]) => [x + w / 2 + dx, y + h / 2 + dy]);
      }
      const k = kind === 'lift' ? S * report.lifts[lift].k : 0;
      // How far outside an edge a centre stands for the ring to clear what begins `padding` capture px inside it.
      const off = (padding, clear) => (kind === 'lift' ? Math.max(0, clear - padding * k) : 0);
      const corner = stand * Math.SQRT1_2;
      const [left, top, right, bottom] = [x - off(pad[0], corner), y - off(pad[1], corner), x + w + off(pad[2], corner), y + h + off(pad[3], corner)];
      const along = [];
      for (let at = x + PIN_STEP; at <= x + w - PIN_STEP; at += PIN_STEP) along.push(at);
      if (!along.length) along.push(x + w / 2);
      return [[left, top], [right, top], [left, bottom], [right, bottom], ...along.map((at) => [at, y - off(pad[1], stand)]), ...along.map((at) => [at, y + h + off(pad[3], stand)])];
    };
    // The words of a lift's card: its rect less its padding.
    const wordsOf = ({ rect: [x, y, w, h], pad, lift }) => {
      const k = S * report.lifts[lift].k;
      return [x + pad[0] * k, y + pad[1] * k, w - (pad[0] + pad[2]) * k, h - (pad[1] + pad[3]) * k];
    };
    // The grounds round a target: what its leader would start on by either side, and the frame's on both.
    const groundsRound = (index) => {
      const { dot: dotted, rect: [x, y, w, h] } = targets[index];
      const near = (side) => (dotted ? groundOf(targets[index], side) : pageBeside(side === 'right' ? [[x + w, y + h / 2], [cw, y + h / 2]] : [[x + w / 2, y + h], [x + w / 2, ch]]));
      return ['right', 'bottom'].flatMap((side) => [near(side), edgeGround(side)]).filter(Boolean);
    };
    // A pin takes the spot where it hides the least. A spot is free when the pin stands off every other target
    // and every earlier pin, and its ring off every redaction outside its own target (a pin on a fill would say
    // the fill is the point) and off the words of its own card. Of the free spots those whose ring also clears
    // the ring of every other mark's target come first, since a pin against another mark's card reads as that
    // card's. Of those it takes the first that covers no page content, read against the grounds round its target
    // and outside the cards, which the board draws over the page; if each covers some, the one that covers the
    // least. With no free spot it takes the least of those off the other targets, the pins and the fills, or its
    // first spot, and the board says so. A bracket in the margin stands outside the capture, and so does its pin.
    // A card's pin first tries `corner` (an index into its corners, the one the board's pins share) and takes it when
    // there it is off everything a ringed spot is off and covers no page content. Returns the centre, and whether
    // the pin found a free spot.
    const cards = new Set(['lift', 'slot']);
    const pinOn = (index, taken, corner = null) => {
      const target = targets[index];
      const outside = target.kind === 'bracket' && target.rect[0] >= cw;
      const spots = pinSpots(index).map(([x, y]) => (outside ? [x, y] : [Math.min(Math.max(x, PIN_R + 1), cw - PIN_R - 1), Math.min(Math.max(y, PIN_R + 1), ch - PIN_R - 1)]));
      const apart = (c, ringed = false) => targets.every((other, i) => i === index || gapTo(c, other.rect) >= PIN_R + (ringed && other.mark !== target.mark ? PIN_RING + other.ring : 0))
        && taken.every(([px, py]) => Math.hypot(px - c[0], py - c[1]) >= 2 * PIN_R + PIN_RING)
        && report.redactions.every(({ rects }) => rects.every((rect) => hits(rect, target.rect) || gapTo(c, rect) >= PIN_R + PIN_RING));
      const offWords = (c) => target.kind !== 'lift' || gapTo(c, wordsOf(target)) >= PIN_R + PIN_RING - 0.5;
      const grounds = groundsRound(index);
      const covered = (c) => footprintInk(c, grounds, PIN_R + PIN_RING, target.kind === 'slot' ? target.rect : null) * S * S;
      if (corner !== null && cards.has(target.kind)) {
        const c = spots[corner];
        if (apart(c, true) && offWords(c) && covered(c) <= PIN_STRAY) return { center: c, free: true, cornered: true };
      }
      const least = (list) => list.map((c) => ({ c, ink: covered(c) })).reduce((best, spot) => (spot.ink < best.ink - PIN_STRAY ? spot : best)).c;
      const free = spots.filter((c) => apart(c) && offWords(c));
      const ringed = free.filter((c) => apart(c, true));
      if (free.length) return { center: least(ringed.length ? ringed : free), free: true };
      const off = spots.filter((c) => apart(c));
      return { center: off.length ? least(off) : spots[0], free: false };
    };
    // Reading order: one target comes before another when it lies in a row above it, or to its left in the same row.
    const reads = ([px, py, , ph], [qx, qy, , qh]) => (py + ph / 2 < qy ? -1 : qy + qh / 2 < py ? 1 : px - qx || py - qy);

    const pinOrder = () => {
      for (const a of anchors) a.primary = a.members.reduce((first, i) => (reads(targets[i].rect, targets[first].rect) < 0 ? i : first));
      return [...anchors].sort((p, q) => reads(targets[p.primary].rect, targets[q.primary].rect));
    };
    const pinsOf = (a) => [a.primary, ...a.members.filter((m) => m !== a.primary)];
    // How many of this panel's pins stand on a card, and the corners (indexes into a card's corners) where every
    // one of them could stand, each placed in turn as `pin` places them.
    const corners = () => {
      const order = pinOrder().flatMap(pinsOf);
      const count = order.filter((i) => cards.has(targets[i].kind)).length;
      const free = [0, 1, 2, 3].filter((corner) => {
        const taken = [];
        return order.every((i) => {
          const spot = pinOn(i, taken, corner);
          taken.push(spot.center);
          return !cards.has(targets[i].kind) || spot.cornered;
        });
      });
      return { count, free };
    };

    // No side takes every label of the board, so no leader is drawn: each point's targets carry its number, and
    // the labels stand in number order in a legend, in a column to the right or in rows below that wrap at the
    // capture's width. The numbers count on from `first`, so no number stands twice on a board, and a card's pin
    // stands on `corner` where it is free. Returns how far right and down the legend reaches.
    const pin = (side, first, corner) => {
      let maxR = cw; let maxB = ch;
      const taken = [];
      const entries = pinOrder().map((a, n) => {
        const number = first + n;
        for (const i of pinsOf(a)) {
          const { center, free } = pinOn(i, taken, corner);
          if (!free) warn('a pin covers another mark, a redaction or the words of its own card');
          taken.push(center);
          place(el('div', 'pin', comp, String(number)), center[0] - PIN_R, center[1] - PIN_R);
          report.pins.push({ center, r: PIN_R, number, target: i });
          maxR = Math.max(maxR, center[0] + PIN_R + PIN_RING); maxB = Math.max(maxB, center[1] + PIN_R + PIN_RING);
        }
        const { lab, size, block } = blockOf(a);
        // The number is level with the middle of a lens, or with the first line of a label that has none.
        const head = lab && !a.lens ? Math.min(lab.firstElementChild.getBoundingClientRect().height / 2, PIN_R) : 0;
        const above = a.lens ? block.height / 2 : PIN_R;
        const below = a.lens ? block.height / 2 : Math.max(PIN_R, size.height - head);
        return { a, number, lab, size, head, above, below, wide: 2 * PIN_R + LEGEND_GAP + block.width };
      });
      const rows = [];
      for (const entry of entries) {
        const row = rows.at(-1);
        if (side === 'bottom' && row && row.wide + LEGEND_APART + entry.wide <= cw) { row.entries.push(entry); row.wide += LEGEND_APART + entry.wide; } else rows.push({ entries: [entry], wide: entry.wide });
      }
      // A pin on a bracket in the margin stands where the column would begin.
      const left = side === 'right' ? Math.max(cw + gutter + 18, maxR + LEGEND_GAP) : 0;
      let top = side === 'right' ? 0 : ch + 18;
      for (const row of rows) {
        const level = top + Math.max(...row.entries.map((entry) => entry.above));
        const below = Math.max(...row.entries.map((entry) => entry.below));
        let x = left;
        for (const { a, number, lab, size, head, wide } of row.entries) {
          place(el('div', 'lnum', comp, String(number)), x, level - PIN_R);
          report.legend.push({ number, rect: [x, level - PIN_R, 2 * PIN_R, 2 * PIN_R] });
          const bx = x + 2 * PIN_R + LEGEND_GAP;
          if (a.lens) drawLens(a, bx, level - LENS_D / 2);
          if (lab) {
            const lx = bx + (a.lens ? LENS_D + LENS_GAP : 0); const ly = a.lens ? level - size.height / 2 : level - head;
            place(lab, lx, ly);
            report.labels.push({ rect: [lx, ly, size.width, size.height], anchor: report.pins.find((p) => p.target === a.primary).center, target: a.primary, number });
          }
          maxR = Math.max(maxR, x + wide);
          x += wide + LEGEND_APART;
        }
        maxB = Math.max(maxB, level + below);
        top = level + below + (row.entries.some((entry) => entry.a.lens) ? LENS_STACK : LEGEND_STACK);
      }
      return [maxR, maxB];
    };

    // Returns how many points it numbered: the next panel of a pinned board counts on from there.
    const draw = ({ side, pinned, first, corner = null }) => {
      const [maxR, maxB] = pinned && anchors.length ? pin(side, first, corner) : lead(side);
      for (const [x, top, w, h] of glyphs) line([[x, top], [x + w, top], [x + w, top + h], [x, top + h]], { width: BRACKET_WIDTH, join: 'round' });
      comp.style.width = `${Math.ceil(maxR + 4)}px`; comp.style.height = `${Math.ceil(maxB + 4)}px`;
      svg.setAttribute('width', comp.style.width); svg.setAttribute('height', comp.style.height);
      return pinned ? anchors.length : 0;
    };
    return { survey, corners, draw };
  }

  // Two live captures of one viewport whose frames differ and overlap by ONE_VIEW of the smaller are one region
  // framed twice. A shared frame never reaches past either capture's own frame, the area its driver inspected
  // and redacted: it is where the two frames meet, and only when that holds every mark box of both panels and
  // every redaction that meets it. Returns null otherwise, and each panel keeps its own frame. A viewport is
  // its size in CSS px, whatever the device scale of each capture, and the frames and boxes are in CSS px too.
  const ONE_VIEW = 0.5;
  const MARK_KINDS = ['lift', 'link', 'bracket', 'empty', 'ghost', 'loupe', 'context', 'redact'];
  const within = (outer, inner) => outer[0] <= inner[0] && outer[1] <= inner[1] && outer[0] + outer[2] >= inner[0] + inner[2] && outer[1] + outer[3] >= inner[1] + inner[3];
  function sharedFrame(captures, panels) {
    if (captures.some((capture) => capture.source === 'import')) return null;
    const [size, other] = captures.map((capture) => capture.size.map((n) => n / capture.scale));
    const [a, b] = captures.map((capture) => capture.frame.map((n) => n / capture.scale));
    if (size.some((n, k) => n !== other[k]) || a.every((n, k) => n === b[k])) return null;
    const meet = clampTo(a, b);
    const [, , w, h] = meet;
    if (!(w > 0 && h > 0 && w * h >= ONE_VIEW * Math.min(a[2] * a[3], b[2] * b[3]))) return null;
    const marks = panels.flatMap((panel, i) => (panel.marks || []).flatMap((mark) => MARK_KINDS.filter((kind) => kind in mark).map((kind) => ({
      kind, box: union(keysOf(mark, kind).map((key) => captures[i].boxes[key])).map((n) => n / captures[i].scale),
    }))));
    const fillOf = ([x, y, w, h]) => [x - REDACT_GROW, y - REDACT_GROW, w + 2 * REDACT_GROW, h + 2 * REDACT_GROW];
    return marks.every(({ kind, box }) => within(meet, box) || (kind === 'redact' && !hits(fillOf(box), meet))) ? meet : null;
  }

  window.__composeLayout = async function () {
    const { spec, captures, redactFill } = window.__composeData;
    const warnings = [...globalThis.__composeWording.wordingWarnings(spec, captures)];
    await document.fonts.load('600 13px Inter');
    const stage = document.getElementById('stage');
    const header = el('div', 'header', stage);
    el('span', 'state', header, spec.state).style.background = TONES[spec.state] || '#1F1A3D';
    el('span', 'title', header, spec.title);
    const row = el('div', 'panels', stage);

    const layout = spec.layout ?? 'single';
    const flags = { crops: layout !== 'pair', floor: layout !== 'single', hold: layout !== 'single' };
    const shared = layout === 'pair' ? sharedFrame(captures, spec.panels) : null;
    let stripOut = null;
    let noWord = null;
    const sourcesWith = async (edges, at) => {
      const list = [];
      for (const [i, panel] of spec.panels.entries()) {
        const capture = shared ? { ...captures[i], frame: shared.map((n) => n * captures[i].scale) } : captures[i];
        list.push({ ...await sourceOf(panel, capture, redactFill, edges, { stripOut, noWord, ...at }), ...flags });
      }
      return list;
    };
    let sources = await sourcesWith('settled');
    // CSS px two frames may move apart by and still count as alike: half a pixel between a 1x capture and a 2x
    // one, and nothing where both took one shared frame, which must stay one rectangle.
    const MOVE_APART = shared ? 0 : 0.5;
    // A pair shows one element in two states. A word step past a strip moves an edge far enough to show a row the
    // other state lacks: a pair's panels take one on a side only when every panel does. A page that reflows between
    // the states puts its word spaces in other places, so a word step settles each panel's edge apart: a side takes
    // one only where every panel's edge settles at one CSS position inside its own captured frame, and each edge
    // elsewhere stays where cleaning left it, with a fade.
    if (layout === 'pair') {
      const every = SIDES.filter((side) => sources.every((src) => src.cleaned.stripOut[side]));
      if (sources.some((src) => Object.keys(src.cleaned.stripOut).some((side) => !every.includes(side)))) {
        stripOut = every;
        sources = await sourcesWith('settled');
      }
      const settledAt = (src, side) => {
        const [x, y, w, h] = src.cleaned.frame; const [cx, cy, cw, ch] = src.capture.frame;
        return { left: x - cx, top: y - cy, right: cx + cw - x - w, bottom: cy + ch - y - h }[side] / src.scale;
      };
      for (;;) {
        const apart = SIDES.filter((side) => !noWord?.includes(side) && sources.some((src) => src.cleaned.edges[side] === 'word')
          && sources.some((src) => Math.abs(settledAt(src, side) - settledAt(sources[0], side)) > MOVE_APART));
        if (!apart.length) break;
        noWord = [...(noWord ?? []), ...apart];
        sources = await sourcesWith('settled');
      }
    }
    // Two frames of one size in a pair are one region in two states. An edge that loses its sliver in one state
    // and not in the other (content flush against a border, an imported panel) would show two rectangles: unless
    // every panel's frame lost its slivers alike, none moves. A divider that shows in one state only would part
    // them too, or stay in one: on each side every panel comes in by the deepest shed of any panel that every
    // panel can lose (a panel without the rule loses ground), or the deepest that all can. A lone small item in
    // one state is cut the same way: the deepest cut every panel can take over its ground or its own item. Each
    // panel then takes, on each side, the most air any panel wants there, so a lift in one state does not part the
    // frames; a panel that cannot take it (no ground at that edge, an imported panel) moves none. Where the frames
    // still part, every panel keeps its cleaned frame and takes no word step. One viewport framed twice shows one
    // rectangle exactly: where cleaning moves its two frames apart as well, both stay as given.
    const moveOf = (src, frame = src.shown) => [frame[0] - src.capture.frame[0], frame[1] - src.capture.frame[1],
      frame[2] - src.capture.frame[2], frame[3] - src.capture.frame[3]].map((n) => n / src.scale);
    const oneSize = sources.every((src) => [2, 3].every((k) => src.capture.frame[k] / src.scale === sources[0].capture.frame[k] / sources[0].scale));
    const alike = (frameOf = (src) => src.shown) => sources.every((src) => moveOf(src, frameOf(src)).every((n, k) => Math.abs(n - moveOf(sources[0], frameOf(sources[0]))[k]) <= MOVE_APART));
    if (layout === 'pair' && oneSize) {
      const { sharedShed } = geometryFor(1);
      const deepest = sharedShed(sources);
      if (sources.some((src) => SIDES.some((side) => src.shed[side] !== Math.round(deepest[side] * src.scale)))) sources = await sourcesWith('settled', { shedAt: deepest });
      const orphanCut = sharedShed(sources.map((src) => ({ scale: src.scale, shed: src.cut, takes: src.cutTakes })));
      if (sources.some((src) => SIDES.some((side) => src.cut[side] !== Math.round(orphanCut[side] * src.scale)))) sources = await sourcesWith('settled', { shedAt: deepest, cutAt: orphanCut });
      const most = Object.fromEntries(SIDES.map((side) => [side, Math.max(...sources.map((src) => src.air[side] / src.scale))]));
      const slivers = alike((src) => src.slivered);
      if (slivers && sources.some((src) => SIDES.some((side) => src.air[side] / src.scale !== most[side]))) sources = await sourcesWith('settled', { airAt: most, shedAt: deepest, cutAt: orphanCut });
      if (!slivers || !alike()) sources = await sourcesWith('cleaned', { noWord: SIDES });
    }
    if (shared && !alike()) sources = await sourcesWith('given');
    const washAll = sources.length > 1 && sources.some((src) => src.groups.length > 0);
    for (const src of sources) src.washAll = washAll;
    let solved = sources.map((src) => settle(src, singleScale(src.scale, layout === 'single')));
    let stacked = false;
    if (sources.length > 1) {
      // Steps crops grow to the largest of them, in whole CSS px, so the one size the panels share is one scale.
      // A crop that then covers half its frame gives way to the frame, as any crop does. A crop grown to that size
      // can meet a redaction and take it in whole, which makes it the largest: the size is found again while it
      // grows and a crop is short of it, at most SHARE_ROUNDS times. A crop whose edge snaps back inside the size
      // keeps the size it snapped to, as it did with one pass.
      const first = layout === 'steps' ? solved.flatMap((s, i) => (s.cropped ? [i] : [])) : [];
      const cssSize = (i) => [solved[i].frame[2] / sources[i].scale, solved[i].frame[3] / sources[i].scale];
      let grownTo = [0, 0];
      for (let round = 0; round < SHARE_ROUNDS; round += 1) {
        const cropped = first.filter((i) => solved[i].cropped);
        const largest = [0, 1].map((k) => Math.ceil(Math.max(0, ...cropped.map((i) => cssSize(i)[k]))));
        const short = cropped.filter((i) => !cssSize(i).every((n, k) => n >= largest[k]));
        if (!short.length || largest.every((n, k) => n <= grownTo[k])) break;
        grownTo = largest;
        for (const i of short) {
          sources[i].min = largest.map((n) => n * sources[i].scale);
          solved[i] = settle(sources[i], singleScale(sources[i].scale, false));
        }
      }
      // The panels share a height, or stacked a width, or steps one zoom (sharedZoom), so each is drawn at a scale
      // its own trim did not know. A whole frame whose room was reckoned for a larger scale is trimmed again for the
      // one it gets, which changes the size: again until every room holds. Past ROOM_ROUNDS a frame keeps all its ground, and holds from then on.
      let found = solved.map((s) => s.region);
      let regions; let sizes; let zoom;
      const scaleOf = (i) => (frame) => (zoom ? zoom / sources[i].scale : sizes.stacked ? sizes.width / frame[2] : sizes.height / frame[3]);
      for (let round = 0; ; round += 1) {
        regions = layout === 'pair' ? sharedTrims(sources, found) : found;
        const frames = regions.map((region, i) => region.box.map((v) => v / sources[i].scale));
        sizes = panelSizes(frames);
        zoom = layout === 'steps' ? sharedZoom(frames, sizes) : null;
        const drawnAt = regions.map((region, i) => scaleOf(i)(region.box));
        const tight = found.map((region, i) => region.roomAt > drawnAt[i] + 1e-9);
        if (!tight.some(Boolean)) break;
        found = found.map((region, i) => (!tight[i] ? region : round < ROOM_ROUNDS ? roomRegion(sources[i], solved[i].parts, drawnAt[i]) : untrimmed(sources[i])));
      }
      sources.forEach((src, i) => { src.region = regions[i]; });
      solved = sources.map((src, i) => settle(src, scaleOf(i)));
      if (solved.some((p, i) => p.S * sources[i].scale < PANEL_SMALL_S)) warnings.push('a panel is drawn small; frame the card that holds its marks');
      ({ stacked } = sizes);
    }
    if (stacked) row.classList.add('stack');
    const arrowNodes = [];
    const drawn = sources.map((src, i) => {
      if (layout === 'steps' && i > 0) {
        const arrow = el('div', 'arrow', row, stacked ? '↓' : '→');
        // Steps at one zoom differ in size: the arrow stands level with the smaller of the two it joins.
        const across = (key) => Math.min(solved[i - 1][key], solved[i][key]) / 2 - ARROW_D / 2;
        if (stacked) arrow.style.marginLeft = `${across('cw')}px`;
        else arrow.style.marginTop = `${HEAD_H + PANEL_GAP + across('ch')}px`;
        arrowNodes.push(arrow);
      }
      const own = Boolean(src.panel.note);
      return drawPanel(src, solved[i], row, { number: layout === 'steps' ? i + 1 : null, headed: layout !== 'single' || Boolean(src.panel.label || src.panel.tag) || own || src.imported, noted: stacked ? own : spec.panels.some((panel) => panel.note) });
    });
    const wide = sources.length === 1 && solved[0].frame[2] > 2.2 * solved[0].frame[3];
    // The panels of a stacked board stand under one another, so their labels have only the right to go to.
    const verdict = pickBoardSide(drawn.map((d) => d.router.survey()), { forced: stacked ? 'right' : null, fallback: sources.length > 1 || wide ? 'bottom' : 'right' });
    // Pins are numbered across the board, so the pins of two or more cards share the first corner free on every panel.
    const panelCorners = verdict.pinned ? drawn.map((d) => d.router.corners()) : [];
    const together = panelCorners.reduce((n, { count }) => n + count, 0) > 1 ? [0, 1, 2, 3].find((c) => panelCorners.every(({ free }) => free.includes(c))) : undefined;
    let numbered = 0;
    for (const { router: { draw }, panel } of drawn) { numbered += draw({ ...verdict, first: numbered + 1, corner: together ?? null }); panel.side = verdict.side; }

    // Panels of one row keep one head height, so their captures stand level: the tallest note sets it.
    const noteH = Math.max(0, ...drawn.map((d) => (d.pnote ? d.pnote.getBoundingClientRect().height : 0)));
    if (!stacked && noteH > 0) {
      for (const { pnote } of drawn) if (pnote) pnote.style.minHeight = `${noteH}px`;
      for (const arrow of arrowNodes) arrow.style.marginTop = `${parseFloat(arrow.style.marginTop) + noteH + PANEL_GAP}px`;
    }
    await document.fonts.ready;
    const s = stage.getBoundingClientRect();
    const inStage = (node) => { const r = node.getBoundingClientRect(); return [r.left - s.left, r.top - s.top, r.width, r.height]; };
    const panels = drawn.map(({ col, phead, pnote, number, comp, panel }, i) => {
      const c = comp.getBoundingClientRect();
      const dx = c.left - s.left; const dy = c.top - s.top;
      const off = (r) => [r[0] + dx, r[1] + dy, r[2], r[3]];
      const offPoint = ([x, y]) => [x + dx, y + dy];
      return {
        ...panel,
        extent: inStage(col),
        head: phead ? { rect: pnote ? union([inStage(phead), inStage(pnote)]) : inStage(phead), number, origin: panel.source === 'import', ...(spec.panels[i].tag ? { tag: spec.panels[i].tag } : {}), ...(spec.panels[i].note ? { note: spec.panels[i].note } : {}) } : null,
        capture: off(panel.capture),
        targets: panel.targets.map((t) => ({ kind: t.kind, mark: t.mark, rect: off(t.rect), ...(t.lift === undefined ? {} : { lift: t.lift }) })),
        lifts: panel.lifts.map((l) => ({ ...l, rect: off(l.rect) })),
        slots: panel.slots.map((s) => ({ ...s, rect: off(s.rect) })),
        brackets: panel.brackets.map((b) => ({ ...b, rows: off(b.rows), rect: off(b.rect) })),
        loupes: panel.loupes.map((l) => ({ ...l, ring: off(l.ring), lens: off(l.lens) })),
        flats: panel.flats.map((f) => ({ ...f, rect: off(f.rect) })),
        labels: panel.labels.map((l) => ({ ...l, rect: off(l.rect), anchor: offPoint(l.anchor) })),
        pins: panel.pins.map((p) => ({ ...p, center: offPoint(p.center) })),
        legend: panel.legend.map((entry) => ({ ...entry, rect: off(entry.rect) })),
        dots: panel.dots.map((d) => ({ ...d, center: offPoint(d.center) })),
        redactions: panel.redactions.map((r) => ({ ...r, rect: off(r.rect), rects: r.rects.map(off) })),
        fades: panel.fades.map((f) => ({ ...f, rect: off(f.rect), parts: f.parts.map(off) })),
        leaders: panel.leaders.map((l) => ({ ...l, points: l.points.map(offPoint) })),
        connectors: panel.connectors.map((l) => ({ ...l, points: l.points.map(offPoint) })),
      };
    });
    for (const { notes } of drawn) warnings.push(...notes);
    const strays = drawn.flatMap(({ unseen }, i) => Array.from({ length: unseen }, () => `a redact mark on panel ${i + 1} lies outside the board, so it hides nothing`));
    const fillWarnings = drawn.flatMap(({ fillNotes }, i) => fillNotes.flatMap((note) => {
      const named = `a redaction on panel ${i + 1} (${note.mark})`;
      return [
        ...(note.grew ? [{ text: `${named} grew to cover ink beside it` }] : []),
        ...note.extended.map((side) => ({ text: `${named} covered a line beside it to that line's end, past its ${side} edge` })),
        ...note.bridged.map((side) => ({ text: `${named} covered ink past a gap at its ${side} edge` })),
        ...note.near.map((side) => ({ text: `${named} stopped at a gap with more ink just past its ${side} edge` })),
        ...note.spared.map((side) => ({ text: `${named} left a line past its ${side} edge uncovered, as another row of its list` })),
        ...note.capped.map(({ side, why, refuse }) => ({ refuse, text: `${named} ${{ mark: "met another mark's box", frame: 'reached the frame', limit: 'reached its growth limit' }[why]} with ink still at its ${side} edge` })),
      ].map((w) => ({ ...w, shown: note.shown }));
    }));
    const unhidden = fillWarnings.filter((w) => w.refuse && w.shown).map((w) => w.text);
    // A refused fill the crop leaves out is a stray mark, unless the value's ink runs on past it into the board.
    const runsIn = drawn.flatMap(({ fillNotes }, i) => fillNotes.flatMap((note) => note.runsIn.map((side) => `a redact mark on panel ${i + 1} (${note.mark}) lies outside the board, but the value's ink runs into the board past its ${side} edge. Frame the panel so that value is out of the board, or redact it where it shows`)));
    const report = { layout, stage: [0, 0, s.width, s.height], warnings: [...new Set(warnings), ...strays, ...fillWarnings.filter((w) => w.shown).map((w) => w.text)], unhidden, runsIn, arrows: arrowNodes.map(inStage), panels, sharedFrame: shared };
    const gated = spec.panels.some((panel, i) => captures[i].source === 'import' && (panel.marks || []).some((mark) => 'redact' in mark));
    const whole = ([x, y, w, h]) => {
      const x0 = Math.max(0, Math.floor(x - CROP_MARGIN)); const y0 = Math.max(0, Math.floor(y - CROP_MARGIN));
      return [x0, y0, Math.min(Math.ceil(s.width), Math.ceil(x + w + CROP_MARGIN)) - x0, Math.min(Math.ceil(s.height), Math.ceil(y + h + CROP_MARGIN)) - y0];
    };
    report.side = verdict.side;
    report.pinned = verdict.pinned;
    report.stacked = stacked;
    report.gated = gated;
    report.crops = gated ? panels.flatMap((panel, p) => {
      const c = drawn[p].comp.getBoundingClientRect();
      const off = (r) => [r[0] + c.left - s.left, r[1] + c.top - s.top, r[2], r[3]];
      return panel.redactions.map((r, k) => ({ panel: p, redaction: k, rect: whole(union([r.rect, off(drawn[p].glances[k])])) }));
    }) : [];
    window.__composeReport = report;
    return report;
  };
}());
