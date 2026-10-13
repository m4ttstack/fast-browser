// Runs inside the headless renderer page. Plain script, no imports: page.mjs
// inlines this file's text. window.__composeLayout() returns a Promise that
// resolves once every image is decoded and layout is final.
//
// Every rect, points, center and anchor in the report is in board CSS pixels;
// frame, cleanFrame, source, grown and pad are in that panel's own capture
// pixels, at the scale its panel.scale gives.
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
  const { liftSpot, pickLeaderSide, collidingLifts, cleanestSpot, pathsCross, hits, union, components, commonHeight, frameIsDark, TOLERANCE, LIFT_RING, LEADER_THROUGH } = globalThis.__composeGeometry;
  // The rest work in a capture's own pixels, so each capture takes the geometry of its scale.
  const geometries = new Map();
  const geometryFor = (scale) => {
    if (!geometries.has(scale)) geometries.set(scale, globalThis.__composeGeometry.withScale(scale));
    return geometries.get(scale);
  };
  // A redaction fill reaches this far past its box: a measured box is tight to
  // its text, an inspected one is drawn by eye.
  const REDACT_GROW = 2;
  const IMPORT_REDACT_PAD = 12;
  const CROP_MARGIN = 24;
  const MIN_LIFT_HEIGHT = 28;
  const MAX_K = 3;
  const BASE_K = 1.06;
  const SINGLE_WIDTH = 560;
  const MIN_S = 0.55;
  const MAX_S = 1.25;
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
  // The distance between neighbouring leader tracks, lanes and label columns.
  const LANE_PITCH = 8;
  const LEADER_WIDTH = 1.5;
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
  const LOUPE_FILL = 0.8;
  const LOUPE_ZOOM = 4;
  // These three mirror the page CSS in page.mjs (the .panel gap, the .phead
  // height and the .arrow size) and change together with it.
  const PANEL_GAP = 8;
  const HEAD_H = 22;
  const ARROW_D = 40;
  // Below this panel scale (drawn height over frame height) text is unreadable.
  const PANEL_SMALL_S = 0.4;

  const singleScale = (scale) => (frame) => Math.min(MAX_S, Math.max(MIN_S, SINGLE_WIDTH / (frame[2] / scale))) / scale;

  // Redaction is applied once, to the source pixels, before any layer reads
  // them: every layer below draws from this redacted copy, so no lift can
  // ever show what a redaction hides, and lift growth reads these same pixels.
  async function redactedSource(capture, regions, fill, grow) {
    const img = await loadImage(capture.uri);
    const canvas = document.createElement('canvas');
    canvas.width = capture.size[0]; canvas.height = capture.size[1];
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    ctx.fillStyle = fill;
    for (const [x, y, w, h] of regions) ctx.fillRect(x - grow, y - grow, w + 2 * grow, h + 2 * grow);
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { url: canvas.toDataURL('image/png'), pixels: { data, width, height } };
  }

  const keysOf = (mark, kind) => [].concat(mark[kind]);
  const liftKind = (mark) => ('lift' in mark ? 'lift' : 'link' in mark ? 'link' : null);

  async function sourceOf(panel, capture, redactFill) {
    const marks = panel.marks || [];
    const imported = capture.source === 'import';
    const scale = capture.scale || 1;
    const geo = geometryFor(scale);
    const { growBox, cleanFrame, clusterBoxes, LIFT_BAND } = geo;
    const GROW_LIMIT = 96 * scale;
    const PAD = 4 * scale;
    const keepClear = (o) => [o[0] - 2 * PAD, o[1] - 2 * PAD, o[2] + 4 * PAD, o[3] + 4 * PAD];
    const grow = imported ? IMPORT_REDACT_PAD : REDACT_GROW * scale;
    const boxes = capture.boxes;

    const redactBoxes = marks.filter((m) => 'redact' in m).map((m) => union(keysOf(m, 'redact').map((k) => boxes[k])));
    const { url, pixels } = await redactedSource(capture, redactBoxes, redactFill, grow);

    const liftMarks = marks.flatMap((mark, markIndex) => (liftKind(mark) ? [{ mark, markIndex, kind: liftKind(mark) }] : []));
    const slotMarks = marks.flatMap((mark, markIndex) => {
      const kind = ['empty', 'ghost'].find((k) => k in mark);
      return kind ? [{ mark, markIndex, kind, box: boxes[mark[kind]] }] : [];
    });
    const slotBoxes = slotMarks.map((slot) => slot.box);
    const bracketMarks = marks.flatMap((mark, markIndex) => ('bracket' in mark ? [{ mark, markIndex, original: union(keysOf(mark, 'bracket').map((k) => boxes[k])) }] : []));
    const loupeMarks = marks.flatMap((mark, markIndex) => ('loupe' in mark ? [{ mark, markIndex, box: boxes[mark.loupe] }] : []));
    const fillRects = redactBoxes.map((r) => [r[0] - grow, r[1] - grow, r[2] + 2 * grow, r[3] + 2 * grow]);

    // The captured frame's edges can land mid-word; they move off content
    // before anything is bounded by the frame. The marks are the boxes as
    // captured, and a redaction wholly outside the frame is not a mark.
    // An imported frame may be all that hides what lies beside it, so it only shrinks.
    const sourceMarks = [...liftMarks.flatMap(({ mark, kind }) => keysOf(mark, kind).map((k) => boxes[k])), ...slotBoxes, ...bracketMarks.map((b) => b.original), ...loupeMarks.map((l) => l.box), ...redactBoxes]
      .filter((b) => hits(b, capture.frame));
    const cleaned = cleanFrame(pixels, capture.frame, sourceMarks.length ? union(sourceMarks) : null, { ignore: fillRects, keep: fillRects.filter((f) => hits(f, capture.frame)), fixed: imported });
    const shown = cleaned.frame;
    const dark = imported ? frameIsDark(pixels, shown, fillRects) : Boolean(capture.dark);
    const notes = cleaned.cut ? ['a frame edge cuts through content'] : [];

    // A lift whose box ends inside content (a name without its value) grows
    // out to the nearest clean edges. It never grows into a redaction, a slot or into
    // another lift unless the two boxes already overlapped as named. The
    // redaction fill's 2px margin often sits inside a lift box already, so
    // those pixels are ignored when testing an edge rather than walled off.
    const growAvoiding = (box, avoid, bounds = shown) => growBox(pixels, box, GROW_LIMIT, { bounds, avoid: [...avoid, ...redactBoxes, ...slotBoxes], ignore: fillRects, band: LIFT_BAND });

    for (const b of bracketMarks) {
      const { box, cut } = growAvoiding(b.original, []);
      b.rows = box;
      if (cut) notes.push('a bracket edge cuts through content');
    }

    // A point over elements that sit apart is one lift per cluster of elements.
    // Keys cluster by where each grows to on its own, so a union never sweeps
    // the content between them into the lift. A link's keys never cluster.
    const groups = liftMarks.flatMap(({ mark, markIndex, kind }) => {
      const keys = keysOf(mark, kind);
      let clusters = kind === 'link' ? keys.map((_, i) => [i]) : [keys.map((_, i) => i)];
      if (kind === 'lift' && keys.length > 1) {
        const others = liftMarks.filter((l) => l.mark !== mark).flatMap((l) => keysOf(l.mark, l.kind).map((k) => boxes[k]));
        const alone = keys.map((k) => growAvoiding(boxes[k], others.filter((o) => !hits(boxes[k], o)).map(keepClear)).box);
        clusters = clusterBoxes(alone);
      }
      return clusters.map((members) => {
        const own = members.map((i) => keys[i]);
        return { mark, markIndex, keys: own, original: union(own.map((k) => boxes[k])), ...(kind === 'link' ? { separate: true } : {}) };
      });
    });

    return { panel, capture, imported, scale, geo, PAD, keepClear, marks, boxes, dark, url, pixels, redactBoxes, fillRects, shown, cleaned, liftMarks, slotMarks, bracketMarks, loupeMarks, groups, growAvoiding, redactFill, notes };
  }

  const NO_TRIM = { left: 0, top: 0, right: 0, bottom: 0 };
  const marksBoxOf = (parts) => (parts.length ? union(parts.map((part) => part.box)) : null);

  // A panel that shows its whole frame in a pair or steps board loses the blank
  // ground at the frame's edges, so panels of one card start where it starts.
  function wholeRegion(src, parts) {
    const trim = src.trims ? src.geo.trimBlank(src.pixels, src.shown, marksBoxOf(parts)) : null;
    return { box: trim ? trim.box : src.shown.slice(), cropped: false, trimmed: trim ? trim.trimmed : NO_TRIM };
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
    const least = Object.fromEntries(['left', 'top', 'right', 'bottom'].map((side) => [side, Math.min(...regions.map((region, i) => css(sources[i], region.trimmed[side])))]));
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
  // band, so a dense page does not swell the crop to the whole frame.
  function regionOf(src, parts) {
    if (!src.crops) return wholeRegion(src, parts);
    const crop = src.geo.cropToMarks(src.pixels, src.shown, marksBoxOf(parts), { parts, floor: src.floor, hold: src.hold });
    return crop.edges ? { box: crop.box, edges: crop.edges, cut: crop.cut, cropped: true, trimmed: NO_TRIM } : wholeRegion(src, parts);
  }

  // Everything below the groups follows from them: the grown boxes, the
  // frame, the scale and every lift's final rect. So a merge solves again.
  function solve(src, groups, scaleFor) {
    const { pixels, shown, redactBoxes, slotMarks, bracketMarks, loupeMarks, fillRects, growAvoiding, PAD, keepClear } = src;
    const { cleanPad, contentUnder } = src.geo;
    const originals = groups.map((g) => g.original);
    // A pinned region was cropped for the first solve's groups; a lift that
    // merged since may not grow past it, or its card would show what the crop left out.
    const reach = src.region ? src.region.box : shown;
    const grownBoxes = []; const cutLifts = [];
    groups.forEach((_, i) => {
      const avoid = originals.flatMap((o, j) => (j === i || hits(originals[i], o) ? [] : [keepClear(j < i ? grownBoxes[j] : o)]));
      const { box, cut } = growAvoiding(originals[i], avoid, reach);
      grownBoxes.push(box); cutLifts.push(cut);
    });

    // The frame shrinks to its marks before the scale is chosen, so the scale,
    // the lifts, the labels and the leaders all work on the frame that is
    // shown. A redaction or a slot wholly outside the original frame is not a mark.
    const parts = [
      ...grownBoxes.map((box) => ({ box, bracket: false })),
      ...[...slotMarks.map((slot) => ({ box: slot.box, bracket: false })), ...bracketMarks.map((b) => ({ box: b.rows, bracket: true })), ...loupeMarks.map((l) => ({ box: l.box, bracket: false })), ...redactBoxes.map((box) => ({ box, bracket: false }))].filter((part) => hits(part.box, shown)),
    ];
    const region = src.region || regionOf(src, parts);
    const { box: frame, edges: cropEdges } = region;
    const [fx, fy, fw, fh] = frame;
    const S = scaleFor(frame);
    const cw = Math.round(fw * S); const ch = Math.round(fh * S);
    const map = (b) => [(b[0] - fx) * S, (b[1] - fy) * S, b[2] * S, b[3] * S];

    const plans = groups.map((group, i) => {
      const b = grownBoxes[i]; const orig = originals[i];
      const grown = [orig[0] - b[0], orig[1] - b[1], b[0] + b[2] - orig[0] - orig[2], b[1] + b[3] - orig[1] - orig[3]]
        .map((g) => Math.max(0, Math.round(g)));
      // Padding keeps clear of the neighbouring content, so a lift never shows
      // a sliver of the neighbouring word and never sits hard against it.
      const pad = cleanPad(pixels, b, PAD, { bounds: frame, ignore: fillRects });
      const bb = [b[0] - pad[0], b[1] - pad[1], b[2] + pad[0] + pad[2], b[3] + pad[1] + pad[3]];
      const [x, y, w, h] = map(bb);
      const k = Math.max(BASE_K, Math.min(MAX_K, MIN_LIFT_HEIGHT / h));
      const kFit = Math.min(k, (cw - 4) / w, (ch - 4) / h);
      return { group, b, grown, pad, bb, x, y, w, h, kFit, floor: Math.min(BASE_K, kFit), hidden: contentUnder(pixels, frame, S, [x, y, w, h]), spots: new Map() };
    });
    const fitted = (p, kk) => {
      if (!p.spots.has(kk)) {
        const W = p.w * kk; const H = p.h * kk;
        p.spots.set(kk, { W, H, ...liftSpot(p.hidden, [cw, ch], [p.x, p.y, p.w, p.h], [W, H]) });
      }
      return p.spots.get(kk);
    };

    const finals = []; const notes = region.cut ? ['a crop edge cuts through content'] : [];
    plans.forEach((p, i) => {
      if (cutLifts[i]) notes.push('a lift edge cuts through content');
      // An enlarged lift gives way, back toward the base scale and no further,
      // to the earlier lifts as drawn and to the later ones at base scale, so
      // two lifts of separate content never end up on top of each other.
      const apart = (r) => plans.every((q, j) => {
        if (j === i || hits(grownBoxes[j], p.b)) return true;
        const o = j < i ? finals[j].rect : (({ L, T, W, H }) => [L, T, W, H])(fitted(q, q.floor));
        return !hits(o, [r.L, r.T, r.W, r.H]);
      });
      let kEff = p.kFit;
      while (kEff > p.floor && !apart(fitted(p, kEff))) kEff = Math.max(p.floor, kEff - 0.02);
      if (kEff < BASE_K - 1e-9) notes.push('a lift was scaled down to fit the frame');
      const { W, H, L, T, clamped } = fitted(p, kEff);
      if (clamped) notes.push('a lift was clamped at the frame edge');
      finals.push({ rect: [L, T, W, H], clamped, k: kEff });
    });
    finals.forEach((a, i) => finals.slice(i + 1).forEach((b, k) => {
      if (!hits(grownBoxes[i], grownBoxes[i + 1 + k]) && hits(a.rect, b.rect)) notes.push('two lifts overlap');
    }));
    return { groups, plans, finals, notes, frame, cropEdges, cropped: region.cropped, trimmed: region.trimmed, region, S, cw, ch, map };
  }

  // Lifts of one point that would collide at their final rects are one thing
  // again: those clusters merge and the layout is solved once more.
  const mergeColliding = (groups, pairs) => {
    return components(groups.length, pairs).map((indexes) => {
      const members = indexes.map((i) => groups[i]);
      if (members.length === 1) return members[0];
      return { ...members[0], keys: members.flatMap((m) => m.keys), original: union(members.map((m) => m.original)), merged: true };
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
    const onFill = (sx, sy) => fillRects.some(([x, y, w, h]) => sx >= x && sx < x + w && sy >= y && sy < y + h);
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
    const inkIn = ([x, y, w, h], ref) => {
      let ink = 0;
      for (let sy = Math.floor(fy + y / S); sy <= Math.ceil(fy + (y + h) / S); sy += 1) {
        for (let sx = Math.floor(fx + x / S); sx <= Math.ceil(fx + (x + w) / S); sx += 1) {
          const dx = (sx + 0.5 - fx) * S; const dy = (sy + 0.5 - fy) * S;
          if (dx < x || dy < y || dx > x + w || dy > y + h || dx < 0 || dy < 0 || dx > cw || dy > ch) continue;
          if (sx < 0 || sy < 0 || sx >= pixels.width || sy >= pixels.height) continue;
          if (differs((sy * pixels.width + sx) * 4, ref)) ink += 1;
        }
      }
      return ink;
    };
    return { colourAt, differs, groundOf, inkIn, onFill };
  }

  function drawPanel(src, solved, host, head) {
    const { capture, dark, redactFill } = src;
    const { groups, plans, finals, frame, cropEdges, cropped, trimmed, S, cw, ch, map } = solved;
    const [fx, fy] = frame;
    const notes = [...src.notes, ...solved.notes];
    const warn = (message) => notes.push(message);
    const bg = (node, x, y, k) => {
      node.style.backgroundImage = `url(${src.url})`;
      node.style.backgroundSize = `${capture.size[0] * S * k}px ${capture.size[1] * S * k}px`;
      node.style.backgroundPosition = `${-x * S * k}px ${-y * S * k}px`;
    };

    const col = el('div', 'panel', host);
    let phead = null;
    if (head.headed) {
      phead = el('div', 'phead', col);
      if (head.number) el('span', 'num', phead, String(head.number));
      if (src.panel.label) el('span', 'plabel', phead, src.panel.label);
      if (src.imported) el('span', 'origin', phead, 'From the ticket');
    }
    const comp = el('div', 'comp', col);
    const cap = el('div', 'capture', comp); place(cap, 0, 0, cw, ch);
    bg(el('div', 'fill', cap), fx, fy, 1);
    if (groups.length) el('div', `wash${dark ? ' dark' : ''}`, cap);
    const clip = ([x, y, w, h]) => {
      const x0 = Math.max(0, x); const y0 = Math.max(0, y); const x1 = Math.min(cw, x + w); const y1 = Math.min(ch, y + h);
      return x1 > x0 && y1 > y0 ? [x0, y0, x1 - x0, y1 - y0] : null;
    };

    const panel = {
      source: src.imported ? 'import' : 'live',
      dark,
      capture: [0, 0, cw, ch],
      scale: src.scale,
      frame,
      cleanFrame: src.shown,
      frameEdges: src.cleaned.edges,
      cropped,
      ...(cropped ? { cropEdges } : {}),
      trimmed: { ...trimmed },
      wash: groups.length > 0,
      targets: [], lifts: [], links: [], slots: [], brackets: [], loupes: [], flats: [], labels: [], leaders: [], connectors: [], dots: [], redactions: [],
    };
    const { targets } = panel;
    const probe = probes(src, solved);
    const anchors = [];
    const glyphs = [];
    let gutter = 0;
    for (const slot of src.slotMarks) {
      const rect = clip(map(slot.box));
      if (!rect) continue;
      const node = el('div', `slot ${slot.kind}${dark ? ' dark' : ''}`, cap); place(node, ...rect);
      let text = null; let { title } = slot.mark;
      if (slot.kind === 'empty') {
        const words = slot.mark.text ?? 'Nothing rendered here';
        const span = el('span', null, node, words); const size = span.getBoundingClientRect();
        if (size.width + 16 <= rect[2] && size.height + 8 <= rect[3]) text = 'inside';
        else {
          span.remove(); text = title ? 'dropped' : 'label';
          if (title) warn('an empty slot is too small for its text'); else title = words;
        }
      }
      panel.slots.push({ kind: slot.kind, mark: slot.markIndex, rect, text });
      const target = targets.push({ kind: 'slot', mark: slot.markIndex, rect, ring: 0, dot: true, source: slot.box, pad: [0, 0, 0, 0] }) - 1;
      if (title) anchors.push({ mark: slot.mark, markIndex: slot.markIndex, label: { title, note: slot.mark.note, tag: slot.mark.tag }, members: [target] });
    }
    plans.forEach((p, i) => {
      const { group, b, grown, pad, bb } = p;
      const { rect: [L, T, W, H], clamped, k: kEff } = finals[i];
      // bg() positions the source at -bb * S * k, so a clamped lift still
      // shows its own region wherever it ends up.
      const lift = el('div', `lift${dark ? ' dark' : ''}`, comp); place(lift, L, T, W, H);
      bg(lift, bb[0], bb[1], kEff);
      panel.lifts.push({ keys: group.keys, mark: group.markIndex, rect: [L, T, W, H], clamped, grown, pad, source: b, k: kEff, ...(group.merged ? { merged: true } : {}) });
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
      const rowsRect = clip(map(b.rows));
      if (!rowsRect) continue;
      if (panel.wash) {
        const flat = el('div', 'flat', cap); place(flat, ...rowsRect);
        bg(flat, fx + rowsRect[0] / S, fy + rowsRect[1] / S, 1);
        panel.flats.push({ mark: b.markIndex, rect: rowsRect });
      }
      const right = rowsRect[0] + rowsRect[2];
      const edge = [fx + right / S - BRACKET_PROBE, fy + rowsRect[1] / S, BRACKET_PROBE, rowsRect[3] / S];
      const ref = probe.groundOf({ source: edge, pad: [0, 0, 0, 0] }, 'right');
      let x = null; let slid = 0; let inMargin = false;
      for (let d = 0; d <= BRACKET_REACH; d += BRACKET_STEP) {
        const at = right + BRACKET_GAP + d;
        if (at + BRACKET_ARM > cw - BRACKET_EDGE) { inMargin = true; break; }
        const strip = [at - BRACKET_CLEAR, rowsRect[1], BRACKET_ARM + 2 * BRACKET_CLEAR, rowsRect[3]];
        if (probe.inkIn(strip, ref) === 0 && !targets.some((t) => t.kind === 'lift' && hits(strip, t.rect))) { x = at; slid = d; break; }
      }
      if (inMargin) { x = cw + BRACKET_GAP; gutter = BRACKET_GUTTER; }
      if (x === null) { x = right + BRACKET_GAP; warn('a bracket sits on page content'); }
      const rect = [x, rowsRect[1], BRACKET_ARM, rowsRect[3]];
      glyphs.push(rect);
      panel.brackets.push({ mark: b.markIndex, rows: rowsRect, rect, slid, inMargin });
      const source = [fx + x / S, fy + rect[1] / S, BRACKET_ARM / S, rect[3] / S];
      const target = targets.push({ kind: 'bracket', mark: b.markIndex, rect, ring: 0, dot: false, source, pad: [0, 0, 0, 0] }) - 1;
      anchors.push({ mark: b.mark, markIndex: b.markIndex, prefer: ['right', 'bottom'], label: { title: b.mark.title, note: b.mark.note, tag: b.mark.tag }, members: [target] });
    }

    for (const l of src.loupeMarks) {
      const box = clip(map(l.box));
      if (!box) continue;
      const r = Math.min(Math.max(box[2], box[3]) / 2 + LOUPE_PAD, cw / 2, ch / 2);
      const cx = Math.min(Math.max(box[0] + box[2] / 2, r), cw - r); const cy = Math.min(Math.max(box[1] + box[3] / 2, r), ch - r);
      const ring = [cx - r, cy - r, 2 * r, 2 * r];
      const patch = el('div', 'patch', cap); place(patch, ...ring); bg(patch, fx + ring[0] / S, fy + ring[1] / S, 1);
      place(el('div', 'ring', cap), ...ring);
      const asked = l.mark.zoom ?? LOUPE_ZOOM;
      const zoom = Math.max(1, Math.min(asked, (LOUPE_FILL * LENS_D) / Math.max(box[2], box[3])));
      if (zoom < asked - 1e-9) warn('a loupe was zoomed out to fit its target');
      const target = targets.push({ kind: 'ring', mark: l.markIndex, rect: ring, ring: 0, dot: false, source: l.box, pad: [0, 0, 0, 0] }) - 1;
      anchors.push({
        mark: l.mark, markIndex: l.markIndex, members: [target],
        label: l.mark.title ? { title: l.mark.title, note: l.mark.note, tag: l.mark.tag } : null,
        lens: { centre: [box[0] + box[2] / 2, box[1] + box[3] / 2], zoom, asked },
      });
    }

    src.fillRects.forEach((fillRect) => {
      const rect = clip(map(fillRect));
      if (rect) panel.redactions.push({ rect, fill: redactFill });
    });

    route({ comp, src, solved, targets, anchors, report: panel, warn, probe, glyphs, gutter, bg });
    return { col, phead, number: head.number, comp, panel, notes };
  }

  function route(ctx) {
    const { comp, src, solved, targets, anchors, report, warn, probe, glyphs, gutter, bg } = ctx;
    const { pixels } = src;
    const { colourAt, differs, groundOf, onFill } = probe;
    const { frame, S, cw, ch } = solved;
    const [fx, fy, fw, fh] = frame;
    const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'ov'); comp.appendChild(svg);
    const line = (points, { width = LEADER_WIDTH, join } = {}) => {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', `M ${points.map((q) => q.join(' ')).join(' L ')}`);
      p.setAttribute('fill', 'none'); p.setAttribute('stroke', '#6E56CF'); p.setAttribute('stroke-width', width);
      if (join) p.setAttribute('stroke-linejoin', join);
      svg.appendChild(p);
    };
    const placed = [];
    const dot = ([cx, cy], target, slid) => {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', DOT_R);
      c.setAttribute('fill', '#6E56CF'); c.setAttribute('stroke', '#fff'); c.setAttribute('stroke-width', 2);
      svg.appendChild(c); report.dots.push({ center: [cx, cy], r: DOT_OUTER, target, slid });
    };
    const makeLabel = ({ title, note, tag }) => {
      const lab = el('div', 'label', comp); const row = el('div', 'lrow', lab);
      if (tag) el('span', `tag ${tag}`, row, tag);
      el('span', 'ltitle', row, title);
      if (note) el('div', 'lnote', lab, note);
      return lab;
    };

    // Only the shown frame is drawn inside the lens, from the redacted copy, so
    // the lens cannot show page that the crop left out or a redaction hides.
    const drawLens = (a, lx, ly) => {
      const lens = el('div', `lens${src.dark ? ' dark' : ''}`, comp); place(lens, lx, ly, LENS_D, LENS_D);
      const view = el('div', 'lensview', lens); const z = a.lens.zoom;
      place(view, LENS_D / 2 - a.lens.centre[0] * z, LENS_D / 2 - a.lens.centre[1] * z, cw * z, ch * z);
      bg(view, fx, fy, z);
      place(el('div', 'ztag', comp, `${Math.round(z * 10) / 10}×`), lx + LENS_D - ZTAG_INSET_X, ly + LENS_D - ZTAG_INSET_Y);
      report.loupes.push({ mark: a.markIndex, target: a.primary, ring: targets[a.primary].rect, lens: [lx, ly, LENS_D, LENS_D], zoom: z, asked: a.lens.asked });
    };

    const hitsOther = (index, x0, y0, x1, y1) => targets.some((t, i) => {
      if (i === index || t.kind === 'bracket') return false;
      const [lx, ly, lw, lh] = t.rect;
      return lx <= x1 && lx + lw >= x0 && ly <= y1 && ly + lh >= y0;
    });
    const dotOff = (index) => (targets[index].dot ? DOT_OUTER + targets[index].ring : 0);
    // A path is as wide as its dot, ring included, so a side is clear only if
    // the dot also stays off every other mark's target but a bracket.
    const clearOf = (index, side, along) => {
      const [x, y, w, h] = targets[index].rect;
      const off = dotOff(index);
      const at = along ?? (side === 'right' ? y + h / 2 : x + w / 2);
      return side === 'right'
        ? !hitsOther(index, x + w, at - off, cw + 2 * off, at + off)
        : !hitsOther(index, at - off, y + h, at + off, ch + 2 * off);
    };
    const reach = (index, side) => { const [x, y, w, h] = targets[index].rect; return side === 'right' ? x + w : y + h; };
    const preferred = fw > 2.2 * fh ? ['bottom', 'right'] : ['right', 'bottom'];
    const preferredFor = (a) => a.prefer ?? preferred;
    const middleOf = (index, side) => { const [x, y, w, h] = targets[index].rect; return side === 'right' ? y + h / 2 : x + w / 2; };
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
    // Samples along a route where the capture's pixels differ from the colour
    // `fixed` (by default the route's own first sample, the clean padding beside
    // a lift): how much page content the route would strike through.
    // With `wide`, a sample also counts when a capture pixel beside the centre
    // line differs, as far as the drawn stroke and LEADER_CLEAR reach. A sample
    // on a redaction fill counts whatever its colour.
    const inkAlong = (points, fixed, wide = false) => {
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
            if (side >= 0 && (differs(side, ref) || onFill(...capturePoint(near)))) return true;
          }
        }
        return false;
      };
      let ref = fixed ?? null; let ink = 0;
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
          else if (!ref) ref = colourAt(px);
          else if (differs(px, ref)) ink += 1;
          else if (reachPixels && beside(x, y, nx, ny, reachPixels, ref)) ink += 1;
        }
      }
      return ink;
    };
    // Every source pixel whose centre falls inside the dot's footprint, so a
    // thin stroke between two sample points cannot slip through. The clear
    // space reaches under the lift's own ring, where the board shows the lift
    // and not the page, so what a lift covers is not counted.
    const footprintInk = ([x, y], ref) => {
      const r = FOOT_R / S; const ux = fx + x / S; const uy = fy + y / S;
      let ink = 0;
      for (let sy = Math.floor(uy - r); sy <= Math.ceil(uy + r); sy += 1) {
        for (let sx = Math.floor(ux - r); sx <= Math.ceil(ux + r); sx += 1) {
          if (Math.hypot(sx + 0.5 - ux, sy + 0.5 - uy) > r || sx < 0 || sy < 0 || sx >= pixels.width || sy >= pixels.height) continue;
          const dx = (sx + 0.5 - fx) * S; const dy = (sy + 0.5 - fy) * S;
          if (dx < 0 || dy < 0 || dx > cw || dy > ch) continue;
          if (targets.some(({ kind, rect: [lx, ly, lw, lh], ring }) => kind === 'lift' && dx >= lx - ring && dx <= lx + lw + ring && dy >= ly - ring && dy <= ly + lh + ring)) continue;
          if (onFill(sx, sy) || differs((sy * pixels.width + sx) * 4, ref)) ink += 1;
        }
      }
      return ink;
    };
    // A leader's first segment runs from its target to the capture's edge, and
    // pickLeaderSide chooses the side from the content over its middle: against
    // the clean padding at the lift's own edge for a dot, against the page just
    // beside the target for a ring or bracket, which also counts content within
    // the stroke and LEADER_CLEAR of it.
    const scores = new Map();
    const leaderInk = (index, side) => {
      const key = `${index}:${side}`;
      if (!scores.has(key)) {
        const [x, y, w, h] = targets[index].rect;
        const off = dotOff(index);
        const path = side === 'right' ? [[x + w + off, y + h / 2], [cw, y + h / 2]] : [[x + w / 2, y + h + off], [x + w / 2, ch]];
        scores.set(key, targets[index].dot ? inkAlong(path, groundOf(targets[index], side)) : inkAlong(path, pageBeside(path), true));
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
      const ref = groundOf(targets[index], side);
      const [lo, span] = side === 'right' ? [y, h] : [x, w];
      const centre = lo + span / 2;
      const pointAt = (p) => (side === 'right' ? [x + w + off, p] : [p, y + h + off]);
      const cost = (p) => inkAlong([pointAt(p), side === 'right' ? [cw, p] : [p, ch]], ref, true);
      const accept = (p) => {
        if (!clearOf(index, side, p)) return false;
        const point = pointAt(p);
        return !placed.some(([px, py]) => Math.hypot(px - point[0], py - point[1]) < DOT_APART) && footprintInk(point, ref) === 0;
      };
      const allowed = cleanestSpot(lo, lo + span, centre, accept, cost);
      const clean = allowed && allowed.cost < LEADER_THROUGH ? allowed : null;
      const found = clean ?? allowed ?? cleanestSpot(lo, lo + span, centre, () => true, cost);
      return { at: found.at, slid: Math.round((found.at - centre) * 1000) / 1000, clean: clean !== null };
    };
    let dotOnContent = false;
    const primaryOf = (a, side) => a.members.filter((i) => clearOf(i, side)).reduce((best, i) => (reach(i, side) > reach(best, side) ? i : best));
    const rightList = []; const bottomList = [];
    for (const a of anchors) {
      const open = preferredFor(a).filter((s) => a.members.some((i) => clearOf(i, s)));
      if (!open.length) warn('a leader crosses another lift');
      const inks = open.map((side) => leaderInk(primaryOf(a, side), side));
      let chosen = pickLeaderSide(inks);
      // A ring or bracket has no dot to slide off content, so the tolerance
      // pickLeaderSide gives a dot does not apply: it takes the least struck side.
      if (chosen >= 0 && !targets[primaryOf(a, open[chosen])].dot && inks[chosen] > Math.min(...inks)) chosen = inks.indexOf(Math.min(...inks));
      // The dot goes on the chosen side's best spot; if that has none clean,
      // on the first other open side that has one.
      let pick = null;
      for (const i of chosen < 0 ? [] : [chosen, ...open.keys()].filter((k, n, all) => all.indexOf(k) === n)) {
        const target = primaryOf(a, open[i]);
        const option = { side: open[i], target, spot: targets[target].dot ? dotOn(target, open[i]) : null };
        pick ??= option;
        if (!option.spot || option.spot.clean) { pick = option; break; }
      }
      a.side = pick?.side || 'right';
      a.primary = pick ? pick.target : a.members.reduce((far, i) => (reach(i, a.side) > reach(far, a.side) ? i : far));
      a.slid = 0;
      if (pick?.spot) Object.assign(a, { at: pick.spot.at, slid: pick.spot.slid });
      else if (pick) a.at = middleOf(pick.target, pick.side);
      if (pick?.spot && !pick.spot.clean) dotOnContent = true;
      a.rect = targets[a.primary].rect;
      a.at ??= middleOf(a.primary, a.side);
      if (targets[a.primary].dot) placed.push(a.side === 'right' ? [a.rect[0] + a.rect[2] + dotOff(a.primary), a.at] : [a.at, a.rect[1] + a.rect[3] + dotOff(a.primary)]);
      (a.side === 'bottom' ? bottomList : rightList).push(a);
    }

    const leaderFor = (a, points) => {
      line(points);
      if (targets[a.primary].dot) dot(points[0], a.primary, a.slid);
      report.leaders.push({ points, target: a.primary, targets: [a.primary, ...a.members.filter((i) => i !== a.primary)] });
    };
    // Every other lift of the mark joins the leader's own track: a connector
    // from its dot to `join`. It leaves by the side that is clear of other
    // lifts and strikes through the least page content, the leader's side
    // first on a tie. A route to the leader's far side runs along a lane
    // outside the capture, which adds no ink, so the side is chosen on the
    // base lane and the route is drawn later, once every connector has its own.
    const laned = [];
    const routesOf = (s, toward, lane, join) => {
      const [sx, sy, sw, sh] = targets[s].rect;
      const off = dotOff(s);
      return {
        right: (y) => { const d = [sx + sw + off, y]; return toward === 'right' ? [d, [join[0], d[1]], join] : [d, [lane.x, d[1]], [lane.x, join[1]], join]; },
        bottom: (x) => { const d = [x, sy + sh + off]; return toward === 'bottom' ? [d, [d[0], join[1]], join] : [d, [d[0], lane.y], [join[0], lane.y], join]; },
      };
    };
    const drawConnector = (s, points, slid, leader) => {
      line(points); dot(points[0], s, slid);
      report.connectors.push({ points, target: s, leader });
    };
    const connect = (a, toward, lane, join) => {
      for (const s of a.members.filter((i) => i !== a.primary)) {
        const routes = routesOf(s, toward, lane, join);
        const clear = [toward, toward === 'right' ? 'bottom' : 'right'].filter((o) => clearOf(s, o));
        if (!clear.length) warn('a connector crosses another lift');
        const sides = clear.length ? clear : [toward];
        // A side with a clean dot spot beats one without; then the route that strikes through the least page content.
        const options = sides.map((o) => {
          const spot = dotOn(s, o);
          return { side: o, spot, points: routes[o](spot.at) };
        });
        const { side, points, spot } = options.reduce((best, o) => {
          if (o.spot.clean !== best.spot.clean) return o.spot.clean ? o : best;
          return inkAlong(o.points, groundOf(targets[s], o.side)) < inkAlong(best.points, groundOf(targets[s], best.side)) ? o : best;
        });
        if (!spot.clean && clear.length) dotOnContent = true;
        placed.push(points[0]);
        const leader = report.leaders.length - 1;
        if (side === toward) drawConnector(s, points, spot.slid, leader);
        else laned.push({ target: s, side, at: points[0][side === 'right' ? 1 : 0], slid: spot.slid, toward, join, leader });
      }
    };

    let maxR = cw; let maxB = ch;
    const nR = rightList.length; const nB = bottomList.length;
    // Every lane runs outside the capture, so the labels stand past the lanes
    // the connectors may take: at most one x-lane per non-primary lift of the
    // bottom list, and exactly the y-lanes the right list produced.
    const xLanes = bottomList.reduce((n, a) => n + a.members.length - 1, 0);
    // A margin item is its label, or its lens, or a lens with the label beside it.
    const blockOf = (a) => {
      const lab = a.label ? makeLabel(a.label) : null;
      const size = lab ? lab.getBoundingClientRect() : { width: 0, height: 0 };
      const lensWide = a.lens ? LENS_D + (lab ? LENS_GAP : 0) : 0;
      return { lab, size, block: { width: lensWide + size.width, height: Math.max(a.lens ? LENS_D : 0, size.height) } };
    };
    let nextY = 0;
    rightList.sort((p, q) => p.at - q.at).forEach((a, i) => {
      const { lab, size, block } = blockOf(a);
      const cy = a.rect[1] + a.rect[3] / 2;
      const y = Math.max(nextY, cy - block.height / 2, 0); nextY = y + block.height + (a.lens ? LENS_STACK : 10);
      const x = cw + gutter + 18 + LANE_PITCH * (nR + Math.max(0, xLanes - 1));
      const p1 = [a.rect[0] + a.rect[2] + dotOff(a.primary), a.at]; const xm = cw + gutter + 10 + LANE_PITCH * (nR - 1 - i);
      const ey = a.lens ? y + block.height / 2 : y + Math.min(size.height / 2, 11);
      if (a.lens) drawLens(a, x, y + (block.height - LENS_D) / 2);
      leaderFor(a, [p1, [xm, a.at], [xm, ey], [x - (a.lens ? LENS_RING + LENS_CLEAR : 6), ey]]);
      connect(a, 'right', { y: ch + 10 + LANE_PITCH * nB }, [xm, a.at]);
      if (lab) {
        const lx = x + (a.lens ? LENS_D + LENS_GAP : 0); const ly = y + block.height / 2 - size.height / 2;
        place(lab, lx, ly); report.labels.push({ rect: [lx, ly, size.width, size.height], anchor: p1, target: a.primary });
      }
      maxR = Math.max(maxR, x + block.width); maxB = Math.max(maxB, y + block.height);
    });
    const yLanes = laned.length;
    let nextX = 0;
    bottomList.sort((p, q) => p.at - q.at).forEach((a, i) => {
      const { lab, size, block } = blockOf(a);
      const cx = a.rect[0] + a.rect[2] / 2;
      const x = Math.max(nextX, cx - 24, 0); nextX = x + block.width + 20;
      const y = ch + 18 + LANE_PITCH * (nB + Math.max(0, yLanes - 1));
      const p1 = [a.at, a.rect[1] + a.rect[3] + dotOff(a.primary)]; const ym = ch + 10 + LANE_PITCH * (nB - 1 - i);
      if (a.lens) drawLens(a, x, y);
      const bend = x + (a.lens ? LENS_D / 2 : 12);
      leaderFor(a, [p1, [a.at, ym], [bend, ym], [bend, y - (a.lens ? LENS_RING + LENS_CLEAR : 6)]]);
      connect(a, 'bottom', { x: cw + gutter + 10 + LANE_PITCH * nR }, [a.at, ym]);
      if (lab) {
        const lx = x + (a.lens ? LENS_D + LENS_GAP : 0); const ly = y + block.height / 2 - size.height / 2;
        place(lab, lx, ly); report.labels.push({ rect: [lx, ly, size.width, size.height], anchor: p1, target: a.primary });
      }
      maxR = Math.max(maxR, x + block.width); maxB = Math.max(maxB, y + block.height);
    });
    // The connector of the last anchor takes the nearest lane, so a drop
    // further down the board never crosses an earlier connector's run.
    const used = { x: 0, y: 0 };
    for (const c of laned.reverse()) {
      const axis = c.toward === 'right' ? 'y' : 'x';
      const lane = axis === 'y' ? { y: ch + 10 + LANE_PITCH * (nB + used.y) } : { x: cw + gutter + 10 + LANE_PITCH * (nR + used.x) };
      used[axis] += 1;
      drawConnector(c.target, routesOf(c.target, c.toward, lane, c.join)[c.side](c.at), c.slid, c.leader);
      maxR = Math.max(maxR, lane.x ?? 0); maxB = Math.max(maxB, lane.y ?? 0);
    }
    for (const [x, top, w, h] of glyphs) line([[x, top], [x + w, top], [x + w, top + h], [x, top + h]], { width: BRACKET_WIDTH, join: 'round' });
    const lines = [...report.leaders, ...report.connectors].map(({ points, target }) => ({ points, mark: targets[target].mark }));
    if (lines.some((p, i) => lines.slice(i + 1).some((q) => p.mark !== q.mark && pathsCross(p.points, q.points)))) warn('a connector crosses another leader');
    if (dotOnContent) warn('a leader dot sits on page content');
    comp.style.width = `${Math.ceil(maxR + 4)}px`; comp.style.height = `${Math.ceil(maxB + 4)}px`;
    svg.setAttribute('width', comp.style.width); svg.setAttribute('height', comp.style.height);
  }

  window.__composeLayout = async function () {
    const { spec, captures, redactFill } = window.__composeData;
    const warnings = [];
    await document.fonts.load('600 13px Inter');
    const stage = document.getElementById('stage');
    const header = el('div', 'header', stage);
    el('span', 'state', header, spec.state).style.background = TONES[spec.state] || '#1F1A3D';
    el('span', 'title', header, spec.title);
    const row = el('div', 'panels', stage);

    const layout = spec.layout ?? 'single';
    const sources = [];
    for (const [i, panel] of spec.panels.entries()) sources.push({ ...await sourceOf(panel, captures[i], redactFill), trims: layout !== 'single', crops: layout !== 'pair', floor: layout !== 'single', hold: layout !== 'single' });
    let solved = sources.map((src) => settle(src, singleScale(src.scale)));
    if (sources.length > 1) {
      const found = solved.map((s) => s.region);
      const regions = layout === 'pair' ? sharedTrims(sources, found) : found;
      sources.forEach((src, i) => { src.region = regions[i]; });
      const { height, floored } = commonHeight(regions.map((region, i) => region.box.map((v) => v / sources[i].scale)));
      if (floored) warnings.push('the panels differ too much in shape to share a height well');
      solved = sources.map((src) => settle(src, (frame) => height / frame[3]));
      if (solved.some((p, i) => p.S * sources[i].scale < PANEL_SMALL_S)) warnings.push('a panel is drawn small; frame the card that holds its marks');
    }
    const arrowNodes = [];
    const drawn = sources.map((src, i) => {
      if (layout === 'steps' && i > 0) {
        const arrow = el('div', 'arrow', row, '→');
        arrow.style.marginTop = `${HEAD_H + PANEL_GAP + solved[i].ch / 2 - ARROW_D / 2}px`;
        arrowNodes.push(arrow);
      }
      return drawPanel(src, solved[i], row, { number: layout === 'steps' ? i + 1 : null, headed: layout !== 'single' || Boolean(src.panel.label) || src.imported });
    });

    await document.fonts.ready;
    const s = stage.getBoundingClientRect();
    const inStage = (node) => { const r = node.getBoundingClientRect(); return [r.left - s.left, r.top - s.top, r.width, r.height]; };
    const panels = drawn.map(({ col, phead, number, comp, panel }) => {
      const c = comp.getBoundingClientRect();
      const dx = c.left - s.left; const dy = c.top - s.top;
      const off = (r) => [r[0] + dx, r[1] + dy, r[2], r[3]];
      const offPoint = ([x, y]) => [x + dx, y + dy];
      return {
        ...panel,
        extent: inStage(col),
        head: phead ? { rect: inStage(phead), number, origin: panel.source === 'import' } : null,
        capture: off(panel.capture),
        targets: panel.targets.map((t) => ({ kind: t.kind, mark: t.mark, rect: off(t.rect), ...(t.lift === undefined ? {} : { lift: t.lift }) })),
        lifts: panel.lifts.map((l) => ({ ...l, rect: off(l.rect) })),
        slots: panel.slots.map((s) => ({ ...s, rect: off(s.rect) })),
        brackets: panel.brackets.map((b) => ({ ...b, rows: off(b.rows), rect: off(b.rect) })),
        loupes: panel.loupes.map((l) => ({ ...l, ring: off(l.ring), lens: off(l.lens) })),
        flats: panel.flats.map((f) => ({ ...f, rect: off(f.rect) })),
        labels: panel.labels.map((l) => ({ ...l, rect: off(l.rect), anchor: offPoint(l.anchor) })),
        dots: panel.dots.map((d) => ({ ...d, center: offPoint(d.center) })),
        redactions: panel.redactions.map((r) => ({ ...r, rect: off(r.rect) })),
        leaders: panel.leaders.map((l) => ({ ...l, points: l.points.map(offPoint) })),
        connectors: panel.connectors.map((l) => ({ ...l, points: l.points.map(offPoint) })),
      };
    });
    for (const { notes } of drawn) warnings.push(...notes);
    const report = { layout, stage: [0, 0, s.width, s.height], warnings: [...new Set(warnings)], arrows: arrowNodes.map(inStage), panels };
    const gated = spec.panels.some((panel, i) => captures[i].source === 'import' && (panel.marks || []).some((mark) => 'redact' in mark));
    const whole = ([x, y, w, h]) => {
      const x0 = Math.max(0, Math.floor(x - CROP_MARGIN)); const y0 = Math.max(0, Math.floor(y - CROP_MARGIN));
      return [x0, y0, Math.min(Math.ceil(s.width), Math.ceil(x + w + CROP_MARGIN)) - x0, Math.min(Math.ceil(s.height), Math.ceil(y + h + CROP_MARGIN)) - y0];
    };
    report.gated = gated;
    report.crops = gated ? panels.flatMap((panel, p) => panel.redactions.map((r, k) => ({ panel: p, redaction: k, rect: whole(r.rect) }))) : [];
    window.__composeReport = report;
    return report;
  };
}());
