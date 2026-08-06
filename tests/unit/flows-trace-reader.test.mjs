import assert from 'node:assert/strict';
import {
  appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  cleanArray,
  isReplayRecord,
  isTruncationMarker,
  listTraceSessions,
  readTraceRecords,
  readTraceRecordsFrom,
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
  const { records, skipped, readable } = await readTraceRecords(basicDir);

  assert.equal(readable, true);
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
  const { records, skipped, readable } = await readTraceRecords(truncatedDir);

  assert.equal(readable, true); // the file itself read fine -- its CONTENT is hostile, not the read
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

test('readTraceRecords never throws when actions.jsonl is missing, and reports it as an honest empty session (readable: true)', async (t) => {
  const dataDir = await tempDataDir();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const sessionDir = path.join(dataDir, 'trace-9999999999999');
  await mkdir(sessionDir);

  const result = await readTraceRecords(sessionDir);
  // ENOENT specifically: no actions.jsonl at all is a session that
  // genuinely has nothing in it yet (or ever will -- a meta-only live
  // session), not a read fault. Reporting readable: false here (as this
  // reader used to, folding ENOENT into "any fs error") made
  // lib/flows/sweep.mjs report 'unreadable' on every sweep of such a
  // session even though nothing is actually wrong.
  assert.deepEqual(result, { records: [], skipped: 0, readable: true });
});

test('readTraceRecords never throws when actions.jsonl exists but is unreadable (permissions), and reports readable: false', async (t) => {
  const dataDir = await tempDataDir();
  t.after(async () => {
    // Restore write/read perms before recursive rm -- an rm that has to
    // descend into a 000-mode file's parent can otherwise fail cleanup.
    await chmod(path.join(dataDir, 'trace-8888888888888', 'actions.jsonl'), 0o600).catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  });
  const sessionDir = path.join(dataDir, 'trace-8888888888888');
  await mkdir(sessionDir);
  const actionsFile = path.join(sessionDir, 'actions.jsonl');
  await writeFile(actionsFile, '{"v":1,"seq":1,"tool":"browser_navigate"}\n');
  await chmod(actionsFile, 0o000);

  const result = await readTraceRecords(sessionDir);
  // EACCES (and every other fs error besides ENOENT) is genuinely unknown,
  // not empty: the file's actual content might hold records this reader
  // just couldn't see this attempt, so it stays readable: false -- pinned
  // distinctly from the ENOENT case above, which now reports readable: true.
  assert.deepEqual(result, { records: [], skipped: 0, readable: false });
});

test('readTraceRecords distinguishes ENOENT (readable: true, honest empty) from EACCES (readable: false, unknown) on otherwise identical sessions', async (t) => {
  const dataDir = await tempDataDir();
  t.after(async () => {
    await chmod(path.join(dataDir, 'trace-7777777777777', 'actions.jsonl'), 0o600).catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  });

  const missingDir = path.join(dataDir, 'trace-6666666666666');
  await mkdir(missingDir);
  const missingResult = await readTraceRecords(missingDir);
  assert.equal(missingResult.readable, true);

  const deniedDir = path.join(dataDir, 'trace-7777777777777');
  await mkdir(deniedDir);
  const actionsFile = path.join(deniedDir, 'actions.jsonl');
  await writeFile(actionsFile, '{"v":1,"seq":1,"tool":"browser_navigate"}\n');
  await chmod(actionsFile, 0o000);
  const deniedResult = await readTraceRecords(deniedDir);
  assert.equal(deniedResult.readable, false);

  // Records/skipped alone can never tell the two apart -- both report the
  // same empty shape -- which is exactly why `readable` has to carry the
  // distinction rather than being inferred from the rest of the result.
  assert.deepEqual(
    { records: missingResult.records, skipped: missingResult.skipped },
    { records: deniedResult.records, skipped: deniedResult.skipped },
  );
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

// --- readTraceRecordsFrom: byte-offset API (WS3b Task 1) ---

test('readTraceRecordsFrom at offset 0 matches readTraceRecords exactly on the same fixture, plus a full-file endByte/lineCount', async () => {
  const whole = await readTraceRecords(basicDir);
  const fromZero = await readTraceRecordsFrom(basicDir, 0);

  assert.deepEqual(
    { records: fromZero.records, skipped: fromZero.skipped, readable: fromZero.readable },
    whole,
  );
  assert.equal(fromZero.lineCount, 6);
  const fileBytes = await readFile(path.join(basicDir, 'actions.jsonl'));
  assert.equal(fromZero.endByte, fileBytes.length);
});

test('readTraceRecordsFrom resuming from a prior endByte yields exactly the appended records', async (t) => {
  const dataDir = await tempDataDir();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const sessionDir = path.join(dataDir, 'trace-1000000000001');
  await mkdir(sessionDir);
  const actionsFile = path.join(sessionDir, 'actions.jsonl');

  await writeFile(
    actionsFile,
    `${JSON.stringify({ v: 1, seq: 1, tool: 'browser_navigate' })}\n`
    + `${JSON.stringify({ v: 1, seq: 2, tool: 'browser_snapshot' })}\n`,
  );

  const first = await readTraceRecordsFrom(sessionDir, 0);
  assert.equal(first.records.length, 2);
  assert.equal(first.lineCount, 2);
  assert.equal(first.readable, true);

  await appendFile(
    actionsFile,
    `${JSON.stringify({ v: 1, seq: 3, tool: 'browser_click' })}\n`
    + `${JSON.stringify({ v: 1, seq: 4, tool: 'browser_fill_form' })}\n`,
  );

  const second = await readTraceRecordsFrom(sessionDir, first.endByte);
  assert.equal(second.records.length, 2);
  assert.deepEqual(second.records.map((record) => record.seq), [3, 4]);
  assert.equal(second.lineCount, 2);
  assert.equal(second.skipped, 0);
  assert.equal(second.readable, true);
  assert.ok(second.endByte > first.endByte);
});

test('readTraceRecordsFrom excludes a trailing partial line (no terminating newline) and stops endByte before it; completing the line and resuming from endByte then yields it', async (t) => {
  const dataDir = await tempDataDir();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const sessionDir = path.join(dataDir, 'trace-1000000000002');
  await mkdir(sessionDir);
  const actionsFile = path.join(sessionDir, 'actions.jsonl');

  const completeLines = `${JSON.stringify({ v: 1, seq: 1, tool: 'browser_navigate' })}\n`
    + `${JSON.stringify({ v: 1, seq: 2, tool: 'browser_snapshot' })}\n`;
  const partialLine = '{"v":1,"seq":3,"tool":"browser_clic'; // mid-append, no trailing newline
  await writeFile(actionsFile, completeLines + partialLine);

  const result = await readTraceRecordsFrom(sessionDir, 0);
  assert.equal(result.records.length, 2);
  assert.equal(result.lineCount, 2);
  assert.equal(result.readable, true);
  // endByte lands exactly at the byte length of the two complete lines --
  // the partial line's bytes are neither parsed nor counted.
  assert.equal(result.endByte, Buffer.byteLength(completeLines, 'utf8'));

  // Complete the partial line (as a real capturing agent would on its next
  // append) and resume from the previously reported endByte.
  const restOfLine3 = 'k","params":{"ref":"e9"}}\n';
  await appendFile(actionsFile, restOfLine3);

  const resumed = await readTraceRecordsFrom(sessionDir, result.endByte);
  assert.equal(resumed.records.length, 1);
  assert.equal(resumed.records[0].seq, 3);
  assert.equal(resumed.records[0].tool, 'browser_click');
  assert.equal(resumed.lineCount, 1);
  assert.equal(resumed.endByte, Buffer.byteLength(completeLines + partialLine + restOfLine3, 'utf8'));
});

test('readTraceRecordsFrom counts a malformed line mid-file toward lineCount and endByte, exactly like readTraceRecords counts it toward skipped', async (t) => {
  const dataDir = await tempDataDir();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const sessionDir = path.join(dataDir, 'trace-1000000000003');
  await mkdir(sessionDir);
  const actionsFile = path.join(sessionDir, 'actions.jsonl');

  await writeFile(
    actionsFile,
    `${JSON.stringify({ v: 1, seq: 1, tool: 'browser_navigate' })}\n`
    + 'not even close to json {{{\n'
    + `${JSON.stringify({ v: 1, seq: 3, tool: 'browser_click' })}\n`,
  );

  const result = await readTraceRecordsFrom(sessionDir, 0);
  assert.equal(result.records.length, 2);
  assert.equal(result.skipped, 1);
  assert.equal(result.lineCount, 3); // skip = consume: the malformed line still counts
  assert.deepEqual(result.records.map((record) => record.seq), [1, 3]);

  const fileBytes = await readFile(actionsFile);
  assert.equal(result.endByte, fileBytes.length);
});

test('readTraceRecordsFrom skips a wrong-version record (v !== 1), counting it toward skipped and lineCount/endByte, same as readTraceRecords', async (t) => {
  const dataDir = await tempDataDir();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const sessionDir = path.join(dataDir, 'trace-1000000000004');
  await mkdir(sessionDir);
  const actionsFile = path.join(sessionDir, 'actions.jsonl');
  const content = `${JSON.stringify({ v: 1, seq: 1, tool: 'browser_navigate' })}\n`
    + `${JSON.stringify({ v: 99, seq: 2, tool: 'browser_click' })}\n`;
  await writeFile(actionsFile, content);

  const result = await readTraceRecordsFrom(sessionDir, 0);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].seq, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.lineCount, 2);
  assert.equal(result.endByte, Buffer.byteLength(content, 'utf8'));
});

test('readTraceRecordsFrom never throws when actions.jsonl is missing: readable: true, endByte unchanged from the requested offset (no rewind)', async (t) => {
  const dataDir = await tempDataDir();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const sessionDir = path.join(dataDir, 'trace-1000000000005');
  await mkdir(sessionDir);

  const atZero = await readTraceRecordsFrom(sessionDir, 0);
  assert.deepEqual(atZero, {
    records: [], skipped: 0, readable: true, endByte: 0, lineCount: 0,
  });

  // A non-zero resume offset against a still-missing file must not be
  // treated as new information to rewind from: endByte echoes the
  // requested offset back unchanged.
  const atNonZero = await readTraceRecordsFrom(sessionDir, 42);
  assert.deepEqual(atNonZero, {
    records: [], skipped: 0, readable: true, endByte: 42, lineCount: 0,
  });
});

test('readTraceRecordsFrom never throws when actions.jsonl exists but is unreadable (permissions): readable: false, endByte unchanged', async (t) => {
  const dataDir = await tempDataDir();
  t.after(async () => {
    await chmod(path.join(dataDir, 'trace-1000000000006', 'actions.jsonl'), 0o600).catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  });
  const sessionDir = path.join(dataDir, 'trace-1000000000006');
  await mkdir(sessionDir);
  const actionsFile = path.join(sessionDir, 'actions.jsonl');
  await writeFile(actionsFile, '{"v":1,"seq":1,"tool":"browser_navigate"}\n');
  await chmod(actionsFile, 0o000);

  const result = await readTraceRecordsFrom(sessionDir, 7);
  assert.deepEqual(result, {
    records: [], skipped: 0, readable: false, endByte: 7, lineCount: 0,
  });
});

test('readTraceRecordsFrom resumes correctly across a multibyte UTF-8 record boundary without corrupting content or splitting mid-character', async (t) => {
  const dataDir = await tempDataDir();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const sessionDir = path.join(dataDir, 'trace-1000000000007');
  await mkdir(sessionDir);
  const actionsFile = path.join(sessionDir, 'actions.jsonl');

  // Each name below is multibyte in UTF-8 (2-, 3-, and 4-byte sequences),
  // so a resume computed from STRING length rather than BYTE length would
  // land on the wrong offset and either corrupt or lose the second record.
  const firstLine = `${JSON.stringify({
    v: 1, seq: 1, tool: 'browser_fill_form', params: { value: 'café 日本語' },
  })}\n`;
  const secondLine = `${JSON.stringify({
    v: 1, seq: 2, tool: 'browser_click', params: { name: 'Place order 🚀' },
  })}\n`;
  await writeFile(actionsFile, firstLine);

  const first = await readTraceRecordsFrom(sessionDir, 0);
  assert.equal(first.records.length, 1);
  assert.equal(first.records[0].params.value, 'café 日本語');
  assert.equal(first.endByte, Buffer.byteLength(firstLine, 'utf8'));
  // The line's byte length must exceed its string (UTF-16 code unit)
  // length -- otherwise this test would not actually exercise byte-vs-
  // string offset arithmetic.
  assert.ok(first.endByte > firstLine.length);

  await appendFile(actionsFile, secondLine);

  const second = await readTraceRecordsFrom(sessionDir, first.endByte);
  assert.equal(second.records.length, 1);
  assert.equal(second.records[0].seq, 2);
  assert.equal(second.records[0].params.name, 'Place order 🚀');
  assert.equal(second.endByte, Buffer.byteLength(firstLine + secondLine, 'utf8'));
});

test('readTraceRecordsFrom given a mid-line byteOffset (not a real endByte -- a corrupted/misused cursor) resyncs at the next newline: the fragment counts toward skipped/lineCount, and the record after it still parses', async (t) => {
  const dataDir = await tempDataDir();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const sessionDir = path.join(dataDir, 'trace-1000000000008');
  await mkdir(sessionDir);
  const actionsFile = path.join(sessionDir, 'actions.jsonl');

  const line1 = `${JSON.stringify({ v: 1, seq: 1, tool: 'browser_navigate' })}\n`;
  const line2 = `${JSON.stringify({ v: 1, seq: 2, tool: 'browser_snapshot' })}\n`;
  const line3 = `${JSON.stringify({ v: 1, seq: 3, tool: 'browser_click' })}\n`;
  await writeFile(actionsFile, line1 + line2 + line3);

  // Deliberately NOT a value this reader ever returned as an endByte --
  // it lands 5 bytes into line2's JSON body, well before line2's own
  // terminating newline, simulating a corrupted/misused caller cursor
  // rather than a legitimate resume point.
  const midLineOffset = Buffer.byteLength(line1, 'utf8') + 5;

  const result = await readTraceRecordsFrom(sessionDir, midLineOffset);

  // The line2 fragment (from midLineOffset to line2's own newline) is not
  // valid JSON on its own and fails JSON.parse -- counted exactly like any
  // other malformed line: skip = consume.
  assert.equal(result.skipped, 1);
  // lineCount: 1 for the fragment, 1 for line3 -- the scan resyncs cleanly
  // at the next real newline (JSONL records never contain a raw 0x0A byte,
  // so the fragment can never itself swallow line3's boundary).
  assert.equal(result.lineCount, 2);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].seq, 3);
  assert.equal(result.readable, true);
  assert.equal(result.endByte, Buffer.byteLength(line1 + line2 + line3, 'utf8'));
});

test('readTraceRecordsFrom with byteOffset past EOF returns no records and echoes the offset back unchanged', async (t) => {
  const dataDir = await tempDataDir();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const sessionDir = path.join(dataDir, 'trace-1000000000009');
  await mkdir(sessionDir);
  const actionsFile = path.join(sessionDir, 'actions.jsonl');
  await writeFile(actionsFile, `${JSON.stringify({ v: 1, seq: 1, tool: 'browser_navigate' })}\n`);

  const fileBytes = await readFile(actionsFile);
  const farOffset = fileBytes.length + 1000;

  const result = await readTraceRecordsFrom(sessionDir, farOffset);
  assert.deepEqual(result, {
    records: [], skipped: 0, readable: true, endByte: farOffset, lineCount: 0,
  });
});

test('readTraceRecordsFrom on an empty (zero-byte) actions.jsonl returns no records, readable: true, endByte 0', async (t) => {
  const dataDir = await tempDataDir();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const sessionDir = path.join(dataDir, 'trace-1000000000010');
  await mkdir(sessionDir);
  await writeFile(path.join(sessionDir, 'actions.jsonl'), '');

  const result = await readTraceRecordsFrom(sessionDir, 0);
  assert.deepEqual(result, {
    records: [], skipped: 0, readable: true, endByte: 0, lineCount: 0,
  });
});

test('readTraceRecordsFrom on a file that is only a partial line (no newline anywhere) returns no records and endByte 0 -- nothing is consumed', async (t) => {
  const dataDir = await tempDataDir();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const sessionDir = path.join(dataDir, 'trace-1000000000011');
  await mkdir(sessionDir);
  await writeFile(path.join(sessionDir, 'actions.jsonl'), '{"v":1,"seq":1,"tool":"browser_na');

  const result = await readTraceRecordsFrom(sessionDir, 0);
  assert.deepEqual(result, {
    records: [], skipped: 0, readable: true, endByte: 0, lineCount: 0,
  });
});

// --- isReplayRecord: shared predicate (WS3b Task 1) ---
//
// Previously three byte-identical copies (lib/flows/sweep.mjs,
// lib/sites/graph.mjs, lib/sites/inventory.mjs), each independently
// pinned only through the behavior of their own callers
// (mineGraphEdges/mineInventory/sweep). This is the first direct pin of
// the predicate itself, now that it has one shared home.

test('isReplayRecord recognizes a flow-runner replay invocation and rejects everything else, without throwing on hostile input', () => {
  assert.equal(
    isReplayRecord({
      tool: 'browser_run_code_unsafe',
      params: { filename: '/macros/flow-runner.js', args: { flow: { name: 'checkout' } } },
    }),
    true,
  );
  // A path prefix before the filename is fine -- only the suffix is checked.
  assert.equal(
    isReplayRecord({
      tool: 'browser_run_code_unsafe',
      params: { filename: '/some/nested/dir/flow-runner.js' },
    }),
    true,
  );

  assert.equal(isReplayRecord({ tool: 'browser_click', params: {} }), false);
  assert.equal(
    isReplayRecord({
      tool: 'browser_run_code_unsafe',
      params: { filename: '/macros/page-recon.js' },
    }),
    false,
  );
  assert.equal(isReplayRecord({ tool: 'browser_run_code_unsafe' }), false);
  assert.equal(isReplayRecord({ tool: 'browser_run_code_unsafe', params: { filename: 42 } }), false);
  assert.equal(isReplayRecord({}), false);
  assert.equal(isReplayRecord(null), false);
  assert.equal(isReplayRecord(undefined), false);
});
