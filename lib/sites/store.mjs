import crypto from 'node:crypto';
import {
  chmod, readFile, readdir, rename, unlink, writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { ensurePrivateDirectory } from '../core/files.mjs';
import { patternSlug } from './patterns.mjs';

// The site memory store (WS2b plan, Task 1): owns the on-disk layout under
// `paths.sitesDir` (`~/.fast-browser/sites/<encoded origin>/`) for every
// later WS2b task -- the graph miner (Task 2), the inventory miner (Task 3),
// the sweep integration (Task 4) and the `sites` CLI (Task 5) all read and
// write through the functions here rather than touching the filesystem
// directly.
//
// Layout per origin directory:
//   graph.json          -- GraphV1 (lib/sites/graph.mjs's mined edges)
//   inventory.json       -- InventoryV1 (lib/sites/inventory.mjs's mined targets)
//   quirks.json           -- QuirksV1 (agent-recorded, `sites quirk add`)
//   digests/<slug>.json  -- DigestV1, one per url pattern (patternSlug)
//
// **Origin directories are NOT created by `setup`.** `lib/commands/setup.mjs`
// creates `paths.sitesDir` itself (an ordinary `ensureSetupDirectories`
// entry), but setup cannot know in advance which origins an agent will ever
// visit -- that population is open-ended and grows one write at a time. So
// every WRITE function below creates its own per-origin subdirectory on
// demand, `0o700`, via the same `ensurePrivateDirectory` helper setup uses,
// the first time that origin is written. Reads never create anything: a
// missing origin directory is just an origin site memory has not seen yet.
//
// **Every write validates the origin.** `origin` must be a bare absolute
// http(s) origin (scheme + host [+ port], no path/query/hash) -- anything
// else is rejected with a path-annotated `SiteStoreError` before any
// filesystem access happens. Reads never throw on a bad origin string
// (global "never throw on read paths" rule): an origin that fails
// validation just resolves to the empty-defaults shape, the same as an
// origin that validates but has never been written.
//
// Every write uses the temp+rename+`0o600` idiom (this module's own
// `writeJsonAtomic`, the same shape as `lib/flows/sweep.mjs`'s -- copied
// rather than imported, since `lib/core/files.mjs`'s `saveConfig` is
// specific to the single top-level config file).
//
// Shape validation below (`parseGraph`/`parseInventory`/`parseQuirks`/
// `parseDigestRecord`) is hand-rolled in the style of `lib/flows/artifact.mjs`:
// unknown keys anywhere in the shape are rejected by name, closed sets are
// checked by membership, and every error names the field it's about. This
// module deliberately does NOT enforce the Shared shapes bounds table
// (`MAX_EDGES_PER_ORIGIN` etc., exported below for later tasks) on write --
// enforcing a bound requires evicting the right entry (lowest `count`, then
// oldest `lastSeenAt`) and reporting how many were evicted, which only the
// caller doing the MERGE has enough context to do (graph.mjs's `mergeGraph`,
// inventory.mjs's `mergeInventory`, and the CLI's `quirk add`, in later
// tasks). The one bound this module DOES enforce directly is
// `MAX_DIGEST_BYTES`: a single digest write is self-contained (no merge, no
// eviction), so `parseDigestRecord` rejects an oversized payload itself.

export class SiteStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SiteStoreError';
  }
}

// --- bounds (Shared shapes table, plan doc section "Shared shapes") ---

export const MAX_EDGES_PER_ORIGIN = 200;
export const MAX_PATTERNS_PER_ORIGIN = 200;
export const MAX_TARGETS_PER_PATTERN = 40;
export const MAX_QUIRKS_PER_ORIGIN = 50;
export const MAX_DIGEST_BYTES = 64 * 1024;

const GRAPH_SCHEMA_VERSION = 1;
const INVENTORY_SCHEMA_VERSION = 1;
const QUIRKS_SCHEMA_VERSION = 1;
const DIGEST_SCHEMA_VERSION = 1;
const QUIRK_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// --- hand-rolled validation helpers, local to this module (style
// reference: lib/flows/artifact.mjs's object/array/string helpers) ---

function object(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SiteStoreError(`${field} must be an object`);
  }
  return value;
}

function array(value, field) {
  if (!Array.isArray(value)) {
    throw new SiteStoreError(`${field} must be an array`);
  }
  return value;
}

function string(value, field, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') throw new SiteStoreError(`${field} must be a string`);
  return value;
}

function nonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new SiteStoreError(`${field} must be a non-negative integer`);
  }
  return value;
}

function positiveFiniteNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new SiteStoreError(`${field} must be a positive number`);
  }
  return value;
}

function isoString(value, field) {
  const raw = string(value, field);
  if (Number.isNaN(Date.parse(raw))) throw new SiteStoreError(`${field} must be an ISO date string`);
  return raw;
}

function rejectUnknownKeys(record, allowedKeys, prefix) {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new SiteStoreError(`unknown field: ${prefix ? `${prefix}.${key}` : key}`);
    }
  }
}

// --- origin validation + directory encoding ---

function isValidOrigin(origin) {
  if (typeof origin !== 'string' || origin.length === 0) return false;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.origin === origin;
}

// Validates `origin` (throws a path-annotated `SiteStoreError` when it is
// not a bare http(s) origin) and returns its filesystem-safe, reversible
// directory name. Every write function calls this first, which is what
// makes "every write validates the origin" hold without duplicating the
// check at each call site.
export function originDirName(origin) {
  if (!isValidOrigin(origin)) {
    throw new SiteStoreError('origin must be an absolute http(s) origin (scheme + host, no path)');
  }
  return encodeURIComponent(origin);
}

// Inverse of `originDirName`, for directory listings (`listSiteOrigins`)
// rather than a known origin: decodes `name`, re-encodes the result and
// requires an exact match against the original `name` (guards against a
// directory name that merely happens to decode to something plausible via
// a non-canonical percent-encoding), then requires the decoded value to
// itself be a valid bare http(s) origin. Returns null -- never throws --
// for anything that fails either check: a foreign directory under
// `sitesDir` (not one this store created) is simply not ours to report.
export function originFromDirName(name) {
  if (typeof name !== 'string') return null;
  let decoded;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    return null;
  }
  if (encodeURIComponent(decoded) !== name) return null;
  if (!isValidOrigin(decoded)) return null;
  return decoded;
}

function originDir(paths, dirName) {
  return path.join(paths.sitesDir, dirName);
}

// --- temp+rename+0o600 write idiom (lib/flows/sweep.mjs's `writeJsonAtomic`,
// reproduced here for the same reason that module gives: lib/core/files.mjs's
// `saveConfig` is specific to the single top-level config file, not a
// generic target-path writer) ---

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

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// --- graph.json ---

function parseAction(value, field) {
  const record = object(value, field);
  const tool = string(record.tool, `${field}.tool`);
  const action = { tool };
  if (Object.hasOwn(record, 'targetName')) action.targetName = string(record.targetName, `${field}.targetName`);
  rejectUnknownKeys(record, ['tool', 'targetName'], field);
  return action;
}

function parseEdge(value, field) {
  const record = object(value, field);
  const from = string(record.from, `${field}.from`, { nullable: true });
  const to = string(record.to, `${field}.to`);
  const action = parseAction(record.action, `${field}.action`);
  const count = nonNegativeInteger(record.count, `${field}.count`);
  const lastSeenAt = isoString(record.lastSeenAt, `${field}.lastSeenAt`);
  rejectUnknownKeys(record, ['from', 'to', 'action', 'count', 'lastSeenAt'], field);
  return {
    from, to, action, count, lastSeenAt,
  };
}

function parseGraph(value) {
  const record = object(value, 'graph');
  if (record.schemaVersion !== GRAPH_SCHEMA_VERSION) {
    throw new SiteStoreError(`schemaVersion must be ${GRAPH_SCHEMA_VERSION}`);
  }
  const edges = array(record.edges, 'edges').map((edge, index) => parseEdge(edge, `edges[${index}]`));
  rejectUnknownKeys(record, ['schemaVersion', 'edges'], '');
  return { schemaVersion: GRAPH_SCHEMA_VERSION, edges };
}

function emptyGraph() {
  return { schemaVersion: GRAPH_SCHEMA_VERSION, edges: [] };
}

// --- inventory.json ---

function parseTargetEntry(value, field) {
  const record = object(value, field);
  const role = string(record.role, `${field}.role`);
  const name = string(record.name, `${field}.name`);
  const kinds = array(record.kinds, `${field}.kinds`)
    .map((kind, index) => string(kind, `${field}.kinds[${index}]`));
  const count = nonNegativeInteger(record.count, `${field}.count`);
  const lastSeenAt = isoString(record.lastSeenAt, `${field}.lastSeenAt`);
  rejectUnknownKeys(record, ['role', 'name', 'kinds', 'count', 'lastSeenAt'], field);
  return {
    role, name, kinds, count, lastSeenAt,
  };
}

function parsePatternEntry(value, field) {
  const record = object(value, field);
  const targets = array(record.targets, `${field}.targets`)
    .map((target, index) => parseTargetEntry(target, `${field}.targets[${index}]`));
  const lastSeenAt = isoString(record.lastSeenAt, `${field}.lastSeenAt`);
  rejectUnknownKeys(record, ['targets', 'lastSeenAt'], field);
  return { targets, lastSeenAt };
}

function parseInventory(value) {
  const record = object(value, 'inventory');
  if (record.schemaVersion !== INVENTORY_SCHEMA_VERSION) {
    throw new SiteStoreError(`schemaVersion must be ${INVENTORY_SCHEMA_VERSION}`);
  }
  const patternsRecord = object(record.patterns, 'patterns');
  const patterns = {};
  for (const key of Object.keys(patternsRecord)) {
    // Own-property-safe against a literal "__proto__" pattern key --
    // JSON.parse can produce one as an own key (CreateDataProperty, not
    // assignment); see lib/flows/artifact.mjs's parseArgs for the same
    // concern against Object.prototype.
    if (key === '__proto__') throw new SiteStoreError('patterns.__proto__ is not a valid pattern key');
    patterns[key] = parsePatternEntry(patternsRecord[key], `patterns[${JSON.stringify(key)}]`);
  }
  rejectUnknownKeys(record, ['schemaVersion', 'patterns'], '');
  return { schemaVersion: INVENTORY_SCHEMA_VERSION, patterns };
}

function emptyInventory() {
  return { schemaVersion: INVENTORY_SCHEMA_VERSION, patterns: {} };
}

// --- quirks.json ---

function parseQuirkLocator(value, field) {
  const record = object(value, field);
  const kind = string(record.kind, `${field}.kind`);
  const selector = string(record.selector, `${field}.selector`);
  rejectUnknownKeys(record, ['kind', 'selector'], field);
  return { kind, selector };
}

function parseQuirkTarget(value, field) {
  const record = object(value, field);
  const locators = array(record.locators, `${field}.locators`)
    .map((locator, index) => parseQuirkLocator(locator, `${field}.locators[${index}]`));
  if (locators.length === 0) throw new SiteStoreError(`${field}.locators must not be empty`);
  const target = { locators };
  if (Object.hasOwn(record, 'description')) target.description = string(record.description, `${field}.description`);
  rejectUnknownKeys(record, ['locators', 'description'], field);
  return target;
}

function parseQuirk(value, field) {
  const record = object(value, field);
  const name = string(record.name, `${field}.name`);
  if (!QUIRK_NAME_PATTERN.test(name)) throw new SiteStoreError(`${field}.name must be kebab-case`);
  const urlPattern = string(record.urlPattern, `${field}.urlPattern`, { nullable: true });
  const target = parseQuirkTarget(record.target, `${field}.target`);
  const action = string(record.action, `${field}.action`);
  const addedAt = isoString(record.addedAt, `${field}.addedAt`);
  const source = string(record.source, `${field}.source`);
  rejectUnknownKeys(record, ['name', 'urlPattern', 'target', 'action', 'addedAt', 'source'], field);
  return {
    name, urlPattern, target, action, addedAt, source,
  };
}

function parseQuirks(value) {
  const record = object(value, 'quirks');
  if (record.schemaVersion !== QUIRKS_SCHEMA_VERSION) {
    throw new SiteStoreError(`schemaVersion must be ${QUIRKS_SCHEMA_VERSION}`);
  }
  const quirks = array(record.quirks, 'quirks').map((quirk, index) => parseQuirk(quirk, `quirks[${index}]`));
  rejectUnknownKeys(record, ['schemaVersion', 'quirks'], '');
  return { schemaVersion: QUIRKS_SCHEMA_VERSION, quirks };
}

function emptyQuirks() {
  return { schemaVersion: QUIRKS_SCHEMA_VERSION, quirks: [] };
}

// --- digests/<slug>.json ---

function parseDigestRecord(value) {
  const record = object(value, 'digest');
  if (record.schemaVersion !== DIGEST_SCHEMA_VERSION) {
    throw new SiteStoreError(`schemaVersion must be ${DIGEST_SCHEMA_VERSION}`);
  }
  const url = string(record.url, 'url');
  const pattern = string(record.pattern, 'pattern');
  const savedAt = isoString(record.savedAt, 'savedAt');
  const ttlHours = positiveFiniteNumber(record.ttlHours, 'ttlHours');
  const domHash = string(record.domHash, 'domHash', { nullable: true });
  const digest = object(record.digest, 'digest');
  const serializedDigest = JSON.stringify(digest);
  if (Buffer.byteLength(serializedDigest, 'utf8') > MAX_DIGEST_BYTES) {
    throw new SiteStoreError(`digest must serialize to at most ${MAX_DIGEST_BYTES} bytes`);
  }
  rejectUnknownKeys(record, ['schemaVersion', 'url', 'pattern', 'savedAt', 'ttlHours', 'domHash', 'digest'], '');
  return {
    schemaVersion: DIGEST_SCHEMA_VERSION, url, pattern, savedAt, ttlHours, domHash, digest,
  };
}

function isStale(savedAt, ttlHours, nowMs) {
  const savedMs = Date.parse(savedAt);
  // A record that somehow carries an unparseable savedAt (shouldn't happen
  // past parseDigestRecord, defensive here too) is treated as stale rather
  // than trusted.
  if (Number.isNaN(savedMs)) return true;
  return nowMs - savedMs > ttlHours * 60 * 60 * 1000;
}

// --- reads: corrupt/missing -> empty defaults, never throw ---

async function readJsonOrDefault(filePath, parse, fallback) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return fallback;
  }
  try {
    return parse(JSON.parse(raw));
  } catch {
    return fallback;
  }
}

async function readDigestSummaries(digestsDir, clock) {
  let entries;
  try {
    entries = await readdir(digestsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nowMs = clock().getTime();
  const summaries = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const record = await readJsonOrDefault(path.join(digestsDir, entry.name), parseDigestRecord, null);
    if (!record) continue; // corrupt/foreign file: skip, never throw
    summaries.push({
      pattern: record.pattern,
      savedAt: record.savedAt,
      ttlHours: record.ttlHours,
      stale: isStale(record.savedAt, record.ttlHours, nowMs),
    });
  }
  return summaries;
}

// --- public API ---

export async function listSiteOrigins(paths) {
  let entries;
  try {
    entries = await readdir(paths.sitesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const origins = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const origin = originFromDirName(entry.name);
    if (origin) origins.push(origin);
  }
  return origins;
}

// readSite(paths, origin, { now? }) -> { graph, inventory, quirks, digests }.
// Never throws: a bad origin string, a missing origin directory and corrupt
// per-file JSON all resolve to the same empty-defaults shape for whichever
// piece is affected. `now` is this module's own clock-injection point
// (defaults to `() => new Date()`, the codebase's standing convention),
// consulted only for computing each digest's `stale` flag.
export async function readSite(paths, origin, { now } = {}) {
  const clock = now ?? (() => new Date());
  let dirName;
  try {
    dirName = originDirName(origin);
  } catch {
    return {
      graph: emptyGraph(), inventory: emptyInventory(), quirks: emptyQuirks(), digests: [],
    };
  }
  const dir = originDir(paths, dirName);
  const graph = await readJsonOrDefault(path.join(dir, 'graph.json'), parseGraph, emptyGraph());
  const inventory = await readJsonOrDefault(path.join(dir, 'inventory.json'), parseInventory, emptyInventory());
  const quirks = await readJsonOrDefault(path.join(dir, 'quirks.json'), parseQuirks, emptyQuirks());
  const digests = await readDigestSummaries(path.join(dir, 'digests'), clock);
  return {
    graph, inventory, quirks, digests,
  };
}

// readDigest(paths, origin, pattern, { now? }) -> digestRecord & { stale } | null.
// Never throws: an invalid origin, a missing digest file, or a corrupt one
// all resolve to null.
export async function readDigest(paths, origin, pattern, { now } = {}) {
  const clock = now ?? (() => new Date());
  let dirName;
  try {
    dirName = originDirName(origin);
  } catch {
    return null;
  }
  const filePath = path.join(originDir(paths, dirName), 'digests', `${patternSlug(pattern)}.json`);
  const record = await readJsonOrDefault(filePath, parseDigestRecord, null);
  if (!record) return null;
  return { ...record, stale: isStale(record.savedAt, record.ttlHours, clock().getTime()) };
}

async function ensureOriginDir(paths, origin) {
  const dirName = originDirName(origin); // throws SiteStoreError on an invalid origin
  const dir = originDir(paths, dirName);
  await ensurePrivateDirectory(dir);
  return dir;
}

export async function writeGraph(paths, origin, graph) {
  const parsed = parseGraph(graph);
  const dir = await ensureOriginDir(paths, origin);
  await writeJsonAtomic(path.join(dir, 'graph.json'), serializeJson(parsed));
}

export async function writeInventory(paths, origin, inventory) {
  const parsed = parseInventory(inventory);
  const dir = await ensureOriginDir(paths, origin);
  await writeJsonAtomic(path.join(dir, 'inventory.json'), serializeJson(parsed));
}

export async function writeQuirks(paths, origin, quirks) {
  const parsed = parseQuirks(quirks);
  const dir = await ensureOriginDir(paths, origin);
  await writeJsonAtomic(path.join(dir, 'quirks.json'), serializeJson(parsed));
}

export async function writeDigest(paths, origin, digestRecord) {
  const parsed = parseDigestRecord(digestRecord);
  const dir = await ensureOriginDir(paths, origin);
  const digestsDir = path.join(dir, 'digests');
  await ensurePrivateDirectory(digestsDir);
  await writeJsonAtomic(path.join(digestsDir, `${patternSlug(parsed.pattern)}.json`), serializeJson(parsed));
}
