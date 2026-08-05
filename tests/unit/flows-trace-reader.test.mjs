import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  cleanArray,
  isTruncationMarker,
  listTraceSessions,
  readTraceRecords,
} from '../../lib/flows/trace-reader.mjs';

const fixturesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/traces',
);
const basicDir = path.join(fixturesDir, 'trace-1754350000000');
const truncatedDir = path.join(fixturesDir, 'trace-1754350100000');
// Added by Task 4 (compiler): a read-only session (nav + GET-only click +
// an extract-style run_code_unsafe) the compiler's tests compile against
// directly. It's a third TRACE.md-shaped golden fixture, so it's also
// listed here.
const readOnlyDir = path.join(fixturesDir, 'trace-1754350200000');

async function tempDataDir() {
  return mkdtemp(path.join(os.tmpdir(), 'fast-browser-trace-reader-'));
}

test('listTraceSessions lists the golden fixtures ascending by epochMs with parsed meta', async () => {
  const sessions = await listTraceSessions(fixturesDir);

  assert.equal(sessions.length, 3);
  assert.deepEqual(
    sessions.map((session) => session.epochMs),
    [1754350000000, 1754350100000, 1754350200000],
  );
  assert.equal(sessions[0].dir, basicDir);
  assert.equal(sessions[1].dir, truncatedDir);
  assert.equal(sessions[2].dir, readOnlyDir);
  for (const session of sessions) {
    assert.equal(session.meta.schemaVersion, 1);
    assert.equal(session.meta.productVersion, '0.1.0-alpha.10');
    assert.equal(session.meta.protocolVersion, 2);
  }
});

test('listTraceSessions tolerates missing and unparseable meta.json, still lists the session', async (t) => {
  const dataDir = await tempDataDir();
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const noMeta = path.join(dataDir, 'trace-1000000000000');
  const badMeta = path.join(dataDir, 'trace-2000000000000');
  const goodMeta = path.join(dataDir, 'trace-3000000000000');
  await Promise.all([mkdir(noMeta), mkdir(badMeta), mkdir(goodMeta)]);
  await Promise.all([
    writeFile(path.join(noMeta, 'actions.jsonl'), ''),
    writeFile(path.join(badMeta, 'meta.json'), '{ not json'),
    writeFile(path.join(badMeta, 'actions.jsonl'), ''),
    writeFile(path.join(goodMeta, 'meta.json'), JSON.stringify({ schemaVersion: 1 })),
    writeFile(path.join(goodMeta, 'actions.jsonl'), ''),
  ]);

  const sessions = await listTraceSessions(dataDir);

  assert.equal(sessions.length, 3);
  assert.deepEqual(sessions.map((session) => session.epochMs), [
    1000000000000, 2000000000000, 3000000000000,
  ]);
  assert.equal(sessions[0].meta, null);
  assert.equal(sessions[1].meta, null);
  assert.deepEqual(sessions[2].meta, { schemaVersion: 1 });
});

test('listTraceSessions never throws for a missing data directory', async () => {
  const sessions = await listTraceSessions('/nonexistent/fast-browser-data-dir');
  assert.deepEqual(sessions, []);
});

test('readTraceRecords parses the session-basic fixture into six records with zero skipped', async () => {
  const { records, skipped } = await readTraceRecords(basicDir);

  assert.equal(records.length, 6);
  assert.equal(skipped, 0);

  const [navigate, snapshot, click, fillForm, runCode, errored] = records;

  assert.equal(navigate.tool, 'browser_navigate');
  assert.equal(navigate.urlAfter, 'https://example.com/cart');
  assert.deepEqual(navigate.network, []);
  assert.equal(navigate.mutating, false);

  assert.equal(snapshot.tool, 'browser_snapshot');
  assert.deepEqual(snapshot.targets, []);

  assert.equal(click.tool, 'browser_click');
  assert.equal(click.mutating, true);
  assert.equal(click.targets.length, 1);
  assert.equal(click.targets[0].ref, 'e5');
  assert.equal(click.targets[0].role, 'button');
  assert.equal(click.targets[0].name, 'Place order');
  assert.deepEqual(
    click.targets[0].alternates.map((alternate) => alternate.kind),
    ['role', 'testid'],
  );
  assert.equal(click.network.length, 1);
  assert.equal(click.network[0].method, 'POST');

  assert.equal(fillForm.tool, 'browser_fill_form');
  assert.equal(fillForm.targets.length, 2);
  assert.equal(fillForm.mutating, false);
  assert.deepEqual(fillForm.network, []);

  assert.equal(runCode.tool, 'browser_run_code_unsafe');
  assert.match(runCode.script.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(runCode.script.args, { timeoutMs: 5000 });
  assert.equal(runCode.script.actions.length, 1);

  assert.equal(typeof errored.error, 'string');
  assert.ok(errored.error.length > 0);
});

test('readTraceRecords counts hostile lines in the session-truncated fixture without throwing', async () => {
  const { records, skipped } = await readTraceRecords(truncatedDir);

  assert.equal(records.length, 2);
  assert.equal(skipped, 2);

  const [truncatedNetwork, legacyScript] = records;

  const lastNetworkEntry = truncatedNetwork.network[truncatedNetwork.network.length - 1];
  assert.equal(isTruncationMarker(lastNetworkEntry), true);
  const cleanedNetwork = cleanArray(truncatedNetwork.network);
  assert.equal(cleanedNetwork.truncated, true);
  assert.equal(cleanedNetwork.items.length, 1);
  assert.equal(cleanedNetwork.items[0].method, 'GET');
  assert.equal(cleanedNetwork.items.some((item) => isTruncationMarker(item)), false);

  assert.equal(isTruncationMarker(legacyScript.script), true);
  const cleanedScript = cleanArray(legacyScript.script);
  assert.deepEqual(cleanedScript, { items: [], truncated: true });
});

test('readTraceRecords never throws when actions.jsonl is missing', async (t) => {
  const dataDir = await tempDataDir();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const sessionDir = path.join(dataDir, 'trace-9999999999999');
  await mkdir(sessionDir);

  const result = await readTraceRecords(sessionDir);
  assert.deepEqual(result, { records: [], skipped: 0 });
});

test('isTruncationMarker recognizes every marker shape and rejects ordinary data', () => {
  assert.equal(
    isTruncationMarker({ __truncated__: true, omittedElements: 5, sizeBytes: 10 }),
    true,
  );
  assert.equal(isTruncationMarker({ __truncated__: true, sizeBytes: 10 }), true);
  assert.equal(isTruncationMarker({ __truncated__: true }), true);

  assert.equal(isTruncationMarker({ method: 'GET', url: 'https://example.com' }), false);
  assert.equal(isTruncationMarker([]), false);
  assert.equal(isTruncationMarker(null), false);
  assert.equal(isTruncationMarker(undefined), false);
  assert.equal(isTruncationMarker('marker'), false);
});

test('cleanArray strips a trailing marker and tolerates missing or legacy shapes', () => {
  assert.deepEqual(
    cleanArray([1, 2, { __truncated__: true, omittedElements: 1, sizeBytes: 2 }]),
    { items: [1, 2], truncated: true },
  );
  assert.deepEqual(cleanArray([1, 2]), { items: [1, 2], truncated: false });
  assert.deepEqual(cleanArray([]), { items: [], truncated: false });
  assert.deepEqual(cleanArray(undefined), { items: [], truncated: false });
  assert.deepEqual(
    cleanArray({ __truncated__: true, sizeBytes: 5 }),
    { items: [], truncated: true },
  );
});
