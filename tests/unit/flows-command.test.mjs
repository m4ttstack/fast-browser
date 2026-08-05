import assert from 'node:assert/strict';
import {
  mkdir, mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { flows } from '../../lib/commands/flows.mjs';
import { matchFlows } from '../../lib/flows/match.mjs';
import { resolvePaths } from '../../lib/core/paths.mjs';

// --- fixture builder: a minimal, schema-valid flow artifact (artifact.mjs's
// parseFlow shape). Real `id`/`provenance` correctness is not exercised
// here -- these tests are about the CLI command's own orchestration, not
// artifact.mjs's own validation (covered by flows-artifact.test.mjs). ---

function validFlow(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'a'.repeat(64),
    name: 'log-in',
    description: 'Logs into the app.',
    origin: 'https://example.com',
    urlPattern: '/app',
    sideEffects: 'read-only',
    args: {},
    result: { kind: 'completion', keys: [] },
    steps: [{ op: 'goto', url: '/app' }],
    provenance: {
      compiledAt: '2026-01-01T00:00:00.000Z',
      traceDir: 'trace-1',
      seqRange: [0, 1],
      productVersion: '0.1.0-test',
      successRuns: 0,
      failStreak: 0,
      lastHealed: null,
    },
    ...overrides,
  };
}

async function tempPaths(t) {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-flows-cmd-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  return resolvePaths({ homeDir, pluginRoot: '/plugin' });
}

test('exports a dependency-injected flows command function', () => {
  assert.equal(typeof flows, 'function');
});

// --- find ---

test('find sweeps first, then matches loaded artifacts and embeds the flow-runner invocation', async () => {
  const paths = {
    flowsDir: '/h/.fast-browser/flows',
    flowsPendingDir: '/h/.fast-browser/flows-pending',
    macrosDir: '/h/.fast-browser/macros',
  };
  const readyFlow = validFlow({
    name: 'log-in',
    args: { username: { type: 'string', required: true } },
  });
  const filePath = path.join(paths.flowsDir, 'log-in.flow.json');
  const events = [];

  const report = await flows(
    {
      sub: 'find', intent: 'log in', origin: null, url: null, json: true,
    },
    {
      paths,
      sweep: async (args) => {
        events.push('sweep');
        assert.equal(args.paths, paths);
        return {};
      },
      listFlowFiles: async (dir) => (dir === paths.flowsDir ? ['log-in.flow.json'] : []),
      readFlowFile: async (filePathArg) => {
        assert.equal(filePathArg, filePath);
        return JSON.stringify(readyFlow);
      },
      matchFlows: (args) => {
        events.push('match');
        assert.deepEqual(args.flows, [{ flow: readyFlow, tier: 'ready' }]);
        assert.equal(args.intent, 'log in');
        return [{
          flow: readyFlow, score: 200, runnable: true, reasons: [],
        }];
      },
    },
  );

  assert.deepEqual(events, ['sweep', 'match']);
  assert.deepEqual(report, {
    command: 'flows',
    sub: 'find',
    candidates: [{
      name: 'log-in',
      description: readyFlow.description,
      origin: readyFlow.origin,
      sideEffects: 'read-only',
      runnable: true,
      reasons: [],
      invocation: {
        tool: 'browser_run_code_unsafe',
        arguments: {
          filename: path.join(paths.macrosDir, 'flow-runner.js'),
          args: { flow: readyFlow, args: { username: '<REQUIRED: string>' } },
        },
      },
    }],
    warnings: [],
  });
});

// Load-bearing: tier must come from WHICH DIRECTORY the artifact was loaded
// from, never from flowTier(flow). A mutating flow is content-"pending"
// forever under flowTier, but once its file has been moved into flowsDir
// (approved), find must report it runnable.
test('tier is derived from which directory a flow was loaded from, not flowTier(flow)', async () => {
  const paths = {
    flowsDir: '/h/flows', flowsPendingDir: '/h/pending', macrosDir: '/h/macros',
  };
  const mutatingApprovedFlow = validFlow({ name: 'place-order', sideEffects: 'mutating' });

  const report = await flows(
    {
      sub: 'find', intent: 'place order', origin: null, url: null, json: true,
    },
    {
      paths,
      sweep: async () => ({}),
      listFlowFiles: async (dir) => (dir === paths.flowsDir ? ['place-order.flow.json'] : []),
      readFlowFile: async () => JSON.stringify(mutatingApprovedFlow),
      matchFlows,
    },
  );

  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0].runnable, true);
  assert.deepEqual(report.candidates[0].reasons, []);
});

test('a matching flow still in flows-pending reports runnable: false with the approve reason', async () => {
  const paths = {
    flowsDir: '/h/flows', flowsPendingDir: '/h/pending', macrosDir: '/h/macros',
  };
  const pendingFlow = validFlow({ name: 'log-in' });

  const report = await flows(
    {
      sub: 'find', intent: 'log in', origin: null, url: null, json: true,
    },
    {
      paths,
      sweep: async () => ({}),
      listFlowFiles: async (dir) => (dir === paths.flowsPendingDir ? ['log-in.flow.json'] : []),
      readFlowFile: async () => JSON.stringify(pendingFlow),
      matchFlows,
    },
  );

  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0].runnable, false);
  assert.match(report.candidates[0].reasons[0], /flows approve log-in/);
});

test('find reports unparseable artifact files as warnings without crashing', async () => {
  const paths = {
    flowsDir: '/h/flows', flowsPendingDir: '/h/pending', macrosDir: '/h/macros',
  };

  const report = await flows(
    {
      sub: 'find', intent: 'log in', origin: null, url: null, json: true,
    },
    {
      paths,
      sweep: async () => ({}),
      listFlowFiles: async (dir) => (dir === paths.flowsDir ? ['broken.flow.json'] : []),
      readFlowFile: async () => 'not json',
      matchFlows: () => [],
    },
  );

  assert.equal(report.candidates.length, 0);
  assert.equal(report.warnings.length, 1);
  assert.deepEqual(report.warnings[0].file, 'broken.flow.json');
  assert.equal(report.warnings[0].tier, 'ready');
  assert.match(report.warnings[0].reason, /^invalid:/);
});

test('find reports an unreadable artifact file distinctly from an invalid one', async () => {
  const paths = {
    flowsDir: '/h/flows', flowsPendingDir: '/h/pending', macrosDir: '/h/macros',
  };

  const report = await flows(
    {
      sub: 'find', intent: 'log in', origin: null, url: null, json: true,
    },
    {
      paths,
      sweep: async () => ({}),
      listFlowFiles: async (dir) => (dir === paths.flowsDir ? ['gone.flow.json'] : []),
      readFlowFile: async () => {
        const error = new Error('EACCES');
        error.code = 'EACCES';
        throw error;
      },
      matchFlows: () => [],
    },
  );

  assert.deepEqual(report.warnings, [{ file: 'gone.flow.json', tier: 'ready', reason: 'unreadable' }]);
});

// --- list ---

test('list reports both tiers with health, ready sorted before pending', async () => {
  const paths = { flowsDir: '/h/flows', flowsPendingDir: '/h/pending' };
  const ready = validFlow({
    name: 'b-flow',
    provenance: { ...validFlow().provenance, successRuns: 3, failStreak: 1 },
  });
  const pending = validFlow({ name: 'a-flow', sideEffects: 'mutating' });

  const report = await flows(
    { sub: 'list', json: true },
    {
      paths,
      listFlowFiles: async (dir) => (dir === paths.flowsDir ? ['b-flow.flow.json'] : ['a-flow.flow.json']),
      readFlowFile: async (filePath) => (
        filePath.includes('b-flow') ? JSON.stringify(ready) : JSON.stringify(pending)
      ),
    },
  );

  assert.deepEqual(report, {
    command: 'flows',
    sub: 'list',
    flows: [
      {
        tier: 'ready',
        name: 'b-flow',
        description: ready.description,
        origin: ready.origin,
        health: { successRuns: 3, failStreak: 1 },
      },
      {
        tier: 'pending',
        name: 'a-flow',
        description: pending.description,
        origin: pending.origin,
        health: { successRuns: 0, failStreak: 0 },
      },
    ],
  });
});

// --- compile ---

test('compile runs an explicit sweep and returns its full result verbatim', async () => {
  const sweepResult = {
    compiled: [{ name: 'x', tier: 'ready' }],
    updated: [{ name: 'y', successRuns: 2, failStreak: 0 }],
    sessionsProcessed: 3,
    cursor: { 'trace-1': { lines: 5, provenanceLines: 5 } },
    skippedBySession: {
      'trace-2': [
        { reason: 'unreadable', seqRange: [null, null] },
        { reason: 'invalid: too short to be a flow', seqRange: [0, 1] },
      ],
    },
    replaysSeen: 4,
  };
  const paths = { flowsDir: '/h/flows', flowsPendingDir: '/h/pending' };
  let received;

  const report = await flows(
    { sub: 'compile', json: true },
    {
      paths,
      sweep: async (args) => {
        received = args;
        return sweepResult;
      },
    },
  );

  assert.equal(received.paths, paths);
  assert.deepEqual(report, { command: 'flows', sub: 'compile', ...sweepResult });
});

// --- approve ---

test('approve refuses without interactive confirmation, for --json and for a non-TTY stdin alike', async () => {
  const attempts = [
    { request: { sub: 'approve', name: 'log-in', json: true }, interactive: true },
    { request: { sub: 'approve', name: 'log-in', json: false }, interactive: false },
  ];
  for (const { request, interactive } of attempts) {
    await assert.rejects(
      flows(request, {
        paths: { flowsPendingDir: '/h/pending', flowsDir: '/h/flows' },
        interactive,
        readFlowFile: async () => { throw new Error('must not read before the interactive gate'); },
        moveFlow: async () => { throw new Error('must not move'); },
      }),
      (error) => error.name === 'LifecycleError' && /interactive/i.test(error.message),
    );
  }
});

test('approve fails when no pending flow exists under that name', async () => {
  await assert.rejects(
    flows(
      { sub: 'approve', name: 'ghost', json: false },
      {
        paths: { flowsPendingDir: '/h/pending', flowsDir: '/h/flows' },
        interactive: true,
        readFlowFile: async () => {
          const error = new Error('nope');
          error.code = 'ENOENT';
          throw error;
        },
      },
    ),
    (error) => error.name === 'LifecycleError' && /no pending flow/i.test(error.message),
  );
});

test('approve refuses when a flow already exists in the ready tier under that name', async () => {
  const pendingFlow = validFlow({ name: 'log-in' });
  await assert.rejects(
    flows(
      { sub: 'approve', name: 'log-in', json: false },
      {
        paths: { flowsPendingDir: '/h/pending', flowsDir: '/h/flows' },
        interactive: true,
        readFlowFile: async () => JSON.stringify(pendingFlow),
        confirmApprove: async () => { throw new Error('must not prompt on collision'); },
        moveFlow: async () => { throw new Error('must not move on collision'); },
      },
    ),
    (error) => error.name === 'LifecycleError' && /already exists/i.test(error.message),
  );
});

test('approve prints flow details, requires typed APPROVE, then moves pending to ready unchanged', async () => {
  const pendingFlow = validFlow({
    name: 'log-in',
    args: { username: { type: 'string', required: true } },
    steps: [
      { op: 'goto', url: '/login' },
      { op: 'click', target: { locators: [] } },
    ],
  });
  const prints = [];
  const moved = [];
  let confirmCalled = false;

  const report = await flows(
    { sub: 'approve', name: 'log-in', json: false },
    {
      paths: { flowsPendingDir: '/h/pending', flowsDir: '/h/flows' },
      interactive: true,
      readFlowFile: async (filePath) => {
        if (filePath === '/h/flows/log-in.flow.json') {
          const error = new Error('nope');
          error.code = 'ENOENT';
          throw error;
        }
        return JSON.stringify(pendingFlow);
      },
      print: (line) => prints.push(line),
      confirmApprove: async () => {
        confirmCalled = true;
        return true;
      },
      moveFlow: async (from, to) => moved.push([from, to]),
    },
  );

  assert.equal(confirmCalled, true);
  assert.deepEqual(moved, [['/h/pending/log-in.flow.json', '/h/flows/log-in.flow.json']]);
  assert.ok(prints.some((line) => line.includes('log-in')));
  assert.ok(prints.some((line) => line.includes(pendingFlow.origin)));
  assert.ok(prints.some((line) => line.includes('read-only')));
  assert.ok(prints.some((line) => line.includes('username')));
  assert.deepEqual(report, {
    command: 'flows', sub: 'approve', name: 'log-in', moved: true,
  });
});

test('approve fails when confirmation is not exactly APPROVE', async () => {
  const pendingFlow = validFlow({ name: 'log-in' });
  await assert.rejects(
    flows(
      { sub: 'approve', name: 'log-in', json: false },
      {
        paths: { flowsPendingDir: '/h/pending', flowsDir: '/h/flows' },
        interactive: true,
        readFlowFile: async (filePath) => {
          if (filePath === '/h/flows/log-in.flow.json') {
            const error = new Error('nope');
            error.code = 'ENOENT';
            throw error;
          }
          return JSON.stringify(pendingFlow);
        },
        print: () => {},
        confirmApprove: async () => false,
        moveFlow: async () => { throw new Error('must not move without confirmation'); },
      },
    ),
    (error) => error.name === 'LifecycleError' && /APPROVE/.test(error.message),
  );
});

// --- reject ---

test('reject fails when no pending flow exists under that name', async () => {
  await assert.rejects(
    flows(
      { sub: 'reject', name: 'ghost', json: false },
      {
        paths: { flowsPendingDir: '/h/pending' },
        readFlowFile: async () => {
          const error = new Error('nope');
          error.code = 'ENOENT';
          throw error;
        },
      },
    ),
    (error) => error.name === 'LifecycleError' && /no pending flow/i.test(error.message),
  );
});

test('reject deletes the pending flow and appends a ledger line in the rejected-macros.md format', async () => {
  const deleted = [];
  const appended = [];

  const report = await flows(
    { sub: 'reject', name: 'log-in', json: false },
    {
      paths: { flowsPendingDir: '/h/pending', rejectedFlowsFile: '/h/rejected-flows.md', dataDir: '/h' },
      readFlowFile: async () => JSON.stringify(validFlow({ name: 'log-in' })),
      deleteFlow: async (filePath) => deleted.push(filePath),
      appendRejectedFlow: async (paths, line) => appended.push([paths.rejectedFlowsFile, line]),
      now: () => new Date('2026-08-05T12:00:00.000Z'),
    },
  );

  assert.deepEqual(deleted, ['/h/pending/log-in.flow.json']);
  assert.equal(appended.length, 1);
  assert.equal(appended[0][0], '/h/rejected-flows.md');
  assert.equal(appended[0][1], 'log-in | 2026-08-05 | rejected via CLI');
  assert.deepEqual(report, {
    command: 'flows', sub: 'reject', name: 'log-in', rejected: true,
  });
});

// --- name validation: guards against path traversal through the CLI's
// `<name>` positional before it is ever joined into a filesystem path ---

test('approve and reject refuse a non-kebab-case name before touching any file', async () => {
  for (const sub of ['approve', 'reject']) {
    await assert.rejects(
      flows(
        { sub, name: '../../etc/passwd', json: false },
        {
          paths: { flowsPendingDir: '/h/pending', flowsDir: '/h/flows' },
          interactive: true,
          readFlowFile: async () => { throw new Error('must not touch the filesystem'); },
          deleteFlow: async () => { throw new Error('must not touch the filesystem'); },
        },
      ),
      (error) => error.name === 'LifecycleError',
    );
  }
});

// --- real-fs: move/ledger semantics against a real tmpdir home, matching
// flows-sweep.test.mjs's own real-filesystem test style ---

test('[real fs] approve moves the file from flows-pending to flows, content unchanged', async (t) => {
  const paths = await tempPaths(t);
  await mkdir(paths.flowsPendingDir, { recursive: true });
  const flow = validFlow({ name: 'log-in' });
  const raw = JSON.stringify(flow, null, 2);
  await writeFile(path.join(paths.flowsPendingDir, 'log-in.flow.json'), raw);

  const report = await flows(
    { sub: 'approve', name: 'log-in', json: false },
    {
      paths, interactive: true, confirmApprove: async () => true, print: () => {},
    },
  );

  assert.deepEqual(report, {
    command: 'flows', sub: 'approve', name: 'log-in', moved: true,
  });
  assert.equal(
    await readFile(path.join(paths.flowsDir, 'log-in.flow.json'), 'utf8'),
    raw,
  );
  await assert.rejects(readFile(path.join(paths.flowsPendingDir, 'log-in.flow.json')));
});

test('[real fs] approve refuses when a flow already exists in the ready tier, leaving pending untouched', async (t) => {
  const paths = await tempPaths(t);
  await mkdir(paths.flowsPendingDir, { recursive: true });
  await mkdir(paths.flowsDir, { recursive: true });
  const flow = validFlow({ name: 'log-in' });
  await writeFile(path.join(paths.flowsPendingDir, 'log-in.flow.json'), JSON.stringify(flow));
  await writeFile(path.join(paths.flowsDir, 'log-in.flow.json'), JSON.stringify(flow));

  await assert.rejects(
    flows(
      { sub: 'approve', name: 'log-in', json: false },
      {
        paths, interactive: true, confirmApprove: async () => true, print: () => {},
      },
    ),
    (error) => error.name === 'LifecycleError' && /already exists/i.test(error.message),
  );
  assert.ok(await readFile(path.join(paths.flowsPendingDir, 'log-in.flow.json'), 'utf8'));
});

test('[real fs] reject deletes the pending file and creates the ledger fresh', async (t) => {
  const paths = await tempPaths(t);
  await mkdir(paths.flowsPendingDir, { recursive: true });
  const flow = validFlow({ name: 'log-in' });
  await writeFile(path.join(paths.flowsPendingDir, 'log-in.flow.json'), JSON.stringify(flow));

  const report = await flows(
    { sub: 'reject', name: 'log-in', json: false },
    { paths, now: () => new Date('2026-08-05T00:00:00.000Z') },
  );

  assert.deepEqual(report, {
    command: 'flows', sub: 'reject', name: 'log-in', rejected: true,
  });
  await assert.rejects(readFile(path.join(paths.flowsPendingDir, 'log-in.flow.json')));
  const ledger = await readFile(paths.rejectedFlowsFile, 'utf8');
  assert.equal(ledger, 'log-in | 2026-08-05 | rejected via CLI\n');
});

test('[real fs] reject appends to an existing ledger rather than overwriting it', async (t) => {
  const paths = await tempPaths(t);
  await mkdir(paths.flowsPendingDir, { recursive: true });
  await mkdir(paths.dataDir, { recursive: true });
  await writeFile(paths.rejectedFlowsFile, 'old-flow | 2026-01-01 | rejected via CLI\n');
  const flow = validFlow({ name: 'log-in' });
  await writeFile(path.join(paths.flowsPendingDir, 'log-in.flow.json'), JSON.stringify(flow));

  await flows(
    { sub: 'reject', name: 'log-in', json: false },
    { paths, now: () => new Date('2026-08-05T00:00:00.000Z') },
  );

  const ledger = await readFile(paths.rejectedFlowsFile, 'utf8');
  assert.equal(
    ledger,
    'old-flow | 2026-01-01 | rejected via CLI\nlog-in | 2026-08-05 | rejected via CLI\n',
  );
});
