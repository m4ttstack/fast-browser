import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startMcpClient } from './mcp-client.mjs';

// Shared e2e flow-fixture trio (Task 10, WS3b): `pathsForOutputDir`/
// `installFlowRunner`/`tracedSession` used to exist as three byte-near-
// identical copies across tests/e2e/healing.test.mjs, flows.test.mjs, and
// sites.test.mjs. Extracted here verbatim (zero behavior change -- every
// e2e suite staying green after the swap IS the proof) so a fourth
// consumer (this task's own new healing legs) does not become a fourth
// copy.

const pluginRoot = fileURLToPath(new URL('../../../', import.meta.url));

// Hand-built paths object matching lib/core/paths.mjs's key shape, but
// rooted at `outputDir` itself rather than at `homeDir/.fast-browser`:
// lib/runtime/launch.mjs's real wiring is `--output-dir=${paths.dataDir}`
// (runtimeArgs), and mcp-client.mjs's `startMcpClient` passes `outputDir`
// as `--output-dir` verbatim -- so in every caller of this helper,
// `paths.dataDir` IS `outputDir`, never a nested subdirectory of it. This
// is where `TraceLog.create` writes `trace-<epochMs>/` (TRACE.md's
// "Directory layout"), exactly what sweep.mjs's `listTraceSessions` scans
// -- `resolvePaths({ homeDir: outputDir })` would instead compute
// `outputDir/.fast-browser`, one level too deep. `sitesDir` is included
// even for a caller that never writes under it (`flows find` reads the
// flow's own origin's stored quirks via lib/sites/store.mjs's
// `readSite(paths, origin)`, which requires the key to be a string, or
// `path.join(paths.sitesDir, ...)` throws -- a never-seen origin degrades
// to `{ quirks: [] }` on its own).
export function pathsForOutputDir(outputDir) {
  return {
    dataDir: outputDir,
    flowsDir: path.join(outputDir, 'flows'),
    flowsPendingDir: path.join(outputDir, 'flows-pending'),
    flowsStateFile: path.join(outputDir, 'flows-state.json'),
    macrosDir: path.join(outputDir, 'macros'),
    rejectedFlowsFile: path.join(outputDir, 'rejected-flows.md'),
    sitesDir: path.join(outputDir, 'sites'),
    // WS4a Task 7: sweep.mjs's runs-ledger append (`paths.runsDir`/
    // `paths.runsFile`) needs these two keys the same way it needs every
    // other key above -- without them `ensurePrivateDirectory(undefined)`
    // throws and every e2e replay's runs-ledger append lands in
    // `report.runsErrors` instead of `runs.jsonl` (contained, so it never
    // fails a suite, but it silently defeats the ledger for every e2e
    // fixture using this shared trio -- caught live via this exact symptom
    // in the drift harness's own kill-leg diagnostic output).
    runsDir: path.join(outputDir, 'runs'),
    runsFile: path.join(outputDir, 'runs', 'runs.jsonl'),
  };
}

// flows.mjs's `buildInvocation` embeds an absolute `<macrosDir>/
// flow-runner.js` filename (never inline code -- a macro sandboxed by
// browser_run_code_unsafe has no fs access to look itself up any other
// way). The physical file has to exist under this traced session's own
// output dir for that filename to resolve at replay time -- production's
// setup.mjs does this via installBuiltinMacros (which also writes
// MACROS.md and a hashes ledger no e2e test has a use for); a plain copy
// of the one file any invocation ever names is sufficient here.
export async function installFlowRunner(paths) {
  await mkdir(paths.macrosDir, { recursive: true });
  await copyFile(
    path.join(pluginRoot, 'builtins/macros/flow-runner.js'),
    path.join(paths.macrosDir, 'flow-runner.js'),
  );
}

// Wraps startMcpClient with an idempotent close registered via t.after as
// a safety net: a caller that closes its session explicitly and early
// (sweep defers compilation entirely until `meta.endedAt` exists, so a
// session MUST be closed before the next `flows compile` call can see it)
// still must not leak the spawned runtime process if an assertion throws
// between session creation and that explicit close.
export async function tracedSession(t, outputDir) {
  const session = await startMcpClient({ outputDir, extraArgs: ['--save-trace'] });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await session.close();
  };
  t.after(close);
  return { callTool: session.callTool, metrics: session.metrics, close };
}
