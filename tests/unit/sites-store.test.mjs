import assert from 'node:assert/strict';
import {
  mkdir, mkdtemp, rm, stat, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolvePaths } from '../../lib/core/paths.mjs';
import {
  MAX_DIGEST_BYTES,
  MAX_EDGES_PER_ORIGIN,
  MAX_PATTERNS_PER_ORIGIN,
  MAX_QUIRKS_PER_ORIGIN,
  MAX_TARGETS_PER_PATTERN,
  listSiteOrigins,
  originDirName,
  originFromDirName,
  readDigest,
  readSite,
  writeDigest,
  writeGraph,
  writeInventory,
  writeQuirks,
} from '../../lib/sites/store.mjs';

async function tempPaths(t) {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-sites-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  return resolvePaths({ homeDir, pluginRoot: '/plugin' });
}

const ORIGIN = 'https://shop.example';

function graph(overrides = {}) {
  return {
    schemaVersion: 1,
    edges: [
      {
        from: null,
        to: '/cart',
        action: { tool: 'browser_navigate' },
        count: 1,
        lastSeenAt: '2026-08-05T12:00:00.000Z',
      },
      {
        from: '/cart',
        to: '/orders/:id',
        action: { tool: 'browser_click', targetName: 'Place order' },
        count: 3,
        lastSeenAt: '2026-08-05T12:05:00.000Z',
      },
    ],
    ...overrides,
  };
}

function inventory(overrides = {}) {
  return {
    schemaVersion: 1,
    patterns: {
      '/cart': {
        targets: [
          {
            role: 'button',
            name: 'Place order',
            kinds: ['role', 'testid'],
            count: 3,
            lastSeenAt: '2026-08-05T12:05:00.000Z',
          },
        ],
        lastSeenAt: '2026-08-05T12:05:00.000Z',
      },
    },
    ...overrides,
  };
}

function quirks(overrides = {}) {
  return {
    schemaVersion: 1,
    quirks: [
      {
        name: 'cookie-banner',
        urlPattern: null,
        target: {
          locators: [{ kind: 'css', selector: '#cookie-accept' }],
          description: 'Accept all cookies button',
        },
        action: 'click',
        addedAt: '2026-08-05T12:00:00.000Z',
        source: 'agent',
      },
    ],
    ...overrides,
  };
}

function digestRecord(overrides = {}) {
  return {
    schemaVersion: 1,
    url: 'https://shop.example/cart',
    pattern: '/cart',
    savedAt: '2026-08-05T12:00:00.000Z',
    ttlHours: 72,
    domHash: null,
    digest: { affordances: ['button:Place order'] },
    ...overrides,
  };
}

// --- origin dir encoding ---

test('originDirName / originFromDirName round-trip, including a port', () => {
  const origin = 'https://shop.example:8443';
  const dirName = originDirName(origin);
  assert.equal(dirName, encodeURIComponent(origin));
  assert.equal(originFromDirName(dirName), origin);
});

test('originDirName rejects anything that is not a bare http(s) origin', () => {
  for (const bad of ['not a url', 'ftp://files.example', 'https://shop.example/cart', '']) {
    assert.throws(() => originDirName(bad), /origin/);
  }
});

test('originFromDirName returns null for a name that does not round-trip', () => {
  assert.equal(originFromDirName('not-percent-encoded'), null);
  assert.equal(originFromDirName('%'), null); // malformed percent-encoding
  assert.equal(originFromDirName(encodeURIComponent('just-a-string')), null);
});

// --- write/read round-trip for all four stores ---

test('writeGraph/readSite round-trip the graph shape', async (t) => {
  const paths = await tempPaths(t);
  await writeGraph(paths, ORIGIN, graph());
  const site = await readSite(paths, ORIGIN);
  assert.deepEqual(site.graph, graph());
});

test('writeInventory/readSite round-trip the inventory shape', async (t) => {
  const paths = await tempPaths(t);
  await writeInventory(paths, ORIGIN, inventory());
  const site = await readSite(paths, ORIGIN);
  assert.deepEqual(site.inventory, inventory());
});

test('writeQuirks/readSite round-trip the quirks shape', async (t) => {
  const paths = await tempPaths(t);
  await writeQuirks(paths, ORIGIN, quirks());
  const site = await readSite(paths, ORIGIN);
  assert.deepEqual(site.quirks, quirks());
});

test('writeDigest/readDigest round-trip a digest record', async (t) => {
  const paths = await tempPaths(t);
  await writeDigest(paths, ORIGIN, digestRecord());
  const read = await readDigest(paths, ORIGIN, '/cart', { now: () => new Date('2026-08-05T13:00:00.000Z') });
  assert.equal(read.url, 'https://shop.example/cart');
  assert.equal(read.pattern, '/cart');
  assert.equal(read.savedAt, '2026-08-05T12:00:00.000Z');
  assert.equal(read.ttlHours, 72);
  assert.equal(read.domHash, null);
  assert.deepEqual(read.digest, { affordances: ['button:Place order'] });
  assert.equal(read.stale, false);
});

test('writeDigest/readSite surfaces the digest in the digests summary', async (t) => {
  const paths = await tempPaths(t);
  await writeDigest(paths, ORIGIN, digestRecord());
  const site = await readSite(paths, ORIGIN, { now: () => new Date('2026-08-05T13:00:00.000Z') });
  assert.equal(site.digests.length, 1);
  assert.equal(site.digests[0].pattern, '/cart');
  assert.equal(site.digests[0].savedAt, '2026-08-05T12:00:00.000Z');
  assert.equal(site.digests[0].ttlHours, 72);
  assert.equal(site.digests[0].stale, false);
});

// --- writes validate origin ---

test('every write rejects a non-origin string with a path-annotated error', async (t) => {
  const paths = await tempPaths(t);
  await assert.rejects(() => writeGraph(paths, 'https://shop.example/cart', graph()), /origin/);
  await assert.rejects(() => writeInventory(paths, 'not a url', inventory()), /origin/);
  await assert.rejects(() => writeQuirks(paths, 'ftp://shop.example', quirks()), /origin/);
  await assert.rejects(() => writeDigest(paths, '', digestRecord()), /origin/);
});

// --- corrupt JSON -> empty defaults, never throw ---

test('readSite returns empty defaults when nothing has been written', async (t) => {
  const paths = await tempPaths(t);
  const site = await readSite(paths, ORIGIN);
  assert.deepEqual(site, {
    graph: { schemaVersion: 1, edges: [] },
    inventory: { schemaVersion: 1, patterns: {} },
    quirks: { schemaVersion: 1, quirks: [] },
    digests: [],
  });
});

test('readSite returns empty defaults for corrupt JSON instead of throwing', async (t) => {
  const paths = await tempPaths(t);
  const originDir = path.join(paths.sitesDir, originDirName(ORIGIN));
  await mkdir(originDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(originDir, 'graph.json'), '{ not json', 'utf8');
  await writeFile(path.join(originDir, 'inventory.json'), '[]', 'utf8'); // wrong shape, not just bad JSON
  await writeFile(path.join(originDir, 'quirks.json'), 'null', 'utf8');
  await mkdir(path.join(originDir, 'digests'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(originDir, 'digests', 'cart.json'), 'not json at all', 'utf8');

  const site = await readSite(paths, ORIGIN);
  assert.deepEqual(site.graph, { schemaVersion: 1, edges: [] });
  assert.deepEqual(site.inventory, { schemaVersion: 1, patterns: {} });
  assert.deepEqual(site.quirks, { schemaVersion: 1, quirks: [] });
  assert.deepEqual(site.digests, []);
});

test('readSite tolerates a nonsense origin string instead of throwing', async (t) => {
  const paths = await tempPaths(t);
  const site = await readSite(paths, 'not an origin at all');
  assert.deepEqual(site, {
    graph: { schemaVersion: 1, edges: [] },
    inventory: { schemaVersion: 1, patterns: {} },
    quirks: { schemaVersion: 1, quirks: [] },
    digests: [],
  });
});

test('readDigest returns null for a missing or corrupt digest instead of throwing', async (t) => {
  const paths = await tempPaths(t);
  assert.equal(await readDigest(paths, ORIGIN, '/nowhere'), null);

  await writeGraph(paths, ORIGIN, graph()); // creates the origin dir
  const digestsDir = path.join(paths.sitesDir, originDirName(ORIGIN), 'digests');
  await mkdir(digestsDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(digestsDir, 'root.json'), '{ broken', 'utf8');
  assert.equal(await readDigest(paths, ORIGIN, '/'), null);
});

// --- digest TTL staleness ---

test('readDigest flips stale across the ttlHours boundary via an injected clock', async (t) => {
  const paths = await tempPaths(t);
  await writeDigest(paths, ORIGIN, digestRecord({ savedAt: '2026-08-05T12:00:00.000Z', ttlHours: 1 }));

  const justInside = await readDigest(paths, ORIGIN, '/cart', {
    now: () => new Date('2026-08-05T12:59:59.000Z'),
  });
  assert.equal(justInside.stale, false);

  const justOutside = await readDigest(paths, ORIGIN, '/cart', {
    now: () => new Date('2026-08-05T13:00:01.000Z'),
  });
  assert.equal(justOutside.stale, true);
});

// --- origin listing / foreign dirs skipped ---

test('listSiteOrigins lists only directories that round-trip as valid origins', async (t) => {
  const paths = await tempPaths(t);
  await writeGraph(paths, 'https://shop.example', graph());
  await writeGraph(paths, 'https://other.example:9000', graph());
  await mkdir(paths.sitesDir, { recursive: true, mode: 0o700 });
  await mkdir(path.join(paths.sitesDir, 'not-an-origin'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(paths.sitesDir, '.DS_Store-ish'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(paths.sitesDir, 'a-stray-file.json'), '{}', 'utf8');

  const origins = await listSiteOrigins(paths);
  assert.deepEqual(
    origins.slice().sort(),
    ['https://other.example:9000', 'https://shop.example'].sort(),
  );
});

test('listSiteOrigins returns empty when the sites directory does not exist yet', async (t) => {
  const paths = await tempPaths(t);
  assert.deepEqual(await listSiteOrigins(paths), []);
});

// --- filesystem hygiene: per-origin dirs 0o700 on demand, files 0o600 ---

test('writeGraph creates the per-origin directory 0o700 on demand and writes the file 0o600', async (t) => {
  const paths = await tempPaths(t);
  await writeGraph(paths, ORIGIN, graph());

  const originDir = path.join(paths.sitesDir, originDirName(ORIGIN));
  const dirStat = await stat(originDir);
  assert.equal(dirStat.mode & 0o777, 0o700);

  const fileStat = await stat(path.join(originDir, 'graph.json'));
  assert.equal(fileStat.mode & 0o777, 0o600);
});

test('digests directory is created 0o700 on demand', async (t) => {
  const paths = await tempPaths(t);
  await writeDigest(paths, ORIGIN, digestRecord());
  const digestsDir = path.join(paths.sitesDir, originDirName(ORIGIN), 'digests');
  const dirStat = await stat(digestsDir);
  assert.equal(dirStat.mode & 0o777, 0o700);
});

// --- digest payload bound ---

test('writeDigest rejects a digest payload over the 64KB bound', async (t) => {
  const paths = await tempPaths(t);
  const oversized = digestRecord({ digest: { blob: 'x'.repeat(MAX_DIGEST_BYTES) } });
  await assert.rejects(() => writeDigest(paths, ORIGIN, oversized));
});

// --- bounds constants exist for later tasks to import ---

test('bounds constants match the plan Shared shapes table', () => {
  assert.equal(MAX_EDGES_PER_ORIGIN, 200);
  assert.equal(MAX_PATTERNS_PER_ORIGIN, 200);
  assert.equal(MAX_TARGETS_PER_PATTERN, 40);
  assert.equal(MAX_QUIRKS_PER_ORIGIN, 50);
  assert.equal(MAX_DIGEST_BYTES, 64 * 1024);
});

// --- shape validation rejects malformed writes (artifact.mjs-style strictness) ---

test('writeGraph rejects an unknown top-level key', async (t) => {
  const paths = await tempPaths(t);
  await assert.rejects(() => writeGraph(paths, ORIGIN, { ...graph(), extra: true }));
});

test('writeQuirks rejects a non-kebab-case quirk name', async (t) => {
  const paths = await tempPaths(t);
  const bad = quirks({ quirks: [{ ...quirks().quirks[0], name: 'Cookie_Banner' }] });
  await assert.rejects(() => writeQuirks(paths, ORIGIN, bad));
});

test('writeGraph rejects a wrong schemaVersion', async (t) => {
  const paths = await tempPaths(t);
  await assert.rejects(() => writeGraph(paths, ORIGIN, { ...graph(), schemaVersion: 2 }));
});
