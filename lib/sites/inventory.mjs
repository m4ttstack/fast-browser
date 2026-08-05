import { cleanArray } from '../flows/trace-reader.mjs';
import { normalizeUrlPattern } from './patterns.mjs';
import { MAX_PATTERNS_PER_ORIGIN, MAX_TARGETS_PER_PATTERN } from './store.mjs';

// The interaction-inventory miner (WS2b plan, Task 3): turns a session's raw
// TraceRecords into `inventory.json` patterns (store.mjs's shape,
// `{ patterns: { [urlPattern]: { targets: [{ role, name, kinds, count,
// lastSeenAt }], lastSeenAt } } }`).
//
// **What gets keyed, and how.** Each record is filed under the normalized
// pattern of its OWN `urlBefore` -- the page the interaction happened ON --
// falling back to `urlAfter` only when `urlBefore` is missing, unparseable,
// or resolves to a different origin than the one being mined. This mirrors
// graph.mjs's `from`/`to` split conceptually (urlBefore is "where this
// happened"), but inventory has no `to`: an interaction target belongs to
// the page it was found on, not wherever the action navigated next.
// Whichever URL wins the fallback still has to resolve to `origin` itself
// (canonical `.origin` comparison, the binding carry-down from Task 1's
// review) -- a record that fails that check contributes nothing, exactly
// like graph.mjs drops a cross-origin `urlAfter`.
//
// **What counts as an "enriched" target.** TRACE.md's `TraceTarget` shape
// (`{ ref?, resolved?, alternates, role?, name?, description? }`) degrades
// to `{ ref, resolved, alternates: [] }` -- no `role`/`name` -- when the
// enrichment channel round trip itself failed (TRACE.md, "targets" section).
// A target only contributes to the inventory when it carries BOTH a
// non-empty `role` and a non-empty `name`; this is what "records with no
// enriched targets contribute nothing" means literally: `targets: []`,
// `targets` truncated to a bare marker, and every target present but
// degraded (no role/name) are the same outcome as far as this miner is
// concerned. `alternates` is `cleanArray`'d per element the same way
// compile.mjs's `targetFromRecord` does -- a trailing truncation marker
// must never be mistaken for a real `TraceLocator`, and a target whose
// OWN `alternates` collapsed to a bare marker still keeps its role/name
// (kinds just come back empty) rather than losing the whole target.
//
// **Replays are excluded, exactly as they are from compilation and from
// graph mining.** A replay record is `tool === 'browser_run_code_unsafe'`
// whose `params.filename` is a string ending `flow-runner.js` (the WS2a
// contract, `lib/flows/sweep.mjs`'s `isReplayRecord`). Reproduced locally
// rather than imported, same reasoning as graph.mjs: `sweep.mjs` (Task 4)
// will import THIS module, so importing the other way would be circular,
// and graph.mjs doesn't export its own copy for inventory.mjs to share.
//
// **Never throws on hostile records.** Every field read off a record is
// guarded (`typeof` / `cleanArray`) rather than assumed, mirroring
// graph.mjs's posture for the same raw input.
//
// **The `__proto__` hazard, and why it's structurally unreachable from
// mining alone.** `mineInventory`'s own two key sources are a
// `normalizeUrlPattern` result (always a leading-`/` string -- see
// patterns.mjs, never literally `"__proto__"`) and `${role}|${name}`
// (always contains a literal `|`, so it can never equal `"__proto__"`
// either). Internally this module keys both levels with `Map`, which has
// no `[[Set]]`-on-`__proto__` hazard at all regardless. The hazard store.mjs's
// `parseInventory` guards against (a `"__proto__"` OWN key from
// `JSON.parse`, which -- unlike an object literal or bracket assignment --
// uses `CreateDataProperty` rather than `[[Set]]`) becomes reachable only
// where a plain object is actually constructed with a caller-supplied key:
// `flattenPatterns` below (both `mineInventory`'s and `mergeInventory`'s
// final `{ patterns }` shape) and `toWorkingPatterns` (which reads
// `existing`/`mined` -- caller-supplied, not necessarily produced by this
// module's own mining path -- Task 4's sweep and any test can hand
// `mergeInventory` a `JSON.parse`'d object directly). Both guard it the
// same way store.mjs's `parseInventory` does (skip the key), except
// SKIPPED rather than THROWN: unlike store.mjs's strict on-disk-shape
// validator, this module's contract is never-throw-on-hostile-input.

const FLOW_RUNNER_SUFFIX = 'flow-runner.js';

function isReplayRecord(record) {
  return (
    record.tool === 'browser_run_code_unsafe'
    && typeof record?.params?.filename === 'string'
    && record.params.filename.endsWith(FLOW_RUNNER_SUFFIX)
  );
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// Resolves a raw `urlBefore`/`urlAfter` value to its normalized pattern and
// canonical origin in one pass, never throwing -- identical contract to
// graph.mjs's own `urlInfo` (reproduced rather than shared: neither module
// exports it, and both are small enough that importing one from the other
// isn't worth the coupling).
function urlInfo(url) {
  if (typeof url !== 'string') return { pattern: null, origin: null, usable: false };
  const pattern = normalizeUrlPattern(url);
  if (pattern === null) return { pattern: null, origin: null, usable: false };
  return { pattern, origin: originOf(url), usable: true };
}

// Resolves the pattern a record's targets should be filed under:
// `urlBefore` when it's usable AND already on `origin`, else `urlAfter`
// (consulted whether or not IT lands on `origin` -- the caller checks that
// separately, since "fell back and still isn't on origin" is a normal,
// expected outcome for a multi-origin session, not a bug).
function keyingUrlInfo(record, origin) {
  const before = urlInfo(record.urlBefore);
  if (before.usable && before.origin === origin) return before;
  return urlInfo(record.urlAfter);
}

// Extracts the enriched-target view of a raw TraceTarget at
// `record.targets[index]` (already `cleanArray`'d by the caller), or `null`
// when the target doesn't qualify (not an object, or missing/empty
// `role`/`name` -- TRACE.md's documented enrichment-failure shape).
function enrichedTargetInfo(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.role !== 'string' || raw.role.length === 0) return null;
  if (typeof raw.name !== 'string' || raw.name.length === 0) return null;

  const { items: alternates } = cleanArray(raw.alternates);
  const kinds = new Set(
    alternates
      .filter((alt) => alt && typeof alt === 'object' && typeof alt.kind === 'string')
      .map((alt) => alt.kind),
  );

  return { role: raw.role, name: raw.name, kinds };
}

function targetKey(role, name) {
  return `${role}|${name}`;
}

// Converts the internal `Map<pattern, { targets: Map<'role|name', entry>,
// lastSeenAt }>` working structure both `mineInventory` and `mergeInventory`
// build into the plain, JSON-serializable `{ [pattern]: { targets: [...],
// lastSeenAt } }` shape store.mjs's `writeInventory` expects. This is the
// one point where a caller-supplied key becomes a plain-object property
// (`result[pattern] = ...`), so it's also the one point that needs the
// `"__proto__"` guard -- see the module doc comment above.
function flattenPatterns(patternsMap) {
  const result = {};
  for (const [pattern, bucket] of patternsMap) {
    if (pattern === '__proto__') continue;
    const targets = [];
    for (const [key, entry] of bucket.targets) {
      if (key === '__proto__') continue;
      targets.push({
        role: entry.role,
        name: entry.name,
        kinds: Array.from(entry.kinds),
        count: entry.count,
        lastSeenAt: entry.lastSeenAt,
      });
    }
    result[pattern] = { targets, lastSeenAt: bucket.lastSeenAt };
  }
  return result;
}

// mineInventory(records, { origin, now }) -> { patterns }.
// `records` is a raw TraceRecord array (no TOOL_OPS filtering, same as
// graph.mjs's `mineGraphEdges`). `origin` is a canonical
// `new URL(url).origin` string (never validated/normalized here -- the
// binding carry-down from Task 1's review: this module trusts its caller
// to have already canonicalized it the same way store.mjs requires for
// writes, exactly as graph.mjs does). `now` is this codebase's standing
// clock-injection point (defaults to `() => new Date()`); every target
// touched by this mine call is stamped `lastSeenAt: now().toISOString()`,
// and so is every pattern that gained at least one target.
export function mineInventory(records, { origin, now = () => new Date() } = {}) {
  const nowIso = now().toISOString();
  const patterns = new Map();

  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record !== 'object') continue;
    if (isReplayRecord(record)) continue;

    const keying = keyingUrlInfo(record, origin);
    if (!keying.usable || keying.origin !== origin) continue;

    const { items } = cleanArray(record.targets);
    const enriched = items.map(enrichedTargetInfo).filter((info) => info !== null);
    if (enriched.length === 0) continue; // "records with no enriched targets contribute nothing"

    let bucket = patterns.get(keying.pattern);
    if (!bucket) {
      bucket = { targets: new Map(), lastSeenAt: nowIso };
      patterns.set(keying.pattern, bucket);
    } else {
      bucket.lastSeenAt = nowIso;
    }

    for (const info of enriched) {
      const key = targetKey(info.role, info.name);
      let entry = bucket.targets.get(key);
      if (!entry) {
        entry = {
          role: info.role, name: info.name, kinds: new Set(), count: 0, lastSeenAt: nowIso,
        };
        bucket.targets.set(key, entry);
      }
      for (const kind of info.kinds) entry.kinds.add(kind);
      entry.count += 1;
      entry.lastSeenAt = nowIso;
    }
  }

  return { patterns: flattenPatterns(patterns) };
}

// Converts a raw `patterns` field (either a real inventory.json's, via
// store.mjs's `readSite`, or a caller-supplied/hostile object -- callers of
// `mergeInventory` are not required to have run their input through
// store.mjs's `parseInventory` first) into the internal `Map`-keyed working
// structure. Never throws: anything not shaped like a plain object
// collapses to no patterns; malformed entries/targets are dropped
// individually rather than aborting the whole conversion. `nowIso` fills in
// for any missing/invalid `lastSeenAt` so every pattern/target in the
// working set always carries a usable timestamp for eviction ranking.
function toWorkingPatterns(rawPatterns, nowIso) {
  const patterns = new Map();
  if (!rawPatterns || typeof rawPatterns !== 'object' || Array.isArray(rawPatterns)) {
    return patterns;
  }

  for (const key of Object.keys(rawPatterns)) {
    // Same "__proto__" own-key hazard store.mjs's `parseInventory` guards
    // on read (see the module doc comment) -- skipped here, never thrown.
    if (key === '__proto__') continue;

    const rawEntry = rawPatterns[key];
    const rawTargets = Array.isArray(rawEntry?.targets) ? rawEntry.targets : [];
    const targets = new Map();
    for (const rawTarget of rawTargets) {
      if (!rawTarget || typeof rawTarget !== 'object') continue;
      if (typeof rawTarget.role !== 'string' || typeof rawTarget.name !== 'string') continue;
      const tKey = targetKey(rawTarget.role, rawTarget.name);
      if (tKey === '__proto__') continue; // structurally unreachable (see doc comment); guarded anyway
      const kinds = Array.isArray(rawTarget.kinds)
        ? rawTarget.kinds.filter((kind) => typeof kind === 'string')
        : [];
      const count = Number.isInteger(rawTarget.count) && rawTarget.count > 0 ? rawTarget.count : 1;
      const lastSeenAt = typeof rawTarget.lastSeenAt === 'string' ? rawTarget.lastSeenAt : nowIso;
      targets.set(tKey, {
        role: rawTarget.role, name: rawTarget.name, kinds: new Set(kinds), count, lastSeenAt,
      });
    }

    const lastSeenAt = typeof rawEntry?.lastSeenAt === 'string' ? rawEntry.lastSeenAt : nowIso;
    patterns.set(key, { targets, lastSeenAt });
  }

  return patterns;
}

// Repeatedly removes the lowest-`count` entry from `targetsMap` (ties
// broken by the oldest `lastSeenAt`) until its size is at most `maxTargets`,
// returning the number removed. Shared by `mergeInventory`'s per-pattern
// bound; same lowest-count-then-oldest rule as graph.mjs's `mergeGraph`
// eviction loop, just over a `Map` instead of an array.
function evictTargets(targetsMap, maxTargets) {
  let evicted = 0;
  while (targetsMap.size > maxTargets) {
    let evictKey = null;
    let evictEntry = null;
    for (const [key, entry] of targetsMap) {
      const worse = evictEntry === null
        || entry.count < evictEntry.count
        || (entry.count === evictEntry.count && entry.lastSeenAt < evictEntry.lastSeenAt);
      if (worse) {
        evictKey = key;
        evictEntry = entry;
      }
    }
    targetsMap.delete(evictKey);
    evicted += 1;
  }
  return evicted;
}

// A `PatternEntry` (store.mjs's shape) carries no `count` of its own --
// only its `targets` do. For the per-origin pattern bound, this module's
// judgment call (the plan brief doesn't pin one) is to rank a pattern by
// the SUM of its targets' counts: the total interaction volume mined for
// that route, which is the most natural stand-in for "how much this pattern
// has been used" given the shape actually on disk. Ties still break on the
// pattern's own `lastSeenAt`, oldest first, same rule as everywhere else.
function patternWeight(bucket) {
  let total = 0;
  for (const entry of bucket.targets.values()) total += entry.count;
  return total;
}

function evictPatterns(patternsMap, maxPatterns) {
  let evicted = 0;
  while (patternsMap.size > maxPatterns) {
    let evictKey = null;
    let evictWeight = null;
    let evictLastSeenAt = null;
    for (const [key, bucket] of patternsMap) {
      const weight = patternWeight(bucket);
      const worse = evictKey === null
        || weight < evictWeight
        || (weight === evictWeight && bucket.lastSeenAt < evictLastSeenAt);
      if (worse) {
        evictKey = key;
        evictWeight = weight;
        evictLastSeenAt = bucket.lastSeenAt;
      }
    }
    patternsMap.delete(evictKey);
    evicted += 1;
  }
  return evicted;
}

// mergeInventory(existing, mined, { now, bounds }) -> { inventory, evicted }.
// `existing` is an inventory.json-shaped object (`{ schemaVersion, patterns
// }`, e.g. `readSite(...).inventory`) or nullish/hostile (a fresh origin, or
// a corrupted store read that already degraded to something other than the
// expected shape); `mined` is `mineInventory(...)`'s own return shape (or,
// again, anything caller-supplied -- never assumed trusted).
//
// On a role|name match within a pattern: `count` accumulates, `kinds`
// unions, and `lastSeenAt` is REFRESHED to this merge's own `now()` --
// mirrors `mergeGraph`'s literal wording ("merge increments count and
// refreshes lastSeenAt"). A pattern that gains or updates at least one
// target this merge also has ITS `lastSeenAt` refreshed to `now()`,
// matching the fact that mining only ever produces a pattern with at least
// one target ("records with no enriched targets contribute nothing"
// applies here too: a mined pattern entry with zero targets -- possible
// only from hostile/hand-built `mined` input, never from `mineInventory`
// itself -- touches nothing).
//
// `bounds.maxTargetsPerPattern` / `bounds.maxPatternsPerOrigin` override the
// shared `MAX_TARGETS_PER_PATTERN` / `MAX_PATTERNS_PER_ORIGIN` bounds
// (store.mjs, Task 1 -- imported, never redefined, per the binding
// carry-down); overridable so tests can exercise eviction without
// constructing 40/200+ real entries. The per-pattern bound runs first,
// against every pattern in the working set (touched or not this merge,
// mirroring `mergeGraph`'s "evict until under bound" loop over the whole
// set rather than only new entries); the per-origin pattern bound runs
// after, over the patterns that remain. `evicted` counts every removal at
// either level as one -- a whole pattern evicted at the per-origin bound
// counts once, same as a single target evicted at the per-pattern bound --
// so truncation is always reported, never silent, matching graph.mjs's own
// eviction-counting contract.
export function mergeInventory(existing, mined, { now = () => new Date(), bounds = {} } = {}) {
  const maxTargetsPerPattern = bounds.maxTargetsPerPattern ?? MAX_TARGETS_PER_PATTERN;
  const maxPatternsPerOrigin = bounds.maxPatternsPerOrigin ?? MAX_PATTERNS_PER_ORIGIN;
  const schemaVersion = existing?.schemaVersion ?? 1;
  const nowIso = now().toISOString();

  const patterns = toWorkingPatterns(existing?.patterns, nowIso);
  const incoming = toWorkingPatterns(mined?.patterns, nowIso);

  for (const [pattern, incomingBucket] of incoming) {
    if (incomingBucket.targets.size === 0) continue; // nothing to merge for this pattern

    let bucket = patterns.get(pattern);
    if (!bucket) {
      bucket = { targets: new Map(), lastSeenAt: nowIso };
      patterns.set(pattern, bucket);
    } else {
      bucket.lastSeenAt = nowIso;
    }

    for (const [key, incomingTarget] of incomingBucket.targets) {
      const match = bucket.targets.get(key);
      if (match) {
        match.count += incomingTarget.count;
        match.lastSeenAt = nowIso;
        for (const kind of incomingTarget.kinds) match.kinds.add(kind);
      } else {
        bucket.targets.set(key, {
          role: incomingTarget.role,
          name: incomingTarget.name,
          kinds: new Set(incomingTarget.kinds),
          count: incomingTarget.count,
          lastSeenAt: incomingTarget.lastSeenAt,
        });
      }
    }
  }

  let evicted = 0;
  for (const bucket of patterns.values()) {
    evicted += evictTargets(bucket.targets, maxTargetsPerPattern);
  }
  evicted += evictPatterns(patterns, maxPatternsPerOrigin);

  return { inventory: { schemaVersion, patterns: flattenPatterns(patterns) }, evicted };
}
