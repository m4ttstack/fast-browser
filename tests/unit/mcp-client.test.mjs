import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { startMcpClient } from '../e2e/helpers/mcp-client.mjs';

const ARCHIVE_FILE = 'fast-browser-mcp-0.1.0-alpha.1.tar.gz';
const ACCEPTED_SHA256 = '356981ca2e4b76c06272e529becdf0296052b45d533e4ee14eb8dfcc35439950';
const INTEGRITY_ERROR = 'the local fast-browser runtime artifact failed integrity validation';

function releaseManifest(sha256) {
  return {
    schemaVersion: 1,
    productVersion: '0.1.0-alpha.1',
    sourceCommit: '23c61fcce87a8d2fcaf9f636751f062641a1bf1e',
    protocolVersion: 2,
    runtime: { file: ARCHIVE_FILE, sha256, node: '>=20' },
  };
}

async function tamperedRelease(t, manifestSha256) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-mcp-integrity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const releaseDir = path.join(root, 'release');
  const outputDir = path.join(root, 'output');
  const archive = Buffer.from('tampered local runtime archive');
  await Promise.all([mkdir(releaseDir), mkdir(outputDir)]);
  await Promise.all([
    writeFile(path.join(releaseDir, ARCHIVE_FILE), archive),
    writeFile(
      path.join(releaseDir, 'fast-browser-release-0.1.0-alpha.1.json'),
      JSON.stringify(releaseManifest(manifestSha256(archive))),
    ),
  ]);
  return { root, releaseDir, outputDir };
}

async function assertRejectedBeforeExtraction({ root, releaseDir, outputDir }) {
  await assert.rejects(
    startMcpClient({ outputDir, releaseDir }),
    (error) => {
      assert.equal(error.message, INTEGRITY_ERROR);
      assert.equal(error.message.includes(root), false);
      return true;
    },
  );
  await assert.rejects(stat(path.join(outputDir, '.runtime')), { code: 'ENOENT' });
}

test('rejects a tampered local runtime archive before extraction', async (t) => {
  const fixture = await tamperedRelease(t, () => ACCEPTED_SHA256);

  await assertRejectedBeforeExtraction(fixture);
});

test('rejects release checksum drift from the accepted runtime lock before extraction', async (t) => {
  const fixture = await tamperedRelease(
    t,
    (archive) => crypto.createHash('sha256').update(archive).digest('hex'),
  );

  await assertRejectedBeforeExtraction(fixture);
});
