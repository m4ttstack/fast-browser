// Wording checks for a board spec. Plain script, no imports: page.mjs inlines
// this file's text ahead of page-layout.js, and the unit tests run it in a vm
// context.
(function () {
const SKIPPED = new Set(['the', 'and', 'for', 'with']);

function wordsOf(text) {
  const found = String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return found.filter((word) => word.length >= 3 && !SKIPPED.has(word));
}

function wordingWarnings(spec, captures) {
  const warnings = [];
  const titleWords = new Set(wordsOf(spec.title));
  const repeatsTitle = (text) => {
    const words = wordsOf(text);
    return words.length > 0 && words.filter((word) => titleWords.has(word)).length * 3 >= words.length * 2;
  };
  const marks = spec.panels.flatMap((panel) => panel.marks ?? []);
  if (marks.some((mark) => repeatsTitle(mark.title) || repeatsTitle(mark.note))) warnings.push("a label repeats the board's title");
  const namesOrigin = spec.panels.some((panel, index) => captures[index]?.source === 'import' && /ticket/i.test(panel.label ?? ''));
  if (namesOrigin) warnings.push('a panel label repeats where the image came from');
  return warnings;
}

globalThis.__composeWording = { wordingWarnings };
}());
