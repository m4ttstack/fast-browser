import assert from 'node:assert/strict';
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
  assert.equal(paths.pluginRoot, '/plugin');
});
