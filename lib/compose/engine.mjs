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
    const board = await readFile(temp);
    const { width, height } = readPngSize(board);
    await rename(temp, outPath);
    // Cut from the page that drew the board, at the board's own device scale:
    // a downscaled view of the whole board is how a readable sliver survives.
    const crops = [];
    if (report.crops?.length) {
      // A fullPage clip is in document coordinates, which boundingBox() (viewport-relative) is not.
      const stage = await page.evaluate(() => {
        const box = document.getElementById('stage').getBoundingClientRect();
        return { x: box.left + window.scrollX, y: box.top + window.scrollY };
      });
      for (const { rect: [x, y, width, height] } of report.crops) {
        crops.push(await page.screenshot({ fullPage: true, omitBackground: true, clip: { x: stage.x + x, y: stage.y + y, width, height } }));
      }
    }
    return { report, pixels: { width, height }, board, crops };
  } finally {
    await rm(temp, { force: true });
    await browser.close();
  }
}

export const IMPORT_MAX_SIDE = 16000;
const TOO_LARGE = 'image exceeds the side limit';

export class ImageTooLargeError extends Error {
  constructor() { super('the image is larger than the side limit'); this.name = 'ImageTooLargeError'; }
}

// Decodes in the pinned headless shell and re-encodes from a canvas, so the
// PNG that joins a bundle carries none of the original file's metadata. A GIF
// yields its first frame.
export async function rasterizeImage({ bytes, mime, executablePath, playwrightCore, timeoutMs = 30_000 }) {
  if (typeof executablePath !== 'string' || executablePath.length === 0) {
    throw new Error('the compose renderer executable path is required');
  }
  let chromium;
  try { ({ chromium } = await import(playwrightCore)); } catch { throw new RuntimeUnavailableError(); }
  let browser;
  let expired = false;
  let timer;
  const work = (async () => {
    browser = await chromium.launch({ headless: true, executablePath });
    if (expired) { await browser.close(); return null; }
    const page = await browser.newPage();
    return page.evaluate(async ({ uri, limit, marker }) => {
      const image = new Image(); image.src = uri;
      await image.decode();
      if (image.naturalWidth > limit || image.naturalHeight > limit) throw new Error(marker);
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      canvas.getContext('2d').drawImage(image, 0, 0);
      return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
    }, { uri: `data:${mime};base64,${bytes.toString('base64')}`, limit: IMPORT_MAX_SIDE, marker: TOO_LARGE }).catch((error) => {
      throw String(error?.message).includes(TOO_LARGE) ? new ImageTooLargeError() : error;
    });
  })();
  // page.evaluate has no timeout of its own, and an image that never settles would hang the command.
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(Object.assign(new Error('the image did not decode in time'), { name: 'ImageDecodeTimeoutError' }));
    }, timeoutMs);
  });
  try {
    return Buffer.from(await Promise.race([work, deadline]), 'base64');
  } finally {
    clearTimeout(timer);
    work.catch(() => {});
    await browser?.close().catch(() => {});
  }
}
