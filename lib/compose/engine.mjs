import crypto from 'node:crypto';
import { readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { readPngSize } from '../annotate/png.mjs';

export class RuntimeUnavailableError extends Error {
  constructor() { super('the runtime playwright-core could not be loaded'); this.name = 'RuntimeUnavailableError'; }
}

export function playwrightCorePath(paths, lock) {
  return path.join(paths.runtimeDir, lock.productVersion, 'fast-browser-mcp', 'playwright-core', 'index.mjs');
}

// Launches only the pinned headless shell (never the user's Chrome) and
// writes through a unique temp file so two composes of one `out` can never
// leave a half-written board.
export async function renderBoard({ html, outPath, executablePath, playwrightCore, timeoutMs = 30_000 }) {
  // Without a path Playwright would look up a browser of its own choosing.
  if (typeof executablePath !== 'string' || executablePath.length === 0) {
    throw new Error('the compose renderer executable path is required');
  }
  let chromium;
  try { ({ chromium } = await import(playwrightCore)); } catch { throw new RuntimeUnavailableError(); }
  const browser = await chromium.launch({ headless: true, executablePath, timeout: timeoutMs });
  const temp = path.join(path.dirname(outPath), `.${path.basename(outPath)}.${crypto.randomUUID()}.tmp.png`);
  try {
    const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 2400, height: 1600 } });
    page.setDefaultTimeout(timeoutMs);
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error?.message ?? error)));
    await page.setContent(html, { waitUntil: 'load' });
    const report = await page.evaluate(() => window.__composeLayout());
    if (errors.length) throw new Error('the board page reported an error');
    await page.locator('#stage').screenshot({ path: temp, omitBackground: true });
    const { width, height } = readPngSize(await readFile(temp));
    await rename(temp, outPath);
    return { report, pixels: { width, height } };
  } finally {
    await rm(temp, { force: true });
    await browser.close();
  }
}
