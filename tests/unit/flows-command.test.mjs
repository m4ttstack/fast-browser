import assert from 'node:assert/strict';
import {
  lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { flows } from '../../lib/commands/flows.mjs';
import { MAX_EMBED_TEXT_CHARS, MAX_EMBED_TEXTS } from '../../lib/flows/encoder.mjs';
import { matchFlows } from '../../lib/flows/match.mjs';
import { replayPayload } from '../../lib/flows/replay.mjs';
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

// WS3a Task 4: a fake `readSite` standing in for lib/sites/store.mjs's real
// one, matching this file's own DI style (fake the dependency, never touch
// real fs outside a `[real fs]`-tagged test). Reports "no site memory for
// this origin" -- store.mjs's own readSite resolves a never-seen origin to
// this exact shape (the QuirksV1 record nested under `.quirks`, itself
// carrying its own `.quirks` array -- store.mjs's `emptyQuirks()`), so this
// is the fake's honest default, not a shortcut.
async function noQuirks() {
  return { quirks: { schemaVersion: 1, quirks: [] } };
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
      readSite: noQuirks,
    },
  );

  assert.deepEqual(events, ['sweep', 'match']);
  // MAT-338: the embedded flow is the runner's PROJECTION of the artifact,
  // not the artifact -- `browser_run_code_unsafe` echoes its arguments back
  // to the agent verbatim, so description/urlPattern/sideEffects/result/
  // provenance would be paid for twice and read by nobody. `quirks` is `[]`
  // because `readSite` (faked as `noQuirks` above) reports no stored site
  // memory for this flow's origin.
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
          args: { flow: replayPayload(readyFlow), args: { username: '<REQUIRED: string>' }, quirks: [] },
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
      readSite: noQuirks,
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
      readSite: noQuirks,
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

  assert.deepEqual(report.warnings, [{
    kind: 'artifact-load', file: 'gone.flow.json', tier: 'ready', reason: 'unreadable',
  }]);
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
      readSite: noQuirks,
    },
  );

  assert.deepEqual(report.candidates[0].invocation.arguments.args.args, {
    query: '<REQUIRED: string>',
    filter: '<OPTIONAL: string>',
  });
});

// --- find: origin quirks (WS3a Task 4) ---
//
// The flow-runner macro (WS3a Task 3) consumes `args.quirks` to dismiss a
// recorded page interrupt (a cookie banner, say) when its own locator walk
// misses. These tests cover the producer side: `find` looks up the flow's
// OWN origin's stored quirks (lib/sites/store.mjs's `readSite`) and embeds
// them, mapped down to exactly the shape the macro reads.

function storedQuirk(overrides = {}) {
  return {
    name: 'cookie-banner',
    urlPattern: null,
    target: { locators: [{ kind: 'css', selector: '#cookie-accept' }], description: 'Cookie banner accept button' },
    action: 'click',
    addedAt: '2026-01-01T00:00:00.000Z',
    source: 'agent',
    ...overrides,
  };
}

test('find embeds the flow origin\'s stored quirks, dropping description/addedAt/source', async () => {
  const paths = {
    flowsDir: '/h/flows', flowsPendingDir: '/h/pending', macrosDir: '/h/macros',
  };
  const flow = validFlow({ name: 'log-in' });
  const quirk = storedQuirk();

  const report = await flows(
    {
      sub: 'find', intent: 'log in', origin: null, url: null, json: true,
    },
    {
      paths,
      sweep: async () => ({}),
      listFlowFiles: async (dir) => (dir === paths.flowsDir ? ['log-in.flow.json'] : []),
      readFlowFile: async () => JSON.stringify(flow),
      matchFlows: () => [{
        flow, score: 100, runnable: true, reasons: [],
      }],
      readSite: async (readSitePaths, origin) => {
        assert.equal(readSitePaths, paths);
        assert.equal(origin, flow.origin);
        return { quirks: { schemaVersion: 1, quirks: [quirk] } };
      },
    },
  );

  assert.deepEqual(report.candidates[0].invocation.arguments.args.quirks, [{
    name: 'cookie-banner',
    urlPattern: null,
    target: { locators: [{ kind: 'css', selector: '#cookie-accept' }] },
    action: 'click',
  }]);
  assert.deepEqual(report.warnings, []);
});

test('find embeds an empty quirks array when the flow origin has no site memory', async () => {
  const paths = {
    flowsDir: '/h/flows', flowsPendingDir: '/h/pending', macrosDir: '/h/macros',
  };
  const flow = validFlow({ name: 'log-in' });

  const report = await flows(
    {
      sub: 'find', intent: 'log in', origin: null, url: null, json: true,
    },
    {
      paths,
      sweep: async () => ({}),
      listFlowFiles: async (dir) => (dir === paths.flowsDir ? ['log-in.flow.json'] : []),
      readFlowFile: async () => JSON.stringify(flow),
      matchFlows: () => [{
        flow, score: 100, runnable: true, reasons: [],
      }],
      // store.mjs's own readSite resolves an origin it has never seen to
      // this exact shape (never throws, per its own doc comment) -- the
      // fake here stands in for that real "no site memory yet" case.
      readSite: noQuirks,
    },
  );

  assert.deepEqual(report.candidates[0].invocation.arguments.args.quirks, []);
  assert.deepEqual(report.warnings, []);
});

test('find caps embedded quirks at 10, dropping the rest with a warning naming the drop count', async () => {
  const paths = {
    flowsDir: '/h/flows', flowsPendingDir: '/h/pending', macrosDir: '/h/macros',
  };
  const flow = validFlow({ name: 'log-in' });
  const elevenQuirks = Array.from({ length: 11 }, (_, index) => storedQuirk({
    name: `quirk-${index}`,
    target: { locators: [{ kind: 'css', selector: `#quirk-${index}` }] },
  }));

  const report = await flows(
    {
      sub: 'find', intent: 'log in', origin: null, url: null, json: true,
    },
    {
      paths,
      sweep: async () => ({}),
      listFlowFiles: async (dir) => (dir === paths.flowsDir ? ['log-in.flow.json'] : []),
      readFlowFile: async () => JSON.stringify(flow),
      matchFlows: () => [{
        flow, score: 100, runnable: true, reasons: [],
      }],
      readSite: async () => ({ quirks: { schemaVersion: 1, quirks: elevenQuirks } }),
    },
  );

  const embedded = report.candidates[0].invocation.arguments.args.quirks;
  assert.equal(embedded.length, 10);
  assert.deepEqual(embedded.map((q) => q.name), elevenQuirks.slice(0, 10).map((q) => q.name));
  assert.deepEqual(report.warnings, [{
    kind: 'quirks-dropped',
    origin: flow.origin,
    reason: '1 quirk dropped from the replay invocation (max 10)',
  }]);
});

// --- find: WS3b Task 7 rerank stage ---

test('find never reranks by default (no config, no env key): the lexical match order is unchanged', async () => {
  const paths = { flowsDir: '/h/flows', flowsPendingDir: '/h/pending', macrosDir: '/h/macros' };
  const flowA = validFlow({ name: 'flow-a' });
  const flowB = validFlow({ name: 'flow-b' });
  const matches = [
    { flow: flowA, score: 100, runnable: true, reasons: [], urlPatternHit: false, nameTokenHit: false },
    { flow: flowB, score: 90, runnable: true, reasons: [], urlPatternHit: false, nameTokenHit: false },
  ];

  const report = await flows(
    {
      sub: 'find', intent: 'find something', origin: null, url: null, json: true,
    },
    {
      paths,
      sweep: async () => ({}),
      listFlowFiles: async (dir) => (dir === paths.flowsDir ? ['flow-a.flow.json', 'flow-b.flow.json'] : []),
      readFlowFile: async (filePath) => (
        filePath.endsWith('flow-a.flow.json') ? JSON.stringify(flowA) : JSON.stringify(flowB)
      ),
      matchFlows: () => matches,
      readSite: noQuirks,
      // Deliberately no createEncoder/env/loadConfig override -- the real
      // defaults resolve to an inactive lexical encoder (no configFile on
      // this fake `paths`, no config.encoder override), which is exactly
      // the case this test pins.
    },
  );

  assert.deepEqual(report.candidates.map((candidate) => candidate.name), ['flow-a', 'flow-b']);
  assert.deepEqual(report.warnings, []);
});

test(
  'find rerank stage reorders candidates WITHIN a band only, never crossing an exact-first band boundary',
  async () => {
    const paths = { flowsDir: '/h/flows', flowsPendingDir: '/h/pending', macrosDir: '/h/macros' };
    const flowA = validFlow({ name: 'flow-a' });
    const flowB = validFlow({ name: 'flow-b' });
    const flowC = validFlow({ name: 'flow-c' });
    const flowD = validFlow({ name: 'flow-d' });

    // Band X (exact-first: both flags true) contains A then B by lexical
    // score; band Y (neither flag) contains C then D. The stubbed encoder
    // below scores B > A and D > C -- the OPPOSITE of lexical order within
    // each band -- so a passing assertion on [B, A, D, C] proves the
    // reorder happened WITHIN each band while band X stayed wholly ahead
    // of band Y (never interleaved).
    const matches = [
      {
        flow: flowA, score: 300, runnable: true, reasons: [], urlPatternHit: true, nameTokenHit: true,
      },
      {
        flow: flowB, score: 290, runnable: true, reasons: [], urlPatternHit: true, nameTokenHit: true,
      },
      {
        flow: flowC, score: 50, runnable: true, reasons: [], urlPatternHit: false, nameTokenHit: false,
      },
      {
        flow: flowD, score: 40, runnable: true, reasons: [], urlPatternHit: false, nameTokenHit: false,
      },
    ];

    let capturedTexts = null;
    const encoder = {
      active: true,
      kind: 'voyage',
      embed: async (texts) => {
        capturedTexts = texts;
        // [intent, A, B, C, D] -- 1-dimensional vectors are enough since
        // cosineSimilarity is a plain dot product; the encoder itself is
        // fully stubbed here (encoder.mjs's own request-shape/normalization
        // contract is covered separately in flows-encoder.test.mjs).
        return [[1], [0.1], [0.9], [0.05], [0.8]];
      },
    };

    const flowFiles = [flowA, flowB, flowC, flowD];
    const report = await flows(
      {
        sub: 'find', intent: 'find something', origin: null, url: null, json: true,
      },
      {
        paths,
        sweep: async () => ({}),
        listFlowFiles: async (dir) => (
          dir === paths.flowsDir ? flowFiles.map((flow) => `${flow.name}.flow.json`) : []
        ),
        readFlowFile: async (filePath) => {
          const found = flowFiles.find((flow) => filePath.endsWith(`${flow.name}.flow.json`));
          return JSON.stringify(found);
        },
        matchFlows: () => matches,
        readSite: noQuirks,
        createEncoder: () => encoder,
        env: { FAST_BROWSER_VOYAGE_API_KEY: 'sk-test' },
        loadConfig: async () => ({ encoder: 'voyage' }),
      },
    );

    assert.deepEqual(
      report.candidates.map((candidate) => candidate.name),
      ['flow-b', 'flow-a', 'flow-d', 'flow-c'],
    );
    assert.deepEqual(report.warnings, []);
    assert.equal(capturedTexts.length, 5);
    assert.equal(capturedTexts[0], 'find something');
  },
);

test('find rerank never calls embed with fewer than 2 candidates', async () => {
  const paths = { flowsDir: '/h/flows', flowsPendingDir: '/h/pending', macrosDir: '/h/macros' };
  const flow = validFlow({ name: 'log-in' });
  let embedCalled = false;
  const encoder = {
    active: true,
    kind: 'voyage',
    embed: async () => { embedCalled = true; return []; },
  };

  await flows(
    {
      sub: 'find', intent: 'log in', origin: null, url: null, json: true,
    },
    {
      paths,
      sweep: async () => ({}),
      listFlowFiles: async (dir) => (dir === paths.flowsDir ? ['log-in.flow.json'] : []),
      readFlowFile: async () => JSON.stringify(flow),
      matchFlows: () => [{
        flow, score: 100, runnable: true, reasons: [], urlPatternHit: false, nameTokenHit: true,
      }],
      readSite: noQuirks,
      createEncoder: () => encoder,
      env: { FAST_BROWSER_VOYAGE_API_KEY: 'sk-test' },
      loadConfig: async () => ({ encoder: 'voyage' }),
    },
  );

  assert.equal(embedCalled, false, 'a single candidate must never trigger an embed call');
});

test('find rerank never calls embed with an empty intent, even with 2+ candidates', async () => {
  const paths = { flowsDir: '/h/flows', flowsPendingDir: '/h/pending', macrosDir: '/h/macros' };
  const flowA = validFlow({ name: 'flow-a' });
  const flowB = validFlow({ name: 'flow-b' });
  let embedCalled = false;
  const encoder = {
    active: true,
    kind: 'voyage',
    embed: async () => { embedCalled = true; return []; },
  };

  await flows(
    {
      sub: 'find', intent: '', origin: null, url: null, json: true,
    },
    {
      paths,
      sweep: async () => ({}),
      listFlowFiles: async (dir) => (dir === paths.flowsDir ? ['flow-a.flow.json', 'flow-b.flow.json'] : []),
      readFlowFile: async (filePath) => (
        filePath.endsWith('flow-a.flow.json') ? JSON.stringify(flowA) : JSON.stringify(flowB)
      ),
      matchFlows: () => [
        {
          flow: flowA, score: 100, runnable: true, reasons: [], urlPatternHit: false, nameTokenHit: false,
        },
        {
          flow: flowB, score: 90, runnable: true, reasons: [], urlPatternHit: false, nameTokenHit: false,
        },
      ],
      readSite: noQuirks,
      createEncoder: () => encoder,
      env: { FAST_BROWSER_VOYAGE_API_KEY: 'sk-test' },
      loadConfig: async () => ({ encoder: 'voyage' }),
    },
  );

  assert.equal(embedCalled, false, 'an empty intent must never trigger an embed call');
});

test(
  'find rerank degrades to lexical order and reports exactly one encoder-degraded warning when embed fails',
  async () => {
    const paths = { flowsDir: '/h/flows', flowsPendingDir: '/h/pending', macrosDir: '/h/macros' };
    const flowA = validFlow({ name: 'flow-a' });
    const flowB = validFlow({ name: 'flow-b' });
    const matches = [
      {
        flow: flowA, score: 100, runnable: true, reasons: [], urlPatternHit: false, nameTokenHit: false,
      },
      {
        flow: flowB, score: 90, runnable: true, reasons: [], urlPatternHit: false, nameTokenHit: false,
      },
    ];
    const encoder = {
      active: true,
      kind: 'voyage',
      embed: async () => { throw new Error('voyage embeddings request failed: HTTP 500'); },
    };

    const report = await flows(
      {
        sub: 'find', intent: 'find something', origin: null, url: null, json: true,
      },
      {
        paths,
        sweep: async () => ({}),
        listFlowFiles: async (dir) => (dir === paths.flowsDir ? ['flow-a.flow.json', 'flow-b.flow.json'] : []),
        readFlowFile: async (filePath) => (
          filePath.endsWith('flow-a.flow.json') ? JSON.stringify(flowA) : JSON.stringify(flowB)
        ),
        matchFlows: () => matches,
        readSite: noQuirks,
        createEncoder: () => encoder,
        env: { FAST_BROWSER_VOYAGE_API_KEY: 'sk-test' },
        loadConfig: async () => ({ encoder: 'voyage' }),
      },
    );

    // Lexical order preserved -- the rerank's own failure never reorders,
    // never drops, never touches runnable/reasons.
    assert.deepEqual(report.candidates.map((candidate) => candidate.name), ['flow-a', 'flow-b']);
    assert.deepEqual(report.warnings, [
      { kind: 'encoder-degraded', reason: 'voyage embeddings request failed: HTTP 500' },
    ]);
  },
);

test(
  'find rerank clamps the embed batch at this call site: MAX_EMBED_TEXTS texts, each <= MAX_EMBED_TEXT_CHARS',
  async () => {
    const paths = { flowsDir: '/h/flows', flowsPendingDir: '/h/pending', macrosDir: '/h/macros' };
    const manyFlows = Array.from(
      { length: 40 },
      (_, index) => validFlow({ name: `flow-${index}`, description: 'd'.repeat(3000) }),
    );
    const matches = manyFlows.map((flow, index) => ({
      flow, score: 1000 - index, runnable: true, reasons: [], urlPatternHit: false, nameTokenHit: false,
    }));
    let capturedTexts = null;
    const encoder = {
      active: true,
      kind: 'voyage',
      embed: async (texts) => {
        capturedTexts = texts;
        return texts.map(() => [1]);
      },
    };

    await flows(
      {
        sub: 'find', intent: 'x'.repeat(5000), origin: null, url: null, json: true,
      },
      {
        paths,
        sweep: async () => ({}),
        listFlowFiles: async (dir) => (
          dir === paths.flowsDir ? manyFlows.map((flow) => `${flow.name}.flow.json`) : []
        ),
        readFlowFile: async (filePath) => {
          const found = manyFlows.find((flow) => filePath.endsWith(`${flow.name}.flow.json`));
          return JSON.stringify(found);
        },
        matchFlows: () => matches,
        readSite: noQuirks,
        createEncoder: () => encoder,
        env: { FAST_BROWSER_VOYAGE_API_KEY: 'sk-test' },
        loadConfig: async () => ({ encoder: 'voyage' }),
      },
    );

    assert.equal(capturedTexts.length, MAX_EMBED_TEXTS);
    for (const text of capturedTexts) {
      assert.ok(text.length <= MAX_EMBED_TEXT_CHARS, `text length ${text.length} exceeds the clamp`);
    }
  },
);

// --- list ---

// WS3a Task 7: `lastHealed` is `flow.provenance.lastHealed` (artifact.mjs's
// own nullable ISO string), carried through as an additive key on each list
// entry -- distinct null/non-null values on the two fixtures here pin that
// it is passed through verbatim, not just present.
test('list reports both tiers with health, ready sorted before pending', async () => {
  const paths = { flowsDir: '/h/flows', flowsPendingDir: '/h/pending' };
  const ready = validFlow({
    name: 'b-flow',
    provenance: {
      ...validFlow().provenance, successRuns: 3, failStreak: 1, lastHealed: '2026-08-04T00:00:00.000Z',
    },
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
        lastHealed: '2026-08-04T00:00:00.000Z',
      },
      {
        tier: 'pending',
        name: 'a-flow',
        description: pending.description,
        origin: pending.origin,
        health: { successRuns: 0, failStreak: 0 },
        lastHealed: null,
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

// MAT-138 debt sweep, item 1: the recheck above happened to catch that
// scenario only because the fixture also changed `id`. The stored `id`
// FIELD is itself just data read back out of the swapped file -- nothing
// forces it to change when the file's content does (a hand-edited or
// maliciously crafted pending file can swap steps/description/args while
// leaving the original `id` string untouched). Comparing stored-id-to-
// stored-id therefore misses exactly the swap the recheck exists to catch.
// This fixture keeps `id` IDENTICAL across both reads and changes only
// `description`; the recheck must compare the recomputed content hash
// (`flowId`) of what was just re-read against the content hash of what was
// shown at the prompt, not the two files' own `id` fields.
test('approve refuses when pending content changes but the stored id field is left unchanged', async () => {
  const staleId = 'a'.repeat(64);
  const original = validFlow({ name: 'log-in', description: 'Original.', id: staleId });
  const swapped = validFlow({ name: 'log-in', description: 'Swapped!', id: staleId });
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

// MAT-149: `parseFlow`'s `parseArgs` now rejects any arg key outside
// `/^[A-Za-z_][A-Za-z0-9_]*$/` -- a raw ESC byte among them -- with a loud
// parse error, before this module ever sees the flow. The scenario this
// test used to prove safe by STRIPPING the escape byte before printing it
// is now impossible by construction: `readPendingFlow` (which calls
// `parseFlow`) refuses the whole file first, and `approve` never reaches
// its own print calls at all. `stripControlChars` on `argNames` (flows.mjs)
// stays in place as defense-in-depth -- see `commands.test.mjs` for its
// direct unit coverage -- but this specific injection vector is now closed
// one layer earlier, which is what this test pins.
test('approve refuses a flow whose arg name is not a valid identifier (a raw ESC byte among them) before ever printing anything', async () => {
  const pendingFlow = validFlow({
    name: 'log-in',
    args: { 'user\x1b[31mname': { type: 'string', required: true } },
  });
  const prints = [];

  await assert.rejects(
    () => flows(
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
    ),
    (error) => error.name === 'LifecycleError' && /invalid and cannot be approved/.test(error.message),
  );
  assert.deepEqual(prints, []);
});

// Fix round 2, item 4: the denylist grew past raw C0 controls to cover
// line-breaking (NEL/LS/PS), invisible (ZWSP), and bidi
// embedding/override/isolate controls (RLO can visually REVERSE text) --
// while still leaving ordinary Unicode (NBSP, emoji, CJK) untouched.
//
// MAT-149 supersedes this scenario the same way as the ESC-byte test just
// above: `parseArgs` now requires every arg key to match
// `/^[A-Za-z_][A-Za-z0-9_]*$/`, so NBSP/ZWSP/RLO/emoji/CJK -- none of them
// ASCII letters, digits, or underscore -- can never survive into an arg
// key `readPendingFlow` accepts. The file is refused at parse, loudly,
// before any printing happens; the "preserve the harmless characters,
// strip only the dangerous ones" behavior this test used to pin no longer
// has a reachable arg-name code path to exercise (it still applies to
// every OTHER printed field `stripControlChars` guards, per
// `commands.test.mjs` and the other call sites in lib/cli/main.mjs).
test('approve refuses a flow whose arg name carries invisible/bidi characters (NBSP/ZWSP/RLO/emoji/CJK) before ever printing anything', async () => {
  const trickyName = 'user\u00a0\u200b\u202ename\u00a0\u{1F600}\u6f22';
  const pendingFlow = validFlow({
    name: 'log-in',
    args: { [trickyName]: { type: 'string', required: true } },
  });
  const prints = [];

  await assert.rejects(
    () => flows(
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
    ),
    (error) => error.name === 'LifecycleError' && /invalid and cannot be approved/.test(error.message),
  );
  assert.deepEqual(prints, []);
});

// Fix round 2, item 2: a reviewer reproduced a scenario where the ORIGINAL
// (pre-prompt-only) ready-tier check missed a file that appeared at
// readyPath during the human's think-time at the confirm prompt --
// `moveFlow` would have silently overwritten it. The fake `confirmApprove`
// below simulates exactly that: it "plants" the collision as a side effect
// of confirming, which only the pre-rename recheck can catch.
test('approve refuses when a file appears at the ready path during the confirm prompt', async () => {
  const pendingFlow = validFlow({ name: 'log-in' });
  let readyPlanted = false;
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
          return JSON.stringify(pendingFlow);
        },
        pathExists: async (filePath) => (
          filePath === '/h/flows/log-in.flow.json' ? readyPlanted : false
        ),
        print: () => {},
        confirmApprove: async () => {
          readyPlanted = true;
          return true;
        },
        moveFlow: async (from, to) => moved.push([from, to]),
      },
    ),
    (error) => error.name === 'LifecycleError' && /already exists/i.test(error.message),
  );
  assert.deepEqual(moved, []);
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
      pathExists: async () => true,
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

// Fix round 2, item 3: reject parity with approve's fail-closed collision
// probe. `pathExists` (lstat) is now checked BEFORE `readFlowFile`, so the
// two failure modes get honest, distinct messages instead of collapsing
// "nothing there" and "something there but unreadable" (a directory, a
// permission-denied file, a planted entry this process cannot open) into
// the same blanket "not found". Nothing is unlinked on either error path.
test('reject reports an honest error when the pending entry exists but cannot be read', async () => {
  const deleted = [];
  await assert.rejects(
    flows(
      { sub: 'reject', name: 'log-in', json: false },
      {
        paths: { flowsPendingDir: '/h/pending', dataDir: '/h' },
        pathExists: async () => true,
        readFlowFile: async () => {
          throw new Error('EACCES: permission denied, open');
        },
        deleteFlow: async (filePath) => deleted.push(filePath),
      },
    ),
    (error) => error.name === 'LifecycleError' && /exists but cannot be read/i.test(error.message),
  );
  assert.deepEqual(deleted, []);
});

test('reject still reports "not found" when pathExists confirms nothing is there', async () => {
  await assert.rejects(
    flows(
      { sub: 'reject', name: 'ghost', json: false },
      {
        paths: { flowsPendingDir: '/h/pending', dataDir: '/h' },
        pathExists: async () => false,
        readFlowFile: async () => { throw new Error('must not be called when pathExists says absent'); },
      },
    ),
    (error) => error.name === 'LifecycleError' && /no pending flow/i.test(error.message),
  );
});

test('reject refuses, never silently proceeding, when existence itself cannot be verified', async () => {
  const deleted = [];
  await assert.rejects(
    flows(
      { sub: 'reject', name: 'log-in', json: false },
      {
        paths: { flowsPendingDir: '/h/pending', dataDir: '/h' },
        pathExists: async () => { throw new Error('EIO: unexpected'); },
        readFlowFile: async () => { throw new Error('must not be reached'); },
        deleteFlow: async (filePath) => deleted.push(filePath),
      },
    ),
    (error) => error.name === 'LifecycleError' && /could not be verified/i.test(error.message),
  );
  assert.deepEqual(deleted, []);
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

// --- real-fs: an ancestor-symlinked dataDir (fix round 2, item 1) ---
//
// A dataDir REACHED via an ancestor symlink (a dotfile-managed home, a
// relocated data directory -- `~/.fast-browser -> /elsewhere`) is a
// legitimate, common setup, not an attack; round 1's confinement fix
// regressed it, since the containment walk's own first hop IS dataDir
// itself. These two tests pin both halves of the round-2 fix: the
// legitimate ancestor-symlink case now works, and a symlink planted BELOW
// that same (now-permitted) dataDir is still refused exactly as before.

async function tempPathsWithSymlinkedDataDir(t) {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-flows-symhome-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const realDataDir = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-flows-realdata-'));
  t.after(() => rm(realDataDir, { recursive: true, force: true }));

  const paths = resolvePaths({ homeDir, pluginRoot: '/plugin' });
  await symlink(realDataDir, paths.dataDir);
  return { paths, realDataDir };
}

test('[real fs] approve succeeds when dataDir itself is reached through an ancestor symlink', async (t) => {
  const { paths, realDataDir } = await tempPathsWithSymlinkedDataDir(t);
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
  // Read back through the REAL (non-symlink) target to confirm the file
  // actually landed in the physical ready tier, not merely somewhere the
  // logical/symlinked path also happens to resolve.
  assert.equal(
    await readFile(path.join(realDataDir, 'flows', 'log-in.flow.json'), 'utf8'),
    raw,
  );
});

test('[real fs] a leaf symlink planted under a symlinked dataDir is still refused', async (t) => {
  const { paths, realDataDir } = await tempPathsWithSymlinkedDataDir(t);
  await mkdir(paths.flowsPendingDir, { recursive: true });
  const outside = path.join(realDataDir, 'outside.flow.json');
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
  const linkStat = await lstat(linkPath);
  assert.equal(linkStat.isSymbolicLink(), true);
});
