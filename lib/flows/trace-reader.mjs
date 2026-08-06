import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

// The trace format's own schema version (TRACE.md, TRACE_SCHEMA_VERSION).
// Every record in a schema-1 trace carries `v: 1` individually; a record
// whose `v` disagrees is a wrong-version record, not a parse failure, and
// is skipped rather than trusted.
const TRACE_SCHEMA_VERSION = 1;

// TraceLog.create names each session directory `trace-<epochMs>` (TRACE.md,
// "Directory layout"). Anything else under dataDir -- other files, other
// prefixes -- isn't a trace session and is ignored.
const TRACE_DIR_PATTERN = /^trace-(\d+)$/;

// A truncation marker is any of the three shapes traceLog.ts can emit in
// place of an oversized value (TRACE.md, "Truncation"): the array-element
// marker ({ __truncated__, omittedElements, sizeBytes }), the
// object-collapse marker ({ __truncated__, sizeBytes }), and the cycle
// marker ({ __truncated__ } alone). All three share the one structurally
// load-bearing key, so a reader only needs to check that key rather than
// reimplement the marker-shape taxonomy.
export function isTruncationMarker(value) {
  return (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && value.__truncated__ === true
  );
}

// Strips a trailing truncation marker from an array field (network,
// targets, code, script.actions), per TRACE.md's "arrays keep their type"
// rule: elements are always dropped from the end, so the kept portion is
// always a prefix and the marker (if present) is always the last element.
//
// Also tolerates the field itself having collapsed to a bare marker object
// -- the shape a whole compound value (e.g. `script`) takes when even its
// shrunk-down form doesn't fit its budget -- by reporting truncated with no
// items, rather than throwing on `.slice is not a function`. Anything else
// (missing field, unexpected type) degrades to an untruncated empty array:
// this reader must never throw on hostile input.
export function cleanArray(arrayField) {
  if (Array.isArray(arrayField)) {
    const last = arrayField[arrayField.length - 1];
    if (arrayField.length > 0 && isTruncationMarker(last)) {
      return { items: arrayField.slice(0, -1), truncated: true };
    }
    return { items: arrayField.slice(), truncated: false };
  }
  if (isTruncationMarker(arrayField)) {
    return { items: [], truncated: true };
  }
  return { items: [], truncated: false };
}

// actions.jsonl is one JSON object per appended line, written durably
// line-by-line (fs.appendFileSync at write time -- TRACE.md, "actions.jsonl").
// The repo has no streaming-JSONL precedent elsewhere, and TRACE.md's 64 KiB
// per-value truncation budget keeps any one line bounded, so a plain
// readFile + subarray-from-offset + per-line JSON.parse is both simpler and
// sufficient here; a streaming parser would only pay for itself against a
// file too large to buffer whole, which the truncation rules rule out by
// construction. (WS3b Task 1: this used to be a plain readFile + `.split('\n')`
// over a decoded string; it now reads the raw Buffer and scans for the `\n`
// byte itself -- see the byte-vs-string note below -- but the "buffer the
// whole file" posture is unchanged and rests on the same truncation-bound
// reasoning.)
//
// `readTraceRecordsFrom(sessionDir, byteOffset)` is the byte-offset primitive
// a repeated sweep resumes from (WS3b Task 2 threads the cursor through);
// `readTraceRecords` is just its offset-0 call, kept as a separate export
// because most callers (and every existing pin below) only ever want "read
// the whole session" and have no cursor of their own to pass.
export async function readTraceRecordsFrom(sessionDir, byteOffset) {
  let buffer;
  try {
    buffer = await readFile(path.join(sessionDir, 'actions.jsonl'));
  } catch (error) {
    // Missing/unreadable actions.jsonl is hostile input, not a bug in the
    // caller: report an empty, unremarkable session instead of throwing.
    // Two fs failures land here, and they are NOT the same thing:
    //
    // - ENOENT (no actions.jsonl at all) is an honest empty session -- a
    //   session directory whose meta.json exists (or is about to) but
    //   whose capturing agent hasn't appended a first action yet, or never
    //   will (a meta-only live session with zero actions). There is
    //   nothing to distrust here: the file simply doesn't exist yet, which
    //   is exactly what a brand-new session looks like. Reporting this as
    //   `readable: false` (as this reader used to, folding ENOENT into
    //   "any fs error") made every sweep of such a session report
    //   'unreadable' (lib/flows/sweep.mjs's N1 handling) even though
    //   nothing is actually wrong -- a false alarm repeated on every
    //   sweep for as long as the session stays meta-only. So ENOENT
    //   specifically reports `readable: true, records: []`, same as a
    //   file that exists but is empty or all-garbage.
    // - Every OTHER fs error (EACCES, EISDIR, a transient I/O fault, ...)
    //   means the file's actual state is UNKNOWN -- it may hold records
    //   this reader simply couldn't see this attempt. `readable: false`
    //   distinguishes THIS from a genuinely empty read. A caller doing
    //   incremental bookkeeping off this result (lib/flows/sweep.mjs)
    //   needs that distinction: a transient/permissions read fault must
    //   never be treated as "nothing happened in this session yet," since
    //   sweep.mjs would otherwise rewind that session's cursor to zero and
    //   re-count provenance it had already applied once the file becomes
    //   readable again.
    //
    // Either way, nothing was actually consumed this call: `endByte` echoes
    // `byteOffset` back unchanged (never rewinds a caller's cursor to 0 or
    // anywhere else) and `lineCount` is 0.
    if (error?.code === 'ENOENT') {
      return {
        records: [], skipped: 0, readable: true, endByte: byteOffset, lineCount: 0,
      };
    }
    return {
      records: [], skipped: 0, readable: false, endByte: byteOffset, lineCount: 0,
    };
  }

  const records = [];
  let skipped = 0;
  let lineCount = 0;
  let pos = byteOffset;
  let endByte = byteOffset;

  // Scan for the line-separator BYTE (0x0A) directly on the Buffer, before
  // any utf8 decoding -- byte offsets are Buffer offsets (TRACE.md's
  // per-line append boundary), not string/UTF-16 indices, and a resume
  // point computed from decoded string length would drift and corrupt (or
  // split) any line containing multibyte characters. Scanning for 0x0A on
  // the raw bytes first is safe: it's ASCII newline, a single byte that can
  // never occur as a continuation byte (0x80-0xFF) inside a multibyte UTF-8
  // sequence, so it only ever matches a genuine line break. Buffer#indexOf
  // returns -1 (never throws) once `pos` runs past `buffer.length`, which
  // is exactly the "nothing new to read" steady state of a resume call
  // that's already caught up to the last sweep's endByte.
  for (;;) {
    const newlineIndex = buffer.indexOf(0x0a, pos);
    if (newlineIndex === -1) break; // trailing partial line: mid-append, not parsed, not consumed

    const lineBytes = buffer.subarray(pos, newlineIndex);
    pos = newlineIndex + 1;
    endByte = pos;
    lineCount += 1;

    const line = lineBytes.toString('utf8');
    if (line.trim() === '') continue; // blank line: consumed, same as readTraceRecords, never counted skipped

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }

    const isRecord = (
      typeof parsed === 'object'
      && parsed !== null
      && !Array.isArray(parsed)
      && parsed.v === TRACE_SCHEMA_VERSION
    );
    if (isRecord) {
      // Pushed verbatim: only `v` is checked here (the field the version
      // gate reads). Every other field -- known or not -- passes through
      // untouched for the caller to inspect with its own shape checks.
      records.push(parsed);
    } else {
      skipped += 1;
    }
  }
  return {
    records, skipped, readable: true, endByte, lineCount,
  };
}

export async function readTraceRecords(sessionDir) {
  const { records, skipped, readable } = await readTraceRecordsFrom(sessionDir, 0);
  return { records, skipped, readable };
}

// Shared by lib/flows/sweep.mjs, lib/sites/graph.mjs, and
// lib/sites/inventory.mjs (WS3b Task 1 -- previously three independently
// pinned copies). A replay record is one where an agent invoked the flow
// runner macro: `tool === 'browser_run_code_unsafe'` whose
// `params.filename` is a string ending `flow-runner.js` (the WS2a
// contract). Every field access is optional-chained so a hostile or
// missing record degrades to `false` rather than throwing, matching this
// module's own never-throw-on-hostile-input contract for trace records.
const FLOW_RUNNER_SUFFIX = 'flow-runner.js';

export function isReplayRecord(record) {
  return (
    record?.tool === 'browser_run_code_unsafe'
    && typeof record?.params?.filename === 'string'
    && record.params.filename.endsWith(FLOW_RUNNER_SUFFIX)
  );
}

// Scans dataDir for trace-<epochMs> children -- the shape TraceLog.create
// writes, one per client connection (TRACE.md, "Directory layout"). Every
// matching directory is listed even when its meta.json can't be read: a
// missing/corrupt meta.json describes a capture-time failure in that one
// file, not a reason to hide a session whose actions.jsonl may still be
// perfectly readable.
export async function listTraceSessions(dataDir) {
  let entries;
  try {
    entries = await readdir(dataDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const sessions = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = TRACE_DIR_PATTERN.exec(entry.name);
    if (!match) continue;

    const dir = path.join(dataDir, entry.name);
    let meta = null;
    try {
      const parsed = JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8'));
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        meta = parsed;
      }
    } catch {
      // Missing or unparseable meta.json: the session still gets listed,
      // just with meta: null.
    }

    sessions.push({ dir, epochMs: Number(match[1]), meta });
  }

  sessions.sort((left, right) => left.epochMs - right.epochMs);
  return sessions;
}
