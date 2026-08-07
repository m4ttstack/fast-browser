import { createHash, createPublicKey, randomUUID } from 'node:crypto';
import { readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { confirmTty } from '../cli/confirm.mjs';
import { loadConfig as loadSavedConfig } from '../core/config.mjs';
import { ensurePrivateDirectory, saveConfig as saveValidatedConfig } from '../core/files.mjs';
import { resolvePaths } from '../core/paths.mjs';
import {
  flowFileName, flowId, flowTier, parseFlow, serializeFlow,
} from '../flows/artifact.mjs';
import { PUSH_MAX_FLOWS } from '../../registry/lib/constants.mjs';
import { lintArtifact } from '../../registry/lib/pii-lint.mjs';
import { flowsAreAnchored, stepSignature } from '../../registry/lib/signature-fields.mjs';
import { verify } from '../../registry/lib/signing.mjs';
import { LifecycleError, stripControlChars } from './shared.mjs';

// The `fast-browser registry` command family (WS4b plan, Task 7): the ONE
// place data leaves or enters this machine for the registry flywheel
// program, and therefore the workstream's primary CONSENT surface. Every
// subcommand below either requires an explicit typed confirmation before
// its one network side effect (`init` pins a remote-supplied key; `push`
// sends local flow content off the machine), or is a pure read (`pull`,
// `search`, `status`) whose own trust boundary is signature verification
// rather than a human prompt.
//
// This module IMPORTS five dependency-free registry/lib modules directly
// (verify, stepSignature, flowsAreAnchored, lintArtifact, PUSH_MAX_FLOWS) --
// registry/lib/signing.mjs, registry/lib/signature-fields.mjs,
// registry/lib/pii-lint.mjs, and registry/lib/constants.mjs are all
// zero-runtime-dependency by design specifically so the plugin can import
// them without pulling in the registry service's own node:http/pg
// dependencies. PUSH_MAX_FLOWS (MAT-160) is the SAME ceiling
// registry/lib/http.mjs's `validatePushRequest` enforces server-side --
// imported from its single source of truth rather than duplicated, so
// `push`'s own client-side batching (below) can never drift out of sync
// with the whole-request 422 boundary the service actually applies.
//
// `flowsAreAnchored` (WS4b Task 7 fix round 1, Critical #1) is a SHARED
// SOURCE OF TRUTH with registry/lib/ingest.mjs's own cluster-merge: both
// import it from registry/lib/signature-fields.mjs rather than each
// keeping an independent copy. `ingest.mjs`'s alternates-union merge
// algorithm itself (mergeStep/unionLocators) is still deliberately NOT
// imported -- this module mirrors THAT algorithm locally (see `mergeStep`
// below) rather than sharing code, since ingest.mjs merges INTO a
// canonical the client has no business depending on, while `pull` merges
// INTO the user's own local flow file. The union-locator MECHANISM is safe
// to duplicate (it's pure data plumbing); the ANCHOR CHECK that gates
// whether a merge is safe to attempt at all is exactly the kind of logic
// that must never exist in two places, because the two copies WILL drift
// (this file's own history: the first version of this pull-merge shipped
// without the anchor check at all, reopening a bug ingest.mjs had already
// fixed).
//
// Structural privacy boundary (push): this module never imports
// lib/flows/trace-reader.mjs or lib/sites/* -- `push` reads ONLY the
// ready-tier flow directory (`paths.flowsDir`), never a trace, a session,
// or site memory. That is enforced by omission: there is no code path here
// that could reach those data sources even if asked to.

const SUBCOMMANDS = new Set(['init', 'push', 'pull', 'search', 'status']);

// Generous enough that a registry on a slow network/cold start doesn't spuriously
// fail a CLI invocation; short enough that no `fast-browser registry` call can
// hang the terminal indefinitely waiting on a stalled connection.
const REQUEST_TIMEOUT_MS = 15_000;
// Mirrors registry/lib/http.mjs's own BODY_LIMIT_BYTES -- the service caps
// every request body at 5MB, so a response this client reads is held to the
// same ceiling. Enforced two ways below (readJsonResponse): up front off a
// declared Content-Length header when the server sends one, and again after
// the body is fully read (a cap enforced post-hoc, at the cost of the bytes
// already having been buffered, for any response with no declared length --
// an accepted limitation given `fetch`'s Response#text() has no built-in
// streaming cap of its own).
const MAX_RESPONSE_BYTES = 5_000_000;

function fail(stage, message, exitCode = 1, extra = {}) {
  return new LifecycleError(message, { stage, exitCode, ...extra });
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// The public key fingerprint format this command family prints everywhere a
// human needs to eyeball/compare a registry's identity (init, status, the
// key-changed warning): sha256 of the exact PEM string's UTF-8 bytes,
// TRUNCATED to its first 16 bytes, hex-encoded, colon-separated in byte
// pairs (`aa:bb:cc:...`, 16 groups). This is deliberately NOT the full
// 32-byte digest -- a shorter fingerprint is standard practice for a
// human-facing display value (SSH/TLS both truncate or otherwise abbreviate
// for the same reason), and the FULL PEM is what's actually pinned into
// config and used for verification -- this fingerprint is a display/compare
// aid only, never itself the trust anchor.
function fingerprintPublicKey(pem) {
  const digest = createHash('sha256').update(pem, 'utf8').digest();
  return Array.from(digest.subarray(0, 16))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join(':');
}

// Final whole-branch review, blocking #1: the SAME Ed25519 key encoded with
// CRLF line endings, or missing its trailing newline, is byte-different but
// semantically identical -- fingerprinting or comparing the raw PEM STRING
// (rather than the parsed key) made the key-changed warning fire on pure
// formatting noise. `node:crypto`'s `createPublicKey` parses the actual key
// material regardless of that formatting, and `.export({type: 'spki',
// format: 'pem'})` re-serializes it back to ONE canonical PEM form (LF line
// endings, a single trailing newline) -- so normalizing through this
// round-trip makes two encodings of the same key produce byte-identical
// strings, which is what both the fingerprint and the key-change comparison
// actually need. Throws on genuinely unparseable input (garbage, a
// corrupted/truncated PEM, a key of the wrong type) -- the caller decides
// whether that's fatal (a freshly-fetched remote key, `init`) or tolerable
// (a possibly-stale previously-pinned key, also `init` -- see
// `tryNormalizePublicKeyPem` below).
//
// Security carry (task brief item 4, still true after normalization is
// added): `registry/lib/signing.mjs`'s `verify` calls `createPublicKey`
// OUTSIDE its own try/catch -- garbage PEM input throws there, by that
// module's own design (a malformed key is a configuration bug, not a
// verification outcome). `pull` always feeds `verify` the PINNED key, which
// is safe only because a peer-supplied key is validated (and now
// normalized) once, here, at the one place it ever enters config:
// `registry init` receiving GET /health's `publicKey` field from a remote
// server. A garbage/malformed key at init time is rejected cleanly, before
// anything is ever pinned. (Final review fold-in #3, separately: a
// PREVIOUSLY-pinned key that has since gone corrupt -- e.g. a hand-edited
// config, or a config predating this normalization -- is handled at the
// point of USE, in `requireConfiguredRegistry` below, not here.)
function normalizePublicKeyPem(pem, stage) {
  try {
    return createPublicKey(pem).export({ type: 'spki', format: 'pem' });
  } catch {
    throw fail(stage, 'the registry returned a public key that could not be parsed.', 1);
  }
}

// Tolerant counterpart used ONLY for a previously-pinned key during the
// key-change comparison in `init` -- `null` on failure rather than
// throwing, because `init`'s whole job is to fix a broken pin, so a
// corrupt EXISTING pin must never crash the very command that would
// replace it. A `null` result reads as "cannot prove this is the same
// key", which correctly falls out as a key change below.
function tryNormalizePublicKeyPem(pem) {
  try {
    return createPublicKey(pem).export({ type: 'spki', format: 'pem' });
  } catch {
    return null;
  }
}

// `request.registryUrl` (the CLI positional) must be an absolute http(s)
// URL; normalized to its bare origin (scheme + host, no path/query/hash)
// so every subsequent request this module builds via `new URL(pathname,
// storedUrl)` is unambiguous regardless of what the user typed (a trailing
// slash, an accidental path segment) -- mirrors lib/flows/artifact.mjs's
// own "origin must be a bare http(s) origin" rule for flow artifacts.
function ensureValidRegistryUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw fail('registry-init', 'registry init requires an absolute http(s) URL.', 2);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw fail('registry-init', 'registry init requires an absolute http(s) URL.', 2);
  }
  return parsed.origin;
}

// --- fs primitives (injectable, matching lib/commands/flows.mjs's DI
// convention). `defaultWriteFlowFile` is the artifact write discipline this
// task brief points to -- lib/flows/sweep.mjs's `writeJsonAtomic`, mirrored
// here rather than imported (sweep.mjs doesn't export it) ---

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

// temp+rename+0o600 write idiom (lib/core/files.mjs's `saveConfig`,
// lib/flows/sweep.mjs's `writeJsonAtomic` -- same pattern, independently
// owned here since neither module exports it).
async function defaultWriteFlowFile(filePath, text) {
  await ensurePrivateDirectory(path.dirname(filePath));
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, text, { mode: 0o600 });
    await rename(temporary, filePath);
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
  const errorOutput = supplied.errorOutput ?? process.stderr;
  // Matches flows.mjs's `approve` gate: --json forces non-interactive
  // regardless of the real terminal, so a scripted/agent invocation can
  // never land on an interactive branch by accident.
  const interactive = (
    request.json !== true
    && (supplied.interactive ?? (input.isTTY === true && output.isTTY === true))
  );
  return {
    paths,
    loadConfig: supplied.loadConfig ?? loadSavedConfig,
    saveConfig: supplied.saveConfig ?? saveValidatedConfig,
    env: supplied.env ?? process.env,
    fetch: supplied.fetch ?? globalThis.fetch,
    print: supplied.print ?? ((line) => output.write(`${line}\n`)),
    // Review fix round 1, Important #5: `push`'s `--yes`+`assumeYes`
    // automation bypass still needs SOMEWHERE to record the manifest --
    // it's the one consent artifact this whole command family exists to
    // produce -- without corrupting a `--json` caller's stdout. Stderr is
    // that place: stdout stays JSON-pure, and the "what left the machine"
    // record survives in whatever captures this process's logs.
    printStderr: supplied.printStderr ?? ((line) => errorOutput.write(`${line}\n`)),
    interactive,
    listFlowFiles: supplied.listFlowFiles ?? defaultListFlowFiles,
    readFlowFile: supplied.readFlowFile ?? defaultReadFlowFile,
    writeFlowFile: supplied.writeFlowFile ?? defaultWriteFlowFile,
    confirmInit: supplied.confirmInit ?? (() => confirmTty({
      input,
      output,
      createInterface: supplied.createInterface,
      prompt: 'Type TRUST to pin this registry key: ',
      expected: 'TRUST',
    })),
    confirmPush: supplied.confirmPush ?? (() => confirmTty({
      input,
      output,
      createInterface: supplied.createInterface,
      prompt: 'Type PUSH to send these flows to the registry: ',
      expected: 'PUSH',
    })),
  };
}

// --- config access ---

async function loadFullConfig(deps) {
  try {
    return await deps.loadConfig(deps.paths);
  } catch {
    throw fail('registry-config', 'fast-browser config could not be read; run `fast-browser setup` first.', 2);
  }
}

async function requireConfiguredRegistry(deps) {
  const config = await loadFullConfig(deps);
  if (!config.registry.url || !config.registry.publicKey) {
    throw fail('registry-config', 'no registry is configured; run `fast-browser registry init <url>` first.', 2);
  }
  // Final whole-branch review, fold-in #3: the pinned key is validated
  // HERE, at the point every command that needs it (push/pull/search) is
  // about to use it -- not just trusted because it's present. Without
  // this, a corrupted config.json (hand-edited, disk corruption, a config
  // written by a version of this code predating key normalization) sent
  // `pull` straight into `registry/lib/signing.mjs`'s `verify`, whose own
  // `createPublicKey` call sits outside its try/catch by design -- a raw,
  // unreportable Node/OpenSSL decoder error instead of an actionable
  // message. Caught cleanly here instead, naming the fix.
  try {
    createPublicKey(config.registry.publicKey);
  } catch {
    throw fail(
      'registry-config',
      'the pinned registry key could not be read; run `fast-browser registry init <url>` again.',
      2,
    );
  }
  return config;
}

// --- HTTP: the one place every subcommand talks to the registry service ---
//
// Wire contract (registry/lib/http.mjs, read directly rather than assumed):
// POST /v1/push { flows: [{artifact, contentHash}] } -> { results: [...] };
// GET /v1/pull?since&origin -> { flows: [...] }; GET /v1/search?intent&origin
// -> { mode, results: [...] }; GET /health (no auth) -> { ok, version,
// publicKey, clustering }. Auth is `Authorization: Bearer <token>`, and the
// token comes from FAST_BROWSER_REGISTRY_TOKEN ONLY -- never from config, so
// a pinned config file alone can never authenticate a push/pull/search.

async function readJsonResponse(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error('registry response exceeds the maximum allowed size');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new Error('registry response exceeds the maximum allowed size');
  }
  return text.length > 0 ? JSON.parse(text) : undefined;
}

async function callRegistry(deps, {
  url, method = 'GET', auth = true, body,
}) {
  const headers = { Accept: 'application/json' };
  if (auth) {
    const token = deps.env.FAST_BROWSER_REGISTRY_TOKEN;
    if (typeof token !== 'string' || token.length === 0) {
      throw fail('registry-auth', 'registry token missing; set FAST_BROWSER_REGISTRY_TOKEN.', 2);
    }
    headers.Authorization = `Bearer ${token}`;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await deps.fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // Final whole-branch review, blocking #2: never silently FOLLOW a
      // redirect. undici 6.x already strips the Authorization header on a
      // cross-origin redirect, but a 307/308 still RE-SENDS this request's
      // BODY (the push envelope, potentially containing flow content) to
      // wherever the redirect points -- and neither that stripping
      // behavior nor node 20.x's exact undici version is a guarantee this
      // client should rely on. `redirect: 'error'` makes `fetch` itself
      // reject on any redirect response instead of ever following one,
      // which `callRegistry`'s existing catch block already turns into a
      // clean `LifecycleError` like any other network fault.
      redirect: 'error',
    });
  } catch (error) {
    throw fail(
      'registry-network',
      `unable to reach the registry: ${stripControlChars(String(error?.message ?? error))}`,
      1,
    );
  }

  let payload;
  try {
    payload = await readJsonResponse(response);
  } catch (error) {
    throw fail(
      'registry-network',
      `the registry response could not be read: ${stripControlChars(String(error?.message ?? error))}`,
      1,
    );
  }

  if (!response.ok) {
    const message = typeof payload?.error?.message === 'string'
      ? payload.error.message
      : `registry request failed (${response.status})`;
    throw fail('registry-network', stripControlChars(message), 1);
  }

  return payload;
}

// --- init: TOFU consent gate ---

async function init(request, deps) {
  const url = ensureValidRegistryUrl(request.registryUrl);

  // Checked before any network access or config read (mirrors flows.mjs's
  // `approve`: --json or a non-TTY stdin must refuse identically regardless
  // of what the registry would have said), so a scripted invocation never
  // reaches a network call or a config write it could never confirm.
  if (!deps.interactive) {
    throw fail(
      'registry-init',
      'registry init requires an interactive terminal; rerun without --json in a TTY.',
      2,
    );
  }

  const current = await loadFullConfig(deps);

  const healthUrl = new URL('/health', url).toString();
  const health = await callRegistry(deps, { url: healthUrl, method: 'GET', auth: false });
  if (!health || typeof health.publicKey !== 'string') {
    throw fail('registry-init', 'the registry did not return a usable public key.', 1);
  }
  // Validate AND normalize the PEER-supplied key before it is ever printed,
  // compared, or pinned -- see normalizePublicKeyPem's own doc comment.
  // Cannot throw on the happy path here beyond what the presence/typeof
  // check above already covers: `health.publicKey` reaching this line
  // means it's already been proven parseable.
  const normalizedKey = normalizePublicKeyPem(health.publicKey, 'registry-init');

  // The previously-pinned key (if any) is normalized too, tolerantly (see
  // `tryNormalizePublicKeyPem`'s own doc comment) -- comparing raw-to-
  // normalized would reopen exactly the false-positive this fix exists to
  // close for a pin written before normalization existed.
  const previousKeyRaw = current.registry.publicKey;
  const previousKeyNormalized = previousKeyRaw !== null ? tryNormalizePublicKeyPem(previousKeyRaw) : null;
  const keyChanged = previousKeyRaw !== null && previousKeyNormalized !== normalizedKey;
  const fingerprint = fingerprintPublicKey(normalizedKey);

  deps.print(`Registry: ${stripControlChars(url)}`);
  deps.print(`Public key fingerprint: ${fingerprint}`);
  deps.print(`Clustering: ${health.clustering ? 'enabled' : 'disabled'}`);
  if (keyChanged) {
    // TOFU with change detection: re-initializing over an already-pinned
    // DIFFERENT key is exactly the scenario a Trust-On-First-Use model
    // exists to flag loudly -- both fingerprints are shown so a human can
    // actually compare them, not just be told "something changed".
    deps.print('WARNING: this registry is presenting a DIFFERENT public key than the one already pinned.');
    deps.print(`Previous fingerprint: ${previousKeyNormalized ? fingerprintPublicKey(previousKeyNormalized) : '(unreadable -- the previously pinned key could not be parsed)'}`);
    deps.print(`New fingerprint:      ${fingerprint}`);
  }

  const confirmed = await deps.confirmInit();
  if (!confirmed) {
    throw fail('registry-init', 'registry init requires typing TRUST to confirm.', 2);
  }

  // The NORMALIZED form is what gets pinned -- every later fingerprint/
  // compare (status, a future re-init) reads it back byte-identical
  // regardless of how the registry happened to format it this time.
  const next = { ...current, registry: { url, publicKey: normalizedKey, assumeYes: false } };
  await deps.saveConfig(deps.paths, next);

  return {
    command: 'registry',
    sub: 'init',
    url,
    fingerprint,
    keyChanged,
    clustering: Boolean(health.clustering),
  };
}

// --- push: ready-tier flows only, client-side lint, MANIFEST, confirm gate ---

// Structural privacy boundary: reads ONLY `paths.flowsDir` (the ready
// tier) -- never `paths.flowsPendingDir`, a trace, a session, or site
// memory. Mirrors lib/commands/flows.mjs's `loadTierArtifacts`, narrowed to
// one tier and this module's own `warnings` vocabulary.
async function loadReadyArtifacts(deps) {
  const entries = [];
  const warnings = [];
  const names = await deps.listFlowFiles(deps.paths.flowsDir);
  for (const name of names) {
    const filePath = path.join(deps.paths.flowsDir, name);
    let raw;
    try {
      raw = await deps.readFlowFile(filePath);
    } catch {
      warnings.push({ kind: 'artifact-load', file: name, reason: 'unreadable' });
      continue;
    }
    let flow;
    try {
      flow = parseFlow(JSON.parse(raw));
    } catch (error) {
      warnings.push({ kind: 'artifact-load', file: name, reason: `invalid: ${error.message}` });
      continue;
    }
    entries.push(flow);
  }
  return { entries, warnings };
}

// Splits the INCLUDED (post-lint) set into batches of at most
// PUSH_MAX_FLOWS -- the service's own whole-request ceiling
// (registry/lib/http.mjs's `validatePushRequest`, imported from its single
// source of truth above `push` never re-derives it). Order-preserving:
// `flows.slice` never reorders, so concatenating each batch's own results
// back together (below) reproduces the ORIGINAL input order with no extra
// bookkeeping. An empty `flows` array yields zero batches (never one empty
// batch), matching `push`'s existing "nothing to push" no-op.
function chunkFlows(flows, size) {
  const batches = [];
  for (let index = 0; index < flows.length; index += size) {
    batches.push(flows.slice(index, index + size));
  }
  return batches;
}

async function push(request, deps) {
  const config = await requireConfiguredRegistry(deps);

  // The confirm gate: --yes skips it ONLY when config registry.assumeYes
  // is literally true -- `registry init` never sets that (see `init`
  // above), so a bare `--yes` on a freshly-initialized registry is always
  // an error naming the config key, never a silent bypass.
  const bypass = request.yes === true;
  if (bypass && config.registry.assumeYes !== true) {
    throw fail(
      'registry-push',
      '--yes requires config registry.assumeYes to be true; `registry init` never sets this '
        + 'automatically, so it must be enabled by hand in the config file first.',
      2,
    );
  }
  if (!bypass && !deps.interactive) {
    throw fail(
      'registry-push',
      'registry push requires an interactive terminal; rerun without --json in a TTY, '
        + 'or pass --yes with registry.assumeYes enabled.',
      2,
    );
  }

  const { entries, warnings } = await loadReadyArtifacts(deps);
  const included = [];
  const excluded = [];
  for (const flow of entries) {
    // Client-side PII lint: reject loudly, never sanitize -- a failing
    // flow is excluded from the push entirely, with a loud warning naming
    // the path and rule, NEVER the offending value itself.
    const lint = lintArtifact(flow);
    if (!lint.ok) {
      excluded.push({ name: flow.name, reasons: lint.reasons });
      for (const reason of lint.reasons) {
        warnings.push({
          kind: 'lint-excluded', name: flow.name, path: reason.path, rule: reason.rule,
        });
      }
      continue;
    }
    included.push(flow);
  }

  const manifest = included.map((flow) => ({ name: flow.name, origin: flow.origin }));
  // MAT-160: one manifest and one confirm still cover the WHOLE included
  // set below -- consent is about the manifest's CONTENT (which flows,
  // whose origins, that provenance rides along), never about how many HTTP
  // requests deliver that already-approved content. Chunking only changes
  // what happens AFTER confirmation.
  const batches = chunkFlows(included, PUSH_MAX_FLOWS);

  // The MANIFEST: this IS the consent artifact -- the one place a human
  // (or, on the bypass path, a durable log) sees exactly what is about to
  // leave the machine, before it does. Printed unconditionally (review fix
  // round 1, Important #5 -- a prior version skipped this entirely on the
  // bypass path, which made the manifest a print statement mutation
  // testing couldn't tell from a no-op). WHERE it prints differs by path:
  //   - interactive path: `deps.print` (stdout), same shape as flows.mjs's
  //     `approve` printing flow details before its own typed-confirm gate,
  //     immediately followed by the actual prompt.
  //   - `--yes`+`assumeYes` bypass: `deps.printStderr` (stderr) -- this
  //     path exists for non-interactive/`--json` callers, so writing to
  //     stdout would corrupt a `--json` caller's machine-readable output;
  //     stderr keeps stdout JSON-pure while still recording, durably, what
  //     just left the machine and under what consent (the ruling that made
  //     --yes require registry.assumeYes:true in the first place).
  const manifestPrint = bypass ? deps.printStderr : deps.print;
  manifestPrint(`Registry push manifest (${manifest.length} flow(s)):`);
  // Batch count line (MAT-160 client push chunking): printed ONLY when the
  // included set needs more than one POST to deliver -- a push at or under
  // PUSH_MAX_FLOWS is still exactly one request, and the manifest reads
  // exactly as it did before chunking existed for that (the common) case.
  // On BOTH arms, same as every other manifest line.
  if (batches.length > 1) {
    manifestPrint(`${manifest.length} flow(s) in ${batches.length} batch(es) of up to ${PUSH_MAX_FLOWS}.`);
  }
  // Provenance disclosure (MAT-160): push ships each flow's full signed
  // artifact, including `provenance` -- never stripped, it stays inside
  // the signed bytes -- so the human (or, on the bypass path, the durable
  // log) approving this manifest sees that up front, not just names and
  // origins. On BOTH arms, same as every other manifest line.
  manifestPrint('Each flow includes compile provenance: trace folder name, success/fail counters, and timestamps.');
  if (manifest.length === 0) manifestPrint('(none)');
  for (const entry of manifest) manifestPrint(`${entry.name} - ${entry.origin}`);
  for (const entry of excluded) {
    for (const reason of entry.reasons) {
      manifestPrint(`Warning: ${entry.name} excluded - ${reason.path} (${reason.rule})`);
    }
  }

  if (!bypass) {
    const confirmed = await deps.confirmPush();
    if (!confirmed) {
      throw fail('registry-push', 'registry push requires typing PUSH to confirm.', 2);
    }
  }

  // Sequential batches, in input order: `results` is built by concatenating
  // each batch's own response results onto it in turn, which -- since
  // `chunkFlows` never reorders -- reproduces the original included-set
  // order with no extra bookkeeping. Deliberately sequential, not
  // concurrent: a mid-sequence failure (below) needs a clean "everything
  // strictly before this point was actually sent and has a real per-flow
  // outcome" boundary, which concurrent in-flight requests could not give a
  // truthful answer to. No retry: one transport failure ends the whole push
  // (a partial run is always safe to re-issue in full -- see the failure
  // message below, identical flow bytes dedupe server-side, so
  // already-ingested flows from earlier batches are never double-counted
  // by a re-push).
  //
  // Fix round 1, Important #3: a batch whose OWN `callRegistry` call threw
  // is NOT the same as a batch that was simply never sent. `callRegistry`
  // can throw after the request already left the machine (a timeout, a
  // connection reset while the response was in flight) -- the client
  // genuinely does not know whether the registry received and ingested
  // that batch or not. Labeling those flows `not-attempted`, the same as a
  // batch that never got a `fetch` call at all, would assert knowledge the
  // client does not have. So three statuses, not two: `results` (a
  // completed batch's real, server-reported outcomes), `unknown` (the ONE
  // batch whose request threw -- status genuinely unresolved), and
  // `notAttempted` (every batch strictly AFTER the failing one, which this
  // sequential loop never even tries once `failure` is set).
  const results = [];
  const unknown = [];
  const notAttempted = [];
  let failure = null;
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    if (failure) {
      // A strictly earlier batch already failed: this batch's flows were
      // never sent to the registry at all -- report that plainly, as a
      // status distinct from anything the registry itself could have said
      // about them (created/rejected/clustered/deduped) AND distinct from
      // `unknown` (the failing batch itself, whose own delivery status is
      // unresolved rather than definitely-never-sent).
      for (const flow of batch) notAttempted.push({ name: flow.name, outcome: 'not-attempted' });
      continue;
    }
    const pushUrl = new URL('/v1/push', config.registry.url).toString();
    const flows = batch.map((flow) => ({
      artifact: flow,
      contentHash: sha256Hex(serializeFlow(flow)),
    }));
    try {
      const responseBody = await callRegistry(deps, { url: pushUrl, method: 'POST', body: { flows } });
      const batchResults = Array.isArray(responseBody?.results) ? responseBody.results : [];
      results.push(...batchResults);
    } catch (error) {
      failure = { error, batchIndex };
      for (const flow of batch) unknown.push({ name: flow.name, outcome: 'unknown' });
    }
  }

  const batchMeta = { count: batches.length, size: PUSH_MAX_FLOWS };

  if (failure) {
    // Fix round 1, Important #2: when NOTHING was ever confirmed pushed
    // (the failure hit on the very first batch, before any batch had a
    // chance to return real outcomes), rethrow the UNDERLYING error
    // exactly as it already is -- same stage, same message, same
    // exitCode, same partialState if it carried one -- rather than
    // re-wrapping it in batch-accounting language. A pre-transmit failure
    // (a missing FAST_BROWSER_REGISTRY_TOKEN, an unconfigured registry) is
    // not a "batch 1 of 3" story at all, and re-wrapping it silently
    // changed its `stage` from `registry-auth`/`registry-config` to
    // `registry-push` -- a breaking change to the `--json` error envelope
    // contract for the single-batch case, which is the common case.
    // Batch context is only useful, and only added, once at least one
    // earlier batch actually completed.
    if (results.length === 0 && failure.batchIndex === 0) {
      throw failure.error;
    }
    throw fail(
      'registry-push',
      `registry push failed on batch ${failure.batchIndex + 1} of ${batches.length}: ${failure.error.message}. `
        + `${results.length} flow(s) confirmed pushed in ${failure.batchIndex} earlier batch(es); `
        + `${unknown.length} flow(s) unknown (the failed request may have reached the registry); `
        + `${notAttempted.length} flow(s) not attempted. Re-running `
        + '`fast-browser registry push` is safe: identical flow bytes dedupe on the registry, so '
        + 'flows already pushed will not be duplicated.',
      failure.error.exitCode ?? 1,
      {
        partialState: {
          manifest, excluded, results, warnings, unknown, notAttempted, batches: batchMeta,
        },
      },
    );
  }

  return {
    command: 'registry',
    sub: 'push',
    manifest,
    excluded,
    results,
    warnings,
    unknown,
    notAttempted,
    batches: batchMeta,
  };
}

// --- pull: verify EVERY signature against the pinned key; never overwrite
// on a verify failure or a step-signature conflict ---

// Mirrors registry/lib/ingest.mjs's own `mergeStep`/`unionLocators`/
// `mergeTargetLocators`/`locatorKey` byte-for-byte, but merges INTO the
// user's own LOCAL ready-tier flow rather than a server-side canonical --
// deliberately reimplemented here rather than imported (ingest.mjs merges
// for a different owner, with different stakes; see this module's top
// comment). Append-only: every existing local locator is kept, in order,
// and any incoming locator not already present by (kind, selector) identity
// is appended after it.
function locatorKey(locator) {
  return JSON.stringify([locator.kind, locator.selector]);
}

function unionLocators(existing, incoming) {
  const seen = new Set(existing.map(locatorKey));
  const merged = [...existing];
  for (const locator of incoming) {
    const key = locatorKey(locator);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(locator);
    }
  }
  return merged;
}

function mergeTargetLocators(localTarget, incomingTarget) {
  if (!localTarget) return localTarget;
  if (!incomingTarget) return localTarget;
  return { ...localTarget, locators: unionLocators(localTarget.locators, incomingTarget.locators) };
}

function mergeStep(localStep, incomingStep) {
  const merged = { ...localStep };
  if (localStep.target) {
    merged.target = mergeTargetLocators(localStep.target, incomingStep?.target);
  }
  if (localStep.op === 'drag' && localStep.to) {
    merged.to = mergeTargetLocators(localStep.to, incomingStep?.to);
  }
  return merged;
}

// Review fix round 1, Important #3 (ruling, plan amended): tier is
// directory location (lib/commands/flows.mjs's own module-level doc
// comment, the flywheel's binding convention) -- a pulled flow whose
// CONTENT `flowTier` classifies as 'pending' (mutating sideEffects, or any
// js step) must land in `paths.flowsPendingDir`, never `paths.flowsDir`,
// or a pull would silently grant replay trust to content that has never
// been through `flows approve` on THIS machine. `flowTier` is content-only
// and pure (lib/flows/artifact.mjs), so this is computed straight off the
// verified incoming flow, independent of anything the registry claims.
function tierDirFor(paths, tier) {
  return tier === 'pending' ? paths.flowsPendingDir : paths.flowsDir;
}

async function pull(request, deps) {
  const config = await requireConfiguredRegistry(deps);

  // On-demand v1, deliberately: no `since` cursor is persisted anywhere in
  // config or on disk. Every `registry pull` re-fetches the registry's
  // FULL flow set for the (optional) origin filter and re-runs the same
  // merge logic below against it -- which is idempotent (a flow already
  // present with an identical step signature unions in nothing new; an
  // exact byte match would union in nothing at all), so re-pulling
  // everything every time is safe, if not bandwidth-optimal. A `since`
  // cursor is future work, not a v1 requirement.
  const url = new URL('/v1/pull', config.registry.url);
  if (typeof request.origin === 'string' && request.origin.length > 0) {
    url.searchParams.set('origin', request.origin);
  }

  const body = await callRegistry(deps, { url: url.toString(), method: 'GET' });
  const envelopes = Array.isArray(body?.flows) ? body.flows : [];

  // Both tiers listed up front (review fix round 1, Important #3): which
  // directory a given pulled flow's existing-name check runs against
  // depends on THAT flow's own `flowTier`, decided per envelope below.
  const readyNames = new Set(await deps.listFlowFiles(deps.paths.flowsDir));
  const pendingNames = new Set(await deps.listFlowFiles(deps.paths.flowsPendingDir));

  const results = [];
  const warnings = [];
  let failures = 0;

  for (const envelope of envelopes) {
    // Never assume envelope artifact parses: a parse failure counts as a
    // verify failure -- reject loudly, write nothing, keep going.
    let flow;
    try {
      flow = parseFlow(envelope?.artifact);
    } catch (error) {
      failures += 1;
      const label = typeof envelope?.artifact?.name === 'string' ? envelope.artifact.name : '(unknown)';
      warnings.push({ kind: 'pull-rejected', name: label, reason: `invalid artifact: ${error.message}` });
      results.push({ name: label, outcome: 'rejected', reason: 'invalid-artifact' });
      continue;
    }

    // The one trust boundary for everything pulled: verify the Ed25519
    // signature against the PINNED public key (validated once already, at
    // `init` time) over the exact same canonical bytes the service signed
    // (serializeFlow(parseFlow(artifact))). Any failure here is loud,
    // writes nothing for this flow, and does not abort the rest of the
    // pull -- only the final process exit code (report.ok) reflects it.
    const canonicalBytes = serializeFlow(flow);
    const signatureOk = verify(canonicalBytes, envelope.signature, config.registry.publicKey);
    if (!signatureOk) {
      failures += 1;
      warnings.push({ kind: 'pull-rejected', name: flow.name, reason: 'signature verification failed' });
      results.push({ name: flow.name, outcome: 'rejected', reason: 'signature-invalid' });
      continue;
    }

    const tier = flowTier(flow);
    const tierDir = tierDirFor(deps.paths, tier);
    const tierNames = tier === 'pending' ? pendingNames : readyNames;
    const fileName = flowFileName(flow);
    const approvalNote = tier === 'pending' ? '`flows approve` is required on this machine before replay.' : null;

    if (!tierNames.has(fileName)) {
      await deps.writeFlowFile(path.join(tierDir, fileName), serializeFlow(flow));
      tierNames.add(fileName);
      results.push({
        name: flow.name, outcome: 'created', tier, ...(approvalNote ? { note: approvalNote } : {}),
      });
      continue;
    }

    let localFlow;
    try {
      localFlow = parseFlow(JSON.parse(await deps.readFlowFile(path.join(tierDir, fileName))));
    } catch {
      warnings.push({ kind: 'pull-skipped', name: flow.name, reason: `local ${tier} flow could not be read` });
      results.push({ name: flow.name, outcome: 'skipped', reason: 'local-unreadable' });
      continue;
    }

    // Review fix round 1, Critical #2: origin equality is a MERGE
    // PRECONDITION, checked before anything content-shaped. A same-named
    // flow from a DIFFERENT origin is never the same flow, no matter what
    // its steps look like -- merging (or even comparing steps) here would
    // let a registry entry for one site contaminate another site's flow
    // that just happens to share a name. Skip, warn naming BOTH origins,
    // never overwrite.
    if (localFlow.origin !== flow.origin) {
      warnings.push({
        kind: 'pull-skipped',
        name: flow.name,
        reason: `origin differs from the local flow (local origin ${localFlow.origin}, incoming origin ${flow.origin})`,
      });
      results.push({ name: flow.name, outcome: 'skipped', reason: 'origin-conflict' });
      continue;
    }

    const localSignature = stepSignature(localFlow);
    const incomingSignature = stepSignature(flow);
    if (localSignature !== incomingSignature) {
      // Different stepSignature: skip, warn naming BOTH flow ids, and
      // NEVER overwrite -- the local file is left exactly as it was.
      warnings.push({
        kind: 'pull-skipped',
        name: flow.name,
        reason: `step signature differs from the local flow (local id ${localFlow.id}, incoming id ${flow.id})`,
      });
      results.push({ name: flow.name, outcome: 'skipped', reason: 'signature-conflict' });
      continue;
    }

    // Review fix round 1, Critical #1: stepSignature equality alone does
    // NOT prove the two flows target the same elements (a role/name-less
    // CSS target collapses distinct elements onto the same signature
    // tuple; `drag`'s `to` isn't part of stepSignature at all). The SAME
    // anchor check registry/lib/ingest.mjs's own cluster-merge already
    // requires, imported from the single shared source
    // (registry/lib/signature-fields.mjs) rather than hand-mirrored here.
    if (!flowsAreAnchored(localFlow, flow)) {
      warnings.push({
        kind: 'pull-skipped',
        name: flow.name,
        reason: `step targets do not anchor to the same elements as the local flow despite a matching `
          + `step signature (local id ${localFlow.id}, incoming id ${flow.id})`,
      });
      results.push({ name: flow.name, outcome: 'skipped', reason: 'anchor-conflict' });
      continue;
    }

    // Same name, same origin, same stepSignature, anchored: union locator
    // alternates into the LOCAL flow (append-only), recompute its id from
    // the merged content, and rewrite it in place, in the SAME tier it was
    // already in.
    const mergedSteps = localFlow.steps.map((step, index) => mergeStep(step, flow.steps[index]));
    const mergedDraft = { ...localFlow, steps: mergedSteps };
    const mergedFlow = parseFlow({ ...mergedDraft, id: flowId(mergedDraft) });
    await deps.writeFlowFile(path.join(tierDir, fileName), serializeFlow(mergedFlow));
    results.push({
      name: flow.name, outcome: 'merged', tier, ...(approvalNote ? { note: approvalNote } : {}),
    });
  }

  return {
    command: 'registry', sub: 'pull', ok: failures === 0, results, warnings,
  };
}

// --- search: renders both modes (server decides, this just reports it) ---

async function search(request, deps) {
  const config = await requireConfiguredRegistry(deps);
  const url = new URL('/v1/search', config.registry.url);
  url.searchParams.set('intent', request.intent);
  if (typeof request.origin === 'string' && request.origin.length > 0) {
    url.searchParams.set('origin', request.origin);
  }

  const body = await callRegistry(deps, { url: url.toString(), method: 'GET' });
  return {
    command: 'registry', sub: 'search', mode: body?.mode ?? 'lexical', results: Array.isArray(body?.results) ? body.results : [],
  };
}

// --- status: /health + configured state; never the token value ---

async function status(request, deps) {
  const config = await loadFullConfig(deps);
  const token = deps.env.FAST_BROWSER_REGISTRY_TOKEN;
  const hasToken = typeof token === 'string' && token.length > 0;

  if (!config.registry.url || !config.registry.publicKey) {
    return {
      command: 'registry',
      sub: 'status',
      configured: false,
      url: config.registry.url,
      fingerprint: null,
      assumeYes: config.registry.assumeYes,
      hasToken,
      reachable: null,
      health: null,
    };
  }

  const healthUrl = new URL('/health', config.registry.url).toString();
  let health = null;
  let reachable = true;
  try {
    health = await callRegistry(deps, { url: healthUrl, method: 'GET', auth: false });
  } catch {
    // `status` degrades to "unreachable" rather than throwing -- unlike
    // push/pull/search (which genuinely need the registry to do their
    // job), status's whole point is to be checkable even when the
    // registry is down.
    reachable = false;
  }

  return {
    command: 'registry',
    sub: 'status',
    configured: true,
    url: config.registry.url,
    fingerprint: fingerprintPublicKey(config.registry.publicKey),
    assumeYes: config.registry.assumeYes,
    hasToken,
    reachable,
    health,
  };
}

export async function registry(request, supplied = {}) {
  const deps = dependencies(request, supplied);
  if (!SUBCOMMANDS.has(request.sub)) {
    throw fail('registry', 'registry requires a subcommand of init, push, pull, search, or status.', 2);
  }
  if (request.sub === 'init') return init(request, deps);
  if (request.sub === 'push') return push(request, deps);
  if (request.sub === 'pull') return pull(request, deps);
  if (request.sub === 'search') return search(request, deps);
  return status(request, deps);
}
