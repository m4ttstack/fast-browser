// Pins chromium-headless-shell for compose. Re-hosts each platform's zip as
// an asset on the fork's immutable release (the lock only accepts immutable
// GitHub release URLs) and writes its checksum into runtime-lock.json.
import { execFile as execFileCallback } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const { values } = parseArgs({ options: {
  revision: { type: 'string' }, tag: { type: 'string' }, 'url-mac-arm64': { type: 'string' }, 'url-mac-x64': { type: 'string' },
  upload: { type: 'boolean', default: false },
} });
for (const key of ['revision', 'tag', 'url-mac-arm64', 'url-mac-x64']) {
  if (!values[key]) { console.error(`--${key} is required`); process.exit(2); }
}
if (!/^\d+$/.test(values.revision)) { console.error('--revision must be digits only'); process.exit(2); }
if (!/^fast-browser-v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(values.tag)) { console.error('--tag must look like fast-browser-v1.2.3'); process.exit(2); }

const repo = 'm4ttheweric/playwright';
const lockPath = fileURLToPath(new URL('../runtime-lock.json', import.meta.url));
const dir = await mkdtemp(path.join(tmpdir(), 'pin-renderer-'));
try {
  const platforms = {};
  // Nothing is uploaded until every platform has downloaded and verified, so a
  // failed sibling never leaves a half-published release.
  for (const platform of ['mac-arm64', 'mac-x64']) {
    const file = `chromium-headless-shell-${values.revision}-${platform}.zip`;
    const response = await fetch(values[`url-${platform}`]);
    if (!response.ok) throw new Error(`download failed for ${platform}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || !bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
      throw new Error(`download for ${platform} is not a zip`);
    }
    await writeFile(path.join(dir, file), bytes);
    platforms[platform] = {
      url: `https://github.com/${repo}/releases/download/${values.tag}/${file}`,
      file,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
  }
  if (values.upload) {
    // No --clobber: the release is public and earlier locks pin its assets.
    for (const { file } of Object.values(platforms)) {
      await execFile('gh', ['release', 'upload', values.tag, path.join(dir, file), '--repo', repo]);
    }
  }
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  lock.renderer = { revision: values.revision, platforms };
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`Pinned renderer ${values.revision}${values.upload ? ' and uploaded assets' : ' (not uploaded)'}; zips in ${dir}`);
} catch (error) {
  await rm(dir, { recursive: true, force: true });
  throw error;
}
