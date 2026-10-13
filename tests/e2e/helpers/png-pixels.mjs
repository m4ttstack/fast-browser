// Reads a PNG in the pinned renderer. `colour` is [r, g, b]: `near` counts the
// pixels within `distance` (summed per-channel difference) of it, and `at`
// returns the pixel at each [x, y] point.
export async function readPixels({ png, renderer, colour, distance = 48, points = [] }) {
  const { chromium } = await import(renderer.playwrightCore);
  const browser = await chromium.launch({ headless: true, executablePath: renderer.executablePath });
  try {
    const page = await browser.newPage();
    return await page.evaluate(async ({ png, colour, distance, points }) => {
      const img = new Image(); img.src = `data:image/png;base64,${png}`; await img.decode();
      const canvas = new OffscreenCanvas(img.width, img.height);
      const context = canvas.getContext('2d'); context.drawImage(img, 0, 0);
      const { data } = context.getImageData(0, 0, img.width, img.height);
      let near = 0;
      if (colour) {
        for (let i = 0; i < data.length; i += 4) {
          if (Math.abs(data[i] - colour[0]) + Math.abs(data[i + 1] - colour[1]) + Math.abs(data[i + 2] - colour[2]) <= distance) near += 1;
        }
      }
      const at = points.map(([x, y]) => { const i = (Math.round(y) * img.width + Math.round(x)) * 4; return [data[i], data[i + 1], data[i + 2]]; });
      return { near, at, size: [img.width, img.height] };
    }, { png: png.toString('base64'), colour, distance, points });
  } finally { await browser.close(); }
}
