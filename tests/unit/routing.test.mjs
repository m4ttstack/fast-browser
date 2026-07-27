import assert from 'node:assert/strict';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolvePaths } from '../../lib/core/paths.mjs';
import {
  beginOwnedCodexAgentFallback,
  escapeTomlString,
  installRouting,
  prepareRoutingTransition,
  preflightRoutingRemoval,
  removeRouting,
  rewriteOwnedCodexAgentWithoutPreferredModel,
} from '../../lib/hosts/routing.mjs';
import { nodeFileTransactionIo } from '../../lib/hosts/file-transaction.mjs';
import { renderCodexAgent } from '../../lib/hosts/codex-agent.mjs';

const pluginRoot = path.resolve(import.meta.dirname, '../..');
const safePolicy = [
  '# fast-browser:start mcp-policy-v1',
  '[plugins."fast-browser@mattstack".mcp_servers.fast_browser]',
  'enabled = true',
  'default_tools_approval_mode = "writes"',
  '',
  '[plugins."fast-browser@mattstack".mcp_servers.fast_browser.tools.browser_run_code_unsafe]',
  'approval_mode = "prompt"',
  '# fast-browser:end mcp-policy-v1',
].join('\n');
// FULL profile policy content depends on the resolved plugin root, so it is
// derived per-call rather than a fixed constant like safePolicy above.
function fullPolicy(root) {
  const mcpServerPath = path.join(root, 'bin', 'fast-browser-mcp.mjs');
  return [
    '# fast-browser:start mcp-policy-v1',
    '[plugins."fast-browser@mattstack".mcp_servers.fast_browser]',
    'enabled = true',
    'default_tools_approval_mode = "approve"',
    '',
    '[plugins."fast-browser@mattstack".mcp_servers.fast_browser.tools.browser_run_code_unsafe]',
    'approval_mode = "approve"',
    '',
    '[mcp_servers.fast_browser]',
    'command = "node"',
    `args = ["${mcpServerPath}"]`,
    '# fast-browser:end mcp-policy-v1',
  ].join('\n');
}

async function temporaryPaths(t) {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-routing-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  return resolvePaths({ homeDir, pluginRoot });
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function routingTargets(paths) {
  return [
    path.join(paths.homeDir, '.claude', 'rules', 'fast-browser-routing.md'),
    path.join(
      paths.homeDir,
      '.claude',
      'rules',
      'fast-browser-verification-consent.md',
    ),
    path.join(paths.homeDir, '.codex', 'AGENTS.md'),
    path.join(paths.homeDir, '.codex', 'AGENTS.override.md'),
    path.join(paths.homeDir, '.codex', 'agents', 'browser_driver.toml'),
    path.join(paths.homeDir, '.codex', 'config.toml'),
  ];
}

async function snapshotTarget(target) {
  try {
    return { exists: true, bytes: await readFile(target) };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, bytes: null };
    throw error;
  }
}

async function snapshotTargets(targets) {
  return Promise.all(targets.map(snapshotTarget));
}

function assertOwnershipRecords(state) {
  for (const entry of [...state.files, ...state.blocks]) {
    assert.equal(path.isAbsolute(entry.path), true);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  }
}

test('safe installs only the Codex agent and exact prompt-oriented MCP policy', async (t) => {
  const paths = await temporaryPaths(t);
  const codexDir = path.join(paths.homeDir, '.codex');
  const configFile = path.join(codexDir, 'config.toml');
  await mkdir(codexDir, { recursive: true });
  await writeFile(configFile, 'user_setting = true\r\n', { mode: 0o644 });

  const state = await installRouting({
    profile: 'safe',
    paths,
    codexVersion: 'codex-cli 0.145.0',
  });

  const agentFile = path.join(codexDir, 'agents', 'browser_driver.toml');
  const config = await readFile(configFile, 'utf8');
  assert.match(await readFile(agentFile, 'utf8'), /^model = "gpt-5\.6-terra"$/m);
  assert.equal(
    config,
    `user_setting = true\r\n\r\n${safePolicy.replaceAll('\n', '\r\n')}`,
  );
  // SAFE profile stays byte-identical: no external [mcp_servers] table. The
  // plugin-scoped `writes` / `prompt` approval gates only apply to the
  // plugin-scoped table, not to external [mcp_servers] entries, so adding
  // this table under SAFE would silently bypass the safe profile's approval
  // posture.
  assert.doesNotMatch(config, /\[mcp_servers\.fast_browser\]/);
  assert.equal(await exists(path.join(paths.homeDir, '.claude', 'rules')), false);
  assert.equal(await exists(path.join(codexDir, 'AGENTS.md')), false);
  assert.deepEqual(state.files.map(({ path: target }) => target), [agentFile]);
  assert.deepEqual(state.blocks.map(({ path: target }) => target), [configFile]);
  assertOwnershipRecords(state);
  assert.equal((await stat(agentFile)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(agentFile))).mode & 0o777, 0o700);
  assert.equal((await stat(configFile)).mode & 0o777, 0o600);

  const second = await installRouting({
    profile: 'safe',
    paths,
    codexVersion: 'codex-cli 0.145.0',
    managedState: state,
  });
  assert.deepEqual(second, state);
  assert.equal(await readFile(configFile, 'utf8'), config);
});

test('routing installs only resources owned by the selected hosts', async (t) => {
  const paths = await temporaryPaths(t);

  const claude = await installRouting({
    profile: 'full',
    hosts: ['claude'],
    paths,
  });

  assert.deepEqual(
    claude.files.map(({ path: target }) => path.relative(paths.homeDir, target)).sort(),
    [
      '.claude/rules/fast-browser-routing.md',
      '.claude/rules/fast-browser-verification-consent.md',
    ],
  );
  assert.deepEqual(claude.blocks, []);
  assert.equal(await exists(path.join(paths.homeDir, '.codex')), false);

  const codex = await installRouting({
    profile: 'full',
    hosts: ['codex'],
    paths,
    codexVersion: 'codex-cli 0.145.0',
    managedState: claude,
  });

  assert.equal(await exists(path.join(paths.homeDir, '.claude', 'rules')), true);
  assert.equal(
    await exists(path.join(
      paths.homeDir,
      '.claude',
      'rules',
      'fast-browser-routing.md',
    )),
    false,
  );
  assert.deepEqual(
    codex.files.map(({ path: target }) => path.relative(paths.homeDir, target)),
    ['.codex/agents/browser_driver.toml'],
  );
  assert.deepEqual(
    codex.blocks.map(({ path: target }) => path.relative(paths.homeDir, target)).sort(),
    ['.codex/AGENTS.md', '.codex/config.toml'],
  );

  const claudeSafe = await installRouting({
    profile: 'safe',
    hosts: ['claude'],
    paths,
    managedState: codex,
  });
  assert.deepEqual(claudeSafe.files, []);
  assert.deepEqual(claudeSafe.blocks, []);
  assert.equal(await exists(path.join(paths.homeDir, '.codex', 'agents')), true);
  assert.equal(
    await exists(path.join(paths.homeDir, '.codex', 'agents', 'browser_driver.toml')),
    false,
  );
});

test('Claude-only routing ignores an unrelated symlinked Codex tree', async (t) => {
  const paths = await temporaryPaths(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-unselected-codex-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(paths.homeDir, '.codex'), 'dir');

  const state = await installRouting({
    profile: 'full',
    hosts: ['claude'],
    paths,
  });

  assert.deepEqual(
    state.files.map(({ path: target }) => path.relative(paths.homeDir, target)).sort(),
    [
      '.claude/rules/fast-browser-routing.md',
      '.claude/rules/fast-browser-verification-consent.md',
    ],
  );
  assert.deepEqual(state.blocks, []);
  assert.deepEqual(await readdir(outside), []);
});

test('full installs dedicated Claude rules and routes through AGENTS.override.md', async (t) => {
  const paths = await temporaryPaths(t);
  const codexDir = path.join(paths.homeDir, '.codex');
  const agentsFile = path.join(codexDir, 'AGENTS.md');
  const overrideFile = path.join(codexDir, 'AGENTS.override.md');
  const configFile = path.join(codexDir, 'config.toml');
  const originalAgents = 'ordinary instructions\n';
  const originalOverride = 'override instructions\r\n';
  const originalConfig = 'user_setting = true\r\n';
  await mkdir(codexDir, { recursive: true });
  await writeFile(agentsFile, originalAgents);
  await writeFile(overrideFile, originalOverride);
  await writeFile(configFile, originalConfig);

  const state = await installRouting({
    profile: 'full',
    paths,
    codexVersion: 'codex 0.144.99',
  });

  const claudeRouting = path.join(
    paths.homeDir,
    '.claude',
    'rules',
    'fast-browser-routing.md',
  );
  const claudeConsent = path.join(
    paths.homeDir,
    '.claude',
    'rules',
    'fast-browser-verification-consent.md',
  );
  const codexAgent = path.join(codexDir, 'agents', 'browser_driver.toml');
  assert.equal(await readFile(agentsFile, 'utf8'), originalAgents);
  const installedOverride = await readFile(overrideFile, 'utf8');
  assert.match(installedOverride, /<!-- fast-browser:start routing-v1 -->/);
  assert.match(
    installedOverride,
    /Fast Browser takes precedence over `browser-use:browser`/,
  );
  assert.match(installedOverride, /delegate.*browser-driver/i);
  assert.doesNotMatch(await readFile(codexAgent, 'utf8'), /^model = /m);
  assert.match(
    await readFile(claudeRouting, 'utf8'),
    /Do not fall back to Claude in Chrome unless the user explicitly requests it\./,
  );
  assert.match(
    await readFile(claudeConsent, 'utf8'),
    /browser_run_code_unsafe.*privileged and state-changing/i,
  );
  assert.equal(
    await readFile(configFile, 'utf8'),
    `${originalConfig}\r\n${fullPolicy(pluginRoot).replaceAll('\n', '\r\n')}`,
  );
  assert.deepEqual(
    state.files.map(({ path: target }) => target).sort(),
    [claudeConsent, claudeRouting, codexAgent].sort(),
  );
  assert.deepEqual(
    state.blocks.map(({ path: target }) => target).sort(),
    [configFile, overrideFile].sort(),
  );
  assertOwnershipRecords(state);

  await removeRouting({ paths, managedState: state });

  assert.equal(await exists(claudeRouting), false);
  assert.equal(await exists(claudeConsent), false);
  assert.equal(await exists(codexAgent), false);
  assert.equal(await readFile(overrideFile, 'utf8'), originalOverride);
  assert.equal(await readFile(configFile, 'utf8'), originalConfig);
  assert.equal(await readFile(agentsFile, 'utf8'), originalAgents);
});

test('FULL profile Codex policy also registers Fast Browser as an external mcp_servers entry', async (t) => {
  const paths = await temporaryPaths(t);
  const configFile = path.join(paths.homeDir, '.codex', 'config.toml');

  const state = await installRouting({
    profile: 'full',
    hosts: ['codex'],
    paths,
    codexVersion: 'codex-cli 0.145.0',
  });

  const config = await readFile(configFile, 'utf8');
  assert.equal(config, fullPolicy(pluginRoot));
  const match = config.match(
    /\[mcp_servers\.fast_browser\]\ncommand = "node"\nargs = \["([^"]+)"\]/,
  );
  assert.ok(match, 'expected an external [mcp_servers.fast_browser] table');
  const [, mcpServerPath] = match;
  assert.equal(path.isAbsolute(mcpServerPath), true);
  assert.equal(mcpServerPath.endsWith('/bin/fast-browser-mcp.mjs'), true);
  assert.equal(mcpServerPath, path.join(pluginRoot, 'bin', 'fast-browser-mcp.mjs'));
  await access(mcpServerPath);

  // Idempotency under FULL: a second install carrying the recorded
  // managedState makes no further change, matching the safe-profile pattern.
  const second = await installRouting({
    profile: 'full',
    hosts: ['codex'],
    paths,
    codexVersion: 'codex-cli 0.145.0',
    managedState: state,
  });
  assert.deepEqual(second, state);
  assert.equal(await readFile(configFile, 'utf8'), config);
});

test('TOML string escaping helper escapes backslashes and double quotes', () => {
  assert.equal(escapeTomlString('/plain/path/bin/fast-browser-mcp.mjs'), '/plain/path/bin/fast-browser-mcp.mjs');
  assert.equal(
    escapeTomlString('/Users/te"st/bin/fast-browser-mcp.mjs'),
    '/Users/te\\"st/bin/fast-browser-mcp.mjs',
  );
  assert.equal(escapeTomlString('back\\slash'), 'back\\\\slash');
  assert.equal(
    escapeTomlString('back\\slash"and"quote'),
    'back\\\\slash\\"and\\"quote',
  );
});

test('full to safe transition removes only routing no longer owned by the safe profile', async (t) => {
  const paths = await temporaryPaths(t);
  const full = await installRouting({
    profile: 'full',
    paths,
    codexVersion: '0.145.0',
  });

  const safe = await installRouting({
    profile: 'safe',
    paths,
    codexVersion: '0.145.0',
    managedState: full,
  });

  assert.equal(
    await exists(path.join(
      paths.homeDir,
      '.claude',
      'rules',
      'fast-browser-routing.md',
    )),
    false,
  );
  assert.equal(
    await exists(path.join(
      paths.homeDir,
      '.claude',
      'rules',
      'fast-browser-verification-consent.md',
    )),
    false,
  );
  assert.equal(
    await exists(path.join(paths.homeDir, '.codex', 'AGENTS.md')),
    false,
  );
  assert.equal(safe.files.length, 1);
  assert.equal(safe.blocks.length, 1);
  assert.match(
    await readFile(path.join(paths.homeDir, '.codex', 'config.toml'), 'utf8'),
    /default_tools_approval_mode = "writes"/,
  );
});

test('AGENTS target transition removes the old owned block and preserves both user files', async (t) => {
  const paths = await temporaryPaths(t);
  const codexDir = path.join(paths.homeDir, '.codex');
  const agentsFile = path.join(codexDir, 'AGENTS.md');
  const overrideFile = path.join(codexDir, 'AGENTS.override.md');
  await mkdir(codexDir, { recursive: true });
  await writeFile(agentsFile, 'ordinary instructions\n');
  const first = await installRouting({ profile: 'full', paths });
  await writeFile(overrideFile, 'override instructions\r\n');

  const second = await installRouting({
    profile: 'full',
    paths,
    managedState: first,
  });

  assert.equal(await readFile(agentsFile, 'utf8'), 'ordinary instructions\n');
  assert.match(
    await readFile(overrideFile, 'utf8'),
    /<!-- fast-browser:start routing-v1 -->/,
  );
  assert.equal(
    second.blocks.some(({ path: target }) => target === agentsFile),
    false,
  );
  assert.equal(
    second.blocks.some(({ path: target }) => target === overrideFile),
    true,
  );
});

test('removal preserves pre-existing empty config and AGENTS container files', async (t) => {
  const paths = await temporaryPaths(t);
  const codexDir = path.join(paths.homeDir, '.codex');
  const agentsFile = path.join(codexDir, 'AGENTS.md');
  const configFile = path.join(codexDir, 'config.toml');
  await mkdir(codexDir, { recursive: true });
  await writeFile(agentsFile, '');
  await writeFile(configFile, '');

  const state = await installRouting({ profile: 'full', paths });
  await removeRouting({ paths, managedState: state });

  assert.equal(await exists(agentsFile), true);
  assert.equal(await exists(configFile), true);
  assert.equal(await readFile(agentsFile, 'utf8'), '');
  assert.equal(await readFile(configFile, 'utf8'), '');
});

test('refuses a non-owned dedicated file before making any routing change', async (t) => {
  const paths = await temporaryPaths(t);
  const codexDir = path.join(paths.homeDir, '.codex');
  const agentFile = path.join(codexDir, 'agents', 'browser_driver.toml');
  const configFile = path.join(codexDir, 'config.toml');
  await mkdir(path.dirname(agentFile), { recursive: true });
  await writeFile(agentFile, 'user-owned = true\n');
  await writeFile(configFile, 'keep = true\n');

  await assert.rejects(
    installRouting({ profile: 'safe', paths, codexVersion: '0.145.0' }),
    /non-owned|conflict/i,
  );

  assert.equal(await readFile(agentFile, 'utf8'), 'user-owned = true\n');
  assert.equal(await readFile(configFile, 'utf8'), 'keep = true\n');
});

test('treats an existing empty dedicated file as a non-owned conflict', async (t) => {
  const paths = await temporaryPaths(t);
  const agentFile = path.join(
    paths.homeDir,
    '.codex',
    'agents',
    'browser_driver.toml',
  );
  await mkdir(path.dirname(agentFile), { recursive: true });
  await writeFile(agentFile, '');

  await assert.rejects(
    installRouting({ profile: 'safe', paths }),
    /non-owned|conflict/i,
  );
  assert.equal(await readFile(agentFile, 'utf8'), '');
  assert.equal(
    await exists(path.join(paths.homeDir, '.codex', 'config.toml')),
    false,
  );
});

test('rejects a symlinked host parent before writing outside the supplied home', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-confined-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, 'home');
  const outside = path.join(root, 'outside');
  await mkdir(homeDir);
  await mkdir(outside);
  await symlink(outside, path.join(homeDir, '.codex'), 'dir');
  const paths = resolvePaths({ homeDir, pluginRoot });

  await assert.rejects(
    installRouting({ profile: 'safe', paths }),
    /symlink|confined/i,
  );

  assert.deepEqual(await readdir(outside), []);
  assert.equal(await exists(path.join(homeDir, '.claude')), false);
});

test('removal verifies all ownership before deleting or rewriting anything', async (t) => {
  const paths = await temporaryPaths(t);
  const state = await installRouting({
    profile: 'safe',
    paths,
    codexVersion: '0.145.0',
  });
  const [agent] = state.files;
  const [config] = state.blocks;
  const configBefore = await readFile(config.path, 'utf8');
  await chmod(agent.path, 0o600);
  await writeFile(agent.path, `${await readFile(agent.path, 'utf8')}# user edit\n`);

  await assert.rejects(
    removeRouting({ paths, managedState: state }),
    /ownership|hash|changed/i,
  );

  assert.equal(await exists(agent.path), true);
  assert.equal(await readFile(config.path, 'utf8'), configBefore);
});

test('desired destination rejects an externally inserted routing block before mutation', async (t) => {
  const paths = await temporaryPaths(t);
  const prior = await installRouting({ profile: 'full', paths });
  const desiredState = structuredClone(prior);
  const recordedAgentsPath = prior.blocks.find(
    ({ id, kind }) => id === 'routing-v1' && kind === 'markdown',
  ).path;
  await removeRouting({ paths, managedState: prior });
  const externalBytes = [
    'external',
    '<!-- fast-browser:start routing-v1 -->',
    'not owned',
    '<!-- fast-browser:end routing-v1 -->',
  ].join('\n');
  await mkdir(path.dirname(recordedAgentsPath), { recursive: true });
  await writeFile(recordedAgentsPath, externalBytes);

  const operation = prepareRoutingTransition({
    profile: 'full',
    paths,
    managedState: null,
    desiredState,
  });
  await assert.rejects(operation, /routing block destination conflict/i);
  assert.equal(await readFile(recordedAgentsPath, 'utf8'), externalBytes);
});

test('unrecorded policy block conflicts even when its bytes match generated policy', async (t) => {
  const paths = await temporaryPaths(t);
  const configFile = path.join(paths.homeDir, '.codex', 'config.toml');
  await mkdir(path.dirname(configFile), { recursive: true });
  await writeFile(configFile, safePolicy);

  await assert.rejects(
    prepareRoutingTransition({ profile: 'safe', paths }),
    /routing block destination conflict/i,
  );
  assert.equal(await readFile(configFile, 'utf8'), safePolicy);
  assert.equal(
    await exists(path.join(paths.homeDir, '.codex', 'agents', 'browser_driver.toml')),
    false,
  );
});

test('unrecorded dedicated file conflicts even when its bytes match generated file', async (t) => {
  const paths = await temporaryPaths(t);
  const agentFile = path.join(
    paths.homeDir,
    '.codex',
    'agents',
    'browser_driver.toml',
  );
  const generated = renderCodexAgent({ usePreferredModel: true });
  await mkdir(path.dirname(agentFile), { recursive: true });
  await writeFile(agentFile, generated);

  await assert.rejects(
    prepareRoutingTransition({
      profile: 'safe',
      paths,
      codexVersion: '0.145.0',
    }),
    /routing file destination conflict/i,
  );
  assert.equal(await readFile(agentFile, 'utf8'), generated);
});

test('transaction preparation detects drift in a later managed target before mutation', async (t) => {
  const paths = await temporaryPaths(t);
  const managedState = await installRouting({ profile: 'full', paths });
  const targets = routingTargets(paths);
  const policy = managedState.blocks.find(({ kind }) => kind === 'toml');
  const external = (await readFile(policy.path, 'utf8'))
    .replace('default_tools_approval_mode = "approve"', 'external = true');
  await writeFile(policy.path, external);
  const before = await snapshotTargets(targets);

  await assert.rejects(
    prepareRoutingTransition({
      profile: 'safe',
      paths,
      managedState,
    }),
    /ownership|hash|changed/i,
  );
  assert.deepEqual(await snapshotTargets(targets), before);
});

test('apply rejects drift in an unchanged retained Codex agent before mutating routing', async (t) => {
  const paths = await temporaryPaths(t);
  const managedState = await installRouting({
    profile: 'safe',
    hosts: ['codex'],
    paths,
    codexVersion: 'codex-cli 0.145.0',
  });
  const agentPath = managedState.files[0].path;
  const configPath = managedState.blocks[0].path;
  const configBefore = await readFile(configPath, 'utf8');
  const prepared = await prepareRoutingTransition({
    profile: 'full',
    hosts: ['codex'],
    paths,
    codexVersion: 'codex-cli 0.145.0',
    managedState,
  });
  await writeFile(agentPath, 'external retained agent drift\n');

  await assert.rejects(
    prepared.apply(),
    /routing transaction preflight failed/i,
  );

  assert.equal(await readFile(agentPath, 'utf8'), 'external retained agent drift\n');
  assert.equal(await readFile(configPath, 'utf8'), configBefore);
  assert.equal(
    await exists(path.join(paths.homeDir, '.codex', 'AGENTS.md')),
    false,
  );
});

test('AGENTS transition consolidates removal and installation to one mutation per path', async (t) => {
  const paths = await temporaryPaths(t);
  const codexDir = path.join(paths.homeDir, '.codex');
  const agentsFile = path.join(codexDir, 'AGENTS.md');
  const overrideFile = path.join(codexDir, 'AGENTS.override.md');
  await mkdir(codexDir, { recursive: true });
  await writeFile(agentsFile, 'ordinary instructions\n');
  const first = await installRouting({ profile: 'full', paths });
  await writeFile(overrideFile, 'override instructions\r\n');
  const mutations = [];
  const io = {
    ...nodeFileTransactionIo,
    async mutate(change) {
      mutations.push(change.path);
      return nodeFileTransactionIo.mutate(change);
    },
  };

  const prepared = await prepareRoutingTransition({
    profile: 'full',
    paths,
    managedState: first,
    transactionIo: io,
  });
  await prepared.apply();

  assert.equal(new Set(mutations).size, mutations.length);
  assert.equal(mutations.filter((target) => target === agentsFile).length, 1);
  assert.equal(mutations.filter((target) => target === overrideFile).length, 1);
  assert.equal(await readFile(agentsFile, 'utf8'), 'ordinary instructions\n');
  assert.match(
    await readFile(overrideFile, 'utf8'),
    /<!-- fast-browser:start routing-v1 -->/,
  );
});

test('routing transaction reverses every injected partial mutation failure', async (t) => {
  for (let failAt = 0; failAt < 5; failAt += 1) {
    const paths = await temporaryPaths(t);
    const codexDir = path.join(paths.homeDir, '.codex');
    await mkdir(codexDir, { recursive: true });
    await writeFile(path.join(codexDir, 'AGENTS.md'), 'unrelated markdown\r\n');
    await writeFile(path.join(codexDir, 'config.toml'), 'unrelated = true\n');
    const targets = routingTargets(paths);
    const before = await snapshotTargets(targets);
    let mutationIndex = 0;
    const io = {
      ...nodeFileTransactionIo,
      async mutate(change) {
        if (mutationIndex++ === failAt) {
          throw new Error('injected routing mutation failure');
        }
        return nodeFileTransactionIo.mutate(change);
      },
    };
    const prepared = await prepareRoutingTransition({
      profile: 'full',
      paths,
      transactionIo: io,
    });

    await assert.rejects(
      prepared.apply(),
      /routing transaction apply failed/i,
    );
    assert.deepEqual(await snapshotTargets(targets), before);
  }
});

test('reciprocal routing receipt restores exact prior bytes and container provenance', async (t) => {
  const paths = await temporaryPaths(t);
  const codexDir = path.join(paths.homeDir, '.codex');
  const agentsFile = path.join(codexDir, 'AGENTS.md');
  const configFile = path.join(codexDir, 'config.toml');
  await mkdir(codexDir, { recursive: true });
  await writeFile(agentsFile, 'unrelated markdown\r\n');
  await writeFile(configFile, 'unrelated = true\n');
  const prior = await installRouting({ profile: 'full', paths });
  const priorSummary = await preflightRoutingRemoval({
    paths,
    managedState: prior,
  });
  const targets = routingTargets(paths);
  const before = await snapshotTargets(targets);
  assert.deepEqual(
    prior.blocks.map(({ containerCreated }) => containerCreated),
    [false, false],
  );

  const prepared = await prepareRoutingTransition({
    profile: 'safe',
    paths,
    managedState: prior,
  });
  const receipt = await prepared.apply();
  await receipt.rollback();

  assert.deepEqual(await snapshotTargets(targets), before);
  assert.deepEqual(
    await preflightRoutingRemoval({ paths, managedState: prior }),
    priorSummary,
  );
  assert.match(await readFile(agentsFile, 'utf8'), /^unrelated markdown\r\n/);
  assert.match(await readFile(configFile, 'utf8'), /^unrelated = true\n/);
});

test('refuses duplicate or malformed TOML markers without installing the agent', async (t) => {
  const paths = await temporaryPaths(t);
  const configFile = path.join(paths.homeDir, '.codex', 'config.toml');
  const malformed = [
    '# fast-browser:start mcp-policy-v1',
    '# fast-browser:end mcp-policy-v1',
    '# fast-browser:start mcp-policy-v1',
    '# fast-browser:end mcp-policy-v1',
  ].join('\n');
  await mkdir(path.dirname(configFile), { recursive: true });
  await writeFile(configFile, malformed);

  await assert.rejects(
    installRouting({ profile: 'safe', paths }),
    /duplicate/i,
  );
  assert.equal(
    await exists(path.join(paths.homeDir, '.codex', 'agents', 'browser_driver.toml')),
    false,
  );
});

test('rejects a bare carriage return after a TOML marker', async (t) => {
  const paths = await temporaryPaths(t);
  const configFile = path.join(paths.homeDir, '.codex', 'config.toml');
  await mkdir(path.dirname(configFile), { recursive: true });
  await writeFile(
    configFile,
    '# fast-browser:start other-v1\rbody\n'
      + '# fast-browser:end other-v1\n',
  );

  await assert.rejects(
    installRouting({ profile: 'safe', paths }),
    /malformed/i,
  );
});

test('owned Codex agent fallback rewrites atomically and updates its ownership hash', async (t) => {
  const paths = await temporaryPaths(t);
  const state = await installRouting({
    profile: 'safe',
    paths,
    codexVersion: '0.145.0',
  });
  const before = await readFile(state.files[0].path, 'utf8');

  const updated = await rewriteOwnedCodexAgentWithoutPreferredModel({
    paths,
    managedState: state,
  });

  const after = await readFile(state.files[0].path, 'utf8');
  assert.equal(after, before.replace(/^model = "gpt-5\.6-terra"\n/m, ''));
  assert.doesNotMatch(after, /^model = /m);
  assert.notEqual(updated.files[0].sha256, state.files[0].sha256);
  assertOwnershipRecords(updated);
  assert.equal((await stat(state.files[0].path)).mode & 0o777, 0o600);
});

test('Codex agent fallback transaction restores original bytes only while it retains ownership', async (t) => {
  const paths = await temporaryPaths(t);
  const originalManagedState = await installRouting({
    profile: 'safe',
    paths,
    codexVersion: '0.145.0',
  });
  const agentPath = originalManagedState.files[0].path;
  const originalBytes = await readFile(agentPath, 'utf8');
  const originalOwnershipSummary = await preflightRoutingRemoval({
    paths,
    managedState: originalManagedState,
  });

  const receipt = await beginOwnedCodexAgentFallback({
    paths,
    managedState: originalManagedState,
  });
  assert.notEqual(
    receipt.managedState.files[0].sha256,
    originalManagedState.files[0].sha256,
  );
  await receipt.rollback();
  assert.equal(await readFile(agentPath, 'utf8'), originalBytes);
  assert.deepEqual(await preflightRoutingRemoval({
    paths,
    managedState: originalManagedState,
  }), originalOwnershipSummary);

  const externallyChanged = await beginOwnedCodexAgentFallback({
    paths,
    managedState: originalManagedState,
  });
  const externalBytes = `${await readFile(agentPath, 'utf8')}# external change\n`;
  await writeFile(agentPath, externalBytes);
  await assert.rejects(externallyChanged.rollback(), /ownership|hash|changed/i);
  assert.equal(await readFile(agentPath, 'utf8'), externalBytes);
});

test('Codex fallback original-ownership errors do not expose the target path', async (t) => {
  const temporary = await temporaryPaths(t);
  const paths = resolvePaths({
    homeDir: path.join(temporary.homeDir, 'maintainer-secret-home'),
    pluginRoot,
  });
  const managedState = await installRouting({
    profile: 'safe',
    paths,
    codexVersion: '0.145.0',
  });
  const agentPath = managedState.files[0].path;
  await writeFile(agentPath, `${await readFile(agentPath, 'utf8')}# external change\n`);

  await assert.rejects(
    beginOwnedCodexAgentFallback({ paths, managedState }),
    (error) => {
      assert.match(error.message, /ownership/i);
      assert.equal(error.message.includes(agentPath), false);
      assert.doesNotMatch(error.message, /maintainer|secret/i);
      return true;
    },
  );
});

test('Codex fallback rollback-ownership errors do not expose the target path', async (t) => {
  const temporary = await temporaryPaths(t);
  const paths = resolvePaths({
    homeDir: path.join(temporary.homeDir, 'maintainer-secret-home'),
    pluginRoot,
  });
  const managedState = await installRouting({
    profile: 'safe',
    paths,
    codexVersion: '0.145.0',
  });
  const agentPath = managedState.files[0].path;
  const receipt = await beginOwnedCodexAgentFallback({ paths, managedState });
  await writeFile(agentPath, `${await readFile(agentPath, 'utf8')}# external change\n`);

  await assert.rejects(
    receipt.rollback(),
    (error) => {
      assert.match(error.message, /ownership/i);
      assert.equal(error.message.includes(agentPath), false);
      assert.doesNotMatch(error.message, /maintainer|secret/i);
      return true;
    },
  );
});
