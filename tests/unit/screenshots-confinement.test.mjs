import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolvePaths } from '../../lib/core/paths.mjs';
import { confinedScreenshotPath } from '../../lib/core/screenshots.mjs';

const fail = (message) => new Error(message);

test('a plain name resolves inside the screenshots directory', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'fb-conf-'));
  try {
    const paths = resolvePaths({ homeDir: home });
    const out = await confinedScreenshotPath(paths, 'board.png', 'out', fail);
    assert.equal(out, path.join(paths.screenshotsDir, 'board.png'));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a traversing name is refused and the message names the field, not the value', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'fb-conf-'));
  try {
    const paths = resolvePaths({ homeDir: home });
    await assert.rejects(
      () => confinedScreenshotPath(paths, '../../secret.png', 'out', fail),
      (error) => error.message === 'out must resolve inside the screenshots directory'
        && !error.message.includes('secret'),
    );
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('an empty name is refused as required', async () => {
  const paths = resolvePaths({ homeDir: '/nonexistent-home' });
  await assert.rejects(() => confinedScreenshotPath(paths, '', 'out', fail), /out is required/);
});
