// WS3b Task 7: the pluggable encoder interface backing find's rerank stage
// and heal's ranker injection. Two implementations behind one shape:
//   - 'lexical' -- the default, always available, a genuine no-op (`active:
//     false`) that never changes v1's existing lexical-only behavior.
//   - 'voyage' -- opt-in via `config.encoder === 'voyage'` AND the
//     FAST_BROWSER_VOYAGE_API_KEY environment variable (never a config file
//     -- Global Constraint: no key ever lands on disk or in an artifact).
//     `voyage` without the env var degrades to lexical, silently, exactly
//     like every other encoder failure below.
// A WS4-era local encoder is expected to implement this exact same
// `{ active, kind, embed }` shape as a third, drop-in `createEncoder`
// branch -- nothing in this file's callers (find's rerank stage, heal's
// `encoderRanker`) is voyage-specific.
//
// --- LEAF module: ONE privilege ---
//
// This file's only I/O is the global `fetch` (used exactly once, inside
// `voyageEmbed`), gated behind a 5000ms `AbortSignal.timeout`. No fs, no
// other network client, no clock beyond that timeout. Every test stubs
// `globalThis.fetch` (and, where a test wants to pin the exact timeout
// value without waiting for one, `AbortSignal.timeout` itself) rather than
// touching a real network -- this module never makes a real HTTP request
// under `npm test`.
//
// --- embed's contract (Shared shapes, pinned exactly) ---
//
// `embed(texts)` takes `texts: string[]` (the CALLER's responsibility to
// keep this at <= MAX_EMBED_TEXTS entries, each <= MAX_EMBED_TEXT_CHARS
// characters -- this module does not clamp; see the two call sites in
// lib/commands/flows.mjs's find rerank stage and this file's own
// `encoderRanker` for where clamping actually happens) and either resolves
// to `Float64Array[]` (one unit-normalized vector per input text, same
// order) or THROWS. Every failure mode -- a missing key, a fetch rejection,
// a non-200 response, a malformed body, the 5000ms timeout firing -- is a
// throw, never a silent wrong answer. The caller (find's rerank stage,
// heal's `proposeHeal` via its injected ranker) is what degrades that one
// call to lexical; this module never degrades itself; `active: false`'s own
// `embed` throws too, for the same reason (a caller that skips the `active`
// check gets a loud failure, not silently wrong scores).

export const VOYAGE_MODEL = 'voyage-3.5-lite';
export const VOYAGE_ENDPOINT = 'https://api.voyageai.com/v1/embeddings';
export const VOYAGE_API_KEY_ENV = 'FAST_BROWSER_VOYAGE_API_KEY';
export const VOYAGE_TIMEOUT_MS = 5000;

// The two call sites that build embed() input (find's rerank stage in
// lib/commands/flows.mjs; this module's own `encoderRanker` below) both
// clamp against these SAME two named constants -- never a locally
// re-derived literal -- so a retune here moves both call sites' behavior
// together, and their own tests can pin against the constant rather than a
// duplicated magic number.
export const MAX_EMBED_TEXTS = 32;
export const MAX_EMBED_TEXT_CHARS = 2000;

// One slot in every embed() batch this module's own callers build is
// always the "subject" text (find's `intent`, heal's `target` text) that
// every other text in the batch is compared against -- reserved up front so
// a caller with more candidates than fit never silently drops the subject
// itself to make room.
const SUBJECT_RESERVED_SLOTS = 1;

// Fix round 1 (controller ruling, direction b): the lexical heal.mjs's
// HEAL_MIN_SCORE (0.6) / HEAL_MIN_MARGIN (0.2) are calibrated for its own
// scale (sparse Jaccard token overlap x TOKEN_OVERLAP_WEIGHT, plus a flat
// role bonus) -- a Voyage cosine distribution clusters much higher, with
// much smaller adjacent-candidate margins (typically ~0.05-0.15 between a
// real match and its nearest wrong neighbor), so applying the lexical
// thresholds to it would reject nearly every encoder-ranked heal. These two
// are the encoder-ranked equivalents, attached to `encoderRanker`'s
// returned function (see below) so `proposeHeal` (lib/flows/heal.mjs) uses
// them instead of the lexical constants for this ranker specifically.
//
// --- WS4a Task 7 THRESHOLD VERDICT: CONFIRM-CITED -- 0.75/0.05 STAND ---
//
// These were ANALYTIC, PROVISIONAL values when WS3b shipped them ("start
// conservative, tune from drift-harness data"). Measured 2026-08 (drift
// harness, Task 6 report), against real, live Voyage traffic
// (voyage-3.5-lite):
//
//   - CORRECT binds, both healed and both matching the fixture's own
//     declared intended drift target: `testid-rename` margin 0.134 (top
//     0.9850, role+testid candidate correctly outranking a bare-text
//     distractor); `text-rename-near` margin 0.169 (top 1.0, an
//     accessible-name paraphrase correctly outranking the unrelated
//     sibling button). Both comfortably clear 0.75/0.05 with real margin
//     to spare.
//   - THE COUNTEREXAMPLE, from the SAME measurement run, on the SAME
//     payload shape: `text-rename-far`'s own distractor candidate
//     ("Confirm order", cosine 0.8508) outscored the fixture's true
//     intended target ("Checkout", cosine 0.7554) by a margin of 0.0954 --
//     ABOVE 0.05 -- so the gate legitimately passed a WRONG bind
//     (`correct: false`, tuningLineFor's own judged field). Both
//     candidates individually clear ENCODER_MIN_SCORE too (0.8508 and
//     0.7554, both >= 0.75) -- this was never a "too generous a score
//     floor" failure, only a preference-ordering one.
//
// A margin raised to ~0.12 would have suppressed that specific mis-bind
// (0.0954 < 0.12 <= both correct-bind margins above), but this is
// n=1-per-cell evidence from a single fixture scene, and raising the
// margin only SUPPRESSES a bad bind by refusing to heal at all -- it does
// not fix the ranker's underlying preference for a semantically-adjacent
// distractor (another order-completion verb sharing lexical/semantic
// territory with the target) over the true target. That is a
// ranking-quality problem (multi-signal: DOM proximity, prior-locator
// distance -- signals this scorer has no access to at all today), not a
// threshold-position problem, and is explicitly deferred to WS4b as the
// local-encoder-era fix. 0.75/0.05 STAND, unchanged, on this citation.
export const ENCODER_MIN_SCORE = 0.75;
export const ENCODER_MIN_MARGIN = 0.05;

// Fix round 1, Folded Minor 1: mirrors heal.mjs's own `ROLE_MATCH_BONUS`
// (0.15) so a role-agreeing candidate keeps the same flat signal under the
// encoder-backed ranker that the lexical one already gives it -- without
// this, a candidate whose role matches the target's loses that 0.15 purely
// because cosine similarity has no role concept of its own. Kept as an
// independent local constant, not an import: heal.mjs is a leaf with no
// imports of its own, and encoder.mjs's own doc comment above pins its
// privilege boundary to fetch alone -- importing heal.mjs here would add a
// module dependency to satisfy nothing but this one shared number, more
// coupling than the value is worth. SYNC NOTE: if heal.mjs's
// `ROLE_MATCH_BONUS` ever changes, this must change with it by hand.
const ROLE_MATCH_BONUS = 0.15;

// Clamps ONE text to the pinned per-text character bound. Exported so both
// call sites (and their tests) share the exact same clamp rather than each
// re-deriving `.slice(0, 2000)` independently.
export function clampEmbedText(value) {
  const text = typeof value === 'string' ? value : '';
  return text.slice(0, MAX_EMBED_TEXT_CHARS);
}

// L2-normalizes one raw embedding vector to unit length so a plain dot
// product between two normalized vectors IS their cosine similarity
// (`cosineSimilarity` below relies on this -- it does not itself divide by
// either vector's norm). A zero vector (norm 0 -- degenerate, never
// expected from a real Voyage response, but not this function's job to
// reject) normalizes to itself rather than dividing by zero.
function unitNormalize(vector) {
  let sumSquares = 0;
  for (let i = 0; i < vector.length; i += 1) sumSquares += vector[i] * vector[i];
  const norm = Math.sqrt(sumSquares);
  const normalized = new Float64Array(vector.length);
  if (norm === 0) return normalized;
  for (let i = 0; i < vector.length; i += 1) normalized[i] = vector[i] / norm;
  return normalized;
}

// Cosine similarity between two ALREADY unit-normalized vectors -- a plain
// dot product, per `unitNormalize`'s own doc comment above. Tolerates
// mismatched lengths (walks only the shorter one) defensively, though
// `embed`'s own contract never produces vectors of differing dimensionality
// within one call.
export function cosineSimilarity(a, b) {
  const length = Math.min(a?.length ?? 0, b?.length ?? 0);
  let dot = 0;
  for (let i = 0; i < length; i += 1) dot += a[i] * b[i];
  return dot;
}

// The one fetch call this whole module ever makes. `texts`/`key` are
// already validated non-empty by `createEncoder` before this is reached.
// Every failure mode below throws a plain Error with a short, internal
// (never page-derived) message -- never a raw fetch/JSON exception object,
// so a caller's `error.message` is always safe to surface in a warning
// without a stripControlChars pass (mirrors sweep.mjs's own `healErrors`
// convention: an internal diagnostic string, not user/page content).
async function voyageEmbed(texts, key) {
  let response;
  try {
    response = await fetch(VOYAGE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ input: texts, model: VOYAGE_MODEL }),
      // 5000ms hard timeout (Shared shapes, pinned exactly): a fetch that
      // hangs must not hang find/heal indefinitely -- AbortSignal.timeout
      // rejects the fetch itself, which the catch below turns into the
      // same degrade-worthy throw as any other transport failure.
      signal: AbortSignal.timeout(VOYAGE_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`voyage embeddings request failed: ${error?.message ?? String(error)}`);
  }

  if (!response.ok) {
    throw new Error(`voyage embeddings request failed: HTTP ${response.status}`);
  }

  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(`voyage embeddings response was not valid JSON: ${error?.message ?? String(error)}`);
  }

  if (!body || !Array.isArray(body.data)) {
    throw new Error('voyage embeddings response was malformed: missing data array');
  }
  if (body.data.length !== texts.length) {
    throw new Error(
      `voyage embeddings response was malformed: expected ${texts.length} embeddings, got ${body.data.length}`,
    );
  }

  return body.data.map((entry, index) => {
    const vector = entry?.embedding;
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error(`voyage embeddings response was malformed: missing embedding at index ${index}`);
    }
    return unitNormalize(vector);
  });
}

// createEncoder({ config, env }) -> { active, kind, embed } (Shared shapes,
// pinned exactly). `config.encoder` selects 'voyage'|'lexical' (anything
// else -- absent, malformed, some other string -- reads as 'lexical', the
// same tolerant-default posture core/config.mjs's own `parseConfig` already
// applies). `env[FAST_BROWSER_VOYAGE_API_KEY_ENV]` is the ONLY place the key
// is ever read from -- never `config`, never a file. Requesting 'voyage'
// without a present, non-empty key degrades to the SAME `{ active: false,
// kind: 'lexical' }` shape a plain 'lexical' request returns -- there is no
// third "voyage but broken" kind; from a caller's perspective it is
// indistinguishable from having never asked for voyage at all.
export function createEncoder({ config, env } = {}) {
  const requestsVoyage = config?.encoder === 'voyage';
  const key = env?.[VOYAGE_API_KEY_ENV];
  const hasKey = typeof key === 'string' && key.length > 0;

  if (requestsVoyage && hasKey) {
    return {
      active: true,
      kind: 'voyage',
      embed: (texts) => voyageEmbed(texts, key),
    };
  }

  return {
    active: false,
    kind: 'lexical',
    // A caller is expected to check `active` before ever calling `embed`
    // (find's rerank stage and `encoderRanker` below both do). This throws
    // rather than returning an empty/fake result so a caller that skips the
    // check fails loudly instead of silently ranking on garbage vectors.
    embed: async () => {
      throw new Error('lexical encoder has no embeddings -- check `active` before calling embed');
    },
  };
}

function textField(value) {
  return typeof value === 'string' ? value : '';
}

// encoderRanker(encoder) -> a function with the EXACT rankCandidates shape
// heal.mjs's own lexical `rankCandidates` has: `({ target, candidates }) ->
// [{ index, score }]` sorted desc, `index` matching `candidates`' own
// position (Shared shapes, pinned exactly). Reads the SAME text fields the
// lexical scorer does -- candidate name+text vs target description+name --
// but ranks by cosine similarity over `encoder.embed` output instead of
// token-Jaccard overlap.
//
// Unlike the lexical `rankCandidates`, this returned function is
// necessarily ASYNC (embedding requires a network round trip) -- it always
// returns a Promise. `proposeHeal` (lib/flows/heal.mjs) is written to
// accept either a synchronous array OR a thenable from its injected
// `ranker`, so this is still a drop-in for that parameter despite the
// signature difference in practice; see that module's own doc comment for
// how it stays synchronous-by-default when no ranker (or a synchronous
// stub ranker) is supplied.
//
// Clamping (Shared shapes' clamping contract): `candidates` is not bounded
// by anything upstream (a flow-runner failure payload can in principle
// carry many candidates), so this reserves one embed-batch slot for the
// target text and embeds at most `MAX_EMBED_TEXTS - 1` candidates, each
// text clamped to `MAX_EMBED_TEXT_CHARS` characters. A candidate beyond
// that cutoff is still represented in the returned array (every input
// index must appear, per the pinned return shape) but with a
// `Number.NEGATIVE_INFINITY` score, so it sorts last rather than being
// silently dropped from the ranking entirely.
//
// Fix round 1, Folded Minor 1: a role-agreeing candidate (case-folded,
// same rule as the lexical scorer) gets the same flat `ROLE_MATCH_BONUS`
// added on top of its cosine similarity, capped at 1.0 so a role-boosted
// score never exceeds the scale `ENCODER_MIN_SCORE`/`ENCODER_MIN_MARGIN`
// above are calibrated against. Only applied to candidates that were
// actually embedded (`index < embeddableCount`) -- a clamped-out
// candidate's `Number.NEGATIVE_INFINITY` stays exactly that; adding a flat
// bonus to it would be meaningless (and, capped at 1.0, would actively lie
// about it ranking above a real cosine score).
//
// Fix round 1, controller ruling (direction b): `minScore`/`minMargin` are
// attached directly to the returned function as plain properties, not
// threaded through the `({ target, candidates })` call args -- this keeps
// the function's call signature identical to the lexical `rankCandidates`
// it replaces (Shared shapes, pinned exactly), while still giving
// `proposeHeal` (lib/flows/heal.mjs) a way to read ranker-specific
// acceptance thresholds off the ranker itself.
export function encoderRanker(encoder) {
  const rankByEncoder = function rankByEncoder({ target, candidates } = {}) {
    if (!Array.isArray(candidates) || candidates.length === 0) return [];

    const safeTarget = target && typeof target === 'object' ? target : {};
    const targetText = clampEmbedText(
      `${textField(safeTarget.description)} ${textField(safeTarget.name)}`.trim(),
    );
    const targetRole = textField(safeTarget.role).toLowerCase();

    const embeddableCount = Math.min(candidates.length, MAX_EMBED_TEXTS - SUBJECT_RESERVED_SLOTS);
    const texts = [targetText];
    for (let i = 0; i < embeddableCount; i += 1) {
      const value = candidates[i];
      const safeCandidate = value && typeof value === 'object' ? value : {};
      texts.push(clampEmbedText(`${textField(safeCandidate.name)} ${textField(safeCandidate.text)}`.trim()));
    }

    return encoder.embed(texts).then((vectors) => {
      if (!Array.isArray(vectors) || vectors.length !== texts.length) {
        throw new Error('encoder returned a mismatched number of vectors');
      }
      const targetVector = vectors[0];
      return candidates
        .map((value, index) => {
          if (index >= embeddableCount) return { index, score: Number.NEGATIVE_INFINITY };
          const cosine = cosineSimilarity(targetVector, vectors[index + 1]);
          const safeCandidate = value && typeof value === 'object' ? value : {};
          const roleMatches = targetRole.length > 0 && textField(safeCandidate.role).toLowerCase() === targetRole;
          const score = Math.min(1, cosine + (roleMatches ? ROLE_MATCH_BONUS : 0));
          return { index, score };
        })
        .sort((a, b) => b.score - a.score);
    });
  };
  rankByEncoder.minScore = ENCODER_MIN_SCORE;
  rankByEncoder.minMargin = ENCODER_MIN_MARGIN;
  return rankByEncoder;
}
