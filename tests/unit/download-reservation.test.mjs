import assert from 'node:assert/strict';
import { mkdtemp, open, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { reserveDownload } from '../../lib/core/download-reservation.mjs';

test('post-open setup failure closes and unlinks its reservation before source work begins', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-reservation-'));
  const downloadPath = path.join(directory, '.download');
  const setupError = new Error('synthetic chmod failure');
  let closeCalls = 0;
  let sourceStarts = 0;

  const openFile = async (...args) => {
    const handle = await open(...args);
    return {
      async chmod() {
        throw setupError;
      },
      async close() {
        closeCalls += 1;
        await handle.close();
      },
    };
  };

  await assert.rejects(
    async () => {
      await reserveDownload(downloadPath, { openFile, unlinkFile: unlink });
      sourceStarts += 1;
    },
    (error) => error === setupError,
  );
  assert.equal(closeCalls, 1);
  assert.equal(sourceStarts, 0);
  await assert.rejects(stat(downloadPath), { code: 'ENOENT' });
});
