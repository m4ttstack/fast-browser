export const REDACT_FILL = '#CBD5E1';

// JSON inside a <script> must not be able to close the tag.
function scriptSafe(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

const CSS = `
:root{--accent:#6E56CF;--ink:#1F1A3D;--muted:#5B5870}
*{box-sizing:border-box;margin:0}
body{background:transparent;font-family:Inter,sans-serif;-webkit-font-smoothing:antialiased}
#stage{display:inline-flex;flex-direction:column;gap:18px;padding:28px;border-radius:16px;
  background:linear-gradient(135deg,#EDE9FE 0%,#DBEAFE 55%,#E0F7F4 100%)}
.header{display:flex;gap:10px;align-items:center}
.state{padding:3px 9px;border-radius:999px;color:#fff;font-size:11px;font-weight:700;letter-spacing:.6px}
.title{font-size:15px;font-weight:600;color:var(--ink)}
.panels{display:flex;gap:24px;align-items:flex-start}
.panel{display:flex;flex-direction:column;gap:8px;flex:none}
.phead{display:flex;gap:8px;align-items:center;height:22px}
.origin{padding:2px 7px;border-radius:999px;background:#E0E7FF;color:#3730A3;font-size:10px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;white-space:nowrap}
.plabel{font-size:11px;font-weight:700;letter-spacing:.8px;color:var(--muted);white-space:nowrap}
.num{flex:none;width:22px;height:22px;border-radius:999px;background:var(--ink);color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700}
.arrow{flex:none;width:40px;height:40px;border-radius:999px;background:#fff;box-shadow:0 4px 12px rgba(30,27,75,.15);display:flex;align-items:center;justify-content:center;color:var(--accent);font-size:20px;font-weight:700}
.comp{position:relative}
.capture{position:absolute;left:0;top:0;border-radius:10px;overflow:hidden;box-shadow:0 10px 30px rgba(30,27,75,.18)}
.fill{position:absolute;inset:0;background-repeat:no-repeat}
.flat{position:absolute;background-repeat:no-repeat}
.wash{position:absolute;inset:0;background:rgba(255,255,255,.55)}
.wash.dark{background:rgba(11,9,32,.65)}
.slot{position:absolute;border-radius:8px;display:flex;align-items:center;justify-content:center}
.slot.empty{border:1.5px dashed #94A3B8;background:rgba(248,250,252,.7);font-style:italic;font-weight:500;font-size:13px;color:#64748B;white-space:nowrap}
.slot.empty.dark{border-color:#64748B;background:rgba(15,23,42,.55);color:#CBD5E1}
.slot.ghost{border:1.5px solid #FB7185;background:rgba(244,63,94,.12)}
.slot.ghost.dark{background:rgba(244,63,94,.22)}
.patch{position:absolute;border-radius:999px;background-repeat:no-repeat}
.ring{position:absolute;border:2px solid var(--accent);border-radius:999px}
.lens{position:absolute;border-radius:999px;overflow:hidden;background:#F1F5F9;box-shadow:0 0 0 4px #fff,0 12px 28px rgba(30,27,75,.35)}
.lens.dark{background:#0F172A;box-shadow:0 0 0 4px #4B4670,0 12px 28px rgba(0,0,0,.5)}
.lensview{position:absolute;background-repeat:no-repeat}
.ztag{position:absolute;padding:2px 6px;border-radius:999px;background:var(--ink);color:#fff;font-size:10px;font-weight:700}
.lift{position:absolute;border-radius:7px;background-repeat:no-repeat;box-shadow:0 0 0 3px #fff,0 12px 28px rgba(30,27,75,.30)}
.lift.dark{box-shadow:0 0 0 3px #4B4670,0 12px 28px rgba(0,0,0,.5)}
.label{position:absolute;display:flex;flex-direction:column;gap:3px;width:max-content;max-width:240px}
.lrow{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.ltitle{font-size:13px;font-weight:600;color:var(--ink)}
.lnote{font-size:12px;color:var(--muted);line-height:1.4;max-width:200px;overflow-wrap:anywhere}
.tag{padding:2px 7px;border-radius:999px;font-size:10px;font-weight:700;letter-spacing:.6px;background:#E2E8F0;color:#475569}
.tag.NEW,.tag.OK{background:#DCFCE7;color:#15803D}.tag.CHANGED{background:#FEF3C7;color:#B45309}
.tag.REMOVED{background:#FFE4E6;color:#BE123C}.tag.ISSUE{background:#FEE2E2;color:#B91C1C}
svg.ov{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}
`;

export function buildBoardHtml({ spec, captures, fontBytes, geometrySource, layoutSource }) {
  const data = {
    spec,
    redactFill: REDACT_FILL,
    captures: captures.map((c) => ({
      uri: `data:image/png;base64,${c.png.toString('base64')}`,
      size: c.size, scale: c.scale ?? 1, frame: c.frame, boxes: c.boxes, dark: c.dark, source: c.source === 'import' ? 'import' : 'live',
    })),
  };
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Inter;src:url(data:font/woff2;base64,${fontBytes.toString('base64')}) format('woff2');font-weight:100 900;font-display:block}
${CSS}</style></head><body><div id="stage"></div>
<script>window.__composeData = ${scriptSafe(data)};</script>
<script>${geometrySource}</script>
<script>${layoutSource}</script>
</body></html>`;
}
