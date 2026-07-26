import crypto from 'node:crypto';
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
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
  try {
    await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, paths.configFile);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch (cleanupError) {
      if (cleanupError?.code !== 'ENOENT') error.cleanupError = cleanupError;
    }
    throw error;
  }
}
