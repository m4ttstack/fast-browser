import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { run } from '../../lib/core/process.mjs';
import { installClaude, uninstallClaude } from '../../lib/hosts/claude.mjs';
import { installCodex, uninstallCodex } from '../../lib/hosts/codex.mjs';

const execFile = promisify(execFileCallback);
const pluginRoot = path.resolve(import.meta.dirname, '../..');
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

// This repo stopped being a marketplace in MAT-378; the catalog that will
// serve it is generated at release time from the sibling repos and published
// as m4ttstack/mattstack-marketplace (MAT-389). Build that shape here rather
// than pointing at either the old repo-as-catalog or a developer's local
// checkout, so the test keeps exercising the adapters on any machine and
// survives the published catalog arriving.
//
// The plugin content is copied, never symlinked: Codex's
// localPluginPathMatches rejects a plugin path whose realpath escapes the
// marketplace root, which is precisely what a symlink into a sibling checkout
// does.
async function buildCatalog(root) {
  const pluginDirectory = path.join(root, 'plugins', 'fast-browser');
  const { stdout } = await execFile('npm', ['pack', '--dry-run', '--json'], {
    cwd: pluginRoot,
    maxBuffer: 32 * 1024 * 1024,
  });
  for (const { path: entry } of JSON.parse(stdout)[0].files) {
    const destination = path.join(pluginDirectory, entry);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(pluginRoot, entry), destination);
  }

  await mkdir(path.join(root, '.claude-plugin'), { recursive: true });
  await writeFile(
    path.join(root, '.claude-plugin', 'marketplace.json'),
    `${JSON.stringify({
      name: 'mattstack',
      owner: { name: 'Matthew Goodwin' },
      // Claude reports `version` in `plugin list --available` straight from the
      // catalog entry, not from the plugin's own manifest.
      plugins: [{
        name: 'fast-browser',
        source: './plugins/fast-browser',
        version: pluginVersion,
      }],
    }, null, 2)}\n`,
  );

  await mkdir(path.join(root, '.agents', 'plugins'), { recursive: true });
  await writeFile(
    path.join(root, '.agents', 'plugins', 'marketplace.json'),
    `${JSON.stringify({
      name: 'mattstack',
      interface: { displayName: 'Mattstack' },
      plugins: [{
        name: 'fast-browser',
        source: { source: 'local', path: './plugins/fast-browser' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Productivity',
      }],
    }, null, 2)}\n`,
  );

  return pluginDirectory;
}

test('both host adapters resolve the local catalog from isolated homes', {
  timeout: 30_000,
}, async (t) => {
  // realpath so path assertions survive macOS's /var -> /private/var symlink,
  // which the host adapters resolve away.
  const temporaryRoot = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'fast-browser-hosts-')),
  );
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

  const catalogRoot = path.join(temporaryRoot, 'catalog');
  const pluginDirectory = await buildCatalog(catalogRoot);

  assert.deepEqual(await installClaude({ source: catalogRoot, run: isolatedRun }), {
    host: 'claude',
    changed: true,
    changes: ['marketplace-added', 'plugin-installed'],
  });
  assert.deepEqual(await installCodex({ source: catalogRoot, run: isolatedRun }), {
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
  assert.equal(codexInstall.source.path, pluginDirectory);
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
  const claudeResolvedPlugin = path.resolve(catalogRoot, claudePlugin.source);
  const codexResolvedPlugin = codexPlugin.source.path;

  assert.equal(claudePlugin.version, pluginVersion);
  assert.equal(codexPlugin.version, pluginVersion);
  assert.equal(claudeResolvedPlugin, pluginDirectory);
  assert.equal(codexResolvedPlugin, pluginDirectory);
  assert.equal(claudeResolvedPlugin, codexResolvedPlugin);
  assert.match(
    claudeMarketplaces.stdout,
    new RegExp(`Source: Directory \\(${catalogRoot.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`),
  );
  assert.deepEqual(
    codexMarketplaces.marketplaces.find(({ name }) => name === 'mattstack')
      .marketplaceSource,
    {
      sourceType: 'local',
      source: catalogRoot,
    },
  );
});
