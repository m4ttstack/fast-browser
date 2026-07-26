import crypto from 'node:crypto';
import { constants } from 'node:fs';
import {
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { assertConfinedPath } from '../core/containment.mjs';

const BUILTIN_NAME = 'page-recon.js';
const INDEX_NAME = 'MACROS.md';

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function lstatOrNull(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function readRegularFile(target, message) {
  const state = await lstat(target);
  if (state.isSymbolicLink() || !state.isFile()) throw new Error(message);
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(state, opened)) throw new Error(message);
    return { state: opened, text: await handle.readFile('utf8') };
  } finally {
    await handle?.close();
  }
}

async function verifyMacroFile(target) {
  await readRegularFile(target, 'existing built-in macro must be a regular file');
}

function pageReconSection(template) {
  const start = template.search(/^## page-recon[ \t]*$/m);
  if (start < 0) throw new Error('packaged macro index is missing page-recon');
  const next = template.slice(start + 1).search(/^## /m);
  const end = next < 0 ? template.length : start + 1 + next;
  return template.slice(start, end).trimEnd();
}

async function createWithoutOverwrite(target, text, mode) {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, text, { flag: 'wx', mode });
    await link(temporary, target);
  } finally {
    try {
      await unlink(temporary);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

async function copyWithoutOverwrite(source, target) {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    await link(temporary, target);
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  } finally {
    try {
      await unlink(temporary);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

async function replaceUnchangedIndex(target, original, merged) {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, merged, {
      flag: 'wx',
      mode: original.state.mode & 0o777,
    });
    const current = await readRegularFile(
      target,
      'live macro index must be a regular file',
    );
    if (!sameIdentity(current.state, original.state) || current.text !== original.text) {
      throw new Error('live macro index changed during merge');
    }
    await rename(temporary, target);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch (cleanupError) {
      if (cleanupError?.code !== 'ENOENT') error.cleanupError = cleanupError;
    }
    throw error;
  }
}

async function ensureLiveIndex(indexFile, template) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const state = await lstatOrNull(indexFile);
    if (!state) {
      try {
        await createWithoutOverwrite(indexFile, template, 0o600);
        return;
      } catch (error) {
        if (error?.code === 'EEXIST') continue;
        throw error;
      }
    }
    const original = await readRegularFile(
      indexFile,
      'live macro index must be a regular file',
    );
    if (/^## page-recon[ \t]*$/m.test(original.text)) return;
    const separator = original.text.endsWith('\n\n')
      ? ''
      : original.text.endsWith('\n') ? '\n' : '\n\n';
    const merged = `${original.text}${separator}${pageReconSection(template)}\n`;
    await replaceUnchangedIndex(indexFile, original, merged);
    return;
  }
  throw new Error('live macro index changed during creation');
}

export async function installBuiltinMacros(paths) {
  const dataDir = path.resolve(paths.dataDir ?? path.dirname(paths.macrosDir));
  const macrosDir = path.resolve(paths.macrosDir);
  if (macrosDir !== path.join(dataDir, 'macros')) {
    throw new Error('macros directory must be the exact data-directory child');
  }
  const destination = path.join(macrosDir, BUILTIN_NAME);
  const indexFile = paths.macroIndexFile ?? path.join(macrosDir, INDEX_NAME);
  if (path.resolve(indexFile) !== path.join(macrosDir, INDEX_NAME)) {
    throw new Error('macro index must use the stable live path');
  }

  await Promise.all([
    assertConfinedPath({ dataDir, rootDir: macrosDir, candidate: destination }),
    assertConfinedPath({ dataDir, rootDir: macrosDir, candidate: indexFile }),
  ]);
  await mkdir(macrosDir, { recursive: true, mode: 0o700 });
  const macrosState = await lstat(macrosDir);
  const physicalData = await realpath(dataDir);
  if (
    macrosState.isSymbolicLink()
    || !macrosState.isDirectory()
    || path.dirname(await realpath(macrosDir)) !== physicalData
  ) {
    throw new Error('macros directory must be a real data-directory child');
  }

  const template = await readFile(
    path.join(paths.pluginRoot, 'skills', 'browser-macros', INDEX_NAME),
    'utf8',
  );
  await ensureLiveIndex(indexFile, template);

  const source = path.join(paths.pluginRoot, 'builtins', 'macros', BUILTIN_NAME);
  await copyWithoutOverwrite(source, destination);
  await verifyMacroFile(destination);
}
