// The deterministic flow matcher (WS2a flywheel plan, Task 6). Consumes
// Task 3's flow artifact shape and Task 5's tier classification (via the
// `{ flow, tier }` pairs a caller assembles by reading `flowsDir` and
// `flowsPendingDir` -- Task 7's CLI does that; this module is a LEAF: no
// fs, no I/O, pure data in / data out).
//
// Two independent things this module computes per candidate, kept
// deliberately separate:
//   - `score` -- how well the candidate matches `origin`/`url`/`intent`.
//     Ranking only; never gates inclusion beyond the `MIN_SCORE` floor.
//   - `runnable` -- whether a v1 replay of this flow is even possible,
//     independent of how well it matched. A perfect lexical match on a
//     pending-tier or js-step flow is still returned (so the caller can
//     surface "here's what you meant, but it needs approval first"), just
//     with `runnable: false`.
//
// `reasons` carries ONLY caveats about the match -- why it's quarantined,
// why it isn't runnable -- never an explanation of why it scored well.
// A clean, healthy, runnable match has `reasons: []`. This keeps the field
// meaningful for a caller/agent deciding what to do next, rather than a
// running commentary on arithmetic.
//
// Scoring layers, exact-first (spec: "Exact-first ... urlPattern match ...
// is a STRONG boost; name-token equality ... is a STRONG boost"):
//   1. `origin` (when given) is a hard filter, not a score component --
//      flows whose origin doesn't match are dropped before scoring runs at
//      all (normalized via `new URL(...).origin`: protocol+host+port,
//      host lowercased per the URL spec).
//   2. `url` (when given) matched against the flow's `urlPattern` --
//      path-only (artifact.mjs's urlPattern is always origin-relative;
//      `:param` segments match any single path segment) -- is a flat,
//      one-time `URL_PATTERN_MATCH_SCORE` boost.
//   3. Any overlap between `intent`'s tokens and the flow `name`'s tokens
//      is a flat, one-time `NAME_TOKEN_MATCH_SCORE` boost -- a match on the
//      flow's own identity is trusted far more than an incidental word
//      shared with its description or a step's target text.
//   4. The general lexical layer: `LEXICAL_TOKEN_SCORE` per DISTINCT token
//      `intent` shares with the corpus built from name + description +
//      every step's target name/description (drag's `to` target included).
//      Name tokens are part of this corpus too, so a name match earns both
//      layer 3's flat boost AND its per-token share of layer 4 -- that's
//      intentional, not double-counting to fix.
// No fuzzy edit distance, no embeddings, no stemming -- token equality
// after lowercasing only, exactly the spec's "deterministic and
// unit-testable" requirement.
//
// `MIN_SCORE` exists so a single incidental shared word (one
// `LEXICAL_TOKEN_SCORE`) never counts as a match -- an expected miss must
// return `[]`, never a wild guess propped up by one coincidental token.
//
// Quarantine (`provenance.failStreak >= QUARANTINE_FAIL_STREAK_THRESHOLD`)
// halves the score AFTER the layers above and BEFORE the `MIN_SCORE` floor
// is applied -- a quarantined flow can fall out of contention entirely,
// not just rank lower, which is the intended "re-record likely cheaper"
// signal winning over a stale match.

// Exported (not just module-private) so tests pin behavior against the
// named constants themselves rather than duplicating magic numbers -- if a
// weight is retuned later, the tests that depend on its exact value fail
// loudly at the constant's own definition, not at some derived arithmetic
// buried in a fixture.
export const URL_PATTERN_MATCH_SCORE = 100;
export const NAME_TOKEN_MATCH_SCORE = 100;
export const LEXICAL_TOKEN_SCORE = 10;
export const MIN_SCORE = 20;
export const QUARANTINE_FAIL_STREAK_THRESHOLD = 3;
export const QUARANTINE_SCORE_MULTIPLIER = 0.5;
export const MAX_RESULTS = 5;

const QUARANTINE_REASON = 'quarantined: re-record likely cheaper';
const JS_STEP_REASON = 'contains js step: not replayable in v1';

// --- tokenization: lowercase runs of [a-z0-9]+, length >= 2 (drops bare
// single-char tokens -- "a", "i" -- the same "too short to be meaningful"
// convention compile.mjs's parameter lifting already applies to literals,
// reused here rather than inventing a second threshold). ---

function tokenize(text) {
  if (typeof text !== 'string') return [];
  const matches = text.toLowerCase().match(/[a-z0-9]+/g);
  return matches ? matches.filter((token) => token.length >= 2) : [];
}

function intersectionCount(tokens, corpus) {
  let count = 0;
  for (const token of tokens) {
    if (corpus.has(token)) count += 1;
  }
  return count;
}

// --- origin normalization: protocol+host+port, host case-folded, via the
// URL spec's own `.origin` (which already lowercases the hostname). Never
// throws -- an unparseable value (caller error, not hostile trace data;
// stored flow origins are always valid per artifact.mjs's own validation)
// normalizes to null, which can never equal a real origin string, so it
// simply fails the filter rather than crashing the matcher. ---

function normalizeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

// --- url/urlPattern path matching: origin-agnostic (origin filtering is
// its own layer above), ':param' segments match any single path segment,
// segment counts must match exactly (no wildcard-remainder semantics). ---

function pathSegments(pathValue) {
  return pathValue.split('/').filter((segment) => segment.length > 0);
}

// Accepts either an absolute URL or an origin-relative path (a bare base is
// supplied for the latter case so `new URL` still succeeds); returns null
// for a value that's neither, rather than throwing.
function pathOf(value) {
  try {
    return new URL(value).pathname;
  } catch {
    try {
      return new URL(value, 'http://placeholder.invalid').pathname;
    } catch {
      return null;
    }
  }
}

function urlPatternMatchesPath(urlPattern, targetPath) {
  const patternSegments = pathSegments(urlPattern);
  const target = pathSegments(targetPath);
  if (patternSegments.length !== target.length) return false;
  return patternSegments.every((segment, index) => (
    segment.startsWith(':') || segment === target[index]
  ));
}

// --- lexical corpus: name + description + every step's target name/
// description (both `target` and drag's `to`), deduped into a Set so a
// repeated word in, say, two step descriptions only ever contributes one
// LEXICAL_TOKEN_SCORE, not one per occurrence. ---

function lexicalCorpusTokens(flow) {
  const tokens = new Set();
  for (const token of tokenize(flow.name)) tokens.add(token);
  for (const token of tokenize(flow.description)) tokens.add(token);
  for (const step of flow.steps) {
    for (const target of [step.target, step.to]) {
      if (!target) continue;
      if (target.name) for (const token of tokenize(target.name)) tokens.add(token);
      if (target.description) for (const token of tokenize(target.description)) tokens.add(token);
    }
  }
  return tokens;
}

// WS3b Task 7: returns the two exact-first layer flags alongside the raw
// score -- whether THIS candidate itself earned the flat URL_PATTERN_MATCH_
// SCORE / NAME_TOKEN_MATCH_SCORE boost, independent of the quarantine
// multiplier applied afterward in `matchFlows` (a quarantined exact match is
// still an exact match; quarantine only scales the number). find's rerank
// stage (lib/commands/flows.mjs) uses these two booleans as the band key an
// encoder-backed reorder must never cross -- "exact-first stays law" means a
// urlPattern/name-token hit can never be reordered below a candidate that
// only matched lexically, no matter what an embedding's cosine similarity
// says.
function scoreFlow(flow, { url, intentTokens }) {
  let score = 0;
  let urlPatternHit = false;
  let nameTokenHit = false;

  if (url) {
    const targetPath = pathOf(url);
    if (targetPath !== null && urlPatternMatchesPath(flow.urlPattern, targetPath)) {
      score += URL_PATTERN_MATCH_SCORE;
      urlPatternHit = true;
    }
  }

  const nameTokens = new Set(tokenize(flow.name));
  if (intersectionCount(intentTokens, nameTokens) > 0) {
    score += NAME_TOKEN_MATCH_SCORE;
    nameTokenHit = true;
  }

  score += LEXICAL_TOKEN_SCORE * intersectionCount(intentTokens, lexicalCorpusTokens(flow));

  return { score, urlPatternHit, nameTokenHit };
}

// --- public API ---

// matchFlows({ flows, origin?, url?, intent }) -> [{ flow, score, runnable,
//   reasons, urlPatternHit, nameTokenHit }] sorted best score first, ties
//   broken by flow name ascending, capped at MAX_RESULTS. `urlPatternHit`/
//   `nameTokenHit` (WS3b Task 7, additive) are this candidate's own exact-
//   first layer flags -- see `scoreFlow`'s doc comment above; a caller doing
//   no reranking of its own can ignore both fields entirely. `flows` is
//   [{ flow, tier }] (Task 3's parsed
//   artifact + which tier dir it came from, per this module's doc comment).
//   Never throws on well-formed input; `origin`/`url`/`intent` are all
//   optional (an omitted `origin` skips the hard filter, an omitted `url`
//   skips layer 2, an omitted/empty `intent` skips layers 3-4 -- a caller
//   can still get an origin/url-only exact lookup with no intent at all).
export function matchFlows({
  flows = [], origin, url, intent = '',
} = {}) {
  const intentTokens = new Set(tokenize(intent));
  const originFilterActive = origin !== undefined && origin !== null;
  const requestOrigin = originFilterActive ? normalizeOrigin(origin) : null;

  const candidates = [];

  for (const entry of flows) {
    const { flow, tier } = entry;

    if (originFilterActive) {
      const flowOrigin = normalizeOrigin(flow.origin);
      if (flowOrigin === null || flowOrigin !== requestOrigin) continue;
    }

    const { score: rawScore, urlPatternHit, nameTokenHit } = scoreFlow(flow, { url, intentTokens });
    let score = rawScore;
    const reasons = [];

    if (flow.provenance.failStreak >= QUARANTINE_FAIL_STREAK_THRESHOLD) {
      score *= QUARANTINE_SCORE_MULTIPLIER;
      reasons.push(QUARANTINE_REASON);
    }

    if (score < MIN_SCORE) continue;

    let runnable = true;
    if (tier === 'pending') {
      runnable = false;
      reasons.push(`pending approval: fast-browser flows approve ${flow.name}`);
    }
    // v1 refuses ALL js steps at replay, not only the sha256:null ones --
    // see artifact.mjs's flowTier note and the runner rules in Task 8.
    if (flow.steps.some((step) => step.op === 'js')) {
      runnable = false;
      reasons.push(JS_STEP_REASON);
    }

    candidates.push({
      flow, score, runnable, reasons, urlPatternHit, nameTokenHit,
    });
  }

  // A tie on BOTH score and name (only reachable via a manual cross-tier
  // file copy -- sweep.mjs's own dedup-by-name keeps two normally-compiled
  // flows from ever sharing a name) falls through to `flows`' own caller
  // order, since `Array.prototype.sort` is stable. Caller contract: this is
  // an artifact of stable sort over whatever order `flows` was given in,
  // not a guarantee -- a caller must not depend on which of two exact ties
  // ends up first.
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.flow.name < b.flow.name) return -1;
    if (a.flow.name > b.flow.name) return 1;
    return 0;
  });

  return candidates.slice(0, MAX_RESULTS);
}
