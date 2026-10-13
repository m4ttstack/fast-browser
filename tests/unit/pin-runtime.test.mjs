import assert from 'node:assert/strict';
import { test } from 'node:test';

import { rewriteText } from '../../scripts/pin-runtime.mjs';

const OLD = 'fast-browser-v0.1.2';
const NEW = 'fast-browser-v0.1.3';
const release = tag => `https://github.com/example/repo/releases/download/${tag}`;
const renderer = [
  `${release(OLD)}/chromium-headless-shell-darwin-arm64.zip`,
  `${release(OLD)}/chromium-headless-shell-linux-x64.zip`,
];
const notices = [
  `runtime ${release(OLD)}/runtime-0.1.2.tgz`,
  `extension ${release(OLD)}/extension-0.1.2.zip`,
  `renderer ${renderer[0]}`,
  `renderer (${renderer[1]})`,
].join('\n');
const pairs = [[OLD, NEW]];
const stale = [OLD];

test('runtime and extension URLs move to the new tag, renderer URLs are byte-identical', () => {
  const text = rewriteText('notices', notices, pairs, stale);
  assert.ok(text.includes(`${release(NEW)}/runtime-0.1.2.tgz`));
  assert.ok(text.includes(`${release(NEW)}/extension-0.1.2.zip`));
  for (const url of renderer)
    assert.ok(text.includes(url));
});

test('the stale check still throws when the old tag survives elsewhere', () => {
  assert.throws(() => rewriteText('notices', `${notices}\nprose about ${OLD}`, [[`${release(OLD)}/runtime-0.1.2.tgz`, 'x']], stale),
      /stale after rewrite/);
  assert.throws(() => rewriteText('notices', `${notices}\n${release(OLD)}/other.tgz`, [[`${release(OLD)}/runtime-0.1.2.tgz`, 'x']], stale),
      /stale after rewrite/);
});

test('a text with nothing to rewrite still throws', () => {
  assert.throws(() => rewriteText('notices', 'nothing here', pairs, stale), /nothing to rewrite/);
});

test('a renderer path split across string literals keeps its tag', () => {
  const second = `          + '${OLD}/chromium-headless-shell-1234-mac-arm64.zip',`;
  const split = [
    `${notices}`,
    `        url: 'https://github.com/example/repo/releases/download/'`,
    second,
  ].join('\n');
  let text;
  assert.doesNotThrow(() => { text = rewriteText('notices', split, pairs, stale); });
  assert.ok(text.split('\n').includes(second));
});

test('only the renderer file prefix is protected', () => {
  const mcp = `${release(OLD)}/fast-browser-mcp-0.1.2.tar.gz`;
  const other = `${release(OLD)}/other-file.zip`;
  const text = rewriteText('notices', `${notices}\n${mcp}\n${other}`, pairs, stale);
  assert.ok(text.includes(mcp.replace(OLD, NEW)));
  assert.ok(text.includes(other.replace(OLD, NEW)));
  assert.throws(() => rewriteText('notices', `${notices}\n${other}`, [[`${release(OLD)}/runtime-0.1.2.tgz`, 'x']], stale),
      /stale after rewrite/);
});
