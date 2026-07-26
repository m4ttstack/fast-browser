const MARKER_RE =
  /<!-- fast-browser:(start|end) ([A-Za-z0-9][A-Za-z0-9._-]*) -->/g;
const MARKER_PREFIX_RE = /<!-- fast-browser:(?:start|end)\b/g;

function assertId(id) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error('invalid Fast Browser managed block id');
  }
}

function parseBlocks(text) {
  const markers = [...text.matchAll(MARKER_RE)];
  const exactStarts = new Set(markers.map((marker) => marker.index));
  for (const marker of text.matchAll(MARKER_PREFIX_RE)) {
    if (!exactStarts.has(marker.index)) {
      throw new Error('malformed Fast Browser managed marker');
    }
  }

  const blocks = new Map();
  let active = null;
  for (const marker of markers) {
    const [value, kind, id] = marker;
    const before = marker.index === 0 ? '' : text[marker.index - 1];
    const afterIndex = marker.index + value.length;
    const after = text[afterIndex] ?? '';
    if (
      (before !== '' && before !== '\n')
      || (after !== '' && after !== '\n' && after !== '\r')
      || (after === '\r' && text[afterIndex + 1] !== '\n')
    ) {
      throw new Error('malformed Fast Browser managed marker');
    }

    if (kind === 'start') {
      if (active) {
        throw new Error('overlapping Fast Browser managed blocks');
      }
      if (blocks.has(id)) {
        throw new Error(`duplicate Fast Browser managed block: ${id}`);
      }
      active = {
        id,
        start: marker.index,
        contentStart: afterIndex,
      };
      continue;
    }

    if (!active) {
      throw new Error('malformed Fast Browser managed markers');
    }
    if (active.id !== id) {
      throw new Error('overlapping Fast Browser managed blocks');
    }
    blocks.set(id, {
      ...active,
      end: afterIndex,
      contentEnd: marker.index,
    });
    active = null;
  }
  if (active) {
    throw new Error('malformed Fast Browser managed markers');
  }
  return blocks;
}

function newlineFor(text, block) {
  if (block) {
    const afterStart = text.slice(block.contentStart, block.contentStart + 2);
    if (afterStart === '\r\n') return '\r\n';
    if (afterStart.startsWith('\n')) return '\n';
  }
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function renderBlock(id, body, newline) {
  const normalizedBody = body
    .replace(/\r\n|\r|\n/g, newline)
    .replace(new RegExp(`${newline.replace('\r', '\\r').replace('\n', '\\n')}$`), '');
  return [
    `<!-- fast-browser:start ${id} -->`,
    normalizedBody,
    `<!-- fast-browser:end ${id} -->`,
  ].join(newline);
}

export function upsertManagedBlock(text, { id, body }) {
  if (typeof text !== 'string' || typeof body !== 'string') {
    throw new TypeError('managed block text and body must be strings');
  }
  assertId(id);
  const blocks = parseBlocks(text);
  const existing = blocks.get(id);
  const newline = newlineFor(text, existing);
  const rendered = renderBlock(id, body, newline);

  if (existing) {
    return text.slice(0, existing.start) + rendered + text.slice(existing.end);
  }
  return text.length === 0 ? rendered : text + newline + rendered;
}

export function removeManagedBlock(text, id) {
  if (typeof text !== 'string') {
    throw new TypeError('managed block text must be a string');
  }
  assertId(id);
  const block = parseBlocks(text).get(id);
  if (!block) return text;

  let prefix = text.slice(0, block.start);
  let suffix = text.slice(block.end);
  if (prefix.endsWith('\r\n')) {
    prefix = prefix.slice(0, -2);
  } else if (prefix.endsWith('\n')) {
    prefix = prefix.slice(0, -1);
  } else if (suffix.startsWith('\r\n')) {
    suffix = suffix.slice(2);
  } else if (suffix.startsWith('\n')) {
    suffix = suffix.slice(1);
  }
  return prefix + suffix;
}
