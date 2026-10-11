async (page, args) => {
  // Only locator.count, locator.evaluate, locator.first().waitFor, page.evaluate, page.screenshot and
  // page.waitForTimeout: those are the calls proven safe over the extension
  // relay. Element handles stalled the relay in the spike, and a new CDP
  // session kills it, so neither may appear here.
  const { targets = {}, frame = 'auto', out = 'capture', home } = args || {};
  if (typeof home !== 'string' || home[0] !== '/' || home.split('/').includes('..')) {
    return { failedStep: 'args', error: "home must be the caller's absolute home directory path, with no .. segments" };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(out)) return { failedStep: 'args', error: 'out must be a simple file name' };
  const keys = Object.keys(targets);
  if (keys.length === 0) return { failedStep: 'args', error: 'targets is required' };

  // Tags left by an earlier call on this page would corrupt this one, so
  // clear them first and again on every exit, thrown errors included.
  const cleanup = () => page.evaluate(() => {
    document.querySelectorAll('[data-ev-key]').forEach((e) => e.removeAttribute('data-ev-key'));
    document.querySelectorAll('[data-ev-frame]').forEach((e) => e.removeAttribute('data-ev-frame'));
  });
  await cleanup();
  try {
    await page.locator(targets[keys[0]]).first().waitFor({ timeout: 5000 }).catch(() => {});
    const missed = [];
    const tagged = [];
    for (const key of keys) {
      const locator = page.locator(targets[key]);
      const count = await locator.count();
      if (count !== 1) { missed.push(count === 0 ? { key, reason: 'no-match' } : { key, reason: 'ambiguous', count }); continue; }
      await locator.evaluate((element, k) => element.setAttribute('data-ev-key', k), key, { timeout: 2000 });
      tagged.push(key);
    }
    if (tagged.length === 0) return { failedStep: 'resolve', missed };
    let frameSnap = 'card';
    if (frame !== 'auto') {
      const count = await page.locator(frame).count();
      if (count !== 1) return { failedStep: 'frame', error: 'the frame selector must match exactly one element' };
      await page.locator(frame).evaluate((element) => element.setAttribute('data-ev-frame', ''), undefined, { timeout: 2000 });
      const contains = await page.evaluate(() => {
        const f = document.querySelector('[data-ev-frame]').getBoundingClientRect();
        return [...document.querySelectorAll('[data-ev-key]')].every((e) => {
          const r = e.getBoundingClientRect();
          return r.left >= f.left - 1 && r.top >= f.top - 1 && r.right <= f.right + 1 && r.bottom <= f.bottom + 1;
        });
      });
      if (!contains) return { failedStep: 'frame', error: 'the frame selector does not contain every target' };
      frameSnap = 'selector';
    }

    const placed = await page.evaluate(() => {
      const elements = [...document.querySelectorAll('[data-ev-key]')];
      const union = () => {
        const rects = elements.map((e) => e.getBoundingClientRect());
        const x = Math.min(...rects.map((r) => r.left + scrollX)); const y = Math.min(...rects.map((r) => r.top + scrollY));
        return { x, y, w: Math.max(...rects.map((r) => r.right + scrollX)) - x, h: Math.max(...rects.map((r) => r.bottom + scrollY)) - y };
      };
      const u = union();
      if (u.w > innerWidth || u.h > innerHeight * 0.9) return { snap: 'too-large' };
      let chosen = document.querySelector('[data-ev-frame]');
      let snap = chosen ? 'selector' : 'card';
      if (!chosen) {
        const chain = (e) => { const list = []; for (let n = e; n; n = n.parentElement) list.push(n); return list; };
        const common = chain(elements[0]).find((n) => elements.every((e) => n.contains(e)));
        for (let n = common; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
          const s = getComputedStyle(n); const r = n.getBoundingClientRect();
          const edged = parseFloat(s.borderTopWidth) > 0 || parseFloat(s.borderBottomWidth) > 0 || s.boxShadow !== 'none'
            || (s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent');
          // A heading-only strip is not a card: require room for content
          // beyond the targets themselves.
          const roomy = r.height >= Math.max(64, u.h + 24) && r.width >= 120;
          if (edged && roomy && r.width <= innerWidth && r.height <= innerHeight * 0.9) { chosen = n; break; }
        }
        if (!chosen) snap = 'union';
      }
      if (chosen) { chosen.setAttribute('data-ev-frame', ''); chosen.scrollIntoView({ block: 'center', inline: 'nearest' }); }
      else elements[0].scrollIntoView({ block: 'center', inline: 'nearest' });
      return { snap };
    });
    if (placed.snap === 'too-large') {
      await page.evaluate(() => document.querySelectorAll('[data-ev-key]').forEach((e) => e.removeAttribute('data-ev-key')));
      return { failedStep: 'frame', frameSnap: 'too-large', error: 'the targets cannot share one viewport-sized frame' };
    }
    if (frameSnap !== 'selector') frameSnap = placed.snap;
    await page.waitForTimeout(350);

    const name = `${out}.png`;
    const png = `${home}/.fast-browser/screenshots/${name}`;
    // Screenshot first, then measure, with nothing page-changing in between.
    await page.screenshot({ path: png, scale: 'css' });
    const measured = await page.evaluate(() => {
      const rect = (e) => { const b = e.getBoundingClientRect(); return [b.x, b.y, b.width, b.height].map(Math.round); };
      const boxes = {};
      for (const e of document.querySelectorAll('[data-ev-key]')) boxes[e.getAttribute('data-ev-key')] = rect(e);
      const f = document.querySelector('[data-ev-frame]');
      let dark = false;
      for (let n = f ?? document.querySelector('[data-ev-key]'); n; n = n.parentElement) {
        const c = getComputedStyle(n).backgroundColor.match(/[\d.]+/g);
        if (c && (c.length < 4 || +c[3] > 0.5)) { dark = (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) < 110; break; }
      }
      const result = { boxes, frame: f ? rect(f) : null, dark, viewport: { w: document.documentElement.clientWidth, h: innerHeight } };
      document.querySelectorAll('[data-ev-key]').forEach((e) => e.removeAttribute('data-ev-key'));
      if (f) f.removeAttribute('data-ev-frame');
      return result;
    });
    const boxes = {};
    for (const [key, box] of Object.entries(measured.boxes)) {
      if (box[2] <= 0 || box[3] <= 0) { missed.push({ key, reason: 'not-visible' }); continue; }
      if (box[0] < 0 || box[0] + box[2] > measured.viewport.w || box[1] < 0 || box[1] + box[3] > measured.viewport.h) { missed.push({ key, reason: 'out-of-view' }); continue; }
      boxes[key] = box;
    }
    if (Object.keys(boxes).length === 0) return { failedStep: 'measure', missed };
    const values = Object.values(boxes);
    const base = measured.frame ?? (values.length ? [
      Math.min(...values.map((b) => b[0])), Math.min(...values.map((b) => b[1])),
      Math.max(...values.map((b) => b[0] + b[2])) - Math.min(...values.map((b) => b[0])),
      Math.max(...values.map((b) => b[1] + b[3])) - Math.min(...values.map((b) => b[1])),
    ] : [0, 0, measured.viewport.w, measured.viewport.h]);
    const pad = frameSnap === 'union' ? 24 : 12;
    const fx = Math.max(0, base[0] - pad); const fy = Math.max(0, base[1] - pad);
    const frameBox = [fx, fy,
      Math.min(measured.viewport.w, base[0] + base[2] + pad) - fx,
      Math.min(measured.viewport.h, base[1] + base[3] + pad) - fy];
    return {
      schemaVersion: 'capture-evidence/1', name, png, frame: frameBox, frameSnap,
      boxes, missed, dark: measured.dark, viewport: measured.viewport, scale: 1,
    };
  } finally {
    await cleanup().catch(() => {});
  }
}
