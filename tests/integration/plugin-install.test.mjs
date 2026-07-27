import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { run } from '../../lib/core/process.mjs';
import { installClaude, uninstallClaude } from '../../lib/hosts/claude.mjs';
import { installCodex, uninstallCodex } from '../../lib/hosts/codex.mjs';

const pluginRoot = path.resolve(import.meta.dirname, '../..');
const repositoryRoot = path.resolve(pluginRoot, '../..');
// Read from the manifest rather than pinned: a literal version here turns
// every release bump into an unrelated failure and asserts nothing the
// manifest does not already state.
const pluginVersion = JSON.parse(
  await readFile(path.join(pluginRoot, 'package.json'), 'utf8'),
).version;

function parseJson(result) {
  assert.equal(result.exitCode, 0, `${result.command} exited ${result.exitCode}`);
  return JSON.parse(result.stdout);
}

test('both host adapters resolve the local catalog from isolated homes', {
  timeout: 30_000,
}, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-hosts-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const directories = {
    home: path.join(temporaryRoot, 'home'),
    claude: path.join(temporaryRoot, 'claude'),
    codex: path.join(temporaryRoot, 'codex'),
    xdgConfig: path.join(temporaryRoot, 'xdg-config'),
    xdgCache: path.join(temporaryRoot, 'xdg-cache'),
    xdgData: path.join(temporaryRoot, 'xdg-data'),
    xdgRuntime: path.join(temporaryRoot, 'xdg-runtime'),
    temporary: path.join(temporaryRoot, 'tmp'),
  };
  await Promise.all(Object.values(directories).map((directory) => mkdir(directory)));

  const env = {
    HOME: directories.home,
    PATH: process.env.PATH,
    TMPDIR: directories.temporary,
    CLAUDE_CONFIG_DIR: directories.claude,
    CODEX_HOME: directories.codex,
    XDG_CONFIG_HOME: directories.xdgConfig,
    XDG_CACHE_HOME: directories.xdgCache,
    XDG_DATA_HOME: directories.xdgData,
    XDG_RUNTIME_DIR: directories.xdgRuntime,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  const isolatedRun = (command, args) => run(command, args, { env, timeoutMs: 10_000 });

  assert.deepEqual(await installClaude({ source: repositoryRoot, run: isolatedRun }), {
    host: 'claude',
    changed: true,
    changes: ['marketplace-added', 'plugin-installed'],
  });
  assert.deepEqual(await installCodex({ source: repositoryRoot, run: isolatedRun }), {
    host: 'codex',
    changed: true,
    changes: ['marketplace-added', 'plugin-installed'],
  });

  const [claudeInstalled, codexInstalled] = await Promise.all([
    isolatedRun('claude', ['plugin', 'list', '--available', '--json']).then(parseJson),
    isolatedRun('codex', ['plugin', 'list', '--available', '--json']).then(parseJson),
  ]);
  const claudeInstall = claudeInstalled.installed.find(
    ({ id }) => id === 'fast-browser@mattstack',
  );
  const codexInstall = codexInstalled.installed.find(
    ({ pluginId }) => pluginId === 'fast-browser@mattstack',
  );
  assert.ok(claudeInstall.installPath.startsWith(`${directories.claude}${path.sep}`));
  assert.equal(codexInstall.source.path, pluginRoot);
  assert.ok((await stat(path.join(
    directories.codex,
    'plugins',
    'cache',
    'mattstack',
    'fast-browser',
    pluginVersion,
  ))).isDirectory());

  assert.equal((await uninstallClaude({ run: isolatedRun })).changed, true);
  assert.equal((await uninstallCodex({ run: isolatedRun })).changed, true);

  const [claudeAvailable, codexAvailable, claudeMarketplaces, codexMarketplaces] =
    await Promise.all([
      isolatedRun('claude', ['plugin', 'list', '--available', '--json']).then(parseJson),
      isolatedRun('codex', ['plugin', 'list', '--available', '--json']).then(parseJson),
      isolatedRun('claude', ['plugin', 'marketplace', 'list']),
      isolatedRun('codex', ['plugin', 'marketplace', 'list', '--json']).then(parseJson),
    ]);

  const claudePlugin = claudeAvailable.available.find(
    ({ pluginId }) => pluginId === 'fast-browser@mattstack',
  );
  const codexPlugin = codexAvailable.available.find(
    ({ pluginId }) => pluginId === 'fast-browser@mattstack',
  );
  const claudeResolvedPlugin = path.resolve(repositoryRoot, claudePlugin.source);
  const codexResolvedPlugin = codexPlugin.source.path;

  assert.equal(claudePlugin.version, pluginVersion);
  assert.equal(codexPlugin.version, pluginVersion);
  assert.equal(claudeResolvedPlugin, pluginRoot);
  assert.equal(codexResolvedPlugin, pluginRoot);
  assert.equal(claudeResolvedPlugin, codexResolvedPlugin);
  assert.match(
    claudeMarketplaces.stdout,
    new RegExp(`Source: Directory \\(${repositoryRoot.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`),
  );
  assert.deepEqual(
    codexMarketplaces.marketplaces.find(({ name }) => name === 'mattstack')
      .marketplaceSource,
    {
      sourceType: 'local',
      source: repositoryRoot,
    },
  );
});
