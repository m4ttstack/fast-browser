import crypto from 'node:crypto';
import {
  chmod, readdir, readFile, rename, unlink, writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { ensurePrivateDirectory } from '../core/files.mjs';
import { compileSession } from './compile.mjs';
import { listTraceSessions, readTraceRecords } from './trace-reader.mjs';
import {
  flowFileName, flowId, flowTier, parseFlow, serializeFlow,
} from './artifact.mjs';

// The incremental sweep (WS2a flywheel plan, Task 5): the one place that
// turns Task 2's trace sessions into Task 3's on-disk flow artifacts via
// Task 4's compiler, and folds later replay traces back into a compiled
// flow's `provenance.successRuns`/`failStreak` counters. Every write this
// module makes goes through the temp+rename+0o600 idiom (lib/core/files.mjs
// `saveConfig`'s pattern, reproduced here as `writeJsonAtomic` since this
// module writes many small JSON files -- flow artifacts, the state file --
// rather than the one config file that idiom was written for).
//
// --- incremental cursor: what "lines" means ---
//
// `trace-reader.mjs` has no partial/offset read: `readTraceRecords` always
// re-parses `actions.jsonl` from byte zero and returns every schema-valid
// record (garbage/wrong-version lines are silently excluded, never
// surfaced as an index a caller could resume from). So `lines` in
// `flows-state.json` counts entries already consumed from that RETURNED
// `records` array, not raw JSONL line offsets in the file. This is safe
// specifically because `actions.jsonl` is append-only (TRACE.md) and
// parsing is deterministic: every record a prior sweep has already
// consumed stays an exact, stable PREFIX of any later re-parse, so
// `records.slice(lines)` always yields precisely the newly appended valid
// records -- whether or not garbage lines are interleaved, since a garbage
// line never became a `records` entry (and so was never counted into
// `lines`) to begin with.
//
// A session whose `meta` has no `endedAt` yet (still live) is swept -- its
// records so far still compile/derive provenance -- but its state entry
// carries `incomplete: true` so it's always eligible for re-checking. It
// flips to complete (the `incomplete` key drops) the moment a later sweep
// observes `meta.endedAt`, even if that sweep found zero new lines.
//
// --- replay provenance (controller ruling c) ---
//
// A trace record is a REPLAY, not a compilable step, when
// `record.tool === 'browser_run_code_unsafe'` and `record.params.filename`
// is a string ending in `flow-runner.js` (the filename
// `browser_run_code_unsafe`'s own `filename` param loads code from --
// packages/fast-browser-mcp/TRACE.md's `params` section, `runCode.ts`'s
// `codeSchema`; Task 8 builds the flow-runner script itself and is the only
// future caller that will ever pass this filename). Its
// `params.args.flow.id`/`.name` identify which stored artifact it
// replayed -- matched by id first, name second, searching `flowsDir` then
// `flowsPendingDir` (ruling c). `record.error` absent means the replay
// succeeded (`successRuns++`, `failStreak` resets to 0); present means it
// failed (`failStreak++`). Replay records never reach the compiler (ruling
// c: "must not compile into new js-step flows") -- they're filtered out of
// a session's new-records slice before `compileSession` ever sees it, and
// counted separately in `replaysSeen`.
//
// Heal merging -- folding a replay's winning locators back into a flow's
// `steps` -- is explicitly DEFERRED to WS3 (ruling d) and is NOT
// implemented here. This module only ever touches a flow's `provenance`
// counters on a replay; every other content field is untouched, so a
// flow's `id` (a content hash that excludes `provenance` -- artifact.mjs's
// `flowId`) never changes as a result of replay bookkeeping.
//
// --- dedup on compile (ruling a) ---
//
// A newly compiled flow is checked against every artifact this module
// already knows about: everything on disk in EITHER tier dir at sweep
// start, plus every flow this same sweep call has already written -- so
// two segments from the SAME `compileSession` call, or from two DIFFERENT
// sessions processed later in the same sweep, collide exactly like a
// pre-existing on-disk artifact would. Same `flowId` means the new flow is
// a byte-for-byte content duplicate of something already stored: it is
// dropped, never written. Same `name` with a DIFFERENT id means the name
// is taken but the content is new: the new flow is renamed with a numeric
// suffix (`-2`, `-3`, ...). Renaming is not cosmetic -- `flowId` hashes
// everything except `id`/`provenance`, and `name` is part of that hashed
// content, so a renamed flow's `id` MUST be recomputed from the renamed
// object; reusing the pre-rename candidate's id would store a file whose
// `id` no longer matches its own content.

const STATE_SCHEMA_VERSION = 1;
const FLOW_RUNNER_SUFFIX = 'flow-runner.js';

// --- temp+rename+0o600 write idiom (lib/core/files.mjs's `saveConfig`,
// generalized to an arbitrary target path/text pair) ---

async function writeJsonAtomic(targetPath, text) {
  await ensurePrivateDirectory(path.dirname(targetPath));
  const temporary = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, text, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, targetPath);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch (cleanupError) {
      if (cleanupError?.code !== 'ENOENT') error.cleanupError = cleanupError;
    }
    throw error;
  }
}

// --- flows-state.json: hand-rolled validation, never throws ---

function freshState() {
  return { schemaVersion: STATE_SCHEMA_VERSION, processed: {} };
}

// A single processed-session entry must be `{ lines: <non-negative
// integer>, incomplete?: true }` -- anything else (wrong shape, a
// negative/non-integer `lines`, an `incomplete` that isn't literally
// `true`) is treated as absent rather than as a reason to discard the
// whole state file: one hand-edited or half-written entry shouldn't cost
// every OTHER session its cursor.
function validProcessedEntry(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!Number.isInteger(value.lines) || value.lines < 0) return null;
  const entry = { lines: value.lines };
  if (value.incomplete === true) entry.incomplete = true;
  return entry;
}

async function loadState(stateFile) {
  let raw;
  try {
    raw = JSON.parse(await readFile(stateFile, 'utf8'));
  } catch {
    return freshState(); // missing or unparseable: start fresh, never throw
  }
  if (
    raw === null || typeof raw !== 'object' || Array.isArray(raw)
    || raw.schemaVersion !== STATE_SCHEMA_VERSION
    || raw.processed === null || typeof raw.processed !== 'object' || Array.isArray(raw.processed)
  ) {
    return freshState();
  }

  const processed = {};
  for (const [key, value] of Object.entries(raw.processed)) {
    // Own-property-safe against a literal "__proto__" key -- same concern
    // artifact.mjs's `parseArgs` already documents for JSON.parse output.
    if (key === '__proto__') continue;
    const entry = validProcessedEntry(value);
    if (entry) processed[key] = entry;
  }
  return { schemaVersion: STATE_SCHEMA_VERSION, processed };
}

async function saveState(stateFile, state) {
  await writeJsonAtomic(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

// --- existing-artifact registry: id/name -> { dir, filePath, flow } ---
//
// Scanned once at sweep start from BOTH tier dirs, `flowsDir` first so its
// entries win an id/name that also appears in `flowsPendingDir` (ruling
// c's "searching flowsDir then flowsPendingDir" order) -- the `!byId.has`/
// `!byName.has` guards below only add an entry the first time its key is
// seen. Every flow this sweep call itself writes (newly compiled, or
// replay-updated) also updates this same registry in place, so it doubles
// as both "what's on disk already" (the initial scan) and "what this sweep
// call has produced so far" -- the single source both the dedup-on-compile
// check (ruling a) and the replay-provenance lookup (ruling c) read from.
async function loadArtifactRegistry(paths) {
  const byId = new Map();
  const byName = new Map();
  for (const dir of [paths.flowsDir, paths.flowsPendingDir]) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // tier dir doesn't exist yet -- nothing stored there
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.flow.json')) continue;
      const filePath = path.join(dir, entry.name);
      let flow;
      try {
        flow = parseFlow(JSON.parse(await readFile(filePath, 'utf8')));
      } catch {
        continue; // corrupt/foreign file: ignore rather than crash the sweep
      }
      const location = { dir, filePath, flow };
      if (!byId.has(flow.id)) byId.set(flow.id, location);
      if (!byName.has(flow.name)) byName.set(flow.name, location);
    }
  }
  return { byId, byName };
}

// Ruling a's numeric-suffix scheme, starting at -2 -- only ever called once
// a caller has already confirmed `baseName` collides.
function claimFlowName(baseName, byName) {
  let suffix = 2;
  let candidate = `${baseName}-${suffix}`;
  while (byName.has(candidate)) {
    suffix += 1;
    candidate = `${baseName}-${suffix}`;
  }
  return candidate;
}

// Applies ruling a to one newly compiled flow: drop it if its content
// (`flowId`) already exists anywhere in the registry; rename+re-hash it if
// only its NAME collides; otherwise write it as-is. Returns `{ name, tier }`
// for the sweep report, or `null` for a dropped duplicate.
async function writeCompiledFlow(flow, paths, registry) {
  if (registry.byId.has(flow.id)) return null;

  let finalFlow = flow;
  if (registry.byName.has(flow.name)) {
    const suffixedName = claimFlowName(flow.name, registry.byName);
    // See the module-level "dedup on compile" note: the id MUST be
    // recomputed from the renamed content, never carried over from the
    // pre-rename candidate.
    const renamed = { ...flow, name: suffixedName };
    renamed.id = flowId(renamed);
    finalFlow = parseFlow(renamed);
  }

  const tier = flowTier(finalFlow);
  const dir = tier === 'pending' ? paths.flowsPendingDir : paths.flowsDir;
  const filePath = path.join(dir, flowFileName(finalFlow));
  await writeJsonAtomic(filePath, serializeFlow(finalFlow));

  const location = { dir, filePath, flow: finalFlow };
  registry.byId.set(finalFlow.id, location);
  registry.byName.set(finalFlow.name, location);
  return { name: finalFlow.name, tier };
}

// --- replay provenance (ruling c) ---

function isReplayRecord(record) {
  return (
    record?.tool === 'browser_run_code_unsafe'
    && typeof record?.params?.filename === 'string'
    && record.params.filename.endsWith(FLOW_RUNNER_SUFFIX)
  );
}

// Splits a session's new records into what the compiler is allowed to see
// (`compileRecords`) and what it must never see (`replayRecords` -- ruling
// c: a replay must not compile into a new js-step flow). Relative order is
// preserved within each bucket, which matters for `replayRecords`: several
// replays of the SAME flow in one incremental slice must apply in the
// order they actually happened for `failStreak` to end up correct.
function partitionReplays(records) {
  const compileRecords = [];
  const replayRecords = [];
  for (const record of records) {
    (isReplayRecord(record) ? replayRecords : compileRecords).push(record);
  }
  return { compileRecords, replayRecords };
}

// Ruling c: match by id first, name second. Returns null for a replay
// record with no usable `params.args.flow`, or one that names nothing this
// sweep knows about -- hostile/unknown input is tolerated, not thrown.
function resolveReplayTarget(record, registry) {
  const flowRef = record.params?.args?.flow;
  const id = typeof flowRef?.id === 'string' ? flowRef.id : null;
  const name = typeof flowRef?.name === 'string' ? flowRef.name : null;
  if (id && registry.byId.has(id)) return registry.byId.get(id);
  if (name && registry.byName.has(name)) return registry.byName.get(name);
  return null;
}

// Applies every replay record in order, writing each touched artifact back
// in place (temp+rename) as it's updated -- a flow replayed twice in the
// same incremental slice is written twice, each time with the cumulative
// counters so far, which is simpler than batching writes and still leaves
// the on-disk file correct after the last write. Returns one `{ name,
// successRuns, failStreak }` per DISTINCT flow touched (final counts only,
// not one entry per replay record), in first-touched order.
async function applyReplayRecords(replayRecords, registry) {
  const touchedIds = new Set();
  for (const record of replayRecords) {
    const location = resolveReplayTarget(record, registry);
    if (!location) continue;

    const { flow } = location;
    const succeeded = typeof record.error !== 'string';
    const provenance = succeeded
      ? { ...flow.provenance, successRuns: flow.provenance.successRuns + 1, failStreak: 0 }
      : { ...flow.provenance, failStreak: flow.provenance.failStreak + 1 };
    // Heal merging (WS3, ruling d) would touch `steps`/locators here; v1
    // never does, so `id` (excludes `provenance`) is stable across replays.
    const nextFlow = { ...flow, provenance };

    await writeJsonAtomic(location.filePath, serializeFlow(nextFlow));

    const nextLocation = { ...location, flow: nextFlow };
    registry.byId.set(nextFlow.id, nextLocation);
    registry.byName.set(nextFlow.name, nextLocation);
    touchedIds.add(nextFlow.id);
  }

  return [...touchedIds].map((id) => {
    const { flow } = registry.byId.get(id);
    return { name: flow.name, successRuns: flow.provenance.successRuns, failStreak: flow.provenance.failStreak };
  });
}

// --- public API ---

// sweep({ paths, now? }) -> { compiled: [{ name, tier }], updated: [{ name,
//   successRuns, failStreak }], sessionsProcessed, cursor, skippedBySession:
//   { '<traceDir>': [{ reason, seqRange }] }, replaysSeen }
//
// `now` is this module's own clock-injection point, matching the
// codebase's `now: supplied.now ?? (() => new Date())` convention
// (lib/commands/setup.mjs, configure.mjs). It's always passed down to
// `compileSession`, but only ever consulted there for a session with no
// `meta.endedAt` yet (a still-live capture) -- a completed session's own
// `meta.endedAt` always wins (compile.mjs's `resolveCompiledAt`), so
// supplying it here can never fabricate a timestamp for a session that
// already has a real one.
//
// Trace sessions live directly under `paths.dataDir` (`listTraceSessions`);
// `paths.flowsStateFile` is the incremental cursor (module doc comment);
// `paths.flowsDir`/`paths.flowsPendingDir` are the two tier destinations
// (`flowTier`). Never throws on trace/state input -- missing/corrupt state
// starts fresh, a session with no compilable content this round just
// contributes nothing, matching every module upstream of this one.
export async function sweep({ paths, now } = {}) {
  const clock = now ?? (() => new Date());
  const state = await loadState(paths.flowsStateFile);
  const registry = await loadArtifactRegistry(paths);
  const sessions = await listTraceSessions(paths.dataDir);

  const compiled = [];
  const updated = [];
  const skippedBySession = {};
  let replaysSeen = 0;
  let sessionsProcessed = 0;

  for (const session of sessions) {
    const basename = path.basename(session.dir);
    const previousLines = state.processed[basename]?.lines ?? 0;

    const { records } = await readTraceRecords(session.dir);
    const newRecords = records.length > previousLines ? records.slice(previousLines) : [];

    if (newRecords.length > 0) {
      sessionsProcessed += 1;
      const { compileRecords, replayRecords } = partitionReplays(newRecords);

      if (compileRecords.length > 0) {
        const result = compileSession({
          records: compileRecords,
          meta: session.meta,
          traceDir: basename,
          now: clock,
        });
        if (result.report.skipped.length > 0) skippedBySession[basename] = result.report.skipped;
        // Sequential, not Promise.all: each write must land in the
        // registry before the next flow's dedup check runs against it
        // (ruling a's intra-session collision case depends on this order).
        for (const flow of result.flows) {
          const outcome = await writeCompiledFlow(flow, paths, registry);
          if (outcome) compiled.push(outcome);
        }
      }

      replaysSeen += replayRecords.length;
      if (replayRecords.length > 0) {
        updated.push(...(await applyReplayRecords(replayRecords, registry)));
      }
    }

    const isComplete = typeof session.meta?.endedAt === 'string';
    const nextEntry = { lines: records.length };
    if (!isComplete) nextEntry.incomplete = true;
    state.processed[basename] = nextEntry;
  }

  await saveState(paths.flowsStateFile, state);

  return {
    compiled,
    updated,
    sessionsProcessed,
    cursor: { ...state.processed },
    skippedBySession,
    replaysSeen,
  };
}
