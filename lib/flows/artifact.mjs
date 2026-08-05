import { createHash } from 'node:crypto';

// The flow artifact wire format (WS2a flywheel plan, Task 3). This is a
// LEAF module: it must not import from ./trace-reader.mjs or anything else
// under lib/flows/ -- every other flywheel module (compiler, sweep,
// matcher, CLI, flow-runner builtin) is a consumer of the shape defined
// here, never the reverse.
//
// Unlike lib/core/config.mjs (which discards unknown keys so a config file
// can evolve underneath an older binary), this module validates STRICTLY:
// unknown top-level keys, unknown step ops, and unknown keys anywhere in
// the nested shape are all rejected. An artifact is a wire format compiled
// once and replayed by flow-runner.js in a macro sandbox with no schema
// negotiation -- a field the reader doesn't recognize is far more likely to
// be a bug (a stale compiler, a hand-edited file) than a compatible
// extension, so it fails loudly instead of being silently dropped.

export const FLOW_SCHEMA_VERSION = 1;

export class FlowError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FlowError';
  }
}

const SIDE_EFFECTS = new Set(['read-only', 'mutating']);
const RESULT_KINDS = new Set(['extracts', 'completion']);
const ARG_TYPES = new Set(['string']);
const LOCATOR_KINDS = new Set(['role', 'testid', 'text', 'css', 'other']);
const EXPECT_STATES = new Set(['visible', 'hidden', 'enabled', 'disabled', 'checked', 'unchecked']);
const STEP_OPS = new Set([
  'goto', 'click', 'fill', 'select', 'press', 'hover', 'drag', 'upload', 'expect', 'extract', 'wait', 'js',
]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// --- hand-rolled validation helpers, local to this module (style
// reference: lib/core/config.mjs's object/string/boolean helpers) ---

function object(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new FlowError(`${field} must be an object`);
  }
  return value;
}

function array(value, field) {
  if (!Array.isArray(value)) {
    throw new FlowError(`${field} must be an array`);
  }
  return value;
}

function string(value, field, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') throw new FlowError(`${field} must be a string`);
  return value;
}

function boolean(value, field) {
  if (typeof value !== 'boolean') throw new FlowError(`${field} must be a boolean`);
  return value;
}

function nonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new FlowError(`${field} must be a non-negative integer`);
  }
  return value;
}

// Every field this module validates comes from a closed set of allowed
// keys; anything else at that level is rejected by name (path-annotated,
// e.g. `steps[2].target.locators`), matching the "artifacts are a wire
// format" strictness the compiler and flow-runner depend on.
function rejectUnknownKeys(record, allowedKeys, prefix) {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new FlowError(`unknown field: ${prefix ? `${prefix}.${key}` : key}`);
    }
  }
}

// --- nested shapes ---

// TraceLocator, verbatim from TRACE.md's enriched target shape: an ordered
// fallback candidate with a `kind` classifying how it was resolved and the
// `selector` string as recorded (Playwright's `internal:`-prefixed forms
// pass through opaque).
function parseLocator(value, field) {
  const record = object(value, field);
  const kind = string(record.kind, `${field}.kind`);
  if (!LOCATOR_KINDS.has(kind)) {
    throw new FlowError(`${field}.kind must be one of ${[...LOCATOR_KINDS].join(', ')}`);
  }
  const selector = string(record.selector, `${field}.selector`);
  rejectUnknownKeys(record, ['kind', 'selector'], field);
  return { kind, selector };
}

// TraceTarget-shaped: the ordered locator list plus description/role/name
// carried through verbatim for future healing (WS3). `locators` may be
// empty -- the compiler emits that shape when the source trace record had
// no enriched target (old traces); the flow is still valid, flow-runner
// fails that step loudly at replay rather than the compiler refusing to
// produce the flow at all.
function parseTarget(value, field) {
  const record = object(value, field);
  const locators = array(record.locators, `${field}.locators`)
    .map((locator, index) => parseLocator(locator, `${field}.locators[${index}]`));
  const target = { locators };
  if (Object.hasOwn(record, 'description')) target.description = string(record.description, `${field}.description`);
  if (Object.hasOwn(record, 'role')) target.role = string(record.role, `${field}.role`);
  if (Object.hasOwn(record, 'name')) target.name = string(record.name, `${field}.name`);
  rejectUnknownKeys(record, ['locators', 'description', 'role', 'name'], field);
  return target;
}

function parseWaitAfter(value, field) {
  const record = object(value, field);
  const networkSettled = boolean(record.networkSettled, `${field}.networkSettled`);
  rejectUnknownKeys(record, ['networkSettled'], field);
  return { networkSettled };
}

// Shared by every op that carries a step-level `waitAfter`/`mutating`
// (all ops except goto, expect, extract, wait, and js -- those don't
// describe an interaction the trace's `mutating` flag or a post-action
// settle wait apply to).
function withInteractionExtras(step, record, field) {
  if (Object.hasOwn(record, 'waitAfter')) {
    step.waitAfter = parseWaitAfter(record.waitAfter, `${field}.waitAfter`);
  }
  if (Object.hasOwn(record, 'mutating')) {
    step.mutating = boolean(record.mutating, `${field}.mutating`);
  }
  return step;
}

// Step ops closed set: goto, click, fill, select, press, hover, drag,
// upload, expect, extract, wait, js (plan Task 3). Each op below validates
// exactly the fields it accepts and rejects everything else.
function parseStep(value, index) {
  const field = `steps[${index}]`;
  const record = object(value, field);
  const op = string(record.op, `${field}.op`);
  if (!STEP_OPS.has(op)) {
    throw new FlowError(`${field}.op must be one of ${[...STEP_OPS].join(', ')}`);
  }

  switch (op) {
    case 'goto': {
      const url = string(record.url, `${field}.url`);
      if (!url.startsWith('/')) throw new FlowError(`${field}.url must be origin-relative (start with /)`);
      rejectUnknownKeys(record, ['op', 'url'], field);
      return { op, url };
    }

    case 'click':
    case 'hover': {
      const target = parseTarget(record.target, `${field}.target`);
      const step = withInteractionExtras({ op, target }, record, field);
      rejectUnknownKeys(record, ['op', 'target', 'waitAfter', 'mutating'], field);
      return step;
    }

    case 'fill':
    case 'select': {
      const target = parseTarget(record.target, `${field}.target`);
      const value = string(record.value, `${field}.value`);
      const step = withInteractionExtras({ op, target, value }, record, field);
      rejectUnknownKeys(record, ['op', 'target', 'value', 'waitAfter', 'mutating'], field);
      return step;
    }

    case 'press': {
      const step = { op };
      // Playwright presses a key against a focused target when one is
      // recorded, or the keyboard globally when not (TOOL_OPS maps
      // browser_press_key here regardless of whether a target was
      // resolved), so `target` is the one optional locator-bearing field
      // in this closed set.
      if (Object.hasOwn(record, 'target')) step.target = parseTarget(record.target, `${field}.target`);
      step.key = string(record.key, `${field}.key`);
      withInteractionExtras(step, record, field);
      rejectUnknownKeys(record, ['op', 'target', 'key', 'waitAfter', 'mutating'], field);
      return step;
    }

    case 'drag': {
      const target = parseTarget(record.target, `${field}.target`);
      const to = parseTarget(record.to, `${field}.to`);
      const step = withInteractionExtras({ op, target, to }, record, field);
      rejectUnknownKeys(record, ['op', 'target', 'to', 'waitAfter', 'mutating'], field);
      return step;
    }

    case 'upload': {
      const target = parseTarget(record.target, `${field}.target`);
      const files = array(record.files, `${field}.files`)
        .map((entry, i) => string(entry, `${field}.files[${i}]`));
      if (files.length === 0) throw new FlowError(`${field}.files must not be empty`);
      const step = withInteractionExtras({ op, target, files }, record, field);
      rejectUnknownKeys(record, ['op', 'target', 'files', 'waitAfter', 'mutating'], field);
      return step;
    }

    case 'expect': {
      const target = parseTarget(record.target, `${field}.target`);
      const state = string(record.state, `${field}.state`);
      if (!EXPECT_STATES.has(state)) {
        throw new FlowError(`${field}.state must be one of ${[...EXPECT_STATES].join(', ')}`);
      }
      rejectUnknownKeys(record, ['op', 'target', 'state'], field);
      return { op, target, state };
    }

    case 'extract': {
      const target = parseTarget(record.target, `${field}.target`);
      const as = string(record.as, `${field}.as`);
      if (as.length === 0) throw new FlowError(`${field}.as must not be empty`);
      rejectUnknownKeys(record, ['op', 'target', 'as'], field);
      return { op, target, as };
    }

    case 'wait': {
      const value = record.value;
      if (!Number.isFinite(value) || value < 0) {
        throw new FlowError(`${field}.value must be a non-negative number`);
      }
      rejectUnknownKeys(record, ['op', 'value'], field);
      return { op, value };
    }

    case 'js': {
      // The opaque escape step: a content hash of the recorded script plus
      // its raw args, never the script body itself (flow-runner has no fs
      // access and v1 refuses to replay js steps at all -- see plan Task
      // 8 -- so this exists to be inspected/approved, not executed).
      // `sha256: null` means the source trace's script field was itself
      // opaque (legacy truncation); parseFlow accepts it, flowTier still
      // forces the flow to 'pending'.
      let sha256 = null;
      if (record.sha256 !== null) {
        sha256 = string(record.sha256, `${field}.sha256`);
        if (!SHA256_PATTERN.test(sha256)) {
          throw new FlowError(`${field}.sha256 must be a SHA-256 digest or null`);
        }
      }
      const args = object(record.args, `${field}.args`);
      rejectUnknownKeys(record, ['op', 'sha256', 'args'], field);
      return { op, sha256, args };
    }

    default:
      // Unreachable: op was already checked against STEP_OPS above.
      throw new FlowError(`${field}.op must be one of ${[...STEP_OPS].join(', ')}`);
  }
}

function parseArgs(value, field) {
  const record = object(value, field);
  const args = {};
  for (const key of Object.keys(record)) {
    const entryField = `${field}.${key}`;
    const entry = object(record[key], entryField);
    const type = string(entry.type, `${entryField}.type`);
    if (!ARG_TYPES.has(type)) {
      throw new FlowError(`${entryField}.type must be one of ${[...ARG_TYPES].join(', ')}`);
    }
    const required = boolean(entry.required, `${entryField}.required`);
    rejectUnknownKeys(entry, ['type', 'required'], entryField);
    args[key] = { type, required };
  }
  return args;
}

function parseResult(value, field) {
  const record = object(value, field);
  if (!RESULT_KINDS.has(record.kind)) {
    throw new FlowError(`${field}.kind must be one of ${[...RESULT_KINDS].join(', ')}`);
  }
  const keys = array(record.keys, `${field}.keys`)
    .map((key, index) => string(key, `${field}.keys[${index}]`));
  rejectUnknownKeys(record, ['kind', 'keys'], field);
  return { kind: record.kind, keys };
}

function parseProvenance(value, field) {
  const record = object(value, field);
  const compiledAt = string(record.compiledAt, `${field}.compiledAt`);
  const traceDir = string(record.traceDir, `${field}.traceDir`);
  const seqRange = array(record.seqRange, `${field}.seqRange`);
  if (seqRange.length !== 2) {
    throw new FlowError(`${field}.seqRange must have exactly 2 elements`);
  }
  const start = nonNegativeInteger(seqRange[0], `${field}.seqRange[0]`);
  const end = nonNegativeInteger(seqRange[1], `${field}.seqRange[1]`);
  if (start > end) throw new FlowError(`${field}.seqRange must be ascending`);
  const productVersion = string(record.productVersion, `${field}.productVersion`);
  const successRuns = nonNegativeInteger(record.successRuns, `${field}.successRuns`);
  const failStreak = nonNegativeInteger(record.failStreak, `${field}.failStreak`);
  const lastHealed = string(record.lastHealed, `${field}.lastHealed`, { nullable: true });
  rejectUnknownKeys(record, [
    'compiledAt', 'traceDir', 'seqRange', 'productVersion', 'successRuns', 'failStreak', 'lastHealed',
  ], field);
  return { compiledAt, traceDir, seqRange: [start, end], productVersion, successRuns, failStreak, lastHealed };
}

// --- public API ---

// Validates `value` against the flow artifact v1 shape and returns a clean
// copy built entirely from known fields (no pass-through of unrecognized
// data -- see the strictness note at the top of this file). Throws
// FlowError with a path-annotated message (e.g. `steps[2].target.locators
// must be an array`) naming exactly where validation failed.
export function parseFlow(value) {
  const record = object(value, 'flow');

  if (record.schemaVersion !== FLOW_SCHEMA_VERSION) {
    throw new FlowError(`schemaVersion must be ${FLOW_SCHEMA_VERSION}`);
  }

  const id = string(record.id, 'id');
  if (!SHA256_PATTERN.test(id)) throw new FlowError('id must be a SHA-256 digest');

  const name = string(record.name, 'name');
  if (!NAME_PATTERN.test(name)) throw new FlowError('name must be kebab-case');

  const description = string(record.description, 'description');

  const origin = string(record.origin, 'origin');
  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new FlowError('origin must be an absolute http(s) URL');
  }
  if (
    (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:')
    || parsedOrigin.origin !== origin
  ) {
    throw new FlowError('origin must be a bare http(s) origin (scheme + host, no path)');
  }

  const urlPattern = string(record.urlPattern, 'urlPattern');
  if (!urlPattern.startsWith('/')) throw new FlowError('urlPattern must be origin-relative (start with /)');

  if (!SIDE_EFFECTS.has(record.sideEffects)) {
    throw new FlowError(`sideEffects must be one of ${[...SIDE_EFFECTS].join(', ')}`);
  }
  const sideEffects = record.sideEffects;

  const args = parseArgs(record.args, 'args');
  const result = parseResult(record.result, 'result');

  const steps = array(record.steps, 'steps').map((step, index) => parseStep(step, index));
  if (steps.length === 0) throw new FlowError('steps must not be empty');

  const provenance = parseProvenance(record.provenance, 'provenance');

  rejectUnknownKeys(record, [
    'schemaVersion', 'id', 'name', 'description', 'origin', 'urlPattern',
    'sideEffects', 'args', 'result', 'steps', 'provenance',
  ], '');

  return {
    schemaVersion: FLOW_SCHEMA_VERSION,
    id,
    name,
    description,
    origin,
    urlPattern,
    sideEffects,
    args,
    result,
    steps,
    provenance,
  };
}

// Recursively sorts object keys (arrays keep their element order -- only
// object key order is arbitrary JS insertion order, array order is always
// semantically meaningful, e.g. locator fallback priority). Shared by
// flowId and serializeFlow so both give the same flow content the same
// canonical shape regardless of how its object literals happened to be
// built.
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalize(value[key]);
    }
    return sorted;
  }
  return value;
}

// sha256 hex of the canonical serialization of `flow`, excluding `id` and
// `provenance`: stable under key reordering (canonicalize sorts keys
// first) and under provenance updates (replay counters must not change a
// flow's identity), unstable under any edit to the flow's actual content
// (name, steps, args, ...).
export function flowId(flow) {
  const { id, provenance, ...content } = flow;
  return createHash('sha256').update(JSON.stringify(canonicalize(content))).digest('hex');
}

// The stable on-disk / content-addressed form: canonical (sorted) key
// order at every level, including `id` and `provenance` this time (unlike
// flowId, this is the whole artifact, not the content hash's input).
export function serializeFlow(flow) {
  return `${JSON.stringify(canonicalize(flow), null, 2)}\n`;
}

// 'pending' iff the flow is mutating or contains a js step (opaque script,
// never safe to auto-approve); 'ready' otherwise. Consent model owned by
// the plan (Task 7's `flows approve`), not this module -- this is only the
// classification.
export function flowTier(flow) {
  if (flow.sideEffects === 'mutating') return 'pending';
  if (flow.steps.some((step) => step.op === 'js')) return 'pending';
  return 'ready';
}

export function flowFileName(flow) {
  return `${flow.name}.flow.json`;
}
