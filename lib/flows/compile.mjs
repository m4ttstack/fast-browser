import { cleanArray, isTruncationMarker } from './trace-reader.mjs';
import {
  FLOW_SCHEMA_VERSION, FlowError, flowId, parseFlow,
} from './artifact.mjs';

// The trace-to-flow compiler (WS2a flywheel plan, Task 4). Consumes Task 2's
// reader output (raw TraceRecord objects, TRACE.md-shaped) and produces
// Task 3's flow artifact shape (artifact.mjs, authoritative over any JSON
// sketch elsewhere -- this module is a CONSUMER of that contract, never
// redefines it). Every compiled flow is round-tripped through `parseFlow`
// before being returned, so a compiler bug in THIS module surfaces as a loud
// FlowError during development/testing -- but a hostile-yet-realistic TRACE
// (unparseable URLs, a non-http origin like `about:blank`, missing/malformed
// params) must never crash `compileSession` itself: any `FlowError` (schema
// rejection) or `InvalidRecordError` (a degenerate record this module
// refuses to fabricate a step for -- see rule 8's "ADOPTED F8" fix) raised
// while building one segment's flow is caught in `compileSegment` and
// converted to a `{ reason: 'invalid: <message>', seqRange }` skip entry,
// exactly like `too-short`/`unsupported: <tool>`. `compileSession` has the
// same "never throws on trace input" contract as Task 2's trace reader --
// see fix-round-1 notes in task-4-report.md. `CompileError` (below) is the
// one deliberate exception: it fires only when the CALLER hasn't wired a
// `now` clock for a session with no `meta.endedAt`, which is a caller-wiring
// bug, not hostile trace data, so it is left to propagate.
//
// Deterministic by construction: no Date.now()/Math.random() anywhere in
// this file. `provenance.compiledAt` comes from `meta.endedAt` (the trace
// session's own recorded close time) when present, or from a caller-supplied
// `now` clock (a `() => Date` function, matching the `now: supplied.now ??
// (() => new Date())` convention used elsewhere in this codebase --
// lib/commands/setup.mjs, lib/commands/configure.mjs -- except this module
// never supplies its own default; the caller must, exactly like the global
// constraint requires). See `resolveCompiledAt` below.
//
// v1 semantics, intended (not incidental) -- documented once here rather
// than re-litigated at each call site:
// - **Same-literal collapse.** A literal value that recurs anywhere in a
//   flow -- under the same target label, a different target label, or as a
//   goto URL path/query segment -- collapses onto ONE arg: whichever name
//   first claimed that literal wins, every later occurrence reuses it. Two
//   different literals that would slug to the same base name get numeric
//   suffixes (`name`, `name2`, ...) instead of colliding. This is rule 4's
//   "deduped with numeric suffixes" read literally: dedup is per ARG NAME,
//   reuse is per LITERAL VALUE, and both share one registry (`liftState`)
//   so upload paths, fill/select values, and goto URL segments/query values
//   can never mint conflicting args for the same name (fix-round-1 F2) or
//   silently leak an unnamed literal into the artifact (fix-round-1 F7).
// - **Naming uses strict priority tiers**, not a blended score: (1) the
//   last click's target-name slug (preferring a network-mutating click),
//   (2) the origin path's first segment, (3) `flow-<epochMs>-<segmentIndex>`.
//   The first tier that produces a name wins outright; there is no
//   fallback-to-tier-2-if-tier-1-name-seems-weak logic.

export class CompileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CompileError';
  }
}

// Raised for a record whose tool-mapped fields are structurally present
// (the tool is in TOOL_OPS, so it counts toward the action-record threshold)
// but too degenerate to compile into a truthful step -- a `browser_navigate`
// with no usable `params.url`, a `browser_type`/`browser_select_option`/
// `browser_fill_form` field with no usable literal, a `browser_press_key`
// with no `key`. Fabricating a placeholder (`goto /`, `value: ''`) here
// would silently produce a flow that replays something the trace never
// actually did (fix-round-1 "ADOPTED F8") -- so these throw instead, and
// `compileSegment` catches this alongside `FlowError`, skipping the whole
// segment as `invalid: <message>` rather than shipping a fabricated step.
class InvalidRecordError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidRecordError';
  }
}

// Op mapping (plan Task 4, rule 2), copied verbatim. A tool absent from this
// map is a no-op for compilation -- snapshot/find/console_messages/
// take_screenshot/network_requests etc. are observations, not steps, and
// are silently skipped in the per-record switch below.
const TOOL_OPS = new Map([
  ['browser_navigate', 'goto'],
  ['browser_click', 'click'],
  ['browser_type', 'fill'],
  ['browser_fill_form', 'fill'], // one step per target, values from params.fields
  ['browser_select_option', 'select'],
  ['browser_press_key', 'press'],
  ['browser_hover', 'hover'],
  ['browser_drag', 'drag'],
  ['browser_file_upload', 'upload'],
  ['browser_run_code_unsafe', 'js'],
  ['browser_wait_for', 'wait'],
]);

// Side-effect gating (plan Task 4, rule 5), copied verbatim. TRACE.md's own
// "mutating-by-tool-identity" list (fill_form, type, hover, select_option,
// navigate) is NOT what this set is -- the controller ruling (Task 3 review)
// deliberately narrows/widens it for the compiler's purposes: hover stays
// out (transient, no lasting page effect) and navigate stays out (page-level,
// not itself a mutation of application state), while file_upload/drag/drop
// are added (state-changing by identity even though none of them ever
// populates `network`, so `record.mutating` alone would always read false
// for them). `browser_drop` is included here even though it can never reach
// this check in practice -- it's always caught by UNSUPPORTED_TOOLS first
// (rule d, below) and the containing segment is skipped outright -- kept
// verbatim per the exact-contents instruction rather than pruned as dead.
const MUTATING_BY_IDENTITY = new Set([
  'browser_fill_form',
  'browser_type',
  'browser_select_option',
  'browser_file_upload',
  'browser_drag',
  'browser_drop',
]);

// Controller ruling (Task 3 review, ruling d): state-changing tools with no
// step mapping. Compiling a segment that contains one of these while
// silently dropping the record would produce a flow that looks complete but
// replays a corrupted sequence of actions (a dialog never handled, a tab
// switch never made, a network request never issued) -- so the whole
// segment is skipped instead. `browser_tabs` is handled separately just
// below since only some of its actions are unsupported (`list` is a genuine
// read-only observation).
const UNSUPPORTED_TOOLS = new Set([
  'browser_drop',
  'browser_handle_dialog',
  'browser_navigate_back',
  'browser_evaluate',
  'browser_network_request',
]);

const SHA256_HEX = /^[0-9a-f]{64}$/;

// --- small pure helpers ---

// ASCII kebab-case slug: lowercase, diacritics stripped, any run of
// non-alphanumeric characters collapsed to one hyphen, edges trimmed. Used
// both for flow `name` (kebab-case, per artifact.mjs's NAME_PATTERN) and as
// the input to `camelize` for arg names.
function slugify(text) {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// kebab-case -> camelCase (`customer-name` -> `customerName`, plan Task 4
// rule 4's worked example). First segment stays lowercase; every later
// segment is capitalized.
function camelize(slug) {
  const parts = slug.split('-').filter(Boolean);
  if (parts.length === 0) return '';
  return parts[0] + parts.slice(1).map((part) => part[0].toUpperCase() + part.slice(1)).join('');
}

// `new URL(url).origin`, tolerant of missing/unparseable input -- returns
// null instead of throwing, since both segmentation (rule 1) and origin
// resolution need to treat "can't tell" as "don't split"/"fall through to
// the next source", never as a hard failure. Note `new URL('about:blank')`
// does NOT throw -- it parses fine and yields `origin === 'null'` (the
// four-character string), which is deliberately NOT filtered out here: it's
// a legitimate origin-shaped value that fails validation downstream at
// `parseFlow` (not an http(s) origin), which is exactly the "hostile but
// realistic" case fix-round-1 F1 catches via `compileSegment`'s try/catch
// rather than this helper trying to special-case it.
function safeOrigin(url) {
  if (typeof url !== 'string' || url.length === 0) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function safeParseUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

// Fix-round-2 N2: a record with a missing/non-numeric `seq` (hostile input
// -- TRACE.md guarantees `seq` for a real schema-1 record, but this reader
// doesn't re-validate it, see readTraceRecords) must not leave a bare JS
// `undefined` sitting in a `seqRange` tuple. `undefined` still ends up
// rendering as `null` once JSON.stringify'd (arrays coerce `undefined`
// elements to `null`), but every OTHER consumer of `report.skipped` in this
// codebase (deepEqual assertions, direct property reads before
// serialization) sees the raw in-memory value -- so this normalizes to
// `null` explicitly, immediately, rather than relying on JSON's array
// encoding to paper over it downstream.
function toSeqValue(seq) {
  return Number.isFinite(seq) ? seq : null;
}

function toSeqRange(records) {
  return [toSeqValue(records[0]?.seq), toSeqValue(records.at(-1)?.seq)];
}

function targetLabel(target) {
  const label = target?.name ?? target?.description;
  return label ? `"${label}"` : 'an element';
}

// One clause per compiled step, joined into the flow's deterministic
// description sentence (rule 9: "deterministic template, no inference").
function describeStep(step) {
  switch (step.op) {
    case 'goto': return `navigates to ${step.url}`;
    case 'click': return `clicks ${targetLabel(step.target)}`;
    case 'fill': return `fills ${targetLabel(step.target)}`;
    case 'select': return `selects an option in ${targetLabel(step.target)}`;
    case 'press': return `presses "${step.key}"`;
    case 'hover': return `hovers ${targetLabel(step.target)}`;
    case 'drag': return `drags ${targetLabel(step.target)} to ${targetLabel(step.to)}`;
    case 'upload': return `uploads ${step.files.length} file${step.files.length === 1 ? '' : 's'}`;
    case 'wait': return `waits ${step.value}ms`;
    case 'js': return 'runs a script';
    default: return step.op;
  }
}

function buildDescription(origin, steps) {
  return `On ${origin}, this flow ${steps.map(describeStep).join(', ')}.`;
}

// --- rule 3: targets from record.targets (cleanArray'd) ---

// Maps a raw TraceTarget (TRACE.md: `{ ref?, resolved?, alternates, role?,
// name?, description? }`) at `record.targets[index]` to the artifact's
// Target shape (`{ locators, description?, role?, name? }`, artifact.mjs's
// parseTarget). `alternates` is itself cleanArray'd defensively -- TRACE.md
// doesn't call this array out by name in its truncation examples, but the
// same array-keeps-its-type rule applies recursively to any nested array,
// and treating a stray trailing marker as a real TraceLocator would throw
// inside parseFlow's locator `kind` check rather than degrading gracefully.
//
// Fix-round-1 F12: when `alternates` is empty but `resolved` (the human-
// readable locator string from `Locator.normalize()`) is a non-empty
// string, that's TRACE.md's documented enrichment-FAILURE shape (`{ ref,
// resolved, alternates: [] }`) -- the ranked selector-candidate list never
// came back, but the resolved locator itself did. Falling all the way to
// `locators: []` here would throw away a perfectly replayable locator for
// no reason; `kind: 'other'` is the correct classification for a selector
// this reader doesn't otherwise recognize (mirrors `traceLocatorKind()`'s
// own `other` bucket in TRACE.md). Only fires when `alternates` itself is
// empty -- a non-empty `alternates` keeps the current verbatim mapping,
// `resolved` is never consulted when real candidates exist.
function targetFromRecord(record, index) {
  const { items } = cleanArray(record?.targets);
  const raw = items[index];
  if (!raw || typeof raw !== 'object') return { locators: [] };

  const { items: alternates } = cleanArray(raw.alternates);
  let locators = alternates
    .filter((alt) => alt && typeof alt === 'object' && typeof alt.kind === 'string' && typeof alt.selector === 'string')
    .map((alt) => ({ kind: alt.kind, selector: alt.selector }));

  if (locators.length === 0 && alternates.length === 0 && typeof raw.resolved === 'string' && raw.resolved.length > 0) {
    locators = [{ kind: 'other', selector: raw.resolved }];
  }

  const target = { locators };
  if (typeof raw.description === 'string') target.description = raw.description;
  if (typeof raw.role === 'string') target.role = raw.role;
  if (typeof raw.name === 'string') target.name = raw.name;
  return target;
}

// --- rule 7: waitAfter, plus the step-level `mutating` passthrough ---

// Shared by every op that supports `waitAfter`/`mutating` in the artifact
// schema (click, fill, select, press, hover, drag, upload -- everything
// `withInteractionExtras` in artifact.mjs accepts). `waitAfter` is set only
// when the record's own telemetry shows a settle wait actually happened
// (rule 7); `mutating` is the record's raw, per-action `mutating` field,
// passed through verbatim -- this is deliberately NOT identity-corrected
// the way the flow-level `sideEffects` rollup is (see `computeSideEffects`):
// the per-step field is a literal echo of what the trace observed for this
// one action, while identity-based gating is specifically a rollup concern
// (the commit message names it "identity-based side-effect gating" for a
// reason -- it governs the flow, not the step).
function applyInteractionExtras(step, record) {
  const waits = record?.waits;
  if (waits && (waits.awaitedRequests > 0 || waits.awaitedNavigation === true)) {
    step.waitAfter = { networkSettled: true };
  }
  if (typeof record?.mutating === 'boolean') step.mutating = record.mutating;
  return step;
}

// --- rule 4: parameter lifting state ---

// Tracks every literal lifted so far in this flow, in both directions:
// `usedNames` (argName -> the literal that first claimed it, for collision
// detection) and `argsByLiteral` (literal -> argName, so a later occurrence
// of the SAME literal -- whether another fill/select value, an upload path,
// or a goto URL segment/query value -- reuses the same arg instead of
// minting a new one). `args` accumulates the flow's `args` map entries
// directly as they're claimed. Every lift in this module (fill/select
// literals AND upload paths, fix-round-1 F2) goes through this one
// registry via `liftWithBaseName`/`claimArgName` -- there is no
// registry-bypassing code path left that could silently collide two
// different literals onto the same arg name.
function createLiftState() {
  return {
    usedNames: new Map(),
    argsByLiteral: new Map(),
    args: {},
  };
}

function argNameFromTarget(target) {
  const label = target?.name ?? target?.description;
  if (!label) return null;
  const slug = slugify(label);
  return slug || null;
}

// Reserves `baseName` for `literal`, resolving a collision with a
// DIFFERENT literal by trying baseName2, baseName3, ... (rule 4: "deduped
// with numeric suffixes"). A collision with the SAME literal under the same
// base name is not possible here since callers check `argsByLiteral` first
// (see `liftWithBaseName`) and short-circuit to the existing arg before
// ever calling this.
function claimArgName(baseName, literal, state) {
  if (!state.usedNames.has(baseName)) {
    state.usedNames.set(baseName, literal);
    state.argsByLiteral.set(literal, baseName);
    state.args[baseName] = { type: 'string', required: true };
    return baseName;
  }
  let suffix = 2;
  let candidate = `${baseName}${suffix}`;
  while (state.usedNames.has(candidate)) {
    suffix += 1;
    candidate = `${baseName}${suffix}`;
  }
  state.usedNames.set(candidate, literal);
  state.argsByLiteral.set(literal, candidate);
  state.args[candidate] = { type: 'string', required: true };
  return candidate;
}

// Shared entry point for every lift in this module (fill/select literals,
// upload paths -- fix-round-1 F2): reuse the arg already claimed for this
// exact literal if one exists, otherwise claim `baseName` (deduping with a
// numeric suffix per `claimArgName`). Callers own their own eligibility
// filters (length/boolean exclusion for fill/select; upload paths have
// none, per ruling b) -- this function itself never rejects a literal.
function liftWithBaseName(literal, baseName, state) {
  const existing = state.argsByLiteral.get(literal);
  if (existing) return existing;
  return claimArgName(baseName, literal, state);
}

// Rule 4's lift filter: literals shorter than 2 chars, and the string
// booleans `browser_fill_form` uses for checkbox/radio fields ("true"/
// "false"), are not lifted (they stay as literal step values -- these are
// legitimate short/boolean data, not missing data). There is no separate
// "value came from the page rather than params" check here -- this module
// only ever reads literal values out of `record.params` (never `record.code`
// or a tool's response), so that exclusion holds by construction rather
// than by an explicit runtime test.
//
// Fix-round-1 "ADOPTED F7": when the target has no usable accessible name
// (missing target, empty slug, or a fill_form field/target count mismatch
// that degrades `targetFromRecord` to `{ locators: [] }`), this used to
// leave the literal un-lifted -- which meant a real captured value (an
// email, a coupon code, anything) could survive VERBATIM into the compiled
// artifact. No captured literal is allowed to do that: when there's no
// name to derive from, it still lifts, under a positional fallback name
// ('value', 'value2', ... -- claimed through the same registry as every
// other lift, so it still dedupes/reuses correctly against named lifts).
function liftLiteral(literal, target, state) {
  if (typeof literal !== 'string' || literal.length < 2) return null;
  if (literal === 'true' || literal === 'false') return null;

  const targetBase = argNameFromTarget(target);
  const baseName = targetBase ? camelize(targetBase) : 'value';
  return liftWithBaseName(literal, baseName, state);
}

function fillLikeValue(literal, target, state) {
  const argName = liftLiteral(literal, target, state);
  if (argName) return `{${argName}}`;
  return typeof literal === 'string' ? literal : '';
}

// --- rule 4c: goto URL path/query lifting ---

// Tokenizes `pathname` against literals ALREADY lifted from fill/select
// values in this same flow (`state.argsByLiteral`) -- never mints a brand
// new arg from a bare path segment. A goto record carries no enriched
// target (browser_navigate is not one of TRACE.md's seven target-enriched
// tools), so rule 4's naming source ("the target's accessible name/
// description") has nothing to draw from for a URL segment on its own; the
// only well-defined name available is one a fill/select step already
// established for the identical literal. This is also exactly what the
// step-1 test wording implies: "urlPattern tokenized IF the nav URL
// contained A LIFTED literal" -- i.e. a literal lifted elsewhere, reused
// here, not an independent lift.
function tokenizePath(pathname, state) {
  const segments = pathname.split('/');
  const templated = [];
  const pattern = [];
  for (const segment of segments) {
    if (segment === '') {
      templated.push(segment);
      pattern.push(segment);
      continue;
    }
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // Malformed percent-encoding: compare the raw segment instead of
      // throwing out of a compile step over one cosmetic mismatch.
    }
    const argName = state.argsByLiteral.get(decoded);
    if (argName) {
      templated.push(`{${argName}}`);
      pattern.push(`:${argName}`);
    } else {
      templated.push(segment);
      pattern.push(segment);
    }
  }
  return { templatedPath: templated.join('/'), patternPath: pattern.join('/') };
}

// Fix-round-1 F3: query-string values now get the same treatment as path
// segments. Deliberately does NOT round-trip through `URLSearchParams`'s
// `.toString()` -- that would percent-encode the `{argName}`/`:argName`
// placeholder punctuation and corrupt it. Instead this splits the raw
// `search` string on `&`/`=` by hand (never re-encoding anything), decodes
// only each value in isolation to compare it against already-lifted
// literals (mirroring how `tokenizePath` decodes a path segment before
// comparing it), and substitutes the WHOLE matched value -- an exact match
// per `key=value` pair, not a blind substring replace, so a lifted literal
// that happens to be a prefix of some unrelated, longer query value (e.g.
// lifted "SAVE10" vs. an unrelated "SAVE100" elsewhere in the string) can
// never be partially/incorrectly replaced. Every other pair, and anything
// that isn't a clean `key=value` pair, is carried through byte-for-byte.
function tokenizeQuery(search, state) {
  if (!search || search.length <= 1) return { templatedQuery: search ?? '', patternQuery: search ?? '' };

  const pairs = search.slice(1).split('&');
  const templated = [];
  const pattern = [];
  for (const pair of pairs) {
    const eqIndex = pair.indexOf('=');
    if (eqIndex === -1) {
      templated.push(pair);
      pattern.push(pair);
      continue;
    }
    const key = pair.slice(0, eqIndex);
    const rawValue = pair.slice(eqIndex + 1);
    let decoded = rawValue;
    try {
      decoded = decodeURIComponent(rawValue);
    } catch {
      // Malformed percent-encoding: compare the raw value instead.
    }
    const argName = state.argsByLiteral.get(decoded);
    if (argName) {
      templated.push(`${key}={${argName}}`);
      pattern.push(`${key}=:${argName}`);
    } else {
      templated.push(pair);
      pattern.push(pair);
    }
  }
  return { templatedQuery: `?${templated.join('&')}`, patternQuery: `?${pattern.join('&')}` };
}

// Builds one `goto` step per `browser_navigate` record. The step's `url`
// keeps its fragment verbatim while path segments AND query values get
// `{argName}` templated wherever they match an already-lifted literal
// (matching the fill/select `value` placeholder syntax, per the
// flows-artifact.test.mjs baseFlow fixture's own `{ op: 'goto', url:
// '/checkout/{plan}' }` example). Returns `urlInfo: { origin, patternPath }`
// for the FIRST goto in a segment to seed the flow's top-level `origin`/
// `urlPattern` (rule 9) -- callers only use `urlInfo` from the first goto
// they see.
//
// Fix-round-2 N1 (controller ruling): `urlPattern` is PATH-ONLY -- no query,
// no hash. `urlPattern` exists for retrieval MATCHING (Task 6 matches it
// against a live page's URL, conventionally path-only), while replay
// fidelity -- including the tokenized query string -- lives entirely in the
// step's own `url`. Fix-round-1's F3 fix mistakenly folded the tokenized
// query into `urlInfo.patternPath` too, which both violated that contract
// and changed flow NAMING for any query-bearing nav with no click
// (`pathRootSlug` would slugify the raw `?query&string` text along with the
// real path root). `patternPath` here is therefore the tokenized PATH alone
// (via `tokenizePath`); `tokenizeQuery`'s `patternQuery` is computed only to
// feed the step's own `url` construction below it, never `urlInfo`.
//
// Fix-round-1 "ADOPTED F8": a `browser_navigate` record with a missing or
// unparseable `params.url` used to fall back to a fabricated `goto /` step
// -- a URL the trace never actually visited. That's exactly the kind of
// silent fabrication F8 rules out; this now throws `InvalidRecordError`
// instead, which `compileSegment` catches and turns into an `invalid: ...`
// skip for the whole segment.
function buildGotoStep(record, state) {
  const parsed = safeParseUrl(record?.params?.url);
  if (!parsed) throw new InvalidRecordError('browser_navigate missing or unparseable params.url');

  const { templatedPath, patternPath } = tokenizePath(parsed.pathname, state);
  const { templatedQuery } = tokenizeQuery(parsed.search, state);
  const url = `${templatedPath}${templatedQuery}${parsed.hash}`;
  return {
    step: { op: 'goto', url },
    urlInfo: { origin: parsed.origin, patternPath },
  };
}

// --- rule 6: js steps ---

// `record.script` is `undefined` for every tool except browser_run_code_
// unsafe, and can itself collapse to a bare truncation marker (TRACE.md's
// object-collapse marker) when even its shrunk-down form didn't fit its
// write-time budget -- the "legacy bare-marker script" shape the hostile
// golden fixture (trace-1754350100000) exercises. Either case -- missing or
// opaque -- compiles to `sha256: null`, which `parseFlow` accepts (Task 3)
// and which forces the flow to the 'pending' replay tier regardless of
// `sideEffects` (flowTier, artifact.mjs) since an opaque script can never be
// auto-approved.
function buildJsStep(record) {
  const script = record?.script;
  if (script && !isTruncationMarker(script) && typeof script.sha256 === 'string' && SHA256_HEX.test(script.sha256)) {
    const args = script.args && typeof script.args === 'object' && !Array.isArray(script.args) ? script.args : {};
    return { op: 'js', sha256: script.sha256, args };
  }
  return { op: 'js', sha256: null, args: {} };
}

// --- rule 9: naming ---

function pathRootSlug(urlPattern) {
  const first = urlPattern.split('/').filter(Boolean)[0];
  if (!first) return null;
  const slug = slugify(first.replace(/^:/, ''));
  return slug || null;
}

// The "dominant verb": the target label of the LAST click step in the
// segment, preferring a click whose own record was network-mutating (the
// "POST click" rule 9's worked example describes) over a merely-present
// one. `place-order` from a POST click's target name "Place order" is the
// literal pinned case (session-basic); a read-only flow with no mutating
// click at all still gets a name from its last click, if any (e.g. the
// read-only fixture's "View details").
function dominantVerbSlug(clickEntries) {
  let mutatingCandidate = null;
  let anyCandidate = null;
  for (const { record, target } of clickEntries) {
    const label = target?.name ?? target?.description;
    if (!label) continue;
    const slug = slugify(label);
    if (!slug) continue;
    anyCandidate = slug;
    if (record.mutating === true) mutatingCandidate = slug;
  }
  return mutatingCandidate ?? anyCandidate;
}

// Strict priority tiers (see the module-level v1-semantics note): tier 1
// wins outright the moment it produces a name, never blended/scored against
// tiers 2/3.
function resolveName(dominantVerb, urlPattern, epochMs, segmentIndex) {
  if (dominantVerb) return dominantVerb;
  const root = pathRootSlug(urlPattern);
  if (root) return root;
  return `flow-${epochMs}-${segmentIndex}`;
}

function sessionEpochMs(meta) {
  const parsed = Date.parse(meta?.startedAt ?? meta?.endedAt ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

// --- provenance / compiledAt (global constraint: no Date.now() in here) ---

// `compiledAt` comes from `meta.endedAt` (the session's own recorded clean-
// close time, TRACE.md) when present. A session that ended without a clean
// close (crash, kill -9) has no `endedAt` -- for that case (or a null
// `meta`, e.g. a trace with missing/corrupt meta.json per trace-reader's
// `listTraceSessions`), the caller must supply `now` -- a `() => Date`
// clock, matching this codebase's existing convention (lib/commands/
// setup.mjs, lib/commands/configure.mjs) -- or a plain ISO string. Compiling
// a flow with neither available throws `CompileError` rather than
// fabricating a timestamp -- deliberately NOT caught by `compileSegment`'s
// FlowError/InvalidRecordError safety net (see the module-level doc
// comment): this is a caller-wiring gap, not hostile trace data.
function resolveCompiledAt(meta, now) {
  if (meta && typeof meta.endedAt === 'string') return meta.endedAt;
  if (typeof now === 'function') {
    const value = now();
    return value instanceof Date ? value.toISOString() : value;
  }
  if (typeof now === 'string') return now;
  throw new CompileError('compileSession: compiledAt requires meta.endedAt or a caller-supplied now');
}

// --- rule 5: side effects ---

function computeSideEffects(records) {
  for (const record of records) {
    if (record.mutating === true) return 'mutating';
    if (MUTATING_BY_IDENTITY.has(record.tool)) return 'mutating';
  }
  return 'read-only';
}

// --- rule 1 (unsupported-tool half) ---

// Controller ruling (Task 3 review, ruling d/a): a segment containing any of
// these is skipped wholesale rather than silently dropping just the one
// record, because these tools change page/session state with no step
// mapping -- compiling around them would produce a flow that replays a
// DIFFERENT sequence of actions than the trace actually performed.
function findUnsupportedReason(records) {
  for (const record of records) {
    if (UNSUPPORTED_TOOLS.has(record.tool)) return `unsupported: ${record.tool}`;
    if (record.tool === 'browser_tabs' && record.params?.action !== 'list') return 'unsupported: browser_tabs';
    if (record.tool === 'browser_select_option') {
      const values = record.params?.values;
      if (Array.isArray(values) && values.length > 1) return 'unsupported: multi-select';
    }
  }
  return null;
}

// --- rule 1 (segmentation) ---

// Walks the session's records once, producing an ordered list of units in
// chronological order: `{ type: 'segment', records, truncatedByError }` for
// a contiguous span to attempt compiling, or `{ type: 'error', record }`
// for a record whose `error` field ends the segment at the previous record
// (rule 1). A segment starts at a `browser_navigate` or the first record,
// and closes right before a `browser_navigate` whose URL origin differs
// from the segment's established origin, or at end of trace.
//
// Fix-round-1 F4 (origin re-latch): a segment's `currentOrigin` can start
// out unresolved (`null`) -- e.g. its first record is not a navigate and its
// `urlBefore`/`urlAfter` are both unparseable. The ORIGINAL code never
// re-armed `currentOrigin` once a LATER navigate within that same segment
// finally resolved a real origin (the origin-change check itself required
// `currentOrigin` to already be non-null), so a genuine origin change after
// that point could never be detected -- two truly different-origin spans
// would silently collapse into one wrongly-anchored flow. Fixed: the first
// time a navigate resolves an origin while `currentOrigin` is still `null`,
// that origin is LATCHED (adopted, no split -- there was nothing to split
// from). Only once `currentOrigin` is non-null does a differing navigate
// origin trigger a split, exactly as before.
//
// The error case: `record.error` is checked immediately after the record is
// tentatively appended to `current`. If set, that record is popped back off
// (it never compiles -- "failed exploration doesn't compile") and reported
// as its own always-too-short (0 compiled actions), always-`error-truncated`
// unit, positioned exactly where it occurred. Whatever preceded it flushes
// as an ordinary segment, evaluated on its own merits (unsupported, or a
// real flow) -- EXCEPT fix-round-1 F5: if that preceding fragment turns out
// to be too short (rule 1's own text: "reason error-truncated IF THAT
// LEAVES IT TOO SHORT"), its skip reason is `error-truncated`, not the
// generic `too-short`, since the shortness is a direct consequence of the
// error truncating it rather than the trace simply containing few actions.
// `flush(truncatedByError)` tags each segment unit with this so
// `compileSegment` (see below) can pick the right reason. See
// task-4-report.md for the fuller reasoning trail across both review
// rounds.
function splitIntoUnits(records) {
  const units = [];
  let current = [];
  let currentOrigin = null;

  const flush = (truncatedByError = false) => {
    if (current.length > 0) units.push({ type: 'segment', records: current, truncatedByError });
    current = [];
  };

  for (const record of records) {
    if (record.tool === 'browser_navigate') {
      const navOrigin = safeOrigin(record.params?.url);
      if (current.length === 0) {
        currentOrigin = navOrigin;
      } else if (currentOrigin === null) {
        currentOrigin = navOrigin; // re-latch: adopt the first resolvable origin seen mid-segment
      } else if (navOrigin && navOrigin !== currentOrigin) {
        flush();
        currentOrigin = navOrigin;
      }
      current.push(record);
    } else {
      if (current.length === 0) currentOrigin = safeOrigin(record.urlBefore) ?? safeOrigin(record.urlAfter);
      current.push(record);
    }

    if (typeof record.error === 'string') {
      current.pop();
      flush(true);
      units.push({ type: 'error', record });
      currentOrigin = null;
    }
  }
  flush();

  return units;
}

// --- per-record step building ---

// Builds every step EXCEPT `goto` (which needs a second pass -- see
// `buildFlowFromRecords` -- since a segment's fill/select values are only
// fully known after a full first pass, but the navigate that needs them
// usually comes first in record order). Returns null for a record that maps
// to no step (an observation-only `browser_wait_for` with neither `time`
// nor a step-worthy outcome), in which case the caller emits nothing for
// this record but it still counted toward the action-record threshold
// (rule 1) purely by tool identity, checked earlier in `compileSegment`.
// Throws `InvalidRecordError` for a degenerate record whose params have no
// usable value to compile a truthful step from (fix-round-1 "ADOPTED F8") --
// an empty/missing `value` is fine (a legitimate "clear this field"), a
// MISSING one is not.
function buildNonGotoStep(record, state) {
  switch (record.tool) {
    case 'browser_click': {
      const target = targetFromRecord(record, 0);
      return applyInteractionExtras({ op: 'click', target }, record);
    }
    case 'browser_type': {
      const target = targetFromRecord(record, 0);
      if (typeof record.params?.text !== 'string') {
        throw new InvalidRecordError('browser_type missing params.text');
      }
      const value = fillLikeValue(record.params.text, target, state);
      return applyInteractionExtras({ op: 'fill', target, value }, record);
    }
    case 'browser_select_option': {
      const target = targetFromRecord(record, 0);
      const values = record.params?.values;
      if (!Array.isArray(values) || values.length === 0 || typeof values[0] !== 'string') {
        throw new InvalidRecordError('browser_select_option missing or empty params.values');
      }
      const value = fillLikeValue(values[0], target, state);
      return applyInteractionExtras({ op: 'select', target, value }, record);
    }
    case 'browser_press_key': {
      if (typeof record.params?.key !== 'string') {
        throw new InvalidRecordError('browser_press_key missing params.key');
      }
      return applyInteractionExtras({ op: 'press', key: record.params.key }, record);
    }
    case 'browser_hover': {
      const target = targetFromRecord(record, 0);
      return applyInteractionExtras({ op: 'hover', target }, record);
    }
    case 'browser_drag': {
      const target = targetFromRecord(record, 0);
      const to = targetFromRecord(record, 1);
      return applyInteractionExtras({ op: 'drag', target, to }, record);
    }
    case 'browser_run_code_unsafe':
      return buildJsStep(record);
    case 'browser_wait_for': {
      // Controller ruling c: params.time is SECONDS, the wait step's value
      // is MILLISECONDS. text/textGone-only calls (no `time` at all) are an
      // observation with no step (segment continues; nothing to build
      // here).
      //
      // Fix-round-2 N3: `time` PRESENT but not a finite number (wrong type
      // -- e.g. the string `'2'` -- or NaN/Infinity) used to fall straight
      // through to `return null` below, silently dropping the wait and
      // fabricating a pause-free segment -- inconsistent with F8's "never
      // fabricate" rule. Presence of `time` now commits this record to
      // being a time-based wait; if it isn't a genuine finite number, that
      // is degenerate input and throws, same as F8's other cases. A
      // NEGATIVE finite time (e.g. -5) is deliberately NOT caught here --
      // it still builds a wait step and is rejected by `parseFlow`'s own
      // non-negative check downstream (fix-round-1 F1's generic catch), a
      // clean, already-correct rejection path with its own clear message.
      const rawTime = record.params?.time;
      if (rawTime !== undefined) {
        if (!Number.isFinite(rawTime)) {
          throw new InvalidRecordError('browser_wait_for has a non-finite params.time');
        }
        return { op: 'wait', value: rawTime * 1000 };
      }
      return null;
    }
    default:
      return null;
  }
}

// browser_fill_form produces one step per target (rule 2), zipped
// positionally against `params.fields` -- TRACE.md guarantees both are in
// the same field order. Throws `InvalidRecordError` for any field with no
// usable `value` (fix-round-1 F8), aborting the whole segment rather than
// fabricating that one field's step.
function buildFillFormSteps(record, state) {
  const fields = Array.isArray(record.params?.fields) ? record.params.fields : [];
  return fields.map((field, index) => {
    const target = targetFromRecord(record, index);
    if (typeof field?.value !== 'string') {
      throw new InvalidRecordError('browser_fill_form field missing value');
    }
    const value = fillLikeValue(field.value, target, state);
    return applyInteractionExtras({ op: 'fill', target, value }, record);
  });
}

// Controller ruling b: upload paths are ALWAYS lifted into args (never
// baked as literals -- an absolute local path from the machine that
// captured the trace has no reason to exist on the machine that replays
// it). Fix-round-1 F2: each path is claimed through the SAME
// `liftWithBaseName`/`claimArgName` registry every other lift uses (fill/
// select values, goto URL segments), requesting the base name `'file'` --
// this is what makes `'file'`, `'file2'`, `'file3'`, ... naturally fall out
// of `claimArgName`'s own collision-suffix logic (spanning multiple
// `browser_file_upload` records in one flow, or multiple paths in one
// call) AND what prevents an upload from colliding with -- and silently
// overwriting -- an unrelated arg a fill/select step already named `file`.
// Upload steps carry no `target` (browser_file_upload is never one of
// TRACE.md's seven target-enriched tools, and artifact.mjs makes the field
// optional for exactly this case).
function buildUploadStep(record, state) {
  const paths = Array.isArray(record.params?.paths) ? record.params.paths.filter((p) => typeof p === 'string') : [];
  if (paths.length === 0) return null;
  const files = paths.map((filePath) => `{${liftWithBaseName(filePath, 'file', state)}}`);
  return applyInteractionExtras({ op: 'upload', files }, record);
}

// --- flow assembly ---

// First pass over a segment's records: builds every step (goto steps get a
// literal placeholder now, tokenized properly in the second pass once
// `state` -- the lift map -- is complete), and records enough about each
// click step (its record + resolved target) for `dominantVerbSlug` to pick
// the flow's name without a third pass.
function buildFlowFromRecords(records, state) {
  const entries = []; // { record, step } in original order; goto steps get patched below
  const clickEntries = [];

  for (const record of records) {
    if (!TOOL_OPS.has(record.tool)) continue;

    if (record.tool === 'browser_navigate') {
      entries.push({ record, step: null }); // patched in the second pass
      continue;
    }
    if (record.tool === 'browser_fill_form') {
      for (const step of buildFillFormSteps(record, state)) entries.push({ record, step });
      continue;
    }
    if (record.tool === 'browser_file_upload') {
      const step = buildUploadStep(record, state);
      if (step) entries.push({ record, step });
      continue;
    }

    const step = buildNonGotoStep(record, state);
    if (step) {
      entries.push({ record, step });
      if (record.tool === 'browser_click') {
        clickEntries.push({ record, target: step.target });
      }
    }
  }

  // Second pass: now that every fill/select literal is lifted, resolve
  // goto steps against the complete lift map (rule 4c) and capture the
  // FIRST goto's origin/urlPattern for the flow overall (rule 9).
  let firstUrlInfo = null;
  for (const entry of entries) {
    if (entry.record.tool !== 'browser_navigate') continue;
    const { step, urlInfo } = buildGotoStep(entry.record, state);
    entry.step = step;
    if (!firstUrlInfo && urlInfo) firstUrlInfo = urlInfo;
  }

  const steps = entries.map((entry) => entry.step);
  return { steps, clickEntries, firstUrlInfo };
}

function resolveOriginAndPattern(firstUrlInfo, records, fallbackOrigin) {
  if (firstUrlInfo) return { origin: firstUrlInfo.origin, urlPattern: firstUrlInfo.patternPath || '/' };

  // No navigate in this segment (rule 1: a segment can start at "the first
  // record" too) -- fall back to the first record's own urlBefore/urlAfter,
  // then to the caller-supplied `origin` option (`compileSession`'s
  // fallback -- see its own doc comment).
  const first = records[0];
  const parsed = safeParseUrl(first?.urlBefore) ?? safeParseUrl(first?.urlAfter);
  if (parsed) return { origin: parsed.origin, urlPattern: parsed.pathname || '/' };
  return { origin: fallbackOrigin, urlPattern: '/' };
}

// Builds and validates one compiled Flow from a segment already cleared for
// compilation (past the unsupported-tool and too-short checks in
// `compileSegment`). Returns null if the segment produces zero actual steps
// despite clearing the action-record threshold (e.g. two `browser_wait_for`
// calls that are both text/textGone-only observations) -- the caller treats
// that the same as `too-short`. May throw `InvalidRecordError` (degenerate
// record params) or `FlowError` (a `parseFlow` rejection -- unresolvable/
// non-http origin, negative wait value, missing seq, ...); both are caught
// one level up in `compileSegment`.
function buildFlow(records, { meta, fallbackOrigin, traceDir, now, segmentIndex, seqRange }) {
  const state = createLiftState();
  const { steps, clickEntries, firstUrlInfo } = buildFlowFromRecords(records, state);
  if (steps.length === 0) return null;

  const { origin, urlPattern } = resolveOriginAndPattern(firstUrlInfo, records, fallbackOrigin);
  const sideEffects = computeSideEffects(records);
  const name = resolveName(dominantVerbSlug(clickEntries), urlPattern, sessionEpochMs(meta), segmentIndex);
  const description = buildDescription(origin, steps);

  // Rule 8: v1 never compiles an `extract` step (ruling e), so this always
  // resolves to 'completion' in practice -- implemented as written anyway
  // so a future hand-authored/extended flow with real extract steps is
  // still classified correctly by the same logic.
  const extractKeys = steps.filter((step) => step.op === 'extract').map((step) => step.as);
  const result = extractKeys.length > 0 ? { kind: 'extracts', keys: extractKeys } : { kind: 'completion', keys: [] };

  const provenance = {
    compiledAt: resolveCompiledAt(meta, now),
    traceDir: typeof traceDir === 'string' ? traceDir : '',
    seqRange,
    productVersion: typeof meta?.productVersion === 'string' ? meta.productVersion : '',
    successRuns: 0,
    failStreak: 0,
    lastHealed: null,
  };

  const candidate = {
    schemaVersion: FLOW_SCHEMA_VERSION,
    id: '0'.repeat(64), // placeholder; replaced by the real content hash below
    name,
    description,
    origin,
    urlPattern,
    sideEffects,
    args: state.args,
    result,
    steps,
    provenance,
  };
  candidate.id = flowId(candidate);
  return parseFlow(candidate); // may throw FlowError -- caught in compileSegment
}

// --- segment-level compile decision ---

// Fix-round-1 F1/F8: `buildFlow` can throw (a `parseFlow` schema rejection,
// or this module's own `InvalidRecordError` for degenerate params) on
// hostile-but-realistic trace input -- an `about:blank` navigate (present
// verbatim as `urlBefore` in this repo's own golden fixture), a segment
// with no resolvable origin at all, a non-http(s) scheme, an unparseable
// URL, a negative/NaN `wait_for` time, a record with no `seq`. NEITHER
// error type is allowed to escape `compileSession` -- both are caught here
// and turned into a skip, matching the trace reader's own "never throws on
// hostile input" contract.
function compileSegment(records, ctx, truncatedByError) {
  const seqRange = toSeqRange(records);
  const shortReason = truncatedByError ? 'error-truncated' : 'too-short';

  const unsupported = findUnsupportedReason(records);
  if (unsupported) return { skip: { reason: unsupported, seqRange } };

  const actionCount = records.filter((record) => TOOL_OPS.has(record.tool)).length;
  if (actionCount < 2) return { skip: { reason: shortReason, seqRange } };

  let flow;
  try {
    flow = buildFlow(records, { ...ctx, seqRange });
  } catch (error) {
    if (error instanceof FlowError || error instanceof InvalidRecordError) {
      return { skip: { reason: `invalid: ${error.message}`, seqRange } };
    }
    throw error;
  }
  if (!flow) return { skip: { reason: shortReason, seqRange } };
  return { flow };
}

// --- public API ---

// compileSession({ records, meta, origin?, traceDir?, now? }) ->
//   { flows: Flow[], report: { segments, skipped: [{ reason, seqRange }] } }
//
// `records` is Task 2's `readTraceRecords(sessionDir).records` (raw,
// v1-only TraceRecord objects, already stripped of unparseable lines --
// this module still has to tolerate per-field truncation markers within
// them, AND degenerate/hostile field values within an otherwise well-formed
// record -- see `compileSegment`'s doc comment). `meta` is
// `listTraceSessions`'s parsed meta.json (or null). `origin` is a fallback
// web origin used only when a segment can establish none of its own (no
// navigate, and no urlBefore/urlAfter on its first record). `traceDir` and
// `now` feed `provenance` (see `buildFlow`/`resolveCompiledAt`) -- neither
// is in the plan's abbreviated interface sketch, but `provenance.traceDir`
// and `provenance.compiledAt` are both required, non-derivable-from-
// `records` fields, so this module accepts them as additional, optional
// inputs rather than inventing placeholder values silently. See
// task-4-report.md.
//
// `report.segments` is the total count of segmentation outcomes considered
// (every produced flow plus every skip, error-truncated units included) --
// a summary number alongside `report.skipped`'s per-item detail. Not
// spelled out as a shape in the plan's interface sketch (which only
// annotates `skipped`), so this is a documented design choice, not a
// literal transcription.
//
// Never throws on trace input (records/meta), by contract -- see the
// module-level doc comment for the one deliberate exception (`CompileError`
// for a caller-wiring gap, not hostile data).
export function compileSession({ records, meta, origin, traceDir, now } = {}) {
  const allRecords = Array.isArray(records) ? records : [];
  const units = splitIntoUnits(allRecords);

  const flows = [];
  const skipped = [];
  let segmentIndex = 0;

  for (const unit of units) {
    if (unit.type === 'error') {
      skipped.push({ reason: 'error-truncated', seqRange: [toSeqValue(unit.record.seq), toSeqValue(unit.record.seq)] });
      continue;
    }
    const outcome = compileSegment(
      unit.records,
      { meta, fallbackOrigin: origin, traceDir, now, segmentIndex },
      unit.truncatedByError,
    );
    if (outcome.flow) flows.push(outcome.flow);
    else skipped.push(outcome.skip);
    segmentIndex += 1;
  }

  return { flows, report: { segments: flows.length + skipped.length, skipped } };
}
