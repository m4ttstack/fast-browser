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
// readFile + split + per-line JSON.parse is both simpler and sufficient
// here; a streaming parser would only pay for itself against a file too
// large to buffer whole, which the truncation rules rule out by
// construction.
export async function readTraceRecords(sessionDir) {
  let contents;
  try {
    contents = await readFile(path.join(sessionDir, 'actions.jsonl'), 'utf8');
  } catch {
    // Missing/unreadable actions.jsonl is hostile input, not a bug in the
    // caller: report an empty, unremarkable session instead of throwing.
    return { records: [], skipped: 0 };
  }

  const records = [];
  let skipped = 0;
  for (const line of contents.split('\n')) {
    if (line.trim() === '') continue;

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
  return { records, skipped };
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
