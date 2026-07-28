import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { annotate } from '../../lib/commands/annotate.mjs';
import { defaultConfig } from '../../lib/core/config.mjs';
import { resolvePaths } from '../../lib/core/paths.mjs';

function pngBytes(width, height) {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.write('IHDR', 12, 'latin1');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

async function fixture(configBody, { palette = 'violet' } = {}) {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'fb-annot-'));
  const paths = resolvePaths({ homeDir, pluginRoot: process.cwd() });
  await mkdir(paths.screenshotsDir, { recursive: true });
  await writeFile(path.join(paths.screenshotsDir, 'base.png'), pngBytes(900, 560));
  const configPath = path.join(homeDir, 'annot.json');
  await writeFile(configPath, JSON.stringify(configBody));
  return {
    paths,
    configPath,
    config: { ...defaultConfig(), annotation: { palette } },
  };
}

const BODY = {
  base: 'base.png',
  out: 'base-annotated.png',
  measured: { schemaVersion: 1, viewport: { inner: [900, 560], client: [900, 560] } },
  annotations: [{ type: 'highlight', box: [783, 200, 72, 17] }],
};

test('annotate rasterises to the screenshots directory', async () => {
  const { paths, configPath, config } = await fixture(BODY);
  let rendered = null;
  const report = await annotate(
    { command: 'annotate', config: configPath, json: true },
    {
      paths,
      loadConfig: async () => config,
      rasterise: async ({ svg, outPath }) => { rendered = { svg, outPath }; },
    },
  );
  assert.equal(report.out, path.join(paths.screenshotsDir, 'base-annotated.png'));
  assert.equal(rendered.outPath, report.out);
  assert.match(rendered.svg, /viewBox="0 0 900 560"/);
});

test('annotate refuses when no palette has been chosen', async () => {
  const { paths, configPath, config } = await fixture(BODY, { palette: null });
  await assert.rejects(
    () => annotate({ command: 'annotate', config: configPath }, {
      paths, loadConfig: async () => config, rasterise: async () => {},
    }),
    /fast-browser configure --palette/,
  );
});

test('annotate refuses a box that extends past the image', async () => {
  const { paths, configPath, config } = await fixture({
    ...BODY,
    annotations: [{ type: 'blur', box: [860, 200, 100, 17] }],
  });
  await assert.rejects(
    () => annotate({ command: 'annotate', config: configPath }, {
      paths, loadConfig: async () => config, rasterise: async () => {},
    }),
    /outside the image/,
  );
});

test('annotate refuses a zero-area blur box instead of reporting a redaction that covers nothing', async () => {
  // Both corners of a zero-area box are identical and trivially in bounds,
  // so the plain corner-based bounds check accepts it. buildSvg's clipPath
  // then encloses zero pixels, so a `blur` -- the PII redaction primitive --
  // would silently redact nothing while the command still reports success.
  const { paths, configPath, config } = await fixture({
    ...BODY,
    annotations: [{ type: 'blur', box: [320, 128, 0, 0] }],
  });
  const rasteriseCalls = [];
  await assert.rejects(
    () => annotate({ command: 'annotate', config: configPath }, {
      paths,
      loadConfig: async () => config,
      rasterise: async (call) => { rasteriseCalls.push(call); },
    }),
    /zero-area|not greater than zero/,
  );
  assert.equal(rasteriseCalls.length, 0, 'must fail before ever handing a zero-area box to rasterise');
});

test('annotate refuses a zero-width (but non-zero-height) box', async () => {
  const { paths, configPath, config } = await fixture({
    ...BODY,
    annotations: [{ type: 'highlight', box: [320, 128, 0, 17] }],
  });
  await assert.rejects(
    () => annotate({ command: 'annotate', config: configPath }, {
      paths, loadConfig: async () => config, rasterise: async () => {},
    }),
    /zero-area|not greater than zero/,
  );
});

test('annotate refuses an arrow whose head lands outside the image', async () => {
  const { paths, configPath, config } = await fixture({
    ...BODY,
    annotations: [{ type: 'arrow', tail: [100, 100], head: [950, 100] }],
  });
  await assert.rejects(
    () => annotate({ command: 'annotate', config: configPath }, {
      paths, loadConfig: async () => config, rasterise: async () => {},
    }),
    /outside the image/,
  );
});

test('annotate refuses an arrow whose tail lands outside the image', async () => {
  const { paths, configPath, config } = await fixture({
    ...BODY,
    annotations: [{ type: 'arrow', tail: [-10, 100], head: [100, 100] }],
  });
  await assert.rejects(
    () => annotate({ command: 'annotate', config: configPath }, {
      paths, loadConfig: async () => config, rasterise: async () => {},
    }),
    /outside the image/,
  );
});

test('annotate refuses a chip anchored outside the image', async () => {
  const { paths, configPath, config } = await fixture({
    ...BODY,
    annotations: [{ type: 'chip', xy: [890, 600], text: 'Total' }],
  });
  await assert.rejects(
    () => annotate({ command: 'annotate', config: configPath }, {
      paths, loadConfig: async () => config, rasterise: async () => {},
    }),
    /outside the image/,
  );
});

test('annotate refuses a counter anchored outside the image', async () => {
  const { paths, configPath, config } = await fixture({
    ...BODY,
    annotations: [{ type: 'counter', xy: [905, 10], n: 1 }],
  });
  await assert.rejects(
    () => annotate({ command: 'annotate', config: configPath }, {
      paths, loadConfig: async () => config, rasterise: async () => {},
    }),
    /outside the image/,
  );
});

test('bounds checking skips geometry it cannot interpret, leaving svg validation to reject it', async () => {
  // box.width is a string here. A bounds check that computed a corner from
  // this without a finite-number guard would compare against NaN, which is
  // always false, and silently pass the annotation through as "in bounds".
  // The command must still fail, but on buildSvg's own geometry validation,
  // not on a false "outside the image" claim manufactured from NaN math.
  const { paths, configPath, config } = await fixture({
    ...BODY,
    annotations: [{ type: 'blur', box: [10, 10, 'wide', 20] }],
  });
  await assert.rejects(
    () => annotate({ command: 'annotate', config: configPath }, {
      paths, loadConfig: async () => config, rasterise: async () => {},
    }),
    /invalid annotation geometry/,
  );
});

test('annotate refuses an unversioned measurement payload', async () => {
  const { paths, configPath, config } = await fixture({
    ...BODY, measured: { viewport: { inner: [900, 560], client: [900, 560] } },
  });
  await assert.rejects(
    () => annotate({ command: 'annotate', config: configPath }, {
      paths, loadConfig: async () => config, rasterise: async () => {},
    }),
    /measurement payload/,
  );
});

test('annotate refuses when the PNG matches neither reported viewport width', async () => {
  const { paths, configPath, config } = await fixture({
    ...BODY, measured: { schemaVersion: 1, viewport: { inner: [1280, 560], client: [1265, 560] } },
  });
  await assert.rejects(
    () => annotate({ command: 'annotate', config: configPath }, {
      paths, loadConfig: async () => config, rasterise: async () => {},
    }),
    /does not match the measured viewport/,
  );
});

test('annotate refuses to overwrite its own base', async () => {
  const { paths, configPath, config } = await fixture({ ...BODY, out: 'base.png' });
  await assert.rejects(
    () => annotate({ command: 'annotate', config: configPath }, {
      paths, loadConfig: async () => config, rasterise: async () => {},
    }),
    /must not overwrite/,
  );
});

test('annotate refuses a base or out that escapes the screenshots directory', async () => {
  for (const escape of ['../config.json', '/etc/passwd']) {
    const { paths, configPath, config } = await fixture({ ...BODY, out: escape });
    await assert.rejects(
      () => annotate({ command: 'annotate', config: configPath }, {
        paths, loadConfig: async () => config, rasterise: async () => {},
      }),
      // The confinement failure is a validation failure like every other
      // guard in this command, not an unlabelled crash: it must surface as
      // a LifecycleError with exit code 2 (not fall through to main.mjs's
      // safeFailure() and collapse to a diagnostics-free exit 1), and it
      // must never echo the raw, user-supplied escape string back out.
      (error) => error.name === 'LifecycleError'
        && error.exitCode === 2
        && !error.message.includes(escape),
    );
  }
});

test('annotate reports a diagnosable, exit-2 error when the named base capture is missing', async () => {
  const { paths, configPath, config } = await fixture({ ...BODY, base: 'does-not-exist.png' });
  await assert.rejects(
    () => annotate({ command: 'annotate', config: configPath }, {
      paths, loadConfig: async () => config, rasterise: async () => {},
    }),
    // A missing base is one of the two most likely real-world failures (the
    // capture landed under a slightly different name). It must not collapse
    // to main.mjs's generic "failed without exposing external diagnostics"
    // exit-1 message: the agent needs enough signal to self-correct, without
    // the raw filename (user-supplied config data) being echoed back.
    (error) => error.name === 'LifecycleError'
      && error.exitCode === 2
      && /base/.test(error.message)
      && /screenshots directory/.test(error.message)
      && !error.message.includes('does-not-exist.png'),
  );
});

test('a failed rasterise never leaves a report claiming success', async () => {
  const { paths, configPath, config } = await fixture(BODY);
  await assert.rejects(
    () => annotate({ command: 'annotate', config: configPath }, {
      paths,
      loadConfig: async () => config,
      rasterise: async () => { throw new Error('rsvg-convert failed'); },
    }),
    /rsvg-convert failed/,
  );
});
