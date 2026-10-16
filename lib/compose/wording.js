// Wording checks for a board spec. Plain script, no imports: page.mjs inlines
// this file's text ahead of page-layout.js, and the unit tests run it in a vm
// context.
(function () {
const SKIPPED = new Set(['the', 'and', 'for', 'with']);

function wordsOf(text) {
  const found = String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return found.filter((word) => word.length >= 3 && !SKIPPED.has(word));
}

const ARTICLES = new Set(['a', 'an', 'the']);
const COPY_WORDS = 4;

function sentenceOf(text) {
  const found = String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return found.filter((word) => !ARTICLES.has(word)).join(' ');
}

function runsIn(words, within) {
  let at = 0;
  for (const word of within) if (word === words[at]) at += 1;
  return at === words.length;
}

// A callout may name the record or fact the title names, so sharing its words is not a repeat; copying the title
// is: every clause of the title, in any order and with words around it, the title's counted words alone, or a run
// of COPY_WORDS counted words in the title's order.
function wordingWarnings(spec, captures) {
  const warnings = [];
  const titleWords = wordsOf(spec.title);
  const clauses = String(spec.title ?? '').split(/[;:,.!?]+/).map(sentenceOf).filter(Boolean);
  const repeatsTitle = (text) => {
    const sentence = sentenceOf(text);
    if (!sentence) return false;
    if (clauses.length && clauses.every((clause) => ` ${sentence} `.includes(` ${clause} `))) return true;
    const words = wordsOf(text);
    if (words.length && words.join(' ') === titleWords.join(' ')) return true;
    return words.length >= COPY_WORDS && runsIn(words, titleWords);
  };
  const marks = spec.panels.flatMap((panel) => panel.marks ?? []);
  if (marks.some((mark) => repeatsTitle(mark.title) || repeatsTitle(mark.note))) warnings.push("a label repeats the board's title");
  const namesOrigin = spec.panels.some((panel, index) => captures[index]?.source === 'import' && /ticket/i.test(panel.label ?? ''));
  if (namesOrigin) warnings.push('a panel label repeats where the image came from');
  return warnings;
}

globalThis.__composeWording = { wordingWarnings };
}());
