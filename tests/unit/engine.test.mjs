import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_ENGINE, UnknownEngineError, engineFor } from '../../lib/runtime/engine.mjs';
import { runtimeArgs } from '../../lib/runtime/launch.mjs';

const paths = { dataDir: '/synthetic-home/.fast-browser' };
const lock = { extension: { id: 'abcdefghijklmnopabcdefghijklmnop' } };

// A config with no `engine` field is what every pre-existing caller passes,
// and it must keep producing today's exact attached arg list.
const legacy = { profile: 'safe', trace: false };
const cloud = {
  profile: 'safe',
  trace: false,
  engine: 'cdp',
  cdpEndpoint: 'http://127.0.0.1:9222',
};

test('a config with no engine defaults to attached', () => {
  assert.equal(DEFAULT_ENGINE, 'attached');
  assert.equal(engineFor({}).name, 'attached');
  assert.equal(engineFor({ engine: 'attached' }).name, 'attached');
});

test('an unrecognized engine throws with exit code 78', () => {
  assert.throws(
    () => engineFor({ engine: 'headless' }),
    (error) => {
      assert.ok(error instanceof UnknownEngineError);
      assert.equal(error.exitCode, 78);
      assert.match(error.message, /headless/);
      return true;
    },
  );
});

test('the attached arg list keeps its exact historical order', () => {
  assert.deepEqual(runtimeArgs({ config: legacy, paths, lock }), [
    '--extension',
    '--extension-id=abcdefghijklmnopabcdefghijklmnop',
    '--snapshot-mode=none',
    '--timeout-settle=200',
    '--output-dir=/synthetic-home/.fast-browser',
  ]);
});

test('the cdp engine emits the endpoint and never --headless or --extension', () => {
  const args = runtimeArgs({ config: cloud, paths, lock });

  assert.deepEqual(args, [
    '--cdp-endpoint=http://127.0.0.1:9222',
    '--snapshot-mode=none',
    '--timeout-settle=200',
    '--output-dir=/synthetic-home/.fast-browser',
  ]);
  // Under --cdp-endpoint, headlessness belongs to the sidecar's Chrome.
  // Emitting the flag would imply a knob that does nothing.
  assert.ok(!args.includes('--headless'));
  assert.ok(!args.some((arg) => arg.startsWith('--extension')));
});

test('both engines inherit the shared observation defaults', () => {
  for (const config of [legacy, cloud]) {
    const args = runtimeArgs({ config, paths, lock });
    assert.ok(args.includes('--snapshot-mode=none'), 'snapshots stay off by default');
    assert.ok(args.includes('--timeout-settle=200'), 'settle stays at 200ms');
  }
});

test('outputDir overrides the resolved data dir when set', () => {
  const args = runtimeArgs({ config: { ...cloud, outputDir: '/tmp/fb' }, paths, lock });
  assert.ok(args.includes('--output-dir=/tmp/fb'));
  assert.ok(!args.includes('--output-dir=/synthetic-home/.fast-browser'));
});

test('secretsFile adds --secrets and is absent when unset', () => {
  assert.ok(
    runtimeArgs({ config: { ...cloud, secretsFile: '/run/secrets/app.env' }, paths, lock })
      .includes('--secrets=/run/secrets/app.env'),
  );
  assert.ok(
    !runtimeArgs({ config: cloud, paths, lock }).some((arg) => arg.startsWith('--secrets')),
  );
});
