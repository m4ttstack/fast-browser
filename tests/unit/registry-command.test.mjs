import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

import { registry } from '../../lib/commands/registry.mjs';
import { defaultConfig } from '../../lib/core/config.mjs';
import {
  flowId, parseFlow, serializeFlow,
} from '../../lib/flows/artifact.mjs';
import { stepSignature as stepSignatureOf } from '../../registry/lib/signature-fields.mjs';
import { sign } from '../../registry/lib/signing.mjs';

// Every test here fetch-stubs the registry HTTP surface -- no real server,
// no real network, per the task brief. `registry.mjs`'s own `dependencies()`
// only calls `globalThis.fetch` when a test doesn't inject one; every test
// below injects a `fetch` double instead.

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function jsonResponse(status, body) {
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => text,
  };
}

function keyPair() {
  return generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

function target(overrides = {}) {
  const built = {
    locators: [{ kind: 'role', selector: 'internal:role=button[name="Place order"i]' }],
    description: 'Place order',
    role: 'button',
    name: 'Place order',
    ...overrides,
  };
  return Object.fromEntries(Object.entries(built).filter(([, value]) => value !== undefined));
}

function baseFlow(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'a'.repeat(64),
    name: 'place-order',
    description: 'Fill the order form and place an order',
    origin: 'https://example.com',
    urlPattern: '/checkout/:plan',
    sideEffects: 'read-only',
    args: { customer: { type: 'string', required: true } },
    result: { kind: 'extracts', keys: ['confirmationText'] },
    steps: [
      { op: 'goto', url: '/checkout/{plan}' },
      {
        op: 'fill',
        target: target({
          locators: [{ kind: 'role', selector: 'internal:role=textbox[name="Customer"i]' }],
          description: 'Customer',
          role: 'textbox',
          name: 'Customer',
        }),
        value: '{customer}',
      },
      {
        op: 'click',
        target: target(),
        waitAfter: { networkSettled: true },
        mutating: false,
      },
      {
        op: 'expect',
        target: target({
          locators: [{ kind: 'text', selector: 'internal:text="Order placed"' }],
          description: 'Order placed',
          role: undefined,
          name: undefined,
        }),
        state: 'visible',
      },
    ],
    provenance: {
      compiledAt: '2026-08-05T00:00:00.000Z',
      traceDir: 'trace-1754350000000',
      seqRange: [3, 9],
      productVersion: '0.1.0-alpha.10',
      successRuns: 0,
      failStreak: 0,
      lastHealed: null,
    },
    ...overrides,
  };
}

// Recomputes `id` from `overrides`-applied content, matching the write
// discipline every real compiled flow already satisfies (`flow.id ===
// flowId(flow)`). Used wherever a test needs a flow that would ALSO pass a
// stricter "id matches content" check, even though parseFlow itself never
// enforces that relationship.
function validFlow(overrides = {}) {
  const draft = baseFlow({ ...overrides, id: 'a'.repeat(64) });
  return { ...draft, id: flowId(draft) };
}

function signedEnvelope(flow, privateKey) {
  const canonicalBytes = serializeFlow(flow);
  return {
    artifact: flow,
    contentHash: sha256Hex(canonicalBytes),
    signature: sign(canonicalBytes, privateKey),
  };
}

function baseConfig(overrides = {}) {
  return {
    ...defaultConfig(),
    ...overrides,
  };
}

function configuredConfig(publicKey, overrides = {}) {
  return baseConfig({
    registry: { url: 'https://registry.example.com', publicKey, assumeYes: false },
    ...overrides,
  });
}

// --- init ---

test('registry init pins {url, publicKey, assumeYes:false} into config after typed confirmation', async () => {
  const { publicKey } = keyPair();
  const saved = [];
  const prints = [];
  const current = baseConfig();

  const report = await registry(
    { sub: 'init', registryUrl: 'https://registry.example.com', json: false },
    {
      interactive: true,
      loadConfig: async () => current,
      saveConfig: async (paths, config) => saved.push(config),
      fetch: async (url) => {
        assert.equal(url, 'https://registry.example.com/health');
        return jsonResponse(200, {
          ok: true, version: '1.0.0', publicKey, clustering: false,
        });
      },
      print: (line) => prints.push(line),
      confirmInit: async () => true,
    },
  );

  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].registry, { url: 'https://registry.example.com', publicKey, assumeYes: false });
  assert.equal(report.url, 'https://registry.example.com');
  assert.match(report.fingerprint, /^([0-9a-f]{2}:){15}[0-9a-f]{2}$/);
  assert.equal(report.keyChanged, false);
  // The prompt narrative shows the fingerprint, never the raw key material.
  assert.ok(prints.some((line) => line.includes(report.fingerprint)));
  assert.ok(!prints.some((line) => line.includes(publicKey)));
});

test('registry init pins nothing when confirmation is declined', async () => {
  const { publicKey } = keyPair();
  const saved = [];

  await assert.rejects(
    registry(
      { sub: 'init', registryUrl: 'https://registry.example.com', json: false },
      {
        interactive: true,
        loadConfig: async () => baseConfig(),
        saveConfig: async (paths, config) => saved.push(config),
        fetch: async () => jsonResponse(200, {
          ok: true, version: '1.0.0', publicKey, clustering: false,
        }),
        print: () => {},
        confirmInit: async () => false,
      },
    ),
    (error) => error.name === 'LifecycleError' && /TRUST/.test(error.message),
  );
  assert.equal(saved.length, 0);
});

test('registry init requires an interactive terminal and never touches the network or config when it is not one', async () => {
  await assert.rejects(
    registry(
      { sub: 'init', registryUrl: 'https://registry.example.com', json: true },
      {
        interactive: false,
        loadConfig: async () => { throw new Error('must not read config before the interactive gate'); },
        fetch: async () => { throw new Error('must not fetch before the interactive gate'); },
      },
    ),
    (error) => error.name === 'LifecycleError' && /interactive/i.test(error.message),
  );
});

test('registry init rejects a garbage public key before printing or confirming anything', async () => {
  const prints = [];
  const saved = [];

  await assert.rejects(
    registry(
      { sub: 'init', registryUrl: 'https://registry.example.com', json: false },
      {
        interactive: true,
        loadConfig: async () => baseConfig(),
        saveConfig: async (paths, config) => saved.push(config),
        fetch: async () => jsonResponse(200, {
          ok: true, version: '1.0.0', publicKey: 'not a pem at all', clustering: false,
        }),
        print: (line) => prints.push(line),
        confirmInit: async () => { throw new Error('must not prompt over a garbage key'); },
      },
    ),
    (error) => error.name === 'LifecycleError' && /could not be parsed/i.test(error.message),
  );
  assert.deepEqual(prints, []);
  assert.equal(saved.length, 0);
});

test('registry init re-run over a DIFFERENT already-pinned key warns with both fingerprints and still requires confirmation', async () => {
  const previous = keyPair();
  const next = keyPair();
  const prints = [];
  const saved = [];

  const report = await registry(
    { sub: 'init', registryUrl: 'https://registry.example.com', json: false },
    {
      interactive: true,
      loadConfig: async () => configuredConfig(previous.publicKey),
      saveConfig: async (paths, config) => saved.push(config),
      fetch: async () => jsonResponse(200, {
        ok: true, version: '1.0.0', publicKey: next.publicKey, clustering: true,
      }),
      print: (line) => prints.push(line),
      confirmInit: async () => true,
    },
  );

  assert.equal(report.keyChanged, true);
  assert.ok(prints.some((line) => /WARNING/.test(line)));
  assert.ok(prints.some((line) => line.includes('Previous fingerprint')));
  assert.ok(prints.some((line) => line.includes('New fingerprint')));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].registry.publicKey, next.publicKey);
});

test('registry init re-run with the SAME already-pinned key does not warn of a key change', async () => {
  const { publicKey } = keyPair();
  const prints = [];

  const report = await registry(
    { sub: 'init', registryUrl: 'https://registry.example.com', json: false },
    {
      interactive: true,
      loadConfig: async () => configuredConfig(publicKey),
      saveConfig: async () => {},
      fetch: async () => jsonResponse(200, {
        ok: true, version: '1.0.0', publicKey, clustering: false,
      }),
      print: (line) => prints.push(line),
      confirmInit: async () => true,
    },
  );

  assert.equal(report.keyChanged, false);
  assert.ok(!prints.some((line) => /WARNING/.test(line)));
});

// --- push ---

test('push manifest lists exactly the ready tier minus lint-excluded flows, with a pinned per-flow exclusion warning', async () => {
  const clean = validFlow({ name: 'clean-flow' });
  // Violates pii-lint's 'email' rule via the description field.
  const dirty = validFlow({ name: 'dirty-flow', description: 'Contact ops@example.com for help.' });
  const { publicKey } = keyPair();
  let pushed;
  const prints = [];

  const report = await registry(
    { sub: 'push', json: false, yes: false },
    {
      interactive: true,
      loadConfig: async () => configuredConfig(publicKey),
      listFlowFiles: async (dir) => {
        assert.equal(dir, '/h/flows');
        return ['clean-flow.flow.json', 'dirty-flow.flow.json'];
      },
      readFlowFile: async (filePath) => (
        filePath.includes('dirty') ? JSON.stringify(dirty) : JSON.stringify(clean)
      ),
      paths: { flowsDir: '/h/flows', flowsPendingDir: '/h/pending' },
      print: (line) => prints.push(line),
      confirmPush: async () => true,
      fetch: async (url, options) => {
        pushed = JSON.parse(options.body);
        assert.equal(url, 'https://registry.example.com/v1/push');
        return jsonResponse(200, {
          results: [{
            name: 'clean-flow', outcome: 'created', canonicalId: 'canonical-1', reasons: [],
          }],
        });
      },
      env: { FAST_BROWSER_REGISTRY_TOKEN: 'tok' },
    },
  );

  assert.deepEqual(report.manifest, [{ name: 'clean-flow', origin: 'https://example.com' }]);
  assert.equal(report.excluded.length, 1);
  assert.equal(report.excluded[0].name, 'dirty-flow');
  assert.ok(report.excluded[0].reasons.some((reason) => reason.rule === 'email'));
  assert.equal(pushed.flows.length, 1);
  assert.equal(pushed.flows[0].artifact.name, 'clean-flow');
  assert.equal(report.results[0].outcome, 'created');

  // The exclusion warning is pinned to path+rule -- the offending value
  // itself (the email address) must never appear anywhere in the report.
  assert.ok(report.warnings.some((warning) => warning.kind === 'lint-excluded' && warning.name === 'dirty-flow' && warning.rule === 'email'));
  assert.doesNotMatch(JSON.stringify(report), /ops@example\.com/);

  // Review fix round 1, Important #5: the manifest is the consent
  // artifact -- assert it actually PRINTS (name, origin, count), not just
  // that the report object carries the data. Deleting the print block
  // entirely must fail this test.
  assert.ok(prints.some((line) => /1 flow\(s\)/.test(line)));
  assert.ok(prints.some((line) => line.includes('clean-flow') && line.includes('https://example.com')));
  assert.ok(prints.some((line) => line.includes('dirty-flow') && /excluded/i.test(line)));
});

test('push confirm gate blocks the request without approval, and never calls the registry', async () => {
  const clean = validFlow({ name: 'clean-flow' });
  const { publicKey } = keyPair();

  await assert.rejects(
    registry(
      { sub: 'push', json: false, yes: false },
      {
        interactive: true,
        loadConfig: async () => configuredConfig(publicKey),
        listFlowFiles: async () => ['clean-flow.flow.json'],
        readFlowFile: async () => JSON.stringify(clean),
        paths: { flowsDir: '/h/flows', flowsPendingDir: '/h/pending' },
        print: () => {},
        confirmPush: async () => false,
        fetch: async () => { throw new Error('must not push without confirmation'); },
        env: { FAST_BROWSER_REGISTRY_TOKEN: 'tok' },
      },
    ),
    (error) => error.name === 'LifecycleError' && /PUSH/.test(error.message),
  );
});

test('push requires an interactive terminal (or --yes with assumeYes) before ever reading the ready tier', async () => {
  const { publicKey } = keyPair();
  await assert.rejects(
    registry(
      { sub: 'push', json: true, yes: false },
      {
        interactive: false,
        loadConfig: async () => configuredConfig(publicKey),
        listFlowFiles: async () => { throw new Error('must not read the ready tier before the gate'); },
        fetch: async () => { throw new Error('must not push'); },
        env: { FAST_BROWSER_REGISTRY_TOKEN: 'tok' },
      },
    ),
    (error) => error.name === 'LifecycleError' && /interactive/i.test(error.message),
  );
});

test('push --yes without config registry.assumeYes is an error naming the config key, never a silent bypass', async () => {
  const { publicKey } = keyPair();
  await assert.rejects(
    registry(
      { sub: 'push', json: true, yes: true },
      {
        interactive: false,
        loadConfig: async () => configuredConfig(publicKey), // assumeYes: false (init never sets true)
        listFlowFiles: async () => { throw new Error('must not read the ready tier'); },
        confirmPush: async () => { throw new Error('must not prompt under --yes'); },
        fetch: async () => { throw new Error('must not push'); },
        env: { FAST_BROWSER_REGISTRY_TOKEN: 'tok' },
      },
    ),
    (error) => error.name === 'LifecycleError' && /assumeYes/.test(error.message),
  );
});

test('push --yes with config registry.assumeYes:true skips the confirm prompt but still records the manifest to stderr', async () => {
  const clean = validFlow({ name: 'clean-flow' });
  const { publicKey } = keyPair();
  let confirmCalled = false;
  const stderrLines = [];

  const report = await registry(
    { sub: 'push', json: true, yes: true },
    {
      interactive: false,
      loadConfig: async () => configuredConfig(publicKey, {
        registry: { url: 'https://registry.example.com', publicKey, assumeYes: true },
      }),
      listFlowFiles: async () => ['clean-flow.flow.json'],
      readFlowFile: async () => JSON.stringify(clean),
      paths: { flowsDir: '/h/flows', flowsPendingDir: '/h/pending' },
      confirmPush: async () => { confirmCalled = true; return true; },
      // Review fix round 1, Important #5 (ruling): stdout must stay
      // JSON-pure on the automation bypass path -- `print` (stdout) must
      // never be called at all; the manifest instead goes to
      // `printStderr` so the "what left the machine" record still
      // survives in logs.
      print: () => { throw new Error('the automation bypass must not print to stdout'); },
      printStderr: (line) => stderrLines.push(line),
      fetch: async () => jsonResponse(200, {
        results: [{
          name: 'clean-flow', outcome: 'created', canonicalId: 'c1', reasons: [],
        }],
      }),
      env: { FAST_BROWSER_REGISTRY_TOKEN: 'tok' },
    },
  );

  assert.equal(confirmCalled, false);
  assert.equal(report.results[0].outcome, 'created');
  assert.ok(stderrLines.some((line) => /1 flow\(s\)/.test(line)));
  assert.ok(stderrLines.some((line) => line.includes('clean-flow') && line.includes('https://example.com')));
});

// --- pull ---

test('pull rejects a signature that does not verify against the pinned key, writes nothing, warns naming the flow, and reports not-ok', async () => {
  const pinned = keyPair();
  const attacker = keyPair(); // signs with a DIFFERENT private key than the pinned public key
  const flow = validFlow({ name: 'tampered' });
  const envelope = signedEnvelope(flow, attacker.privateKey);
  let writeCalled = false;

  const report = await registry(
    { sub: 'pull', json: false, origin: null },
    {
      loadConfig: async () => configuredConfig(pinned.publicKey),
      fetch: async (url) => {
        assert.equal(url, 'https://registry.example.com/v1/pull');
        return jsonResponse(200, { flows: [envelope] });
      },
      listFlowFiles: async () => [],
      writeFlowFile: async () => { writeCalled = true; },
      paths: { flowsDir: '/h/flows', flowsPendingDir: '/h/pending' },
      env: { FAST_BROWSER_REGISTRY_TOKEN: 'tok' },
    },
  );

  assert.equal(writeCalled, false);
  assert.equal(report.ok, false);
  assert.deepEqual(report.results, [{ name: 'tampered', outcome: 'rejected', reason: 'signature-invalid' }]);
  assert.equal(report.warnings.length, 1);
  assert.equal(report.warnings[0].name, 'tampered');
  assert.match(report.warnings[0].reason, /signature/i);
});

test('pull treats a tampered/unparseable artifact as a verify failure: writes nothing, warns, reports not-ok', async () => {
  const pinned = keyPair();
  let writeCalled = false;

  const report = await registry(
    { sub: 'pull', json: false, origin: null },
    {
      loadConfig: async () => configuredConfig(pinned.publicKey),
      fetch: async () => jsonResponse(200, {
        flows: [{ artifact: { name: 'broken', schemaVersion: 999 }, contentHash: 'x', signature: 'y' }],
      }),
      listFlowFiles: async () => [],
      writeFlowFile: async () => { writeCalled = true; },
      paths: { flowsDir: '/h/flows', flowsPendingDir: '/h/pending' },
      env: { FAST_BROWSER_REGISTRY_TOKEN: 'tok' },
    },
  );

  assert.equal(writeCalled, false);
  assert.equal(report.ok, false);
  assert.equal(report.results[0].outcome, 'rejected');
  assert.equal(report.results[0].name, 'broken');
});

test('pull lands a verified new-name flow in the ready tier as valid parseFlow bytes', async () => {
  const pinned = keyPair();
  const flow = validFlow({ name: 'brand-new' });
  const envelope = signedEnvelope(flow, pinned.privateKey);
  const writes = [];

  const report = await registry(
    { sub: 'pull', json: false, origin: null },
    {
      loadConfig: async () => configuredConfig(pinned.publicKey),
      fetch: async () => jsonResponse(200, { flows: [envelope] }),
      listFlowFiles: async () => [],
      writeFlowFile: async (filePath, text) => writes.push({ filePath, text }),
      paths: { flowsDir: '/h/flows', flowsPendingDir: '/h/pending' },
      env: { FAST_BROWSER_REGISTRY_TOKEN: 'tok' },
    },
  );

  assert.equal(report.ok, true);
  assert.deepEqual(report.results, [{ name: 'brand-new', outcome: 'created', tier: 'ready' }]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].filePath, path.join('/h/flows', 'brand-new.flow.json'));
  const written = parseFlow(JSON.parse(writes[0].text));
  assert.deepEqual(written, flow);
});

test('pull unions locator alternates append-only for a same-name/same-stepSignature flow and recomputes its id', async () => {
  const pinned = keyPair();
  const alternateA = { kind: 'role', selector: 'internal:role=button[name="Place order"i]' };
  const alternateB = { kind: 'testid', selector: 'internal:testid=place-order-btn' };

  const local = validFlow({
    name: 'place-order',
    steps: [
      { op: 'goto', url: '/checkout/{plan}' },
      {
        op: 'fill',
        target: target({
          locators: [{ kind: 'role', selector: 'internal:role=textbox[name="Customer"i]' }],
          description: 'Customer',
          role: 'textbox',
          name: 'Customer',
        }),
        value: '{customer}',
      },
      {
        op: 'click', target: target({ locators: [alternateA] }), waitAfter: { networkSettled: true }, mutating: false,
      },
      {
        op: 'expect',
        target: target({
          locators: [{ kind: 'text', selector: 'internal:text="Order placed"' }], description: 'Order placed', role: undefined, name: undefined,
        }),
        state: 'visible',
      },
    ],
  });
  const incoming = validFlow({
    name: 'place-order',
    steps: [
      { op: 'goto', url: '/checkout/{plan}' },
      {
        op: 'fill',
        target: target({
          locators: [{ kind: 'role', selector: 'internal:role=textbox[name="Customer"i]' }],
          description: 'Customer',
          role: 'textbox',
          name: 'Customer',
        }),
        value: '{customer}',
      },
      {
        op: 'click', target: target({ locators: [alternateB] }), waitAfter: { networkSettled: true }, mutating: false,
      },
      {
        op: 'expect',
        target: target({
          locators: [{ kind: 'text', selector: 'internal:text="Order placed"' }], description: 'Order placed', role: undefined, name: undefined,
        }),
        state: 'visible',
      },
    ],
  });
  const envelope = signedEnvelope(incoming, pinned.privateKey);
  const writes = [];

  const report = await registry(
    { sub: 'pull', json: false, origin: null },
    {
      loadConfig: async () => configuredConfig(pinned.publicKey),
      fetch: async () => jsonResponse(200, { flows: [envelope] }),
      listFlowFiles: async () => ['place-order.flow.json'],
      readFlowFile: async (filePath) => {
        assert.equal(filePath, path.join('/h/flows', 'place-order.flow.json'));
        return JSON.stringify(local);
      },
      writeFlowFile: async (filePath, text) => writes.push({ filePath, text }),
      paths: { flowsDir: '/h/flows', flowsPendingDir: '/h/pending' },
      env: { FAST_BROWSER_REGISTRY_TOKEN: 'tok' },
    },
  );

  assert.equal(report.ok, true);
  assert.deepEqual(report.results, [{ name: 'place-order', outcome: 'merged', tier: 'ready' }]);
  assert.equal(writes.length, 1);
  const merged = parseFlow(JSON.parse(writes[0].text));
  // Append-only union: the local alternate stays first, the incoming one is
  // appended after it -- never reordered, never dropped.
  assert.deepEqual(merged.steps[2].target.locators, [alternateA, alternateB]);
  // id is recomputed from the merged content, not carried over from either side.
  assert.notEqual(merged.id, local.id);
  assert.notEqual(merged.id, incoming.id);
  const { id, provenance, ...content } = merged;
  assert.equal(merged.id, flowId({ ...content, provenance }));
});

test('pull skips a same-name/different-stepSignature flow, warns naming BOTH flow ids, and never overwrites the local file', async () => {
  const pinned = keyPair();
  const local = validFlow({ name: 'place-order' });
  const incoming = validFlow({
    name: 'place-order',
    steps: [
      { op: 'goto', url: '/checkout/{plan}' },
      {
        op: 'click',
        target: target({ description: 'Cancel order', role: 'button', name: 'Cancel order' }),
        waitAfter: { networkSettled: true },
        mutating: true,
      },
    ],
  });
  const envelope = signedEnvelope(incoming, pinned.privateKey);
  let writeCalled = false;

  const report = await registry(
    { sub: 'pull', json: false, origin: null },
    {
      loadConfig: async () => configuredConfig(pinned.publicKey),
      fetch: async () => jsonResponse(200, { flows: [envelope] }),
      listFlowFiles: async () => ['place-order.flow.json'],
      readFlowFile: async () => JSON.stringify(local),
      writeFlowFile: async () => { writeCalled = true; },
      paths: { flowsDir: '/h/flows', flowsPendingDir: '/h/pending' },
      env: { FAST_BROWSER_REGISTRY_TOKEN: 'tok' },
    },
  );

  assert.equal(writeCalled, false);
  // A content-shape disagreement is not a trust failure -- overall pull
  // status stays ok; only the individual flow is skipped.
  assert.equal(report.ok, true);
  assert.deepEqual(report.results, [{ name: 'place-order', outcome: 'skipped', reason: 'signature-conflict' }]);
  assert.equal(report.warnings.length, 1);
  assert.ok(report.warnings[0].reason.includes(local.id));
  assert.ok(report.warnings[0].reason.includes(incoming.id));
});

// Review fix round 1, Critical #2: origin equality is a merge precondition,
// checked before anything content-shaped. A same-named flow pulled from a
// DIFFERENT origin must never merge into (or overwrite) a local flow just
// because the name matches.
test('pull skips a same-name/different-origin flow, warns naming BOTH origins, and never overwrites the local file', async () => {
  const pinned = keyPair();
  const local = validFlow({ name: 'place-order', origin: 'https://bank.example.com' });
  const incoming = validFlow({ name: 'place-order', origin: 'https://evil.example.com' });
  const envelope = signedEnvelope(incoming, pinned.privateKey);
  let writeCalled = false;

  const report = await registry(
    { sub: 'pull', json: false, origin: null },
    {
      loadConfig: async () => configuredConfig(pinned.publicKey),
      fetch: async () => jsonResponse(200, { flows: [envelope] }),
      listFlowFiles: async () => ['place-order.flow.json'],
      readFlowFile: async () => JSON.stringify(local),
      writeFlowFile: async () => { writeCalled = true; },
      paths: { flowsDir: '/h/flows', flowsPendingDir: '/h/pending' },
      env: { FAST_BROWSER_REGISTRY_TOKEN: 'tok' },
    },
  );

  assert.equal(writeCalled, false);
  assert.equal(report.ok, true);
  assert.deepEqual(report.results, [{ name: 'place-order', outcome: 'skipped', reason: 'origin-conflict' }]);
  assert.equal(report.warnings.length, 1);
  assert.ok(report.warnings[0].reason.includes('https://bank.example.com'));
  assert.ok(report.warnings[0].reason.includes('https://evil.example.com'));
});

// Review fix round 1, Critical #1: stepSignature equality alone is NOT
// enough to allow a merge -- a role/name-less CSS target collapses two
// DIFFERENT elements onto the identical signature tuple. The reviewer's
// exact reproduction: `#confirm` vs `#delete-account`.
test('pull refuses to merge two role/name-less CSS targets that share a stepSignature but point at different elements', async () => {
  const pinned = keyPair();
  const cssStep = (selector) => ({ op: 'click', target: { locators: [{ kind: 'css', selector }] } });
  const local = validFlow({
    name: 'place-order',
    steps: [{ op: 'goto', url: '/checkout/{plan}' }, cssStep('#confirm')],
  });
  const incoming = validFlow({
    name: 'place-order',
    steps: [{ op: 'goto', url: '/checkout/{plan}' }, cssStep('#delete-account')],
  });
  // Same stepSignature (both targets carry no role/name) despite pointing
  // at completely different elements.
  assert.equal(stepSignatureOf(local), stepSignatureOf(incoming));

  const envelope = signedEnvelope(incoming, pinned.privateKey);
  let writeCalled = false;

  const report = await registry(
    { sub: 'pull', json: false, origin: null },
    {
      loadConfig: async () => configuredConfig(pinned.publicKey),
      fetch: async () => jsonResponse(200, { flows: [envelope] }),
      listFlowFiles: async () => ['place-order.flow.json'],
      readFlowFile: async () => JSON.stringify(local),
      writeFlowFile: async () => { writeCalled = true; },
      paths: { flowsDir: '/h/flows', flowsPendingDir: '/h/pending' },
      env: { FAST_BROWSER_REGISTRY_TOKEN: 'tok' },
    },
  );

  assert.equal(writeCalled, false);
  assert.equal(report.ok, true);
  assert.deepEqual(report.results, [{ name: 'place-order', outcome: 'skipped', reason: 'anchor-conflict' }]);
  assert.equal(report.warnings.length, 1);
  assert.ok(report.warnings[0].reason.includes(local.id));
  assert.ok(report.warnings[0].reason.includes(incoming.id));
});

// Review fix round 1, Critical #1 (second reproduction): `drag`'s `to` is
// not part of stepSignature at all -- two drags with the SAME source but a
// DIFFERENT drop destination still share stepSignature, and must still be
// refused a merge.
test('pull refuses to merge two drag steps with the same source but a different drop destination', async () => {
  const pinned = keyPair();
  const dragStep = (to) => ({
    op: 'drag',
    target: target({ role: 'img', name: 'Card' }),
    to: { locators: [{ kind: 'css', selector: to }] },
  });
  const local = validFlow({
    name: 'place-order',
    steps: [{ op: 'goto', url: '/checkout/{plan}' }, dragStep('#slot-a')],
  });
  const incoming = validFlow({
    name: 'place-order',
    steps: [{ op: 'goto', url: '/checkout/{plan}' }, dragStep('#slot-b')],
  });
  assert.equal(stepSignatureOf(local), stepSignatureOf(incoming));

  const envelope = signedEnvelope(incoming, pinned.privateKey);
  let writeCalled = false;

  const report = await registry(
    { sub: 'pull', json: false, origin: null },
    {
      loadConfig: async () => configuredConfig(pinned.publicKey),
      fetch: async () => jsonResponse(200, { flows: [envelope] }),
      listFlowFiles: async () => ['place-order.flow.json'],
      readFlowFile: async () => JSON.stringify(local),
      writeFlowFile: async () => { writeCalled = true; },
      paths: { flowsDir: '/h/flows', flowsPendingDir: '/h/pending' },
      env: { FAST_BROWSER_REGISTRY_TOKEN: 'tok' },
    },
  );

  assert.equal(writeCalled, false);
  assert.deepEqual(report.results, [{ name: 'place-order', outcome: 'skipped', reason: 'anchor-conflict' }]);
});

// The positive counterpart to the two anchor-conflict tests above: a
// SAME-selector role/name-less CSS target (the shape the anchor check must
// still allow through) merges exactly as before.
test('pull merges two role/name-less CSS targets that point at the SAME element', async () => {
  const pinned = keyPair();
  const cssStep = (selector) => ({ op: 'click', target: { locators: [{ kind: 'css', selector }] } });
  const local = validFlow({
    name: 'place-order',
    steps: [{ op: 'goto', url: '/checkout/{plan}' }, cssStep('#confirm')],
  });
  const incoming = validFlow({
    name: 'place-order',
    steps: [{ op: 'goto', url: '/checkout/{plan}' }, cssStep('#confirm')],
  });
  const envelope = signedEnvelope(incoming, pinned.privateKey);
  const writes = [];

  const report = await registry(
    { sub: 'pull', json: false, origin: null },
    {
      loadConfig: async () => configuredConfig(pinned.publicKey),
      fetch: async () => jsonResponse(200, { flows: [envelope] }),
      listFlowFiles: async () => ['place-order.flow.json'],
      readFlowFile: async () => JSON.stringify(local),
      writeFlowFile: async (filePath, text) => writes.push({ filePath, text }),
      paths: { flowsDir: '/h/flows', flowsPendingDir: '/h/pending' },
      env: { FAST_BROWSER_REGISTRY_TOKEN: 'tok' },
    },
  );

  assert.deepEqual(report.results, [{ name: 'place-order', outcome: 'merged', tier: 'ready' }]);
  assert.equal(writes.length, 1);
  parseFlow(JSON.parse(writes[0].text)); // parseFlow-valid bytes
});

// Review fix round 1, Important #3 (ruling): tier is directory location --
// a pulled flow whose CONTENT is 'pending' (mutating sideEffects, or a js
// step) must land in flowsPendingDir, never flowsDir, so it cannot replay
// without going through `flows approve` on this machine first.
test('pull routes a mutating-sideEffects flow to the pending tier, not ready, with an approve-needed note', async () => {
  const pinned = keyPair();
  const flow = validFlow({ name: 'delete-account', sideEffects: 'mutating' });
  const envelope = signedEnvelope(flow, pinned.privateKey);
  const writes = [];

  const report = await registry(
    { sub: 'pull', json: false, origin: null },
    {
      loadConfig: async () => configuredConfig(pinned.publicKey),
      fetch: async () => jsonResponse(200, { flows: [envelope] }),
      listFlowFiles: async () => [],
      writeFlowFile: async (filePath, text) => writes.push({ filePath, text }),
      paths: { flowsDir: '/h/flows', flowsPendingDir: '/h/pending' },
      env: { FAST_BROWSER_REGISTRY_TOKEN: 'tok' },
    },
  );

  assert.equal(report.ok, true);
  assert.equal(report.results[0].tier, 'pending');
  assert.match(report.results[0].note, /flows approve/);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].filePath, path.join('/h/pending', 'delete-account.flow.json'));
  assert.deepEqual(parseFlow(JSON.parse(writes[0].text)), flow); // parseFlow-valid bytes
});

test('pull routes a js-step flow to the pending tier even when sideEffects is read-only', async () => {
  const pinned = keyPair();
  const flow = validFlow({
    name: 'run-script',
    steps: [
      { op: 'goto', url: '/checkout/{plan}' },
      { op: 'js', sha256: null, args: {} },
    ],
  });
  const envelope = signedEnvelope(flow, pinned.privateKey);
  const writes = [];

  const report = await registry(
    { sub: 'pull', json: false, origin: null },
    {
      loadConfig: async () => configuredConfig(pinned.publicKey),
      fetch: async () => jsonResponse(200, { flows: [envelope] }),
      listFlowFiles: async () => [],
      writeFlowFile: async (filePath, text) => writes.push({ filePath, text }),
      paths: { flowsDir: '/h/flows', flowsPendingDir: '/h/pending' },
      env: { FAST_BROWSER_REGISTRY_TOKEN: 'tok' },
    },
  );

  assert.equal(report.results[0].tier, 'pending');
  assert.equal(writes[0].filePath, path.join('/h/pending', 'run-script.flow.json'));
});

test('pull still routes a safe (read-only, no js step) flow straight to the ready tier', async () => {
  const pinned = keyPair();
  const flow = validFlow({ name: 'view-order' });
  const envelope = signedEnvelope(flow, pinned.privateKey);
  const writes = [];

  const report = await registry(
    { sub: 'pull', json: false, origin: null },
    {
      loadConfig: async () => configuredConfig(pinned.publicKey),
      fetch: async () => jsonResponse(200, { flows: [envelope] }),
      listFlowFiles: async () => [],
      writeFlowFile: async (filePath, text) => writes.push({ filePath, text }),
      paths: { flowsDir: '/h/flows', flowsPendingDir: '/h/pending' },
      env: { FAST_BROWSER_REGISTRY_TOKEN: 'tok' },
    },
  );

  assert.deepEqual(report.results, [{ name: 'view-order', outcome: 'created', tier: 'ready' }]);
  assert.equal(writes[0].filePath, path.join('/h/flows', 'view-order.flow.json'));
});

// --- search ---

test('search renders the lexical mode a keyless registry reports', async () => {
  const { publicKey } = keyPair();
  const report = await registry(
    { sub: 'search', intent: 'log in', origin: null, json: false },
    {
      loadConfig: async () => configuredConfig(publicKey),
      fetch: async (url) => {
        assert.equal(url, 'https://registry.example.com/v1/search?intent=log+in');
        return jsonResponse(200, { mode: 'lexical', results: [] });
      },
      env: { FAST_BROWSER_REGISTRY_TOKEN: 'tok' },
    },
  );
  assert.equal(report.mode, 'lexical');
  assert.deepEqual(report.results, []);
});

test('search renders the semantic mode a Voyage-backed registry reports', async () => {
  const { publicKey } = keyPair();
  const flow = validFlow({ name: 'log-in' });
  const envelope = { artifact: flow, contentHash: 'x', signature: 'y' };
  const report = await registry(
    {
      sub: 'search', intent: 'log in', origin: 'https://example.com', json: false,
    },
    {
      loadConfig: async () => configuredConfig(publicKey),
      fetch: async (url) => {
        assert.equal(url, 'https://registry.example.com/v1/search?intent=log+in&origin=https%3A%2F%2Fexample.com');
        return jsonResponse(200, { mode: 'semantic', results: [{ envelope, score: 0.91, args: flow.args }] });
      },
      env: { FAST_BROWSER_REGISTRY_TOKEN: 'tok' },
    },
  );
  assert.equal(report.mode, 'semantic');
  assert.equal(report.results[0].score, 0.91);
  assert.equal(report.results[0].envelope.artifact.name, 'log-in');
});

// --- auth ---

test('a missing FAST_BROWSER_REGISTRY_TOKEN raises a LifecycleError naming the env var, before any network call', async () => {
  const { publicKey } = keyPair();
  let fetchCalled = false;
  await assert.rejects(
    registry(
      { sub: 'pull', json: true, origin: null },
      {
        loadConfig: async () => configuredConfig(publicKey),
        fetch: async () => { fetchCalled = true; return jsonResponse(200, { flows: [] }); },
        listFlowFiles: async () => [],
        env: {},
      },
    ),
    (error) => error.name === 'LifecycleError' && /FAST_BROWSER_REGISTRY_TOKEN/.test(error.message),
  );
  assert.equal(fetchCalled, false);
});

test('/health calls (init, status) never require a token', async () => {
  const { publicKey } = keyPair();
  const report = await registry(
    { sub: 'status', json: false },
    {
      loadConfig: async () => configuredConfig(publicKey),
      fetch: async () => jsonResponse(200, {
        ok: true, version: '1.0.0', publicKey, clustering: false,
      }),
      env: {},
    },
  );
  assert.equal(report.hasToken, false);
  assert.equal(report.reachable, true);
});

// --- status ---

test('status reports unconfigured state without contacting the network', async () => {
  let fetchCalled = false;
  const report = await registry(
    { sub: 'status', json: false },
    {
      loadConfig: async () => baseConfig(),
      fetch: async () => { fetchCalled = true; return jsonResponse(200, {}); },
      env: { FAST_BROWSER_REGISTRY_TOKEN: 'tok' },
    },
  );
  assert.equal(fetchCalled, false);
  assert.equal(report.configured, false);
  assert.equal(report.fingerprint, null);
});

test('status degrades to unreachable rather than throwing when the registry cannot be contacted', async () => {
  const { publicKey } = keyPair();
  const report = await registry(
    { sub: 'status', json: false },
    {
      loadConfig: async () => configuredConfig(publicKey),
      fetch: async () => { throw new Error('ECONNREFUSED'); },
      env: { FAST_BROWSER_REGISTRY_TOKEN: 'tok' },
    },
  );
  assert.equal(report.configured, true);
  assert.equal(report.reachable, false);
  assert.equal(report.health, null);
});

// --- unconfigured registry ---

test('push/pull/search require a configured registry, naming `registry init` in the error', async () => {
  for (const sub of ['push', 'pull', 'search']) {
    await assert.rejects(
      registry(
        {
          sub, json: true, intent: 'x', origin: null, yes: false,
        },
        { loadConfig: async () => baseConfig(), env: { FAST_BROWSER_REGISTRY_TOKEN: 'tok' } },
      ),
      (error) => error.name === 'LifecycleError' && /registry init/.test(error.message),
    );
  }
});
