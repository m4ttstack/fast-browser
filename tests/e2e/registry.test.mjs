// WS4b Task 8: the registry's own local acceptance round trip. Boots the
// REAL registry service in-process (memory store, throwaway Ed25519 keys,
// an ephemeral port -- registry/tests/helpers/server.mjs's own boot()
// harness, the same one registry/tests/http.test.mjs trusts) and drives the
// REAL CLI (a child process of bin/fast-browser.mjs, exactly the way
// tests/e2e/annotate.test.mjs and tests/e2e/video.test.mjs already spawn it)
// against it: push creates a canonical; an identical re-push dedupes; a
// mutated re-push (a locator alternate appended) creates a SECOND canonical
// under the same name (a keyless service never clusters -- see the DESIGN
// note below); wiping the local flow and pulling restores it, exercising
// the client's alternates-union merge path across the two canonicals for
// free; lexical search (no embedder key) finds it; and a pull pinned to the
// WRONG public key rejects every envelope, writes nothing, and exits
// non-zero.
//
// DESIGN DECISION (brief Step 1's fork -- committed fixture vs. in-code
// construction): this suite builds its fixture IN CODE via
// registry/tests/helpers/fixtures.mjs's baseFlow(), the exact helper
// registry/tests/http.test.mjs already trusts for the same purpose, rather
// than committing a new binary/JSON fixture file that would need to be kept
// in sync with the flow schema by hand. No browser is launched anywhere in
// this file -- the "service" here is registry/server.mjs's boot() against
// the memory store, and the "client" is a plain child-process spawn -- so
// this suite runs in ordinary CI and is wired into both `npm run
// test:registry-e2e` and the root `npm test` (package.json).
//
// TTY ARRANGEMENT (brief Step 3a/3b) -- read this before wondering why
// `registry init` is never actually invoked below: both `registry init`'s
// and `registry push`'s confirm gates are TTY-gated (lib/cli/confirm.mjs's
// confirmTty fails closed whenever stdin/stdout are not a real TTY, which a
// spawned child process never has), and the CLI deliberately has NO env var
// or flag that bypasses that gate -- lib/commands/registry.mjs's own `push`
// comment: "--yes requires config registry.assumeYes to be true --
// `registry init` never sets this automatically". This suite does not add,
// or otherwise weaken, any such bypass to production code. Instead:
//   - `init`'s END STATE (a config with a registry URL and the service's
//     real public key pinned) is arranged directly: this suite calls the
//     SAME `saveConfig` (lib/core/files.mjs) production code itself uses,
//     writing the exact shape `registry init` would have written after a
//     human typed TRUST, over the service's OWN real public key (the value
//     `boot()` returns, byte-identical to what `GET /health` serves --
//     registry/tests/http.test.mjs's "publicKey matches the key derived
//     from the booted signing key" test already pins that equivalence, so
//     re-deriving it via an extra HTTP round trip here would prove nothing
//     new). This is exactly the "the e2e is allowed to arrange state" path
//     the task brief calls for -- what this suite proves end to end is
//     push/pull/search/verify, never the TTY prompt itself.
//   - `push`'s confirm gate is exercised through its OTHER documented,
//     production, non-interactive path: `--yes` together with
//     `registry.assumeYes: true` already set in config -- the same
//     automation opt-in a human enables by hand in the config file, per
//     `push`'s own comment. Every push below goes through the REAL CLI
//     binary with this flag; nothing about the gate itself is bypassed by
//     this suite, only exercised via the path production code documents for
//     exactly this purpose.
// Both gates' actual interactive/TTY-refusal behavior is unit-tested
// elsewhere (tests/unit); this suite's job is the round trip those gates
// protect, not the gates themselves.

import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import {
  mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { defaultConfig } from '../../lib/core/config.mjs';
import { ensurePrivateDirectory, saveConfig } from '../../lib/core/files.mjs';
import { resolvePaths } from '../../lib/core/paths.mjs';
import {
  flowFileName, parseFlow, serializeFlow,
} from '../../lib/flows/artifact.mjs';
import { verify } from '../../registry/lib/signing.mjs';
import { baseFlow } from '../../registry/tests/helpers/fixtures.mjs';
import { startTestServer } from '../../registry/tests/helpers/server.mjs';

const execFile = promisify(execFileCallback);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.join(HERE, '..', '..');
const CLI_PATH = path.join(PLUGIN_ROOT, 'bin', 'fast-browser.mjs');

// Spawns the real `fast-browser registry ...` CLI binary, always with
// --json (a machine-parseable report on stdout) and the given HOME/token in
// the CHILD's env -- never the parent test process's own env -- so config
// and the flows directory are fully isolated per call site. execFile
// rejects on a nonzero exit code; the tampered-signature pull below
// legitimately exits 1 (main.mjs's own convention: a `registry pull` whose
// report.ok is false returns 1), so a nonzero exit is treated as DATA here,
// not a thrown test failure -- the report/stdout/stderr are recovered off
// the rejected error the same way a successful call recovers them off the
// resolved value.
async function runCli(args, { home, token }) {
  const env = { ...process.env, HOME: home, FAST_BROWSER_REGISTRY_TOKEN: token };
  try {
    const { stdout, stderr } = await execFile(process.execPath, [CLI_PATH, ...args, '--json'], { env });
    return {
      code: 0, report: JSON.parse(stdout), stdout, stderr,
    };
  } catch (error) {
    return {
      code: error.code,
      report: typeof error.stdout === 'string' && error.stdout.length > 0 ? JSON.parse(error.stdout) : null,
      stdout: error.stdout,
      stderr: error.stderr,
    };
  }
}

// Writes `flow` straight into the ready tier (paths.flowsDir), the same
// atomic-write shape lib/commands/registry.mjs's own defaultWriteFlowFile
// produces -- this suite arranges the flow's presence directly (recording
// and compiling a flow end to end is tests/e2e/flows.test.mjs's job, not
// this suite's), so `push` has something real to read off disk.
async function writeReadyFlow(paths, flow) {
  await ensurePrivateDirectory(paths.flowsDir);
  await writeFile(path.join(paths.flowsDir, flowFileName(flow)), serializeFlow(flow), { mode: 0o600 });
}

// Pins `publicKeyPem`/`url` into a fresh, otherwise-default config -- the
// "init, arranged" step documented in the header comment above.
async function arrangeInitializedConfig(paths, { url, publicKeyPem }) {
  await saveConfig(paths, {
    ...defaultConfig(),
    registry: { url, publicKey: publicKeyPem, assumeYes: true },
  });
}

test('registry round trip: push creates, re-push dedupes, mutated re-push creates a second canonical, pull restores + merges, lexical search finds it', async (t) => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-registry-e2e-'));
  t.after(() => rm(tempHome, { recursive: true, force: true }));
  const paths = resolvePaths({ homeDir: tempHome });

  const registryServer = await startTestServer();
  t.after(registryServer.close);

  await arrangeInitializedConfig(paths, {
    url: registryServer.baseUrl,
    publicKeyPem: registryServer.publicKeyPem,
  });

  // --- (a)/(b): push the fixture flow -- newly created. ---
  const flow = parseFlow(baseFlow({ name: 'registry-e2e-flow' }));
  await writeReadyFlow(paths, flow);

  const firstPush = await runCli(['registry', 'push', '--yes'], { home: tempHome, token: registryServer.token });
  assert.equal(firstPush.code, 0, `push should succeed: ${firstPush.stderr}`);
  assert.equal(firstPush.report.results.length, 1);
  assert.equal(firstPush.report.results[0].name, 'registry-e2e-flow');
  assert.equal(firstPush.report.results[0].outcome, 'created');
  const firstCanonicalId = firstPush.report.results[0].canonicalId;
  assert.equal(typeof firstCanonicalId, 'string');

  // The manifest (the one consent artifact push produces) must appear on
  // stderr on the --yes bypass path -- lib/commands/registry.mjs's own
  // documented reasoning: stdout stays JSON-pure for a --json caller, and
  // stderr durably records what left the machine and under what consent.
  assert.match(firstPush.stderr, /Registry push manifest \(1 flow\(s\)\)/);
  assert.match(firstPush.stderr, /registry-e2e-flow - http:\/\/localhost:4823/);

  // --- (c1): an EXACT re-push of the same bytes is idempotent: deduped,
  // never created twice. ---
  const dedupPush = await runCli(['registry', 'push', '--yes'], { home: tempHome, token: registryServer.token });
  assert.equal(dedupPush.report.results[0].outcome, 'deduped');
  assert.equal(dedupPush.report.results[0].canonicalId, firstCanonicalId);

  // --- (c2): mutate a locator alternate on the click step, then push
  // again. THINK (per the brief): a keyless service (no VOYAGE_API_KEY,
  // confirmed by registry/tests/http.test.mjs's own "keyless service ...
  // creates with embedding null and never clusters") never clusters, so
  // pushing DIFFERENT bytes under the SAME name is not a dedup and not a
  // clustered merge -- it is a SECOND canonical entirely. That is the
  // designed behavior for a keyless registry (server-side clustering is an
  // opt-in feature gated on an embedder being configured at all), not a
  // bug, and this suite asserts exactly that rather than the clustered
  // outcome a keyed service would have produced instead. ---
  const mutatedLocator = { kind: 'testid', selector: 'place-order-alt' };
  const mutatedFlow = parseFlow({
    ...flow,
    steps: flow.steps.map((step, index) => (
      index === 2 // the click step
        ? { ...step, target: { ...step.target, locators: [...step.target.locators, mutatedLocator] } }
        : step
    )),
  });
  await writeReadyFlow(paths, mutatedFlow);

  const mutatedPush = await runCli(['registry', 'push', '--yes'], { home: tempHome, token: registryServer.token });
  assert.equal(mutatedPush.report.results[0].outcome, 'created');
  const secondCanonicalId = mutatedPush.report.results[0].canonicalId;
  assert.notEqual(secondCanonicalId, firstCanonicalId, 'a mutated re-push must land as a distinct canonical, not the same one');

  // --- (d): wipe the local ready-tier flow file, then pull. The server now
  // holds TWO canonicals named 'registry-e2e-flow' (the original, and the
  // locator-mutated one) -- the client processes GET /v1/pull's envelopes
  // in whatever order the store returns them: whichever one is seen FIRST
  // is not present locally yet, so it lands as 'created'; the SECOND hits
  // the same name + same origin + same stepSignature (appending a locator
  // alternate does not change stepSignature -- registry/lib/
  // signature-fields.mjs's own doc comment) and is anchored to the same
  // element, so it unions its locator alternate into the just-written local
  // file via the merge path ('merged'). Asserted as an unordered pair
  // (`.sort()`) rather than a fixed sequence: the union of alternates the
  // merge produces is the same regardless of which canonical the store
  // happens to list first, so pinning a specific order here would only
  // create a spurious flake tied to store iteration order, not prove
  // anything more about the merge itself. ---
  const readyFilePath = path.join(paths.flowsDir, flowFileName(flow));
  await rm(readyFilePath);

  const pull = await runCli(['registry', 'pull'], { home: tempHome, token: registryServer.token });
  assert.equal(pull.code, 0, `pull should succeed: ${pull.stderr}`);
  assert.equal(pull.report.ok, true);
  const outcomesForFlow = pull.report.results
    .filter((result) => result.name === 'registry-e2e-flow')
    .map((result) => result.outcome)
    .sort();
  assert.deepEqual(outcomesForFlow, ['created', 'merged']);

  // Restored, byte-verifiable: re-parses cleanly off disk, and its click
  // step's locators are the exact union of alternates the two canonicals
  // carried (order-independent per the note above: the ORIGINAL locator
  // survives, and the MUTATED alternate is present too, regardless of
  // which order the merge actually ran in).
  const restoredRaw = await readFile(readyFilePath, 'utf8');
  const restoredFlow = parseFlow(JSON.parse(restoredRaw));
  const restoredClickLocators = restoredFlow.steps[2].target.locators;
  assert.deepEqual(
    [...restoredClickLocators].sort((a, b) => a.selector.localeCompare(b.selector)),
    [...flow.steps[2].target.locators, mutatedLocator].sort((a, b) => a.selector.localeCompare(b.selector)),
  );

  // Signature verified INDEPENDENTLY of the CLI's own internal verify call:
  // fetch the raw envelopes straight off the still-running service (not
  // through the CLI at all) and, using registry/lib/signing.mjs's `verify`
  // directly in THIS test, confirm both canonicals the pull just consumed
  // really were signed by the service's own key over serializeFlow bytes --
  // the exact trust boundary lib/commands/registry.mjs's `pull` relies on
  // before it ever writes a byte to disk.
  const rawPullResponse = await fetch(`${registryServer.baseUrl}/v1/pull`, {
    headers: { Authorization: `Bearer ${registryServer.token}` },
  });
  assert.equal(rawPullResponse.status, 200);
  const rawPullPayload = await rawPullResponse.json();
  const flowEnvelopes = rawPullPayload.flows.filter((entry) => entry.artifact.name === 'registry-e2e-flow');
  assert.equal(flowEnvelopes.length, 2, 'both canonicals must still be present server-side');
  for (const envelope of flowEnvelopes) {
    const parsedArtifact = parseFlow(envelope.artifact);
    assert.equal(
      verify(serializeFlow(parsedArtifact), envelope.signature, registryServer.publicKeyPem),
      true,
      'every envelope pull consumed must independently verify against the service\'s own public key',
    );
  }

  // --- (e): lexical search (keyless service -> mode 'lexical'), the flow
  // is found. ---
  const search = await runCli(['registry', 'search', '--intent', 'place an order'], {
    home: tempHome,
    token: registryServer.token,
  });
  assert.equal(search.code, 0, `search should succeed: ${search.stderr}`);
  assert.equal(search.report.mode, 'lexical');
  assert.ok(
    search.report.results.some((result) => result.envelope.artifact.name === 'registry-e2e-flow'),
    `expected 'registry-e2e-flow' among search results: ${JSON.stringify(search.report.results.map((r) => r.envelope.artifact.name))}`,
  );
});

test('registry pull pinned to the WRONG public key rejects every envelope loudly, writes nothing, and exits non-zero', async (t) => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-registry-e2e-tamper-'));
  t.after(() => rm(tempHome, { recursive: true, force: true }));
  const paths = resolvePaths({ homeDir: tempHome });

  // Two REAL services, each with its own independently-generated Ed25519
  // signing key (registry/tests/helpers/server.mjs's own startTestServer
  // never reuses a key across calls): `serviceB` is the one this test
  // actually pushes to and pulls from; `decoyService` exists purely to
  // donate a real, independently-derived public key -- standing in for
  // "service A's key" (the brief's own framing) without keeping a second
  // service alive across a test-file boundary. Either way the proof is the
  // same: a public key that is NOT the serving key's own key must reject
  // every signature, full stop.
  const serviceB = await startTestServer();
  t.after(serviceB.close);
  const decoyService = await startTestServer();
  t.after(decoyService.close);
  assert.notEqual(decoyService.publicKeyPem, serviceB.publicKeyPem, 'the two services must have genuinely different keys');

  // Config points at service B's URL but pins the DECOY's public key --
  // exactly the "URL says B, pinned key says A" arrangement the brief
  // calls for, reached by writing config directly (see the header comment's
  // TTY ARRANGEMENT note -- this is the same arranged-config technique, not
  // a new one).
  await arrangeInitializedConfig(paths, {
    url: serviceB.baseUrl,
    publicKeyPem: decoyService.publicKeyPem,
  });

  const flow = parseFlow(baseFlow({ name: 'registry-e2e-tamper-flow' }));
  await writeReadyFlow(paths, flow);

  const push = await runCli(['registry', 'push', '--yes'], { home: tempHome, token: serviceB.token });
  assert.equal(push.code, 0, `push to service B should succeed: ${push.stderr}`);
  assert.equal(push.report.results[0].outcome, 'created');

  // Remove the local ready-tier copy so a failed pull's "nothing written"
  // claim below is checking a real absence, not an untouched pre-existing
  // file that would look the same either way.
  const readyFilePath = path.join(paths.flowsDir, flowFileName(flow));
  await rm(readyFilePath);

  const pull = await runCli(['registry', 'pull'], { home: tempHome, token: serviceB.token });
  // main.mjs's documented convention: `registry pull` never throws for a
  // per-flow verify failure (it keeps going and reports every other flow),
  // so its failure signal is the report's own `ok: false`, surfaced as a
  // non-zero process exit -- exactly `doctor`'s own non-zero-exit-on-report
  // convention, reused here.
  assert.equal(pull.code, 1);
  assert.equal(pull.report.ok, false);
  const tamperResult = pull.report.results.find((result) => result.name === 'registry-e2e-tamper-flow');
  assert.ok(tamperResult, 'the tampered-key envelope must still be reported, not silently dropped');
  assert.equal(tamperResult.outcome, 'rejected');
  assert.equal(tamperResult.reason, 'signature-invalid');
  const tamperWarning = pull.report.warnings.find((warning) => warning.name === 'registry-e2e-tamper-flow');
  assert.ok(tamperWarning, 'a loudly-named warning must accompany the rejection');
  assert.match(tamperWarning.reason, /signature verification failed/);

  // Nothing written: the ready-tier file this suite removed above must
  // still be absent -- a rejected envelope must never reach disk.
  await assert.rejects(readFile(readyFilePath, 'utf8'), { code: 'ENOENT' });

  // Independent proof the two keys really do disagree over the SAME bytes
  // (not merely that the CLI said so): fetch the real envelope straight off
  // service B and confirm it verifies against service B's OWN key but fails
  // against the decoy's -- using registry/lib/signing.mjs's `verify`
  // directly in this test, the same independent check the first test above
  // runs on the success path.
  const rawPullResponse = await fetch(`${serviceB.baseUrl}/v1/pull`, {
    headers: { Authorization: `Bearer ${serviceB.token}` },
  });
  const rawPullPayload = await rawPullResponse.json();
  const [envelope] = rawPullPayload.flows.filter((entry) => entry.artifact.name === 'registry-e2e-tamper-flow');
  const canonicalBytes = serializeFlow(parseFlow(envelope.artifact));
  assert.equal(verify(canonicalBytes, envelope.signature, serviceB.publicKeyPem), true);
  assert.equal(verify(canonicalBytes, envelope.signature, decoyService.publicKeyPem), false);
});
