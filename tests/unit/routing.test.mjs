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
  installRouting,
  removeRouting,
  rewriteOwnedCodexAgentWithoutPreferredModel,
} from '../../lib/hosts/routing.mjs';

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
const fullPolicy = safePolicy
  .replace('"writes"', '"approve"')
  .replace('"prompt"', '"approve"');

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
    `${originalConfig}\r\n${fullPolicy.replaceAll('\n', '\r\n')}`,
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
