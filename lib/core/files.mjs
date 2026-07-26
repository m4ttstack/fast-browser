import crypto from 'node:crypto';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parseConfig } from './config.mjs';

export async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

export async function saveConfig(paths, config) {
  const parsed = parseConfig(config);
  await ensurePrivateDirectory(paths.dataDir);
  const temporary = path.join(
    paths.dataDir,
    `.config.json.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, paths.configFile);
}
