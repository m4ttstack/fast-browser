import { isReservedName } from './redactions.mjs';

export const STATES = Object.freeze(['AFTER', 'BEFORE → AFTER', 'FLOW', 'FOUND']);
export const TAGS = Object.freeze(['NEW', 'CHANGED', 'REMOVED', 'ISSUE', 'PENDING', 'OK']);

// keys: how many keys the mark names. words: whether it takes title, note and tag.
const RULES = Object.freeze({
  lift: { keys: 'many', words: true },
  redact: { keys: 'many', words: false },
  empty: { keys: 'one', words: true, text: true },
  ghost: { keys: 'one', words: true },
  bracket: { keys: 'many', words: true, title: 'required' },
  loupe: { keys: 'one', words: true, zoom: true },
  context: { keys: 'many', words: false },
  link: { keys: 'two', words: true, title: 'required' },
});
export const MARK_KINDS = Object.freeze(Object.keys(RULES));

// Panels a layout takes, as [fewest, most].
export const LAYOUTS = Object.freeze({ single: [1, 1], pair: [2, 2], steps: [2, 4] });
const COUNT = Object.freeze({
  single: 'a single layout takes exactly one panel',
  pair: 'a pair layout takes exactly two panels',
  steps: 'a steps layout takes two to four panels',
});

export function markKind(mark) {
  if (!mark || typeof mark !== 'object') return null;
  const kinds = MARK_KINDS.filter((kind) => kind in mark);
  return kinds.length === 1 ? kinds[0] : null;
}

export function markKeys(mark) {
  const kind = markKind(mark);
  if (!kind) return [];
  const value = mark[kind];
  return (Array.isArray(value) ? value : [value]).filter((key) => typeof key === 'string');
}

const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;

export function validateSpec(spec, capturesByPanel) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return ['the spec must be a JSON object'];
  const problems = [];
  if (!STATES.includes(spec.state)) problems.push(`state must be one of ${STATES.join(', ')}`);
  if (!nonEmpty(spec.title)) problems.push('title is required');
  const layout = spec.layout ?? 'single';
  const layoutOk = typeof layout === 'string' && Object.hasOwn(LAYOUTS, layout);
  if (!layoutOk) problems.push(`layout must be one of ${Object.keys(LAYOUTS).join(', ')}`);
  if (!nonEmpty(spec.out)) problems.push('out is required');
  else if (isReservedName(spec.out)) problems.push('out must not be named like a redaction crop or record');
  else if (!spec.out.endsWith('.png')) problems.push('out must end in .png');
  const panels = Array.isArray(spec.panels) ? spec.panels : [];
  if (layoutOk && (panels.length < LAYOUTS[layout][0] || panels.length > LAYOUTS[layout][1])) problems.push(COUNT[layout]);
  panels.forEach((panel, p) => {
    if (panel?.label !== undefined && !(nonEmpty(panel.label) && panel.label.length <= 48)) problems.push(`panels[${p}].label must be text of at most 48 characters`);
    else if (layout === 'pair' && panel?.label === undefined) problems.push(`panels[${p}].label is required in a pair layout`);
    if (panel?.tag !== undefined && !TAGS.includes(panel.tag)) problems.push(`panels[${p}].tag must be one of ${TAGS.join(', ')}`);
    if (panel?.note !== undefined && !(nonEmpty(panel.note) && panel.note.length <= 120)) problems.push(`panels[${p}].note must be text of at most 120 characters`);
    if (!nonEmpty(panel?.capture)) problems.push(`panels[${p}].capture is required`);
    const capture = capturesByPanel[p];
    const importedPanel = capture?.source === 'import';
    let measured = new Set(Object.keys(capture?.boxes ?? {}));
    if (importedPanel) {
      const isBox = (b) => Array.isArray(b) && b.length === 4 && b.every((n) => Number.isFinite(n)) && b[2] > 0 && b[3] > 0;
      const within = (b, o) => b[0] >= o[0] && b[1] >= o[1] && b[0] + b[2] <= o[0] + o[2] && b[1] + b[3] <= o[1] + o[3];
      const frameOk = isBox(panel?.frame) && within(panel.frame, [0, 0, capture.size[0], capture.size[1]]);
      if (panel?.frame === undefined) problems.push(`panels[${p}].frame is required for an imported panel`);
      else if (!frameOk) problems.push(`panels[${p}].frame must be four numbers inside the image`);
      const boxes = panel?.boxes === undefined ? {} : panel.boxes;
      const boxesOk = boxes !== null && typeof boxes === 'object' && !Array.isArray(boxes) && Object.values(boxes).every(isBox);
      if (!boxesOk) problems.push(`panels[${p}].boxes must map keys to boxes of four numbers`);
      else if (frameOk && !Object.values(boxes).every((b) => within(b, panel.frame))) problems.push(`panels[${p}].boxes has a box outside the frame`);
      measured = new Set(boxesOk ? Object.keys(boxes) : []);
    } else if (panel?.frame !== undefined || panel?.boxes !== undefined) {
      problems.push(`panels[${p}].frame and panels[${p}].boxes are only for an imported panel`);
    }
    const missed = new Set((capture?.missed ?? []).map((entry) => entry.key));
    if (panel?.marks !== undefined && !Array.isArray(panel.marks)) {
      problems.push(`panels[${p}].marks must be a list`);
      return;
    }
    (panel?.marks ?? []).forEach((mark, m) => {
      const at = `panels[${p}].marks[${m}]`;
      const kind = markKind(mark);
      if (!kind) { problems.push(`${at} is not a supported mark in this version`); return; }
      const rule = RULES[kind];
      const named = Array.isArray(mark[kind]) ? mark[kind] : [mark[kind]];
      // markKeys drops non-text keys, so the page would silently skip one
      // the validator never saw; refuse it here instead.
      if (named.some((key) => typeof key !== 'string')) { problems.push(`${at} names a key that is not text`); return; }
      if (rule.keys === 'one' && (Array.isArray(mark[kind]) || named.length !== 1)) { problems.push(`${at} takes exactly one key`); return; }
      if (rule.keys === 'two' && (named.length !== 2 || named[0] === named[1])) { problems.push(`${at} takes exactly two different keys`); return; }
      const keys = markKeys(mark);
      if (kind === 'redact' && keys.some((key) => missed.has(key))) {
        problems.push(`${at} redacts a key the capture missed; fix the selector and recapture`);
        return;
      }
      if (keys.length === 0 || keys.some((key) => !measured.has(key))) {
        problems.push(`${at} names a key ${importedPanel ? "that is not in the panel's boxes" : 'the capture did not measure'}`);
      }
      if (kind === 'context' && ['title', 'note', 'tag'].some((field) => field in mark)) problems.push(`${at}: a context mark takes no words`);
      if (rule.words) {
        if (mark.tag !== undefined && !TAGS.includes(mark.tag)) problems.push(`${at}.tag must be one of ${TAGS.join(', ')}`);
        if (rule.title === 'required' && mark.title === undefined) problems.push(`${at}.title is required`);
        if (mark.title !== undefined && !nonEmpty(mark.title)) problems.push(`${at}.title must not be empty`);
        if (mark.note !== undefined && !nonEmpty(mark.note)) problems.push(`${at}.note must be text`);
      }
      if (rule.text && mark.text !== undefined && !(nonEmpty(mark.text) && mark.text.length <= 80)) {
        problems.push(`${at}.text must be text of at most 80 characters`);
      }
      if (rule.zoom && mark.zoom !== undefined && !(Number.isFinite(mark.zoom) && mark.zoom >= 2 && mark.zoom <= 8)) {
        problems.push(`${at}.zoom must be a number from 2 to 8`);
      }
    });
  });
  return problems;
}
