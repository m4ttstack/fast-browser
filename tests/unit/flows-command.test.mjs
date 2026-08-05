import assert from 'node:assert/strict';
import {
  lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile,
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

// Fix round 1, item 5: the invocation's arg placeholder must be derived
// from each arg's own `required`/`type`, never a single hardcoded literal
// applied uniformly -- otherwise the placeholder could lie once an
// optional arg (or a future non-string type) exists.
test('find derives each arg placeholder from its own required flag and type', async () => {
  const paths = {
    flowsDir: '/h/flows', flowsPendingDir: '/h/pending', macrosDir: '/h/macros',
  };
  const flow = validFlow({
    name: 'search',
    args: {
      query: { type: 'string', required: true },
      filter: { type: 'string', required: false },
    },
  });

  const report = await flows(
    {
      sub: 'find', intent: 'search', origin: null, url: null, json: true,
    },
    {
      paths,
      sweep: async () => ({}),
      listFlowFiles: async (dir) => (dir === paths.flowsDir ? ['search.flow.json'] : []),
      readFlowFile: async () => JSON.stringify(flow),
      matchFlows: () => [{
        flow, score: 100, runnable: true, reasons: [],
      }],
    },
  );

  assert.deepEqual(report.candidates[0].invocation.arguments.args.args, {
    query: '<REQUIRED: string>',
    filter: '<OPTIONAL: string>',
  });
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
        paths: { flowsPendingDir: '/h/pending', flowsDir: '/h/flows', dataDir: '/h' },
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
        paths: { flowsPendingDir: '/h/pending', flowsDir: '/h/flows', dataDir: '/h' },
        interactive: true,
        readFlowFile: async () => JSON.stringify(pendingFlow),
        pathExists: async (filePath) => filePath === '/h/flows/log-in.flow.json',
        confirmApprove: async () => { throw new Error('must not prompt on collision'); },
        moveFlow: async () => { throw new Error('must not move on collision'); },
      },
    ),
    (error) => error.name === 'LifecycleError' && /already exists/i.test(error.message),
  );
});

// Fail-closed collision probe (fix round 1, item 3): a target that exists
// but cannot be *read* (a directory, a permission-denied file) must still
// count as a collision. The old design probed via `readFlowFile`, so a
// thrown read failure at the ready path was indistinguishable from "does
// not exist" and `moveFlow` would have renamed straight over it.
test('approve treats any existing entry at the ready path as a collision, even one it cannot read', async () => {
  const pendingFlow = validFlow({ name: 'log-in' });
  await assert.rejects(
    flows(
      { sub: 'approve', name: 'log-in', json: false },
      {
        paths: { flowsPendingDir: '/h/pending', flowsDir: '/h/flows', dataDir: '/h' },
        interactive: true,
        readFlowFile: async (filePath) => {
          if (filePath === '/h/flows/log-in.flow.json') {
            throw new Error('EACCES: permission denied, open');
          }
          return JSON.stringify(pendingFlow);
        },
        pathExists: async (filePath) => filePath === '/h/flows/log-in.flow.json',
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
      paths: { flowsPendingDir: '/h/pending', flowsDir: '/h/flows', dataDir: '/h' },
      interactive: true,
      readFlowFile: async (filePath) => {
        if (filePath === '/h/flows/log-in.flow.json') {
          const error = new Error('nope');
          error.code = 'ENOENT';
          throw error;
        }
        return JSON.stringify(pendingFlow);
      },
      pathExists: async () => false,
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
        paths: { flowsPendingDir: '/h/pending', flowsDir: '/h/flows', dataDir: '/h' },
        interactive: true,
        readFlowFile: async (filePath) => {
          if (filePath === '/h/flows/log-in.flow.json') {
            const error = new Error('nope');
            error.code = 'ENOENT';
            throw error;
          }
          return JSON.stringify(pendingFlow);
        },
        pathExists: async () => false,
        print: () => {},
        confirmApprove: async () => false,
        moveFlow: async () => { throw new Error('must not move without confirmation'); },
      },
    ),
    (error) => error.name === 'LifecycleError' && /APPROVE/.test(error.message),
  );
});

// TOCTOU (fix round 1, item 4): a fake `confirmApprove` that mutates what
// the NEXT `readFlowFile(pendingPath)` call returns simulates a swap
// happening during the human's think-time at the prompt. The pre-rename
// recheck must catch the id mismatch and refuse, never rename the swapped
// content into the ready tier.
test('approve refuses when the pending flow changes between the prompt and the rename', async () => {
  const original = validFlow({ name: 'log-in', description: 'Original.' });
  const swapped = validFlow({ name: 'log-in', description: 'Swapped!', id: 'b'.repeat(64) });
  let pendingReadCount = 0;
  const moved = [];

  await assert.rejects(
    flows(
      { sub: 'approve', name: 'log-in', json: false },
      {
        paths: { flowsPendingDir: '/h/pending', flowsDir: '/h/flows', dataDir: '/h' },
        interactive: true,
        readFlowFile: async (filePath) => {
          if (filePath === '/h/flows/log-in.flow.json') {
            const error = new Error('nope');
            error.code = 'ENOENT';
            throw error;
          }
          pendingReadCount += 1;
          return JSON.stringify(pendingReadCount === 1 ? original : swapped);
        },
        pathExists: async () => false,
        print: () => {},
        confirmApprove: async () => true,
        moveFlow: async (from, to) => moved.push([from, to]),
      },
    ),
    (error) => error.name === 'LifecycleError' && /changed since approval prompt/i.test(error.message),
  );
  assert.equal(pendingReadCount, 2);
  assert.deepEqual(moved, []);
});

test('approve strips control characters from arg names before printing them', async () => {
  const pendingFlow = validFlow({
    name: 'log-in',
    args: { 'user\x1b[31mname': { type: 'string', required: true } },
  });
  const prints = [];

  await flows(
    { sub: 'approve', name: 'log-in', json: false },
    {
      paths: { flowsPendingDir: '/h/pending', flowsDir: '/h/flows', dataDir: '/h' },
      interactive: true,
      readFlowFile: async (filePath) => {
        if (filePath === '/h/flows/log-in.flow.json') {
          const error = new Error('nope');
          error.code = 'ENOENT';
          throw error;
        }
        return JSON.stringify(pendingFlow);
      },
      pathExists: async () => false,
      print: (line) => prints.push(line),
      confirmApprove: async () => true,
      moveFlow: async () => {},
    },
  );

  // Only the raw ESC byte (0x1b) is stripped -- the printable characters
  // that followed it in the crafted key ("[31m") are left as inert literal
  // text, no longer capable of being interpreted as a terminal escape once
  // the ESC byte that introduces it is gone.
  const joined = prints.join('\n');
  assert.doesNotMatch(joined, /\x1b/);
  assert.match(joined, /Args: user\[31mname/);
});

test('the default confirmApprove gate requires typing the exact literal APPROVE', async () => {
  const pendingFlow = validFlow({ name: 'log-in' });
  const basePaths = {
    flowsPendingDir: '/h/pending', flowsDir: '/h/flows', dataDir: '/h',
  };
  const baseReadFlowFile = async (filePath) => {
    if (filePath === '/h/flows/log-in.flow.json') {
      const error = new Error('nope');
      error.code = 'ENOENT';
      throw error;
    }
    return JSON.stringify(pendingFlow);
  };

  for (const answer of ['approve', '', 'APPROVE ']) {
    await assert.rejects(
      flows(
        { sub: 'approve', name: 'log-in', json: false },
        {
          paths: basePaths,
          input: { isTTY: true },
          output: { isTTY: true, write: () => {} },
          createInterface: () => ({
            question: async () => answer,
            close: () => {},
          }),
          readFlowFile: baseReadFlowFile,
          pathExists: async () => false,
          moveFlow: async () => { throw new Error(`must not move on answer ${JSON.stringify(answer)}`); },
        },
      ),
      (error) => error.name === 'LifecycleError' && /APPROVE/.test(error.message),
    );
  }

  const moved = [];
  const report = await flows(
    { sub: 'approve', name: 'log-in', json: false },
    {
      paths: basePaths,
      input: { isTTY: true },
      output: { isTTY: true, write: () => {} },
      createInterface: () => ({
        question: async () => 'APPROVE',
        close: () => {},
      }),
      readFlowFile: baseReadFlowFile,
      pathExists: async () => false,
      moveFlow: async (from, to) => moved.push([from, to]),
    },
  );
  assert.deepEqual(moved, [['/h/pending/log-in.flow.json', '/h/flows/log-in.flow.json']]);
  assert.deepEqual(report, {
    command: 'flows', sub: 'approve', name: 'log-in', moved: true,
  });
});

test('flows refuses an unrecognised subcommand', async () => {
  await assert.rejects(
    flows(
      { sub: 'bogus', json: false },
      { paths: { flowsDir: '/h/flows', flowsPendingDir: '/h/pending', dataDir: '/h' } },
    ),
    (error) => error.name === 'LifecycleError' && /subcommand/i.test(error.message) && error.exitCode === 2,
  );
});

// --- reject ---

test('reject fails when no pending flow exists under that name', async () => {
  await assert.rejects(
    flows(
      { sub: 'reject', name: 'ghost', json: false },
      {
        paths: { flowsPendingDir: '/h/pending', dataDir: '/h' },
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

// --- real-fs: symlink confinement (fix round 1, item 2) ---

test('[real fs] approve refuses a symlink planted at the pending path, leaving it untouched', async (t) => {
  const paths = await tempPaths(t);
  await mkdir(paths.flowsPendingDir, { recursive: true });
  const outside = path.join(paths.homeDir, 'outside.flow.json');
  const flow = validFlow({ name: 'log-in' });
  await writeFile(outside, JSON.stringify(flow));
  const linkPath = path.join(paths.flowsPendingDir, 'log-in.flow.json');
  await symlink(outside, linkPath);

  await assert.rejects(
    flows(
      { sub: 'approve', name: 'log-in', json: false },
      {
        paths, interactive: true, confirmApprove: async () => true, print: () => {},
      },
    ),
    (error) => error.name === 'LifecycleError',
  );
  // The symlink itself must survive an aborted approval -- never renamed
  // into the ready tier as a live link.
  const linkStat = await lstat(linkPath);
  assert.equal(linkStat.isSymbolicLink(), true);
  await assert.rejects(readFile(path.join(paths.flowsDir, 'log-in.flow.json')));
});

test('[real fs] reject refuses a symlink planted at the pending path, leaving it untouched', async (t) => {
  const paths = await tempPaths(t);
  await mkdir(paths.flowsPendingDir, { recursive: true });
  const outside = path.join(paths.homeDir, 'outside.flow.json');
  const flow = validFlow({ name: 'log-in' });
  await writeFile(outside, JSON.stringify(flow));
  const linkPath = path.join(paths.flowsPendingDir, 'log-in.flow.json');
  await symlink(outside, linkPath);

  await assert.rejects(
    flows({ sub: 'reject', name: 'log-in', json: false }, { paths }),
    (error) => error.name === 'LifecycleError',
  );
  const linkStat = await lstat(linkPath);
  assert.equal(linkStat.isSymbolicLink(), true);
});
