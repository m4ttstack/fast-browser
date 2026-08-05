import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { assertConfinedPath } from '../core/containment.mjs';
import { resolvePaths } from '../core/paths.mjs';
import { normalizeUrlPattern, patternSlug } from '../sites/patterns.mjs';
import {
  MAX_DIGEST_BYTES,
  MAX_QUIRKS_PER_ORIGIN,
  originDirName,
  readDigest as defaultReadDigest,
  readSite as defaultReadSite,
  writeDigest as defaultWriteDigest,
  writeQuirks as defaultWriteQuirks,
} from '../sites/store.mjs';
import { LifecycleError, stripControlChars } from './shared.mjs';

// The `sites` CLI command (WS2b site-memory plan, Task 5): the agent-facing
// surface of site memory. This module is a CONSUMER, never a source of
// truth -- graph/inventory/quirk/digest shapes and the origin/pattern
// encodings all come from lib/sites/store.mjs and lib/sites/patterns.mjs;
// this file only canonicalizes CLI input, orchestrates store calls, and
// renders CLI-shaped reports.
//
// --- no sweep, ever ---
//
// Unlike `flows find` (which sweeps on every call, so a just-captured
// session becomes a candidate immediately), every subcommand here is a
// plain read or a plain write against the stores Task 4's sweep already
// populated. Site reads must be fast and side-effect-free: an agent calling
// `sites affordances` while scouting a page should never trigger a trace
// sweep as a side effect.
//
// --- quirks are inert data: no approval gate here ---
//
// `quirk add`/`list`/`remove` have no confirmation prompt, unlike `flows
// approve`. This is a deliberate plan decision, not an oversight: a quirk
// is just a recorded locator until WS3's healing rung starts EXECUTING it
// against a live page. WS3's plan must add the consent story before any
// runtime ever clicks a quirk's selector -- this module only stores and
// retrieves the data.
//
// --- origin/url canonicalization ---
//
// lib/sites/store.mjs REJECTS any origin string that is not already the
// canonical `new URL(x).origin` form (no normalizing on its side, by
// design -- see that module's own doc comment). Every subcommand here that
// accepts an origin or a url therefore canonicalizes FIRST
// (`canonicalizeOrigin`/`canonicalizeUrl` below), so `https://Shop.Example
// :443/x` reaches the store as `https://shop.example`. An unparseable or
// non-http(s) value never reaches the store at all, and is never echoed
// back in the resulting error (safeToken discipline, `lib/cli/parse-
// args.mjs`).
//
// --- symlink confinement: this module's own responsibility ---
//
// store.mjs builds every on-disk path itself, entirely from ALREADY-SAFE
// components -- `encodeURIComponent(origin)` (round-trip validated) and
// `patternSlug(pattern)` (sanitized to a single `[A-Za-z0-9_-]+` path
// component) -- so no raw user string is ever joined unescaped into a
// path. That rules out path TRAVERSAL. It does not rule out a SYMLINK
// planted at one of those (otherwise-safe-looking) locations, because
// store.mjs never lstats along the way the way `core/containment.mjs`
// does; it just `ensurePrivateDirectory` + temp-write + rename through
// whatever is there. So, for every WRITE this module performs (`quirk
// add`/`quirk remove`'s rewrite of quirks.json, `digest`'s save), this
// module reconstructs the exact path store.mjs is about to write
// (`originDirName`/`patternSlug`, the same functions store.mjs itself
// uses) and confines it with `assertConfinedPath` -- the same
// gif.mjs/flows.mjs idiom -- immediately before the write. This mirrors
// flows.mjs's `confineOrFail`, including resolving `dataDir` to its real
// path ONCE first (`physicalDataDir` below) so a `~/.fast-browser` reached
// through an ancestor symlink (a dotfile-managed home) still works, while
// a symlink planted anywhere at or below `sitesDir` is refused. Read-only
// subcommands (`show`, `affordances`, `quirk list`) are deliberately NOT
// confined, matching `flows.mjs`'s own read/write asymmetry (`find`/`list`
// never confine; only `approve`/`reject` do) -- store.mjs's reads already
// degrade to empty defaults on any failure, and adding a throwing check
// ahead of them would regress that "reads never throw" contract for no
// corresponding write-safety benefit.

const SUBCOMMANDS = new Set(['show', 'affordances', 'digest', 'quirk']);
const QUIRK_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFAULT_TTL_HOURS = 72; // three days -- matches this codebase's own digest fixtures

function fail(stage, message, exitCode = 1) {
  return new LifecycleError(message, { stage, exitCode });
}

function assertValidQuirkName(name) {
  if (typeof name !== 'string' || !QUIRK_NAME_PATTERN.test(name)) {
    throw fail('sites-quirk', 'quirk name must be lowercase kebab-case.', 2);
  }
}

// `value` may be a bare origin OR a fuller URL (a positional/flag typed by
// a human can carry a path/case/port a machine wouldn't) -- `new
// URL(value).origin` is the one, load-bearing canonicalization step every
// store call is required to see. Never echoes `value` in its error.
function canonicalizeOrigin(value, stage) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw fail(stage, 'origin must be an absolute http(s) origin.', 2);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw fail(stage, 'origin must be an absolute http(s) origin.', 2);
  }
  return parsed.origin;
}

// `normalizeUrlPattern` is already the single source of truth for "is this
// url usable" (http(s), parseable) -- reusing it here rather than
// duplicating its validation means there is exactly one place that
// decides what counts as a usable url. `pathname` is returned alongside
// `origin`/`pattern` so callers that persist a `url` field (`digest`) can
// build a SANITIZED one (fix round 1, I1) -- `origin + pathname` only,
// never the raw input, which can carry userinfo/query/fragment (a
// credential in `user:pass@host`, a token in `?token=...`) straight to
// disk otherwise.
function canonicalizeUrl(value, stage) {
  const pattern = normalizeUrlPattern(value);
  if (pattern === null) {
    throw fail(stage, 'url must be an absolute http(s) url.', 2);
  }
  const parsed = new URL(value);
  return { origin: parsed.origin, pattern, pathname: parsed.pathname };
}

// --- symlink confinement helpers (mirrors flows.mjs's physicalDataDir /
// confineOrFail; see the module doc comment above) ---

async function physicalDataDir(deps) {
  try {
    return await deps.realpath(deps.paths.dataDir);
  } catch {
    return deps.paths.dataDir;
  }
}

async function confineOrFail(deps, stage, candidate, message) {
  try {
    const logicalDataDir = deps.paths.dataDir;
    const physicalRoot = await physicalDataDir(deps);
    const physicalRootDir = path.join(physicalRoot, path.relative(logicalDataDir, deps.paths.sitesDir));
    const physicalCandidate = path.join(physicalRoot, path.relative(logicalDataDir, candidate));
    await deps.assertConfined({
      dataDir: physicalRoot, rootDir: physicalRootDir, candidate: physicalCandidate,
    });
  } catch {
    throw fail(stage, message, 2);
  }
}

function originDirPath(paths, origin) {
  return path.join(paths.sitesDir, originDirName(origin));
}

// --- stdin (digest payload) ---

async function readAllStdin(stream, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      // Stop accumulating as soon as the bound is crossed rather than
      // reading an unbounded stream to the end first.
      throw fail('sites-digest', `digest JSON on stdin must be at most ${maxBytes} bytes.`, 2);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function dependencies(request, supplied) {
  const paths = supplied.paths ?? resolvePaths({
    homeDir: supplied.homeDir,
    pluginRoot: supplied.pluginRoot,
  });
  const input = supplied.input ?? process.stdin;
  return {
    paths,
    now: supplied.now ?? (() => new Date()),
    readSite: supplied.readSite ?? defaultReadSite,
    readDigest: supplied.readDigest ?? defaultReadDigest,
    writeDigest: supplied.writeDigest ?? defaultWriteDigest,
    writeQuirks: supplied.writeQuirks ?? defaultWriteQuirks,
    readStdin: supplied.readStdin ?? (() => readAllStdin(input, MAX_DIGEST_BYTES)),
    realpath: supplied.realpath ?? realpath,
    assertConfined: supplied.assertConfined ?? assertConfinedPath,
  };
}

// --- show: the full per-origin graph/inventory/quirks/digests snapshot ---

function patternsToArray(patterns) {
  return Object.keys(patterns)
    .sort()
    .map((pattern) => ({
      pattern,
      targets: patterns[pattern].targets,
      lastSeenAt: patterns[pattern].lastSeenAt,
    }));
}

async function show(request, deps) {
  const origin = canonicalizeOrigin(request.origin, 'sites-show');
  const site = await deps.readSite(deps.paths, origin, { now: deps.now });
  return {
    command: 'sites',
    sub: 'show',
    origin,
    edges: site.graph.edges,
    patterns: patternsToArray(site.inventory.patterns),
    quirks: site.quirks.quirks,
    digests: site.digests,
  };
}

// --- affordances: warm-start read -- freshest digest for the pattern, plus
// the mined inventory as the always-present fallback layer ---

async function affordances(request, deps) {
  const { origin, pattern } = canonicalizeUrl(request.url, 'sites-affordances');
  const digest = await deps.readDigest(deps.paths, origin, pattern, { now: deps.now });
  const site = await deps.readSite(deps.paths, origin, { now: deps.now });
  const inventoryEntry = site.inventory.patterns[pattern];
  return {
    command: 'sites',
    sub: 'affordances',
    found: digest !== null,
    stale: digest !== null ? digest.stale : null,
    savedAt: digest !== null ? digest.savedAt : null,
    pattern,
    digest: digest !== null ? digest.digest : null,
    inventory: inventoryEntry ? inventoryEntry.targets : [],
  };
}

// --- digest: agent-pushed warm start, read from stdin ---

async function digestSub(request, deps) {
  const { origin, pattern, pathname } = canonicalizeUrl(request.url, 'sites-digest');
  const raw = await deps.readStdin();
  if (Buffer.byteLength(raw, 'utf8') > MAX_DIGEST_BYTES) {
    throw fail('sites-digest', `digest JSON on stdin must be at most ${MAX_DIGEST_BYTES} bytes.`, 2);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw fail('sites-digest', 'digest JSON on stdin could not be parsed.', 2);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw fail('sites-digest', 'digest JSON on stdin must be an object.', 2);
  }

  const record = {
    schemaVersion: 1,
    // Sanitized, never the raw input (fix round 1, I1): userinfo, query,
    // and fragment are dropped -- only origin + pathname persist. Matches
    // `normalizeUrlPattern`'s own stripping and `compile.mjs`'s redaction
    // posture; a credential or token embedded in the URL a human pasted
    // must never reach this file's bytes.
    url: `${origin}${pathname}`,
    pattern,
    savedAt: deps.now().toISOString(),
    ttlHours: request.ttlHours ?? DEFAULT_TTL_HOURS,
    domHash: null,
    digest: parsed,
  };

  const digestPath = path.join(originDirPath(deps.paths, origin), 'digests', `${patternSlug(pattern)}.json`);
  await confineOrFail(deps, 'sites-digest', digestPath, 'the digest path is not safe to write.');
  await deps.writeDigest(deps.paths, origin, record);

  return {
    command: 'sites', sub: 'digest', saved: true, pattern, stale: false,
  };
}

// --- quirk: agent-recorded locators, no approval gate (see module doc) ---

const QUIRK_TEXT_MAX_LENGTH = 500; // fix round 1, M4: bound selector/description
const QUIRK_URL_PATTERN_MAX_LENGTH = 200; // fix round 1, I3

function assertBoundedText(value, field, maxLength) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw fail('sites-quirk', `${field} must be 1 to ${maxLength} characters.`, 2);
  }
}

// Fix round 1, I3: `urlPattern` is a match key the agent chose, not a value
// `normalizeUrlPattern` should reinterpret (an agent may deliberately want
// a literal, un-collapsed key) -- so this only enforces the one invariant
// every other pattern in this store shares (a path, never an absolute
// URL) plus a length bound, and names the requirement, never the value, in
// its error.
function assertValidQuirkUrlPattern(value) {
  if (value === null) return;
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > QUIRK_URL_PATTERN_MAX_LENGTH) {
    throw fail(
      'sites-quirk',
      `url-pattern must start with / and be at most ${QUIRK_URL_PATTERN_MAX_LENGTH} characters.`,
      2,
    );
  }
}

async function quirkAdd(request, deps) {
  assertValidQuirkName(request.name);
  assertBoundedText(request.selector, 'selector', QUIRK_TEXT_MAX_LENGTH);
  // An empty --description is treated as "not given" (the nit from fix
  // round 1): only a NON-empty description is bound-checked and stored.
  if (
    request.description !== null
    && request.description !== ''
    && request.description.length > QUIRK_TEXT_MAX_LENGTH
  ) {
    throw fail('sites-quirk', `description must be 1 to ${QUIRK_TEXT_MAX_LENGTH} characters.`, 2);
  }
  assertValidQuirkUrlPattern(request.urlPattern);
  const origin = canonicalizeOrigin(request.origin, 'sites-quirk');

  const site = await deps.readSite(deps.paths, origin, { now: deps.now });
  const existingQuirks = site.quirks.quirks;
  if (existingQuirks.some((quirk) => quirk.name === request.name)) {
    throw fail('sites-quirk', 'a quirk already exists under that name; remove it first.', 2);
  }
  if (existingQuirks.length >= MAX_QUIRKS_PER_ORIGIN) {
    throw fail('sites-quirk', `at most ${MAX_QUIRKS_PER_ORIGIN} quirks are stored per origin.`, 2);
  }

  const target = { locators: [{ kind: 'css', selector: request.selector }] };
  if (request.description !== null && request.description !== '') target.description = request.description;
  const quirk = {
    name: request.name,
    urlPattern: request.urlPattern ?? null,
    target,
    action: 'click',
    addedAt: deps.now().toISOString(),
    source: 'agent',
  };

  const quirksPath = path.join(originDirPath(deps.paths, origin), 'quirks.json');
  await confineOrFail(deps, 'sites-quirk', quirksPath, 'the quirks path is not safe to write.');
  await deps.writeQuirks(deps.paths, origin, { schemaVersion: 1, quirks: [...existingQuirks, quirk] });

  return {
    command: 'sites', sub: 'quirk', verb: 'add', origin, name: request.name, quirk,
  };
}

async function quirkList(request, deps) {
  const origin = canonicalizeOrigin(request.origin, 'sites-quirk');
  const site = await deps.readSite(deps.paths, origin, { now: deps.now });
  return {
    command: 'sites', sub: 'quirk', verb: 'list', origin, quirks: site.quirks.quirks,
  };
}

async function quirkRemove(request, deps) {
  assertValidQuirkName(request.name);
  const origin = canonicalizeOrigin(request.origin, 'sites-quirk');

  const site = await deps.readSite(deps.paths, origin, { now: deps.now });
  const existingQuirks = site.quirks.quirks;
  if (!existingQuirks.some((quirk) => quirk.name === request.name)) {
    throw fail('sites-quirk', 'no quirk with that name was found.', 2);
  }
  const remaining = existingQuirks.filter((quirk) => quirk.name !== request.name);

  const quirksPath = path.join(originDirPath(deps.paths, origin), 'quirks.json');
  await confineOrFail(deps, 'sites-quirk', quirksPath, 'the quirks path is not safe to write.');
  await deps.writeQuirks(deps.paths, origin, { schemaVersion: 1, quirks: remaining });

  return {
    command: 'sites', sub: 'quirk', verb: 'remove', origin, name: request.name, removed: true,
  };
}

async function quirk(request, deps) {
  if (request.verb === 'add') return quirkAdd(request, deps);
  if (request.verb === 'list') return quirkList(request, deps);
  if (request.verb === 'remove') return quirkRemove(request, deps);
  throw fail('sites-quirk', 'sites quirk requires a verb of add, list, or remove.', 2);
}

export async function sites(request, supplied = {}) {
  const deps = dependencies(request, supplied);
  if (!SUBCOMMANDS.has(request.sub)) {
    throw fail('sites', 'sites requires a subcommand of show, affordances, digest, or quirk.', 2);
  }
  if (request.sub === 'show') return show(request, deps);
  if (request.sub === 'affordances') return affordances(request, deps);
  if (request.sub === 'digest') return digestSub(request, deps);
  return quirk(request, deps);
}
