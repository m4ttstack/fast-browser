import path from 'node:path';

import { annotate } from '../commands/annotate.mjs';
import { configure } from '../commands/configure.mjs';
import { doctor } from '../commands/doctor.mjs';
import { gif } from '../commands/gif.mjs';
import { migrate } from '../commands/migrate.mjs';
import { setup } from '../commands/setup.mjs';
import { uninstall } from '../commands/uninstall.mjs';
import { isDirectoryOnPath } from '../core/launcher.mjs';

const VERSION = '0.1.0-alpha.1';
const HELP = [
  'Usage: fast-browser <setup|doctor|configure|migrate|uninstall|annotate|gif> [options]',
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
  return 0;
}
