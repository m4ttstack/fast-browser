export const STATES = Object.freeze(['AFTER', 'BEFORE → AFTER', 'FLOW', 'FOUND']);
export const TAGS = Object.freeze(['NEW', 'CHANGED', 'REMOVED', 'ISSUE', 'PENDING', 'OK']);
export const MARK_KINDS_M1 = Object.freeze(['lift', 'redact']);

export function markKind(mark) {
  if (!mark || typeof mark !== 'object') return null;
  const kinds = MARK_KINDS_M1.filter((kind) => kind in mark);
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
  if ((spec.layout ?? 'single') !== 'single') problems.push('layout must be single in this version');
  if (!nonEmpty(spec.out)) problems.push('out is required');
  else if (!spec.out.endsWith('.png')) problems.push('out must end in .png');
  const panels = Array.isArray(spec.panels) ? spec.panels : [];
  if (panels.length !== 1) problems.push('panels must list exactly one panel in this version');
  panels.forEach((panel, p) => {
    if (!nonEmpty(panel?.capture)) problems.push(`panels[${p}].capture is required`);
    const capture = capturesByPanel[p];
    const measured = new Set(Object.keys(capture?.boxes ?? {}));
    const missed = new Set((capture?.missed ?? []).map((entry) => entry.key));
    if (panel?.marks !== undefined && !Array.isArray(panel.marks)) {
      problems.push(`panels[${p}].marks must be a list`);
      return;
    }
    (panel?.marks ?? []).forEach((mark, m) => {
      const at = `panels[${p}].marks[${m}]`;
      const kind = markKind(mark);
      if (!kind) { problems.push(`${at} is not a supported mark in this version`); return; }
      // markKeys drops non-text keys, so the page would silently skip one
      // the validator never saw; refuse it here instead.
      const named = Array.isArray(mark[kind]) ? mark[kind] : [mark[kind]];
      if (named.some((key) => typeof key !== 'string')) { problems.push(`${at} names a key that is not text`); return; }
      const keys = markKeys(mark);
      if (kind === 'redact' && keys.some((key) => missed.has(key))) {
        problems.push(`${at} redacts a key the capture missed; fix the selector and recapture`);
        return;
      }
      if (keys.length === 0 || keys.some((key) => !measured.has(key))) {
        problems.push(`${at} names a key the capture did not measure`);
      }
      if (kind === 'lift') {
        if (mark.tag !== undefined && !TAGS.includes(mark.tag)) problems.push(`${at}.tag must be one of ${TAGS.join(', ')}`);
        if (mark.title !== undefined && !nonEmpty(mark.title)) problems.push(`${at}.title must not be empty`);
      }
    });
  });
  return problems;
}
