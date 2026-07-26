import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { detectHosts } from '../../lib/hosts/detect.mjs';
import { installClaude, uninstallClaude } from '../../lib/hosts/claude.mjs';
import { installCodex, uninstallCodex } from '../../lib/hosts/codex.mjs';

const pluginRoot = path.resolve(import.meta.dirname, '../..');
const source = path.resolve(pluginRoot, '../..');
const gitSource = 'mattstack/mattstack';
const TRUNCATION_MARKER = '\n[output truncated at 1048576 bytes]\n';

function result(command, args, stdout = '', overrides = {}) {
  return {
    command,
    args,
    exitCode: 0,
    stdout,
    stderr: '',
    ...overrides,
  };
}

function scriptedRunner(responses) {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, args]);
    const response = responses.shift();
    assert.ok(response, `unexpected command: ${command} ${args.join(' ')}`);
    return typeof response === 'function'
      ? response(command, args)
      : result(command, args, response.stdout ?? '', response);
  };
  return { calls, run };
}

const claudeNoPlugins =
  'No plugins installed. Use `claude plugin install` to install a plugin.\n';
const claudeNoMarketplaces = 'No marketplaces configured\n';
const claudeInstalledCurrent = `Installed plugins:

  ❯ fast-browser@mattstack
    Version: 0.1.0-alpha.1
    Scope: user
    Status: ✔ enabled
`;
const claudeMarketplace = `Configured marketplaces:

  ❯ mattstack
    Source: Directory (${source})
`;
const claudeGitMarketplace = `Configured marketplaces:

  ❯ mattstack
    Source: GitHub (${gitSource})
`;

const codexEmptyPlugins = JSON.stringify({ installed: [], available: [] });
const codexNoMarketplaces = JSON.stringify({ marketplaces: [] });
const codexMarketplace = JSON.stringify({
  marketplaces: [{
    name: 'mattstack',
    root: source,
    marketplaceSource: {
      sourceType: 'local',
      source,
    },
  }],
});

function codexPlugins(version = '0.1.0-alpha.1', marketplaceSource = source) {
  return JSON.stringify({
    installed: [{
      pluginId: 'fast-browser@mattstack',
      name: 'fast-browser',
      marketplaceName: 'mattstack',
      version,
      installed: true,
      enabled: true,
      source: {
        source: 'local',
        path: `${source}/plugins/fast-browser`,
      },
      marketplaceSource: {
        sourceType: marketplaceSource === source ? 'local' : 'git',
        source: marketplaceSource,
      },
      installPolicy: 'AVAILABLE',
      authPolicy: 'ON_INSTALL',
    }],
    available: [],
  });
}

test('Claude preflights and uses the exact fresh-install mutation commands', async () => {
  const { calls, run } = scriptedRunner([
    { stdout: claudeNoPlugins },
    { stdout: claudeNoMarketplaces },
    { stdout: 'marketplace added' },
    { stdout: 'plugin installed' },
  ]);

  const installed = await installClaude({ source: gitSource, run });

  assert.deepEqual(calls.slice(2), [
    ['claude', ['plugin', 'marketplace', 'add', gitSource, '--scope', 'user', '--sparse', '.claude-plugin', 'plugins/fast-browser']],
    ['claude', ['plugin', 'install', 'fast-browser@mattstack', '--scope', 'user']],
  ]);
  assert.deepEqual(installed, {
    host: 'claude',
    changed: true,
    changes: ['marketplace-added', 'plugin-installed'],
  });
});

test('Codex preflights and uses the exact fresh-install mutation commands', async () => {
  const { calls, run } = scriptedRunner([
    { stdout: codexEmptyPlugins },
    { stdout: codexNoMarketplaces },
    { stdout: '{"marketplaceName":"mattstack","alreadyAdded":false}' },
    { stdout: '{"pluginId":"fast-browser@mattstack"}' },
  ]);

  const installed = await installCodex({ source: gitSource, run });

  assert.deepEqual(calls.slice(2), [
    ['codex', ['plugin', 'marketplace', 'add', gitSource, '--sparse', '.agents/plugins', '--sparse', 'plugins/fast-browser', '--json']],
    ['codex', ['plugin', 'add', 'fast-browser@mattstack', '--json']],
  ]);
  assert.deepEqual(installed, {
    host: 'codex',
    changed: true,
    changes: ['marketplace-added', 'plugin-installed'],
  });
});

test('refreshes an exact Claude marketplace and leaves the matching version installed', async () => {
  const { calls, run } = scriptedRunner([
    { stdout: claudeInstalledCurrent },
    { stdout: claudeGitMarketplace },
    { stdout: 'marketplace updated' },
  ]);

  const installed = await installClaude({ source: gitSource, run });

  assert.deepEqual(calls, [
    ['claude', ['plugin', 'list']],
    ['claude', ['plugin', 'marketplace', 'list']],
    ['claude', ['plugin', 'marketplace', 'update', 'mattstack']],
  ]);
  assert.deepEqual(installed, {
    host: 'claude',
    changed: false,
    changes: ['marketplace-refreshed'],
  });
});

test('refreshes an exact Codex marketplace and leaves the matching version installed', async () => {
  const { calls, run } = scriptedRunner([
    { stdout: codexPlugins('0.1.0-alpha.1', gitSource) },
    {
      stdout: JSON.stringify({
        marketplaces: [{
          name: 'mattstack',
          root: '/cache/mattstack',
          marketplaceSource: { sourceType: 'git', source: gitSource },
        }],
      }),
    },
    { stdout: '{"marketplaceName":"mattstack"}' },
  ]);

  const installed = await installCodex({ source: gitSource, run });

  assert.deepEqual(calls, [
    ['codex', ['plugin', 'list', '--available', '--json']],
    ['codex', ['plugin', 'marketplace', 'list', '--json']],
    ['codex', ['plugin', 'marketplace', 'upgrade', 'mattstack', '--json']],
  ]);
  assert.deepEqual(installed, {
    host: 'codex',
    changed: false,
    changes: ['marketplace-refreshed'],
  });
});

test('replaces only fast-browser@mattstack when the Claude version differs', async () => {
  const oldVersion = claudeInstalledCurrent.replace('0.1.0-alpha.1', '0.0.9');
  const { calls, run } = scriptedRunner([
    { stdout: oldVersion },
    { stdout: claudeGitMarketplace },
    { stdout: 'marketplace updated' },
    { stdout: 'plugin removed' },
    { stdout: 'plugin installed' },
  ]);

  const installed = await installClaude({ source: gitSource, run });

  assert.deepEqual(calls.slice(2), [
    ['claude', ['plugin', 'marketplace', 'update', 'mattstack']],
    ['claude', ['plugin', 'uninstall', 'fast-browser@mattstack', '--scope', 'user']],
    ['claude', ['plugin', 'install', 'fast-browser@mattstack', '--scope', 'user']],
  ]);
  assert.deepEqual(installed.changes, [
    'marketplace-refreshed',
    'plugin-removed',
    'plugin-installed',
  ]);
});

test('replaces only fast-browser@mattstack when the Codex version differs', async () => {
  const { calls, run } = scriptedRunner([
    { stdout: codexPlugins('0.0.9', gitSource) },
    {
      stdout: JSON.stringify({
        marketplaces: [{
          name: 'mattstack',
          root: '/cache/mattstack',
          marketplaceSource: { sourceType: 'git', source: gitSource },
        }],
      }),
    },
    { stdout: '{"marketplaceName":"mattstack"}' },
    { stdout: '{"pluginId":"fast-browser@mattstack"}' },
    { stdout: '{"pluginId":"fast-browser@mattstack"}' },
  ]);

  await installCodex({ source: gitSource, run });

  assert.deepEqual(calls.slice(2), [
    ['codex', ['plugin', 'marketplace', 'upgrade', 'mattstack', '--json']],
    ['codex', ['plugin', 'remove', 'fast-browser@mattstack', '--json']],
    ['codex', ['plugin', 'add', 'fast-browser@mattstack', '--json']],
  ]);
});

test('reports a partial Claude install without leaking stderr or claiming rollback', async () => {
  const { run } = scriptedRunner([
    { stdout: claudeNoPlugins },
    { stdout: claudeNoMarketplaces },
    { stdout: 'marketplace added' },
    { exitCode: 1, stderr: 'token=claude-secret', stdout: '' },
  ]);

  await assert.rejects(installClaude({ source: gitSource, run }), (error) => {
    assert.equal(error.message, 'claude plugin install exited with code 1');
    assert.deepEqual(error.result, {
      host: 'claude',
      changed: true,
      changes: ['marketplace-added'],
      next: 'Retry installing fast-browser@mattstack.',
    });
    assert.doesNotMatch(JSON.stringify(error), /claude-secret|rollback/i);
    return true;
  });
});

test('reports removal when Codex reinstall fails and gives precise remediation', async () => {
  const { run } = scriptedRunner([
    { stdout: codexPlugins('0.0.9', gitSource) },
    {
      stdout: JSON.stringify({
        marketplaces: [{
          name: 'mattstack',
          root: '/cache/mattstack',
          marketplaceSource: { sourceType: 'git', source: gitSource },
        }],
      }),
    },
    { stdout: '{"marketplaceName":"mattstack"}' },
    { stdout: '{"pluginId":"fast-browser@mattstack"}' },
    { exitCode: 9, stderr: 'authorization=codex-secret', stdout: '' },
  ]);

  await assert.rejects(installCodex({ source: gitSource, run }), (error) => {
    assert.equal(error.message, 'codex plugin add exited with code 9');
    assert.deepEqual(error.result, {
      host: 'codex',
      changed: true,
      changes: ['marketplace-refreshed', 'plugin-removed'],
      next: 'Retry installing fast-browser@mattstack.',
    });
    assert.doesNotMatch(JSON.stringify(error), /codex-secret|rollback/i);
    return true;
  });
});

test('uninstall is idempotent and removes only the exact plugin selector', async () => {
  const claudeAbsent = scriptedRunner([{ stdout: claudeNoPlugins }]);
  const claudePresent = scriptedRunner([
    {
      stdout: `${claudeInstalledCurrent}
  ❯ fast-browser-helper@other-market
    Version: 9.0.0
    Scope: user
    Status: ✔ enabled
`,
    },
    { stdout: 'plugin removed' },
  ]);
  const codexAbsent = scriptedRunner([{ stdout: codexEmptyPlugins }]);
  const codexPresent = scriptedRunner([
    { stdout: codexPlugins() },
    { stdout: '{"pluginId":"fast-browser@mattstack"}' },
  ]);

  assert.equal((await uninstallClaude({ run: claudeAbsent.run })).changed, false);
  assert.equal((await uninstallCodex({ run: codexAbsent.run })).changed, false);
  assert.equal((await uninstallClaude({ run: claudePresent.run })).changed, true);
  assert.equal((await uninstallCodex({ run: codexPresent.run })).changed, true);
  assert.deepEqual(claudePresent.calls.at(-1), [
    'claude',
    ['plugin', 'uninstall', 'fast-browser@mattstack', '--scope', 'user'],
  ]);
  assert.deepEqual(codexPresent.calls.at(-1), [
    'codex',
    ['plugin', 'remove', 'fast-browser@mattstack', '--json'],
  ]);
});

test('uses local marketplaces live without sparse flags or refresh commands', async () => {
  const claudeFresh = scriptedRunner([
    { stdout: claudeNoPlugins },
    { stdout: claudeNoMarketplaces },
    { stdout: 'marketplace added' },
    { stdout: 'plugin installed' },
  ]);
  const codexFresh = scriptedRunner([
    { stdout: codexEmptyPlugins },
    { stdout: codexNoMarketplaces },
    { stdout: '{"marketplaceName":"mattstack","alreadyAdded":false}' },
    { stdout: '{"pluginId":"fast-browser@mattstack"}' },
  ]);
  const claudeCurrent = scriptedRunner([
    { stdout: claudeInstalledCurrent },
    { stdout: claudeMarketplace },
  ]);
  const codexCurrent = scriptedRunner([
    { stdout: codexPlugins() },
    { stdout: codexMarketplace },
  ]);

  await installClaude({ source, run: claudeFresh.run });
  await installCodex({ source, run: codexFresh.run });
  assert.deepEqual((await installClaude({ source, run: claudeCurrent.run })).changes, []);
  assert.deepEqual((await installCodex({ source, run: codexCurrent.run })).changes, []);
  assert.deepEqual(claudeFresh.calls.slice(2), [
    ['claude', ['plugin', 'marketplace', 'add', source, '--scope', 'user']],
    ['claude', ['plugin', 'install', 'fast-browser@mattstack', '--scope', 'user']],
  ]);
  assert.deepEqual(codexFresh.calls.slice(2), [
    ['codex', ['plugin', 'marketplace', 'add', source, '--json']],
    ['codex', ['plugin', 'add', 'fast-browser@mattstack', '--json']],
  ]);
  assert.equal(claudeCurrent.calls.length, 2);
  assert.equal(codexCurrent.calls.length, 2);
});

test('normalizes relative local sources before commands', async () => {
  const cases = [
    {
      install: installClaude,
      input: '.',
      expected: await realpath('.'),
      responses: [
        { stdout: claudeNoPlugins },
        { stdout: claudeNoMarketplaces },
        { stdout: 'marketplace added' },
        { stdout: 'plugin installed' },
      ],
      mutation(commandSource) {
        return [
          'claude',
          ['plugin', 'marketplace', 'add', commandSource, '--scope', 'user'],
        ];
      },
    },
    {
      install: installCodex,
      input: '..',
      expected: await realpath('..'),
      responses: [
        { stdout: codexEmptyPlugins },
        { stdout: codexNoMarketplaces },
        { stdout: '{"marketplaceName":"mattstack","alreadyAdded":false}' },
        { stdout: '{"pluginId":"fast-browser@mattstack"}' },
      ],
      mutation(commandSource) {
        return ['codex', ['plugin', 'marketplace', 'add', commandSource, '--json']];
      },
    },
    {
      install: installClaude,
      input: './',
      expected: await realpath('./'),
      responses: [
        { stdout: claudeNoPlugins },
        { stdout: claudeNoMarketplaces },
        { stdout: 'marketplace added' },
        { stdout: 'plugin installed' },
      ],
      mutation(commandSource) {
        return [
          'claude',
          ['plugin', 'marketplace', 'add', commandSource, '--scope', 'user'],
        ];
      },
    },
    {
      install: installCodex,
      input: '../',
      expected: await realpath('../'),
      responses: [
        { stdout: codexEmptyPlugins },
        { stdout: codexNoMarketplaces },
        { stdout: '{"marketplaceName":"mattstack","alreadyAdded":false}' },
        { stdout: '{"pluginId":"fast-browser@mattstack"}' },
      ],
      mutation(commandSource) {
        return ['codex', ['plugin', 'marketplace', 'add', commandSource, '--json']];
      },
    },
  ];

  for (const fixture of cases) {
    const { calls, run } = scriptedRunner([...fixture.responses]);
    await fixture.install({ source: fixture.input, run });
    assert.deepEqual(calls[2], fixture.mutation(fixture.expected));
  }
});

test('relative local input is idempotent against canonical host paths', async () => {
  const relativeSource = path.relative(process.cwd(), source);
  const claude = scriptedRunner([
    { stdout: claudeInstalledCurrent },
    { stdout: claudeMarketplace },
  ]);
  const codex = scriptedRunner([
    { stdout: codexPlugins() },
    { stdout: codexMarketplace },
  ]);

  assert.deepEqual(
    await installClaude({ source: relativeSource, run: claude.run }),
    { host: 'claude', changed: false, changes: [] },
  );
  assert.deepEqual(
    await installCodex({ source: relativeSource, run: codex.run }),
    { host: 'codex', changed: false, changes: [] },
  );
  assert.equal(claude.calls.length, 2);
  assert.equal(codex.calls.length, 2);
});

test('requires the exact marketplace source type as well as source text', async () => {
  const claude = scriptedRunner([
    { stdout: claudeInstalledCurrent },
    {
      stdout: `Configured marketplaces:

  ❯ mattstack
    Source: Directory (${gitSource})
`,
    },
  ]);
  const codex = scriptedRunner([
    { stdout: codexPlugins('0.1.0-alpha.1', gitSource) },
    {
      stdout: JSON.stringify({
        marketplaces: [{
          name: 'mattstack',
          root: '/cache/mattstack',
          marketplaceSource: { sourceType: 'local', source: gitSource },
        }],
      }),
    },
  ]);

  await assert.rejects(
    installClaude({ source: gitSource, run: claude.run }),
    /mattstack marketplace is configured from a different source/,
  );
  await assert.rejects(
    installCodex({ source: gitSource, run: codex.run }),
    /mattstack marketplace is configured from a different source/,
  );
  assert.equal(claude.calls.length, 2);
  assert.equal(codex.calls.length, 2);
});

test('rejects unsupported local-like source forms before running a CLI', async () => {
  const unsupported = ['~', '~/repo', 'file:///tmp/repo', 'C:\\repo', 'foo/bar/baz'];
  for (const candidate of unsupported) {
    const calls = [];
    const runner = async (...args) => {
      calls.push(args);
      throw new Error('runner must not be called');
    };
    await assert.rejects(
      installClaude({ source: candidate, run: runner }),
      { message: 'unsupported marketplace source' },
    );
    await assert.rejects(
      installCodex({ source: candidate, run: runner }),
      { message: 'unsupported marketplace source' },
    );
    assert.equal(calls.length, 0);
  }
});

test('Claude text parsing does not treat substring mentions as installed or configured', async () => {
  const { calls, run } = scriptedRunner([
    {
      stdout: `Installed plugins:

  ❯ helper@other
    Version: 1.0.0
    Description: migrates fast-browser@mattstack
`,
    },
    {
      stdout: `Configured marketplaces:

  ❯ mattstack-archive
    Source: Directory (${source})
`,
    },
    { stdout: 'marketplace added' },
    { stdout: 'plugin installed' },
  ]);

  await installClaude({ source, run });

  assert.equal(calls.length, 4);
  assert.deepEqual(calls[2], [
    'claude',
    ['plugin', 'marketplace', 'add', source, '--scope', 'user'],
  ]);
});

test('Claude rejects malformed or truncated plugin-list text before mutation', async () => {
  const malformedOutputs = [
    'arbitrary fast-browser@mattstack text',
    `${claudeInstalledCurrent}${TRUNCATION_MARKER}`,
    `Installed plugins:

  ❯ fast-browser@mattstack
    Scope: user
    Status: ✔ enabled
`,
  ];

  for (const stdout of malformedOutputs) {
    const { calls, run } = scriptedRunner([
      { stdout },
      { stdout: claudeNoMarketplaces },
    ]);

    await assert.rejects(installClaude({ source, run }), (error) => {
      assert.equal(error.message, 'claude plugin list returned unrecognized output');
      assert.doesNotMatch(JSON.stringify(error), /arbitrary|output truncated/);
      return true;
    });
    assert.equal(calls.length, 2);
  }
});

test('Claude rejects malformed or truncated marketplace-list text before mutation', async () => {
  const malformedOutputs = [
    'mattstack might be configured',
    `${claudeMarketplace}${TRUNCATION_MARKER}`,
    `Configured marketplaces:

  ❯ mattstack
`,
  ];

  for (const stdout of malformedOutputs) {
    const { calls, run } = scriptedRunner([
      { stdout: claudeNoPlugins },
      { stdout },
    ]);

    await assert.rejects(installClaude({ source, run }), (error) => {
      assert.equal(
        error.message,
        'claude plugin marketplace list returned unrecognized output',
      );
      assert.doesNotMatch(JSON.stringify(error), /might be configured|output truncated/);
      return true;
    });
    assert.equal(calls.length, 2);
  }
});

test('rejects a marketplace name collision whose source is not exact', async () => {
  const { calls, run } = scriptedRunner([
    { stdout: claudeNoPlugins },
    {
      stdout: `Configured marketplaces:

  ❯ mattstack
    Source: Directory (/another/source)
`,
    },
  ]);

  await assert.rejects(
    installClaude({ source, run }),
    /mattstack marketplace is configured from a different source/,
  );
  assert.equal(calls.length, 2);
});

test('Codex rejects malformed JSON using fixed context without echoing output', async () => {
  const { run } = scriptedRunner([
    { stdout: '{"installed":[', stderr: 'private-diagnostic' },
    { stdout: codexNoMarketplaces },
  ]);

  await assert.rejects(installCodex({ source, run }), (error) => {
    assert.equal(error.message, 'codex plugin list returned invalid JSON');
    assert.doesNotMatch(JSON.stringify(error), /private-diagnostic|installed/);
    return true;
  });
});

test('Codex rejects syntactically valid plugin JSON with the wrong shape', async () => {
  const { run } = scriptedRunner([
    { stdout: '{"installed":{},"available":[]}' },
    { stdout: codexNoMarketplaces },
  ]);

  await assert.rejects(installCodex({ source, run }), (error) => {
    assert.equal(error.message, 'codex plugin list returned unexpected JSON');
    assert.doesNotMatch(JSON.stringify(error), /installed|available/);
    return true;
  });
});

test('Codex rejects malformed install JSON and preserves completed changes', async () => {
  const { run } = scriptedRunner([
    { stdout: codexEmptyPlugins },
    { stdout: codexNoMarketplaces },
    { stdout: '{"marketplaceName":"mattstack","alreadyAdded":false}' },
    { stdout: '{"pluginId":', stderr: 'install-json-secret' },
  ]);

  await assert.rejects(installCodex({ source, run }), (error) => {
    assert.equal(error.message, 'codex plugin add returned invalid JSON');
    assert.deepEqual(error.result, {
      host: 'codex',
      changed: true,
      changes: ['marketplace-added'],
      next: 'Retry installing fast-browser@mattstack.',
    });
    assert.doesNotMatch(JSON.stringify(error), /install-json-secret|pluginId/);
    return true;
  });
});

test('Codex validates marketplace add identity and status before recording a change', async () => {
  const invalidResults = [
    '{}',
    '{"marketplaceName":"other","alreadyAdded":false}',
    '{"marketplaceName":"mattstack","alreadyAdded":true}',
  ];

  for (const stdout of invalidResults) {
    const { calls, run } = scriptedRunner([
      { stdout: codexEmptyPlugins },
      { stdout: codexNoMarketplaces },
      { stdout },
    ]);

    await assert.rejects(installCodex({ source, run }), (error) => {
      assert.equal(error.message, 'codex plugin marketplace returned unexpected JSON');
      assert.deepEqual(error.result, {
        host: 'codex',
        changed: false,
        changes: [],
        next: 'Retry installing fast-browser@mattstack.',
      });
      return true;
    });
    assert.equal(calls.length, 3);
  }
});

test('Codex validates upgrade, remove, and add result identities', async () => {
  const gitMarketplace = {
    stdout: JSON.stringify({
      marketplaces: [{
        name: 'mattstack',
        root: '/cache/mattstack',
        marketplaceSource: { sourceType: 'git', source: gitSource },
      }],
    }),
  };
  const cases = [
    {
      responses: [
        { stdout: codexPlugins('0.1.0-alpha.1', gitSource) },
        gitMarketplace,
        { stdout: '{"marketplaceName":"other"}' },
      ],
      message: 'codex plugin marketplace returned unexpected JSON',
      changes: [],
      changed: false,
      calls: 3,
    },
    {
      responses: [
        { stdout: codexPlugins('0.0.9', gitSource) },
        gitMarketplace,
        { stdout: '{"marketplaceName":"mattstack"}' },
        { stdout: '{"pluginId":"other@mattstack"}' },
      ],
      message: 'codex plugin remove returned unexpected JSON',
      changes: ['marketplace-refreshed'],
      changed: false,
      calls: 4,
    },
    {
      responses: [
        { stdout: codexEmptyPlugins },
        { stdout: codexNoMarketplaces },
        { stdout: '{"marketplaceName":"mattstack","alreadyAdded":false}' },
        { stdout: '{"pluginId":"other@mattstack"}' },
      ],
      message: 'codex plugin add returned unexpected JSON',
      changes: ['marketplace-added'],
      changed: true,
      calls: 4,
    },
  ];

  for (const fixture of cases) {
    const { calls, run } = scriptedRunner([...fixture.responses]);
    await assert.rejects(installCodex({
      source: fixture === cases[2] ? source : gitSource,
      run,
    }), (error) => {
      assert.equal(error.message, fixture.message);
      assert.deepEqual(error.result.changes, fixture.changes);
      assert.equal(error.result.changed, fixture.changed);
      return true;
    });
    assert.equal(calls.length, fixture.calls);
  }
});

test('Codex rejects contradictory or wrong-source installed records before mutation', async () => {
  const fixtures = [
    (plugin) => { plugin.installed = false; },
    (plugin) => { plugin.name = 'not-fast-browser'; },
    (plugin) => { plugin.marketplaceSource.sourceType = 'git'; },
    (plugin) => { plugin.source.path = `${source}/plugins/not-fast-browser`; },
    (plugin) => { plugin.source.path = `${source}/plugins/fast-browser/../escape`; },
  ];

  for (const mutate of fixtures) {
    const value = JSON.parse(codexPlugins());
    mutate(value.installed[0]);
    const { calls, run } = scriptedRunner([
      { stdout: JSON.stringify(value) },
      { stdout: codexMarketplace },
    ]);

    await assert.rejects(installCodex({ source, run }), (error) => {
      assert.equal(error.message, 'codex plugin list returned unexpected JSON');
      return true;
    });
    assert.equal(calls.length, 2);
  }
});

test('detectHosts omits ENOENT, retains installed CLIs with nonzero exits, and orders deterministically', async () => {
  const run = async (command, args) => {
    assert.deepEqual(args, ['--version']);
    if (command === 'claude') {
      const error = new Error('spawn-secret');
      error.code = 'ENOENT';
      throw error;
    }
    return result(command, args, '', { exitCode: 2, stderr: 'license error' });
  };

  assert.deepEqual(await detectHosts({ run }), ['codex']);
});

test('detectHosts redacts unexpected executable errors', async () => {
  const run = async (command) => {
    if (command === 'claude') {
      const error = new Error('permission secret');
      error.code = 'EACCES';
      throw error;
    }
    return result(command, ['--version'], 'codex-cli');
  };

  await assert.rejects(detectHosts({ run }), (error) => {
    assert.equal(error.message, 'unable to detect claude CLI: EACCES');
    assert.doesNotMatch(JSON.stringify(error), /permission secret/);
    return true;
  });
});
