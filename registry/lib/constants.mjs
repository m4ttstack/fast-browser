// Pinned registry constants (WS4b plan, Shared shapes). Both the ingest
// pipeline (registry/lib/ingest.mjs) and the production embedder
// (registry/lib/embedder.mjs) import from here rather than re-deriving
// either value locally, so a retune moves every consumer together, and a
// reviewer has exactly one place to check either number against.

// Conservative on purpose. WS4a's drift harness (lib/flows/encoder.mjs's
// own Task 7 threshold-verdict comment, measured against real, live
// Voyage traffic on voyage-3.5-lite) found a genuine cosine MIS-BIND: on
// one fixture, a distractor candidate ("Confirm order", cosine 0.8508)
// outscored the fixture's own true intended target ("Checkout", cosine
// 0.7554) by a margin of 0.0954 -- a margin that legitimately passed a
// looser acceptance gate and would have clicked the wrong element. Both
// candidates individually cleared a reasonable score floor; this was a
// PREFERENCE-ORDERING failure, not a "score too low" one. Cosine
// similarity between two embedded text snippets cannot, by itself, be
// trusted to mean "these are the same flow" below a very high bar.
//
// REGISTRY_CLUSTER_THRESHOLD is set well above that 0.0954 mis-bind
// margin (and above both correct-bind margins measured in the same run,
// 0.134 and 0.169) specifically because cosine here is being asked a
// higher-stakes question than encoder.mjs's own ranker asks: not "which of
// these candidates ranks best" but "is this incoming flow actually the
// SAME flow as this existing canonical, safe to merge locator alternates
// into". A wrong "yes" corrupts a canonical (mixes fallback locators from
// two different actions into one flow's step) in a way a wrong heal-rank
// choice does not.
//
// Clustering also NEVER relies on cosine alone: a candidate must already
// share the same origin AND an identical opSequence (registry/lib/
// store.mjs's findClusterCandidates prefilter) before cosine is even
// consulted, and the ingest pipeline additionally requires the full
// stepSignature to match PLUS a per-step identity anchor at every step
// (registry/lib/ingest.mjs's findClusterMatch/stepsAreAnchored -- fix
// round 1, Critical #2: stepSignature alone collapses two DIFFERENT
// targets that both happen to carry no role/name, e.g. a raw CSS-selector
// click on #confirm vs #delete-account, into the identical tuple, and
// never covers `drag`'s `to` destination at all) before actually merging
// -- so cosine's only real job is deciding whether two candidates that
// already agree on origin, op sequence, step signature, AND every step's
// own target identity are close enough in MEANING (description) to treat
// as duplicates of each other, never whether two structurally different
// flows are "close enough" to merge.
export const REGISTRY_CLUSTER_THRESHOLD = 0.95;

// Mirrors lib/flows/encoder.mjs's VOYAGE_MODEL constant byte-for-byte.
// Kept as an independent constant here, not an import: encoder.mjs is the
// PLUGIN's own leaf module (its top comment pins fetch as its one
// privilege, scoped to the plugin's own callers -- find's rerank stage,
// heal's ranker); the registry is a separate deployable (its own
// package.json, its own env, its own embedder -- registry/lib/
// embedder.mjs) and importing across that boundary would couple two
// things the WS4b plan explicitly wants free to evolve independently.
// SYNC NOTE: if voyage-3.5-lite is ever retired, or encoder.mjs's own
// VOYAGE_MODEL changes, update this by hand -- encoder.mjs is NOT required
// to reference this file in either direction.
export const EMBED_MODEL = 'voyage-3.5-lite';

// voyage-3.5-lite's real output width, AND what registry/migrations/
// 001-init.sql's `canonical_flows.embedding` column is fixed to
// (`vector(1024)`). pg-store's schema already enforces this width
// STRUCTURALLY at INSERT/UPDATE time -- a wrong-width value is rejected by
// Postgres itself. This constant is what lets registry/lib/embedder.mjs
// catch a wrong-width (or otherwise malformed: non-finite elements) Voyage
// response BEFORE it ever reaches the store (fix round 1, Important #4:
// an odd-but-200-OK response -- a model change returning a different
// width, or non-numeric elements producing NaN -- previously escaped
// ingest entirely and would 500 the whole push once pg-store's own column
// constraint rejected the insert). Any mismatch degrades that one embed to
// null, same as every other embedder failure mode, rather than surfacing
// as a mid-push crash.
export const EMBED_DIM = 1024;
