async (page, args) => {
  const { targets = {}, out = 'capture', home } = args || {};
  const names = Object.keys(targets);
  if (names.length === 0) {
    return { failedStep: 'args', error: 'targets is required' };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(out)) {
    return { failedStep: 'args', error: 'out must be a simple file name' };
  }
  // This macro runs with no Node globals at all: no `process`, no `require`,
  // nothing that could read the caller's home directory. Only `page` and
  // this `args` object are in scope (confirmed by a live run: `typeof
  // process` inside the real sandbox is `undefined`). The caller -- the
  // agent driving `browser_run_code_unsafe`, which runs in a real Node
  // process and can read its own environment -- must supply `home` instead.
  // This check is also the macro's only defence, alongside the `out` regex
  // above, against writing outside the screenshots directory: the runtime
  // applies no path confinement of its own to code executed this way, so an
  // absolute path outside `~/.fast-browser` would write just as freely as
  // one inside it.
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
    }

    // Playwright creates parent directories for a screenshot path, so the
    // screenshots directory does not need to exist beforehand.
    return { schemaVersion: 1, name, png, viewport, resolved, missed };
  } catch (error) {
    return { failedStep: 'capture', error: String(error && error.message), url: page.url() };
  }
}
