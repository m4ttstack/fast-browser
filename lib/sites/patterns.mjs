// URL pattern normalization for site memory (WS2b plan, Task 1). Turns a
// concrete URL into a stable RECALL KEY -- the shape graph.mjs, inventory.mjs
// and the digest store key their per-route data on -- by collapsing
// path segments that look like an identifier (a numeric id, a UUID, or a
// high-entropy token) down to a literal `:id` placeholder.
//
// Deliberately independent of lib/flows/compile.mjs's goto-arg tokenizer:
// that module lifts sensitive/variable segments into REPLAY TEMPLATE args
// (`{argName}`) for a specific captured flow, keyed off the flow's own
// claimed arg names. This module has a different job -- collapsing MANY
// concrete URLs from MANY sessions down to the same recall key -- and must
// keep doing that even if compile.mjs's tokenization rules evolve, so the
// two are not shared code and must not be made to import each other.

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS_SEGMENT = /^[0-9]+$/;
// High-entropy token shape: URL-safe characters only, long enough that a
// literal word is implausible, and containing both a letter and a digit --
// a purely-alphabetic segment (a real path word) or a purely-numeric one
// (already caught by DIGITS_SEGMENT) never matches this on its own.
const HIGH_ENTROPY_SEGMENT = /^[A-Za-z0-9_-]+$/;
const HAS_LETTER = /[A-Za-z]/;
const HAS_DIGIT = /[0-9]/;
const MIN_HIGH_ENTROPY_LENGTH = 16;

function isHighEntropySegment(segment) {
  return (
    segment.length >= MIN_HIGH_ENTROPY_LENGTH
    && HIGH_ENTROPY_SEGMENT.test(segment)
    && HAS_LETTER.test(segment)
    && HAS_DIGIT.test(segment)
  );
}

function isIdSegment(segment) {
  return DIGITS_SEGMENT.test(segment) || UUID_SEGMENT.test(segment) || isHighEntropySegment(segment);
}

// Path only (query and hash are stripped by construction -- `URL#pathname`
// never includes either); a segment becomes `:id` per the rules above; the
// empty path (`/`, or a URL with no segments at all) normalizes to `/`.
// Returns null when `url` doesn't parse as an absolute URL, or parses to
// anything other than an http(s) URL (e.g. `about:blank`, `data:...`) --
// site memory only ever tracks real web origins.
export function normalizeUrlPattern(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) return '/';
  const normalized = segments.map((segment) => (isIdSegment(segment) ? ':id' : segment));
  return `/${normalized.join('/')}`;
}

// Filesystem-safe slug for a normalized pattern (used for digest filenames:
// `digests/<slug>.json`). Segments are joined with `-`; a segment's own
// literal `-` characters are escaped to `--` first so the join delimiter
// stays unambiguous (`/a-b/c` and `/a/b-c` must not collapse to the same
// slug); a leading `:` (the only place the placeholder can appear, since
// it's always a whole segment) becomes `_`. Root (`/`) is the literal
// `root` rather than the empty string, which is not a usable filename.
// A final catch-all replaces anything still outside `[A-Za-z0-9_-]` (stray
// characters a pattern segment could carry through unencoded) with `_`, so
// the result is always a safe single path component on every OS this plugin
// supports.
export function patternSlug(pattern) {
  if (pattern === '/') return 'root';
  const trimmed = pattern.replace(/^\/+/, '').replace(/\/+$/, '');
  const slug = trimmed
    .split('/')
    .map((segment) => segment.replace(/-/g, '--').replace(/^:/, '_'))
    .join('-');
  return slug.replace(/[^A-Za-z0-9_-]/g, '_');
}
