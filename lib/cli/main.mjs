import { annotate } from '../commands/annotate.mjs';
import { configure } from '../commands/configure.mjs';
import { doctor } from '../commands/doctor.mjs';
import { migrate } from '../commands/migrate.mjs';
import { setup } from '../commands/setup.mjs';
import { uninstall } from '../commands/uninstall.mjs';

const VERSION = '0.1.0-alpha.1';
const HELP = [
  'Usage: fast-browser <setup|doctor|configure|migrate|uninstall|annotate> [options]',
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

function humanSetup(report) {
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
  // Fixed, non-echoing notice: no paths, no digests, no user data. Printed
  // only when setup replaced an install it could not verify (a legacy
  // marker predating content-digest verification), so the user knows their
  // prior, unverifiable bytes were not silently trusted.
  if (report.unverifiedArtifactsReplaced) {
    lines.push('Note: a previously unverifiable install was replaced with a freshly verified one.');
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
  const preserved = report.macros?.preserved?.length ?? 0;
  if (preserved > 0) {
    lines.push(
      `Note: ${preserved} edited built-in macro ${preserved === 1 ? 'entry was' : 'entries were'}`
      + ' kept as-is and may be out of date; rerun with --json for details.',
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

function humanReport(command, report) {
  if (command === 'setup') return humanSetup(report);
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
  else write(humanReport(request.command, report));
  if (request.command === 'doctor' && !report.ok) return 1;
  return 0;
}
