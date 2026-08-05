import crypto from 'node:crypto';
import {
  chmod, readdir, readFile, rename, unlink, writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { ensurePrivateDirectory } from '../core/files.mjs';
import { mergeGraph, mineGraphEdges } from '../sites/graph.mjs';
import { mergeInventory, mineInventory } from '../sites/inventory.mjs';
import { readSite, writeGraph, writeInventory } from '../sites/store.mjs';
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
// --- incremental cursors: TWO of them, and why ---
//
// A trace session's `actions.jsonl` grows while its capturing agent is
// still working; `meta.endedAt` only appears once the session closes
// cleanly. Fix round 1 (Task 5 review, F2/controller ruling) found that
// compiling a still-growing session incrementally -- the original design --
// is actively harmful, not just wasteful: slicing at whatever line the
// cursor happened to sit on could split a coherent flow mid-way, compiling
// a FRAGMENT (steps with no `goto`, a flow missing the click that gives it
// meaning) as if it were the whole thing, and once the cursor advances past
// that prefix, the coherent flow can never be recovered -- the records that
// would have completed it are gone from the next incremental slice. So:
//
// **Compilation is deferred entirely until `meta.endedAt` exists.** A live
// (no-`endedAt`) session is still swept every sweep, but ONLY to scan for
// replay records -- an agent replaying an EXISTING flow mid-session is
// real, useful signal (and, unlike compiling the agent's own in-progress
// work, carries no fragmentation risk: a replay record either matches a
// stored artifact or it doesn't). The moment a later sweep observes
// `meta.endedAt`, the session compiles in ONE shot, from wherever
// compilation last left off to the current end of file -- the whole
// coherent trace, never a fragment.
//
// This needs two independent cursors per session, not one:
// - `lines` -- how far COMPILATION has consumed. Frozen while a session is
//   live (compilation deferred); only ever advances, in one jump, when a
//   session is found complete.
// - `provenanceLines` -- how far REPLAY SCANNING has consumed. Advances on
//   every sweep, live or complete, to the current end of file -- so a
//   replay is counted exactly once regardless of when it's observed
//   relative to its session's own completion.
//
// `provenanceLines >= lines` always holds by construction: provenance
// always catches all the way up to the current end of file every sweep;
// `lines` only catches up when the session completes, at which point both
// land on the same value. `trace-reader.mjs` has no partial/offset read --
// `readTraceRecords` always re-parses `actions.jsonl` from byte zero and
// returns every schema-valid record -- so both cursors count entries
// already consumed from that RETURNED `records` array, not raw JSONL line
// offsets in the file; this is safe because `actions.jsonl` is append-only
// (TRACE.md) and parsing is deterministic, so a prior sweep's consumed
// records stay an exact, stable PREFIX of any later re-parse.
//
// `flows-state.json` validation is tolerant of the OLD one-cursor shape (a
// bare `{ lines }` entry, from before this fix): `provenanceLines` absent
// or malformed defaults to `lines`. This upgrades existing state cleanly --
// a session already fully consumed under the old (single-cursor) design had
// already compiled AND replay-scanned everything up to `lines`, so treating
// `provenanceLines` as starting there too is exactly correct, not a guess.
//
// A live session's state entry carries `incomplete: true`. Under the
// original design this flag was purely cosmetic -- nothing in this module
// ever read it back to decide behavior, only external readers (a future
// CLI) would. Under THIS design the underlying distinction it names is no
// longer decorative: whether a session is complete is exactly what decides
// whether this sweep compiles it at all. The stored flag itself is still
// only ever written, never consulted -- every sweep re-derives completeness
// fresh from `session.meta.endedAt` (the only source that can actually
// change between sweeps) -- but it does real work as the one place an
// external reader can see that distinction without separately opening every
// session's `meta.json`, so it stays (review F6).
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
// whatever range the compiler is given before `compileSession` ever sees
// it, and counted separately in `replaysSeen` regardless of whether they
// match a stored artifact.
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
//
// --- crash safety (F1) and stale entries (F8) ---
//
// State is persisted after EVERY session's writes complete, not once at
// the end of the whole sweep: if a later session's write throws (a full
// disk, a permissions problem, any operational fault -- not hostile TRACE
// input, which every module upstream of this one already tolerates), every
// session processed before it has already landed on disk, cursors and all,
// so a retried sweep never re-applies an already-counted replay or
// recompiles an already-written flow. Every save also prunes any state
// entry whose trace directory no longer exists (this sweep's own
// `listTraceSessions` result is the source of truth for "still exists") --
// this exists to stop `flows-state.json` from growing without bound as
// ephemeral trace directories get deleted over time, not to model any
// particular deletion mechanism. KNOWN v1 LIMITATION: if a trace directory
// is ever restored into the live data dir after its cursor entry has
// already been pruned, its replays get re-counted on the next sweep that
// finds it (there's no archive/restore workflow today for this to bite in
// practice) -- accepted, not fixed here; revisit if that changes.
//
// --- unreadable sessions (fix round 2, finding N1) ---
//
// `readTraceRecords` distinguishes a session it genuinely found empty
// (`readable: true, records: []`) from one it flat-out couldn't read
// (`readable: false` -- ENOENT, EACCES, any other fs error;
// trace-reader.mjs). This module MUST honor that distinction rather than
// collapsing both to "zero new records": collapsing them would let a
// transient or permissions read fault silently rewind a session's cursor
// to what it reads as "empty," and once the file becomes readable again on
// a later sweep, every replay that session had already had counted gets
// counted a second time. So a session whose read comes back
// `readable: false` is left COMPLETELY untouched this sweep -- no cursor
// write (its state entry, if it has one, is not touched at all), no
// compile, no provenance -- and reported as
// `skippedBySession[basename] = [{ reason: 'unreadable', seqRange: [null, null] }]`
// so a caller can still see that something needs attention.
//
// --- site memory mining (WS2b plan, Task 4) ---
//
// Once a session compiles (the branch above, `isComplete` with a non-empty
// `compileRecords` slice), that SAME slice -- replays already excluded, the
// exact records `compileSession` itself saw -- is also handed to the graph
// (`lib/sites/graph.mjs`) and inventory (`lib/sites/inventory.mjs`) miners.
// This is deliberately the compile branch's slice, not a new cursor: site
// memory inherits the two-cursor model and live-session deferral for free
// by piggybacking on `lines`, rather than re-deriving either. A LIVE session
// therefore mines nothing (compilation, and mining with it, is deferred
// until `meta.endedAt` exists -- see above), and a slice that is ALL replay
// records mines nothing either (it never reaches `compileRecords` to begin
// with; the miners' own replay self-exclusion is harmless overlap on top of
// that, never load-bearing here).
//
// A single session can touch several origins (a checkout flow that
// navigates from `shop.example` to `checkout.example`, say), so the slice
// is grouped by each record's own canonical origin -- `new URL(...).origin`
// of `urlAfter`, falling back to `urlBefore` -- before mining; a record
// whose `urlAfter` AND `urlBefore` both fail to resolve to a usable http(s)
// origin contributes to no group (`groupRecordsByOrigin`). Origins handed
// to the miners and the store are always this canonical `.origin` form,
// never a raw string -- `lib/sites/store.mjs` (Task 1) REJECTS anything
// else, and every write here goes through it.
//
// Per origin: mine, then merge-then-write -- read the origin's existing
// `graph.json`/`inventory.json` via `readSite` (never throws), merge the
// freshly mined edges/targets in via `mergeGraph`/`mergeInventory` (which
// also apply the shared per-origin/per-pattern bounds and report eviction
// counts), then write both back via `writeGraph`/`writeInventory` (temp+
// rename is inside the store, same idiom this module's own
// `writeJsonAtomic` uses). An origin that mines zero edges AND zero targets
// this sweep is skipped entirely -- no read, no write, not added to
// `sites.origins` -- so a no-op sweep (nothing new to compile) reports
// `sites` as all-zeros/empty without needing a separate "already seen"
// check (CONTRACT, pinned here since the brief leaves the exact shape of
// "nothing mined" to the implementation): `sites.origins` lists only
// origins this SWEEP CALL actually wrote to, not every origin site memory
// has ever seen.
//
// A sites store failure (a mining, merge, or write error for one origin)
// is caught PER ORIGIN and reported as `sites.errors: [{ origin, error }]`
// (error MESSAGE, never the raw exception) -- it must never fail the flow
// sweep itself: flows still compile, the cursor still advances, exactly as
// if mining had not run at all for that origin. This mirrors F1's crash-
// safety posture in spirit but is a deliberately SEPARATE failure domain --
// an operational fault writing `graph.json` is not a flow-compile fault,
// and conflating them would mean a broken `sites` directory could silently
// stop flow compilation, which is not this module's job to protect against
// (site memory is additive, best-effort bookkeeping over the same slice).

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
// integer>, provenanceLines?: <non-negative integer>, incomplete?: true }`
// -- anything else (wrong shape, a negative/non-integer `lines`, an
// `incomplete` that isn't literally `true`) is treated as absent rather
// than as a reason to discard the whole state file: one hand-edited or
// half-written entry shouldn't cost every OTHER session its cursor.
// `provenanceLines` absent or malformed defaults to `lines` -- see the
// module doc comment's "tolerant of the OLD one-cursor shape" note.
function validProcessedEntry(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!Number.isInteger(value.lines) || value.lines < 0) return null;
  const provenanceLines = Number.isInteger(value.provenanceLines) && value.provenanceLines >= 0
    ? value.provenanceLines
    : value.lines;
  const entry = { lines: value.lines, provenanceLines };
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

// F8: prunes any entry whose trace directory this sweep didn't actually
// see (`validBasenames`, drawn from THIS sweep's own `listTraceSessions`
// result) before writing -- "at save time" so the in-memory `state`
// object stays the simple single source of truth for the whole sweep call,
// and only the on-disk/returned view is ever filtered.
async function saveState(stateFile, state, validBasenames) {
  const processed = {};
  for (const [key, value] of Object.entries(state.processed)) {
    if (validBasenames.has(key)) processed[key] = value;
  }
  const pruned = { schemaVersion: state.schemaVersion, processed };
  await writeJsonAtomic(stateFile, `${JSON.stringify(pruned, null, 2)}\n`);
  return pruned;
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
// same slice is written twice, each time with the cumulative counters so
// far, which is simpler than batching writes and still leaves the on-disk
// file correct after the last write. `updatedById` is the SWEEP-LEVEL
// aggregate (F7): keyed by flow id so a flow touched by replays in more
// than one session across this whole sweep gets exactly one final entry,
// never two contradictory snapshots.
async function applyReplayRecords(replayRecords, registry, updatedById) {
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
    updatedById.set(nextFlow.id, {
      name: nextFlow.name,
      successRuns: provenance.successRuns,
      failStreak: provenance.failStreak,
    });
  }
}

// --- site memory mining (module doc comment's "site memory mining" note) ---

// Resolves a raw URL to its canonical `.origin` string, or null when it's
// missing, unparseable, or not http(s) -- the same "usable" gate
// graph.mjs's/inventory.mjs's own `urlInfo` apply before ever computing an
// origin, reproduced locally (not imported) for the same small-helper/
// anti-circularity reasoning those modules already document for their own
// `isReplayRecord`.
function canonicalOrigin(url) {
  if (typeof url !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.origin;
}

// Groups a compile slice's records by each record's own canonical origin --
// `urlAfter` first, `urlBefore` as fallback (module doc comment) -- so a
// session that touches several origins mines each with its own `origin`
// option rather than one call blending them. A record with neither usable
// contributes to no group; insertion order of `Map` keys is preserved,
// which only matters for test determinism, not correctness.
function groupRecordsByOrigin(records) {
  const groups = new Map();
  for (const record of records) {
    const origin = canonicalOrigin(record?.urlAfter) ?? canonicalOrigin(record?.urlBefore);
    if (origin === null) continue;
    let group = groups.get(origin);
    if (!group) {
      group = [];
      groups.set(origin, group);
    }
    group.push(record);
  }
  return groups;
}

// Runs the graph/inventory miners over one compile slice, grouped per
// origin, merging each origin's mined output into its on-disk store and
// reporting sweep-shaped totals -- `{ origins, edges, targets, evicted,
// errors }` (module doc comment's pinned contract: an origin that mines
// nothing this call is skipped entirely, never read, written, or listed).
// `edges`/`targets` count the MINERS' own output for this call (every
// edge `mineGraphEdges` pushed; every distinct role|name target entry
// `mineInventory` produced), not the resulting on-disk totals after merge
// -- a session replaying already-known routes/targets still reports the
// same edges/targets count as a session that discovers all-new ones; only
// `evicted` reflects the merge's own bookkeeping. A per-origin failure
// (read is never-throw, so in practice a merge/write fault) is caught here
// and turned into a `sites.errors` entry rather than propagating -- see the
// module doc comment's "must never fail the flow sweep" note.
async function mineSiteMemory(compileRecords, paths, clock) {
  const origins = [];
  let edges = 0;
  let targets = 0;
  let evicted = 0;
  const errors = [];

  for (const [origin, originRecords] of groupRecordsByOrigin(compileRecords)) {
    try {
      const minedEdges = mineGraphEdges(originRecords, { origin, now: clock }).edges;
      const minedPatterns = mineInventory(originRecords, { origin, now: clock }).patterns;
      const minedTargetCount = Object.values(minedPatterns)
        .reduce((total, entry) => total + entry.targets.length, 0);
      if (minedEdges.length === 0 && minedTargetCount === 0) continue; // nothing to merge here

      const existing = await readSite(paths, origin, { now: clock });
      const graphResult = mergeGraph(existing.graph, minedEdges, { now: clock });
      const inventoryResult = mergeInventory(existing.inventory, { patterns: minedPatterns }, { now: clock });
      await writeGraph(paths, origin, graphResult.graph);
      await writeInventory(paths, origin, inventoryResult.inventory);

      origins.push(origin);
      edges += minedEdges.length;
      targets += minedTargetCount;
      evicted += graphResult.evicted + inventoryResult.evicted;
    } catch (error) {
      errors.push({ origin, error: error?.message ?? String(error) });
    }
  }

  return {
    origins, edges, targets, evicted, errors,
  };
}

// --- public API ---

// sweep({ paths, now? }) -> { compiled: [{ name, tier }], updated: [{ name,
//   successRuns, failStreak }], sessionsProcessed, cursor, skippedBySession:
//   { '<traceDir>': [{ reason, seqRange }] }, replaysSeen, sites: { origins:
//   [origin], edges, targets, evicted, errors: [{ origin, error }] } }
//
// `now` is this module's own clock-injection point, matching the
// codebase's `now: supplied.now ?? (() => new Date())` convention
// (lib/commands/setup.mjs, configure.mjs). It's always passed down to
// `compileSession`, but only ever consulted there for a session with no
// `meta.endedAt` yet -- which, under this module's own deferred-compile
// design, no longer happens in practice (compilation only ever runs once
// `meta.endedAt` exists), but is still wired through so `compileSession`'s
// own contract (it throws `CompileError` if neither is available) is never
// at risk of tripping.
//
// Trace sessions live directly under `paths.dataDir` (`listTraceSessions`);
// `paths.flowsStateFile` is the incremental cursor (module doc comment);
// `paths.flowsDir`/`paths.flowsPendingDir` are the two tier destinations
// (`flowTier`). Never throws on trace/state input -- missing/corrupt state
// starts fresh, a session with no compilable content this round just
// contributes nothing. Operational faults (a write that fails because a
// tier directory can't be created/written) are NOT swallowed -- see the
// module doc comment's "crash safety" note; F1 is what makes that safe to
// let propagate.
export async function sweep({ paths, now } = {}) {
  const clock = now ?? (() => new Date());
  const state = await loadState(paths.flowsStateFile);
  const registry = await loadArtifactRegistry(paths);
  const sessions = await listTraceSessions(paths.dataDir);
  const validBasenames = new Set(sessions.map((session) => path.basename(session.dir)));

  const compiled = [];
  const updatedById = new Map();
  const skippedBySession = {};
  let replaysSeen = 0;
  let sessionsProcessed = 0;
  const sitesOrigins = new Set();
  let sitesEdges = 0;
  let sitesTargets = 0;
  let sitesEvicted = 0;
  const sitesErrors = [];
  // Pruning (F8) needs at least one save even when there are zero sessions
  // to iterate below -- e.g. a dataDir that's been fully emptied since the
  // last sweep must still drop its now-stale state entries.
  let finalState = await saveState(paths.flowsStateFile, state, validBasenames);

  for (const session of sessions) {
    const basename = path.basename(session.dir);
    const previous = state.processed[basename];
    const previousLines = previous?.lines ?? 0;
    const previousProvenanceLines = previous?.provenanceLines ?? previousLines;
    const isComplete = typeof session.meta?.endedAt === 'string';

    const { records, readable } = await readTraceRecords(session.dir);

    if (!readable) {
      // N1: leave this session completely untouched -- see the module doc
      // comment's "unreadable sessions" note. No cursor write, no compile,
      // no provenance; just surface it and move on to the next session.
      skippedBySession[basename] = [{ reason: 'unreadable', seqRange: [null, null] }];
      finalState = await saveState(paths.flowsStateFile, state, validBasenames);
      continue;
    }

    let touchedThisSession = false;
    let nextLines = previousLines;

    // Compilation: deferred entirely until the session is complete (module
    // doc comment's "fragment flows" note). Once complete, whatever range
    // hasn't been compiled yet -- possibly the WHOLE file, if this session
    // was never seen before it closed -- compiles in one shot.
    if (isComplete) {
      const compileSlice = records.length > previousLines ? records.slice(previousLines) : [];
      const compileRecords = compileSlice.filter((record) => !isReplayRecord(record));
      if (compileRecords.length > 0) {
        touchedThisSession = true;
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

        // Site memory mining: the SAME `compileRecords` slice compileSession
        // just consumed (module doc comment's "site memory mining" note) --
        // never a new/separate cursor, and never run for a live session
        // (this whole block is inside `if (isComplete)`).
        const siteResult = await mineSiteMemory(compileRecords, paths, clock);
        for (const origin of siteResult.origins) sitesOrigins.add(origin);
        sitesEdges += siteResult.edges;
        sitesTargets += siteResult.targets;
        sitesEvicted += siteResult.evicted;
        sitesErrors.push(...siteResult.errors);
      }
      nextLines = records.length;
    }

    // Replay provenance: independent of completion (module doc comment's
    // two-cursor note) -- scanned every sweep, live or complete, from
    // wherever provenance scanning last left off.
    const provenanceSlice = records.length > previousProvenanceLines
      ? records.slice(previousProvenanceLines)
      : [];
    const replayRecords = provenanceSlice.filter(isReplayRecord);
    if (replayRecords.length > 0) {
      touchedThisSession = true;
      replaysSeen += replayRecords.length;
      await applyReplayRecords(replayRecords, registry, updatedById);
    }
    const nextProvenanceLines = records.length;

    if (touchedThisSession) sessionsProcessed += 1;

    const nextEntry = { lines: nextLines, provenanceLines: nextProvenanceLines };
    if (!isComplete) nextEntry.incomplete = true;
    state.processed[basename] = nextEntry;

    // F1: persist after THIS session's writes succeed, before moving on --
    // a later session's failure must never rewind an earlier session's
    // already-durable progress.
    finalState = await saveState(paths.flowsStateFile, state, validBasenames);
  }

  return {
    compiled,
    updated: [...updatedById.values()],
    sessionsProcessed,
    cursor: { ...finalState.processed },
    skippedBySession,
    replaysSeen,
    sites: {
      origins: [...sitesOrigins],
      edges: sitesEdges,
      targets: sitesTargets,
      evicted: sitesEvicted,
      errors: sitesErrors,
    },
  };
}
