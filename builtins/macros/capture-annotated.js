async (page, args) => {
  const {
    targets = {}, out = 'capture', home, space: wantSpace = true,
  } = args || {};
  const names = Object.keys(targets);
  if (names.length === 0) {
    return { failedStep: 'args', error: 'targets is required' };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(out)) {
    return { failedStep: 'args', error: 'out must be a simple file name' };
  }
  // This macro runs with none of the Node host globals that could reach the
  // filesystem or the environment: no `process`, no `require`, nothing that
  // could read the caller's home directory (confirmed by a live run: `typeof
  // process` inside the real sandbox is `undefined`). Some ambient names do
  // exist -- `console` is present both in the real sandbox and in the `vm`
  // context the tests use -- but none of them expose the environment. So the
  // caller -- the agent driving `browser_run_code_unsafe`, which runs in a
  // real Node process and can read its own environment -- must supply `home`.
  //
  // What the check below buys is well-formedness, not a boundary. It rejects
  // a malformed or traversing value, which is what guarantees the screenshot
  // path is a well-formed absolute path carrying a fixed
  // `/.fast-browser/screenshots/` suffix. It is NOT a defence against this
  // macro's own caller, who already holds arbitrary code execution in the
  // Playwright server process by virtue of calling `browser_run_code_unsafe`
  // at all. Any absolute path passes, so `home: '/tmp'` writes to
  // `/tmp/.fast-browser/screenshots/` just as readily as the real home
  // directory would; the runtime applies no path confinement of its own to
  // code executed this way.
  if (
    typeof home !== 'string'
    || home.length === 0
    || home.length > 4096
    || home[0] !== '/'
    || home.includes('\0')
    || home.split('/').includes('..')
  ) {
    return {
      failedStep: 'args',
      error: "home must be the caller's absolute home directory path, with no .. segments",
    };
  }

  // `name` is what goes into the annotate config's `base` field, which takes a
  // NAME inside the screenshots directory, not a path. Returning both avoids
  // the agent having to derive one from the other and getting it wrong.
  const name = `${out}.png`;
  const png = `${home}/.fast-browser/screenshots/${name}`;

  try {
    // Screenshot FIRST, then measure, with nothing between them that could
    // reflow the page. This adjacency is the entire integrity guarantee: any
    // gap lets a lazy image or a dismissing toast move the elements, and the
    // boxes would then describe a layout the PNG does not show.
    await page.screenshot({ path: png, scale: 'css' });

    const viewport = await page.evaluate(() => ({
      inner: [window.innerWidth, window.innerHeight],
      // innerWidth counts a classic scrollbar's own pixels, so it cannot
      // detect one. clientWidth is what changes when a scrollbar appears.
      client: [document.documentElement.clientWidth, document.documentElement.clientHeight],
    }));

    const resolved = {};
    const missed = [];
    const opaque = {};
    for (const key of names) {
      const selector = targets[key];
      const locator = page.locator(selector);
      const count = await locator.count();
      if (count === 0) {
        missed.push({ key, reason: 'no-match' });
        continue;
      }
      if (count > 1) {
        // Never take the first hit. Silently annotating element 1 of 4 is how
        // a redaction lands on the wrong row.
        missed.push({ key, reason: 'ambiguous', count });
        continue;
      }
      const box = await locator.boundingBox();
      if (!box || box.width <= 0 || box.height <= 0) {
        missed.push({ key, reason: 'not-visible' });
        continue;
      }
      const rect = [
        Math.round(box.x), Math.round(box.y),
        Math.round(box.width), Math.round(box.height),
      ];
      // Re-check after rounding, not only before it. The guard above tests
      // boundingBox()'s own floating-point size, so a sub-pixel element (0.4
      // px wide) passes it and still rounds to a zero dimension here.
      // `annotate` refuses a zero-area box, and refuses the WHOLE config with
      // it, blaming an annotation the agent measured correctly and cannot
      // act on. Anything this macro puts in `resolved` has to clear annotate's
      // guards, so a box that rounds away is a miss like any other.
      if (rect[2] <= 0 || rect[3] <= 0) {
        missed.push({ key, reason: 'not-visible' });
        continue;
      }
      if (
        rect[0] < 0 || rect[1] < 0
        || rect[0] + rect[2] > viewport.inner[0]
        || rect[1] + rect[3] > viewport.inner[1]
      ) {
        missed.push({ key, reason: 'out-of-view' });
        continue;
      }
      resolved[key] = rect;
      // An opaque element's box is measurable but its interior is not: a bar
      // inside a canvas chart, a row inside a cross-origin iframe, a face in
      // a photo. No selector can ever reach deeper, so retrying selectors is
      // wasted work, and the caller has to know that up front to escalate to
      // container arithmetic or within-capture inspection instead. Reading a
      // tag name mutates nothing, so the screenshot-then-measure adjacency
      // holds.
      const tag = await locator.evaluate((element) => element.tagName.toLowerCase());
      if (['canvas', 'iframe', 'frame', 'video', 'embed', 'object', 'img'].includes(tag)) {
        opaque[key] = tag;
      }
    }

    // A label belongs in empty space, and empty space is usually not an
    // element: no selector names the gap beside a field, so `resolved` alone
    // leaves a chip nowhere measured to sit. `space` closes that gap with
    // candidate empty bands per resolved target, measured here, after the
    // same screenshot, with nothing page-changing in between: the
    // screenshot-then-measure adjacency that makes `resolved` trustworthy is
    // the same guarantee these numbers ride on.
    let space;
    if (wantSpace) {
      space = {};
      // Bands are confined to min(inner, client) per axis, not inner alone:
      // `annotate` only accepts coordinates inside the smaller of the two (a
      // classic scrollbar makes them differ), so a band reaching into the
      // scrollbar strip would hand back numbers annotate then refuses.
      const bounds = [
        Math.min(viewport.inner[0], viewport.client[0]),
        Math.min(viewport.inner[1], viewport.client[1]),
      ];
      // The same 6 px standoff the annotate skill pads every measured box
      // with, so a band never touches the content it labels.
      const PAD = 6;
      // A band never reaches further than this from its target. A chip is at
      // most ~44 px tall, so more reach adds no placement value and only
      // grows the area the occupancy scan below must prove clear.
      const REACH = 240;
      // Minimum useful sizes: a chip needs room, and a band too small to hold
      // one is a wrong answer with correct coordinates. Cross-axis caps bound
      // a band the same way REACH bounds the main axis: past a label's size,
      // extra area adds nothing and only invites a refusal.
      const SIDES = {
        above: { main: 28, cross: 120, crossCap: 360 },
        below: { main: 28, cross: 120, crossCap: 360 },
        left: { main: 90, cross: 28, crossCap: 120 },
        right: { main: 90, cross: 28, crossCap: 120 },
      };
      // The band's extent across the target: the padded target extent, widened
      // to the minimum useful size when the target is narrow (centred on the
      // target so the label stays visually attached to it) and capped when it
      // is wide, then clamped to the viewport. A null here refuses the side.
      const crossExtent = (lo, hi, centre, side) => {
        let start = lo;
        let size = hi - lo;
        if (size < side.cross) {
          start = centre - side.cross / 2;
          size = side.cross;
        } else if (size > side.crossCap) {
          start = centre - side.crossCap / 2;
          size = side.crossCap;
        }
        return [start, size];
      };
      const candidatesFor = (side, rect) => {
        const [tx, ty, tw, th] = rect;
        const spec = SIDES[side];
        const horizontal = side === 'left' || side === 'right';
        const crossLimit = horizontal ? bounds[1] : bounds[0];
        const raw = horizontal
          ? crossExtent(ty - PAD, ty + th + PAD, ty + th / 2, spec)
          : crossExtent(tx - PAD, tx + tw + PAD, tx + tw / 2, spec);
        const cross0 = Math.max(0, Math.round(raw[0]));
        const crossSize = Math.min(crossLimit, Math.round(raw[0] + raw[1])) - cross0;
        if (crossSize < spec.cross) return null;
        const nearEdge = side === 'above' ? ty - PAD
          : side === 'below' ? ty + th + PAD
            : side === 'left' ? tx - PAD
              : tx + tw + PAD;
        const avail = (side === 'above' || side === 'left')
          ? nearEdge
          : (horizontal ? bounds[0] : bounds[1]) - nearEdge;
        if (avail < spec.main) return null;
        // Shrink toward the target: the edge nearest the target stays fixed
        // and the far edge pulls in, because the empty space closest to the
        // target is the most useful place for its label. Stop once the next
        // step would be too small for a chip.
        const full = Math.min(avail, REACH);
        const candidates = [];
        for (const step of [full, full / 2, full / 4]) {
          const size = Math.round(step);
          if (size < spec.main) break;
          const box = side === 'above' ? [cross0, nearEdge - size, crossSize, size]
            : side === 'below' ? [cross0, nearEdge, crossSize, size]
              : side === 'left' ? [nearEdge - size, cross0, size, crossSize]
                : [nearEdge, cross0, size, crossSize];
          candidates.push({ box });
        }
        return candidates.length > 0 ? candidates : null;
      };
      // The whole call shares one element-scan cap so a pathological page (a
      // huge DOM under many candidate bands) stays cheap. A walk the cap cuts
      // short proves nothing about any band, so overflow refuses them all:
      // an unmeasured band must never be returned as an empty one.
      const plan = { scanCap: 5000, targets: [] };
      for (const key of Object.keys(resolved)) {
        const sides = [];
        for (const side of ['above', 'below', 'left', 'right']) {
          const candidates = candidatesFor(side, resolved[key]);
          if (candidates) sides.push({ side, candidates });
        }
        if (sides.length > 0) plan.targets.push({ key, sides });
      }
      if (plan.targets.length > 0) {
        const bands = await page.evaluate((input) => {
          // Operational rule for "empty", judged in-page because only the
          // page can see layout: a band is empty when no painted content's
          // GEOMETRY intersects it. An earlier version sampled
          // document.elementFromPoint on a grid instead, and every one of
          // its misses put a chip over content: hit-testing skips
          // pointer-events:none text entirely, returns a transparent child
          // while an ancestor paints a background image through it, never
          // reports what an iframe shows, and lets anything smaller than
          // the grid spacing sit between the points. So the rule walks the
          // document (open shadow roots included) and refuses any band
          // touched by: direct non-whitespace text, judged by its own line
          // rectangles because text overflows element boxes and an element
          // box would also over-refuse beside a short line in a wide
          // container; inherently visual or interactive elements (img, svg,
          // canvas, video, picture, iframe, frame, object, embed, input,
          // button, select, textarea, a, [role]), iframes wholesale because
          // this document cannot see inside them; a background image on ANY
          // element, with html and body refusing everything because their
          // backgrounds propagate to the canvas and paint the whole
          // viewport regardless of their own boxes; and pseudo-element
          // content. Invisible paint (visibility: hidden, opacity: 0) does
          // not occupy. What geometry cannot see -- closed shadow roots,
          // decoration painted only by borders, box shadows, or background
          // colours -- stays a limit the skill docs state instead of a
          // guarantee they overstate. Over-refusal is the safe direction:
          // a band wrongly refused costs a label its spot and the caller
          // has a fallback; a band wrongly returned puts a chip over
          // content, the confident wrongness this macro exists to avoid.
          const VISUAL = 'img,svg,canvas,video,picture,iframe,frame,object,embed,'
            + 'input,button,select,textarea,a,[role]';
          for (const element of [document.documentElement, document.body]) {
            if (element && getComputedStyle(element).backgroundImage !== 'none') return [];
          }
          const boxes = [];
          for (const target of input.targets) {
            for (const side of target.sides) {
              for (const candidate of side.candidates) {
                candidate.index = boxes.length;
                boxes.push(candidate.box);
              }
            }
          }
          const occupied = boxes.map(() => false);
          let remaining = boxes.length;
          const intersects = (rect, box) => (
            rect.left < box[0] + box[2] && rect.right > box[0]
            && rect.top < box[1] + box[3] && rect.bottom > box[1]
          );
          const hits = (rect) => {
            if (!(rect.width > 0 && rect.height > 0)) return false;
            for (const box of boxes) {
              if (intersects(rect, box)) return true;
            }
            return false;
          };
          const mark = (rect) => {
            for (let i = 0; i < occupied.length; i += 1) {
              if (!occupied[i] && intersects(rect, boxes[i])) {
                occupied[i] = true;
                remaining -= 1;
              }
            }
          };
          // A ::before or ::after paints inside the element's box but is not
          // a child node, so the text scan below never sees it, and its own
          // rectangle is unreadable from here; the element's box stands in
          // for it, which can only over-refuse. An empty-string content with
          // no background is the clearfix idiom and paints nothing.
          const pseudoPaints = (element) => {
            for (const which of ['::before', '::after']) {
              const pseudo = getComputedStyle(element, which);
              if (pseudo.content === 'none' || pseudo.content === 'normal') continue;
              if (pseudo.content !== '""' || pseudo.backgroundImage !== 'none') return true;
            }
            return false;
          };
          let scanned = 0;
          const stack = [document.documentElement];
          while (stack.length > 0 && remaining > 0) {
            scanned += 1;
            if (scanned > input.scanCap) return [];
            const element = stack.pop();
            if (element.shadowRoot) {
              for (const child of element.shadowRoot.children) stack.push(child);
            }
            for (const child of element.children) stack.push(child);
            // Style is read at most once per element, and only for elements
            // whose geometry actually reaches a band; on a big page most
            // never do, and skipping getComputedStyle for them is what
            // keeps the walk cheap.
            let style = null;
            const painted = () => {
              if (style === null) style = getComputedStyle(element);
              return style.visibility === 'visible' && style.opacity !== '0';
            };
            const rect = element.getBoundingClientRect();
            if (hits(rect) && painted()) {
              if (
                element.namespaceURI === 'http://www.w3.org/2000/svg'
                || element.matches(VISUAL)
                || style.backgroundImage !== 'none'
                || pseudoPaints(element)
              ) mark(rect);
            }
            // The shadow root is a text container in its own right: a bare
            // text node from root.textContent = '...' is a child of the
            // ShadowRoot, not of any element, so a scan that only reads
            // element.childNodes certifies bands as empty over exactly that
            // text. The host's paint state governs it, same as light DOM.
            const textContainers = element.shadowRoot
              ? [element, element.shadowRoot]
              : [element];
            for (const container of textContainers) {
              for (const node of container.childNodes) {
                if (node.nodeType !== 3 || !/\S/.test(node.nodeValue)) continue;
                const range = document.createRange();
                range.selectNodeContents(node);
                for (const lineRect of range.getClientRects()) {
                  if (hits(lineRect) && painted()) mark(lineRect);
                }
              }
            }
          }
          const found = [];
          for (const target of input.targets) {
            for (const side of target.sides) {
              for (const candidate of side.candidates) {
                if (!occupied[candidate.index]) {
                  // The first (largest) surviving candidate wins the side.
                  found.push({ key: target.key, side: side.side, box: candidate.box });
                  break;
                }
              }
            }
          }
          return found;
        }, plan);
        for (const target of plan.targets) {
          const won = [];
          for (const band of bands) {
            if (band.key === target.key) won.push({ side: band.side, box: band.box });
          }
          if (won.length > 0) space[target.key] = won;
        }
      }
    }

    // Playwright creates parent directories for a screenshot path, so the
    // screenshots directory does not need to exist beforehand.
    const result = {
      schemaVersion: 1, name, png, viewport, resolved, missed,
    };
    if (space) result.space = space;
    if (Object.keys(opaque).length > 0) result.opaque = opaque;
    return result;
  } catch (error) {
    return { failedStep: 'capture', error: String(error && error.message), url: page.url() };
  }
}
