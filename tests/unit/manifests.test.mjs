import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repositoryRoot = resolve(pluginRoot, '../..');

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

test('publishes host-compatible bundled MCP contracts', async () => {
  const [claude, codex, claudeMcp, codexMcp, claudeMarketplace, codexMarketplace] = await Promise.all([
    readJson(resolve(pluginRoot, '.claude-plugin/plugin.json')),
    readJson(resolve(pluginRoot, '.codex-plugin/plugin.json')),
    readJson(resolve(pluginRoot, '.mcp.json')),
    readJson(resolve(pluginRoot, 'adapters/codex/mcp.json')),
    readJson(resolve(repositoryRoot, '.claude-plugin/marketplace.json')),
    readJson(resolve(repositoryRoot, '.agents/plugins/marketplace.json')),
  ]);

  assert.equal(claude.name, 'fast-browser');
  assert.equal(codex.name, 'fast-browser');
  assert.equal(claude.version, codex.version);
  assert.equal(claude.skills, './skills/');
  assert.equal(codex.skills, './skills/');
  assert.deepEqual(codex.mcpServers, {
    fast_browser: {
      command: 'node',
      args: ['${PLUGIN_ROOT}/bin/fast-browser-mcp.mjs'],
    },
  });
  assert.deepEqual(claudeMcp, {
    mcpServers: {
      'fast-browser': {
        command: 'node',
        args: ['${CLAUDE_PLUGIN_ROOT}/bin/fast-browser-mcp.mjs'],
      },
    },
  });
  assert.deepEqual(codexMcp, {
    fast_browser: {
      command: 'node',
      args: ['${PLUGIN_ROOT}/bin/fast-browser-mcp.mjs'],
    },
  });
  assert.equal(claudeMarketplace.plugins[0].source, './plugins/fast-browser');
  assert.deepEqual(codexMarketplace.plugins[0].source, {
    source: 'local',
    path: './plugins/fast-browser',
  });
});
