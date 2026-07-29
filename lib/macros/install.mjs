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

import { LifecycleError } from '../commands/shared.mjs';
import { assertConfinedPath } from '../core/containment.mjs';

// Every built-in macro ships as a file plus a `## <name>` section in the
// packaged index. Neither is ever overwritten blind. On a machine that already
// ran setup, each destination is classified by what its bytes are, not by
// whether it exists: bytes this project itself shipped in some release are
// refreshed to the current ones, bytes already current are left alone, and
// anything else is the user's and is preserved.
//
// Copying without overwriting was the whole install rule until now, which made
// the first install permanent: a shipped bug in a built-in could never reach a
// machine that already had the file, and rerunning setup repaired neither the
// macro nor its index entry. capture-annotated gaining a required `home`
// argument is the case that proved it, since existing installs kept both the
// old macro and an index section documenting the old signature. A stale
// `Params` line misleads exactly as badly as stale code, so the index section
// is classified by the same rule as the file.
export const BUILTIN_NAMES = Object.freeze([
  'page-recon.js',
  'page-affordances.js',
  'capture-annotated.js',
]);
export const INDEX_NAME = 'MACROS.md';
export const MACRO_HASHES_NAME = 'macro-hashes.json';

const HEX64 = /^[0-9a-f]{64}$/;
const MACRO_MESSAGE = 'existing built-in macro must be a regular file';
const INDEX_MESSAGE = 'live macro index must be a regular file';

export function digestText(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

const EMPTY_DIGEST = digestText('');

export function macroIndexName(fileName) {
  return fileName.replace(/\.js$/, '');
}

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
  await readRegularFile(target, MACRO_MESSAGE);
}

function sectionBounds(text, macroName) {
  const heading = new RegExp(`^## ${macroName}[ \\t]*$`, 'm');
  const start = text.search(heading);
  if (start < 0) return null;
  const next = text.slice(start + 1).search(/^## /m);
  return { start, end: next < 0 ? text.length : start + 1 + next };
}

// Trailing blank lines are layout, not content: an index that differs from the
// shipped one only by how many newlines precede the next heading is still the
// shipped text, and hashing the untrimmed slice would misfile it as a user
// edit and freeze it forever.
export function indexSectionBody(text, macroName) {
  const bounds = sectionBounds(text, macroName);
  return bounds ? text.slice(bounds.start, bounds.end).trimEnd() : null;
}

function packagedSection(template, macroName) {
  const body = indexSectionBody(template, macroName);
  if (body === null) throw new Error(`packaged macro index is missing ${macroName}`);
  return body;
}

function manifestError(message) {
  return new LifecycleError(message, { stage: 'install-macros', exitCode: 2 });
}

function shippedDigests(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw manifestError(`${MACRO_HASHES_NAME} records no shipped hash for ${label}`);
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || !HEX64.test(entry)) {
      throw manifestError(`${MACRO_HASHES_NAME} records a malformed hash for ${label}`);
    }
    // The digest of no bytes at all. A generator that hashes whatever it read
    // for a file a release did not contain writes exactly this, and trusting
    // it would let the installer call an emptied file project-shipped and
    // overwrite the user's truncation.
    if (entry === EMPTY_DIGEST) {
      throw manifestError(`${MACRO_HASHES_NAME} records the empty-file digest for ${label}`);
    }
  }
  return new Set(value);
}

// The manifest is packaged data on the same footing as the index template:
// without it there is no way to tell a stale shipped file from a user's own
// work, and guessing in either direction is worse than refusing.
async function loadShippedDigests(pluginRoot) {
  const file = path.join(pluginRoot, 'builtins', MACRO_HASHES_NAME);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    throw manifestError(`${MACRO_HASHES_NAME} is missing or unreadable`);
  }
  const macros = new Map();
  const sections = new Map();
  for (const name of BUILTIN_NAMES) {
    macros.set(name, shippedDigests(parsed?.macros?.[name], name));
    const sectionName = macroIndexName(name);
    sections.set(sectionName, shippedDigests(parsed?.indexSections?.[sectionName], sectionName));
  }
  return { macros, sections };
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

// Refreshing is still a read-decide-write sequence, so the decision is
// re-checked against the destination's identity and bytes immediately before
// the rename. Without that, an edit landing in the gap between classification
// and write would be clobbered by a refresh that was authorised against
// bytes the user had already replaced.
async function replaceUnchangedFile(target, original, replacement, { readMessage, changedMessage }) {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, replacement, {
      flag: 'wx',
      mode: original.state.mode & 0o777,
    });
    const current = await readRegularFile(target, readMessage);
    if (!sameIdentity(current.state, original.state) || current.text !== original.text) {
      throw new Error(changedMessage);
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

function classify(live, packaged, shipped) {
  if (live === packaged) return 'current';
  return shipped.has(live) ? 'refreshed' : 'preserved';
}

async function ensureLiveIndex(indexFile, template, shipped) {
  const macroNames = BUILTIN_NAMES.map(macroIndexName);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const state = await lstatOrNull(indexFile);
    if (!state) {
      try {
        await createWithoutOverwrite(indexFile, template, 0o600);
        return macroNames.map((name) => ({ name, action: 'installed' }));
      } catch (error) {
        if (error?.code === 'EEXIST') continue;
        throw error;
      }
    }
    const original = await readRegularFile(indexFile, INDEX_MESSAGE);
    const outcomes = [];
    let merged = original.text;
    for (const name of macroNames) {
      const packaged = packagedSection(template, name);
      // Recomputed against `merged`, not `original.text`: an earlier name in
      // this loop may already have moved every offset after it.
      const bounds = sectionBounds(merged, name);
      if (!bounds) {
        const separator = merged.endsWith('\n\n') ? '' : merged.endsWith('\n') ? '\n' : '\n\n';
        merged = `${merged}${separator}${packaged}\n`;
        outcomes.push({ name, action: 'installed' });
        continue;
      }
      const raw = merged.slice(bounds.start, bounds.end);
      const body = raw.trimEnd();
      const action = classify(digestText(body), digestText(packaged), shipped.sections.get(name));
      if (action === 'refreshed') {
        // Splice the body only, carrying the original trailing whitespace
        // through, so refreshing one section never reflows the rest of a file
        // the user owns.
        merged = merged.slice(0, bounds.start)
          + packaged
          + raw.slice(body.length)
          + merged.slice(bounds.end);
      }
      outcomes.push({ name, action });
    }
    if (merged !== original.text) {
      await replaceUnchangedFile(indexFile, original, merged, {
        readMessage: INDEX_MESSAGE,
        changedMessage: 'live macro index changed during merge',
      });
    }
    return outcomes;
  }
  throw new Error('live macro index changed during creation');
}

async function installMacroFile({ source, destination, name, shipped }) {
  const packaged = await readFile(source, 'utf8');
  if (await copyWithoutOverwrite(source, destination)) {
    await verifyMacroFile(destination);
    return 'installed';
  }
  const original = await readRegularFile(destination, MACRO_MESSAGE);
  const action = classify(
    digestText(original.text),
    digestText(packaged),
    shipped.macros.get(name),
  );
  if (action !== 'refreshed') return action;
  await replaceUnchangedFile(destination, original, packaged, {
    readMessage: MACRO_MESSAGE,
    changedMessage: 'built-in macro changed during refresh',
  });
  await verifyMacroFile(destination);
  return action;
}

// Both destination kinds under one action, named the way a user would look
// them up: a macro by its file name, an index entry by the section it owns.
function destinationsWith(macros, index, action) {
  return [
    ...macros.filter((entry) => entry.action === action).map((entry) => entry.name),
    ...index
      .filter((entry) => entry.action === action)
      .map((entry) => `${INDEX_NAME}#${entry.name}`),
  ];
}

// `installed` and `refreshed` are the two actions that put bytes on disk;
// `current` and `preserved` touch nothing. A caller deciding whether its run
// changed anything must ask this rather than assume that having called the
// installer means something was written, because the whole point of the
// checksum rule is that the usual answer is no.
export function macrosWereWritten(report) {
  return (report?.installed?.length ?? 0) > 0 || (report?.refreshed?.length ?? 0) > 0;
}

export async function installBuiltinMacros(paths) {
  const dataDir = path.resolve(paths.dataDir ?? path.dirname(paths.macrosDir));
  const macrosDir = path.resolve(paths.macrosDir);
  if (macrosDir !== path.join(dataDir, 'macros')) {
    throw new Error('macros directory must be the exact data-directory child');
  }
  const indexFile = paths.macroIndexFile ?? path.join(macrosDir, INDEX_NAME);
  if (path.resolve(indexFile) !== path.join(macrosDir, INDEX_NAME)) {
    throw new Error('macro index must use the stable live path');
  }

  await Promise.all([
    ...BUILTIN_NAMES.map((name) => assertConfinedPath({
      dataDir, rootDir: macrosDir, candidate: path.join(macrosDir, name),
    })),
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
  const shipped = await loadShippedDigests(paths.pluginRoot);
  const index = await ensureLiveIndex(indexFile, template, shipped);

  const macros = [];
  for (const name of BUILTIN_NAMES) {
    macros.push({
      name,
      action: await installMacroFile({
        source: path.join(paths.pluginRoot, 'builtins', 'macros', name),
        destination: path.join(macrosDir, name),
        name,
        shipped,
      }),
    });
  }

  return {
    macros,
    index,
    // Preserving is the branch nobody sees happen, and an install left holding
    // a macro that no longer matches its documentation is exactly the state
    // this rewrite exists to make visible.
    preserved: destinationsWith(macros, index, 'preserved'),
    // Refreshing replaced code the user is about to run, under a name they
    // already know, so it is at least as reportable as preserving. Callers
    // also need it to answer "did this run change anything", which is what
    // makes running the installer on every setup honest rather than noisy.
    refreshed: destinationsWith(macros, index, 'refreshed'),
    installed: destinationsWith(macros, index, 'installed'),
  };
}
