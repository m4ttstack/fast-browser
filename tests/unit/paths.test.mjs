import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { resolvePaths } from '../../lib/core/paths.mjs';

test('resolves every mutable path below the supplied home', () => {
  const paths = resolvePaths({ homeDir: '/tmp/fb-home', pluginRoot: '/plugin' });

  assert.equal(paths.homeDir, '/tmp/fb-home');
  assert.equal(paths.dataDir, '/tmp/fb-home/.fast-browser');
  assert.equal(paths.configFile, '/tmp/fb-home/.fast-browser/config.json');
  assert.equal(paths.macrosDir, '/tmp/fb-home/.fast-browser/macros');
  assert.equal(paths.sessionsDir, '/tmp/fb-home/.fast-browser/sessions');
  assert.equal(paths.runtimeDir, '/tmp/fb-home/.fast-browser/runtime');
  assert.equal(paths.extensionDir, '/tmp/fb-home/.fast-browser/extension');
  assert.equal(paths.archiveDir, '/tmp/fb-home/.fast-browser/archive');
  assert.equal(paths.backupsDir, '/tmp/fb-home/.fast-browser/backups');
  assert.equal(paths.macroIndexFile, '/tmp/fb-home/.fast-browser/macros/MACROS.md');
  assert.equal(paths.macroFailuresFile, '/tmp/fb-home/.fast-browser/macro-failures.md');
  assert.equal(paths.rejectedMacrosFile, '/tmp/fb-home/.fast-browser/rejected-macros.md');
  assert.equal(paths.rejectedFlowsFile, '/tmp/fb-home/.fast-browser/rejected-flows.md');
  assert.equal(paths.pluginRoot, '/plugin');
});

// The launcher paths sit under ~/.local/bin rather than the data dir, and
// deriving them here is what lets every test point them at a temp home
// instead of the developer's real one.
test('launcher paths resolve below the supplied home, outside the data dir', () => {
  const paths = resolvePaths({ homeDir: '/tmp/fb-home', pluginRoot: '/plugin' });
  assert.equal(paths.launcherDir, '/tmp/fb-home/.local/bin');
  assert.equal(paths.launcherFile, '/tmp/fb-home/.local/bin/fast-browser');
});

test('screenshotsDir is an exact data-directory child', () => {
  const paths = resolvePaths({ homeDir: '/tmp/fb-home', pluginRoot: '/plugin' });
  assert.equal(paths.screenshotsDir, '/tmp/fb-home/.fast-browser/screenshots');
});

test('resolvePaths exposes flow directories under the data dir', () => {
  const paths = resolvePaths({ homeDir: '/home/u', pluginRoot: '/p' });
  assert.equal(paths.flowsDir, path.join('/home/u', '.fast-browser', 'flows'));
  assert.equal(paths.flowsPendingDir, path.join('/home/u', '.fast-browser', 'flows-pending'));
  assert.equal(paths.flowsStateFile, path.join('/home/u', '.fast-browser', 'flows-state.json'));
});

test('resolvePaths exposes sitesDir under the data dir', () => {
  const paths = resolvePaths({ homeDir: '/home/u', pluginRoot: '/p' });
  assert.equal(paths.sitesDir, path.join('/home/u', '.fast-browser', 'sites'));
});

test('resolvePaths exposes the runs ledger directory and file under the data dir', () => {
  const paths = resolvePaths({ homeDir: '/home/u', pluginRoot: '/p' });
  assert.equal(paths.runsDir, path.join('/home/u', '.fast-browser', 'runs'));
  assert.equal(paths.runsFile, path.join('/home/u', '.fast-browser', 'runs', 'runs.jsonl'));
});
