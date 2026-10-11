import assert from 'node:assert/strict';
import test from 'node:test';

import { renderBoard } from '../../lib/compose/engine.mjs';

// An empty executablePath makes Playwright fall back to its own browser
// lookup, which is exactly the "never the user's Chrome" rule this guards.
for (const [label, executablePath] of [['missing', undefined], ['empty', ''], ['not text', 7]]) {
  test(`renderBoard refuses an executablePath that is ${label} before loading anything`, async () => {
    await assert.rejects(
      () => renderBoard({ html: '', outPath: '/nowhere/o.png', executablePath, playwrightCore: '/nowhere/index.mjs' }),
      /^Error: the compose renderer executable path is required$/,
    );
  });
}
