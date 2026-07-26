import { constants } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { assertConfinedPath } from '../core/containment.mjs';

const BUILTIN_MACROS = ['page-recon.js'];

export async function installBuiltinMacros(paths) {
  const dataDir = path.dirname(paths.macrosDir);
  const destinations = await Promise.all(BUILTIN_MACROS.map(async (name) => {
    const destination = path.join(paths.macrosDir, name);
    await assertConfinedPath({
      dataDir,
      rootDir: paths.macrosDir,
      candidate: destination,
    });
    return { name, destination };
  }));

  await mkdir(paths.macrosDir, { recursive: true, mode: 0o700 });
  for (const { name, destination } of destinations) {
    const source = path.join(paths.pluginRoot, 'builtins', 'macros', name);
    try {
      await copyFile(source, destination, constants.COPYFILE_EXCL);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
}
