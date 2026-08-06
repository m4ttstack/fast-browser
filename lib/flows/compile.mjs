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
//   MAT-137 (WS3b task 4) narrows one direction of this, but only for the
//   POSITIONAL-fallback shape: a goto's own path/query/fragment tokenizer
//   will not CONSULT a fill/select/upload literal that has no real name of
//   its own (`'value'`/`'value2'`/... or an upload path) purely because it
//   happens to share the same string as an unrelated URL value. A NAMED
//   fill/select literal (a real target label) is still consulted -- the
//   `fill {searchQuery} -> goto /search?q={searchQuery}` pattern is
//   intended, not coincidental (controller ruling, fix round 1). The
//   registry itself still collapses unconditionally regardless of source:
//   a goto value that independently qualifies as sensitive (MAT-136) still
//   reuses an already-claimed literal's arg name (named, positional, or
//   url) rather than minting a second one for the same literal; see
//   `urlLiftedArgName`'s doc comment for the exact rule.
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

// Final whole-branch review, I1: `browser_press_key` is telemetry-blind for
// every key EXCEPT plain 'Enter' -- the runtime's keyboard.ts routes only an
// Enter press through its network-observation wait (waitForCompletion), so
// any other press (`Control+Enter`, a single-letter shortcut, ...) always
// records `network: []` / `mutating: false` by construction, regardless of
// what it actually does on the page. Trusting that structural blindness
// would let a POST-firing non-Enter press compile as read-only and replay
// without approval -- a consent-seam gap the same shape as `record.mutating`
// alone always reading false for file_upload/drag/drop above. Closed the
// same way: a press whose `params.key` is anything other than exactly
// 'Enter' is mutating-by-identity. A plain 'Enter' press is network-observed
// and trustworthy, so it keeps its structural `record.mutating` flag instead
// of being forced.
function isMutatingByIdentity(record) {
  if (record.tool === 'browser_press_key') return record.params?.key !== 'Enter';
  return MUTATING_BY_IDENTITY.has(record.tool);
}

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
// MAT-137 (WS3b task 4): `literalSource` tracks, per lifted literal, WHERE
// it was lifted from, as one of three kinds:
//   - `'url'` -- a query key, path segment, or fragment part.
//   - `'input-named'` -- a fill/select value whose target had a real,
//     human-authored accessible name/description (`argNameFromTarget`
//     resolved to something).
//   - `'input-positional'` -- a fill/select value with NO nameable target
//     (the `'value'`/`'value2'`/... positional fallback), or an upload
//     path (which never carries a target at all, so it's positional by
//     construction, same as an unnamed fill).
// Controller ruling (fix round 1, this task): the WS2a "same-literal
// collapse" tests pin a real pattern -- a NAMED fill echoed into a later
// goto (`fill {searchQuery} -> goto /search?q={searchQuery}`) -- as
// INTENDED, not coincidental; a url-only restriction would break replay-
// with-different-args for that shape. Only `'input-positional'` (the
// unnamed-fallback shape MAT-137's own motivating example actually uses)
// is excluded from goto tokenization; `'url'` and `'input-named'` both
// still drive it. See `urlLiftedArgName` below for where this is
// consulted. This is compile-internal bookkeeping only -- the artifact
// schema (`args`) is unchanged, the tag never leaves this module.
function createLiftState() {
  return {
    usedNames: new Map(),
    argsByLiteral: new Map(),
    literalSource: new Map(),
    args: {},
  };
}

function argNameFromTarget(target) {
  const label = target?.name ?? target?.description;
  if (!label) return null;
  const slug = slugify(label);
  return slug || null;
}

// MAT-149: the flow-runner's `{arg}` substitution regex (builtins/macros/
// flow-runner.js's `TOKEN`) is `/\{([A-Za-z_][A-Za-z0-9_]*)\}/g` -- a
// letter or underscore must lead. Nothing upstream of `claimArgName`
// enforced that shape: a key-derived base name like `2faToken` (from a
// query key `2fa_token`, camelized the same as every other lift) is
// perfectly legal JS-object-key-wise but can never match that regex, so a
// step url baked as `{2faToken}` replays with the literal placeholder
// still in it -- the substitution silently never fires. `claimArgName` is
// every name source's single mint point (query keys, path segments,
// fragment parts, fill labels, positional fallbacks all funnel through
// `liftWithBaseName` into this one function), so sanitizing here closes
// all of them at once rather than patching each source. Plan Scope
// decision, binding: prefix a digit-leading name with `arg` and
// re-capitalize its original first character (kept, not dropped, so
// `arg2faToken` still traces back to `2faToken`) rather than stripping the
// leading digit, which would discard information and risks a different,
// harder-to-see collision.
function upperFirst(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function sanitizeArgName(name) {
  return /^[0-9]/.test(name) ? `arg${upperFirst(name)}` : name;
}

// Reserves `baseName` (sanitized first, see `sanitizeArgName` above) for
// `literal`, resolving a collision with a DIFFERENT literal by trying
// baseName2, baseName3, ... (rule 4: "deduped with numeric suffixes").
// Sanitizing here -- before the collision check, not after -- means a
// sanitized name that collides with an already-claimed arg (sanitized or
// not, e.g. `arg2faToken` already claimed by an unrelated fill labeled
// "Arg 2fa Token") runs through this SAME dedupe rather than silently
// overwriting it. A collision with the SAME literal under the same base
// name is not possible here since callers check `argsByLiteral` first (see
// `liftWithBaseName`) and short-circuit to the existing arg before ever
// calling this.
// `source` (MAT-137: `'url' | 'input-named' | 'input-positional'`) is
// recorded alongside the mint -- every caller of `liftWithBaseName` knows
// its own source kind and passes it through here unchanged; it plays no
// part in sanitizing or deduping the name itself (both untouched by this
// task).
function claimArgName(baseName, literal, state, source) {
  const name = sanitizeArgName(baseName);
  if (!state.usedNames.has(name)) {
    state.usedNames.set(name, literal);
    state.argsByLiteral.set(literal, name);
    state.literalSource.set(literal, source);
    state.args[name] = { type: 'string', required: true };
    return name;
  }
  let suffix = 2;
  let candidate = `${name}${suffix}`;
  while (state.usedNames.has(candidate)) {
    suffix += 1;
    candidate = `${name}${suffix}`;
  }
  state.usedNames.set(candidate, literal);
  state.argsByLiteral.set(literal, candidate);
  state.literalSource.set(literal, source);
  state.args[candidate] = { type: 'string', required: true };
  return candidate;
}

// Shared entry point for every lift in this module (fill/select literals,
// upload paths -- fix-round-1 F2): reuse the arg already claimed for this
// exact literal if one exists, otherwise claim `baseName` (deduping with a
// numeric suffix per `claimArgName`). Callers own their own eligibility
// filters (length/boolean exclusion for fill/select; upload paths have
// none, per ruling b) -- this function itself never rejects a literal.
//
// `source` (MAT-137: `'url' | 'input-named' | 'input-positional'`) is the
// caller's own lift-source kind, forwarded to `claimArgName` ONLY when this
// literal is being claimed for the first time. The REUSE branch
// deliberately does not touch or re-check `source`: the same-literal-
// collapse invariant above (one registry, dedup by literal) is
// unconditional and source-agnostic by design -- a literal already claimed
// keeps whichever tag it was first claimed under, regardless of what kind
// of caller reuses it next. This is what lets `liftLiteral` (fill/select,
// MAT-137 note there) later reuse an arg a goto tokenizer already
// url-lifted, and what lets a goto tokenizer that independently judges a
// value sensitive (MAT-136) still collapse it onto an arg a fill already
// claimed (named or positional -- see the `SENSITIVE_QUERY_KEY` note) --
// only the goto tokenizers' own BARE "already lifted, reuse blindly" check
// (`urlLiftedArgName` below) is gated on source; this shared mint point is
// not.
function liftWithBaseName(literal, baseName, state, source) {
  const existing = state.argsByLiteral.get(literal);
  if (existing) return existing;
  return claimArgName(baseName, literal, state, source);
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
//
// MAT-137: every literal this function lifts came from a fill/select value,
// never a URL -- but WHICH input flavor matters to goto tokenization
// (`urlLiftedArgName` below): `targetBase` present means a real,
// human-authored accessible name backs this literal (`'input-named'`); its
// absence means this is the positional `'value'`/`'value2'`/... fallback,
// which carries no such evidence of intent (`'input-positional'`).
function liftLiteral(literal, target, state) {
  if (typeof literal !== 'string' || literal.length < 2) return null;
  if (literal === 'true' || literal === 'false') return null;

  const targetBase = argNameFromTarget(target);
  const baseName = targetBase ? camelize(targetBase) : 'value';
  const source = targetBase ? 'input-named' : 'input-positional';
  return liftWithBaseName(literal, baseName, state, source);
}

function fillLikeValue(literal, target, state) {
  const argName = liftLiteral(literal, target, state);
  if (argName) return `{${argName}}`;
  return typeof literal === 'string' ? literal : '';
}

// --- rule 4c: goto URL path/query lifting ---

// MAT-137 (WS3b task 4): the goto tokenizers below (`tokenizePath`,
// `tokenizeQuery`, `tokenizeFragment`) may only reuse a literal whose lift
// source carries some evidence it's meaningful beyond this one flow's
// incidental text -- `'url'` (this same tokenizing machinery, tagged at
// claim time) or `'input-named'` (a fill/select value with a real,
// human-authored target label). A `'input-positional'` literal -- no
// nameable target at all, e.g. an unnamed fill or an upload path -- is
// excluded: MAT-137's own motivating example is exactly this shape (an
// UNNAMED fill of `gold` turning an unrelated `/plans/gold` goto into
// `/plans/{value}` by pure coincidence -- deterministic, but wrong, since a
// nameless literal says nothing about URL structure). This helper is the
// single gate for that "already lifted, reuse blindly" check every
// tokenizer makes before falling through to its own sensitivity check
// (MAT-136).
//
// Controller ruling (fix round 1, this task): a NAMED fill's literal is
// NOT excluded, even though it's just as "input-sourced" as a positional
// one. The name is itself evidence of intent -- `fill {searchQuery} ->
// goto /search?q={searchQuery}` is the ordinary search-query
// parameterization pattern, not a coincidence, and 3 pre-existing WS2a
// tests pin exactly this as desired. The accepted residual: a NAMED input
// literal that collides with an UNRELATED URL token purely by chance (a
// customer types "2026" into some field, and a goto elsewhere happens to
// contain "2026" for an unrelated reason) still tokenizes that goto too --
// the name-derived arg is treated as reason enough, the same way any two
// occurrences of an identical named-fill literal already collapse onto one
// arg regardless of context (see the module-level "Same-literal collapse"
// note). Only the nameless/positional shape is treated as too weak a
// signal to drive URL structure.
//
// Deliberately does NOT touch `liftWithBaseName`'s own same-literal-
// collapse registry (see its doc comment): a literal that independently
// qualifies as sensitive under the URL rules still collapses onto
// whatever arg already claimed it, regardless of that arg's source -- e.g.
// a sensitive-query-key value that was also typed into a form field
// earlier (named OR positional) reuses that fill's arg name rather than
// minting a second one. Only the BARE reuse check here is source-gated.
function urlLiftedArgName(literal, state) {
  const argName = state.argsByLiteral.get(literal);
  if (!argName) return undefined;
  const source = state.literalSource.get(literal);
  if (source === 'url' || source === 'input-named') return argName;
  return undefined;
}

// Tokenizes `pathname` against literals ALREADY lifted from a url-sourced or
// NAMED-input occurrence elsewhere in this same flow (`urlLiftedArgName`
// above, MAT-137) -- never mints a brand new arg from a bare path segment
// purely because it matches an unrelated POSITIONAL fill/select/upload
// literal (no name of its own to justify the match). A goto record carries
// no enriched target (browser_navigate is not one of TRACE.md's seven
// target-enriched tools), so rule 4's naming source ("the target's
// accessible name/description") has nothing to draw from for a URL segment
// on its own; the only well-defined name available is one a url-sourced or
// named-input occurrence already established for the identical literal, or
// (Task 7, MAT-136) a fresh sensitivity-based lift right here.
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
    let argName = urlLiftedArgName(decoded, state);
    // Task 7 (MAT-136): a segment never seen in a fill/select still lifts
    // here, under the SAME positional fallback name `liftLiteral` uses for
    // a nameless fill ('value', 'value2', ...), when it looks like a
    // single-use token rather than ordinary path data -- see the
    // module-level Task 7 note above `SENSITIVE_QUERY_KEY` for the full
    // rule and rationale.
    if (!argName && isSensitiveUrlValue(decoded, null)) {
      argName = liftWithBaseName(decoded, 'value', state, 'url');
    }
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
// Task 7 (MAT-136 folded debt): sensitive-value lifting for goto URLs.
//
// Rule 4c above (`tokenizePath`/`tokenizeQuery`) only tokenizes a goto URL
// segment/value against a literal ALREADY lifted from a fill/select/upload
// elsewhere in the flow -- it never mints a new arg from a bare URL value
// on its own. That's exactly right for ordinary data (a plan slug, a
// coupon code typed in a form and later echoed in the URL) but wrong for a
// single-use magic-link/session token: a captured `?token=<jwt>` or
// `/magic/<opaque>` was never typed anywhere, so under rule 4c alone it
// would bake VERBATIM into the compiled flow file -- exactly the
// artifact-persists-a-secret shape `redactScriptArgs` (I2, rule 6) already
// refuses to allow for js-step args. This extends the SAME lifting
// registry (`claimArgName`/`argsByLiteral`, via `liftWithBaseName`) one
// step further: a query value or path segment that ISN'T already lifted is
// additionally lifted -- as a REQUIRED arg, same as every other lift --
// when it looks like a credential rather than ordinary data. Two
// independent triggers, either sufficient on its own (plan-binding):
//   - the query KEY names a well-known credential slot (token/key/code/
//     auth/session/sig/signature/secret/ticket/otp, case-insensitive) --
//     a positive identity signal that needs no entropy check (a
//     4-character `?code=abc123` is still a single-use code); OR
//   - the VALUE itself is high-entropy: 20+ chars, drawn only from the
//     URL-safe unreserved alphabet, containing both a letter and a digit,
//     and not hyphen-heavy (fix round 1, F3: length/charset/letter+digit
//     ALONE turned out not to be enough -- a human-authored slug like
//     "top-10-things-to-do-in-2026" or "annual-report-2024.pdf" clears all
//     three just as easily as a real token does; hyphen density is what
//     actually tells them apart, see `isHighEntropyValue` below).
// Naming mirrors rule 4's own priority: a query value takes its arg's base
// name from the query KEY (matching the worked "arg `token`" case) since a
// key is always present for a clean `key=value` pair; a path segment has
// no key at all, so `tokenizePath` falls back to the SAME positional
// 'value'/'value2'/... name `liftLiteral` already uses for a fill with no
// nameable target -- both routes go through the identical `claimArgName`
// registry, so a positional path lift can never collide with (or
// duplicate) an unrelated positional fill lift.
//
// `urlPattern` stays path-only exactly as fix-round-2 N1 requires: this
// sensitivity check runs inside BOTH `tokenizePath` (feeds `patternPath`,
// i.e. `urlPattern`) and `tokenizeQuery` (feeds only `templatedQuery`, i.e.
// the step's own `url`) -- the same split rule 4c already enforces for an
// already-lifted literal. A sensitive QUERY value therefore never touches
// `urlPattern` or tier-2 naming (`pathRootSlug`), which keeps deriving from
// the clean path root regardless of what the query contains.
//
// Replay of a flow with a lifted token then demands a fresh value at run
// time -- correct, not a regression: the captured one was single-use by
// construction, and an arg with no default forces the caller to supply a
// current one instead of unknowingly replaying a dead credential.
const SENSITIVE_QUERY_KEY = /^(token|key|code|auth|session|sig|signature|secret|ticket|otp)$/i;
const HIGH_ENTROPY_VALUE = /^[A-Za-z0-9_.~-]+$/;

// Fix round 2, N1: a canonical UUID -- 36 chars, four hyphens at fixed
// positions (8-4-4-4-12 hex digits) -- is exempted from the hyphen
// discriminator below ENTIRELY. A UUID is THE canonical magic-link/
// password-reset-token shape (Rails/Devise and countless other frameworks
// mint reset and session tokens as UUIDs), and its four hyphens are a
// fixed structural property of the format, not a signal of human
// authorship the way a slug's hyphens are -- the F3 hyphen discriminator,
// applied without this exemption, silently regressed this exact shape
// (`/reset/3f2504e0-4f89-11d3-9a0c-0305e82c3301` baked fully literal). No
// human-authored slug matches this rigid a shape (hex-only digits at
// precise 8/4/4/4/12 widths), so the exemption cannot reopen F3's false
// positives -- it is checked FIRST, before any of the length/charset/
// hyphen checks below, since a valid UUID is unambiguously high-entropy on
// its own terms.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Fix round 1, F4 (documented residual, not fixed): a STANDARD-alphabet
// base64 value (using '+', '/', '=' rather than the URL-safe '-'/'_'
// alphabet -- e.g. a base64 blob pasted into a URL param without being
// re-encoded url-safe) never matches `HIGH_ENTROPY_VALUE` at all, so it
// stays literal when its query key is a non-sensitive one. Fix round 2,
// N3 confirmed this applies identically to a FRAGMENT value: a
// padded-base64 fragment value can't lift on entropy no matter which
// branch of `tokenizeFragment` it's classified into, because the '='
// padding character itself always fails this alphabet. Left as-is in both
// places: a sensitive KEY name (the branch below) still catches the
// common real case (an actual `token`/`code`/`secret`/... slot), so this
// is an accepted gap rather than a rule this task closes.
//
// Fix round 1, F3: length/charset/letter+digit alone over-fired on
// human-authored, hyphen-heavy slugs (the reviewer's four false positives:
// "top-10-things-to-do-in-2026" (6 hyphens), "nike-air-max-270-black" (4),
// "2024-01-15-release-notes" (4), "annual-report-2024.pdf" (2) -- all
// otherwise clear the length/charset/letter+digit bar just as a real token
// would). The discriminator excludes 2+ hyphens (tightened from an
// initially-proposed ">2" cutoff once the fourth reviewer shape, with
// exactly 2 hyphens, showed that cutoff wasn't tight enough to spare it) --
// except for a canonical UUID (`UUID_PATTERN` above), whose four hyphens
// are exempt entirely.
//
// Fix round 2, N4: this discriminator is BEST-EFFORT, not a precision
// instrument, and its false-negative rate is real -- not "rare" as an
// earlier version of this comment characterized it. Reviewer measurement:
// ~14% of HS256-length base64url tokens and ~39% of 86-char base64url
// tokens contain 2+ hyphens by chance alone, and now stay literal under a
// NON-sensitive query key (a UUID is exempted above, but an ordinary
// high-entropy token that happens to roll 2+ hyphens is not). The
// SENSITIVE-KEY branch in `isSensitiveUrlValue` below is this rule's
// PRIMARY net -- it fires on the param NAME, not the value's incidental
// shape, so it carries no such false-negative rate. This entropy branch
// exists only to catch what the key-name branch structurally cannot (an
// unnamed/oddly-named slot, a bare path segment, a fragment value), and is
// accepted as imperfect on that harder problem.
function isHighEntropyValue(value) {
  if (UUID_PATTERN.test(value)) return true;
  if (value.length < 20) return false;
  if (!HIGH_ENTROPY_VALUE.test(value)) return false;
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return false;
  const hyphenCount = (value.match(/-/g) || []).length;
  return hyphenCount < 2;
}

// `queryKey` is `null` for a path segment (no key exists); a well-known
// credential key name is sufficient on its own, otherwise the value must
// be high-entropy.
//
// Fix round 1, F2: the key-name branch used to skip straight to `true`
// with no eligibility check on the VALUE at all -- a degenerate, too-short
// value under a sensitive key (e.g. a hostile/truncated `?code=a`) would
// still lift and poison `state.argsByLiteral`, so a later, wholly
// unrelated URL elsewhere in the flow whose own path segment happened to
// equal that same short string (e.g. `/a/list`) would be silently
// tokenized against it too. Guarded with the same eligibility rule
// `liftLiteral` already applies to fill/select literals (min length 2, not
// the checkbox "true"/"false" strings) -- the entropy branch below never
// needs this guard itself, since `isHighEntropyValue`'s own 20-char floor
// already clears it.
function isSensitiveUrlValue(value, queryKey) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (queryKey && SENSITIVE_QUERY_KEY.test(queryKey)) {
    return value.length >= 2 && value !== 'true' && value !== 'false';
  }
  return isHighEntropyValue(value);
}

// Mirrors `argNameFromTarget`'s slugify -> camelize pipeline so a key like
// `token`/`session_id` becomes `token`/`sessionId`; falls back to the same
// positional `'value'` base name `liftLiteral` uses when there's nothing to
// derive a name from (an empty/unsluggable key -- doesn't happen for a
// well-formed `key=value` pair, kept for robustness against a hostile
// empty-key pair like `?=abc...`).
function queryKeyBaseName(key) {
  const slug = key ? slugify(key) : '';
  return slug ? camelize(slug) : 'value';
}

function tokenizeQuery(search, state) {
  if (!search || search.length <= 1) return { templatedQuery: search ?? '' };

  const pairs = search.slice(1).split('&');
  const templated = [];
  for (const pair of pairs) {
    const eqIndex = pair.indexOf('=');
    if (eqIndex === -1) {
      templated.push(pair);
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
    let argName = urlLiftedArgName(decoded, state);
    if (!argName && isSensitiveUrlValue(decoded, key)) {
      argName = liftWithBaseName(decoded, queryKeyBaseName(key), state, 'url');
    }
    if (argName) {
      templated.push(`${key}={${argName}}`);
    } else {
      templated.push(pair);
    }
  }
  return { templatedQuery: `?${templated.join('&')}` };
}

// Fix round 1, F1: the URL fragment used to pass through byte-for-byte
// (`parsed.hash`, untouched) -- an OAuth implicit-grant redirect bakes its
// access token verbatim into `#access_token=...`, and even a token already
// lifted from the QUERY left a literal, unsubstituted copy behind whenever
// the same value also showed up in the fragment (`?token=X#t=X`), which
// violates this task's own "the literal is absent from
// `JSON.stringify(flow)`" invariant just as surely as never lifting it at
// all. This applies the identical sensitivity rule to the fragment.
//
// Fix round 2, N3 (deviates from the literally-proposed fix -- see below):
// the round-1 version classified the WHOLE fragment in one shot -- "any
// `=` anywhere in the raw fragment" meant treat every `&`-part as a
// key=value pair. That misclassified a single opaque value with an
// incidental `=` in it (e.g. base64 `=` padding) as a pair with an empty
// "value" (or the whole thing as a "key" with nothing after it), so it
// never reached the entropy check a bare value gets. The fix round 2 ask
// was "query-shaped iff EVERY `&`-part has `=` with a non-empty key,
// otherwise treat the WHOLE fragment as one bare value" -- tried first,
// but it has two problems, both confirmed by hand-tracing before landing
// on the design below: (1) it doesn't even fix its own motivating case --
// a lone `<token>=x` part still has a non-empty key ("<token>"), so it's
// STILL classified as a pair, same as before; (2) worse, it's a regression
// risk for a REALISTIC mixed shape (`#token=<jwt>&debug`, a real param
// alongside a bare flag with no `=`): one non-pair-shaped part flips the
// ENTIRE fragment to "bare", which then evaluates the WHOLE raw string
// (now containing `&` and `=`, both outside `HIGH_ENTROPY_VALUE`'s
// alphabet) as one candidate -- losing a lift that round-1's per-pair loop
// already produced correctly for the legitimate `token=` part.
//
// The design below instead classifies PER PART, never the whole fragment
// at once -- structurally closer to `tokenizeQuery`, and avoiding both
// problems: each `&`-separated part is either a genuine key=value pair
// (non-empty key AND non-empty value around its first `=`) -- gets
// `tokenizeQuery`'s exact per-pair treatment -- or, for any part that
// ISN'T (no `=` at all, or `=` sitting at the very start/end with an
// empty key/value either side, e.g. base64 padding) -- gets evaluated as
// its OWN bare, unkeyed value. This closes both the original
// misclassification (a padded value's part now correctly reaches the bare
// check, even though -- fix round 1, F4 -- it still can't lift on
// entropy, since the `=` stays part of the candidate string either way)
// AND a second, previously-unnoticed gap: a bare, un-keyed part mixed in
// among real pairs (the `&debug`-style case above) used to be skipped
// with no entropy check at all (`eqIndex === -1` just re-emitted it
// verbatim); it's now evaluated like any other bare value.
//
// A plain in-page anchor (`#section-2`, `#overview`) needs no special-case
// detection: it's short and wordlike, so neither rule fires on its single
// bare part and it's carried through unchanged, exactly like ordinary
// path/query data is. A url-sourced or NAMED-input value already lifted
// elsewhere in the flow (a query param, an earlier path segment, a named
// fill, ...) is reused here exactly like every other tokenizer (MAT-137:
// `urlLiftedArgName`, NOT a plain `argsByLiteral` lookup, so a same-valued
// POSITIONAL fill/upload is not consulted, but a named one still is) --
// this is what collapses `?token=X#t=X` onto ONE arg with BOTH occurrences
// substituted, rather than lifting the fragment's copy under a second
// name. `urlPattern` is unaffected either way: it's built from
// `tokenizePath` alone (see fix-round-2 N1's own note below), and the
// fragment -- like the query -- only ever templates the step's own `url`.
function tokenizeFragment(hash, state) {
  if (!hash || hash.length <= 1) return hash ?? '';

  const parts = hash.slice(1).split('&');
  const templated = parts.map((part) => {
    const eqIndex = part.indexOf('=');
    const isRealPair = eqIndex > 0 && eqIndex < part.length - 1;

    if (!isRealPair) {
      // No `=` at all, or an empty key/value (leading/trailing `=`, e.g.
      // base64 padding) -- not a genuine pair; evaluate this PART on its
      // own as one bare, unkeyed value. An EMPTY-KEY part (`=<value>`)
      // keeps its leading `=` out of the candidate so the value itself is
      // entropy-checked, mirroring the query tokenizer's `?=<value>`
      // handling; the `=` is re-emitted around the placeholder.
      const emptyKey = eqIndex === 0;
      const candidate = emptyKey ? part.slice(1) : part;
      let decoded = candidate;
      try {
        decoded = decodeURIComponent(candidate);
      } catch {
        // Malformed percent-encoding: compare the raw value instead.
      }
      let argName = urlLiftedArgName(decoded, state);
      if (!argName && isSensitiveUrlValue(decoded, null)) {
        argName = liftWithBaseName(decoded, 'value', state, 'url');
      }
      if (!argName) return part;
      return emptyKey ? `={${argName}}` : `{${argName}}`;
    }

    const key = part.slice(0, eqIndex);
    const rawValue = part.slice(eqIndex + 1);
    let decoded = rawValue;
    try {
      decoded = decodeURIComponent(rawValue);
    } catch {
      // Malformed percent-encoding: compare the raw value instead.
    }
    let argName = urlLiftedArgName(decoded, state);
    if (!argName && isSensitiveUrlValue(decoded, key)) {
      argName = liftWithBaseName(decoded, queryKeyBaseName(key), state, 'url');
    }
    return argName ? `${key}={${argName}}` : part;
  });
  return `#${templated.join('&')}`;
}

// Builds one `goto` step per `browser_navigate` record. Path segments,
// query values, AND (fix round 1, F1) fragment values all get `{argName}`
// templated wherever they match an already-lifted literal, or -- for a
// value never seen in a fill/select -- wherever they look SENSITIVE (see
// the Task 7 note above `SENSITIVE_QUERY_KEY`), matching the fill/select
// `value` placeholder syntax (per the flows-artifact.test.mjs baseFlow
// fixture's own `{ op: 'goto', url: '/checkout/{plan}' }` example).
// Returns `urlInfo: { origin, patternPath }` for the FIRST goto in a
// segment to seed the flow's top-level `origin`/`urlPattern` (rule 9) --
// callers only use `urlInfo` from the first goto they see.
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
// (via `tokenizePath`); `tokenizeQuery`'s `templatedQuery` feeds only the
// step's own `url` construction below it, never `urlInfo`.
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
  const templatedHash = tokenizeFragment(parsed.hash, state);
  const url = `${templatedPath}${templatedQuery}${templatedHash}`;
  return {
    step: { op: 'goto', url },
    urlInfo: { origin: parsed.origin, patternPath },
  };
}

// --- rule 6: js steps ---

const REDACTED_ARG_VALUE = '<REDACTED: captured value not stored>';

// Final whole-branch review, I2: `record.script.args` are the raw, literal
// arguments the recorded script call was invoked with -- password-class
// captured values (TRACE.md) with zero replay utility, since the
// flow-runner refuses every js step in v1 (plan Task 8) -- it exists to be
// inspected/approved by a human, never executed. Copying `args` verbatim
// leaked those captured values twice over: into the compiled flow file
// (persisted to disk) and into every `flows find` invocation's echoed JSON.
// TRACE.md assigns this compiler the job of redacting them before either
// happens. The sha256 (script identity, checked above) and the arg KEYS
// (shape -- useful for a human deciding whether to hand-author a
// replayable equivalent) are kept; every value is replaced with
// `REDACTED_ARG_VALUE`. Shallow by design, not recursive: an object's own
// enumerable keys each map to the placeholder (a nested object's leaf
// values are simply out of scope -- a v1 compiler that never replays js
// has no need to walk further than one level to keep the shape legible).
// Absent `args` means the script was called with none -- `{}` states that
// accurately (parseFlow requires an object here, and skipping the whole
// segment over a no-args script would regress the most common run_code
// shape). Arrays and primitives collapse to the same empty set: only their
// captured VALUES are lost, which is exactly what redaction is for.
function redactScriptArgs(args) {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return Object.fromEntries(Object.keys(args).map((key) => [key, REDACTED_ARG_VALUE]));
  }
  return {};
}

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
    return { op: 'js', sha256: script.sha256, args: redactScriptArgs(script.args) };
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
    if (isMutatingByIdentity(record)) return 'mutating';
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
//
// MAT-137: tagged `'input-positional'`, NOT `'input-named'` -- an upload
// step never carries a `target` at all (see above), so there is no
// human-authored name backing this literal, the same "no real name"
// situation as an unnamed fill's `'value'` fallback. `'file'` is a fixed
// generic base name this module assigns to every upload regardless of any
// label, not evidence of intent the way a real target name is, so it does
// not qualify goto tokenization to reuse it (`urlLiftedArgName` above).
function buildUploadStep(record, state) {
  const paths = Array.isArray(record.params?.paths) ? record.params.paths.filter((p) => typeof p === 'string') : [];
  if (paths.length === 0) return null;
  const files = paths.map((filePath) => `{${liftWithBaseName(filePath, 'file', state, 'input-positional')}}`);
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

function resolveOriginAndPattern(firstUrlInfo, records, fallbackOrigin, state) {
  if (firstUrlInfo) return { origin: firstUrlInfo.origin, urlPattern: firstUrlInfo.patternPath || '/' };

  // No navigate in this segment (rule 1: a segment can start at "the first
  // record" too) -- fall back to the first record's own urlBefore/urlAfter,
  // then to the caller-supplied `origin` option (`compileSession`'s
  // fallback -- see its own doc comment).
  //
  // This pathname never passed through a `goto` step, so nothing has
  // tokenized it yet -- run it through the SAME `tokenizePath` the goto
  // path uses (rule 4c / Task 7) rather than using the raw pathname, so a
  // sensitive segment here (e.g. `/reset/<token>` when a segment happens
  // to START mid-session on that URL with no navigate of its own) is
  // lifted to a positional `:value`/`:value2`-style arg and the token
  // never bakes into `urlPattern` -- the same JSON.stringify
  // literal-absence invariant Task 7 established for the goto path. The
  // lifted arg is claimed into `state.args` (and so into the flow's own
  // `args`) exactly like every other lift, even though no STEP in this
  // segment references it (there's no goto step to carry a `{value}`
  // placeholder) -- `parseFlow` (artifact.mjs) validates each arg's own
  // shape only, never that it's referenced by some step, so an
  // args-with-no-referencing-step flow is accepted. Only `patternPath` is
  // used (urlPattern is path-only, fix-round-2 N1); `templatedPath` has
  // no step of its own to feed here since there's no goto step in this
  // segment.
  const first = records[0];
  const parsed = safeParseUrl(first?.urlBefore) ?? safeParseUrl(first?.urlAfter);
  if (parsed) {
    const { patternPath } = tokenizePath(parsed.pathname, state);
    return { origin: parsed.origin, urlPattern: patternPath || '/' };
  }
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

  const { origin, urlPattern } = resolveOriginAndPattern(firstUrlInfo, records, fallbackOrigin, state);
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
