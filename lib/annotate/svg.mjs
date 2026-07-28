import { LifecycleError } from '../commands/shared.mjs';
import { resolvePalette } from './palette.mjs';

export const ANNOTATION_TYPES = Object.freeze([
  'arrow', 'chip', 'highlight', 'box', 'ellipse', 'counter', 'blur', 'spotlight',
]);

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function esc(value) {
  return String(value).replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

function invalid(field) {
  return new LifecycleError(`invalid annotation geometry: ${field}`, {
    stage: 'validate',
    exitCode: 2,
  });
}

function num(value, field, { min = -1e6, max = 1e6 } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw invalid(field);
  }
  return value;
}

function boxOf(annotation) {
  const box = annotation.box;
  if (!Array.isArray(box) || box.length !== 4) throw invalid('box');
  const [x, y] = [num(box[0], 'box.x'), num(box[1], 'box.y')];
  const w = num(box[2], 'box.width', { min: 0 });
  const h = num(box[3], 'box.height', { min: 0 });
  return { x, y, w, h };
}

function point(value, field) {
  if (!Array.isArray(value) || value.length !== 2) throw invalid(field);
  return [num(value[0], `${field}.x`), num(value[1], `${field}.y`)];
}

const DRAW = {
  arrow(a, ctx) {
    const [x1, y1] = point(a.tail, 'tail');
    const [x2, y2] = point(a.head, 'head');
    const bow = a.bow === undefined ? 0.18 : num(a.bow, 'bow', { min: -2, max: 2 });
    const width = a.width === undefined ? 5 : num(a.width, 'width', { min: 0.5, max: 40 });
    const dx = x2 - x1;
    const dy = y2 - y1;
    const cx = (x1 + x2) / 2 - dy * bow;
    const cy = (y1 + y2) / 2 + dx * bow;
    return `<path d="M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}" fill="none" `
      + `stroke="${ctx.accent}" stroke-width="${width}" stroke-linecap="round" `
      + 'marker-end="url(#head)" filter="url(#sh)"/>';
  },
  chip(a, ctx) {
    const [x, y] = point(a.xy, 'xy');
    if (typeof a.text !== 'string' || a.text.length === 0 || a.text.length > 200) {
      throw invalid('chip.text');
    }
    const size = a.size === undefined ? 22 : num(a.size, 'size', { min: 6, max: 96 });
    const padx = size * 0.7;
    const pady = size * 0.5;
    // [...a.text] counts code points, so astral characters (emoji) are not
    // double-counted the way a UTF-16 .length would count them.
    const w = a.w === undefined
      ? [...a.text].length * size * 0.58 + padx * 2
      : num(a.w, 'chip.w', { min: 1 });
    const h = size + pady * 2;
    return `<g filter="url(#sh)">`
      + `<rect x="${x}" y="${y}" width="${w.toFixed(0)}" height="${h.toFixed(0)}" `
      + `rx="${(h / 2.2).toFixed(0)}" fill="${ctx.soft}" stroke="${ctx.accent}" stroke-width="1.5"/>`
      + `<text x="${(x + w / 2).toFixed(0)}" y="${(y + h / 2).toFixed(0)}" fill="${ctx.ink}" `
      + 'font-family="-apple-system, Helvetica, Arial, sans-serif" '
      + `font-size="${size}" font-weight="700" text-anchor="middle" `
      + `dominant-baseline="central">${esc(a.text)}</text></g>`;
  },
  highlight(a, ctx) {
    const { x, y, w, h } = boxOf(a);
    // accent at low opacity, NOT soft: Radix step 3 is near-white and would be
    // invisible at 14% over a light UI.
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" `
      + `fill="${ctx.accent}" fill-opacity="0.14" stroke="${ctx.accent}" stroke-width="2.5"/>`;
  },
  box(a, ctx) {
    const { x, y, w, h } = boxOf(a);
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="none" `
      + `stroke="${ctx.accent}" stroke-width="3" filter="url(#sh)"/>`;
  },
  ellipse(a, ctx) {
    const cx = num(a.cx, 'cx');
    const cy = num(a.cy, 'cy');
    const rx = num(a.rx, 'rx', { min: 0 });
    const ry = a.ry === undefined ? rx : num(a.ry, 'ry', { min: 0 });
    // Zero is refused, not just negatives. A zero radius encloses no pixels,
    // which is the same silent no-op assertInBounds (lib/commands/annotate.mjs)
    // already refuses for a zero-area box: annotate either rejects geometry
    // that draws nothing or it does not, and half the rule is no rule.
    if (rx <= 0) throw invalid('rx');
    if (ry <= 0) throw invalid('ry');
    return `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" `
      + `stroke="${ctx.accent}" stroke-width="3" filter="url(#sh)"/>`;
  },
  counter(a, ctx) {
    const [x, y] = point(a.xy, 'xy');
    if (!Number.isInteger(a.n) || a.n < 0 || a.n > 999) throw invalid('counter.n');
    const size = a.size === undefined ? 18 : num(a.size, 'size', { min: 6, max: 96 });
    const r = size * 0.9;
    return `<g filter="url(#sh)"><circle cx="${x}" cy="${y}" r="${r.toFixed(0)}" `
      + `fill="${ctx.accent}"/>`
      + `<text x="${x}" y="${y}" fill="white" font-size="${size}" font-weight="700" `
      + 'font-family="-apple-system, Helvetica, Arial, sans-serif" '
      + `text-anchor="middle" dominant-baseline="central">${a.n}</text></g>`;
  },
  blur(a, ctx) {
    const { x, y, w, h } = boxOf(a);
    const amount = a.amount === undefined ? 8 : num(a.amount, 'amount', { min: 0.5, max: 100 });
    const i = ctx.nextId();
    return `<clipPath id="clip${i}"><rect x="${x}" y="${y}" width="${w}" height="${h}"/></clipPath>`
      + `<filter id="blur${i}" x="-20%" y="-20%" width="140%" height="140%">`
      + `<feGaussianBlur stdDeviation="${amount}"/></filter>`
      + `<g clip-path="url(#clip${i})"><image href="${ctx.uri}" x="0" y="0" `
      + `width="${ctx.width}" height="${ctx.height}" filter="url(#blur${i})"/></g>`;
  },
  spotlight(a, ctx) {
    const { x, y, w, h } = boxOf(a);
    const dim = a.dim === undefined ? 0.55 : num(a.dim, 'dim', { min: 0, max: 1 });
    const i = ctx.nextId();
    return `<mask id="spot${i}"><rect x="0" y="0" width="${ctx.width}" height="${ctx.height}" `
      + `fill="white"/><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="black"/>`
      + `</mask><rect x="0" y="0" width="${ctx.width}" height="${ctx.height}" fill="black" `
      + `fill-opacity="${dim}" mask="url(#spot${i})"/>`;
  },
};

export function buildSvg({ base, width, height, annotations, palette, scale = 2 }) {
  if (!Array.isArray(annotations)) throw invalid('annotations');
  const colours = resolvePalette(palette);
  const uri = `data:image/png;base64,${base.toString('base64')}`;
  let counter = 0;
  // One shared counter across blur and spotlight, matching the source. Two
  // per-type counters would let a blur and a spotlight both claim index 1 and
  // collide on the generated element ids.
  const ctx = { ...colours, uri, width, height, nextId: () => { counter += 1; return counter; } };

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width * scale}" `
    + `height="${height * scale}" viewBox="0 0 ${width} ${height}">`,
    '<defs><marker id="head" viewBox="0 0 10 10" refX="7" refY="5" '
    + 'markerWidth="5.5" markerHeight="5.5" orient="auto-start-reverse">'
    + `<path d="M 0 0 L 10 5 L 0 10 z" fill="${colours.accent}"/></marker>`
    + '<filter id="sh" x="-30%" y="-30%" width="160%" height="160%">'
    + '<feDropShadow dx="0" dy="2" stdDeviation="3" flood-opacity="0.35"/>'
    + '</filter></defs>',
    `<image href="${uri}" x="0" y="0" width="${width}" height="${height}"/>`,
  ];
  for (const annotation of annotations) {
    const draw = Object.hasOwn(DRAW, annotation?.type ?? '') ? DRAW[annotation.type] : null;
    if (!draw) {
      throw new LifecycleError('unsupported annotation type', {
        stage: 'validate',
        exitCode: 2,
      });
    }
    parts.push(draw(annotation, ctx));
  }
  parts.push('</svg>');
  return parts.join('');
}
