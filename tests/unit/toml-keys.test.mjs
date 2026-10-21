import assert from 'node:assert/strict';
import test from 'node:test';

import { tomlDefinesPath } from '../../lib/hosts/toml-keys.mjs';

const TARGET = ['mcp_servers', 'fast_browser'];

test('finds every way a document can define mcp_servers.fast_browser', () => {
  const defining = [
    '[mcp_servers.fast_browser]\ncommand = "node"\n',
    '[ mcp_servers . "fast_browser" ]\n',
    '["mcp_servers".fast_browser]\n',
    "['mcp_servers'.'fast_browser']\n",
    '[mcp_servers."fast\\u005fbrowser"]\n',
    '[mcp_servers."fast\\U0000005Fbrowser"]\n',
    '[mcp_servers.fast_browser.env]\nX = "1"\n',
    '[[mcp_servers.fast_browser.tools]]\n',
    'mcp_servers.fast_browser.command = "node"\n',
    '[mcp_servers]\nfast_browser = { command = "node" }\n',
    '[mcp_servers]\nfast_browser.command = "node"\n',
    'mcp_servers = { other = { a = 1 }, fast_browser = { command = "node" } }\n',
  ];
  for (const text of defining) assert.equal(tomlDefinesPath(text, TARGET), true, text);
});

test('ignores look-alikes inside strings, comments and other tables', () => {
  const benign = [
    'note = """\n[mcp_servers.fast_browser]\n"""\n',
    "note = '''\n[mcp_servers.fast_browser]\n'''\n",
    'note = "[mcp_servers.fast_browser]"\n',
    '# [mcp_servers.fast_browser]\n',
    'args = [\n  "[mcp_servers.fast_browser]",\n  [1, 2],\n]\n',
    '[mcp_servers.fast_browser_two]\n',
    '[plugins."fast-browser@mattstack".mcp_servers.fast_browser]\n',
    '[mcp_servers.railway]\nfast_browser = "a string value only names a key under railway"\n',
  ];
  for (const text of benign) assert.equal(tomlDefinesPath(text, TARGET), false, text);
});
