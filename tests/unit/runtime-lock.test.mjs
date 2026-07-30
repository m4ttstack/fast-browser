import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { buildContentManifestDigest } from '../../lib/core/content-manifest.mjs';
import {
  loadRuntimeLock,
  parseRuntimeLock,
} from '../../lib/runtime/lock.mjs';
import { launchRuntime, runtimeArgs } from '../../lib/runtime/launch.mjs';

const RUNTIME_SHA = 'a'.repeat(64);
const EXTENSION_SHA = 'b'.repeat(64);
const execFile = promisify(execFileCallback);

function fixtureLock(runtimeUrl = 'http://127.0.0.1:4567/runtime.tar.gz') {
  return {
    schemaVersion: 1,
    productVersion: '0.1.0-alpha.1',
    sourceCommit: '0123456789abcdef',
    protocolVersion: 2,
    runtime: {
      url: runtimeUrl,
      file: 'fast-browser-mcp-0.1.0-alpha.1.tar.gz',
      sha256: RUNTIME_SHA,
      node: '>=20',
    },
    extension: {
      url: 'http://localhost:4567/extension.zip',
      file: 'fast-browser-extension-0.1.0-alpha.1.zip',
      sha256: EXTENSION_SHA,
      id: 'abcdefghijklmnopabcdefghijklmnop',
      version: '0.2.1',
    },
  };
}

function fixtureIdentity(lock) {
  return {
    schemaVersion: lock.schemaVersion,
    productVersion: lock.productVersion,
    sourceCommit: lock.sourceCommit,
    protocolVersion: lock.protocolVersion,
    runtime: {
      file: lock.runtime.file,
      sha256: lock.runtime.sha256,
      node: lock.runtime.node,
    },
    extension: {
      file: lock.extension.file,
      sha256: lock.extension.sha256,
      id: lock.extension.id,
      version: lock.extension.version,
    },
  };
}

test('parses a complete lock and returns only its supported fields', () => {
  const input = fixtureLock();
  input.ignored = 'discard me';

  assert.deepEqual(parseRuntimeLock(input), fixtureLock());
});

test('rejects every runtime protocol version except exactly 2', () => {
  for (const protocolVersion of [1, 3]) {
    const input = fixtureLock();
    input.protocolVersion = protocolVersion;
    assert.throws(
      () => parseRuntimeLock(input),
      /protocolVersion.*exactly 2/i,
      `protocol ${protocolVersion}`,
    );
  }
});

test('bundled and local-candidate loaders reject protocol drift before returning a lock', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-protocol-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  for (const [kind, protocolVersion] of [['bundled', 1], ['local', 3]]) {
    const lock = fixtureLock();
    lock.protocolVersion = protocolVersion;
    if (kind === 'local') {
      delete lock.runtime.url;
      delete lock.extension.url;
    }
    const selected = path.join(directory, `${kind}.json`);
    await writeFile(selected, JSON.stringify(lock));
    await assert.rejects(
      loadRuntimeLock(kind === 'bundled'
        ? { bundledPath: selected }
        : { bundledPath: path.join(directory, 'unused.json'), overridePath: selected }),
      /protocolVersion.*exactly 2/i,
      kind,
    );
  }
});

test('rejects malformed checksums before installation', () => {
  for (const sha256 of ['a'.repeat(63), 'a'.repeat(65), `${'a'.repeat(63)}g`]) {
    const input = fixtureLock();
    input.runtime.sha256 = sha256;
    assert.throws(() => parseRuntimeLock(input), /runtime\.sha256.*64-character hexadecimal/i);
  }
});

test('rejects noncanonical or path-capable product versions', () => {
  for (const version of [
    '.',
    '..',
    '/tmp/escape',
    'C:\\escape',
    '1/../../escape',
    '1\\..\\escape',
    '%2e%2e',
    'v1.2.3',
    '1.2',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2.3-01',
    '1.2.3-',
  ]) {
    const input = fixtureLock();
    input.productVersion = version;
    input.runtime.file = `fast-browser-mcp-${version}.tar.gz`;
    input.extension.file = `fast-browser-extension-${version}.zip`;
    assert.throws(
      () => parseRuntimeLock(input),
      /productVersion.*canonical SemVer/i,
      version,
    );
  }
});

test('rejects noncanonical or path-capable extension versions', () => {
  for (const version of [
    '.',
    '..',
    '/tmp/escape',
    'C:\\escape',
    '1/../../escape',
    '1\\..\\escape',
    '%2e%2e',
    'v1.2.3',
    '1.2',
    '01.2.3',
    '1.2.3-01',
    '1.2.3+',
  ]) {
    const input = fixtureLock();
    input.extension.version = version;
    assert.throws(
      () => parseRuntimeLock(input),
      /extension\.version.*canonical SemVer/i,
      version,
    );
  }
});

test('accepts immutable GitHub release URLs and rejects mutable or remote HTTP URLs', () => {
  const immutable = fixtureLock(
    'https://github.com/m4ttheweric/playwright/releases/download/'
      + 'fast-browser-v0.1.0-alpha.1/fast-browser-mcp-0.1.0-alpha.1.tar.gz',
  );
  immutable.extension.url = 'https://github.com/m4ttheweric/playwright/releases/download/'
    + 'fast-browser-v0.1.0-alpha.1/fast-browser-extension-0.1.0-alpha.1.zip';
  assert.deepEqual(parseRuntimeLock(immutable), immutable);

  for (const url of [
    'https://github.com/m4ttheweric/playwright/releases/latest/download/runtime.tar.gz',
    'https://example.com/runtime.tar.gz',
    'http://192.0.2.1/runtime.tar.gz',
    'file:///tmp/runtime.tar.gz',
  ]) {
    const input = fixtureLock(url);
    assert.throws(() => parseRuntimeLock(input), /runtime\.url.*immutable GitHub release|loopback/i);
  }
});

test('loads a URL-free release override by resolving exact adjacent artifacts in memory', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-lock-'));
  const overridePath = path.join(directory, 'release.json');
  const release = fixtureLock();
  delete release.runtime.url;
  delete release.extension.url;
  await writeFile(overridePath, `${JSON.stringify(release)}\n`);

  const loaded = await loadRuntimeLock({
    bundledPath: path.join(directory, 'unused.json'),
    overridePath,
  });

  assert.equal(
    loaded.runtime.url,
    pathToFileURL(path.join(directory, release.runtime.file)).href,
  );
  assert.equal(
    loaded.extension.url,
    pathToFileURL(path.join(directory, release.extension.file)).href,
  );
  const persisted = JSON.parse(await readFile(overridePath, 'utf8'));
  assert.equal('url' in persisted.runtime, false);
  assert.equal('url' in persisted.extension, false);
});

test('rejects URL-bearing local overrides instead of persisting or trusting their locations', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-lock-'));
  const overridePath = path.join(directory, 'release.json');
  await writeFile(overridePath, JSON.stringify(fixtureLock()));

  await assert.rejects(
    loadRuntimeLock({ bundledPath: path.join(directory, 'unused.json'), overridePath }),
    /override.*must not contain artifact URLs/i,
  );
});

test('bundled lock pins the intended candidate identity and immutable artifact URLs', async () => {
  const bundledPath = new URL('../../runtime-lock.json', import.meta.url);
  const lock = await loadRuntimeLock({ bundledPath });

  assert.deepEqual(lock, {
    schemaVersion: 1,
    productVersion: '0.1.0-alpha.8',
    sourceCommit: 'c714013f4bde551e3540e4f69f0a2525479d47f4',
    protocolVersion: 2,
    runtime: {
      url: 'https://github.com/m4ttheweric/playwright/releases/download/'
        + 'fast-browser-v0.1.0-alpha.8/fast-browser-mcp-0.1.0-alpha.8.tar.gz',
      file: 'fast-browser-mcp-0.1.0-alpha.8.tar.gz',
      sha256: '11a7a0d79580fdd69ecbf62db2ffc2155b0d70921880c36594057e5f194e8f13',
      node: '>=20',
    },
    extension: {
      url: 'https://github.com/m4ttheweric/playwright/releases/download/'
        + 'fast-browser-v0.1.0-alpha.8/fast-browser-extension-0.1.0-alpha.8.zip',
      file: 'fast-browser-extension-0.1.0-alpha.8.zip',
      sha256: '764beb8d2adca7b50a34a648a98005bfbc845d253fb43d6ef90ad54e52b23ad5',
      id: 'bjlfojdaaanoliidngocnbcalhpfmlie',
      version: '0.2.4',
    },
  });
});

// The literal pin above is a deliberate gate: re-pinning must be an explicit
// edit. These invariants additionally catch shape drift a copied-in literal
// would not, such as a URL left pointing at the previous release.
test('bundled lock is internally consistent whatever it pins', async () => {
  const bundledPath = new URL('../../runtime-lock.json', import.meta.url);
  const lock = await loadRuntimeLock({ bundledPath });

  for (const artifact of [lock.runtime, lock.extension]) {
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
    assert.ok(artifact.url.startsWith('https://'));
    assert.ok(artifact.url.endsWith(`/${artifact.file}`));
    assert.ok(artifact.file.includes(lock.productVersion));
    assert.ok(artifact.url.includes(`fast-browser-v${lock.productVersion}/`));
  }
  assert.notEqual(lock.runtime.sha256, lock.extension.sha256);
  assert.match(lock.sourceCommit, /^[0-9a-f]{40}$/);
});

function launcherConfig(profile = 'safe', mode = 'manual') {
  return {
    profile,
    connection: { mode },
    sessions: { enabled: profile === 'full' },
  };
}

function launcherPaths(directory) {
  return {
    dataDir: path.join(directory, '.fast-browser'),
    runtimeDir: path.join(directory, '.fast-browser', 'runtime'),
  };
}

test('builds exact safe and full runtime argument snapshots', () => {
  const paths = launcherPaths('/synthetic-home');
  const lock = fixtureLock();
  const base = [
    '--extension',
    '--extension-id=abcdefghijklmnopabcdefghijklmnop',
    '--snapshot-mode=none',
    '--timeout-settle=200',
    `--output-dir=${paths.dataDir}`,
  ];

  assert.deepEqual(runtimeArgs({ config: launcherConfig('safe'), paths, lock }), base);
  assert.deepEqual(runtimeArgs({ config: launcherConfig('full'), paths, lock }), [
    ...base,
    '--save-session',
  ]);
});

// Video is orthogonal to the profile: it rides on either arg set, and its
// absence (the default) adds nothing. The runtime ignores the flag for
// attached extension-relay browsers, so passing it alongside --extension is
// deliberate and harmless.
test('runtimeArgs appends --save-video exactly when a video size is configured', () => {
  const paths = launcherPaths('/synthetic-home');
  const lock = fixtureLock();
  const video = { width: 1280, height: 720 };

  assert.deepEqual(
    runtimeArgs({ config: { ...launcherConfig('safe'), video }, paths, lock }),
    [...runtimeArgs({ config: launcherConfig('safe'), paths, lock }), '--save-video=1280x720'],
  );
  assert.deepEqual(
    runtimeArgs({ config: { ...launcherConfig('full'), video }, paths, lock }),
    [...runtimeArgs({ config: launcherConfig('full'), paths, lock }), '--save-video=1280x720'],
  );
  assert.deepEqual(
    runtimeArgs({ config: { ...launcherConfig('safe'), video: null }, paths, lock }),
    runtimeArgs({ config: launcherConfig('safe'), paths, lock }),
  );
});

async function installedLauncher() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-launch-'));
  const paths = launcherPaths(directory);
  const lock = fixtureLock();
  const cli = path.join(
    paths.runtimeDir,
    lock.productVersion,
    'fast-browser-mcp',
    'cli.cjs',
  );
  await mkdir(path.dirname(cli), { recursive: true });
  await writeFile(cli, '#!/usr/bin/env node\n');
  const contentDigest = await buildContentManifestDigest(path.dirname(cli));
  await writeFile(
    path.join(paths.runtimeDir, lock.productVersion, 'installed.json'),
    JSON.stringify({ schemaVersion: 1, lock: fixtureIdentity(lock), contentDigest }),
  );
  return { paths, lock, cli };
}

function exitingSpawn(exitCode, captured) {
  return (command, args, options) => {
    captured.push({ command, args, options });
    const child = new EventEmitter();
    process.nextTick(() => child.emit('exit', exitCode, null));
    return child;
  };
}

test('launches without a shell and scopes an auto-mode token to the child environment', async () => {
  const { paths, lock, cli } = await installedLauncher();
  const captured = [];
  let tokenReads = 0;
  const result = await launchRuntime({
    config: launcherConfig('full', 'auto'),
    paths,
    lock,
    readToken: async () => {
      tokenReads += 1;
      return 'synthetic-secret';
    },
    spawn: exitingSpawn(0, captured),
  });

  assert.equal(result, 0);
  assert.equal(tokenReads, 1);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].command, process.execPath);
  assert.deepEqual(captured[0].args, [
    cli,
    ...runtimeArgs({ config: launcherConfig('full', 'auto'), paths, lock }),
  ]);
  assert.equal(captured[0].options.stdio, 'inherit');
  assert.equal(captured[0].options.shell, false);
  assert.equal(captured[0].options.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, 'synthetic-secret');
});

test('manual mode never reads a token and passes the process environment by identity', async () => {
  const { paths, lock } = await installedLauncher();
  const captured = [];
  await launchRuntime({
    config: launcherConfig('safe', 'manual'),
    paths,
    lock,
    readToken: async () => assert.fail('manual mode must not read a token'),
    spawn: exitingSpawn(0, captured),
  });

  assert.equal(captured[0].options.env, process.env);
});

test('auto mode maps missing or failed token reads to one-line doctor errors', async () => {
  for (const readToken of [
    async () => null,
    async () => {
      throw new Error('keychain\nfailed');
    },
  ]) {
    const { paths, lock } = await installedLauncher();
    let spawnCalls = 0;
    await assert.rejects(
      launchRuntime({
        config: launcherConfig('safe', 'auto'),
        paths,
        lock,
        readToken,
        spawn: exitingSpawn(0, {
          push() {
            spawnCalls += 1;
          },
        }),
      }),
      (error) => error.message.includes('fast-browser doctor')
        && !error.message.includes('\n'),
    );
    assert.equal(spawnCalls, 0);
  }
});

test('missing runtime, spawn ENOENT, and nonzero exits are one-line doctor errors', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-launch-'));
  const paths = launcherPaths(directory);
  const lock = fixtureLock();
  let spawnCalls = 0;
  await assert.rejects(
    launchRuntime({
      config: launcherConfig(),
      paths,
      lock,
      readToken: async () => null,
      spawn: () => {
        spawnCalls += 1;
      },
    }),
    (error) => error.message.includes('fast-browser doctor') && !error.message.includes('\n'),
  );
  assert.equal(spawnCalls, 0);

  await installedLauncher().then(async ({ paths: installedPaths, lock: installedLock }) => {
    const spawn = () => {
      const child = new EventEmitter();
      process.nextTick(() => {
        const error = new Error('missing executable');
        error.code = 'ENOENT';
        child.emit('error', error);
      });
      return child;
    };
    await assert.rejects(
      launchRuntime({
        config: launcherConfig(),
        paths: installedPaths,
        lock: installedLock,
        readToken: async () => null,
        spawn,
      }),
      (error) => error.message.includes('fast-browser doctor') && !error.message.includes('\n'),
    );
  });

  await installedLauncher().then(async ({ paths: installedPaths, lock: installedLock }) => {
    await assert.rejects(
      launchRuntime({
        config: launcherConfig(),
        paths: installedPaths,
        lock: installedLock,
        readToken: async () => null,
        spawn: exitingSpawn(7, []),
      }),
      (error) => /exited with code 7.*fast-browser doctor/.test(error.message)
        && !error.message.includes('\n'),
    );
  });
});

// bin/fast-browser-mcp.mjs -> launchRuntime is the literal entrypoint every
// host config (.mcp.json, adapters/codex/mcp.json, .codex-plugin/plugin.json)
// spawns on every session start, entirely independent of setup and doctor.
// A CLI tampered in place after a clean install -- the marker left exactly
// as the real install wrote it -- must never be executed.
test('refuses to launch a tampered CLI even though its marker is otherwise honest', async () => {
  const { paths, lock, cli } = await installedLauncher();
  await writeFile(cli, '#!/usr/bin/env node\nprocess.stdout.write("malicious");\n');
  let spawnCalls = 0;
  await assert.rejects(
    launchRuntime({
      config: launcherConfig(),
      paths,
      lock,
      readToken: async () => null,
      spawn: () => {
        spawnCalls += 1;
      },
    }),
    (error) => error.message.includes('fast-browser setup')
      && !error.message.includes('fast-browser doctor')
      && !error.message.includes('\n'),
  );
  assert.equal(spawnCalls, 0);
});

// Requirement 5 (backward compatibility), applied to the launch path too: a
// marker written before content-digest verification existed carries no
// digest at all. Even when the CLI bytes it describes are untouched, that
// legacy shape must be treated as unverified (fail closed), never trusted.
test('refuses to launch over a legacy marker with no content digest, even with untouched bytes', async () => {
  const { paths, lock } = await installedLauncher();
  const markerPath = path.join(paths.runtimeDir, lock.productVersion, 'installed.json');
  const legacyMarker = JSON.parse(await readFile(markerPath, 'utf8'));
  delete legacyMarker.contentDigest;
  await writeFile(markerPath, JSON.stringify(legacyMarker));
  let spawnCalls = 0;
  await assert.rejects(
    launchRuntime({
      config: launcherConfig(),
      paths,
      lock,
      readToken: async () => null,
      spawn: () => {
        spawnCalls += 1;
      },
    }),
    (error) => error.message.includes('fast-browser setup') && !error.message.includes('\n'),
  );
  assert.equal(spawnCalls, 0);
});

// An untampered install, with a real digest exactly as installRuntime
// writes it, must still launch normally: the new verification must not
// introduce any false positive against a genuine install.
test('launches normally when the installed CLI content matches its marker exactly', async () => {
  const { paths, lock, cli } = await installedLauncher();
  const captured = [];
  const result = await launchRuntime({
    config: launcherConfig(),
    paths,
    lock,
    readToken: async () => null,
    spawn: exitingSpawn(0, captured),
  });
  assert.equal(result, 0);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].args[0], cli);
});

test('wrapper help smoke never downloads when the runtime is missing', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-wrapper-'));
  const dataDir = path.join(home, '.fast-browser');
  await mkdir(dataDir);
  await writeFile(path.join(dataDir, 'config.json'), JSON.stringify({
    schemaVersion: 1,
    productVersion: '0.1.0-alpha.1',
    profile: 'safe',
    hosts: { claude: false, codex: false },
    connection: { mode: 'manual' },
    sessions: { enabled: false, retentionDays: 30 },
    runtime: { version: null, sha256: null, sourceCommit: null },
    managed: { files: [], blocks: [] },
  }));
  const wrapper = new URL('../../bin/fast-browser-mcp.mjs', import.meta.url);

  await assert.rejects(
    execFile(process.execPath, [wrapper.pathname, '--help'], {
      env: { ...process.env, HOME: home },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /fast-browser doctor/);
      assert.equal(error.stderr.trim().includes('\n'), false);
      return true;
    },
  );
  const runtimeDirectory = path.join(dataDir, 'runtime');
  await assert.rejects(readFile(path.join(runtimeDirectory, '.download')), /ENOENT/);
});

test('launcher refuses runtime roots and CLIs that symlink outside dataDir', async () => {
  for (const symlinkAt of ['root', 'cli']) {
    const home = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-launch-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-outside-'));
    const paths = launcherPaths(home);
    const lock = fixtureLock();
    const outsideCli = path.join(outside, 'outside-cli.cjs');
    await writeFile(outsideCli, 'do-not-launch\n');
    if (symlinkAt === 'root') {
      const outsideRuntime = path.join(
        outside,
        lock.productVersion,
        'fast-browser-mcp',
      );
      await mkdir(outsideRuntime, { recursive: true });
      await writeFile(path.join(outsideRuntime, 'cli.cjs'), 'do-not-launch\n');
      await writeFile(
        path.join(outside, lock.productVersion, 'installed.json'),
        JSON.stringify({ schemaVersion: 1, lock: fixtureIdentity(lock) }),
      );
      await mkdir(paths.dataDir, { recursive: true });
      await symlink(outside, paths.runtimeDir);
    } else {
      const installed = await installedLauncher();
      paths.dataDir = installed.paths.dataDir;
      paths.runtimeDir = installed.paths.runtimeDir;
      await rm(installed.cli);
      await symlink(outsideCli, installed.cli);
    }

    let spawnCalls = 0;
    await assert.rejects(
      launchRuntime({
        config: launcherConfig(),
        paths,
        lock,
        readToken: async () => null,
        spawn: () => {
          spawnCalls += 1;
        },
      }),
      /symlink|confined|outside|fast-browser doctor/i,
      symlinkAt,
    );
    assert.equal(spawnCalls, 0);
    assert.equal(await readFile(outsideCli, 'utf8'), 'do-not-launch\n');
  }
});
