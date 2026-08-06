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
// Per the compile contract (lib/flows/compile.mjs: `fillLikeValue`,
// `buildUploadStep`), a compiled fill/select `value` and every upload
// `files[]` entry are each EITHER a fully-templated arg reference -- the
// WHOLE field is exactly `{argName}`, matching flow-runner's substitution
// token shape verbatim (artifact.mjs's MAT-149 note names the real regex:
// `/\{([A-Za-z_][A-Za-z0-9_]*)\}/g`) -- or empty. compile.mjs's
// fix-round-1 "ADOPTED F7" made this unconditional: EVERY captured
// fill/select literal is lifted into an arg, even with no nameable target
// (the positional `'value'`/`'value2'`/... fallback), and upload paths are
// "ALWAYS lifted into args" per its own controller ruling b. A literal
// surviving in one of these fields therefore means either a pre-WS2b
// artifact (compiled before that fix) or direct tampering with a compiled
// flow file -- never a legitimate compile output.
//
// Pass 2 -- secret scan (rules 'secret-pattern', 'entropy', 'email',
// 'bearer'), the WS2b discriminator family. Runs over every
// value/url/name/description/selector string in the artifact: flow
// name/description/origin/urlPattern, and per step:
// url/value/files/target.name/target.description/target.locators[].selector
// (including `to` for drag). Four independent, non-exclusive checks --
// a single field can trip more than one rule, and every true reason is
// reported (reject loudly, not "first match wins"):
//
//   - 'secret-pattern': a known API-key value shape (Stripe sk-/pk-,
//     GitHub ghp-, Slack xox[a-z]-).
//   - 'entropy': a long, mixed-alphabet, letter+digit string that reads as
//     an opaque token rather than human-authored text. SYNC NOTE: the
//     length/charset/letter-digit/hyphen-density thresholds mirror
//     lib/flows/compile.mjs's `isHighEntropyValue`/`HIGH_ENTROPY_VALUE`
//     byte-for-byte -- keep this in step if that module's thresholds ever
//     change. The UUID check is mirrored from the same module's
//     `UUID_PATTERN`, but its POLARITY is inverted on purpose: compile.mjs
//     treats a UUID as high-entropy (it WANTS to lift a UUID-shaped
//     magic-link/session token into a replay arg); this lint treats a UUID
//     as EXEMPT from 'entropy' -- a UUID is an extremely common non-secret
//     identifier (an element id, a resource id inside a selector), and
//     flagging every one as a leaked secret would just be noise a human
//     reviewer learns to ignore.
//   - 'email': an embedded email address.
//   - 'bearer': a `Bearer <token>` or `Authorization: <value>`
//     header-shaped substring (the literal header shape this repo's own
//     lib/flows/encoder.mjs sends: `Authorization: Bearer ${key}`).

// --- pass 1: the arg-template shape ---

// Matches ONLY a field whose entire value is one arg reference -- mirrors
// flow-runner's substitution token (artifact.mjs's MAT-149 comment,
// `/\{([A-Za-z_][A-Za-z0-9_]*)\}/g`) anchored to the whole string, since a
// compiled fill/select `value` or upload `files[]` entry is never a
// literal/template MIX the way a `goto` url can be -- see this module's
// top comment.
const TEMPLATE_ONLY_PATTERN = /^\{[A-Za-z_][A-Za-z0-9_]*\}$/;

function isTemplateOrEmpty(value) {
  return value === '' || TEMPLATE_ONLY_PATTERN.test(value);
}

// --- pass 2: the WS2b discriminator family ---

// Known API-key value shapes: Stripe sk-/pk-, GitHub ghp-, Slack
// xox[a-z]- (xoxb/xoxp/xoxa/xoxr/...), each followed by 16+ url-safe
// characters.
const KEY_SHAPE_PATTERN = /^(sk|pk|ghp|xox[a-z])[-_a-z0-9]{16,}/i;

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
// comment.
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
  const rules = [];
  if (KEY_SHAPE_PATTERN.test(value)) rules.push('secret-pattern');
  if (isEntropySecret(value)) rules.push('entropy');
  if (EMAIL_PATTERN.test(value)) rules.push('email');
  if (BEARER_PATTERN.test(value)) rules.push('bearer');
  return rules;
}

// --- field collection ---

// Walks the artifact's known shape (never a generic deep-walk: `id`,
// `provenance`, a `js` step's `sha256`/`args`, and `target.role` are all
// deliberately never visited -- structural hashes/ids/roles are not PII
// surface and scanning them produces nothing but false 'entropy' noise,
// e.g. the flow's own 64-hex-char content-addressed `id`). Returns two
// lists:
//   - `valueFields`: fill/select `value` and upload `files[]` entries --
//     checked by BOTH passes.
//   - `textFields`: every other name/description/url/selector string --
//     checked by pass 2 only.
// Every entry carries the exact JSON-path string of its field (e.g.
// `steps[2].target.locators[0].selector`), matching artifact.mjs's own
// path-annotated error convention.
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
        if (typeof step.value === 'string') valueFields.push({ path: `${base}.value`, value: step.value });
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
            if (typeof file === 'string') valueFields.push({ path: `${base}.files[${fileIndex}]`, value: file });
          });
        }
        break;
      // 'js' is deliberately excluded: `sha256` is a content hash and
      // `args` is already redacted by the compiler (compile.mjs's
      // `redactScriptArgs`) -- neither is PII surface, and a hex sha256
      // would false-positive 'entropy' if scanned.
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

  for (const { path, value } of valueFields) {
    if (!isTemplateOrEmpty(value)) reasons.push({ path, rule: 'literal-survived' });
  }

  for (const { path, value } of [...valueFields, ...textFields]) {
    for (const rule of secretRulesFor(value)) {
      reasons.push({ path, rule });
    }
  }

  return { ok: reasons.length === 0, reasons };
}
