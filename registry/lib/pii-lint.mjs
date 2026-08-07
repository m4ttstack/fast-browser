// PII lint (WS4b plan, Task 2): reject loudly, never sanitize. This module
// is imported by BOTH the registry service's ingest pipeline (Task 5) and
// the fast-browser client's pre-push path (Task 7), so both ends agree
// byte-for-byte on what counts as PII/a secret. It imports nothing from
// this plugin's `lib/` -- zero runtime deps, plain string/regex checks over
// an already-parsed flow artifact (lib/flows/artifact.mjs's `parseFlow`
// shape) -- so it is safe to bundle into either side without pulling in
// either runtime.
//
// `lintArtifact(flow)` never mutates `flow`: every check is a read.
//
// Two passes, run over disjoint-but-overlapping scopes of the artifact's
// string fields:
//
// Pass 1 -- literals-stripped verification (rule 'literal-survived').
// Per the compile contract (lib/flows/compile.mjs: `liftLiteral`,
// `fillLikeValue`, `buildUploadStep`), a compiled fill/select `value` is
// EITHER a fully-templated arg reference -- the WHOLE field is exactly
// `{argName}`, matching flow-runner's substitution token shape verbatim
// (artifact.mjs's MAT-149 note names the real regex:
// `/\{([A-Za-z_][A-Za-z0-9_]*)\}/g`) -- empty, OR one of `liftLiteral`'s
// own two narrow exclusions from lifting: a literal shorter than 2 chars,
// or exactly the checkbox/radio strings `'true'`/`'false'` (fix round 1,
// finding 2: the real compile contract governs, not a stricter reading of
// it). Upload `files[]` entries get NO such exclusion -- `buildUploadStep`
// lifts every path unconditionally (controller ruling b, "ALWAYS lifted
// into args"), bypassing `liftLiteral`'s filter entirely -- so a compiled
// upload file entry is always exactly a template or empty, never a short
// or boolean-shaped literal. A literal surviving where none of these
// shapes apply means either a pre-WS2b artifact (compiled before
// fix-round-1 "ADOPTED F7" introduced unconditional lifting) or direct
// tampering with a compiled flow file -- never a legitimate compile
// output.
//
// Pass 2 -- secret scan (rules 'secret-pattern', 'entropy', 'email',
// 'bearer'), the WS2b discriminator family. Runs over every
// value/url/name/description/selector string in the artifact: flow
// name/description/origin/urlPattern; per step:
// url/value/files/target.name/target.description/target.locators[].selector
// (including `to` for drag); every string key and string value inside
// a `js` step's `args` object, at any nesting depth (fix round 1, finding
// 4: compile.mjs's `redactScriptArgs` only redacts VALUES, key names
// survive verbatim, and `parseFlow` allows arbitrary JSON under `args` --
// a real tamper channel pass 1 exists specifically to catch, so it cannot
// be exempted); and, since MAT-160, every provenance string field
// (compiledAt/traceDir/productVersion/lastHealed) -- WS4b shipped with
// `provenance` skipped entirely, deferred as a minor because provenance
// is compile-generated, not user-authored. But it is still a tamper
// channel: `push` ships the flow's full signed artifact (registry.mjs
// includes `provenance` byte-for-byte, never strips it), and `traceDir`
// in particular can be an absolute path carrying a username if a caller
// ever hands `compileSession` a non-basename trace directory. Provenance
// gets pass 2 ONLY -- see `collectFields` below for why pass 1's
// literal-survived check does not apply to it. Four independent,
// non-exclusive checks -- a single field
// can trip more than one rule, and every true reason is reported (reject
// loudly, not "first match wins"):
//
//   - 'secret-pattern': a known API-key value shape (Stripe sk-/pk-,
//     GitHub ghp-, Slack xox[a-z]-). Checked per TOKEN (fix round 1,
//     finding 1), not over the whole field -- see `tokenize` below.
//   - 'entropy': a long, mixed-alphabet, letter+digit string that reads as
//     an opaque token rather than human-authored text. Checked per TOKEN,
//     same reason. SYNC NOTE: the length/charset/letter-digit/
//     hyphen-density thresholds mirror lib/flows/compile.mjs's
//     `isHighEntropyValue`/`HIGH_ENTROPY_VALUE` byte-for-byte -- keep this
//     in step if that module's thresholds ever change. The UUID check is
//     mirrored from the same module's `UUID_PATTERN`, but its POLARITY is
//     inverted on purpose: compile.mjs treats a UUID as high-entropy (it
//     WANTS to lift a UUID-shaped magic-link/session token into a replay
//     arg); this lint treats a UUID as EXEMPT from 'entropy' -- a UUID is
//     an extremely common non-secret identifier (an element id, a
//     resource id inside a selector), and flagging every one as a leaked
//     secret would just be noise a human reviewer learns to ignore.
//   - 'email': an embedded email address. Checked over the WHOLE field
//     (an email's `@`/`.` shape is its own delimiter; tokenizing on
//     non-alphanumeric characters would only ever break it apart).
//   - 'bearer': a `Bearer <token>` or `Authorization: <value>`
//     header-shaped substring (the literal header shape this repo's own
//     lib/flows/encoder.mjs sends: `Authorization: Bearer ${key}`).
//     Checked over the WHOLE field, same reason as 'email'.
//
// Fix round 1, finding 1 (CRITICAL): 'secret-pattern' and 'entropy' were
// originally applied to each field's WHOLE value with start/end-anchored
// patterns. compile.mjs never does this -- `tokenizePath`/`tokenizeQuery`
// hand `isHighEntropyValue` exactly ONE already-isolated URL segment/query
// value at a time, never a raw url/selector/description string with
// separator punctuation still in it. Anchoring the mirrored checks to the
// WHOLE field was a drift in application GRANULARITY, not in the
// discriminators' own bytes -- a secret embedded in a `goto` url, a
// selector attribute value, or free-text prose (anywhere a `/`, `?`, `=`,
// `:`, `"`, or space sits next to it) silently passed clean. Fixed by
// tokenizing each scanned field on runs of characters OUTSIDE the entropy
// alphabet before running the two value-shape checks -- see `tokenize`.
// 'email'/'bearer' are untouched by this: both already scan the whole
// field as a substring match (an email/header shape is not a token-shaped
// thing to isolate first).

// --- pass 1: the arg-template shape ---

// Matches ONLY a field whose entire value is one arg reference -- mirrors
// flow-runner's substitution token (artifact.mjs's MAT-149 comment,
// `/\{([A-Za-z_][A-Za-z0-9_]*)\}/g`) anchored to the whole string, since a
// compiled fill/select `value` or upload `files[]` entry is never a
// literal/template MIX the way a `goto` url can be -- see this module's
// top comment.
const TEMPLATE_ONLY_PATTERN = /^\{[A-Za-z_][A-Za-z0-9_]*\}$/;

// Strict form: template or empty, nothing else. This is upload `files[]`'s
// whole contract -- `buildUploadStep` never exempts a short or boolean
// literal the way `liftLiteral` does for fill/select (see this module's
// top comment).
function isTemplateOrEmpty(value) {
  return value === '' || TEMPLATE_ONLY_PATTERN.test(value);
}

// SYNC NOTE (source: lib/flows/compile.mjs, `liftLiteral`): mirrors its
// own two exclusions from unconditional lifting -- a literal shorter than
// 2 chars, or exactly the checkbox/radio strings 'true'/'false' -- both of
// which `fillLikeValue` then emits AS THE RAW LITERAL rather than a
// template (fix round 1, finding 2). Used only for fill/select `value`;
// upload `files[]` uses the stricter `isTemplateOrEmpty` above instead.
function isCompiledFillValue(value) {
  if (isTemplateOrEmpty(value)) return true;
  if (value.length < 2) return true;
  return value === 'true' || value === 'false';
}

// --- pass 2: the WS2b discriminator family ---

// Splits a field on any run of characters OUTSIDE the entropy alphabet
// (mirrors `HIGH_ENTROPY_ALPHABET` below) so 'secret-pattern' and
// 'entropy' each see an isolated candidate token, the same granularity
// compile.mjs's own tokenizePath/tokenizeQuery hand `isHighEntropyValue`
// (fix round 1, finding 1). A token that IS the whole field (no
// out-of-alphabet characters present at all) behaves identically to the
// pre-fix whole-string check, so a bare secret value with no surrounding
// punctuation is unaffected.
const TOKEN_SPLIT_PATTERN = /[^A-Za-z0-9_.~-]+/;

function tokenize(value) {
  return value.split(TOKEN_SPLIT_PATTERN).filter(Boolean);
}

// Known API-key value shapes: Stripe sk-/pk-, GitHub ghp-, Slack
// xox[a-z]- (xoxb/xoxp/xoxa/xoxr/...), each followed by a `-`/`_`
// separator and then 15+ more url-safe characters. Fix round 1, finding
// 3: the separator must sit IMMEDIATELY after the prefix -- without it,
// this matched ordinary kebab-case prose that happens to start with one
// of these two-to-four-letter prefixes ("skip-onboarding-and-continue",
// "skateboard-2024-checkout" -- both real-shaped `resolveName` output,
// compile.mjs's dominant-verb/path-root naming). A real key's separator
// is structural, not incidental.
const KEY_SHAPE_PATTERN = /^(sk|pk|ghp|xox[a-z])[-_][-_a-z0-9]{15,}/i;

// SYNC NOTE (source: lib/flows/compile.mjs, `UUID_PATTERN` and
// `HIGH_ENTROPY_VALUE`): canonical UUID shape and the url-safe entropy
// alphabet, copied verbatim. See this module's top comment for why the
// UUID check's polarity is inverted here (exemption, not inclusion).
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HIGH_ENTROPY_ALPHABET = /^[A-Za-z0-9_.~-]+$/;
const MIN_ENTROPY_LENGTH = 20;

// SYNC NOTE (source: lib/flows/compile.mjs, `isHighEntropyValue`): same
// length floor, same charset, same letter+digit requirement, same
// hyphen-density guard against human-authored slugs ("nike-air-max-270",
// "annual-report-2024.pdf" -- compile.mjs's fix-round-1 F3) -- except a
// UUID is EXEMPT here rather than auto-included; see this module's top
// comment. Called per-token (see `tokenize` above), not over a whole
// field.
function isEntropySecret(value) {
  if (UUID_PATTERN.test(value)) return false;
  if (value.length < MIN_ENTROPY_LENGTH) return false;
  if (!HIGH_ENTROPY_ALPHABET.test(value)) return false;
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return false;
  const hyphenCount = (value.match(/-/g) || []).length;
  return hyphenCount < 2;
}

const EMAIL_PATTERN = /[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

// A `Bearer <token>` credential, or an `Authorization: <value>` header
// shape (colon required so ordinary prose like "user authorization
// required" -- no attached value -- doesn't false-positive).
const BEARER_PATTERN = /\bbearer\s+[A-Za-z0-9._-]{8,}\b|\bauthorization\s*:\s*\S{4,}/i;

function secretRulesFor(value) {
  const rules = new Set();
  for (const token of tokenize(value)) {
    if (KEY_SHAPE_PATTERN.test(token)) rules.add('secret-pattern');
    if (isEntropySecret(token)) rules.add('entropy');
  }
  if (EMAIL_PATTERN.test(value)) rules.add('email');
  if (BEARER_PATTERN.test(value)) rules.add('bearer');
  return [...rules];
}

// --- field collection ---

// Recursively collects every string (both key names and leaf values, at
// any nesting depth) inside a `js` step's `args` object. Fix round 1,
// finding 4: `parseFlow` only requires `args` to be a plain object --
// nothing about its nested shape is validated, so arbitrary JSON (nested
// objects, arrays, strings) can sit underneath it, and compile.mjs's
// `redactScriptArgs` redacts only the top-level VALUES it itself produces
// at compile time, never a key name, and never anything an attacker
// tampers in afterward. Key names are scanned at their own path (the path
// IS built from the key text, so a key's own violation is reported at
// that same path); the generic recursive shape mirrors the dot/bracket
// path convention used everywhere else in this module.
function collectStrings(node, basePath, out) {
  if (typeof node === 'string') {
    out.push({ path: basePath, value: node });
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => collectStrings(item, `${basePath}[${index}]`, out));
    return;
  }
  if (node && typeof node === 'object') {
    for (const key of Object.keys(node)) {
      const childPath = `${basePath}.${key}`;
      out.push({ path: childPath, value: key });
      collectStrings(node[key], childPath, out);
    }
  }
}

// Walks the artifact's known shape (never a generic deep-walk over the
// WHOLE flow: `id` and a `js` step's `sha256`/`target.role` are
// deliberately never visited -- structural hashes/ids/roles are not PII
// surface and scanning them produces nothing but false 'entropy' noise,
// e.g. the flow's own 64-hex-char content-addressed `id`). `js` step
// `args` ARE visited, recursively -- see `collectStrings` above.
// `provenance`'s own string fields ARE visited too, since MAT-160 (see
// the module's top comment) -- but only into `textFields`, never
// `valueFields`: provenance is compile-generated metadata, not
// step/value-bearing content, so pass 1's literal-survived contract
// (which exists to catch an un-lifted compile literal) does not apply to
// it. `seqRange`/`successRuns`/`failStreak` are numbers, not strings, so
// they are outside either pass's scope by construction.
// Returns two lists:
//   - `valueFields`: fill/select `value` and upload `files[]` entries --
//     checked by BOTH passes. Each entry also carries `kind` ('fill' or
//     'upload') so pass 1 can apply the right literal-survived contract
//     (see `isCompiledFillValue` vs. `isTemplateOrEmpty` above).
//   - `textFields`: every other name/description/url/selector/js-arg/
//     provenance string -- checked by pass 2 only.
// Every entry carries the exact JSON-path string of its field (e.g.
// `steps[2].target.locators[0].selector`, `steps[4].args.userEmail`,
// `provenance.traceDir`), matching artifact.mjs's own path-annotated
// error convention.
function collectFields(flow) {
  const valueFields = [];
  const textFields = [];

  const pushText = (path, value) => {
    if (typeof value === 'string' && value.length > 0) textFields.push({ path, value });
  };

  pushText('name', flow?.name);
  pushText('description', flow?.description);
  pushText('origin', flow?.origin);
  pushText('urlPattern', flow?.urlPattern);

  // MAT-160: provenance's own string fields, pass 2 only -- see the
  // module's top comment and this function's own comment above for why.
  // `lastHealed` is nullable (artifact.mjs's `parseProvenance`); `pushText`
  // already no-ops on a non-string, so `null` is skipped without a
  // separate guard here.
  pushText('provenance.compiledAt', flow?.provenance?.compiledAt);
  pushText('provenance.traceDir', flow?.provenance?.traceDir);
  pushText('provenance.productVersion', flow?.provenance?.productVersion);
  pushText('provenance.lastHealed', flow?.provenance?.lastHealed);

  const pushTarget = (target, basePath) => {
    if (!target || typeof target !== 'object') return;
    pushText(`${basePath}.name`, target.name);
    pushText(`${basePath}.description`, target.description);
    const locators = Array.isArray(target.locators) ? target.locators : [];
    locators.forEach((locator, index) => {
      if (locator && typeof locator === 'object') {
        pushText(`${basePath}.locators[${index}].selector`, locator.selector);
      }
    });
  };

  const steps = Array.isArray(flow?.steps) ? flow.steps : [];
  steps.forEach((step, index) => {
    if (!step || typeof step !== 'object') return;
    const base = `steps[${index}]`;
    switch (step.op) {
      case 'goto':
        pushText(`${base}.url`, step.url);
        break;
      case 'click':
      case 'hover':
      case 'expect':
      case 'extract':
        pushTarget(step.target, `${base}.target`);
        break;
      case 'fill':
      case 'select':
        pushTarget(step.target, `${base}.target`);
        if (typeof step.value === 'string') valueFields.push({ path: `${base}.value`, value: step.value, kind: 'fill' });
        break;
      case 'press':
        if (step.target) pushTarget(step.target, `${base}.target`);
        break;
      case 'drag':
        pushTarget(step.target, `${base}.target`);
        pushTarget(step.to, `${base}.to`);
        break;
      case 'upload':
        if (step.target) pushTarget(step.target, `${base}.target`);
        if (Array.isArray(step.files)) {
          step.files.forEach((file, fileIndex) => {
            if (typeof file === 'string') valueFields.push({ path: `${base}.files[${fileIndex}]`, value: file, kind: 'upload' });
          });
        }
        break;
      case 'js':
        // `sha256` is a content hash, never PII surface -- excluded, same
        // as `id` (unlike `id`, `provenance`'s own string fields ARE
        // scanned, but separately -- see `collectFields` above, MAT-160).
        // `args` IS scanned, recursively (fix round 1, finding 4).
        if (step.args && typeof step.args === 'object') {
          const argFields = [];
          collectStrings(step.args, `${base}.args`, argFields);
          argFields.forEach(({ path, value }) => pushText(path, value));
        }
        break;
      default:
        break;
    }
  });

  return { valueFields, textFields };
}

// --- public API ---

// Validates `flow` (an already-parsed flow artifact, lib/flows/
// artifact.mjs's `parseFlow` shape) and returns `{ ok, reasons }`, where
// `reasons` is every `{ path, rule }` violation found, most-structural
// (pass 1) first, in field-declaration order. `ok` is `reasons.length ===
// 0`. Never mutates `flow`.
export function lintArtifact(flow) {
  const { valueFields, textFields } = collectFields(flow);
  const reasons = [];

  for (const { path, value, kind } of valueFields) {
    const valid = kind === 'upload' ? isTemplateOrEmpty(value) : isCompiledFillValue(value);
    if (!valid) reasons.push({ path, rule: 'literal-survived' });
  }

  for (const { path, value } of [...valueFields, ...textFields]) {
    for (const rule of secretRulesFor(value)) {
      reasons.push({ path, rule });
    }
  }

  return { ok: reasons.length === 0, reasons };
}
