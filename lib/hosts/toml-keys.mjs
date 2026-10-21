// A key scanner, not a TOML parser: it finds which key paths a document
// defines (table headers, dotted and quoted keys, keys of inline tables) and
// skips everything inside strings, comments and multi-line values, so text
// that only looks like a header never counts.

const BARE_KEY = /[A-Za-z0-9_-]/;
const SHORT_ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' };
const UNICODE_ESCAPE_LENGTH = { x: 2, u: 4, U: 8 };

function readBasicString(text, i) {
  let value = '';
  for (let j = i + 1; j < text.length; j += 1) {
    const char = text[j];
    if (char === '\\') {
      const kind = text[j + 1] ?? '';
      const length = UNICODE_ESCAPE_LENGTH[kind];
      const hex = length ? text.slice(j + 2, j + 2 + length) : '';
      if (length && /^[0-9A-Fa-f]+$/.test(hex) && hex.length === length) {
        value += String.fromCodePoint(Number.parseInt(hex, 16));
        j += 1 + length;
      } else {
        value += SHORT_ESCAPES[kind] ?? kind;
        j += 1;
      }
      continue;
    }
    if (char === '"') return { value, end: j + 1 };
    if (char === '\n') break;
    value += char;
  }
  return { value, end: text.length };
}

function readLiteralString(text, i) {
  const close = text.indexOf("'", i + 1);
  const end = close === -1 ? text.length : close;
  return { value: text.slice(i + 1, end), end: end + 1 };
}

function skipSpaces(text, i) {
  while (text[i] === ' ' || text[i] === '\t') i += 1;
  return i;
}

function readKeyPath(text, start) {
  const segments = [];
  let i = skipSpaces(text, start);
  while (i < text.length) {
    let segment;
    if (text[i] === '"') segment = readBasicString(text, i);
    else if (text[i] === "'") segment = readLiteralString(text, i);
    else {
      let j = i;
      while (j < text.length && BARE_KEY.test(text[j])) j += 1;
      if (j === i) return null;
      segment = { value: text.slice(i, j), end: j };
    }
    segments.push(segment.value);
    i = skipSpaces(text, segment.end);
    if (text[i] !== '.') return { segments, end: i };
    i = skipSpaces(text, i + 1);
  }
  return null;
}

function startsWith(path, prefix) {
  return prefix.every((segment, index) => path[index] === segment);
}

// Consumes one value from `i`, reporting each inline-table key path relative
// to `base` through `onKey`. Returns the index just past the value.
function skipValue(text, i, base, onKey) {
  const stack = [];
  while (i < text.length) {
    if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
      const quote = text.slice(i, i + 3);
      let close = text.indexOf(quote, i + 3);
      if (close === -1) return text.length;
      while (text[close + 3] === quote[0]) close += 1;
      i = close + 3;
      continue;
    }
    const char = text[i];
    if (char === '"') { i = readBasicString(text, i).end; continue; }
    if (char === "'") { i = readLiteralString(text, i).end; continue; }
    if (char === '#') {
      const eol = text.indexOf('\n', i);
      i = eol === -1 ? text.length : eol;
      continue;
    }
    if (char === '\n' && stack.length === 0) return i;
    if (char === '[') stack.push({ kind: 'array' });
    if (char === '{' || (char === ',' && stack.at(-1)?.kind === 'table')) {
      if (char === '{') stack.push({ kind: 'table', base: stack.at(-1)?.pending ?? base });
      const frame = stack.at(-1);
      const key = readKeyPath(text, i + 1);
      if (key && text[key.end] === '=') {
        const path = [...frame.base, ...key.segments];
        onKey(path);
        frame.pending = path;
        i = key.end + 1;
        continue;
      }
    }
    if ((char === ']' || char === '}') && stack.length > 0) stack.pop();
    i += 1;
  }
  return i;
}

export function tomlDefinesPath(text, target) {
  let table = [];
  let found = false;
  const onKey = (path) => { if (startsWith(path, target)) found = true; };
  let i = 0;
  while (i < text.length && !found) {
    i = skipSpaces(text, i);
    const char = text[i];
    if (char === '\n' || char === '\r') { i += 1; continue; }
    if (char === '#') {
      const eol = text.indexOf('\n', i);
      i = eol === -1 ? text.length : eol;
      continue;
    }
    if (char === '[') {
      const array = text[i + 1] === '[';
      const key = readKeyPath(text, i + (array ? 2 : 1));
      if (key) {
        table = key.segments;
        onKey(table);
      }
      i = skipValue(text, key ? key.end + (array ? 2 : 1) : i + 1, table, () => {});
      continue;
    }
    const key = readKeyPath(text, i);
    if (!key || text[key.end] !== '=') {
      i = skipValue(text, i, table, () => {});
      continue;
    }
    const path = [...table, ...key.segments];
    onKey(path);
    i = skipValue(text, key.end + 1, path, onKey);
  }
  return found;
}
