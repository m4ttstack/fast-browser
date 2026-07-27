import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { applyMigration } from '../../lib/migration/apply.mjs';
import { createMigrationBackup } from '../../lib/migration/backup.mjs';
import { importLegacyData } from '../../lib/migration/import-data.mjs';
import {
  inventoryLegacy,
  UNMANAGED_TOKEN_KEY_PLACEHOLDER,
} from '../../lib/migration/inventory.mjs';
import { rollbackMigration } from '../../lib/migration/rollback.mjs';

const fixtureRoot = fileURLToPath(new URL('../fixtures/legacy-home/', import.meta.url));
const secretFixture = 'legacy-token-fixture';
const links = [
  ['.claude/skills/mattstack:fast-browsing',
    '/Users/example/Documents/GitHub/mattstack/skills/browser/fast-browsing'],
  ['.claude/skills/mattstack:browser-macros',
    '/Users/example/Documents/GitHub/mattstack/skills/browser/browser-macros'],
  ['.claude/skills/mattstack:mine-macros',
    '/Users/example/Documents/GitHub/mattstack/skills/browser/mine-macros'],
];

async function fixtureHome(t, prefix = 'fast-browser-migration-') {
  const homeDir = await mkdtemp(path.join(await realpath(os.tmpdir()), prefix));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  await cp(fixtureRoot, homeDir, { recursive: true, dereference: false });
  return homeDir;
}

function migrationPaths(homeDir) {
  return {
    homeDir,
    dataDir: path.join(homeDir, '.fast-browser'),
    backupsDir: path.join(homeDir, '.fast-browser', 'backups'),
    macrosDir: path.join(homeDir, '.fast-browser', 'macros'),
    macroIndexFile: path.join(homeDir, '.fast-browser', 'macros', 'MACROS.md'),
    macroFailuresFile: path.join(homeDir, '.fast-browser', 'macro-failures.md'),
    sessionsDir: path.join(homeDir, '.fast-browser', 'sessions'),
    archiveDir: path.join(homeDir, '.fast-browser', 'archive'),
  };
}

async function lstatOrNull(pathname) {
  try {
    return await lstat(pathname);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function mode(pathname) {
  return (await lstat(pathname)).mode & 0o777;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function inventoryFixture(homeDir) {
  return inventoryLegacy(migrationPaths(homeDir));
}

async function readClaudeJson(homeDir) {
  return JSON.parse(await readFile(path.join(homeDir, '.claude.json'), 'utf8'));
}

async function writeClaudeJson(homeDir, value) {
  await writeFile(
    path.join(homeDir, '.claude.json'),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

async function applyFixture(homeDir, overrides = {}) {
  const events = [];
  try {
    const result = await applyMigration({
      paths: migrationPaths(homeDir),
      now: () => new Date('2026-07-26T12:00:00.000Z'),
      migrationId: 'fixture',
      writeMigratedToken: async (value) => {
        assert.equal(value, secretFixture);
        events.push('token');
      },
      installAdaptersAndRouting: async () => {
        events.push('install');
        return { hosts: ['claude', 'codex'] };
      },
      cleanupInstalled: async () => {
        events.push('cleanup-install');
      },
      verify: async () => {
        events.push('verify');
      },
      ...overrides,
    });
    return { events, result };
  } catch (error) {
    Object.defineProperty(error, 'events', { value: events });
    throw error;
  }
}

test('inventory recognizes only exact legacy registrations and import roots', async (t) => {
  const homeDir = await fixtureHome(t);
  const inventory = await inventoryFixture(homeDir);

  assert.deepEqual(
    inventory.files.map((entry) => path.relative(homeDir, entry.path)),
    [
      '.claude.json',
      '.claude/agents/browser-driver.md',
      '.claude/rules/playwright-first.md',
      '.claude/rules/playwright-verification.md',
    ],
  );
  assert.deepEqual(inventory.jsonEdits.map((entry) => entry.pointer), [
    '/mcpServers/playwright',
  ]);
  assert.deepEqual(
    inventory.symlinks.map((entry) => path.relative(homeDir, entry.path)),
    links.map(([relative]) => relative).sort(),
  );
  const serialized = JSON.stringify(inventory);
  assert.equal(serialized.includes('legacy-token-fixture'), false);
  assert.equal(serialized.includes('notes-server'), false);
  assert.equal(serialized.includes('keep.txt'), false);
});

test('inventory never mutates lookalike registrations but reports them as unmanaged candidates', async (t) => {
  const homeDir = await fixtureHome(t);
  assert.equal((await inventoryFixture(homeDir)).jsonEdits.length, 1);
  const value = await readClaudeJson(homeDir);
  value.mcpServers.playwright.args = ['@playwright/mcp@latest'];
  value.mcpServers['playwright-copy'] = {
    command: 'npx',
    args: ['@playwright/mcp@latest', '--extension'],
  };
  await writeClaudeJson(homeDir, value);

  const inventory = await inventoryFixture(homeDir);
  assert.deepEqual(inventory.jsonEdits, []);
  assert.deepEqual(inventory.unmanagedCandidates, [
    {
      key: 'playwright',
      command: 'npx',
      argCount: 1,
      envKeys: [UNMANAGED_TOKEN_KEY_PLACEHOLDER],
    },
    {
      key: 'playwright-copy',
      command: 'npx',
      argCount: 2,
      envKeys: [],
    },
  ]);
  const serialized = JSON.stringify(inventory);
  assert.equal(serialized.includes(secretFixture), false);
  assert.equal(serialized.includes('@playwright/mcp@latest'), false);
});

test('inventory recognizes the local development node invocation of Playwright MCP', async (t) => {
  const homeDir = await fixtureHome(t, 'fast-browser-migration-node-dev-');
  const value = await readClaudeJson(homeDir);
  value.mcpServers.playwright = {
    command: 'node',
    args: [
      '/Users/example/dev/playwright/packages/playwright-mcp/lib/mcp-server.js',
      '--snapshot-mode=none',
      '--save-session',
    ],
    env: {
      PLAYWRIGHT_MCP_EXTENSION: 'local-extension-id',
      PLAYWRIGHT_MCP_EXTENSION_TOKEN: secretFixture,
      PLAYWRIGHT_MCP_OUTPUT_DIR: '/Users/example/.playwright-mcp/output',
      PLAYWRIGHT_MCP_TIMEOUT_SETTLE: '5000',
    },
  };
  await writeClaudeJson(homeDir, value);

  const inventory = await inventoryFixture(homeDir);
  assert.equal(inventory.jsonEdits.length, 1);
  assert.equal(inventory.jsonEdits[0].pointer, '/mcpServers/playwright');
  assert.equal(
    inventory.jsonEdits[0].tokenPointer,
    '/mcpServers/playwright/env/PLAYWRIGHT_MCP_EXTENSION_TOKEN',
  );
  assert.deepEqual(inventory.unmanagedCandidates, []);
  assert.equal(JSON.stringify(inventory).includes(secretFixture), false);
});

test('inventory keeps recognizing the published npx invocation unchanged', async (t) => {
  const homeDir = await fixtureHome(t, 'fast-browser-migration-npx-unchanged-');
  const inventory = await inventoryFixture(homeDir);
  assert.deepEqual(inventory.jsonEdits.map((entry) => entry.pointer), ['/mcpServers/playwright']);
  assert.equal(
    inventory.jsonEdits[0].tokenPointer,
    '/mcpServers/playwright/env/PLAYWRIGHT_MCP_EXTENSION_TOKEN',
  );
  assert.deepEqual(inventory.unmanagedCandidates, []);
});

test('inventory reports an unrecognized node Playwright candidate without mutating it', async (t) => {
  const homeDir = await fixtureHome(t, 'fast-browser-migration-node-unmanaged-');
  const value = await readClaudeJson(homeDir);
  value.mcpServers.playwright = {
    command: 'node',
    args: ['/Users/example/dev/playwright/lib/mcp-server.js', '--headless'],
    env: {
      SOME_OTHER_VAR: 'value',
    },
  };
  await writeClaudeJson(homeDir, value);

  const inventory = await inventoryFixture(homeDir);
  assert.deepEqual(inventory.jsonEdits, []);
  assert.deepEqual(inventory.unmanagedCandidates, [{
    key: 'playwright',
    command: 'node',
    argCount: 2,
    envKeys: ['SOME_OTHER_VAR'],
  }]);
});

test('inventory never reports an MCP server with no playwright signal anywhere', async (t) => {
  const homeDir = await fixtureHome(t, 'fast-browser-migration-unrelated-');
  const value = await readClaudeJson(homeDir);
  value.mcpServers.other = {
    command: 'other-server',
    args: ['--flag'],
    env: { OTHER_VAR: 'x' },
  };
  await writeClaudeJson(homeDir, value);

  const inventory = await inventoryFixture(homeDir);
  assert.deepEqual(inventory.unmanagedCandidates.map((entry) => entry.key), []);
  assert.equal(JSON.stringify(inventory).includes('other-server'), false);
});

test('unmanaged candidates never expose env values or a raw token key name', async (t) => {
  const homeDir = await fixtureHome(t, 'fast-browser-migration-candidate-redaction-');
  const value = await readClaudeJson(homeDir);
  value.mcpServers['playwright-dev'] = {
    command: 'node',
    args: ['/Users/example/dev/playwright/lib/mcp-server.js'],
    env: {
      PLAYWRIGHT_MCP_EXTENSION_TOKEN: 'super-secret-dev-token',
      PLAYWRIGHT_MCP_OUTPUT_DIR: '/Users/example/.playwright-mcp/output',
    },
  };
  await writeClaudeJson(homeDir, value);

  const inventory = await inventoryFixture(homeDir);
  const candidate = inventory.unmanagedCandidates.find((entry) => entry.key === 'playwright-dev');
  assert.deepEqual(candidate, {
    key: 'playwright-dev',
    command: 'node',
    argCount: 1,
    envKeys: [UNMANAGED_TOKEN_KEY_PLACEHOLDER, 'PLAYWRIGHT_MCP_OUTPUT_DIR'],
  });
  const serialized = JSON.stringify(inventory);
  assert.equal(serialized.includes('super-secret-dev-token'), false);
  assert.equal(serialized.includes('/Users/example/.playwright-mcp/output'), false);
});

test('unmanaged candidates are informational only and do not affect apply or rollback', async (t) => {
  const homeDir = await fixtureHome(t, 'fast-browser-migration-candidate-apply-');
  const value = await readClaudeJson(homeDir);
  const unmanagedEntry = {
    command: 'node',
    args: ['/Users/example/dev/playwright/lib/mcp-server.js'],
    env: { PLAYWRIGHT_MCP_OUTPUT_DIR: '/tmp/output' },
  };
  value.mcpServers['playwright-dev'] = unmanagedEntry;
  await writeClaudeJson(homeDir, value);

  const inventoryBefore = await inventoryFixture(homeDir);
  assert.equal(inventoryBefore.unmanagedCandidates.length, 1);

  const { result } = await applyFixture(homeDir);
  const current = await readClaudeJson(homeDir);
  assert.equal('playwright' in current.mcpServers, false);
  assert.deepEqual(current.mcpServers['playwright-dev'], unmanagedEntry);

  let reads = 0;
  await rollbackMigration(result.rollbackManifestPath, {
    homeDir,
    readMigratedToken: async () => {
      reads += 1;
      return secretFixture;
    },
  });
  assert.equal(reads, 1);
  const restored = await readClaudeJson(homeDir);
  assert.deepEqual(restored, value);
});

test('apply returns unmanaged candidates in the report with no env value, token, or arg value leak', async (t) => {
  const homeDir = await fixtureHome(t, 'fast-browser-migration-candidate-report-');
  const value = await readClaudeJson(homeDir);
  value.mcpServers['playwright-dev'] = {
    command: 'node',
    args: ['/Users/example/dev/playwright/lib/mcp-server.js', '--headless'],
    env: {
      PLAYWRIGHT_MCP_EXTENSION_TOKEN: 'super-secret-dev-token',
      PLAYWRIGHT_MCP_OUTPUT_DIR: '/Users/example/.playwright-mcp/output',
    },
  };
  await writeClaudeJson(homeDir, value);

  const { result } = await applyFixture(homeDir);
  assert.deepEqual(result.unmanagedCandidates, [{
    key: 'playwright-dev',
    command: 'node',
    argCount: 2,
    envKeys: [UNMANAGED_TOKEN_KEY_PLACEHOLDER, 'PLAYWRIGHT_MCP_OUTPUT_DIR'],
  }]);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('super-secret-dev-token'), false);
  assert.equal(serialized.includes(secretFixture), false);
  assert.equal(serialized.includes('/Users/example/.playwright-mcp/output'), false);
  assert.equal(serialized.includes('/Users/example/dev/playwright/lib/mcp-server.js'), false);
});

test('inventory fails closed on malformed Claude JSON', async (t) => {
  const homeDir = await fixtureHome(t);
  await writeFile(path.join(homeDir, '.claude.json'), '{"mcpServers":');
  await assert.rejects(() => inventoryFixture(homeDir), /malformed/);
});

test('inventory refuses source and parent symlinks without reading through them', async (t) => {
  const homeDir = await fixtureHome(t);
  const victim = path.join(homeDir, 'victim.js');
  const source = path.join(homeDir, '.playwright-mcp', 'macros', 'personal-checkout.js');
  await writeFile(victim, 'external victim\n');
  await rm(source);
  await symlink(victim, source);
  await assert.rejects(() => inventoryFixture(homeDir), /symlink|regular file/);
  assert.equal(await readFile(victim, 'utf8'), 'external victim\n');

  const linkedHome = await fixtureHome(t, 'fast-browser-parent-link-');
  const external = await mkdtemp(path.join(await realpath(os.tmpdir()), 'migration-external-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  await rm(path.join(linkedHome, '.playwright-mcp'), { recursive: true });
  await symlink(external, path.join(linkedHome, '.playwright-mcp'));
  await assert.rejects(() => inventoryFixture(linkedHome), /symlink/);
  assert.deepEqual(await readdir(external), []);
});

test('missing optional legacy data is a no-op', async (t) => {
  const homeDir = await fixtureHome(t);
  await rm(path.join(homeDir, '.playwright-mcp'), { recursive: true });
  const inventory = await inventoryFixture(homeDir);
  assert.equal(inventory.files.length, 4);
  assert.deepEqual(inventory.imports, {
    macroIndex: null,
    macros: [],
    failureRecord: null,
    sessions: [],
    archive: [],
  });
});

test('backup is private, no-overwrite, stable, and contains no secret bytes', async (t) => {
  const homeDir = await fixtureHome(t);
  const paths = migrationPaths(homeDir);
  const inventory = await inventoryFixture(homeDir);
  const manifest = await createMigrationBackup(inventory, {
    ...paths,
    now: () => new Date('2026-07-26T12:00:00.000Z'),
    migrationId: 'fixture',
  });

  assert.equal(await mode(manifest.backupDir), 0o700);
  assert.equal(await mode(manifest.manifestPath), 0o600);
  assert.equal(manifest.files.length, 4);
  for (const entry of manifest.files) {
    assert.equal(await mode(entry.backupPath), 0o600);
    assert.equal(entry.sha256, sha256(await readFile(entry.path)));
    assert.equal((await readFile(entry.backupPath, 'utf8')).includes(secretFixture), false);
  }
  const serialized = await readFile(manifest.manifestPath, 'utf8');
  assert.equal(serialized.includes(secretFixture), false);
  assert.equal(JSON.stringify(manifest).includes(secretFixture), false);
  await assert.rejects(
    () => createMigrationBackup(inventory, {
      ...paths,
      now: () => new Date('2026-07-26T12:00:00.000Z'),
      migrationId: 'fixture',
    }),
    /already exists|overwrite/,
  );
});

test('backup refuses ambiguous and noncanonical token literals before backup creation', async (t) => {
  for (const [name, mutate] of [
    ['ambiguous', (raw) => raw.replace(
      '"keep this byte-for-byte"',
      `"${secretFixture}"`,
    )],
    ['noncanonical', (raw) => raw.replace(
      secretFixture,
      'legacy-token-\\u0066ixture',
    )],
  ]) {
    await t.test(name, async (subtest) => {
      const homeDir = await fixtureHome(subtest, `migration-token-${name}-`);
      const claudeJson = path.join(homeDir, '.claude.json');
      await writeFile(claudeJson, mutate(await readFile(claudeJson, 'utf8')));
      const paths = migrationPaths(homeDir);
      const inventory = await inventoryFixture(homeDir);
      await assert.rejects(
        () => createMigrationBackup(inventory, {
          ...paths,
          now: () => new Date('2026-07-26T12:00:00.000Z'),
          migrationId: name,
        }),
        /canonical token literal|ambiguous token literal/,
      );
      assert.equal(await lstatOrNull(paths.backupsDir), null);
    });
  }
});

test('backup rejects changed inventory and non-regular backup collisions', async (t) => {
  const homeDir = await fixtureHome(t);
  const paths = migrationPaths(homeDir);
  const inventory = await inventoryFixture(homeDir);
  await writeFile(
    path.join(homeDir, '.claude', 'rules', 'playwright-first.md'),
    'post-inventory edit\n',
  );
  await assert.rejects(
    () => createMigrationBackup(inventory, { ...paths, migrationId: 'changed' }),
    /changed|hash/,
  );
  assert.equal(await lstatOrNull(paths.backupsDir), null);

  const linkedHome = await fixtureHome(t, 'migration-backup-link-');
  const linkedPaths = migrationPaths(linkedHome);
  const external = await mkdtemp(path.join(await realpath(os.tmpdir()), 'backup-external-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  await mkdir(path.dirname(linkedPaths.backupsDir), { recursive: true });
  await symlink(external, linkedPaths.backupsDir);
  const linkedInventory = await inventoryFixture(linkedHome);
  await assert.rejects(
    () => createMigrationBackup(linkedInventory, {
      ...linkedPaths,
      migrationId: 'linked',
    }),
    /symlink|non-directory/,
  );
  assert.deepEqual(await readdir(external), []);
});

test('copy-first import rewrites only Script lines and preserves every legacy source', async (t) => {
  const homeDir = await fixtureHome(t);
  const paths = migrationPaths(homeDir);
  const inventory = await inventoryFixture(homeDir);
  const result = await importLegacyData({ inventory, paths });

  const index = await readFile(paths.macroIndexFile, 'utf8');
  assert.match(index, /Legacy note: \/Users\/example\/\.playwright-mcp/);
  assert.match(index, /- Script: ~\/\.fast-browser\/macros\/personal-checkout\.js/);
  assert.doesNotMatch(index, /^- Script: .*\.playwright-mcp/m);
  assert.deepEqual(
    await readFile(path.join(paths.macrosDir, 'personal-checkout.js')),
    await readFile(path.join(homeDir, '.playwright-mcp', 'macros', 'personal-checkout.js')),
  );
  assert.match(await readFile(paths.macroFailuresFile, 'utf8'), /personal-checkout/);
  assert.match(
    await readFile(path.join(paths.sessionsDir, 'session-2026-07-20', 'session.md'), 'utf8'),
    /fixture\.example/,
  );
  assert.match(
    await readFile(path.join(paths.archiveDir, 'session-2026-07-01', 'session.md'), 'utf8'),
    /archive\.example/,
  );
  for (const relative of [
    '.playwright-mcp/macros/MACROS.md',
    '.playwright-mcp/macros/personal-checkout.js',
    '.playwright-mcp/macro-failures.md',
    '.playwright-mcp/session-2026-07-20/session.md',
    '.playwright-mcp/archive/session-2026-07-01/session.md',
    '.playwright-mcp/keep.txt',
  ]) assert.ok(await lstatOrNull(path.join(homeDir, relative)));
  assert.equal(JSON.stringify(result).includes(secretFixture), false);
});

test('import is idempotent and preserves live index and failure-ledger entries', async (t) => {
  const homeDir = await fixtureHome(t);
  const paths = migrationPaths(homeDir);
  await mkdir(paths.macrosDir, { recursive: true });
  await writeFile(paths.macroIndexFile, '# User Index\n\n## user-only\n\n- Script: custom.js\n');
  await writeFile(paths.macroFailuresFile, 'user-only | 2026-07-25 | navigation\n');
  const inventory = await inventoryFixture(homeDir);
  await importLegacyData({ inventory, paths });
  const once = {
    index: await readFile(paths.macroIndexFile),
    failures: await readFile(paths.macroFailuresFile),
  };
  await importLegacyData({ inventory, paths });
  assert.deepEqual(await readFile(paths.macroIndexFile), once.index);
  assert.deepEqual(await readFile(paths.macroFailuresFile), once.failures);
  assert.match(once.index.toString(), /## user-only/);
  assert.match(once.index.toString(), /## personal-checkout/);
  assert.match(once.failures.toString(), /user-only/);
  assert.match(once.failures.toString(), /personal-checkout/);
});

test('different macro content gets one deterministic legacy hash name', async (t) => {
  const homeDir = await fixtureHome(t);
  const paths = migrationPaths(homeDir);
  await mkdir(paths.macrosDir, { recursive: true });
  await writeFile(path.join(paths.macrosDir, 'personal-checkout.js'), '// live user version\n');
  const inventory = await inventoryFixture(homeDir);
  const imported = await importLegacyData({ inventory, paths });
  const source = await readFile(
    path.join(homeDir, '.playwright-mcp', 'macros', 'personal-checkout.js'),
  );
  const expected = `personal-checkout.legacy-${sha256(source).slice(0, 8)}.js`;

  assert.equal(
    await readFile(path.join(paths.macrosDir, 'personal-checkout.js'), 'utf8'),
    '// live user version\n',
  );
  assert.deepEqual(imported.macros.map(({ name }) => name), [expected]);
  assert.deepEqual(await readFile(path.join(paths.macrosDir, expected)), source);
  assert.match(await readFile(paths.macroIndexFile, 'utf8'), new RegExp(expected));
  await importLegacyData({ inventory, paths });
  assert.deepEqual(await readFile(path.join(paths.macrosDir, expected)), source);
});

test('matching metadata retains distinct ordinary and hashed macro targets', async (t) => {
  const homeDir = await fixtureHome(t);
  const paths = migrationPaths(homeDir);
  await mkdir(paths.macrosDir, { recursive: true });
  const liveSection = '## personal-checkout\n\n'
    + '- Description: Complete a personal checkout flow.\n'
    + '- Script: ~/.fast-browser/macros/personal-checkout.js\n'
    + '- Status: approved';
  const live = `# Live\n\n${liveSection}\n`;
  await writeFile(paths.macroIndexFile, live);
  await writeFile(path.join(paths.macrosDir, 'personal-checkout.js'), '// live user version\n');
  const source = await readFile(
    path.join(homeDir, '.playwright-mcp', 'macros', 'personal-checkout.js'),
  );
  const importedName = `personal-checkout.legacy-${sha256(source).slice(0, 8)}.js`;

  const inventory = await inventoryFixture(homeDir);
  await importLegacyData({ inventory, paths });
  const once = await readFile(paths.macroIndexFile, 'utf8');
  assert.ok(once.startsWith(live));
  assert.equal([...once.matchAll(/^## personal-checkout/gm)].length, 2);
  assert.match(once, new RegExp(`Script: ~\\/\\.fast-browser\\/macros\\/${importedName}`));
  await importLegacyData({ inventory, paths });
  assert.equal(await readFile(paths.macroIndexFile, 'utf8'), once);
});

test('a colliding live heading remains unchanged and gains one deterministic legacy section', async (t) => {
  const homeDir = await fixtureHome(t);
  const paths = migrationPaths(homeDir);
  await mkdir(paths.macrosDir, { recursive: true });
  const live = '# Live\n\n## personal-checkout\n\n- Script: ~/.fast-browser/macros/personal-checkout.js\n';
  await writeFile(paths.macroIndexFile, live);
  await writeFile(path.join(paths.macrosDir, 'personal-checkout.js'), '// live\n');
  const inventory = await inventoryFixture(homeDir);
  await importLegacyData({ inventory, paths });
  const once = await readFile(paths.macroIndexFile, 'utf8');
  assert.ok(once.startsWith(live));
  assert.match(once, /## personal-checkout \(legacy [a-f0-9]{8}\)/);
  await importLegacyData({ inventory, paths });
  assert.equal(await readFile(paths.macroIndexFile, 'utf8'), once);
});

for (const destinationState of ['absent', 'identical']) {
  test(`same-heading import keeps a distinct legacy section when its macro is ${destinationState}`, async (t) => {
    const homeDir = await fixtureHome(t, `migration-same-heading-${destinationState}-`);
    const paths = migrationPaths(homeDir);
    await mkdir(paths.macrosDir, { recursive: true });
    const live = '# Live\n\n## personal-checkout\n\n- Description: Live owner.\n'
      + '- Script: ~/.fast-browser/macros/live-personal-checkout.js\n';
    await writeFile(paths.macroIndexFile, live);
    const legacyMacro = await readFile(
      path.join(homeDir, '.playwright-mcp', 'macros', 'personal-checkout.js'),
    );
    if (destinationState === 'identical') {
      await writeFile(path.join(paths.macrosDir, 'personal-checkout.js'), legacyMacro);
    }
    const sourceIndex = await readFile(
      path.join(homeDir, '.playwright-mcp', 'macros', 'MACROS.md'),
      'utf8',
    );
    const normalizedSection = sourceIndex
      .slice(sourceIndex.indexOf('## personal-checkout'))
      .replace(
        '/Users/example/.playwright-mcp/macros/personal-checkout.js',
        '~/.fast-browser/macros/personal-checkout.js',
      )
      .trimEnd();
    const identity = sha256(Buffer.from(normalizedSection)).slice(0, 8);

    const inventory = await inventoryFixture(homeDir);
    await importLegacyData({ inventory, paths });
    const once = await readFile(paths.macroIndexFile, 'utf8');
    assert.ok(once.startsWith(live));
    assert.match(once, new RegExp(`## personal-checkout \\(legacy ${identity}\\)`));
    assert.match(
      once,
      /Script: ~\/\.fast-browser\/macros\/personal-checkout\.js/,
    );
    await importLegacyData({ inventory, paths });
    assert.equal(await readFile(paths.macroIndexFile, 'utf8'), once);
  });
}

test('same-heading import does not duplicate a truly represented normalized section', async (t) => {
  const homeDir = await fixtureHome(t);
  const paths = migrationPaths(homeDir);
  await mkdir(paths.macrosDir, { recursive: true });
  const sourceIndex = await readFile(
    path.join(homeDir, '.playwright-mcp', 'macros', 'MACROS.md'),
    'utf8',
  );
  const represented = sourceIndex
    .slice(sourceIndex.indexOf('## personal-checkout'))
    .replace(
      '/Users/example/.playwright-mcp/macros/personal-checkout.js',
      '~/.fast-browser/macros/personal-checkout.js',
    )
    .trimEnd();
  const live = `# Live\n\n${represented}\n`;
  await writeFile(paths.macroIndexFile, live);
  await writeFile(
    path.join(paths.macrosDir, 'personal-checkout.js'),
    await readFile(path.join(homeDir, '.playwright-mcp', 'macros', 'personal-checkout.js')),
  );

  await importLegacyData({ inventory: await inventoryFixture(homeDir), paths });
  assert.equal(await readFile(paths.macroIndexFile, 'utf8'), live);
});

test('occupied deterministic legacy labels preserve both user and imported sections', async (t) => {
  const selectedLabels = [];
  for (const unrelatedPosition of ['before', 'after']) {
    const homeDir = await fixtureHome(t, `migration-label-collision-${unrelatedPosition}-`);
    const paths = migrationPaths(homeDir);
    await mkdir(paths.macrosDir, { recursive: true });
    const sourceIndex = await readFile(
      path.join(homeDir, '.playwright-mcp', 'macros', 'MACROS.md'),
      'utf8',
    );
    const importedSection = sourceIndex
      .slice(sourceIndex.indexOf('## personal-checkout'))
      .replace(
        '/Users/example/.playwright-mcp/macros/personal-checkout.js',
        '~/.fast-browser/macros/personal-checkout.js',
      )
      .trimEnd();
    const fullIdentity = sha256(Buffer.from(importedSection));
    const userBase = '## personal-checkout\n\n- Description: Live owner.\n'
      + '- Script: ~/.fast-browser/macros/live-personal-checkout.js';
    const occupied = `## personal-checkout (legacy ${fullIdentity.slice(0, 8)})\n\n`
      + '- Description: User-owned deterministic label collision.\n'
      + '- Script: ~/.fast-browser/macros/user-collision.js';
    const unrelated = '## unrelated\n\n- Script: custom.js';
    const ordered = unrelatedPosition === 'before'
      ? [unrelated, userBase, occupied]
      : [userBase, occupied, unrelated];
    const live = `# Live\n\n${ordered.join('\n\n')}\n`;
    await writeFile(paths.macroIndexFile, live);

    const inventory = await inventoryFixture(homeDir);
    await importLegacyData({ inventory, paths });
    const once = await readFile(paths.macroIndexFile, 'utf8');
    const expectedLabel = `personal-checkout (legacy ${fullIdentity.slice(0, 12)})`;
    assert.ok(once.startsWith(live));
    assert.match(once, /User-owned deterministic label collision/);
    assert.match(once, /Complete a personal checkout flow/);
    assert.match(once, new RegExp(`^## ${expectedLabel.replace(/[()]/g, '\\$&')}$`, 'm'));
    await importLegacyData({ inventory, paths });
    assert.equal(await readFile(paths.macroIndexFile, 'utf8'), once);
    selectedLabels.push(expectedLabel);
  }
  assert.equal(selectedLabels[0], selectedLabels[1]);
});

test('duplicate identical legacy sections are queued only once', async (t) => {
  const homeDir = await fixtureHome(t);
  const paths = migrationPaths(homeDir);
  await mkdir(paths.macrosDir, { recursive: true });
  await writeFile(paths.macroIndexFile, '# Live\n');
  const sourcePath = path.join(homeDir, '.playwright-mcp', 'macros', 'MACROS.md');
  const source = await readFile(sourcePath, 'utf8');
  const duplicate = source.slice(source.indexOf('## personal-checkout')).trimEnd();
  await writeFile(sourcePath, `${source.trimEnd()}\n\n${duplicate}\n`);

  const inventory = await inventoryFixture(homeDir);
  await importLegacyData({ inventory, paths });
  const once = await readFile(paths.macroIndexFile, 'utf8');
  assert.equal(
    [...once.matchAll(/^## personal-checkout(?: \(legacy [a-f0-9]+\))?$/gm)].length,
    1,
  );
  await importLegacyData({ inventory, paths });
  assert.equal(await readFile(paths.macroIndexFile, 'utf8'), once);
});

test('import rejects source and target symlink collisions without outside writes', async (t) => {
  const homeDir = await fixtureHome(t);
  const paths = migrationPaths(homeDir);
  const inventory = await inventoryFixture(homeDir);
  const external = path.join(homeDir, 'external-target');
  await mkdir(external);
  await symlink(external, paths.dataDir);
  await assert.rejects(() => importLegacyData({ inventory, paths }), /symlink/);
  assert.deepEqual(await readdir(external), []);
});

test('apply verifies before preflighted cleanup and removes only recognized host state', async (t) => {
  const homeDir = await fixtureHome(t);
  const claudeJson = path.join(homeDir, '.claude.json');
  const original = await readFile(claudeJson, 'utf8');
  const notes = JSON.parse(original).mcpServers.notes;
  const { events, result } = await applyFixture(homeDir);

  assert.deepEqual(events, ['token', 'install', 'verify']);
  const currentRaw = await readFile(claudeJson, 'utf8');
  const current = JSON.parse(currentRaw);
  assert.deepEqual(current.mcpServers.notes, notes);
  assert.equal(currentRaw.includes('"theme": "dark"'), true);
  assert.equal(currentRaw.includes('"keep this byte-for-byte"'), true);
  assert.equal('playwright' in current.mcpServers, false);
  for (const relative of [
    '.claude/agents/browser-driver.md',
    '.claude/rules/playwright-first.md',
    '.claude/rules/playwright-verification.md',
    ...links.map(([entry]) => entry),
  ]) assert.equal(await lstatOrNull(path.join(homeDir, relative)), null);
  assert.ok(await lstatOrNull(path.join(homeDir, '.playwright-mcp', 'keep.txt')));
  assert.ok(await lstatOrNull(
    path.join(homeDir, '.playwright-mcp', 'macros', 'personal-checkout.js'),
  ));
  assert.match(result.rollbackCommand, /^fast-browser migrate --rollback /);
  assert.equal(await mode(result.rollbackManifestPath), 0o600);
  assert.equal(JSON.stringify(result).includes(secretFixture), false);
  assert.equal(
    (await readFile(result.rollbackManifestPath, 'utf8')).includes(secretFixture),
    false,
  );
});

test('adapter and verification failures keep legacy state active and redact errors', async (t) => {
  for (const [stage, overrides, expectedEvents] of [
    ['adapter', {
      installAdaptersAndRouting: async () => {
        const error = new Error(`adapter exposed ${secretFixture}`);
        error.partialState = { hosts: ['claude'] };
        throw error;
      },
    }, ['token', 'cleanup-install']],
    ['verify', {
      verify: async () => {
        throw new Error(`verify exposed ${secretFixture}`);
      },
    }, ['token', 'install', 'cleanup-install']],
  ]) {
    await t.test(stage, async (subtest) => {
      const homeDir = await fixtureHome(subtest, `migration-${stage}-`);
      const before = await readFile(path.join(homeDir, '.claude.json'));
      let caught;
      try {
        await applyFixture(homeDir, overrides);
      } catch (error) {
        caught = error;
      }
      assert.ok(caught);
      assert.equal(String(caught).includes(secretFixture), false);
      assert.equal(JSON.stringify(caught).includes(secretFixture), false);
      assert.deepEqual(caught.events, expectedEvents);
      assert.deepEqual(await readFile(path.join(homeDir, '.claude.json')), before);
      for (const relative of [
        '.claude/agents/browser-driver.md',
        '.claude/rules/playwright-first.md',
        '.claude/rules/playwright-verification.md',
        ...links.map(([entry]) => entry),
      ]) assert.ok(await lstatOrNull(path.join(homeDir, relative)));
    });
  }
});

test('cleanup preflight mismatch prevents every recognized removal', async (t) => {
  const homeDir = await fixtureHome(t);
  const claudeBefore = await readFile(path.join(homeDir, '.claude.json'));
  let caught;
  try {
    await applyFixture(homeDir, {
      verify: async () => {
        await writeFile(
          path.join(homeDir, '.claude', 'rules', 'playwright-verification.md'),
          'user edit after inventory\n',
        );
      },
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught);
  assert.match(String(caught), /cleanup preflight/i);
  assert.deepEqual(await readFile(path.join(homeDir, '.claude.json')), claudeBefore);
  assert.ok(await lstatOrNull(path.join(homeDir, '.claude', 'agents', 'browser-driver.md')));
  assert.ok(await lstatOrNull(
    path.join(homeDir, '.claude', 'rules', 'playwright-first.md'),
  ));
  for (const [relative] of links) assert.ok(await lstatOrNull(path.join(homeDir, relative)));
});

test('rollback restores byte-identical files, exact modes, and symlink targets', async (t) => {
  const homeDir = await fixtureHome(t);
  const originals = new Map();
  for (const relative of [
    '.claude.json',
    '.claude/agents/browser-driver.md',
    '.claude/rules/playwright-first.md',
    '.claude/rules/playwright-verification.md',
  ]) {
    const pathname = path.join(homeDir, relative);
    await chmod(pathname, relative.endsWith('.json') ? 0o640 : 0o604);
    originals.set(relative, {
      bytes: await readFile(pathname),
      mode: await mode(pathname),
    });
  }
  const { result } = await applyFixture(homeDir);
  let reads = 0;
  await rollbackMigration(result.rollbackManifestPath, {
    homeDir,
    readMigratedToken: async () => {
      reads += 1;
      return secretFixture;
    },
  });
  assert.equal(reads, 1);
  for (const [relative, original] of originals) {
    const pathname = path.join(homeDir, relative);
    assert.deepEqual(await readFile(pathname), original.bytes);
    assert.equal(await mode(pathname), original.mode);
  }
  for (const [relative, target] of links) {
    const pathname = path.join(homeDir, relative);
    assert.equal((await lstat(pathname)).isSymbolicLink(), true);
    assert.equal(await readlink(pathname), target);
  }
});

test('rollback refuses post-migration edits before any restoration', async (t) => {
  const homeDir = await fixtureHome(t);
  const { result } = await applyFixture(homeDir);
  const claudeJson = path.join(homeDir, '.claude.json');
  await writeFile(claudeJson, `${await readFile(claudeJson, 'utf8')}\n`);

  await assert.rejects(
    () => rollbackMigration(result.rollbackManifestPath, {
      homeDir,
      readMigratedToken: async () => secretFixture,
    }),
    /post-migration edit|hash/,
  );
  for (const relative of [
    '.claude/agents/browser-driver.md',
    '.claude/rules/playwright-first.md',
    '.claude/rules/playwright-verification.md',
    ...links.map(([entry]) => entry),
  ]) assert.equal(await lstatOrNull(path.join(homeDir, relative)), null);
});

test('rollback preflights every absent target for all-or-nothing behavior', async (t) => {
  const homeDir = await fixtureHome(t);
  const { result } = await applyFixture(homeDir);
  const collision = path.join(homeDir, '.claude', 'rules', 'playwright-verification.md');
  await writeFile(collision, 'unrelated post-migration file\n');

  await assert.rejects(
    () => rollbackMigration(result.rollbackManifestPath, {
      homeDir,
      readMigratedToken: async () => secretFixture,
    }),
    /post-migration edit|collision/,
  );
  assert.equal(
    await lstatOrNull(path.join(homeDir, '.claude', 'rules', 'playwright-first.md')),
    null,
  );
  assert.equal(await readFile(collision, 'utf8'), 'unrelated post-migration file\n');
});

test('rollback rejects a symlinked restored-file parent without external writes', async (t) => {
  const homeDir = await fixtureHome(t);
  const { result } = await applyFixture(homeDir);
  const external = await mkdtemp(path.join(await realpath(os.tmpdir()), 'rollback-external-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  await rm(path.join(homeDir, '.claude', 'rules'), { recursive: true });
  await symlink(external, path.join(homeDir, '.claude', 'rules'));
  await assert.rejects(
    () => rollbackMigration(result.rollbackManifestPath, {
      homeDir,
      readMigratedToken: async () => secretFixture,
    }),
    /symlink/,
  );
  assert.deepEqual(await readdir(external), []);
  assert.equal(await lstatOrNull(
    path.join(homeDir, '.claude', 'agents', 'browser-driver.md'),
  ), null);
});

test('rollback re-preflights after token read replaces a parent with a symlink', async (t) => {
  const homeDir = await fixtureHome(t);
  const { result } = await applyFixture(homeDir);
  const external = await mkdtemp(path.join(await realpath(os.tmpdir()), 'rollback-token-swap-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  const rules = path.join(homeDir, '.claude', 'rules');

  await assert.rejects(
    () => rollbackMigration(result.rollbackManifestPath, {
      homeDir,
      readMigratedToken: async () => {
        await rm(rules, { recursive: true });
        await symlink(external, rules);
        return secretFixture;
      },
    }),
    /symlink|parent/,
  );
  assert.deepEqual(await readdir(external), []);
  assert.equal(await lstatOrNull(
    path.join(homeDir, '.claude', 'agents', 'browser-driver.md'),
  ), null);
  assert.equal(await lstatOrNull(
    path.join(homeDir, '.claude', 'rules', 'playwright-first.md'),
  ), null);
});

test('rollback undoes earlier restores when a later filesystem operation fails', async (t) => {
  const homeDir = await fixtureHome(t);
  const { result } = await applyFixture(homeDir);
  const skillsDir = path.join(homeDir, '.claude', 'skills');
  const skillsMode = await mode(skillsDir);
  const claudeJson = path.join(homeDir, '.claude.json');
  const migratedJson = await readFile(claudeJson);
  await chmod(skillsDir, 0o555);

  try {
    await assert.rejects(
      () => rollbackMigration(result.rollbackManifestPath, {
        homeDir,
        readMigratedToken: async () => secretFixture,
      }),
      /EACCES|operation not permitted|permission denied/i,
    );
  } finally {
    await chmod(skillsDir, skillsMode);
  }

  for (const relative of [
    '.claude/agents/browser-driver.md',
    '.claude/rules/playwright-first.md',
    '.claude/rules/playwright-verification.md',
    ...links.map(([entry]) => entry),
  ]) assert.equal(await lstatOrNull(path.join(homeDir, relative)), null);
  assert.deepEqual(await readFile(claudeJson), migratedJson);
});

test('rollback validates schema, supplied home, confinement, and recognized targets', async (t) => {
  const homeDir = await fixtureHome(t);
  const { result } = await applyFixture(homeDir);
  const manifest = JSON.parse(await readFile(result.rollbackManifestPath, 'utf8'));
  for (const [name, mutate] of [
    ['schema', (value) => ({ ...value, schemaVersion: 2 })],
    ['home', (value) => ({ ...value, homeDir: path.dirname(homeDir) })],
    ['path', (value) => ({
      ...value,
      files: value.files.map((entry, index) => (
        index === 0 ? { ...entry, path: path.join(path.dirname(homeDir), 'victim') } : entry
      )),
    })],
  ]) {
    await t.test(name, async () => {
      await assert.rejects(
        () => rollbackMigration(mutate(structuredClone(manifest)), {
          homeDir,
          readMigratedToken: async () => secretFixture,
        }),
        /schema|home|confined|recognized/,
      );
    });
  }
});
