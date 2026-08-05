import assert from 'node:assert/strict';
import {
  access, mkdtemp, rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { flows } from '../../lib/commands/flows.mjs';
import { sites } from '../../lib/commands/sites.mjs';
import { startOrderFixture } from '../fixtures/order-flow/server.mjs';
import { startMcpClient } from './helpers/mcp-client.mjs';

// The site-memory e2e (WS2b plan, Task 11): the workstream's acceptance
// test. Drives the exact same order-flow recording flows.test.mjs's
// flywheel e2e uses (same fixture, same discrete MCP calls) through a
// traced session, then proves the WHOLE site-memory slice end to end
// against the real runtime: sweep mines a navigation graph and an
// interaction inventory from that trace (no separate capture step -- it
// rides the same compile-on-sweep cursor flows.mjs's `find` already uses),
// `sites show`/`sites affordances` read them back, a digest saved through
// the command layer warm-starts `affordances` from `found: false` to
// `found: true`, quirks round-trip through the same command layer, and a
// second sweep proves the cursor keeps mining idempotent (no double-
// counted edges/targets on a re-sweep with nothing new to compile).
//
// Deliberately reuses flows.test.mjs's recording script verbatim (see that
// file's own header for why discrete MCP calls, not a single
// `browser_run_code_unsafe` script, are what make a session's records
// carry real tool identities and URL transitions for the miners to read --
// graph.mjs/inventory.mjs mine the SAME raw TraceRecords compile.mjs does,
// just without its TOOL_OPS curation). This test asserts nothing about
// compiled FLOWS (that is flows.test.mjs's job); it only reads the `sites`
// slice of the same sweep() call.
//
// `lastSeenAt` fields are real-clock timestamps (mineGraphEdges/
// mineInventory default `now` to `() => new Date()`, and this test never
// injects one for the recording/compile steps -- there is no meaningful
// clock to inject before the runtime itself has produced the records being
// mined). Pinning them as literal strings would make every future run fail
// the moment wall-clock time moved on, so `withoutLastSeenAt` strips them
// before every structural comparison below; the store's own read-side
// parser (`readSite` -> `parseGraph`/`parseInventory`, both `isoString`-
// validated) is what already guarantees any `lastSeenAt` that survived a
// `sites show` call is a real ISO date, so no separate format check is
// needed on top of that.
//
// KNOWN BLIND SPOTS of this acceptance test (all unit-covered, none
// exercised end to end because the order-flow fixture is a single-page app
// that never changes URL mid-flow): multi-pattern inventory, navigation
// edges with a non-null `from`, cross-origin record grouping, non-root
// patternSlug digest filenames, eviction bounds (evicted is always 0
// here), replay-record exclusion inside the miners, and non-default
// ttlHours/domHash. A future fixture with a second routed page closes
// most of these in one go.

// Same hand-built paths shape as flows.test.mjs's `pathsForOutputDir`
// (rooted at outputDir itself, matching mcp-client.mjs's --output-dir
// wiring), extended with `sitesDir` -- the one path lib/sites/store.mjs
// needs that flows.mjs's own paths shape doesn't carry. No `macrosDir`
// install is needed here (unlike flows.test.mjs): this test never calls
// `flows find`, the only place that embeds flow-runner.js's path, so the
// file itself never has to exist on disk for `flows compile` to run.
function pathsForOutputDir(outputDir) {
  return {
    dataDir: outputDir,
    flowsDir: path.join(outputDir, 'flows'),
    flowsPendingDir: path.join(outputDir, 'flows-pending'),
    flowsStateFile: path.join(outputDir, 'flows-state.json'),
    macrosDir: path.join(outputDir, 'macros'),
    rejectedFlowsFile: path.join(outputDir, 'rejected-flows.md'),
    sitesDir: path.join(outputDir, 'sites'),
  };
}

// Wraps startMcpClient with an idempotent close registered via t.after as a
// safety net -- identical contract to flows.test.mjs's own helper: this
// test closes its one session explicitly and early (sweep defers
// compilation until `meta.endedAt` exists), but a thrown assertion between
// session creation and that explicit close must still not leak the spawned
// runtime process.
async function tracedSession(t, outputDir) {
  const session = await startMcpClient({ outputDir, extraArgs: ['--save-trace'] });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await session.close();
  };
  t.after(close);
  return { callTool: session.callTool, metrics: session.metrics, close };
}

function fakeStdin(text) {
  return async () => text;
}

// Recursively strips every `lastSeenAt` key so a mined graph/inventory
// snapshot can be pinned structurally without pinning wall-clock values --
// see the module doc comment.
function withoutLastSeenAt(value) {
  if (Array.isArray(value)) return value.map(withoutLastSeenAt);
  if (value && typeof value === 'object') {
    const clone = {};
    for (const [key, val] of Object.entries(value)) {
      if (key === 'lastSeenAt') continue;
      clone[key] = withoutLastSeenAt(val);
    }
    return clone;
  }
  return value;
}

// Pinned on the fixture's own first observed run (per this task's brief:
// "pin exactly what the fixture produces on your first run, assert exactly
// thereafter") -- the order-flow fixture (tests/fixtures/order-flow) is a
// single-page app that never changes its URL after the initial navigate
// (every subsequent interaction is a DOM swap within the same page), so
// the graph miner mines exactly one edge: the ENTRY edge for the initial
// `browser_navigate` (`from: null` -- entered from outside this origin's
// own graph -- see graph.mjs's own doc comment). No other recorded action
// causes a `urlBefore !== urlAfter` transition, so no second edge exists.
const EXPECTED_ENTRY_EDGES = [
  { from: null, to: '/', action: { tool: 'browser_navigate' }, count: 1 },
];

// Every click/type/select_option in the recording script targets an
// element with a real accessible role+name, and all of them happen on the
// single mined pattern (`/`) -- one inventory entry per distinct
// role|name pair, each touched exactly once. `kinds` is the set of
// locator alternate kinds the runtime's own enrichment resolved for that
// target (role always present; `css`/`other` vary per element type) --
// also pinned from the same first observed run.
const EXPECTED_ROOT_TARGETS = [
  { role: 'button', name: 'Start order', kinds: ['role', 'css'], count: 1 },
  { role: 'textbox', name: 'Customer name', kinds: ['role', 'other'], count: 1 },
  { role: 'button', name: 'Continue', kinds: ['role', 'css'], count: 1 },
  { role: 'combobox', name: 'Plan', kinds: ['other'], count: 1 },
  { role: 'spinbutton', name: 'Seats', kinds: ['role', 'other'], count: 1 },
  { role: 'button', name: 'Review order', kinds: ['role', 'css'], count: 1 },
  { role: 'button', name: 'Place order', kinds: ['role', 'css'], count: 1 },
];

test('site memory: record to mined graph to warm-start round trip', async (t) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-sites-e2e-'));
  const paths = pathsForOutputDir(outputDir);

  const fixture = await startOrderFixture();
  t.after(fixture.close);
  const { origin } = fixture;
  const rootUrl = `${origin}/`;

  // --- 1. record: drive the order flow through a TRACED session via
  // discrete MCP calls (flows.test.mjs's recording script, verbatim), then
  // close so meta.json gets endedAt -- sweep defers compilation (and site
  // memory mining, which rides the same compile slice) entirely until
  // then. ---
  const recorder = await tracedSession(t, outputDir);
  await recorder.callTool('browser_navigate', { url: fixture.origin });
  await recorder.callTool('browser_click', { target: 'role=button[name="Start order"]' });
  await recorder.callTool('browser_type', { target: 'role=textbox[name="Customer name"]', text: 'Ada' });
  await recorder.callTool('browser_click', { target: 'role=button[name="Continue"]' });
  await recorder.callTool('browser_select_option', { target: 'role=combobox[name="Plan"]', values: ['team'] });
  await recorder.callTool('browser_type', { target: 'role=spinbutton[name="Seats"]', text: '7' });
  await recorder.callTool('browser_click', { target: 'role=button[name="Review order"]' });
  await recorder.callTool('browser_click', { target: 'role=button[name="Place order"]' });
  await recorder.callTool('browser_wait_for', { text: 'Order complete' });
  await recorder.close();

  // --- 2. compile: the sweep's `sites` slice mines this session's records
  // into graph/inventory, non-zero, attributed to exactly this origin;
  // the origin's on-disk directory exists under the ENCODED origin. ---
  const compileReport = await flows({ sub: 'compile', json: true }, { paths });
  // Exact counts, not just non-zero: step 3 pins 1 entry edge and 7
  // targets, so the report must agree with what lands on disk.
  assert.deepEqual(compileReport.sites, {
    origins: [origin],
    edges: 1,
    targets: EXPECTED_ROOT_TARGETS.length,
    evicted: 0,
    errors: [],
  });

  // Independent encoding pin: build the expected dir name with
  // encodeURIComponent directly, not with the SUT's own originDirName,
  // so an encoding change in the store fails here.
  const originDir = path.join(paths.sitesDir, encodeURIComponent(origin));
  await assert.doesNotReject(access(originDir));

  // --- 3. show: the mined graph/inventory read back through the command
  // layer, pinned exactly (module doc comment: entry edge only, seven
  // role+name inventory targets under pattern `/`). ---
  const showReport = await sites({ sub: 'show', origin, json: true }, { paths });
  assert.deepEqual(withoutLastSeenAt(showReport.edges), EXPECTED_ENTRY_EDGES);
  assert.equal(showReport.patterns.length, 1);
  assert.equal(showReport.patterns[0].pattern, '/');
  assert.deepEqual(withoutLastSeenAt(showReport.patterns[0].targets), EXPECTED_ROOT_TARGETS);

  // --- 4. affordances with no digest saved yet: `found: false`, but the
  // mined inventory is still returned as the warm-start fallback layer. ---
  const affordancesCold = await sites({ sub: 'affordances', url: rootUrl, json: true }, { paths });
  assert.equal(affordancesCold.found, false);
  assert.equal(affordancesCold.stale, null);
  assert.equal(affordancesCold.savedAt, null);
  assert.equal(affordancesCold.digest, null);
  assert.equal(affordancesCold.pattern, '/');
  assert.deepEqual(withoutLastSeenAt(affordancesCold.inventory), EXPECTED_ROOT_TARGETS);

  // --- 5. digest: saved via the command layer (injected stdin, mirroring
  // tests/unit/sites-command.test.mjs's own dependency-injection idiom),
  // then re-queried -- `found: true, stale: false` immediately after
  // saving (real clock, negligible elapsed time against the 72h default
  // TTL), and `stale: true` once `now` is injected far into the future. ---
  const digestPayload = { affordances: ['button:Start order', 'button:Place order'] };
  const digestSaveReport = await sites(
    { sub: 'digest', url: rootUrl, ttlHours: null, json: true },
    { paths, readStdin: fakeStdin(JSON.stringify(digestPayload)) },
  );
  assert.deepEqual(digestSaveReport, {
    command: 'sites', sub: 'digest', saved: true, pattern: '/', stale: false,
  });

  const affordancesFresh = await sites({ sub: 'affordances', url: rootUrl, json: true }, { paths });
  assert.equal(affordancesFresh.found, true);
  assert.equal(affordancesFresh.stale, false);
  assert.equal(typeof affordancesFresh.savedAt, 'string');
  assert.equal(affordancesFresh.pattern, '/');
  assert.deepEqual(affordancesFresh.digest, digestPayload);
  assert.deepEqual(withoutLastSeenAt(affordancesFresh.inventory), EXPECTED_ROOT_TARGETS);

  const farFutureNow = () => new Date('2099-01-01T00:00:00.000Z');
  const affordancesStale = await sites(
    { sub: 'affordances', url: rootUrl, json: true },
    { paths, now: farFutureNow },
  );
  assert.equal(affordancesStale.found, true);
  assert.equal(affordancesStale.stale, true);
  // Same saved record, not a new digest -- proves `stale` alone flipped
  // with the injected clock, nothing else about the read changed.
  assert.equal(affordancesStale.savedAt, affordancesFresh.savedAt);
  assert.deepEqual(affordancesStale.digest, digestPayload);

  // --- 6. quirks: add, list, remove round-trip through the command
  // layer, no approval gate (module-level `sites.mjs` doc: quirks are
  // inert data until WS3's healing rung starts executing them). ---
  const quirkNow = () => new Date('2026-08-05T12:00:00.000Z');
  const quirkAdded = await sites(
    {
      sub: 'quirk',
      verb: 'add',
      name: 'cookie-banner',
      origin,
      selector: '#cookie-banner-accept',
      description: 'Dismiss the cookie banner',
      urlPattern: null,
      json: true,
    },
    { paths, now: quirkNow },
  );
  assert.deepEqual(quirkAdded, {
    command: 'sites',
    sub: 'quirk',
    verb: 'add',
    origin,
    name: 'cookie-banner',
    quirk: {
      name: 'cookie-banner',
      urlPattern: null,
      target: {
        locators: [{ kind: 'css', selector: '#cookie-banner-accept' }],
        description: 'Dismiss the cookie banner',
      },
      action: 'click',
      addedAt: '2026-08-05T12:00:00.000Z',
      source: 'agent',
    },
  });

  const quirkListed = await sites({ sub: 'quirk', verb: 'list', origin, json: true }, { paths });
  assert.deepEqual(quirkListed, {
    command: 'sites', sub: 'quirk', verb: 'list', origin, quirks: [quirkAdded.quirk],
  });

  const quirkRemoved = await sites(
    { sub: 'quirk', verb: 'remove', name: 'cookie-banner', origin, json: true },
    { paths },
  );
  assert.deepEqual(quirkRemoved, {
    command: 'sites', sub: 'quirk', verb: 'remove', origin, name: 'cookie-banner', removed: true,
  });

  const quirkListedAfter = await sites({ sub: 'quirk', verb: 'list', origin, json: true }, { paths });
  assert.deepEqual(quirkListedAfter.quirks, []);

  // --- 7. re-sweep: nothing new was recorded since step 1's session
  // closed, so the cursor already covers every record -- the second sweep
  // must mine NOTHING (no double-counting), and the on-disk graph/
  // inventory must be BYTE-IDENTICAL to what step 3 read (mineSiteMemory
  // is never even invoked for a session with an empty compile slice --
  // sweep.mjs's own `if (compileRecords.length > 0)` guard -- so the files
  // are not merely unchanged in content, they are not touched at all). ---
  const secondCompile = await flows({ sub: 'compile', json: true }, { paths });
  assert.deepEqual(secondCompile.sites, {
    origins: [], edges: 0, targets: 0, evicted: 0, errors: [],
  });

  const showAfterResweep = await sites({ sub: 'show', origin, json: true }, { paths });
  assert.deepEqual(showAfterResweep.edges, showReport.edges);
  assert.deepEqual(showAfterResweep.patterns, showReport.patterns);
  // The digest summary path (readDigestSummaries) gets its one e2e
  // exercise here: the digest saved in step 5 must survive the re-sweep
  // and read back as the only entry, stale under the far-future clock.
  assert.equal(showAfterResweep.digests.length, 1);
  assert.equal(showAfterResweep.digests[0].pattern, '/');
  assert.deepEqual(showAfterResweep.quirks, []);

  // --- hygiene: best-effort outputDir cleanup, registered LAST so it runs
  // LAST -- node:test runs `t.after` hooks in registration (FIFO) order,
  // and the fixture close / session close hooks were registered earlier,
  // above (flows.test.mjs's own F6 idiom). ---
  t.after(() => rm(outputDir, { recursive: true, force: true }));
});
