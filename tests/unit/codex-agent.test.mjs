import assert from 'node:assert/strict';
import test from 'node:test';

import {
  removePreferredModelLine,
  renderCodexAgent,
  runWithCodexModelFallback,
  shouldUsePreferredCodexModel,
} from '../../lib/hosts/codex-agent.mjs';

test('renders the preferred model only when requested and never leaves the token', () => {
  const preferred = renderCodexAgent({ usePreferredModel: true });
  const inherited = renderCodexAgent({ usePreferredModel: false });

  assert.match(preferred, /^model = "gpt-5\.6-terra"$/m);
  assert.doesNotMatch(inherited, /^model = /m);
  assert.doesNotMatch(preferred, /\{\{MODEL_LINE\}\}/);
  assert.doesNotMatch(inherited, /\{\{MODEL_LINE\}\}/);
});

test('rendered agent encodes the complete delegated browser-driving contract', () => {
  const rendered = renderCodexAgent({ usePreferredModel: true });

  assert.match(rendered, /Check ~\/\.fast-browser\/macros\/MACROS\.md first\./);
  assert.match(rendered, /one initial scout/i);
  assert.match(rendered, /batch.*browser_run_code_unsafe/i);
  assert.match(rendered, /targeted reads/i);
  assert.match(rendered, /fails twice/i);
  assert.match(rendered, /real Chrome/i);
  assert.match(rendered, /Never log in on the user's behalf/i);
  assert.match(rendered, /at most one sentence of caveat/i);
});

test('selects the preferred model only for parseable Codex versions at least 0.145.0', () => {
  const cases = [
    ['codex-cli 0.145.0', true],
    ['codex 0.145.1', true],
    ['codex 1.0.0', true],
    ['0.144.99', false],
    ['0.145.0-alpha.1', false],
    ['not a version', false],
    ['', false],
  ];

  for (const [version, expected] of cases) {
    assert.equal(
      shouldUsePreferredCodexModel(version),
      expected,
      `selection for ${JSON.stringify(version)}`,
    );
  }
});

test('fallback removal changes only one owned preferred-model line and preserves CRLF', () => {
  const original = [
    'name = "browser_driver"',
    'model = "gpt-5.6-terra"',
    'developer_instructions = """model = keep-this-text"""',
    '',
  ].join('\r\n');

  assert.equal(
    removePreferredModelLine(original),
    'name = "browser_driver"\r\n'
      + 'developer_instructions = """model = keep-this-text"""\r\n',
  );
  assert.equal(
    removePreferredModelLine('name = "browser_driver"\n'),
    'name = "browser_driver"\n',
  );
  assert.throws(
    () => removePreferredModelLine(
      'model = "gpt-5.6-terra"\nmodel = "gpt-5.6-terra"\n',
    ),
    /duplicate/i,
  );
});

test('recognized preferred-model rejection rewrites and retries exactly once', async () => {
  const calls = [];
  const rejection = Object.assign(new Error('model rejected'), {
    code: 'PREFERRED_MODEL_REJECTED',
  });
  let attempts = 0;

  const result = await runWithCodexModelFallback({
    run: async () => {
      attempts += 1;
      calls.push(`run-${attempts}`);
      if (attempts === 1) throw rejection;
      return 'ok';
    },
    rewriteOwnedAgent: async () => calls.push('rewrite'),
    isPreferredModelRejection: (error) => (
      error.code === 'PREFERRED_MODEL_REJECTED'
    ),
  });

  assert.equal(result, 'ok');
  assert.deepEqual(calls, ['run-1', 'rewrite', 'run-2']);
});

test('fallback does not rewrite unrelated failures or retry a second rejection', async () => {
  let unrelatedRuns = 0;
  let rewrites = 0;
  const unrelated = new Error('connection failed');

  await assert.rejects(
    runWithCodexModelFallback({
      run: async () => {
        unrelatedRuns += 1;
        throw unrelated;
      },
      rewriteOwnedAgent: async () => {
        rewrites += 1;
      },
      isPreferredModelRejection: () => false,
    }),
    unrelated,
  );
  assert.equal(unrelatedRuns, 1);
  assert.equal(rewrites, 0);

  let rejectedRuns = 0;
  await assert.rejects(
    runWithCodexModelFallback({
      run: async () => {
        rejectedRuns += 1;
        throw new Error(`rejected-${rejectedRuns}`);
      },
      rewriteOwnedAgent: async () => {
        rewrites += 1;
      },
      isPreferredModelRejection: () => true,
    }),
    /rejected-2/,
  );
  assert.equal(rejectedRuns, 2);
  assert.equal(rewrites, 1);
});
