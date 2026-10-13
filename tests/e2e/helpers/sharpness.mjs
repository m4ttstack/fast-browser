// Compares a 2x capture with a 2x reference, and with the 1x image blown up
// without smoothing: a sharp capture is close to the reference while the
// blown-up image is not, so an upscaled capture cannot pass.
export async function comparePngs({ tool, reference, oneX, renderer }) {
  const { chromium } = await import(renderer.playwrightCore);
  const browser = await chromium.launch({ headless: true, executablePath: renderer.executablePath });
  try {
    const page = await browser.newPage();
    return await page.evaluate(async ({ tool, reference, oneX }) => {
      const load = async (base64) => { const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode(); return image; };
      const [a, b, c] = await Promise.all([load(tool), load(reference), load(oneX)]);
      if (a.width !== b.width || a.height !== b.height) return { sameSize: false, tool: [a.width, a.height], reference: [b.width, b.height] };
      const pixels = (image, width, height) => {
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext('2d');
        context.imageSmoothingEnabled = false;
        context.drawImage(image, 0, 0, width, height);
        return context.getImageData(0, 0, width, height).data;
      };
      const count = (left, right) => {
        let differing = 0;
        for (let i = 0; i < left.length; i += 4) {
          if (Math.abs(left[i] - right[i]) > 16 || Math.abs(left[i + 1] - right[i + 1]) > 16 || Math.abs(left[i + 2] - right[i + 2]) > 16) differing += 1;
        }
        return differing;
      };
      const ref = pixels(b, b.width, b.height);
      return { sameSize: true, differing: count(pixels(a, a.width, a.height), ref), upscaledDiffering: count(pixels(c, b.width, b.height), ref), total: b.width * b.height };
    }, { tool: tool.toString('base64'), reference: reference.toString('base64'), oneX: oneX.toString('base64') });
  } finally { await browser.close(); }
}
