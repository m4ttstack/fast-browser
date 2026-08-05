import assert from 'node:assert/strict';
import {
  lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { sites } from '../../lib/commands/sites.mjs';
import { resolvePaths } from '../../lib/core/paths.mjs';
import { patternSlug } from '../../lib/sites/patterns.mjs';
import {
  MAX_DIGEST_BYTES,
  MAX_QUIRKS_PER_ORIGIN,
  originDirName,
  readDigest,
  readSite,
} from '../../lib/sites/store.mjs';

async function tempPaths(t) {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-sites-cmd-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  return resolvePaths({ homeDir, pluginRoot: '/plugin' });
}

function fakeStdin(text) {
  return async () => text;
}

test('exports a dependency-injected sites command function', () => {
  assert.equal(typeof sites, 'function');
});

// --- show ---

test('show canonicalizes the origin and returns the full per-origin snapshot', async () => {
  const paths = { sitesDir: '/h/.fast-browser/sites', dataDir: '/h/.fast-browser' };
  let received;

  const report = await sites(
    {
      sub: 'show', origin: 'https://Shop.Example:443/x', json: true,
    },
    {
      paths,
      readSite: async (pathsArg, origin, options) => {
        received = { pathsArg, origin, options };
        return {
          graph: { edges: [{ from: null, to: '/cart', action: { tool: 'browser_navigate' }, count: 1, lastSeenAt: '2026-08-05T00:00:00.000Z' }] },
          inventory: {
            patterns: {
              '/cart': { targets: [{ role: 'button', name: 'Place order', kinds: ['role'], count: 2, lastSeenAt: '2026-08-05T00:00:00.000Z' }], lastSeenAt: '2026-08-05T00:00:00.000Z' },
            },
          },
          quirks: { quirks: [{ name: 'cookie-banner' }] },
          digests: [{ pattern: '/cart', savedAt: '2026-08-05T00:00:00.000Z', ttlHours: 72, stale: false }],
        };
      },
    },
  );

  // Canonicalized to a bare origin: default port stripped, host lowercased,
  // path/query/hash dropped -- store.mjs rejects anything else.
  assert.equal(received.origin, 'https://shop.example');
  assert.equal(received.pathsArg, paths);

  assert.deepEqual(report, {
    command: 'sites',
    sub: 'show',
    origin: 'https://shop.example',
    edges: [{
      from: null, to: '/cart', action: { tool: 'browser_navigate' }, count: 1, lastSeenAt: '2026-08-05T00:00:00.000Z',
    }],
    patterns: [{
      pattern: '/cart',
      targets: [{
        role: 'button', name: 'Place order', kinds: ['role'], count: 2, lastSeenAt: '2026-08-05T00:00:00.000Z',
      }],
      lastSeenAt: '2026-08-05T00:00:00.000Z',
    }],
    quirks: [{ name: 'cookie-banner' }],
    digests: [{
      pattern: '/cart', savedAt: '2026-08-05T00:00:00.000Z', ttlHours: 72, stale: false,
    }],
  });
});

test('show sorts multiple inventory patterns into a stable array order', async () => {
  const paths = { sitesDir: '/h/sites', dataDir: '/h' };
  const report = await sites(
    { sub: 'show', origin: 'https://example.com', json: true },
    {
      paths,
      readSite: async () => ({
        graph: { edges: [] },
        inventory: {
          patterns: {
            '/orders/:id': { targets: [], lastSeenAt: '2026-08-05T00:00:00.000Z' },
            '/cart': { targets: [], lastSeenAt: '2026-08-05T00:00:00.000Z' },
          },
        },
        quirks: { quirks: [] },
        digests: [],
      }),
    },
  );
  assert.deepEqual(report.patterns.map((entry) => entry.pattern), ['/cart', '/orders/:id']);
});

test('show refuses an unparseable or non-http(s) origin without echoing it', async () => {
  for (const bad of ['not a url', 'ftp://shop.example']) {
    await assert.rejects(
      sites(
        { sub: 'show', origin: bad, json: false },
        { paths: { sitesDir: '/h/sites', dataDir: '/h' }, readSite: async () => { throw new Error('must not read the store'); } },
      ),
      (error) => error.name === 'LifecycleError'
        && !error.message.includes(bad)
        && /origin/i.test(error.message),
    );
  }
  // An empty origin can't be checked for "does not echo the value" (the
  // empty string is trivially a substring of any message); it still must
  // be refused as a validation failure like any other unparseable input.
  await assert.rejects(
    sites(
      { sub: 'show', origin: '', json: false },
      { paths: { sitesDir: '/h/sites', dataDir: '/h' }, readSite: async () => { throw new Error('must not read the store'); } },
    ),
    (error) => error.name === 'LifecycleError' && /origin/i.test(error.message),
  );
});

// --- affordances ---

test('affordances reports found:true with the freshest digest plus the mined inventory for that pattern', async () => {
  const paths = { sitesDir: '/h/sites', dataDir: '/h' };
  let digestArgs;
  let siteArgs;

  const report = await sites(
    { sub: 'affordances', url: 'https://Shop.Example/cart/123', json: true },
    {
      paths,
      readDigest: async (pathsArg, origin, pattern, options) => {
        digestArgs = { pathsArg, origin, pattern, options };
        return {
          savedAt: '2026-08-05T00:00:00.000Z', stale: false, digest: { affordances: ['button:Place order'] },
        };
      },
      readSite: async (pathsArg, origin, options) => {
        siteArgs = { pathsArg, origin, options };
        return {
          inventory: { patterns: { '/cart/:id': { targets: [{ role: 'button', name: 'Place order' }] } } },
        };
      },
    },
  );

  assert.equal(digestArgs.origin, 'https://shop.example');
  assert.equal(digestArgs.pattern, '/cart/:id');
  assert.equal(siteArgs.origin, 'https://shop.example');
  assert.deepEqual(report, {
    command: 'sites',
    sub: 'affordances',
    found: true,
    stale: false,
    savedAt: '2026-08-05T00:00:00.000Z',
    pattern: '/cart/:id',
    digest: { affordances: ['button:Place order'] },
    inventory: [{ role: 'button', name: 'Place order' }],
  });
});

test('affordances reports found:false but still returns the mined inventory as the fallback layer, exit-worthy (no throw)', async () => {
  const report = await sites(
    { sub: 'affordances', url: 'https://example.com/cart', json: true },
    {
      paths: { sitesDir: '/h/sites', dataDir: '/h' },
      readDigest: async () => null,
      readSite: async () => ({
        inventory: { patterns: { '/cart': { targets: [{ role: 'button', name: 'Place order' }] } } },
      }),
    },
  );
  assert.deepEqual(report, {
    command: 'sites',
    sub: 'affordances',
    found: false,
    stale: null,
    savedAt: null,
    pattern: '/cart',
    digest: null,
    inventory: [{ role: 'button', name: 'Place order' }],
  });
});

test('affordances returns an empty inventory array when nothing has been mined for that pattern either', async () => {
  const report = await sites(
    { sub: 'affordances', url: 'https://example.com/nowhere', json: true },
    {
      paths: { sitesDir: '/h/sites', dataDir: '/h' },
      readDigest: async () => null,
      readSite: async () => ({ inventory: { patterns: {} } }),
    },
  );
  assert.equal(report.found, false);
  assert.deepEqual(report.inventory, []);
});

test('affordances refuses an unparseable or non-http(s) url without echoing it', async () => {
  for (const bad of ['not a url', 'ftp://shop.example/x', 'about:blank']) {
    await assert.rejects(
      sites(
        { sub: 'affordances', url: bad, json: false },
        {
          paths: { sitesDir: '/h/sites', dataDir: '/h' },
          readDigest: async () => { throw new Error('must not read the store'); },
          readSite: async () => { throw new Error('must not read the store'); },
        },
      ),
      (error) => error.name === 'LifecycleError' && !error.message.includes(bad) && /url/i.test(error.message),
    );
  }
});

// --- digest ---

test('digest reads the payload from stdin, stores it, and echoes saved/pattern/stale:false', async () => {
  const paths = { sitesDir: '/h/sites', dataDir: '/h' };
  let written;

  const report = await sites(
    { sub: 'digest', url: 'https://Shop.Example/cart', ttlHours: null, json: true },
    {
      paths,
      readStdin: fakeStdin(JSON.stringify({ affordances: ['button:Place order'] })),
      writeDigest: async (pathsArg, origin, record) => { written = { pathsArg, origin, record }; },
      now: () => new Date('2026-08-05T12:00:00.000Z'),
      assertConfined: async () => {},
    },
  );

  assert.equal(written.origin, 'https://shop.example');
  // The stored `url` is the SANITIZED form (origin + pathname only, fix
  // round 1 I1), not an echo of the raw input -- note the host case is
  // also normalized, since it comes from the canonical `origin`.
  assert.deepEqual(written.record, {
    schemaVersion: 1,
    url: 'https://shop.example/cart',
    pattern: '/cart',
    savedAt: '2026-08-05T12:00:00.000Z',
    ttlHours: 72,
    domHash: null,
    digest: { affordances: ['button:Place order'] },
  });
  assert.deepEqual(report, {
    command: 'sites', sub: 'digest', saved: true, pattern: '/cart', stale: false,
  });
});

test('digest uses --ttl-hours when given instead of the default', async () => {
  let written;
  await sites(
    { sub: 'digest', url: 'https://example.com/cart', ttlHours: 24, json: true },
    {
      paths: { sitesDir: '/h/sites', dataDir: '/h' },
      readStdin: fakeStdin('{}'),
      writeDigest: async (pathsArg, origin, record) => { written = record; },
      now: () => new Date('2026-08-05T12:00:00.000Z'),
      assertConfined: async () => {},
    },
  );
  assert.equal(written.ttlHours, 24);
});

test('digest rejects a stdin payload over MAX_DIGEST_BYTES without writing', async () => {
  const oversized = JSON.stringify({ blob: 'x'.repeat(MAX_DIGEST_BYTES) });
  await assert.rejects(
    sites(
      { sub: 'digest', url: 'https://example.com/cart', json: false },
      {
        paths: { sitesDir: '/h/sites', dataDir: '/h' },
        readStdin: fakeStdin(oversized),
        writeDigest: async () => { throw new Error('must not write an oversized digest'); },
      },
    ),
    (error) => error.name === 'LifecycleError' && /bytes/i.test(error.message),
  );
});

// Fix round 1, M8: pin the DEFAULT streaming stdin reader itself (not a
// fake `readStdin`) against a real `Readable`, exactly at the
// MAX_DIGEST_BYTES boundary and one byte past it. `payloadOfSize` builds
// `JSON.stringify({ filler: 'x'.repeat(n) })` whose total byte length is
// exactly `13 + n` (the fixed `{"filler":"` / `"}` wrapper is 13 ASCII
// bytes), so the caller can hit an exact byte target; the payload is split
// across three chunks so the real stream genuinely exercises multi-chunk
// accumulation, not a single `for await` iteration.
function payloadOfSize(totalBytes) {
  const filler = 'x'.repeat(totalBytes - 13);
  const raw = JSON.stringify({ filler });
  assert.equal(Buffer.byteLength(raw, 'utf8'), totalBytes);
  const third = Math.floor(raw.length / 3);
  return [raw.slice(0, third), raw.slice(third, third * 2), raw.slice(third * 2)];
}

test('[real stream] the default stdin reader accepts exactly MAX_DIGEST_BYTES and rejects one byte more', async () => {
  const atBound = Readable.from(payloadOfSize(MAX_DIGEST_BYTES));
  let written;
  const report = await sites(
    { sub: 'digest', url: 'https://example.com/cart', json: true },
    {
      paths: { sitesDir: '/h/sites', dataDir: '/h' },
      input: atBound,
      writeDigest: async (pathsArg, origin, record) => { written = record; },
      now: () => new Date('2026-08-05T12:00:00.000Z'),
      assertConfined: async () => {},
    },
  );
  assert.equal(report.saved, true);
  assert.equal(written.digest.filler.length, MAX_DIGEST_BYTES - 13);

  const overBound = Readable.from(payloadOfSize(MAX_DIGEST_BYTES + 1));
  await assert.rejects(
    sites(
      { sub: 'digest', url: 'https://example.com/cart', json: false },
      {
        paths: { sitesDir: '/h/sites', dataDir: '/h' },
        input: overBound,
        writeDigest: async () => { throw new Error('must not write past the bound'); },
      },
    ),
    (error) => error.name === 'LifecycleError' && /bytes/i.test(error.message),
  );
});

test('digest rejects unparseable JSON on stdin without writing', async () => {
  await assert.rejects(
    sites(
      { sub: 'digest', url: 'https://example.com/cart', json: false },
      {
        paths: { sitesDir: '/h/sites', dataDir: '/h' },
        readStdin: fakeStdin('not json at all {'),
        writeDigest: async () => { throw new Error('must not write'); },
      },
    ),
    (error) => error.name === 'LifecycleError' && /parsed/i.test(error.message),
  );
});

test('digest rejects a non-object payload on stdin (array, string, number, null) without writing', async () => {
  for (const raw of ['[1,2,3]', '"just a string"', '42', 'null']) {
    await assert.rejects(
      sites(
        { sub: 'digest', url: 'https://example.com/cart', json: false },
        {
          paths: { sitesDir: '/h/sites', dataDir: '/h' },
          readStdin: fakeStdin(raw),
          writeDigest: async () => { throw new Error('must not write'); },
        },
      ),
      (error) => error.name === 'LifecycleError' && /object/i.test(error.message),
    );
  }
});

test('digest refuses an unparseable or non-http(s) url before ever touching stdin or the store', async () => {
  await assert.rejects(
    sites(
      { sub: 'digest', url: 'not a url', json: false },
      {
        paths: { sitesDir: '/h/sites', dataDir: '/h' },
        readStdin: async () => { throw new Error('must not read stdin'); },
        writeDigest: async () => { throw new Error('must not write'); },
      },
    ),
    (error) => error.name === 'LifecycleError' && !error.message.includes('not a url'),
  );
});

test('[real fs] digest writes a real digest record that readDigest can read back', async (t) => {
  const paths = await tempPaths(t);
  const report = await sites(
    { sub: 'digest', url: 'https://shop.example/cart', ttlHours: 48, json: true },
    {
      paths,
      readStdin: fakeStdin(JSON.stringify({ affordances: ['button:Place order'] })),
      now: () => new Date('2026-08-05T12:00:00.000Z'),
    },
  );
  assert.deepEqual(report, {
    command: 'sites', sub: 'digest', saved: true, pattern: '/cart', stale: false,
  });

  const read = await readDigest(paths, 'https://shop.example', '/cart', {
    now: () => new Date('2026-08-05T13:00:00.000Z'),
  });
  assert.equal(read.ttlHours, 48);
  assert.equal(read.stale, false);
  assert.deepEqual(read.digest, { affordances: ['button:Place order'] });
});

// Fix round 1, I1: userinfo/query/fragment must never reach disk. The
// stored `url` field is sanitized down to `origin + pathname` only --
// verified here against the ACTUAL BYTES on disk (`readFile`), not just
// the parsed-back record, so a leak that only showed up in raw JSON
// formatting (whitespace, escaping) couldn't hide from this assertion.
test('[real fs] digest stores a sanitized url, stripping userinfo/query/fragment from the file bytes', async (t) => {
  const paths = await tempPaths(t);
  const hostile = 'https://user:hunter2@shop.example/cart?token=SECRET123#frag';

  const report = await sites(
    { sub: 'digest', url: hostile, json: true },
    {
      paths,
      readStdin: fakeStdin(JSON.stringify({ affordances: ['button:Place order'] })),
      now: () => new Date('2026-08-05T12:00:00.000Z'),
    },
  );
  assert.equal(report.pattern, '/cart');

  const digestFilePath = path.join(
    paths.sitesDir,
    originDirName('https://shop.example'),
    'digests',
    `${patternSlug('/cart')}.json`,
  );
  const raw = await readFile(digestFilePath, 'utf8');
  assert.doesNotMatch(raw, /hunter2/);
  assert.doesNotMatch(raw, /SECRET123/);
  assert.doesNotMatch(raw, /frag/);
  assert.match(raw, /"url": "https:\/\/shop\.example\/cart"/);

  const read = await readDigest(paths, 'https://shop.example', '/cart');
  assert.equal(read.url, 'https://shop.example/cart');
});

test('[real fs] digest refuses a symlink planted at the digest file path, leaving it untouched', async (t) => {
  const paths = await tempPaths(t);
  const originDir = path.join(paths.sitesDir, originDirName('https://shop.example'));
  const digestsDir = path.join(originDir, 'digests');
  await mkdir(digestsDir, { recursive: true });
  const outside = path.join(paths.homeDir, 'outside-digest.json');
  await writeFile(outside, 'not part of the store');
  const linkPath = path.join(digestsDir, `${patternSlug('/cart')}.json`);
  await symlink(outside, linkPath);

  await assert.rejects(
    sites(
      { sub: 'digest', url: 'https://shop.example/cart', json: false },
      { paths, readStdin: fakeStdin('{}') },
    ),
    (error) => error.name === 'LifecycleError',
  );

  const linkStat = await lstat(linkPath);
  assert.equal(linkStat.isSymbolicLink(), true);
  assert.equal(await readFile(outside, 'utf8'), 'not part of the store');
});

// --- quirk: add / list / remove ---

test('quirk add validates the name is kebab-case before touching the store', async () => {
  await assert.rejects(
    sites(
      {
        sub: 'quirk', verb: 'add', name: 'Not_Kebab', origin: 'https://example.com', selector: '#x', description: null, urlPattern: null, json: false,
      },
      {
        paths: { sitesDir: '/h/sites', dataDir: '/h' },
        readSite: async () => { throw new Error('must not read the store'); },
        writeQuirks: async () => { throw new Error('must not write'); },
      },
    ),
    (error) => error.name === 'LifecycleError' && /kebab-case/i.test(error.message),
  );
});

test('quirk add refuses a duplicate name without writing', async () => {
  await assert.rejects(
    sites(
      {
        sub: 'quirk', verb: 'add', name: 'cookie-banner', origin: 'https://example.com', selector: '#accept', description: null, urlPattern: null, json: false,
      },
      {
        paths: { sitesDir: '/h/sites', dataDir: '/h' },
        readSite: async () => ({ quirks: { quirks: [{ name: 'cookie-banner' }] } }),
        writeQuirks: async () => { throw new Error('must not write on collision'); },
      },
    ),
    (error) => error.name === 'LifecycleError' && /already exists/i.test(error.message),
  );
});

test('quirk add enforces the MAX_QUIRKS_PER_ORIGIN bound', async () => {
  const existing = Array.from({ length: MAX_QUIRKS_PER_ORIGIN }, (_, index) => ({ name: `quirk-${index}` }));
  await assert.rejects(
    sites(
      {
        sub: 'quirk', verb: 'add', name: 'one-more', origin: 'https://example.com', selector: '#x', description: null, urlPattern: null, json: false,
      },
      {
        paths: { sitesDir: '/h/sites', dataDir: '/h' },
        readSite: async () => ({ quirks: { quirks: existing } }),
        writeQuirks: async () => { throw new Error('must not write past the bound'); },
      },
    ),
    (error) => error.name === 'LifecycleError' && /50/.test(error.message),
  );
});

test('quirk add builds the css locator target, omitting description when not given, and stamps addedAt/source', async () => {
  let written;
  const report = await sites(
    {
      sub: 'quirk', verb: 'add', name: 'cookie-banner', origin: 'https://Shop.Example', selector: '#accept', description: null, urlPattern: null, json: true,
    },
    {
      paths: { sitesDir: '/h/sites', dataDir: '/h' },
      readSite: async () => ({ quirks: { quirks: [] } }),
      writeQuirks: async (pathsArg, origin, quirks) => { written = { origin, quirks }; },
      now: () => new Date('2026-08-05T12:00:00.000Z'),
      assertConfined: async () => {},
    },
  );

  assert.equal(written.origin, 'https://shop.example');
  assert.deepEqual(written.quirks, {
    schemaVersion: 1,
    quirks: [{
      name: 'cookie-banner',
      urlPattern: null,
      target: { locators: [{ kind: 'css', selector: '#accept' }] },
      action: 'click',
      addedAt: '2026-08-05T12:00:00.000Z',
      source: 'agent',
    }],
  });
  assert.equal('description' in written.quirks.quirks[0].target, false);
  assert.deepEqual(report.quirk, written.quirks.quirks[0]);
});

test('quirk add includes description and urlPattern when given', async () => {
  let written;
  await sites(
    {
      sub: 'quirk', verb: 'add', name: 'cookie-banner', origin: 'https://example.com', selector: '#accept', description: 'Accept all cookies', urlPattern: '/cart', json: true,
    },
    {
      paths: { sitesDir: '/h/sites', dataDir: '/h' },
      readSite: async () => ({ quirks: { quirks: [] } }),
      writeQuirks: async (pathsArg, origin, quirks) => { written = quirks; },
      now: () => new Date('2026-08-05T12:00:00.000Z'),
      assertConfined: async () => {},
    },
  );
  assert.equal(written.quirks[0].target.description, 'Accept all cookies');
  assert.equal(written.quirks[0].urlPattern, '/cart');
});

// Fix round 1, I3: `--url-pattern` must start with `/` and stay within a
// length bound; the error names the requirement, never echoes the value.
test('quirk add rejects a url-pattern that is not a path, or is too long, without writing', async () => {
  const base = {
    sub: 'quirk', verb: 'add', name: 'cookie-banner', origin: 'https://example.com', selector: '#accept', description: null,
  };
  for (const bad of ['https://evil.example/absolute', 'cart', `/${'x'.repeat(200)}`]) {
    await assert.rejects(
      sites(
        { ...base, urlPattern: bad, json: false },
        {
          paths: { sitesDir: '/h/sites', dataDir: '/h' },
          readSite: async () => { throw new Error('must not read the store'); },
          writeQuirks: async () => { throw new Error('must not write'); },
        },
      ),
      (error) => error.name === 'LifecycleError'
        && !error.message.includes(bad)
        && /url-pattern/i.test(error.message),
    );
  }
});

test('quirk add accepts a url-pattern at exactly the 200-character bound and round-trips it', async () => {
  const atBound = `/${'x'.repeat(199)}`;
  assert.equal(atBound.length, 200);
  let written;
  await sites(
    {
      sub: 'quirk', verb: 'add', name: 'cookie-banner', origin: 'https://example.com', selector: '#accept', description: null, urlPattern: atBound, json: true,
    },
    {
      paths: { sitesDir: '/h/sites', dataDir: '/h' },
      readSite: async () => ({ quirks: { quirks: [] } }),
      writeQuirks: async (pathsArg, origin, quirks) => { written = quirks; },
      now: () => new Date('2026-08-05T12:00:00.000Z'),
      assertConfined: async () => {},
    },
  );
  assert.equal(written.quirks[0].urlPattern, atBound);
});

// Fix round 1, M4: selector and description are bounded at the command
// layer (defense in depth -- parse-args already rejects an empty
// --selector, but a caller invoking `sites()` directly, bypassing the
// CLI parser, must still be refused).
test('quirk add rejects an empty or over-length selector without writing', async () => {
  for (const bad of ['', 'x'.repeat(501)]) {
    await assert.rejects(
      sites(
        {
          sub: 'quirk', verb: 'add', name: 'cookie-banner', origin: 'https://example.com', selector: bad, description: null, urlPattern: null, json: false,
        },
        {
          paths: { sitesDir: '/h/sites', dataDir: '/h' },
          readSite: async () => { throw new Error('must not read the store'); },
          writeQuirks: async () => { throw new Error('must not write'); },
        },
      ),
      (error) => error.name === 'LifecycleError' && /selector/i.test(error.message),
    );
  }
});

test('quirk add rejects an over-length description without writing', async () => {
  await assert.rejects(
    sites(
      {
        sub: 'quirk', verb: 'add', name: 'cookie-banner', origin: 'https://example.com', selector: '#accept', description: 'x'.repeat(501), urlPattern: null, json: false,
      },
      {
        paths: { sitesDir: '/h/sites', dataDir: '/h' },
        readSite: async () => { throw new Error('must not read the store'); },
        writeQuirks: async () => { throw new Error('must not write'); },
      },
    ),
    (error) => error.name === 'LifecycleError' && /description/i.test(error.message),
  );
});

test('quirk add accepts a selector/description at exactly the 500-character bound', async () => {
  const atBound = 'x'.repeat(500);
  let written;
  await sites(
    {
      sub: 'quirk', verb: 'add', name: 'cookie-banner', origin: 'https://example.com', selector: atBound, description: atBound, urlPattern: null, json: true,
    },
    {
      paths: { sitesDir: '/h/sites', dataDir: '/h' },
      readSite: async () => ({ quirks: { quirks: [] } }),
      writeQuirks: async (pathsArg, origin, quirks) => { written = quirks; },
      now: () => new Date('2026-08-05T12:00:00.000Z'),
      assertConfined: async () => {},
    },
  );
  assert.equal(written.quirks[0].target.locators[0].selector, atBound);
  assert.equal(written.quirks[0].target.description, atBound);
});

// Fix round 1 nit: an empty --description is "not given", not an error --
// the key is omitted entirely rather than stored as an empty string.
test('quirk add omits the description key entirely when --description is an empty string', async () => {
  let written;
  await sites(
    {
      sub: 'quirk', verb: 'add', name: 'cookie-banner', origin: 'https://example.com', selector: '#accept', description: '', urlPattern: null, json: true,
    },
    {
      paths: { sitesDir: '/h/sites', dataDir: '/h' },
      readSite: async () => ({ quirks: { quirks: [] } }),
      writeQuirks: async (pathsArg, origin, quirks) => { written = quirks; },
      now: () => new Date('2026-08-05T12:00:00.000Z'),
      assertConfined: async () => {},
    },
  );
  assert.equal('description' in written.quirks[0].target, false);
});

test('quirk list returns the origin quirks verbatim', async () => {
  const stored = [{ name: 'cookie-banner' }, { name: 'newsletter-modal' }];
  const report = await sites(
    { sub: 'quirk', verb: 'list', origin: 'https://Shop.Example', json: true },
    {
      paths: { sitesDir: '/h/sites', dataDir: '/h' },
      readSite: async (pathsArg, origin) => {
        assert.equal(origin, 'https://shop.example');
        return { quirks: { quirks: stored } };
      },
    },
  );
  assert.deepEqual(report, {
    command: 'sites', sub: 'quirk', verb: 'list', origin: 'https://shop.example', quirks: stored,
  });
});

test('quirk remove deletes the named quirk and writes the remainder', async () => {
  let written;
  const report = await sites(
    {
      sub: 'quirk', verb: 'remove', name: 'cookie-banner', origin: 'https://example.com', json: false,
    },
    {
      paths: { sitesDir: '/h/sites', dataDir: '/h' },
      readSite: async () => ({ quirks: { quirks: [{ name: 'cookie-banner' }, { name: 'newsletter-modal' }] } }),
      writeQuirks: async (pathsArg, origin, quirks) => { written = quirks; },
      assertConfined: async () => {},
    },
  );
  assert.deepEqual(written, { schemaVersion: 1, quirks: [{ name: 'newsletter-modal' }] });
  assert.deepEqual(report, {
    command: 'sites', sub: 'quirk', verb: 'remove', origin: 'https://example.com', name: 'cookie-banner', removed: true,
  });
});

test('quirk remove refuses when no quirk with that name exists', async () => {
  await assert.rejects(
    sites(
      {
        sub: 'quirk', verb: 'remove', name: 'ghost', origin: 'https://example.com', json: false,
      },
      {
        paths: { sitesDir: '/h/sites', dataDir: '/h' },
        readSite: async () => ({ quirks: { quirks: [] } }),
        writeQuirks: async () => { throw new Error('must not write'); },
      },
    ),
    (error) => error.name === 'LifecycleError' && /no quirk/i.test(error.message),
  );
});

test('quirk dispatch refuses an unrecognised verb', async () => {
  await assert.rejects(
    sites(
      { sub: 'quirk', verb: 'bogus', origin: 'https://example.com', json: false },
      { paths: { sitesDir: '/h/sites', dataDir: '/h' } },
    ),
    (error) => error.name === 'LifecycleError' && /verb/i.test(error.message) && error.exitCode === 2,
  );
});

test('[real fs] quirk add/list/remove round-trip against a real tmpdir', async (t) => {
  const paths = await tempPaths(t);
  const origin = 'https://shop.example';

  const added = await sites(
    {
      sub: 'quirk', verb: 'add', name: 'cookie-banner', origin, selector: '#cookie-accept', description: 'Accept all cookies', urlPattern: null, json: true,
    },
    { paths, now: () => new Date('2026-08-05T12:00:00.000Z') },
  );
  assert.equal(added.quirk.name, 'cookie-banner');

  const listed = await sites(
    { sub: 'quirk', verb: 'list', origin, json: true },
    { paths },
  );
  assert.equal(listed.quirks.length, 1);
  assert.equal(listed.quirks[0].name, 'cookie-banner');

  const site = await readSite(paths, origin);
  assert.equal(site.quirks.quirks.length, 1);

  const removed = await sites(
    { sub: 'quirk', verb: 'remove', name: 'cookie-banner', origin, json: true },
    { paths },
  );
  assert.deepEqual(removed, {
    command: 'sites', sub: 'quirk', verb: 'remove', origin, name: 'cookie-banner', removed: true,
  });

  const siteAfter = await readSite(paths, origin);
  assert.deepEqual(siteAfter.quirks.quirks, []);
});

test('[real fs] quirk add refuses a symlink planted at the quirks.json path, leaving it untouched', async (t) => {
  const paths = await tempPaths(t);
  const origin = 'https://shop.example';
  const originDir = path.join(paths.sitesDir, originDirName(origin));
  await mkdir(originDir, { recursive: true });
  const outside = path.join(paths.homeDir, 'outside-quirks.json');
  await writeFile(outside, JSON.stringify({ schemaVersion: 1, quirks: [] }));
  const linkPath = path.join(originDir, 'quirks.json');
  await symlink(outside, linkPath);

  await assert.rejects(
    sites(
      {
        sub: 'quirk', verb: 'add', name: 'cookie-banner', origin, selector: '#accept', description: null, urlPattern: null, json: false,
      },
      { paths },
    ),
    (error) => error.name === 'LifecycleError',
  );

  const linkStat = await lstat(linkPath);
  assert.equal(linkStat.isSymbolicLink(), true);
  assert.equal(await readFile(outside, 'utf8'), JSON.stringify({ schemaVersion: 1, quirks: [] }));
});

test('[real fs] quirk remove refuses a symlink planted at the quirks.json path, leaving the underlying data untouched', async (t) => {
  const paths = await tempPaths(t);
  const origin = 'https://shop.example';
  const originDir = path.join(paths.sitesDir, originDirName(origin));
  await mkdir(originDir, { recursive: true });
  const outsideContent = JSON.stringify({
    schemaVersion: 1,
    quirks: [{
      name: 'cookie-banner',
      urlPattern: null,
      target: { locators: [{ kind: 'css', selector: '#accept' }] },
      action: 'click',
      addedAt: '2026-08-05T00:00:00.000Z',
      source: 'agent',
    }],
  });
  const outside = path.join(paths.homeDir, 'outside-quirks.json');
  await writeFile(outside, outsideContent);
  const linkPath = path.join(originDir, 'quirks.json');
  await symlink(outside, linkPath);

  await assert.rejects(
    sites(
      {
        sub: 'quirk', verb: 'remove', name: 'cookie-banner', origin, json: false,
      },
      { paths },
    ),
    (error) => error.name === 'LifecycleError',
  );

  const linkStat = await lstat(linkPath);
  assert.equal(linkStat.isSymbolicLink(), true);
  assert.equal(await readFile(outside, 'utf8'), outsideContent);
});

// --- real-fs: an ancestor-symlinked dataDir (mirrors flows-command.test.mjs's
// own fix-round-2 coverage) ---

test('[real fs] quirk add succeeds when dataDir itself is reached through an ancestor symlink', async (t) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-sites-symhome-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const realDataDir = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-sites-realdata-'));
  t.after(() => rm(realDataDir, { recursive: true, force: true }));

  const paths = resolvePaths({ homeDir, pluginRoot: '/plugin' });
  await symlink(realDataDir, paths.dataDir);

  const origin = 'https://shop.example';
  const report = await sites(
    {
      sub: 'quirk', verb: 'add', name: 'cookie-banner', origin, selector: '#accept', description: null, urlPattern: null, json: true,
    },
    { paths, now: () => new Date('2026-08-05T12:00:00.000Z') },
  );
  assert.equal(report.quirk.name, 'cookie-banner');

  const writtenPath = path.join(
    realDataDir,
    'sites',
    originDirName(origin),
    'quirks.json',
  );
  const writtenRaw = await readFile(writtenPath, 'utf8');
  assert.match(writtenRaw, /cookie-banner/);
});

// --- top-level dispatch ---

test('sites refuses an unrecognised subcommand', async () => {
  await assert.rejects(
    sites(
      { sub: 'bogus', json: false },
      { paths: { sitesDir: '/h/sites', dataDir: '/h' } },
    ),
    (error) => error.name === 'LifecycleError' && /subcommand/i.test(error.message) && error.exitCode === 2,
  );
});
