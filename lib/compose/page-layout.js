// Runs inside the headless renderer page. Plain script, no imports: page.mjs
// inlines this file's text. window.__composeLayout() returns a Promise that
// resolves once every image is decoded and layout is final.
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

  const { growBox, cleanPad, cropToMarks, cleanFrame, clusterBoxes, pickLeaderSide, collidingLifts, slideDot, hits, union, components, TOLERANCE, LIFT_RING, LIFT_BAND, LEADER_THROUGH } = globalThis.__composeGeometry;
  const GROW_LIMIT = 96;
  const MIN_LIFT_HEIGHT = 28;
  const MAX_K = 3;
  const BASE_K = 1.06;
  const PAD = 4;
  // The dot's outer radius includes its 2px stroke. The dot sits just outside
  // the lift ring so it never covers the content it points at.
  const DOT_R = 4.5;
  const DOT_OUTER = DOT_R + 1;
  const DOT_OFF = LIFT_RING + DOT_OUTER;
  // A dot's footprint is its full diameter plus this much clear space on every
  // side; no page content may sit under it.
  const FOOT_CLEAR = 6;
  const FOOT_R = DOT_OUTER + FOOT_CLEAR;

  // Redaction is applied once, to the source pixels, before any layer reads
  // them: every layer below draws from this redacted copy, so no lift can
  // ever show what a redaction hides, and lift growth reads these same pixels.
  async function redactedSource(capture, regions, fill) {
    const img = await loadImage(capture.uri);
    const canvas = document.createElement('canvas');
    canvas.width = capture.size[0]; canvas.height = capture.size[1];
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    ctx.fillStyle = fill;
    for (const [x, y, w, h] of regions) ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { url: canvas.toDataURL('image/png'), pixels: { data, width, height } };
  }

  const keysOf = (mark, kind) => [].concat(mark[kind]);

  window.__composeLayout = async function () {
    const { spec, captures, redactFill } = window.__composeData;
    const report = { lifts: [], labels: [], leaders: [], connectors: [], dots: [], redactions: [], warnings: [], dark: false };
    await document.fonts.load('600 13px Inter');
    const stage = document.getElementById('stage');
    const header = el('div', 'header', stage);
    el('span', 'state', header, spec.state).style.background = TONES[spec.state] || '#1F1A3D';
    el('span', 'title', header, spec.title);

    const panel = spec.panels[0];
    const capture = captures[0];
    const marks = panel.marks || [];
    const dark = Boolean(capture.dark);
    report.dark = dark;

    const redactBoxes = marks.filter((m) => 'redact' in m).map((m) => union(keysOf(m, 'redact').map((k) => capture.boxes[k])));
    const { url: source, pixels } = await redactedSource(capture, redactBoxes, redactFill);

    const liftMarks = marks.map((mark, markIndex) => ({ mark, markIndex })).filter(({ mark }) => 'lift' in mark);
    const fillRects = redactBoxes.map((r) => [r[0] - 2, r[1] - 2, r[2] + 4, r[3] + 4]);

    // The captured frame's edges can land mid-word; they move off content
    // before anything is bounded by the frame. The marks are the boxes as
    // captured, and a redaction wholly outside the frame is not a mark.
    const sourceMarks = [...liftMarks.flatMap(({ mark }) => keysOf(mark, 'lift').map((k) => capture.boxes[k])), ...redactBoxes]
      .filter((b) => hits(b, capture.frame));
    const cleaned = cleanFrame(pixels, capture.frame, sourceMarks.length ? union(sourceMarks) : null, { ignore: fillRects });
    const shown = cleaned.frame;
    if (cleaned.cut) report.warnings.push('a frame edge cuts through content');

    // A lift whose box ends inside content (a name without its value) grows
    // out to the nearest clean edges. It never grows into a redaction or into
    // another lift unless the two boxes already overlapped as named. The
    // redaction fill's 2px margin often sits inside a lift box already, so
    // those pixels are ignored when testing an edge rather than walled off.
    const keepClear = (o) => [o[0] - 2 * PAD, o[1] - 2 * PAD, o[2] + 4 * PAD, o[3] + 4 * PAD];
    const growAvoiding = (box, avoid) => growBox(pixels, box, GROW_LIMIT, { bounds: shown, avoid: [...avoid, ...redactBoxes], ignore: fillRects, band: LIFT_BAND });

    // A point over elements that sit apart is one lift per cluster of elements.
    // Keys cluster by where each grows to on its own, so a union never sweeps
    // the content between them into the lift.
    const clustered = liftMarks.flatMap(({ mark, markIndex }) => {
      const keys = keysOf(mark, 'lift');
      let clusters = [keys.map((_, i) => i)];
      if (keys.length > 1) {
        const others = liftMarks.filter((l) => l.mark !== mark).flatMap((l) => keysOf(l.mark, 'lift').map((k) => capture.boxes[k]));
        const alone = keys.map((k) => growAvoiding(capture.boxes[k], others.filter((o) => !hits(capture.boxes[k], o)).map(keepClear)).box);
        clusters = clusterBoxes(alone);
      }
      return clusters.map((members) => {
        const own = members.map((i) => keys[i]);
        return { mark, markIndex, keys: own, original: union(own.map((k) => capture.boxes[k])) };
      });
    });

    // Everything below the groups follows from them: the grown boxes, the
    // frame, the scale and every lift's final rect. So a merge solves again.
    const solve = (groups) => {
      const originals = groups.map((g) => g.original);
      const grownBoxes = []; const cutLifts = [];
      groups.forEach((_, i) => {
        const avoid = originals.flatMap((o, j) => (j === i || hits(originals[i], o) ? [] : [keepClear(j < i ? grownBoxes[j] : o)]));
        const { box, cut } = growAvoiding(originals[i], avoid);
        grownBoxes.push(box); cutLifts.push(cut);
      });

      // The frame shrinks to its marks before the scale is chosen, so the scale,
      // the lifts, the labels and the leaders all work on the frame that is
      // shown. A redaction wholly outside the original frame is not a mark.
      const markBoxes = [...grownBoxes, ...redactBoxes.filter((r) => hits(r, shown))];
      const { box: frame, edges: cropEdges } = cropToMarks(pixels, shown, markBoxes.length ? union(markBoxes) : null);
      const [fx, fy, fw, fh] = frame;
      const S = Math.min(1.25, Math.max(0.55, 560 / fw));
      const cw = Math.round(fw * S); const ch = Math.round(fh * S);
      const map = (b) => [(b[0] - fx) * S, (b[1] - fy) * S, b[2] * S, b[3] * S];

      const plans = groups.map((group, i) => {
        const b = grownBoxes[i]; const orig = originals[i];
        const grown = [orig[0] - b[0], orig[1] - b[1], b[0] + b[2] - orig[0] - orig[2], b[1] + b[3] - orig[1] - orig[3]]
          .map((g) => Math.max(0, Math.round(g)));
        // Padding stops at the first line that touches content, so a lift never
        // shows a sliver of the neighbouring word.
        const pad = cleanPad(pixels, b, PAD, { bounds: frame, ignore: fillRects });
        const bb = [b[0] - pad[0], b[1] - pad[1], b[2] + pad[0] + pad[2], b[3] + pad[1] + pad[3]];
        const [x, y, w, h] = map(bb);
        const k = Math.max(BASE_K, Math.min(MAX_K, MIN_LIFT_HEIGHT / h));
        const kFit = Math.min(k, (cw - 4) / w, (ch - 4) / h);
        return { group, b, grown, pad, bb, x, y, w, h, kFit, floor: Math.min(BASE_K, kFit) };
      });
      const fitted = (p, kk) => {
        const W = p.w * kk; const H = p.h * kk;
        const L = Math.min(Math.max(p.x + p.w / 2 - W / 2, 2), cw - W - 2); const T = Math.min(Math.max(p.y + p.h / 2 - H / 2, 2), ch - H - 2);
        return { W, H, L, T, clamped: L !== p.x + p.w / 2 - W / 2 || T !== p.y + p.h / 2 - H / 2 };
      };

      const finals = []; const notes = [];
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
      return { groups, plans, finals, notes, frame, cropEdges, S, cw, ch, map };
    };

    // Lifts of one point that would collide at their final rects are one thing
    // again: those clusters merge and the layout is solved once more.
    const mergeColliding = (groups, pairs) => {
      return components(groups.length, pairs).map((indexes) => {
        const members = indexes.map((i) => groups[i]);
        if (members.length === 1) return members[0];
        return { ...members[0], keys: members.flatMap((m) => m.keys), original: union(members.map((m) => m.original)), merged: true };
      });
    };
    let solved = solve(clustered);
    for (;;) {
      const pairs = collidingLifts(solved.finals.map((f, i) => ({ mark: solved.groups[i].markIndex, rect: f.rect })));
      if (!pairs.length) break;
      solved = solve(mergeColliding(solved.groups, pairs));
    }
    const { groups, plans, finals, frame, cropEdges, S, cw, ch, map } = solved;
    report.warnings.push(...solved.notes);
    const [fx, fy, fw, fh] = frame;
    const cropped = fw * fh < shown[2] * shown[3];
    const bg = (node, x, y, k) => {
      node.style.backgroundImage = `url(${source})`;
      node.style.backgroundSize = `${capture.size[0] * S * k}px ${capture.size[1] * S * k}px`;
      node.style.backgroundPosition = `${-x * S * k}px ${-y * S * k}px`;
    };

    const comp = el('div', 'comp', stage);
    const cap = el('div', 'capture', comp); place(cap, 0, 0, cw, ch);
    bg(el('div', 'fill', cap), fx, fy, 1);
    if (groups.length) el('div', `wash${dark ? ' dark' : ''}`, cap);

    const anchors = [];
    plans.forEach((p, i) => {
      const { group, b, grown, pad, bb } = p;
      const { rect: [L, T, W, H], clamped, k: kEff } = finals[i];
      // bg() positions the source at -bb * S * k, so a clamped lift still
      // shows its own region wherever it ends up.
      const lift = el('div', `lift${dark ? ' dark' : ''}`, comp); place(lift, L, T, W, H);
      bg(lift, bb[0], bb[1], kEff);
      report.lifts.push({ keys: group.keys, mark: group.markIndex, rect: [L, T, W, H], clamped, grown, pad, source: b, k: kEff, ...(group.merged ? { merged: true } : {}) });
      if (group.mark.title) {
        const entry = anchors.find((a) => a.mark === group.mark) || anchors[anchors.push({ mark: group.mark, lifts: [] }) - 1];
        entry.lifts.push(report.lifts.length - 1);
      }
    });

    for (const box of redactBoxes) {
      const [x, y, w, h] = map(box);
      if (hits([x, y, w, h], [0, 0, cw, ch])) report.redactions.push({ rect: [x, y, w, h], fill: redactFill });
    }

    const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'ov'); comp.appendChild(svg);
    const line = (points) => {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', `M ${points.map((q) => q.join(' ')).join(' L ')}`);
      p.setAttribute('fill', 'none'); p.setAttribute('stroke', '#6E56CF'); p.setAttribute('stroke-width', '1.5');
      svg.appendChild(p);
    };
    const dot = ([cx, cy], lift, slid) => {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', DOT_R);
      c.setAttribute('fill', '#6E56CF'); c.setAttribute('stroke', '#fff'); c.setAttribute('stroke-width', 2);
      svg.appendChild(c); report.dots.push({ center: [cx, cy], r: DOT_OUTER, lift, slid });
    };
    const makeLabel = (mark) => {
      const lab = el('div', 'label', comp); const row = el('div', 'lrow', lab);
      if (mark.tag) el('span', `tag ${mark.tag}`, row, mark.tag);
      el('span', 'ltitle', row, mark.title);
      if (mark.note) el('div', 'lnote', lab, mark.note);
      return lab;
    };

    const hitsOther = (index, x0, y0, x1, y1) => report.lifts.some((l, i) => {
      if (i === index) return false;
      const [lx, ly, lw, lh] = l.rect;
      return lx <= x1 && lx + lw >= x0 && ly <= y1 && ly + lh >= y0;
    });
    // A path is as wide as its dot, ring included, so a side is clear only if
    // the dot also stays off every other lift.
    const half = DOT_OUTER + LIFT_RING;
    const clearOf = (index, side, along) => {
      const [x, y, w, h] = report.lifts[index].rect;
      const at = along ?? (side === 'right' ? y + h / 2 : x + w / 2);
      return side === 'right'
        ? !hitsOther(index, x + w, at - half, cw + DOT_OFF + half, at + half)
        : !hitsOther(index, at - half, y + h, at + half, ch + DOT_OFF + half);
    };
    const reach = (index, side) => { const [x, y, w, h] = report.lifts[index].rect; return side === 'right' ? x + w : y + h; };
    const preferred = fw > 2.2 * fh ? ['bottom', 'right'] : ['right', 'bottom'];
    // A colour is [r, g, b]; `px` is a pixel's byte offset in the capture.
    const colourAt = (px) => [pixels.data[px], pixels.data[px + 1], pixels.data[px + 2]];
    const differs = (px, ref) => ref.some((v, c) => Math.abs(pixels.data[px + c] - v) > TOLERANCE);
    // Samples along a route where the capture's pixels differ from the colour
    // `fixed` (by default the route's own first sample, the clean padding beside
    // a lift): how much page content the route would strike through.
    const inkAlong = (points, fixed) => {
      const at = ([x, y]) => {
        const sx = Math.floor(fx + x / S); const sy = Math.floor(fy + y / S);
        return sx < 0 || sy < 0 || sx >= pixels.width || sy >= pixels.height ? -1 : (sy * pixels.width + sx) * 4;
      };
      let ref = fixed ?? null; let ink = 0;
      for (let k = 0; k < points.length - 1; k += 1) {
        const [x0, y0] = points[k]; const [x1, y1] = points[k + 1];
        const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 2);
        for (let t = 0; t <= n; t += 1) {
          const px = at([x0 + ((x1 - x0) * t) / n, y0 + ((y1 - y0) * t) / n]);
          if (px < 0 || x0 + ((x1 - x0) * t) / n > cw || y0 + ((y1 - y0) * t) / n > ch) continue;
          if (!ref) ref = colourAt(px);
          else if (differs(px, ref)) ink += 1;
        }
      }
      return ink;
    };
    // The colour its leader and dot are measured against: the median of the
    // clean padding line beside a lift's side, or of the box's own edge line
    // when there is no padding. A median, so a stray antialiased pixel on the
    // line cannot become the ground.
    const groundOf = (index, side) => {
      const { source: [bx, by, bw, bh], pad } = report.lifts[index];
      const out = pad[side === 'right' ? 2 : 3] > 0 ? 1 : 0;
      const right = side === 'right';
      const fixed = Math.floor(right ? bx + bw - 1 + out : by + bh - 1 + out);
      const [from, to] = right ? [Math.floor(by), Math.ceil(by + bh)] : [Math.floor(bx), Math.ceil(bx + bw)];
      const channels = [[], [], []];
      for (let i = Math.max(0, from); i < Math.min(right ? pixels.height : pixels.width, to); i += 1) {
        const x = right ? fixed : i; const y = right ? i : fixed;
        if (x < 0 || y < 0 || x >= pixels.width || y >= pixels.height) continue;
        const px = colourAt((y * pixels.width + x) * 4);
        channels.forEach((values, c) => values.push(px[c]));
      }
      return channels.map((values) => values.sort((a, b) => a - b)[values.length >> 1]);
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
          if (report.lifts.some(({ rect: [lx, ly, lw, lh] }) => dx >= lx - LIFT_RING && dx <= lx + lw + LIFT_RING && dy >= ly - LIFT_RING && dy <= ly + lh + LIFT_RING)) continue;
          if (differs((sy * pixels.width + sx) * 4, ref)) ink += 1;
        }
      }
      return ink;
    };
    // A leader's dot and first segment run from the lift to the capture's edge.
    // Page content over each clear side is measured against the clean padding
    // at the lift's own edge, and pickLeaderSide decides from it. Scores are
    // kept per lift and side.
    const scores = new Map();
    const leaderInk = (index, side) => {
      const key = `${index}:${side}`;
      if (!scores.has(key)) {
        const [x, y, w, h] = report.lifts[index].rect;
        const route = side === 'right' ? [[x + w + DOT_OFF, y + h / 2], [cw, y + h / 2]] : [[x + w / 2, y + h + DOT_OFF], [x + w / 2, ch]];
        scores.set(key, inkAlong(route, groundOf(index, side)));
      }
      return scores.get(key);
    };
    // Where a lift's dot sits on one side: the middle of the side, or the
    // nearest spot along it whose footprint and first segment cross no page
    // content. `slid` is the offset from the middle; null when no spot is clean.
    const dotOn = (index, side) => {
      const [x, y, w, h] = report.lifts[index].rect;
      const ref = groundOf(index, side);
      const [lo, span] = side === 'right' ? [y, h] : [x, w];
      const centre = lo + span / 2;
      const at = slideDot(lo, lo + span, centre, (p) => {
        if (!clearOf(index, side, p)) return false;
        const point = side === 'right' ? [x + w + DOT_OFF, p] : [p, y + h + DOT_OFF];
        // The first segment may cross a card's border or stray antialiasing, as in pickLeaderSide; the dot itself may touch nothing.
        return footprintInk(point, ref) === 0 && inkAlong([point, side === 'right' ? [cw, p] : [p, ch]], ref) < LEADER_THROUGH;
      });
      return at === null ? null : { at, slid: Math.round((at - centre) * 1000) / 1000 };
    };
    let dotOnContent = false;
    const primaryOf = (a, side) => a.lifts.filter((i) => clearOf(i, side)).reduce((best, i) => (reach(i, side) > reach(best, side) ? i : best));
    const rightList = []; const bottomList = [];
    for (const a of anchors) {
      const open = preferred.filter((s) => a.lifts.some((i) => clearOf(i, s)));
      if (!open.length) report.warnings.push('a leader crosses another lift');
      const chosen = pickLeaderSide(open.map((s) => leaderInk(primaryOf(a, s), s)));
      const side = open[chosen];
      a.side = side || 'right';
      // The leader starts from the lift nearest the label's side, and the dot
      // from the chosen side's clean spot; failing that, the other open sides
      // in turn.
      a.primary = side ? primaryOf(a, side) : a.lifts.reduce((best, i) => (reach(i, a.side) > reach(best, a.side) ? i : best));
      a.slid = 0;
      for (const s of side ? [side, ...open.filter((o) => o !== side)] : []) {
        const lift = primaryOf(a, s); const spot = dotOn(lift, s);
        if (!spot) continue;
        Object.assign(a, { side: s, primary: lift, at: spot.at, slid: spot.slid });
        break;
      }
      if (side && a.at === undefined) dotOnContent = true;
      a.rect = report.lifts[a.primary].rect;
      a.at ??= a.side === 'right' ? a.rect[1] + a.rect[3] / 2 : a.rect[0] + a.rect[2] / 2;
      (a.side === 'bottom' ? bottomList : rightList).push(a);
    }

    const leaderFor = (a, points) => {
      line(points); dot(points[0], a.primary, a.slid);
      report.leaders.push({ points, lift: a.primary, lifts: [a.primary, ...a.lifts.filter((i) => i !== a.primary)] });
    };
    // Every other lift of the mark joins the leader's own track: a connector
    // from its dot to `join`. It leaves by the side that is clear of other
    // lifts and strikes through the least page content, the leader's side
    // first on a tie. `lane` is the track the route to the leader's far side
    // runs along.
    const connect = (a, toward, lane, join) => {
      for (const s of a.lifts.filter((i) => i !== a.primary)) {
        const [sx, sy, sw, sh] = report.lifts[s].rect;
        const routes = {
          right: (y) => { const d = [sx + sw + DOT_OFF, y]; return toward === 'right' ? [d, [join[0], d[1]], join] : [d, [lane.x, d[1]], [lane.x, join[1]], join]; },
          bottom: (x) => { const d = [x, sy + sh + DOT_OFF]; return toward === 'bottom' ? [d, [d[0], join[1]], join] : [d, [d[0], lane.y], [join[0], lane.y], join]; },
        };
        const clear = [toward, toward === 'right' ? 'bottom' : 'right'].filter((o) => clearOf(s, o));
        if (!clear.length) report.warnings.push('a connector crosses another lift');
        const sides = clear.length ? clear : [toward];
        // A side with a clean dot spot beats one without; then the route that strikes through the least page content.
        const options = sides.map((o) => {
          const spot = dotOn(s, o);
          return { side: o, spot, points: routes[o](spot ? spot.at : o === 'right' ? sy + sh / 2 : sx + sw / 2) };
        });
        const { side, points, spot } = options.reduce((best, o) => {
          if (Boolean(o.spot) !== Boolean(best.spot)) return o.spot ? o : best;
          return inkAlong(o.points) < inkAlong(best.points) ? o : best;
        });
        if (!spot && clear.length) dotOnContent = true;
        line(points); dot(points[0], s, spot ? spot.slid : 0);
        report.connectors.push({ points, lift: s, leader: report.leaders.length - 1 });
        if (side !== toward) { maxR = Math.max(maxR, lane.x ?? 0); maxB = Math.max(maxB, lane.y ?? 0); }
      }
    };

    let maxR = cw; let maxB = ch;
    const nR = rightList.length; const nB = bottomList.length;
    let nextY = 0;
    rightList.sort((p, q) => (p.rect[1] + p.rect[3] / 2) - (q.rect[1] + q.rect[3] / 2)).forEach((a, i) => {
      const lab = makeLabel(a.mark); const r = lab.getBoundingClientRect();
      const cy = a.rect[1] + a.rect[3] / 2;
      const y = Math.max(nextY, cy - r.height / 2, 0); nextY = y + r.height + 10;
      const x = cw + 18 + 8 * nR; place(lab, x, y);
      const p1 = [a.rect[0] + a.rect[2] + DOT_OFF, a.at]; const xm = cw + 10 + 8 * (nR - 1 - i); const ey = y + Math.min(r.height / 2, 11);
      leaderFor(a, [p1, [xm, a.at], [xm, ey], [x - 6, ey]]);
      connect(a, 'right', { y: ch + 10 + 8 * nB }, [xm, a.at]);
      report.labels.push({ rect: [x, y, r.width, r.height], anchor: p1 });
      maxR = Math.max(maxR, x + r.width); maxB = Math.max(maxB, y + r.height);
    });
    let nextX = 0;
    bottomList.sort((p, q) => p.rect[0] - q.rect[0]).forEach((a, i) => {
      const lab = makeLabel(a.mark); const r = lab.getBoundingClientRect();
      const cx = a.rect[0] + a.rect[2] / 2;
      const x = Math.max(nextX, cx - 24, 0); nextX = x + r.width + 20;
      const y = ch + 18 + 8 * nB; place(lab, x, y);
      const p1 = [a.at, a.rect[1] + a.rect[3] + DOT_OFF]; const ym = ch + 10 + 8 * (nB - 1 - i);
      leaderFor(a, [p1, [a.at, ym], [x + 12, ym], [x + 12, y - 6]]);
      connect(a, 'bottom', { x: cw + 10 + 8 * nR }, [a.at, ym]);
      report.labels.push({ rect: [x, y, r.width, r.height], anchor: p1 });
      maxR = Math.max(maxR, x + r.width); maxB = Math.max(maxB, y + r.height);
    });
    if (dotOnContent) report.warnings.push('a leader dot sits on page content');
    comp.style.width = `${Math.ceil(maxR + 4)}px`; comp.style.height = `${Math.ceil(maxB + 4)}px`;
    svg.setAttribute('width', comp.style.width); svg.setAttribute('height', comp.style.height);

    await document.fonts.ready;
    const s = stage.getBoundingClientRect(); const c = comp.getBoundingClientRect();
    const off = (rect) => [rect[0] + c.left - s.left, rect[1] + c.top - s.top, rect[2], rect[3]];
    report.stage = [0, 0, s.width, s.height];
    report.capture = off([0, 0, cw, ch]);
    report.frame = frame;
    report.cleanFrame = shown;
    report.frameEdges = cleaned.edges;
    report.cropped = cropped;
    if (cropped) report.cropEdges = cropEdges;
    report.lifts = report.lifts.map((l) => ({ ...l, rect: off(l.rect) }));
    const offPoint = ([x, y]) => [x + c.left - s.left, y + c.top - s.top];
    report.labels = report.labels.map((l) => ({ ...l, rect: off(l.rect), anchor: offPoint(l.anchor) }));
    report.dots = report.dots.map((d) => ({ ...d, center: offPoint(d.center) }));
    report.redactions = report.redactions.map((r) => ({ ...r, rect: off(r.rect) }));
    report.leaders = report.leaders.map((l) => ({ ...l, points: l.points.map(offPoint) }));
    report.connectors = report.connectors.map((l) => ({ ...l, points: l.points.map(offPoint) }));
    report.warnings = [...new Set(report.warnings)];
    window.__composeReport = report;
    return report;
  };
}());
