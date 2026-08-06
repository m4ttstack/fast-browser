import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ConfigError, defaultConfig, loadConfig, parseConfig } from '../../lib/core/config.mjs';
import { ensurePrivateDirectory, saveConfig } from '../../lib/core/files.mjs';
import { resolvePaths } from '../../lib/core/paths.mjs';

function configFor(overrides = {}) {
  return {
    ...defaultConfig(),
    ...overrides,
  };
}

async function temporaryPaths(t) {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'fast-browser-test-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  return resolvePaths({ homeDir, pluginRoot: '/plugin' });
}

test('safe config contains no secret and disables recording', () => {
  assert.deepEqual(defaultConfig(), {
    schemaVersion: 1,
    productVersion: '0.1.0-alpha.1',
    profile: 'safe',
    hosts: { claude: false, codex: false },
    connection: { mode: 'manual' },
    sessions: { enabled: false, retentionDays: 30 },
    runtime: { version: null, sha256: null, sourceCommit: null },
    managed: { files: [], blocks: [] },
    annotation: { palette: null },
    video: null,
    trace: true,
    encoder: 'lexical',
  });
});

test('parsing returns a clean supported config without unknown keys', () => {
  const parsed = parseConfig({
    ...defaultConfig(),
    unknown: 'discard me',
    hosts: { claude: true, codex: false, other: true },
    connection: { mode: 'auto', token: 'discard me' },
    sessions: { enabled: true, retentionDays: 90, recordings: 'discard me' },
    runtime: { version: '1.2.3', sha256: 'abc123', sourceCommit: 'deadbeef', cache: true },
    managed: { files: ['a'], blocks: ['b'], extra: 'discard me' },
  });

  assert.deepEqual(parsed, {
    schemaVersion: 1,
    productVersion: '0.1.0-alpha.1',
    profile: 'safe',
    hosts: { claude: true, codex: false },
    connection: { mode: 'auto' },
    sessions: { enabled: true, retentionDays: 90 },
    runtime: { version: '1.2.3', sha256: 'abc123', sourceCommit: 'deadbeef' },
    managed: { files: ['a'], blocks: ['b'] },
    annotation: { palette: null },
    video: null,
    trace: true,
    encoder: 'lexical',
  });
});

test('config preserves validated routing ownership records for exact cleanup', () => {
  const managed = {
    files: [{ path: '/home/test/.codex/agents/browser_driver.toml', sha256: 'a'.repeat(64) }],
    blocks: [{
      path: '/home/test/.codex/config.toml',
      id: 'mcp-policy-v1',
      kind: 'toml',
      sha256: 'b'.repeat(64),
      containerCreated: true,
    }],
  };
  assert.deepEqual(
    parseConfig(configFor({ managed })),
    configFor({ managed }),
  );
});

test('rejects unsupported schema versions', () => {
  assert.throws(
    () => parseConfig(configFor({ schemaVersion: 2 })),
    ConfigError,
  );
});

test('rejects unknown profiles', () => {
  assert.throws(
    () => parseConfig(configFor({ profile: 'insecure' })),
    ConfigError,
  );
});

test('rejects invalid session retention', () => {
  assert.throws(
    () => parseConfig(configFor({ sessions: { enabled: true, retentionDays: 0 } })),
    ConfigError,
  );
  assert.throws(
    () => parseConfig(configFor({ sessions: { enabled: true, retentionDays: 366 } })),
    ConfigError,
  );
});

test('rejects invalid config field types', () => {
  assert.throws(
    () => parseConfig(configFor({ hosts: { claude: 'true', codex: false } })),
    ConfigError,
  );
  assert.throws(
    () => parseConfig(configFor({ sessions: { enabled: false, retentionDays: '30' } })),
    ConfigError,
  );
  assert.throws(
    () => parseConfig(configFor({ managed: { files: 'a', blocks: [] } })),
    ConfigError,
  );
});

test('private directories are mode 0700', async (t) => {
  const paths = await temporaryPaths(t);
  const directory = path.join(paths.dataDir, 'nested');

  await mkdir(directory, { recursive: true, mode: 0o755 });
  await ensurePrivateDirectory(directory);

  assert.equal((await stat(directory)).mode & 0o777, 0o700);
});

test('atomically rewrites the config without leaving temporary files and uses mode 0600', async (t) => {
  const paths = await temporaryPaths(t);
  await ensurePrivateDirectory(paths.dataDir);
  await writeFile(paths.configFile, '{"obsolete":true}\n', { mode: 0o644 });

  const config = configFor({ profile: 'full' });
  await saveConfig(paths, config);

  assert.deepEqual(JSON.parse(await readFile(paths.configFile, 'utf8')), config);
  assert.equal((await stat(paths.configFile)).mode & 0o777, 0o600);
  const entries = await readdir(paths.dataDir);
  assert.equal(entries.some((entry) => entry.startsWith('.config.json.') && entry.endsWith('.tmp')), false);
});

test('removes sensitive temp config when atomic promotion fails', async (t) => {
  const paths = await temporaryPaths(t);
  await ensurePrivateDirectory(paths.dataDir);
  await mkdir(paths.configFile);

  await assert.rejects(
    () => saveConfig(paths, configFor({ profile: 'full' })),
    (error) => error?.code === 'EISDIR',
  );
  assert.equal((await stat(paths.configFile)).isDirectory(), true);
  const entries = await readdir(paths.dataDir);
  assert.equal(entries.some((entry) => entry.startsWith('.config.json.') && entry.endsWith('.tmp')), false);
});

test('loads and validates a saved config', async (t) => {
  const paths = await temporaryPaths(t);
  const config = configFor({ profile: 'full' });

  await saveConfig(paths, config);

  assert.deepEqual(await loadConfig(paths), config);
});

test('fails closed when the config file is missing', async (t) => {
  const paths = await temporaryPaths(t);

  await assert.rejects(() => loadConfig(paths), ConfigError);
});

test('fails closed when the config file is malformed', async (t) => {
  const paths = await temporaryPaths(t);
  await ensurePrivateDirectory(paths.dataDir);
  await writeFile(paths.configFile, '{not-json}\n', { mode: 0o600 });

  await assert.rejects(() => loadConfig(paths), ConfigError);
});

test('annotation palette defaults to unset so the first use must choose', () => {
  assert.equal(defaultConfig().annotation.palette, null);
});

test('an existing v1 config without an annotation block still parses', () => {
  const legacy = defaultConfig();
  delete legacy.annotation;
  assert.equal(parseConfig(legacy).annotation.palette, null);
});

test('a stored palette round-trips and an invalid one is refused', () => {
  const config = { ...defaultConfig(), annotation: { palette: 'teal' } };
  assert.equal(parseConfig(config).annotation.palette, 'teal');
  assert.throws(
    () => parseConfig({ ...defaultConfig(), annotation: { palette: 'burgundy' } }),
    /annotation.palette/,
  );
});

test('video recording defaults to off so a session never records unasked', () => {
  assert.equal(defaultConfig().video, null);
});

test('an existing v1 config without a video field still parses as off', () => {
  const legacy = defaultConfig();
  delete legacy.video;
  assert.equal(parseConfig(legacy).video, null);
});

test('a stored video size round-trips and an invalid one is refused', () => {
  const stored = { ...defaultConfig(), video: { width: 1280, height: 720 } };
  assert.deepEqual(parseConfig(stored).video, { width: 1280, height: 720 });

  for (const video of [
    'on',
    ['1280', '720'],
    { width: '1280', height: 720 },
    { width: 1280.5, height: 720 },
    { width: 319, height: 720 },
    { width: 3841, height: 720 },
    { width: 1280, height: 239 },
    { width: 1280, height: 2161 },
    { width: 1280 },
  ]) {
    assert.throws(
      () => parseConfig({ ...defaultConfig(), video }),
      /video/,
      JSON.stringify(video),
    );
  }
});

test('trace defaults to true so a session captures a trace unless disabled', () => {
  assert.equal(defaultConfig().trace, true);
});

test('parseConfig honors an explicit trace: false', () => {
  assert.equal(parseConfig(configFor({ trace: false })).trace, false);
});

test('an existing v1 config without a trace field still parses as enabled', () => {
  const legacy = defaultConfig();
  delete legacy.trace;
  assert.equal(parseConfig(legacy).trace, true);
});

test('rejects a non-boolean trace value', () => {
  assert.throws(
    () => parseConfig(configFor({ trace: 'yes' })),
    /trace/,
  );
});

// --- encoder (WS3b Task 7) ---

test('encoder defaults to lexical so find/heal ranking is unchanged unless opted in', () => {
  assert.equal(defaultConfig().encoder, 'lexical');
});

test('parseConfig honors an explicit encoder: voyage', () => {
  assert.equal(parseConfig(configFor({ encoder: 'voyage' })).encoder, 'voyage');
});

test('an existing v1 config without an encoder field still parses as lexical', () => {
  const legacy = defaultConfig();
  delete legacy.encoder;
  assert.equal(parseConfig(legacy).encoder, 'lexical');
});

test('rejects an encoder value that is neither lexical nor voyage', () => {
  assert.throws(
    () => parseConfig(configFor({ encoder: 'openai' })),
    /encoder/,
  );
});
