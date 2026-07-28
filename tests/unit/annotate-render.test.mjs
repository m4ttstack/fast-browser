import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { rasterise, rendererVersion } from '../../lib/annotate/render.mjs';

// stdin is a real EventEmitter (not a plain object) so tests can emit 'error'
// on it, the same way a broken pipe does when the child exits mid-write.
function fakeSpawn({ code = 0, error = null, capture = {}, stdinError = null, neverClose = false } = {}) {
  return () => {
    const child = new EventEmitter();
    const stdin = new EventEmitter();
    stdin.chunks = [];
    stdin.write = function write(chunk) { this.chunks.push(chunk); };
    stdin.end = function end() {
      capture.svg = this.chunks.join('');
      if (stdinError) queueMicrotask(() => stdin.emit('error', stdinError));
    };
    child.stdin = stdin;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { capture.killed = true; };
    if (!neverClose) {
      queueMicrotask(() => {
        if (error) child.emit('error', error);
        else child.emit('close', code);
      });
    }
    return child;
  };
}

test('the svg is piped to stdin and never written to disk', async () => {
  const capture = {};
  await rasterise({ svg: '<svg/>', outPath: '/tmp/out.png', spawn: fakeSpawn({ capture }) });
  assert.equal(capture.svg, '<svg/>');
});

test('a missing rsvg-convert reports the brew remediation', async () => {
  const enoent = Object.assign(new Error('spawn rsvg-convert ENOENT'), { code: 'ENOENT' });
  await assert.rejects(
    () => rasterise({ svg: '<svg/>', outPath: '/tmp/o.png', spawn: fakeSpawn({ error: enoent }) }),
    /brew install librsvg/,
  );
});

test('a non-zero exit removes a partial output file rather than leaving it behind', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fast-browser-render-'));
  try {
    const outPath = path.join(dir, 'out.png');
    await writeFile(outPath, 'zero-length-or-partial-bytes');
    await assert.rejects(
      () => rasterise({ svg: '<svg/>', outPath, spawn: fakeSpawn({ code: 1 }) }),
      /rsvg-convert failed/,
    );
    await assert.rejects(() => access(outPath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an EPIPE on stdin does not crash the process and the promise still rejects normally', async () => {
  // A large write can still be in flight when the child exits (e.g. killed on
  // timeout), so the child's own stdin fires 'error' independently of the
  // child's 'close'/'error' events. Without a listener on that stream, Node
  // treats it as an unhandled exception and kills the host process.
  const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  await assert.rejects(
    () => rasterise({ svg: '<svg/>', outPath: '/tmp/o.png', spawn: fakeSpawn({ code: 1, stdinError: epipe }) }),
    /rsvg-convert failed/,
  );
});

test('a hung child is killed on timeout and rejects with a timeout error', async () => {
  const capture = {};
  // The implementation's timeout timer is deliberately unref'd, relying on the
  // real child process's I/O handles to keep the loop alive until it fires.
  // The fake spawn has no such handles, so pin the loop open for this test.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(
      () => rasterise({
        svg: '<svg/>',
        outPath: '/tmp/o.png',
        spawn: fakeSpawn({ capture, neverClose: true }),
        timeoutMs: 10,
      }),
      /rsvg-convert timed out/,
    );
    assert.equal(capture.killed, true);
  } finally {
    clearInterval(keepAlive);
  }
});

test('rendererVersion returns null when the binary is absent', async () => {
  const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  assert.equal(await rendererVersion({ spawn: fakeSpawn({ error: enoent }) }), null);
});
