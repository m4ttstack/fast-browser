import crypto from 'node:crypto';
import {
  lstat, readFile, readdir, realpath, rename, unlink, writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { confirmTty } from '../cli/confirm.mjs';
import { assertConfinedPath } from '../core/containment.mjs';
import { ensurePrivateDirectory } from '../core/files.mjs';
import { resolvePaths } from '../core/paths.mjs';
import { parseFlow } from '../flows/artifact.mjs';
import { matchFlows as defaultMatchFlows } from '../flows/match.mjs';
import { sweep as defaultSweep } from '../flows/sweep.mjs';
import { LifecycleError, stripControlChars } from './shared.mjs';

// The `flows` CLI command (WS2a flywheel plan, Task 7): the agent-facing
// surface of the flywheel, and its one consent gate (`approve`). This
// module is a CONSUMER, never a source of truth: flow content comes from
// artifact.mjs's `parseFlow`, matching from match.mjs's `matchFlows`,
// compilation from sweep.mjs's `sweep` -- this file only orchestrates them
// against the two tier directories and renders CLI-shaped reports.
//
// --- tier is directory location, never `flowTier(flow)` (load-bearing) ---
//
// `flowTier` (artifact.mjs) classifies a flow's CONTENT: mutating or
// containing a js step is 'pending' forever, no matter where the file
// lives. APPROVAL is a separate, CLI-owned concept expressed purely by
// which directory a `.flow.json` file sits in -- `flowsDir` means
// approved/ready, `flowsPendingDir` means awaiting `flows approve`. A
// mutating flow that has been approved is still content-"pending" under
// `flowTier`, but it must report `runnable: true` from `flows find` once
// it has been moved into `flowsDir`. `loadTierArtifacts` below is the only
// place tier is assigned, and it always assigns it from the directory
// being read, never by calling `flowTier` on the parsed content. Approving
// is therefore nothing more than `rename(pending path, ready path)` --
// content is never touched, so `flow.id` (which excludes `provenance` but
// hashes everything else) survives approval unchanged.

const SUBCOMMANDS = new Set(['find', 'list', 'compile', 'approve', 'reject']);
const FLOW_RUNNER_FILENAME = 'flow-runner.js';
// Flow names are always kebab-case (artifact.mjs's own NAME_PATTERN); a CLI
// `<name>` argument is user-supplied and used to build a filesystem path
// below, so it is checked against the exact same shape before it ever
// reaches `path.join` -- a name that cannot contain `/` or `.` cannot walk
// out of the tier directories it is joined against.
const FLOW_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function fail(stage, message, exitCode = 1) {
  return new LifecycleError(message, { stage, exitCode });
}

function flowFileNameFor(name) {
  return `${name}.flow.json`;
}

function assertValidFlowName(name) {
  if (typeof name !== 'string' || !FLOW_NAME_PATTERN.test(name)) {
    throw fail('flows-name', 'flow name must be lowercase kebab-case.', 2);
  }
}

// --- fs primitives, injectable per the configure.mjs dependency-injection
// pattern (tests fake these the same way commands.test.mjs fakes
// loadConfig/saveConfig for `configure`). Defaults are the real
// node:fs/promises operations this command needs against the two flow tier
// directories and the rejected-flows ledger. ---

async function defaultListFlowFiles(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return []; // tier dir doesn't exist yet -- nothing stored there
  }
  return names.filter((name) => name.endsWith('.flow.json')).sort();
}

async function defaultReadFlowFile(filePath) {
  return readFile(filePath, 'utf8');
}

// Approval's actual mechanism: a same-filesystem rename, never a
// read-modify-write of the flow's content. `ensurePrivateDirectory` covers
// the first-ever approval, when `flowsDir` may not exist yet (a fresh
// install whose only compiled flows so far were mutating/pending).
async function defaultMoveFlow(fromPath, toPath) {
  await ensurePrivateDirectory(path.dirname(toPath));
  await rename(fromPath, toPath);
}

async function defaultDeleteFlow(filePath) {
  await unlink(filePath);
}

// Fail-closed existence probe (fix round 1, item 3): `lstat` succeeding at
// all -- file, directory, symlink, a file this process cannot itself read
// the CONTENT of -- means "something is there" and must count as a naming
// collision. Only ENOENT means "confirmed absent". Any other stat failure
// (e.g. a parent directory this process cannot search) is NOT read as
// "safe, nothing there" -- it propagates so the caller refuses rather than
// silently proceeding to overwrite/rename over an unverifiable target.
async function defaultPathExists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// Mirrors sweep.mjs's temp+rename+0600 write idiom, extended to
// read-then-append: the rejected-flows ledger accumulates one line per
// rejection over the tool's lifetime, not a single-shot config write. The
// format -- `<name> | <date> | <reason>` -- mirrors
// skills/mine-macros/rejected.md's rejected-macros.md template exactly.
async function defaultAppendRejectedFlow(paths, line) {
  await ensurePrivateDirectory(paths.dataDir);
  let current = '';
  try {
    current = await readFile(paths.rejectedFlowsFile, 'utf8');
  } catch {
    current = '';
  }
  const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n';
  const next = `${current}${separator}${line}\n`;
  const temporary = path.join(
    paths.dataDir,
    `.${path.basename(paths.rejectedFlowsFile)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, next, { mode: 0o600 });
    await rename(temporary, paths.rejectedFlowsFile);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch (cleanupError) {
      if (cleanupError?.code !== 'ENOENT') error.cleanupError = cleanupError;
    }
    throw error;
  }
}

function dependencies(request, supplied) {
  const paths = supplied.paths ?? resolvePaths({
    homeDir: supplied.homeDir,
    pluginRoot: supplied.pluginRoot,
  });
  const input = supplied.input ?? process.stdin;
  const output = supplied.output ?? process.stdout;
  // Matches uninstall.mjs's purge gate: `--json` forces non-interactive
  // regardless of the real terminal, so a scripted/agent invocation can
  // never land on the interactive branch by accident.
  const interactive = (
    request.json !== true
    && (supplied.interactive ?? (input.isTTY === true && output.isTTY === true))
  );
  return {
    paths,
    sweep: supplied.sweep ?? defaultSweep,
    matchFlows: supplied.matchFlows ?? defaultMatchFlows,
    now: supplied.now ?? (() => new Date()),
    listFlowFiles: supplied.listFlowFiles ?? defaultListFlowFiles,
    readFlowFile: supplied.readFlowFile ?? defaultReadFlowFile,
    moveFlow: supplied.moveFlow ?? defaultMoveFlow,
    deleteFlow: supplied.deleteFlow ?? defaultDeleteFlow,
    appendRejectedFlow: supplied.appendRejectedFlow ?? defaultAppendRejectedFlow,
    pathExists: supplied.pathExists ?? defaultPathExists,
    realpath: supplied.realpath ?? realpath,
    // Real containment by default (core/containment.mjs, the same module
    // gif.mjs/annotate.mjs use for their own user-named paths); degrades to
    // a harmless walk-up-to-an-existing-ancestor no-op against a fictional
    // path (a fake test `paths` object), so tests only need to override it
    // when they specifically want to exercise a confinement failure without
    // touching a real filesystem.
    assertConfined: supplied.assertConfined ?? assertConfinedPath,
    interactive,
    print: supplied.print ?? ((line) => output.write(`${line}\n`)),
    confirmApprove: supplied.confirmApprove ?? (() => confirmTty({
      input,
      output,
      createInterface: supplied.createInterface,
      prompt: 'Type APPROVE to move this flow into the ready tier: ',
      expected: 'APPROVE',
    })),
  };
}

// --- artifact loading: the one place tier gets assigned (see the
// module-level "tier is directory location" note) ---

async function loadTierArtifacts(deps, dir, tier) {
  const entries = [];
  const warnings = [];
  const names = await deps.listFlowFiles(dir);
  for (const name of names) {
    const filePath = path.join(dir, name);
    let raw;
    try {
      raw = await deps.readFlowFile(filePath);
    } catch {
      warnings.push({ file: name, tier, reason: 'unreadable' });
      continue;
    }
    let flow;
    try {
      flow = parseFlow(JSON.parse(raw));
    } catch (error) {
      warnings.push({ file: name, tier, reason: `invalid: ${error.message}` });
      continue;
    }
    entries.push({ flow, tier, filePath });
  }
  return { entries, warnings };
}

async function loadAllArtifacts(deps) {
  const ready = await loadTierArtifacts(deps, deps.paths.flowsDir, 'ready');
  const pending = await loadTierArtifacts(deps, deps.paths.flowsPendingDir, 'pending');
  return {
    entries: [...ready.entries, ...pending.entries],
    warnings: [...ready.warnings, ...pending.warnings],
  };
}

// --- find: the ready-to-replay invocation shape (load-bearing) ---
//
// `filename` must be the macros-dir-absolute path to flow-runner.js, never
// inline code: sweep.mjs's replay-provenance detection (`isReplayRecord`)
// keys on `params.filename` ending `flow-runner.js`, and the artifact is
// embedded WHOLE under `args.flow` because a macro sandboxed by
// browser_run_code_unsafe cannot read files off disk to look it up itself.
// Derived from each arg's own `required`/`type` (never a hardcoded
// literal, fix round 1 item 5) so the placeholder can't silently lie as
// the args schema grows past today's single `type: 'string'`.
function argPlaceholder(spec) {
  return `<${spec.required ? 'REQUIRED' : 'OPTIONAL'}: ${spec.type}>`;
}

function buildInvocation(flow, paths) {
  const args = {};
  for (const [name, spec] of Object.entries(flow.args)) {
    args[name] = argPlaceholder(spec);
  }
  return {
    tool: 'browser_run_code_unsafe',
    arguments: {
      filename: path.join(paths.macrosDir, FLOW_RUNNER_FILENAME),
      args: { flow, args },
    },
  };
}

async function find(request, deps) {
  // Compile-on-read: this is what makes capture-to-replay automatic. Every
  // `find` call folds in whatever the agent's own recent sessions just
  // produced before it ever searches, so a flow captured moments ago is
  // immediately a candidate.
  await deps.sweep({ paths: deps.paths, now: deps.now });

  const { entries, warnings } = await loadAllArtifacts(deps);
  const flowEntries = entries.map(({ flow, tier }) => ({ flow, tier }));
  const matches = deps.matchFlows({
    flows: flowEntries,
    origin: request.origin,
    url: request.url,
    intent: request.intent,
  });

  const candidates = matches.map(({ flow, runnable, reasons }) => ({
    name: flow.name,
    description: flow.description,
    origin: flow.origin,
    sideEffects: flow.sideEffects,
    runnable,
    reasons,
    // Present on every candidate, runnable or not -- an agent deciding
    // what to do next needs to see the shape even for a pending/js-step
    // match it cannot run yet; `reasons` is what carries the "why not".
    invocation: buildInvocation(flow, deps.paths),
  }));

  return {
    command: 'flows', sub: 'find', candidates, warnings,
  };
}

// --- list: an inventory of both tiers, no matching, no sweep ---

function tierRank(tier) {
  return tier === 'ready' ? 0 : 1;
}

async function list(request, deps) {
  const { entries } = await loadAllArtifacts(deps);
  const flowList = entries
    .map(({ flow, tier }) => ({
      tier,
      name: flow.name,
      description: flow.description,
      origin: flow.origin,
      health: {
        successRuns: flow.provenance.successRuns,
        failStreak: flow.provenance.failStreak,
      },
    }))
    .sort((a, b) => {
      if (tierRank(a.tier) !== tierRank(b.tier)) return tierRank(a.tier) - tierRank(b.tier);
      if (a.name < b.name) return -1;
      if (a.name > b.name) return 1;
      return 0;
    });
  return { command: 'flows', sub: 'list', flows: flowList };
}

// --- compile: an explicit sweep, reported verbatim ---
//
// `sweep`'s own return shape already distinguishes 'unreadable' sessions
// from 'invalid: <message>' compile skips (sweep.mjs/compile.mjs) -- this
// passes it straight through rather than summarizing, so those reasons
// stay individually visible in the JSON report rather than collapsing into
// a single count.
async function compile(request, deps) {
  const result = await deps.sweep({ paths: deps.paths, now: deps.now });
  return { command: 'flows', sub: 'compile', ...result };
}

// --- approve: the one consent gate in the whole flywheel ---

// Fix round 2, item 1: `assertConfinedPath`'s own containment walk starts
// AT `dataDir` itself (core/containment.mjs's per-component loop begins
// with the empty-string component, i.e. `current = logicalData` on its
// very first iteration) and refuses the FIRST symlink it lstats anywhere
// along the walk -- including that very first hop. A `~/.fast-browser`
// reached through an ancestor symlink (a dotfile-managed home, a relocated
// data dir) is a legitimate, common setup, not an attack: the walk's own
// physical-vs-logical comparison further down already exists to validate
// exactly this case, but the leading lstat throws before that comparison
// is ever reached. Resolving `dataDir` to its real path ONCE, then
// re-rooting `rootDir`/`candidate` onto that same real path (both are
// always literally `dataDir + '/flows[-pending]' + ...` by construction,
// so the relative suffix is unaffected by which dataDir spelling it's
// applied to), makes the walk's first hop a real, non-symlink directory
// while every hop AFTER it -- the tier directory, the candidate file
// itself -- is still walked and lstatted exactly as before. A symlink
// PLANTED anywhere at or below the tier directories is therefore still
// refused; only the ancestor-symlinked root itself is no longer conflated
// with that case.
async function physicalDataDir(deps) {
  try {
    return await deps.realpath(deps.paths.dataDir);
  } catch {
    // Matches containment.mjs's own physicalLocation fallback: a dataDir
    // that doesn't exist yet has no symlink to resolve, so the logical
    // path is already the right thing to hand onward.
    return deps.paths.dataDir;
  }
}

// Confines `candidate` (which must sit under `rootDir`, which must itself
// sit under `deps.paths.dataDir`) and refuses a symlink anywhere along that
// path -- fix round 1 item 2. Reused for both the pending- and ready-side
// paths, and called a second time on each side immediately before the
// rename (the TOCTOU rechecks, item 4 and fix round 2 item 2), so a
// symlink swapped in during the human's think-time at the confirm prompt
// is caught too, not only one present at the initial read.
async function confineOrFail(deps, stage, rootDir, candidate, message) {
  try {
    const logicalDataDir = deps.paths.dataDir;
    const physicalRoot = await physicalDataDir(deps);
    const physicalRootDir = path.join(physicalRoot, path.relative(logicalDataDir, rootDir));
    const physicalCandidate = path.join(physicalRoot, path.relative(logicalDataDir, candidate));
    await deps.assertConfined({
      dataDir: physicalRoot, rootDir: physicalRootDir, candidate: physicalCandidate,
    });
  } catch {
    throw fail(stage, message, 2);
  }
}

// The ready-tier availability check (fix-closed collision probe, fix round
// 1 item 3) -- shared by the initial check (before printing/confirming)
// and the pre-rename recheck (fix round 2 item 2: something could have
// appeared at `readyPath` during the human's think-time at the prompt).
async function assertReadyAvailable(deps, readyPath) {
  await confineOrFail(
    deps, 'flows-approve', deps.paths.flowsDir, readyPath,
    'the ready tier path is not safe to write.',
  );
  let readyExists;
  try {
    readyExists = await deps.pathExists(readyPath);
  } catch {
    throw fail(
      'flows-approve',
      'the ready tier could not be verified for a naming collision.',
      2,
    );
  }
  if (readyExists) {
    throw fail(
      'flows-approve',
      'a flow already exists in the ready tier under that name.',
      2,
    );
  }
}

async function readPendingFlow(deps, pendingPath, stage) {
  let raw;
  try {
    raw = await deps.readFlowFile(pendingPath);
  } catch {
    throw fail(stage, 'no pending flow with that name was found.', 2);
  }
  try {
    return parseFlow(JSON.parse(raw));
  } catch {
    throw fail(stage, 'the pending flow file is invalid and cannot be approved.');
  }
}

async function approve(request, deps) {
  assertValidFlowName(request.name);

  // Checked before any filesystem access: --json or a non-TTY stdin must
  // refuse identically regardless of whether the named flow even exists,
  // so "silent approval" is never reachable through any state combination.
  if (!deps.interactive) {
    throw fail(
      'flows-approve',
      'flows approve requires an interactive terminal; rerun without --json in a TTY.',
      2,
    );
  }

  const pendingPath = path.join(deps.paths.flowsPendingDir, flowFileNameFor(request.name));
  const readyPath = path.join(deps.paths.flowsDir, flowFileNameFor(request.name));

  await confineOrFail(
    deps, 'flows-approve', deps.paths.flowsPendingDir, pendingPath,
    'the pending flow path is not safe to read.',
  );
  const flow = await readPendingFlow(deps, pendingPath, 'flows-approve');

  await assertReadyAvailable(deps, readyPath);

  deps.print(`Flow: ${flow.name}`);
  deps.print(`Origin: ${flow.origin}`);
  deps.print(`Side effects: ${flow.sideEffects}`);
  deps.print(`Steps: ${flow.steps.length}`);
  // Arg NAMES are object keys artifact.mjs's own `parseArgs` accepts
  // unvalidated beyond a bare `__proto__` guard -- unlike `flow.name`
  // (kebab-case-only) or `flow.origin` (a strict URL), an arg name could
  // carry raw terminal-escape bytes, so it is sanitized before it is ever
  // written to the terminal at this consent prompt (fix round 1 item 6).
  const argNames = Object.keys(flow.args).map(stripControlChars);
  deps.print(`Args: ${argNames.length > 0 ? argNames.join(', ') : '(none)'}`);

  const confirmed = await deps.confirmApprove();
  if (!confirmed) {
    throw fail('flows-approve', 'flows approve requires typing APPROVE to confirm.', 2);
  }

  // TOCTOU rechecks (item 4, and fix round 2 item 2): re-confine and
  // re-read the pending file right before the mutating rename, and compare
  // its id against what was shown at the prompt; separately, re-verify the
  // ready tier is still available -- a reviewer reproduced a file
  // appearing at `readyPath` during the prompt, which the ORIGINAL
  // pre-prompt check alone could not catch. A human's think-time at the
  // confirm prompt is an open window on both sides; this closes it against
  // a pending-side content swap, the ready-side collision, and the
  // symlink-swap variant of item 2 (confineOrFail refuses a symlink
  // planted since the first check, on either side).
  await confineOrFail(
    deps, 'flows-approve', deps.paths.flowsPendingDir, pendingPath,
    'the pending flow path is not safe to read.',
  );
  const flowAtApproval = await readPendingFlow(deps, pendingPath, 'flows-approve');
  if (flowAtApproval.id !== flow.id) {
    throw fail('flows-approve', 'flow changed since approval prompt.', 2);
  }
  await assertReadyAvailable(deps, readyPath);

  // Content unchanged: a plain move, never a read-modify-write. See the
  // module-level "tier is directory location" note.
  await deps.moveFlow(pendingPath, readyPath);

  return {
    command: 'flows', sub: 'approve', name: request.name, moved: true,
  };
}

// --- reject: no consent gate (removing a candidate is low-stakes; the
// gate exists to protect against granting replay trust, not against
// discarding one), just delete + ledger ---

async function reject(request, deps) {
  assertValidFlowName(request.name);

  const pendingPath = path.join(deps.paths.flowsPendingDir, flowFileNameFor(request.name));
  await confineOrFail(
    deps, 'flows-reject', deps.paths.flowsPendingDir, pendingPath,
    'the pending flow path is not safe to access.',
  );

  // Fix round 2 item 3: probe existence via `lstat` BEFORE attempting to
  // read content, so the two failure modes get honest, distinct messages
  // instead of collapsing "nothing there" and "something there but
  // unreadable" (a directory, a permission-denied file, a planted entry
  // this process cannot open) into the same "not found". Nothing is
  // unlinked on either error path below.
  let pendingExists;
  try {
    pendingExists = await deps.pathExists(pendingPath);
  } catch {
    throw fail('flows-reject', 'the pending flow path could not be verified.', 2);
  }
  if (!pendingExists) {
    throw fail('flows-reject', 'no pending flow with that name was found.', 2);
  }
  try {
    await deps.readFlowFile(pendingPath);
  } catch {
    throw fail('flows-reject', 'pending flow exists but cannot be read.', 2);
  }

  await deps.deleteFlow(pendingPath);
  const isoDate = deps.now().toISOString().slice(0, 10);
  await deps.appendRejectedFlow(deps.paths, `${request.name} | ${isoDate} | rejected via CLI`);

  return {
    command: 'flows', sub: 'reject', name: request.name, rejected: true,
  };
}

export async function flows(request, supplied = {}) {
  const deps = dependencies(request, supplied);
  if (!SUBCOMMANDS.has(request.sub)) {
    throw fail(
      'flows',
      'flows requires a subcommand of find, list, compile, approve, or reject.',
      2,
    );
  }
  if (request.sub === 'find') return find(request, deps);
  if (request.sub === 'list') return list(request, deps);
  if (request.sub === 'compile') return compile(request, deps);
  if (request.sub === 'approve') return approve(request, deps);
  return reject(request, deps);
}
