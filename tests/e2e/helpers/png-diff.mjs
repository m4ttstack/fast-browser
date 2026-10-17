// Counts pixels in rect (PNG pixels) farther than tolerance from color [r, g, b];
// a null color means the rect's own first pixel. With `exact`, counts instead
// the pixels tinted toward color, `matching`: a resampled edge row blends into
// its neighbours, so a bled-in line is a pale tint, never the colour itself.
export async function countOffColor({ png, rect, color, tolerance = 24, renderer, exact = false }) {
  const { chromium } = await import(renderer.playwrightCore);
  const browser = await chromium.launch({ headless: true, executablePath: renderer.executablePath });
  try {
    const page = await browser.newPage();
    return await page.evaluate(async ({ png, rect, color, tolerance, exact }) => {
      const img = new Image(); img.src = `data:image/png;base64,${png}`; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0);
      const [rx, ry, rw, rh] = rect;
      const d = x.getImageData(rx, ry, rw, rh).data; let off = 0;
      if (!color) color = [d[0], d[1], d[2]];
      if (exact) {
        const chroma = ([r, g, b]) => { const m = (r + g + b) / 3; return [r - m, g - m, b - m]; };
        const u = chroma(color); const un = Math.hypot(...u);
        let matching = 0;
        for (let i = 0; i < d.length; i += 4) {
          const v = chroma([d[i], d[i + 1], d[i + 2]]); const vn = Math.hypot(...v);
          const along = (v[0] * u[0] + v[1] * u[1] + v[2] * u[2]) / un;
          if (along >= 10 && along / vn >= 0.9) matching += 1;
        }
        return { matching, total: d.length / 4 };
      }
      for (let i = 0; i < d.length; i += 4) {
        if (Math.abs(d[i] - color[0]) + Math.abs(d[i + 1] - color[1]) + Math.abs(d[i + 2] - color[2]) > tolerance) off += 1;
      }
      return { off, total: d.length / 4 };
    }, { png: png.toString('base64'), rect, color, tolerance, exact });
  } finally { await browser.close(); }
}

export async function diffPngs({ a, b, renderer, tolerance = 24 }) {
  const { chromium } = await import(renderer.playwrightCore);
  const browser = await chromium.launch({ headless: true, executablePath: renderer.executablePath });
  try {
    const page = await browser.newPage();
    return await page.evaluate(async ({ a, b, tolerance }) => {
      const load = async (s) => { const i = new Image(); i.src = `data:image/png;base64,${s}`; await i.decode(); return i; };
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      if (ia.width !== ib.width || ia.height !== ib.height) return { sameSize: false, differing: -1, total: 0 };
      const read = (img) => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const x = c.getContext('2d'); x.drawImage(img, 0, 0); return x.getImageData(0, 0, c.width, c.height).data; };
      const da = read(ia); const db = read(ib); let differing = 0;
      for (let i = 0; i < da.length; i += 4) {
        if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > tolerance) differing += 1;
      }
      return { sameSize: true, differing, total: da.length / 4 };
    }, { a: a.toString('base64'), b: b.toString('base64'), tolerance });
  } finally { await browser.close(); }
}
