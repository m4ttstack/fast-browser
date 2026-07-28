import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { rasterise, rendererVersion } from '../../lib/annotate/render.mjs';

function fakeSpawn({ code = 0, error = null, capture = {} } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdin = { chunks: [], write(c) { this.chunks.push(c); }, end() { capture.svg = this.chunks.join(''); } };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { capture.killed = true; };
    queueMicrotask(() => {
      if (error) child.emit('error', error);
      else child.emit('close', code);
    });
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

test('a non-zero exit fails rather than leaving a partial file', async () => {
  await assert.rejects(
    () => rasterise({ svg: '<svg/>', outPath: '/tmp/o.png', spawn: fakeSpawn({ code: 1 }) }),
    /rsvg-convert failed/,
  );
});

test('rendererVersion returns null when the binary is absent', async () => {
  const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  assert.equal(await rendererVersion({ spawn: fakeSpawn({ error: enoent }) }), null);
});
