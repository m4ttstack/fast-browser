import path from 'node:path';

import { annotate } from '../commands/annotate.mjs';
import { configure } from '../commands/configure.mjs';
import { doctor } from '../commands/doctor.mjs';
import { flows } from '../commands/flows.mjs';
import { gif } from '../commands/gif.mjs';
import { migrate } from '../commands/migrate.mjs';
import { registry } from '../commands/registry.mjs';
import { setup } from '../commands/setup.mjs';
import { stripControlChars } from '../commands/shared.mjs';
import { sites } from '../commands/sites.mjs';
import { stats } from '../commands/stats.mjs';
import { uninstall } from '../commands/uninstall.mjs';
import { isDirectoryOnPath } from '../core/launcher.mjs';

const VERSION = '0.1.0-alpha.1';
const HELP = [
  'Usage: fast-browser <setup|doctor|configure|migrate|uninstall|annotate|gif|flows|sites|stats|registry> [options]',
  'flows subcommands: find|list|compile|approve|reject',
  'sites subcommands: show|affordances|digest|quirk',
  'registry subcommands: init|push|pull|search|status',
  'Run `fast-browser <command> --help` for command options.',
].join('\n');

const HOST_NAMES = {
  claude: 'Claude Code',
  codex: 'Codex',
};

function stdout(text) {
  process.stdout.write(text);
}

function safeFailure(error) {
  if (
    error?.name === 'LifecycleError'
    || error?.name === 'UsageError'
    || error?.name === 'PairingError'
    || error?.name === 'MigrationError'
  ) return error;
  const wrapped = new Error('The command failed without exposing external diagnostics.');
  wrapped.name = 'LifecycleError';
  wrapped.exitCode = 1;
  return wrapped;
}

function humanSetup(report, env) {
  const hosts = report.hosts.map((host) => HOST_NAMES[host]).join(', ');
  const lines = [
    `Fast Browser is configured for: ${hosts}`,
    `Profile: ${report.profile}`,
  ];
  if (report.extensionManual && report.extensionAction === 'reload') {
    // Upgrades never move the install directory, so Chrome is already loading
    // the right path and just needs to re-read it. Saying "manual
    // installation required" here would send the user back through remove and
    // Load unpacked, which is what discards the extension's stored reconnect
    // token and forces re-pairing.
    lines.push(
      'Chrome extension: reload required in chrome://extensions',
      'Next: click the reload arrow on Fast Browser, then run `fast-browser doctor`',
    );
  } else if (report.extensionManual) {
    lines.push(
      `Chrome extension: manual installation required at ${report.extensionPath}`,
      'Next: load the extension, then run `fast-browser doctor`',
    );
  } else {
    lines.push('Chrome extension: already configured');
  }
  // Profile names are our own two literals, so this note echoes nothing.
  // A profile change resets session recording and retention to the new
  // profile's defaults by design; being the one deliberate rewrite left on
  // the reinstall path, it is the one that must be announced.
  if (report.previousProfile) {
    lines.push(
      `Note: profile changed from ${report.previousProfile} to ${report.profile};`
      + ' session recording and retention now follow the new profile\'s defaults.',
    );
  }
  // Fixed, non-echoing notice: no paths, no digests, no user data. Printed
  // only when setup replaced an install it could not verify (a legacy
  // marker predating content-digest verification), so the user knows their
  // prior, unverifiable bytes were not silently trusted.
  if (report.unverifiedArtifactsReplaced) {
    lines.push('Note: a previously unverifiable install was replaced with a freshly verified one.');
  }
  // A macro-only release puts a built-in on the machine that was never there
  // before, which is a new executable file in the user's macros directory.
  // Setup already counts it towards `changed`, so leaving it out here printed
  // a run that claims to have changed something and then names nothing.
  const installed = report.macros?.installed?.length ?? 0;
  if (installed > 0) {
    lines.push(
      `Note: ${installed} built-in macro ${installed === 1 ? 'entry was' : 'entries were'}`
      + ' newly installed; rerun with --json for details.',
    );
  }
  // Replacing code the user is about to run, under a name they already know,
  // is not something to do quietly, and a rerun that reports nothing but
  // "already configured" is how the last stale built-in survived unnoticed.
  const refreshed = report.macros?.refreshed?.length ?? 0;
  if (refreshed > 0) {
    lines.push(
      `Note: ${refreshed} built-in macro ${refreshed === 1 ? 'entry was' : 'entries were'}`
      + ' refreshed to the shipped version; rerun with --json for details.',
    );
  }
  // Count only, no names: setup refreshes built-ins it recognises as its own
  // and keeps everything else, so the one thing the user has to know is that
  // some of their macros are deliberately not current.
  //
  // Deliberately not called "edited". Preserving proves only that the bytes on
  // disk match no version this project published, and an install made from a
  // working tree between releases holds exactly such bytes without anyone
  // having touched them. Those two cases are indistinguishable from here and
  // have the same remedy, so the wording states the evidence and names the
  // remedy rather than asserting a cause the installer cannot know.
  const preserved = report.macros?.preserved?.length ?? 0;
  if (preserved > 0) {
    const one = preserved === 1;
    lines.push(
      `Note: ${preserved} built-in macro ${one ? 'entry was' : 'entries were'} kept as-is;`
      + ` ${one ? 'its' : 'their'} bytes match no version this project shipped,`
      + ` so ${one ? 'it' : 'they'} will never be refreshed.`,
      `If you did not edit ${one ? 'it' : 'them'}, delete ${one ? 'it' : 'them'} and rerun setup`
      + ' to adopt the current version; rerun with --json for names.',
    );
  }
  // Setup only ever adopts a launcher path holding its own marked shim, so a
  // preserved file means the documented bare `fast-browser` commands may
  // still resolve to something unrelated. Fixed wording, no path echoed: the
  // JSON report carries the location.
  if (report.launcher?.action === 'preserved') {
    lines.push(
      'Note: an existing fast-browser command was left untouched;'
      + ' delete it and rerun setup to adopt the managed launcher.',
    );
  }
  // The literal $HOME keeps the line copy-pasteable into any shell profile
  // and keeps the user's expanded home directory out of the output.
  if (
    report.launcher?.path
    && !isDirectoryOnPath(path.dirname(report.launcher.path), env?.PATH ?? '')
  ) {
    lines.push(
      'Note: add export PATH="$HOME/.local/bin:$PATH" to your shell profile'
      + ' so the fast-browser command is found.',
    );
  }
  return `${lines.join('\n')}\n`;
}

function humanDoctor(report) {
  const lines = report.checks.map((check) => (
    `${check.status.toUpperCase()} ${check.id}: ${check.message}`
  ));
  lines.push(report.ok ? 'Fast Browser doctor passed.' : 'Fast Browser doctor found failures.');
  return `${lines.join('\n')}\n`;
}

// Fixed, count-only line for human mode. Never names a key, a command, an
// env key name, or any value: those only ever appear in the JSON report.
function unmanagedCandidatesWarning(candidates) {
  const count = Array.isArray(candidates) ? candidates.length : 0;
  if (count === 0) return '';
  const verb = count === 1 ? 'was' : 'were';
  const noun = count === 1 ? 'entry' : 'entries';
  return `Warning: ${count} unmanaged Playwright-looking MCP ${noun} ${verb} left untouched;`
    + ' rerun with --json for details.\n';
}

// WS3b Task 7 / WS4a Task 7: the encoder degrade rule's one visible human
// surface -- shared verbatim by `flows find` (its own rerank stage) and
// `flows compile` (sweep's heal-path ranker, WS4a Task 7's `warnings`
// addition to sweep.mjs's report) so there is exactly one rendering of a
// `{ kind: 'encoder-degraded', reason }` entry across both call sites,
// rather than two independently maintained copies of the same line.
// `reason` is mostly encoder.mjs's own fixed, internal diagnostic strings,
// but NOT uniformly so (fix round 2 review, Folded Minor b): a
// malformed-JSON failure's message can embed a snippet of the actual server
// response body -- server-derived, not this module's own literal -- so it
// is stripped here rather than trusted verbatim.
function encoderDegradedWarningLines(warnings) {
  return warnings
    .filter((warning) => warning.kind === 'encoder-degraded')
    .map((warning) => `Warning: ranking fell back to lexical order - ${stripControlChars(warning.reason)}`);
}

// `description` traces back to page-derived/agent-captured content that
// artifact.mjs stores as a free-form string, so it is sanitized before it
// reaches the terminal here (fix round 1, item 6) the same way approve's
// arg-name printing is.
function humanFlowsFind(report) {
  const lines = report.candidates.length === 0
    ? ['No matching flows found.']
    : report.candidates.map((candidate) => {
      const status = candidate.runnable ? 'runnable' : 'not runnable';
      const reasonSuffix = candidate.reasons.length > 0 ? ` (${candidate.reasons.join('; ')})` : '';
      const description = stripControlChars(candidate.description);
      // WS3a Task 4: mentioned only when the origin actually has quirks to
      // embed -- the count is structural (a plain integer, never free text
      // read off a page), so it needs no stripControlChars pass of its own.
      // `?? 0` degrades gracefully rather than throwing if a report ever
      // reaches here without the (always-present-in-practice) `quirks` key.
      const quirkCount = candidate.invocation.arguments.args.quirks?.length ?? 0;
      const quirkSuffix = quirkCount > 0 ? ` [quirks: ${quirkCount}]` : '';
      return `${candidate.name} [${status}] ${candidate.origin} - ${description}${reasonSuffix}${quirkSuffix}`;
    });
  // `warnings` used to be --json-only; a human running `flows find`
  // interactively has no other way to learn an artifact file failed to
  // load at all (fix round 1, item 6). WS3a Task 4 added a second warning
  // `kind` ('quirks-dropped') to the same array -- it must be reported on
  // its own, never folded into "N flow artifact files could not be
  // loaded": that count is a load FAILURE, a quirk-drop is neither a
  // failure nor about a file at all, and conflating the two would have the
  // CLI falsely claim artifact files failed to load whenever an origin
  // simply had more than 10 stored quirks.
  const artifactWarnings = report.warnings.filter((warning) => warning.kind === 'artifact-load');
  if (artifactWarnings.length > 0) {
    const count = artifactWarnings.length;
    lines.push(
      `Warning: ${count} flow artifact file${count === 1 ? '' : 's'} could not be loaded; `
      + 'rerun with --json for details.',
    );
  }
  const quirkWarnings = report.warnings.filter((warning) => warning.kind === 'quirks-dropped');
  for (const warning of quirkWarnings) {
    // `origin` is `flow.origin`, artifact.mjs's own strictly-validated bare
    // http(s) origin (no path/query/control chars possible by construction,
    // same trust level the candidate line above already gives it) -- so,
    // like that line, it is printed without a stripControlChars pass.
    lines.push(`Warning: ${warning.origin} - ${warning.reason}`);
  }
  // WS3b Task 7: the encoder degrade rule's one visible surface -- find
  // never fails because Voyage is down, but a human running interactively
  // still deserves to know the ranking they're looking at fell back to
  // lexical order this call.
  lines.push(...encoderDegradedWarningLines(report.warnings));
  return `${lines.join('\n')}\n`;
}

function humanFlowsList(report) {
  if (report.flows.length === 0) return 'No flows recorded yet.\n';
  const lines = report.flows.map((flow) => {
    // WS3a Task 7: a heal rewrites this flow with no consent gate (heals
    // never re-enter `approve`), so a human running `flows list`
    // interactively needs at least this one marker -- matches
    // humanFlowsFind's own bracket-suffix convention (`[quirks: N]`) rather
    // than growing a new rendering style. `lastHealed` absent/null (every
    // never-healed flow, and every report predating this task) prints
    // nothing extra.
    const healedSuffix = flow.lastHealed ? ' [healed]' : '';
    return `${flow.name} [${flow.tier}] ${flow.origin} - `
      + `successRuns=${flow.health.successRuns} failStreak=${flow.health.failStreak}${healedSuffix}`;
  });
  return `${lines.join('\n')}\n`;
}

// Task 8 (folded MAT-136 debt #3): a flat "N segments skipped, rerun with
// --json" line was the whole story before this -- true, but it buries three
// very different situations under one count. `skippedBySession`'s reasons
// (sweep.mjs's 'unreadable'; compile.mjs's 'invalid: <message>',
// 'unsupported: <tool>', 'too-short', 'error-truncated') fall into three
// classes a human running this interactively actually needs to react to
// differently:
//
// - 'unreadable' -- an operational fault (permissions, a transient fs
//   error), not a trace-content problem; sweep.mjs left that session
//   COMPLETELY unprocessed (module doc comment's N1 note). This is the one
//   that needs a human to go fix something before the next sweep can make
//   progress on that session at all, so it's called out loudly, by name,
//   ahead of everything else.
// - 'invalid: ...' / 'unsupported: ...' -- a specific, diagnosable defect
//   in ONE segment of an otherwise-readable trace (a malformed record, a
//   tool this compiler doesn't support yet). The message itself is the
//   useful part, so each one is listed individually with its session and
//   seqRange rather than folded into a count.
// - 'too-short' / 'error-truncated' -- expected, routine noise (a
//   too-brief segment, a segment an error record cut short); individually
//   they carry no diagnostic content beyond "this didn't become a flow",
//   so they're rolled up into a per-session count instead of one line each.
function humanFlowsCompile(report) {
  const lines = [
    `Compiled ${report.compiled.length} new flow(s); updated ${report.updated.length}; `
    + `sessions processed: ${report.sessionsProcessed}; replays seen: ${report.replaysSeen}.`,
  ];

  // WS3a Task 7: until now a heal rewrote a ready-tier artifact with no
  // human-visible signal outside --json, and heals never re-enter the
  // `approve` consent gate -- this is the CLI's one guaranteed surface for
  // that. Exact pinned format (test asserts the literal line). `?? []`
  // covers reports predating Task 6 (sweep's own `healed` field), matching
  // this function's report-shape tolerance elsewhere. `kind` is one of
  // heal.mjs's own fixed set ('testid', 'other' -- see its DEVIATION note),
  // never page-derived text, so it prints verbatim; `name` is `flow.name`,
  // already NAME_PATTERN-validated kebab-case like every other flow name
  // this file prints unstripped (humanFlowsFind, humanFlowsList).
  const healed = report.healed ?? [];
  for (const heal of healed) {
    lines.push(`healed ${heal.name} step ${heal.stepIndex} (${heal.kind})`);
  }

  // A heal-WRITE failure is the same visibility gap as a healed step itself
  // (sweep.mjs's own doc comment: `healErrors` accumulates and the sweep
  // continues rather than failing) -- styled like this file's other warning
  // lines. `error` is `error?.message ?? String(error)` from sweep.mjs's own
  // write-failure catch, an internal diagnostic rather than page-derived
  // text, so -- like the `reason` strings in the skip block below -- it
  // prints without a stripControlChars pass.
  const healErrors = report.healErrors ?? [];
  for (const healError of healErrors) {
    lines.push(`Warning: heal failed for ${healError.name}: ${healError.error}`);
  }

  // WS4a Task 7: the runs-ledger append is contained exactly like a heal
  // write failure (sweep.mjs's own doc comment: "mirrors healErrors's own
  // containment posture") -- same treatment here, `?? []` covering reports
  // from before this task the same way `healed ?? []` above does.
  const runsErrors = report.runsErrors ?? [];
  for (const runsError of runsErrors) {
    lines.push(`Warning: runs ledger append failed for ${runsError.sessionDir}: ${runsError.error}`);
  }

  // WS4a Task 7: sweep's own heal-path ranker can degrade to lexical the
  // same way `flows find`'s rerank stage already can (sweep.mjs's
  // `warningTrackingRanker`) -- rendered with the exact same shared line as
  // that surface (`encoderDegradedWarningLines` above). `?? []` covers
  // reports predating this task, matching this function's report-shape
  // tolerance elsewhere.
  lines.push(...encoderDegradedWarningLines(report.warnings ?? []));

  const bySession = Object.entries(report.skippedBySession);
  const totalSkipped = bySession.reduce((sum, [, entries]) => sum + entries.length, 0);
  if (totalSkipped === 0) return `${lines.join('\n')}\n`;

  lines.push(`Skipped ${totalSkipped} segment(s) across ${bySession.length} session(s).`);

  const unreadableSessions = [];
  const individual = [];
  const countedBySession = new Map();

  for (const [basename, entries] of bySession) {
    for (const entry of entries) {
      if (entry.reason === 'unreadable') {
        unreadableSessions.push(basename);
      } else if (entry.reason === 'too-short' || entry.reason === 'error-truncated') {
        countedBySession.set(basename, (countedBySession.get(basename) ?? 0) + 1);
      } else {
        individual.push({ basename, reason: entry.reason, seqRange: entry.seqRange });
      }
    }
  }

  if (unreadableSessions.length > 0) {
    lines.push(`UNREADABLE -- needs attention: ${unreadableSessions.join(', ')}`);
  }
  for (const { basename, reason, seqRange } of individual) {
    lines.push(`${reason} (${basename}, seq ${seqRange[0]}-${seqRange[1]})`);
  }
  for (const [basename, count] of countedBySession) {
    lines.push(`${count} too-short/error-truncated skip(s) in ${basename}`);
  }

  lines.push('Rerun with --json for full details.');
  return `${lines.join('\n')}\n`;
}

function humanFlows(report) {
  if (report.sub === 'find') return humanFlowsFind(report);
  if (report.sub === 'list') return humanFlowsList(report);
  if (report.sub === 'compile') return humanFlowsCompile(report);
  if (report.sub === 'approve') return `Approved ${report.name}; moved to the ready tier.\n`;
  if (report.sub === 'reject') return `Rejected ${report.name}; recorded in the rejected-flows ledger.\n`;
  return '';
}

// `sites show`'s human arm: a short route table (pattern + mined target
// COUNT only, never the target names themselves -- those can be page-
// derived free text) plus quirk/digest counts. Every free-text field
// (origin, pattern) passes stripControlChars even though canonicalization
// already restricts it to a plain http(s) origin/path -- belt and
// suspenders, matching the contract's "all free text through
// stripControlChars".
function humanSitesShow(report) {
  const lines = [`Site: ${stripControlChars(report.origin)}`];
  if (report.patterns.length === 0) {
    lines.push('No mined routes yet.');
  } else {
    for (const entry of report.patterns) {
      const count = entry.targets.length;
      lines.push(`${stripControlChars(entry.pattern)} - ${count} target${count === 1 ? '' : 's'}`);
    }
  }
  const staleCount = report.digests.filter((digest) => digest.stale).length;
  lines.push(`Quirks: ${report.quirks.length}`);
  lines.push(`Digests: ${report.digests.length} (${staleCount} stale)`);
  return `${lines.join('\n')}\n`;
}

// Unlike `show`, `affordances` is specifically about surfacing the actual
// affordances an agent could act on, so its human arm lists each mined
// target's role/name rather than just a count. Targets are page-derived
// (an accessible name can carry anything, including raw terminal escapes),
// so every one passes stripControlChars before it is ever printed.
//
// `savedAt` passes stripControlChars too (fix round 1, I2): it is stored
// from `deps.now().toISOString()` in the normal path, but a digest FILE
// itself is not re-validated byte-for-byte on read beyond store.mjs's own
// `isoString` check, which only requires `Date.parse` to succeed --
// V8's date parser accepts (and ignores) parenthesized trailing text, so a
// value like `2026-08-05T00:00:00.000Z(\x1b[31m)` parses fine while still
// carrying a raw escape byte through to this, the one field that used to
// reach the terminal unsanitized.
function humanSitesAffordances(report) {
  const lines = [`Pattern: ${stripControlChars(report.pattern)}`];
  lines.push(report.found
    ? `Digest: saved ${stripControlChars(report.savedAt)}${report.stale ? ' (stale)' : ''}`
    : 'Digest: none saved yet.');
  if (report.inventory.length === 0) {
    lines.push('Mined inventory: none yet.');
  } else {
    for (const target of report.inventory) {
      lines.push(`- ${stripControlChars(target.role)} ${stripControlChars(target.name)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function humanSitesDigest(report) {
  return `Saved digest for ${stripControlChars(report.pattern)}.\n`;
}

function humanSitesQuirk(report) {
  if (report.verb === 'add') {
    return `Added quirk ${stripControlChars(report.name)} for ${stripControlChars(report.origin)}.\n`;
  }
  if (report.verb === 'remove') {
    return `Removed quirk ${stripControlChars(report.name)}.\n`;
  }
  if (report.quirks.length === 0) return 'No quirks recorded yet.\n';
  const lines = report.quirks.map((entry) => {
    const detail = entry.target.description ?? entry.target.locators[0]?.selector ?? '';
    return `${stripControlChars(entry.name)} - ${stripControlChars(detail)}`;
  });
  return `${lines.join('\n')}\n`;
}

function humanSites(report) {
  if (report.sub === 'show') return humanSitesShow(report);
  if (report.sub === 'affordances') return humanSitesAffordances(report);
  if (report.sub === 'digest') return humanSitesDigest(report);
  if (report.sub === 'quirk') return humanSitesQuirk(report);
  return '';
}

// `stats`'s human arm (WS4a Task 7): every field here is either a plain
// integer or a 0-1 rate this module itself computed (lib/commands/stats.mjs),
// never page-derived text -- no stripControlChars pass needed, unlike the
// flows/sites renderers above.
//
// Review round 1, Important 1: the human breakdown line prints ONLY the
// three outcomes sweep.mjs can actually emit today (`clean`/`healed`/
// `failed` -- see that module's own doc comment for why
// `fallback`/`escalated`/`quirk-recovered` are reserved-but-unreachable).
// Printing all six with the unreachable three pinned at 0 read as "did not
// happen this period", indistinguishable from "cannot happen yet" -- a
// human running this interactively has no way to tell those apart from the
// human arm alone. `--json` is unaffected: `report.outcomes` still carries
// all six keys (additive-stable, per the Shared shapes), so a caller doing
// its own aggregation across periods -- or a future runtime release that
// starts populating the other three -- reads them from there, not from
// this line.
function humanStats(report) {
  const { outcomes } = report;
  const lines = [
    `Replays: ${report.replays} (clean ${outcomes.clean}, healed ${outcomes.healed}, `
      + `failed ${outcomes.failed})`,
    `Heal rate: ${(report.healRate * 100).toFixed(1)}%; clean rate: ${(report.cleanRate * 100).toFixed(1)}%`,
    `Quarantined flows: ${report.quarantined}`,
    `Flows healed at least once: ${report.flowsHealed}`,
  ];
  return `${lines.join('\n')}\n`;
}

// `registry`'s human arms (WS4b Task 7). Every field sourced from a server
// response (registry publicKey fingerprints are derived locally and never
// printed raw; flow/description/origin/args text pulled from a pull/search
// envelope IS server-supplied) passes stripControlChars before it reaches
// the terminal -- the registry service is untrusted input from this
// client's point of view, same posture flows/sites already take toward
// page-derived text.
function humanRegistryInit(report) {
  const lines = [
    `Registered ${stripControlChars(report.url)}`,
    `Fingerprint: ${report.fingerprint}`,
    `Clustering: ${report.clustering ? 'enabled' : 'disabled'}`,
  ];
  if (report.keyChanged) lines.push('Note: this registry key differs from the previously pinned key.');
  return `${lines.join('\n')}\n`;
}

function humanRegistryPush(report) {
  const lines = [`Pushed ${report.manifest.length} flow(s); excluded ${report.excluded.length}.`];
  for (const result of report.results) {
    const reasons = Array.isArray(result.reasons) && result.reasons.length > 0
      ? ` (${result.reasons.map((reason) => stripControlChars(reason.rule ?? reason.message ?? JSON.stringify(reason))).join('; ')})`
      : '';
    lines.push(`${result.name} - ${result.outcome}${reasons}`);
  }
  for (const entry of report.excluded) {
    const reasons = entry.reasons.map((reason) => `${reason.path} (${reason.rule})`).join(', ');
    lines.push(`Excluded ${entry.name} - ${reasons}`);
  }
  return `${lines.join('\n')}\n`;
}

function humanRegistryPull(report) {
  const rejected = report.results.filter((result) => result.outcome === 'rejected').length;
  const lines = [`Pulled ${report.results.length} flow(s); ${rejected} rejected.`];
  for (const result of report.results) {
    const name = stripControlChars(result.name ?? '(unknown)');
    const reason = result.reason ? ` (${result.reason})` : '';
    lines.push(`${name} - ${result.outcome}${reason}`);
  }
  for (const warning of report.warnings) {
    lines.push(`Warning: ${stripControlChars(warning.name ?? '')} - ${stripControlChars(warning.reason ?? '')}`);
  }
  if (!report.ok) lines.push('One or more pulled flows failed verification; see the warnings above.');
  return `${lines.join('\n')}\n`;
}

function humanRegistrySearch(report) {
  const lines = [`Mode: ${report.mode}`];
  if (report.results.length === 0) lines.push('No matching flows found.');
  for (const result of report.results) {
    const artifact = result.envelope?.artifact ?? {};
    const name = stripControlChars(artifact.name ?? '');
    const origin = stripControlChars(artifact.origin ?? '');
    const description = stripControlChars(artifact.description ?? '');
    const argNames = Object.keys(result.args ?? {}).map(stripControlChars).join(', ');
    const argsSuffix = argNames.length > 0 ? ` [args: ${argNames}]` : '';
    lines.push(`${name} (${origin}) score=${result.score} - ${description}${argsSuffix}`);
  }
  return `${lines.join('\n')}\n`;
}

function humanRegistryStatus(report) {
  const lines = [`Configured: ${report.configured}`];
  if (report.configured) {
    lines.push(`URL: ${stripControlChars(report.url)}`);
    lines.push(`Fingerprint: ${report.fingerprint}`);
    lines.push(`Reachable: ${report.reachable}`);
  }
  lines.push(`assumeYes: ${report.assumeYes}`);
  lines.push(`Token present: ${report.hasToken}`);
  return `${lines.join('\n')}\n`;
}

function humanRegistry(report) {
  if (report.sub === 'init') return humanRegistryInit(report);
  if (report.sub === 'push') return humanRegistryPush(report);
  if (report.sub === 'pull') return humanRegistryPull(report);
  if (report.sub === 'search') return humanRegistrySearch(report);
  return humanRegistryStatus(report);
}

function humanReport(command, report, env) {
  if (command === 'setup') return humanSetup(report, env);
  if (command === 'doctor') return humanDoctor(report);
  if (command === 'configure') {
    return `Fast Browser profile: ${report.config.profile}\n`;
  }
  if (command === 'migrate') {
    if (report.rollback) {
      const count = report.restoredPaths.length;
      return `Migration rolled back; ${count} legacy path${count === 1 ? '' : 's'} restored.\n`;
    }
    return report.dryRun
      ? 'Migration dry-run complete; no changes were made.\n'
        + unmanagedCandidatesWarning(report.inventory?.unmanagedCandidates)
      : `Migration complete.\n${unmanagedCandidatesWarning(report.unmanagedCandidates)}`;
  }
  if (command === 'uninstall') {
    return report.dataRetained
      ? 'Fast Browser was uninstalled; data and Keychain credentials were retained.\n'
      : 'Fast Browser was uninstalled and its exact data directory was purged.\n';
  }
  if (command === 'annotate') {
    return `Annotated ${report.annotations} region${report.annotations === 1 ? '' : 's'} `
      + `at ${report.width}x${report.height}: ${report.out}\n`;
  }
  if (command === 'gif') {
    return `Converted ${path.basename(report.source)} at ${report.fps} fps `
      + `(max width ${report.width}): ${report.out}\n`;
  }
  if (command === 'flows') return humanFlows(report);
  if (command === 'sites') return humanSites(report);
  if (command === 'stats') return humanStats(report);
  if (command === 'registry') return humanRegistry(report);
  return '';
}

export async function main(request, dependencies = {}) {
  const write = dependencies.write ?? stdout;
  if (request.help) {
    write(`${HELP}\n`);
    return 0;
  }
  if (request.version) {
    write(`${VERSION}\n`);
    return 0;
  }
  const commands = dependencies.commands ?? {
    setup,
    doctor,
    configure,
    migrate,
    uninstall,
    annotate,
    gif,
    flows,
    sites,
    stats,
    registry,
  };
  const command = commands[request.command];
  if (typeof command !== 'function') {
    const error = new Error(`unsupported command: ${request.command}`);
    error.exitCode = 2;
    throw error;
  }

  let report;
  try {
    report = await command(request, dependencies);
  } catch (cause) {
    const error = safeFailure(cause);
    if (!request.json) throw error;
    write(`${JSON.stringify({
      ok: false,
      error: {
        message: error.message,
        stage: error.stage ?? null,
        partialState: error.partialState ?? null,
      },
    })}\n`);
    return error.exitCode ?? 1;
  }

  if (request.json) write(`${JSON.stringify(report)}\n`);
  else write(humanReport(request.command, report, dependencies.env ?? process.env));
  if (request.command === 'doctor' && !report.ok) return 1;
  // `registry pull` never throws for a per-flow verify failure (it keeps
  // going and reports every other flow), so its failure signal is the
  // report's own `ok` field, not a thrown error -- same non-zero-exit
  // convention `doctor` already uses above.
  if (request.command === 'registry' && request.sub === 'pull' && !report.ok) return 1;
  return 0;
}
