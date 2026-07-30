import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

import { readPngSize } from '../../lib/annotate/png.mjs';
import { rasterise } from '../../lib/annotate/render.mjs';
import { buildSvg } from '../../lib/annotate/svg.mjs';
import { annotate } from '../../lib/commands/annotate.mjs';
import { defaultConfig } from '../../lib/core/config.mjs';
import { saveConfig } from '../../lib/core/files.mjs';
import { resolvePaths } from '../../lib/core/paths.mjs';

const execFile = promisify(execFileCallback);
const pluginRoot = fileURLToPath(new URL('../../', import.meta.url));

function pngBytes(width, height) {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.write('IHDR', 12, 'latin1');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

// pngBytes above is only a 24-byte IHDR header: enough for readPngSize, but
// not for rsvg-convert, which decodes the embedded base image for real. The
// end-to-end import test below runs the real renderer, so it needs a fully
// decodable PNG; the gradient keeps the pixels non-uniform so an annotation
// drawn over them provably changes the raster.
function decodablePng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const stride = width * 3 + 1; // one filter byte per scanline
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      raw[y * stride + 1 + x * 3] = (x * 7) & 0xff;
      raw[y * stride + 2 + x * 3] = (y * 5) & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
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

// `type` is user-supplied config data and is never validated against
// ANNOTATION_TYPES before these two guards run, so echoing it puts an
// arbitrary string into CLI output. Every other diagnosable failure in this
// command names the field rather than the value (see confinedName and the
// missing-base error in lib/commands/annotate.mjs, and the duplicate
// positional in lib/cli/parse-args.mjs); the annotation index is our own
// number and locates the entry just as precisely.
test('a bounds failure names the annotation index and never echoes the config type', async () => {
  const hostile = '"><script>alert(1)</script> /Users/someone/secret';
  for (const annotations of [
    [{ type: hostile, box: [860, 200, 100, 17] }],
    [{ type: hostile, box: [320, 128, 0, 0] }],
  ]) {
    const { paths, configPath, config } = await fixture({ ...BODY, annotations });
    await assert.rejects(
      () => annotate({ command: 'annotate', config: configPath }, {
        paths, loadConfig: async () => config, rasterise: async () => {},
      }),
      (error) => error.name === 'LifecycleError'
        && error.exitCode === 2
        && /annotation 0\b/.test(error.message)
        && !error.message.includes(hostile)
        && !error.message.includes('<script>'),
    );
  }
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

// An import-mode config carries an absolute path into the temp home, which
// does not exist until the fixture creates it, so the body is built from the
// created fixture rather than passed in like fixture() takes it.
async function importFixture(makeBody) {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'fb-annot-'));
  const paths = resolvePaths({ homeDir, pluginRoot: process.cwd() });
  await mkdir(paths.screenshotsDir, { recursive: true });
  const sourcePath = path.join(homeDir, 'ticket.png');
  await writeFile(sourcePath, pngBytes(400, 300));
  const configPath = path.join(homeDir, 'annot.json');
  await writeFile(configPath, JSON.stringify(makeBody({ homeDir, paths, sourcePath })));
  return {
    paths,
    configPath,
    sourcePath,
    config: { ...defaultConfig(), annotation: { palette: 'violet' } },
  };
}

test('import mode reads dimensions from the png itself and reports its source', async () => {
  const { paths, configPath, sourcePath, config } = await importFixture(({ sourcePath: source }) => ({
    import: source,
    out: 'ticket-annotated.png',
    annotations: [{ type: 'highlight', box: [10, 10, 40, 20] }],
  }));
  let rendered = null;
  const report = await annotate(
    { command: 'annotate', config: configPath, json: true },
    {
      paths,
      loadConfig: async () => config,
      rasterise: async (call) => { rendered = call; },
    },
  );
  assert.equal(report.mode, 'import');
  assert.equal(report.source, sourcePath);
  assert.equal(report.out, path.join(paths.screenshotsDir, 'ticket-annotated.png'));
  assert.match(rendered.svg, /viewBox="0 0 400 300"/);
});

test('import mode still bounds-checks annotations against the png dimensions', async () => {
  const { paths, configPath, config } = await importFixture(({ sourcePath: source }) => ({
    import: source,
    out: 'ticket-annotated.png',
    annotations: [{ type: 'blur', box: [380, 100, 40, 20] }],
  }));
  await assert.rejects(
    () => annotate({ command: 'annotate', config: configPath }, {
      paths, loadConfig: async () => config, rasterise: async () => {},
    }),
    /outside the image/,
  );
});

test('annotate refuses a relative import path, naming the field and not the value', async () => {
  const { paths, configPath, config } = await fixture({
    import: 'ticket.png',
    out: 'ticket-annotated.png',
    annotations: BODY.annotations,
  });
  await assert.rejects(
    () => annotate({ command: 'annotate', config: configPath }, {
      paths, loadConfig: async () => config, rasterise: async () => {},
    }),
    (error) => error.name === 'LifecycleError'
      && error.exitCode === 2
      && /import must be an absolute path/.test(error.message)
      && !error.message.includes('ticket.png'),
  );
});

test('annotate refuses a config naming both import and base', async () => {
  const { paths, configPath, config } = await fixture({
    ...BODY,
    import: path.join(tmpdir(), 'somewhere.png'),
  });
  await assert.rejects(
    () => annotate({ command: 'annotate', config: configPath }, {
      paths, loadConfig: async () => config, rasterise: async () => {},
    }),
    /mutually exclusive/,
  );
});

test('annotate refuses a config naming neither import nor base', async () => {
  const { paths, configPath, config } = await fixture({
    out: 'out.png',
    annotations: BODY.annotations,
  });
  await assert.rejects(
    () => annotate({ command: 'annotate', config: configPath }, {
      paths, loadConfig: async () => config, rasterise: async () => {},
    }),
    /must name a source image/,
  );
});

test('annotate refuses a measured block alongside import', async () => {
  const { paths, configPath, config } = await importFixture(({ sourcePath: source }) => ({
    import: source,
    out: 'ticket-annotated.png',
    measured: BODY.measured,
    annotations: BODY.annotations,
  }));
  await assert.rejects(
    () => annotate({ command: 'annotate', config: configPath }, {
      paths, loadConfig: async () => config, rasterise: async () => {},
    }),
    /measured does not apply to import/,
  );
});

test('annotate reports a diagnosable, exit-2 error when the import file is missing', async () => {
  const { paths, configPath, config } = await importFixture(({ homeDir }) => ({
    import: path.join(homeDir, 'does-not-exist.png'),
    out: 'ticket-annotated.png',
    annotations: [{ type: 'highlight', box: [10, 10, 40, 20] }],
  }));
  await assert.rejects(
    () => annotate({ command: 'annotate', config: configPath }, {
      paths, loadConfig: async () => config, rasterise: async () => {},
    }),
    // Like the missing-base case above: diagnosable, names the field, and
    // never echoes the user-supplied path back out.
    (error) => error.name === 'LifecycleError'
      && error.exitCode === 2
      && /import/.test(error.message)
      && /not found/.test(error.message)
      && !error.message.includes('does-not-exist.png'),
  );
});

test('annotate refuses an import path that resolves inside the screenshots directory', async () => {
  // Screenshots-directory captures are base mode's job, and keeping import
  // out of that directory is also what makes out (always confined inside it)
  // structurally unable to overwrite the import source.
  const { paths, configPath, config } = await importFixture(({ paths: p }) => ({
    import: path.join(p.screenshotsDir, 'base.png'),
    out: 'ticket-annotated.png',
    annotations: BODY.annotations,
  }));
  await assert.rejects(
    () => annotate({ command: 'annotate', config: configPath }, {
      paths, loadConfig: async () => config, rasterise: async () => {},
    }),
    (error) => error.name === 'LifecycleError'
      && error.exitCode === 2
      && /must not resolve inside the screenshots directory/.test(error.message)
      && !error.message.includes(paths.screenshotsDir),
  );
});

test('annotate refuses an import symlink whose target lives inside the screenshots directory', async () => {
  // The refusal judges physical locations, not spellings: an alias outside
  // the directory pointing at a capture inside it would otherwise reopen both
  // holes the refusal exists to close -- annotating a capture with
  // assertMeasurement skipped, and out overwriting the file import reads.
  const { paths, configPath, config } = await importFixture(({ homeDir }) => ({
    import: path.join(homeDir, 'alias.png'),
    out: 'victim.png',
    annotations: [{ type: 'highlight', box: [10, 10, 40, 20] }],
  }));
  const victim = path.join(paths.screenshotsDir, 'victim.png');
  await writeFile(victim, pngBytes(400, 300));
  await symlink(victim, path.join(paths.homeDir, 'alias.png'));
  await assert.rejects(
    () => annotate({ command: 'annotate', config: configPath }, {
      paths, loadConfig: async () => config, rasterise: async () => {},
    }),
    (error) => error.name === 'LifecycleError'
      && error.exitCode === 2
      && /must not resolve inside the screenshots directory/.test(error.message),
  );
  // The refusal fires before anything renders or writes, so the capture the
  // alias points at is untouched.
  assert.deepEqual(await readFile(victim), pngBytes(400, 300));
});

test('annotate accepts an import symlink whose target is outside the screenshots directory', async () => {
  // Symlinks per se are fine -- agents get handed paths they did not lay out.
  // Only a link that reaches a capture is refused.
  const { paths, configPath, sourcePath, config } = await importFixture(({ homeDir }) => ({
    import: path.join(homeDir, 'alias.png'),
    out: 'ticket-annotated.png',
    annotations: [{ type: 'highlight', box: [10, 10, 40, 20] }],
  }));
  await symlink(sourcePath, path.join(paths.homeDir, 'alias.png'));
  const report = await annotate(
    { command: 'annotate', config: configPath, json: true },
    { paths, loadConfig: async () => config, rasterise: async () => {} },
  );
  assert.equal(report.mode, 'import');
  assert.equal(report.source, path.join(paths.homeDir, 'alias.png'));
});

test('import mode end to end: the real CLI rasterises a foreign png at 2x with visible annotations', async (t) => {
  // The other tests in this file stub rasterise, so npm test never needs
  // librsvg. This one runs the real renderer end to end; on a machine
  // without it, skip rather than fail, matching how annotation itself is a
  // permanently-optional capability (see the doctor checks).
  try {
    await execFile('rsvg-convert', ['--version']);
  } catch {
    t.skip('rsvg-convert is not installed');
    return;
  }

  const homeDir = await mkdtemp(path.join(tmpdir(), 'fb-annot-cli-'));
  const paths = resolvePaths({ homeDir, pluginRoot });
  // The real CLI loads its own config, so the palette choice has to exist on
  // disk under the temp home rather than being injected.
  await saveConfig(paths, { ...defaultConfig(), annotation: { palette: 'violet' } });
  const sourcePath = path.join(homeDir, 'ticket.png');
  const sourceBytes = decodablePng(120, 80);
  await writeFile(sourcePath, sourceBytes);
  const configPath = path.join(homeDir, 'import.json');
  await writeFile(configPath, JSON.stringify({
    import: sourcePath,
    out: 'ticket-annotated.png',
    annotations: [
      { type: 'highlight', box: [10, 10, 40, 20] },
      { type: 'blur', box: [60, 40, 30, 20], amount: 10 },
    ],
  }));

  const { stdout } = await execFile(
    process.execPath,
    [path.join(pluginRoot, 'bin/fast-browser.mjs'), 'annotate', configPath, '--json'],
    // HOME steers lib/core/paths.mjs in the child process to the temp home,
    // so the output can only ever land there, never in the real one.
    { env: { ...process.env, HOME: homeDir } },
  );
  const report = JSON.parse(stdout);
  assert.equal(report.mode, 'import');
  assert.equal(report.source, sourcePath);
  assert.ok(
    report.out.startsWith(paths.screenshotsDir + path.sep),
    'the annotated output must land in the temp home screenshots directory',
  );

  const outBytes = await readFile(report.out);
  const out = readPngSize(outBytes);
  assert.equal(out.width, 240);
  assert.equal(out.height, 160);

  // rsvg-convert is deterministic, so byte-equality with an unannotated
  // control raster of the same source at the same scale and palette would
  // mean the CLI silently dropped every annotation while still reporting
  // success and the right dimensions.
  const controlPath = path.join(homeDir, 'control.png');
  await rasterise({
    svg: buildSvg({
      base: sourceBytes,
      width: 120,
      height: 80,
      annotations: [],
      palette: report.palette,
      scale: 2,
    }),
    outPath: controlPath,
  });
  assert.ok(
    !outBytes.equals(await readFile(controlPath)),
    'the CLI output must differ from an unannotated raster of the same source',
  );
});
