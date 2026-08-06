import { cleanArray, isReplayRecord } from '../flows/trace-reader.mjs';
import { normalizeUrlPattern } from './patterns.mjs';
import { MAX_EDGES_PER_ORIGIN } from './store.mjs';

// The navigation-graph miner (WS2b plan, Task 2): turns a session's raw
// TraceRecords into `graph.json` edges (store.mjs's shape,
// `{ from, to, action: { tool, targetName? }, count, lastSeenAt }`).
//
// **Segmentation-independent, unlike the flow compiler.** `compile.mjs`
// only turns a curated `TOOL_OPS` subset of tools into replay steps and
// drops anything else (including `browser_navigate_back`, dialog handling,
// etc.) as unsupported. The graph miner has no such curation: every record
// with a real cross-URL transition on `origin` becomes an edge, regardless
// of whether that tool is one the compiler would ever turn into a flow
// step. Site memory is "where does this site's navigation go", not "what
// can be replayed" -- those are different questions over the same trace.
//
// **`from` vs `to`.** `to` is always the normalized pattern of `urlAfter`
// (required -- an edge with no destination isn't an edge) and is always
// on `origin` by construction (records with a `urlAfter` on a different
// origin are silently not this origin's edge, see below). `from` is the
// normalized pattern of `urlBefore` only when `urlBefore` is ALSO on
// `origin`; anything else (a different origin, `about:blank`, missing,
// unparseable) collapses to `null` -- an "entry edge", the site was
// entered from outside this origin's own graph.
//
// **What counts as `skippedRecords` and what doesn't.** Only two things
// increment it, per the plan brief: (1) replay records (see
// `isReplayRecord`, imported above) and (2) records whose `urlAfter` is
// missing or doesn't parse as an http(s) URL -- there is no usable
// destination to mine at all. Two other "no edge" outcomes are deliberately
// NOT counted here: `urlBefore === urlAfter` (nothing navigated) and a same-origin-
// unusable-but-parseable `urlAfter` that lands on a DIFFERENT origin (a
// cross-origin navigation away from `origin`). Both are ordinary, expected
// outcomes of feeding this miner a per-origin slice of a session that
// legitimately touched several origins (sweep.mjs's Task 4 groups records
// by their own origin before calling this per origin) -- counting them as
// "skipped" would make every multi-origin sweep look lossy for records
// that were never lost, just not this origin's edge.
//
// **Replays are excluded, exactly as they are from compilation.** A
// replay record is `tool === 'browser_run_code_unsafe'` whose
// `params.filename` is a string ending `flow-runner.js` -- the WS2a
// contract, `isReplayRecord` imported from `trace-reader.mjs` (WS3b Task 1;
// previously a copy reproduced locally here and in inventory.mjs/sweep.mjs
// to avoid a circular import back into sweep.mjs -- trace-reader.mjs has
// no dependency on any of the three, so importing the predicate from there
// instead isn't circular).
//
// **Never throws on hostile records.** Every field read off a record is
// guarded (`typeof` / `cleanArray`) rather than assumed; a record missing
// fields, carrying non-string `urlBefore`/`urlAfter`, or ending its
// `targets` array in a truncation marker degrades to "no edge" or "no
// targetName", never a crash. This mirrors `trace-reader.mjs`'s own
// contract for the same raw input.

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// Resolves a raw `urlBefore`/`urlAfter` value to its normalized pattern and
// canonical origin in one pass, never throwing. `usable: false` means
// there's no pattern to mine at all (not a string, or not an http(s) URL
// `normalizeUrlPattern` accepts) -- the caller decides whether that's a
// skip (required field) or just a `null` `from` (optional field).
function urlInfo(url) {
  if (typeof url !== 'string') return { pattern: null, origin: null, usable: false };
  const pattern = normalizeUrlPattern(url);
  if (pattern === null) return { pattern: null, origin: null, usable: false };
  return { pattern, origin: originOf(url), usable: true };
}

// Pulls `action.targetName` from the record's FIRST enriched target
// (targets[0] after `cleanArray` strips any trailing truncation marker),
// per the plan brief. Every other target on a multi-target call (drag's
// end point, fill_form's later fields) is deliberately not represented --
// the graph edge is about which ACTION led where, not a full replay of the
// call's arguments.
function firstTargetName(record) {
  const { items } = cleanArray(record?.targets);
  const first = items[0];
  if (first && typeof first === 'object' && typeof first.name === 'string' && first.name.length > 0) {
    return first.name;
  }
  return null;
}

// mineGraphEdges(records, { origin, now }) -> { edges, skippedRecords }.
// `records` is a raw TraceRecord array (no TOOL_OPS filtering -- see the
// module doc comment). `origin` is a canonical `new URL(url).origin`
// string (never validated/normalized here -- the binding carry-down from
// Task 1's review: origin comparison is always by canonical `.origin`,
// never string prefix, and this module trusts its caller to have already
// canonicalized it the same way `store.mjs` requires for writes). `now` is
// this codebase's standing clock-injection point (defaults to
// `() => new Date()`); each newly mined edge is stamped `lastSeenAt:
// now().toISOString()` at mine time -- `mergeGraph` refreshes that stamp
// again on an actual dedup match (see its own doc comment), so the two
// clocks only diverge when a caller deliberately passes different `now`s
// to the two calls, which production code (Task 4's sweep) never does.
export function mineGraphEdges(records, { origin, now = () => new Date() } = {}) {
  const edges = [];
  let skippedRecords = 0;

  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record !== 'object') {
      skippedRecords += 1;
      continue;
    }
    if (isReplayRecord(record)) {
      skippedRecords += 1;
      continue;
    }

    const after = urlInfo(record.urlAfter);
    if (!after.usable) {
      // Missing or unparseable urlAfter: no destination to mine at all.
      skippedRecords += 1;
      continue;
    }
    if (record.urlBefore === record.urlAfter) continue; // no navigation happened
    if (after.origin !== origin) continue; // navigated to a different origin than we're mining

    if (typeof record.tool !== 'string') {
      // A record with a real cross-URL transition but no usable tool name
      // can't form a valid action -- store.mjs's parseAction requires
      // `tool` to be a string. Hostile input, not a bug in the caller.
      skippedRecords += 1;
      continue;
    }

    const before = urlInfo(record.urlBefore);
    const from = before.usable && before.origin === origin ? before.pattern : null;

    const action = { tool: record.tool };
    const targetName = firstTargetName(record);
    if (targetName !== null) action.targetName = targetName;

    edges.push({
      from,
      to: after.pattern,
      action,
      count: 1,
      lastSeenAt: now().toISOString(),
    });
  }

  return { edges, skippedRecords };
}

// Dedup key per the plan's Shared shapes table: `from|to|action.tool|
// action.targetName`. `from` is only ever `null` or a normalizeUrlPattern
// result (which is always non-empty, minimum `/`), and `targetName` is
// only ever `undefined`/absent or a non-empty string (see
// `firstTargetName`), so the empty string is a safe, collision-free
// sentinel for "absent" in both positions -- no real pattern or target
// name can ever equal it.
function edgeKey(edge) {
  return [edge.from ?? '', edge.to, edge.action?.tool ?? '', edge.action?.targetName ?? ''].join('|');
}

// mergeGraph(existing, newEdges, { now, bounds }) -> { graph, evicted }.
// `existing` is a graph.json-shaped object (`{ schemaVersion, edges }`,
// e.g. `readSite(...).graph`) or nullish (a fresh origin); `newEdges` is
// `mineGraphEdges(...).edges`. Folds `newEdges` into `existing.edges` one
// at a time, in order -- so two new edges that share a dedup key (the same
// route+action mined twice in one session) collapse into each other
// exactly like a new edge colliding with a pre-existing one, with no
// separate "dedupe within the batch first" pass needed.
//
// On a dedup match: `count` accumulates (`match.count += incoming.count`)
// and `lastSeenAt` is REFRESHED to this merge's own `now()` -- the plan
// brief's literal wording ("merge increments count and refreshes
// lastSeenAt"). On no match (brand new edge): the incoming edge is added
// as given, including its own `lastSeenAt` from mine time -- there is
// nothing to "refresh" for an edge the graph has never seen before.
//
// `bounds.maxEdgesPerOrigin` overrides the shared `MAX_EDGES_PER_ORIGIN`
// bound (store.mjs, Task 1 -- imported, never redefined, per the binding
// carry-down); overridable so tests can exercise eviction without
// constructing 200+ edges. Eviction runs after every merge: while over
// bound, repeatedly remove the edge with the lowest `count` (ties broken
// by the oldest `lastSeenAt` -- ISO-8601 strings compare correctly as
// plain strings), incrementing `evicted` once per removal so truncation is
// always reported, never silent.
export function mergeGraph(existing, newEdges, { now = () => new Date(), bounds = {} } = {}) {
  const maxEdgesPerOrigin = bounds.maxEdgesPerOrigin ?? MAX_EDGES_PER_ORIGIN;
  const schemaVersion = existing?.schemaVersion ?? 1;
  const edges = (Array.isArray(existing?.edges) ? existing.edges : [])
    .map((edge) => ({ ...edge, action: { ...edge.action } }));
  const nowIso = now().toISOString();

  for (const incoming of Array.isArray(newEdges) ? newEdges : []) {
    const key = edgeKey(incoming);
    const match = edges.find((edge) => edgeKey(edge) === key);
    if (match) {
      match.count += incoming.count ?? 1;
      match.lastSeenAt = nowIso;
    } else {
      edges.push({
        from: incoming.from ?? null,
        to: incoming.to,
        action: { ...incoming.action },
        count: incoming.count ?? 1,
        lastSeenAt: incoming.lastSeenAt ?? nowIso,
      });
    }
  }

  let evicted = 0;
  while (edges.length > maxEdgesPerOrigin) {
    let evictIndex = 0;
    for (let i = 1; i < edges.length; i += 1) {
      const lower = edges[i].count < edges[evictIndex].count;
      const tiedButOlder = edges[i].count === edges[evictIndex].count
        && edges[i].lastSeenAt < edges[evictIndex].lastSeenAt;
      if (lower || tiedButOlder) evictIndex = i;
    }
    edges.splice(evictIndex, 1);
    evicted += 1;
  }

  return { graph: { schemaVersion, edges }, evicted };
}
