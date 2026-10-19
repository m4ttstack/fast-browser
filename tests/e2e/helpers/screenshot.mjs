// Chromium answers a capture with this when its copy of the page's compositor surface comes back empty after the
// copy's own retries. On a loaded CI runner it does so now and then for a page that draws fine.
const SURFACE_COPY_REFUSED = 'Protocol error (Page.captureScreenshot): Unable to capture screenshot';

// page.screenshot, taken once more after a frame when Chromium refused it as above. Any other error, or a second
// refusal, throws: a page that does not draw still fails its test.
export async function screenshot(page, options = {}, { warn = console.warn } = {}) {
  try {
    return await page.screenshot(options);
  } catch (error) {
    if (!String(error?.message).includes(SURFACE_COPY_REFUSED)) throw error;
    warn(`fast-browser compose e2e: ${SURFACE_COPY_REFUSED} at ${page.url()}, retrying once`);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return page.screenshot(options);
  }
}
