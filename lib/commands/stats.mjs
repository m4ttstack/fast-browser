import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { parseFlow } from '../flows/artifact.mjs';
import { QUARANTINE_FAIL_STREAK_THRESHOLD } from '../flows/match.mjs';
import { resolvePaths } from '../core/paths.mjs';
import { LifecycleError } from './shared.mjs';

// The `stats` CLI command (WS4a drift-harness plan, Task 7): a read-only
// surface over sweep's runs ledger (lib/flows/sweep.mjs's `runs.jsonl`
// append -- see that module's own doc comment for the record shape and why
// several outcome values are never emitted yet) plus the two flow-tier
// directories' own on-disk state. This module is a CONSUMER, never a
// source of truth: `quarantined` reuses match.mjs's own
// `QUARANTINE_FAIL_STREAK_THRESHOLD` constant (the exact gate `flows find`
// already scores against) rather than re-deriving a second definition of
// "quarantined", and `flowsHealed` reads the same `provenance.lastHealed`
// field `flows list`'s own `[healed]` marker already surfaces.
//
// No sweep, no writes: unlike `flows find` (which sweeps on every call),
// this command never mutates anything and never triggers a trace sweep --
// it only reads `runs.jsonl` and the two tier directories exactly as they
// stand right now (mirrors sites.mjs's own "no sweep, ever" posture).

function fail(stage, message, exitCode = 1) {
  return new LifecycleError(message, { stage, exitCode });
}

// The full outcome vocabulary sweep.mjs's runs-ledger record shape reserves
// (Shared shapes) -- always present in the returned `outcomes` object, 0
// when unseen, so `stats --json` stays additive-stable regardless of which
// outcomes this particular ledger happens to contain.
const OUTCOME_KEYS = ['clean', 'fallback', 'escalated', 'quirk-recovered', 'healed', 'failed'];
const OUTCOME_KEY_SET = new Set(OUTCOME_KEYS);

function emptyOutcomes() {
  const outcomes = {};
  for (const key of OUTCOME_KEYS) outcomes[key] = 0;
  return outcomes;
}

// --- runs.jsonl: tolerant line-by-line read, ENOENT = empty (Shared shapes) ---
//
// Mirrors trace-reader.mjs's own posture toward its own append-only JSONL
// file: a blank line, an unparseable line, or a parsed value that isn't a
// plain object with a recognised `outcome` is skipped rather than treated
// as a reason to discard the whole ledger -- the ledger is derived,
// best-effort data (sweep.mjs's own doc comment: "losing it loses stats
// only"), so a reader over it inherits the same tolerance. Only a genuine,
// non-ENOENT read fault (permissions, a transient fs error) propagates, so
// `stats` can report it honestly rather than silently claiming an empty
// ledger.
async function readRunRecords(paths, deps) {
  let raw;
  try {
    raw = await deps.readFile(paths.runsFile, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const records = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && OUTCOME_KEY_SET.has(parsed.outcome)
    ) {
      records.push(parsed);
    }
  }
  return records;
}

// --- flow artifacts: both tiers, tolerant of an unreadable/invalid file
// (mirrors lib/commands/flows.mjs's `loadTierArtifacts`, minus the
// `warnings` array that read-only command reports them into -- this
// surface has none of its own to report a per-file skip in, and a
// corrupt/unreadable artifact simply doesn't count toward either total
// below, same as it wouldn't match in `flows find`). ---

async function defaultListFlowFiles(dir) {
  try {
    return await readdir(dir);
  } catch {
    return []; // tier dir doesn't exist yet -- nothing stored there
  }
}

async function defaultReadFlowFile(filePath) {
  return readFile(filePath, 'utf8');
}

async function listTierFlows(dir, deps) {
  const names = await deps.listFlowFiles(dir);
  const flows = [];
  for (const name of names) {
    if (!name.endsWith('.flow.json')) continue;
    try {
      const raw = await deps.readFlowFile(path.join(dir, name));
      flows.push(parseFlow(JSON.parse(raw)));
    } catch {
      // unreadable/invalid: skip -- see the module-level note above.
    }
  }
  return flows;
}

function dependencies(supplied) {
  const paths = supplied.paths ?? resolvePaths({
    homeDir: supplied.homeDir,
    pluginRoot: supplied.pluginRoot,
  });
  return {
    paths,
    readFile: supplied.readFile ?? readFile,
    listFlowFiles: supplied.listFlowFiles ?? defaultListFlowFiles,
    readFlowFile: supplied.readFlowFile ?? defaultReadFlowFile,
  };
}

function rate(count, total) {
  return total === 0 ? 0 : count / total;
}

// stats() -> Shared shapes' stats --json report, plus `command: 'stats'`
// (matching every other command's own report shape). Never sweeps, never
// writes.
export async function stats(request = {}, supplied = {}) {
  const deps = dependencies(supplied);

  let records;
  try {
    records = await readRunRecords(deps.paths, deps);
  } catch {
    throw fail('stats-runs', 'the runs ledger could not be read.', 1);
  }

  const outcomes = emptyOutcomes();
  for (const record of records) outcomes[record.outcome] += 1;
  const replays = records.length;

  let readyFlows;
  let pendingFlows;
  try {
    [readyFlows, pendingFlows] = await Promise.all([
      listTierFlows(deps.paths.flowsDir, deps),
      listTierFlows(deps.paths.flowsPendingDir, deps),
    ]);
  } catch {
    throw fail('stats-flows', 'the flow artifact directories could not be read.', 1);
  }
  const allFlows = [...readyFlows, ...pendingFlows];
  const quarantined = allFlows.filter(
    (flow) => flow.provenance.failStreak >= QUARANTINE_FAIL_STREAK_THRESHOLD,
  ).length;
  const flowsHealed = allFlows.filter((flow) => flow.provenance.lastHealed !== null).length;

  return {
    command: 'stats',
    replays,
    outcomes,
    healRate: rate(outcomes.healed, replays),
    cleanRate: rate(outcomes.clean, replays),
    quarantined,
    flowsHealed,
  };
}
