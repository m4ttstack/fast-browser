import crypto from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  readdir,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import {
  assertConfined,
  assertNoSymlinkPath,
  canonicalHome,
  readRegularFile,
} from './inventory.mjs';

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function lstatOrNull(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function ensureDirectory(homeDir, target) {
  const pathname = assertConfined(homeDir, target);
  const relative = path.relative(homeDir, pathname);
  let current = homeDir;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const state = await lstatOrNull(current);
    if (!state) {
      await mkdir(current, { mode: 0o700 });
    } else if (state.isSymbolicLink() || !state.isDirectory()) {
      throw new Error(`refusing symlink or non-directory import target: ${current}`);
    }
    await chmod(current, 0o700);
  }
}

async function readTarget(homeDir, target) {
  const state = await lstatOrNull(target);
  if (!state) return null;
  return readRegularFile(homeDir, target, 'import target must be a regular file');
}

async function atomicWrite(homeDir, target, bytes, {
  expected = null,
  createOnly = false,
} = {}) {
  const pathname = assertConfined(homeDir, target);
  await ensureDirectory(homeDir, path.dirname(pathname));
  const temporary = path.join(
    path.dirname(pathname),
    `.${path.basename(pathname)}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await chmod(temporary, 0o600);
    const current = await readTarget(homeDir, pathname);
    if (createOnly && current) throw new Error(`refusing to overwrite import target: ${pathname}`);
    if (expected !== null) {
      if (!current || !current.bytes.equals(expected)) {
        throw new Error(`import target changed during merge: ${pathname}`);
      }
    } else if (!createOnly && current) {
      throw new Error(`import target changed during creation: ${pathname}`);
    }
    if (createOnly) {
      await link(temporary, pathname);
    } else {
      await rename(temporary, pathname);
    }
  } finally {
    try {
      await unlink(temporary);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

async function installMacro(homeDir, source, macrosDir) {
  const { bytes } = await readRegularFile(
    homeDir,
    source.path,
    'legacy macro must remain a regular file',
  );
  const originalTarget = path.join(macrosDir, source.name);
  let target = originalTarget;
  let current = await readTarget(homeDir, target);
  if (current && !current.bytes.equals(bytes)) {
    const extension = path.extname(source.name);
    const stem = source.name.slice(0, -extension.length);
    target = path.join(
      macrosDir,
      `${stem}.legacy-${sha256(bytes).slice(0, 8)}${extension}`,
    );
    current = await readTarget(homeDir, target);
    if (current && !current.bytes.equals(bytes)) {
      throw new Error(`different content occupies deterministic macro collision: ${target}`);
    }
  }
  if (!current) await atomicWrite(homeDir, target, bytes, { createOnly: true });
  return { sourceName: source.name, name: path.basename(target), path: target };
}

function rewriteScriptLines(text, names) {
  return text.split(/(?<=\n)/).map((line) => {
    const match = line.match(/^(\s*-\s*Script:\s*)(.*?)(\r?\n)?$/);
    if (!match) return line;
    const rawValue = match[2].trim();
    const quote = rawValue.startsWith('`') && rawValue.endsWith('`') ? '`' : '';
    const value = quote ? rawValue.slice(1, -1) : rawValue;
    if (!/(?:^|\/)\.playwright-mcp\/macros\/[^/]+\.js$/.test(value)) return line;
    const sourceName = path.posix.basename(value);
    const importedName = names.get(sourceName);
    if (!importedName) return line;
    return `${match[1]}${quote}~/.fast-browser/macros/${importedName}${quote}${match[3] ?? ''}`;
  }).join('');
}

function sections(text) {
  const starts = [...text.matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)];
  return starts.map((match, index) => ({
    heading: match[1],
    text: text.slice(
      match.index,
      starts[index + 1]?.index ?? text.length,
    ).trimEnd(),
  }));
}

function normalizedSection(text) {
  return text
    .replaceAll('\r\n', '\n')
    .replace(
      /(^\s*-\s*Script:\s*`?~\/\.fast-browser\/macros\/)([^/\n]+?)\.legacy-[a-f0-9]{8}(\.js`?\s*$)/m,
      '$1$2$3',
    )
    .trimEnd();
}

function sectionIdentity(text) {
  return sha256(Buffer.from(normalizedSection(text)));
}

function baseHeading(heading) {
  return heading.replace(
    / \(legacy [a-f0-9]{8,64}(?:-[1-9][0-9]*)?\)$/,
    '',
  );
}

function representedSection(section) {
  const normalized = normalizedSection(section.text);
  const body = normalized.replace(/^##[ \t]+.+?[ \t]*(?:\n|$)/, '');
  return `${baseHeading(section.heading)}\0${body}`;
}

function legacyHeading(section, present) {
  const identity = sectionIdentity(section.text);
  for (let length = 8; length <= identity.length; length += 4) {
    const candidate = `${section.heading} (legacy ${identity.slice(0, length)})`;
    if (!present.has(candidate)) return candidate;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${section.heading} (legacy ${identity}-${suffix})`;
    if (!present.has(candidate)) return candidate;
  }
}

function appendSections(current, imported) {
  const currentSections = sections(current);
  const represented = new Set(currentSections.map(representedSection));
  const present = new Set(currentSections.map(({ heading }) => heading));
  const additions = [];
  for (const section of sections(imported)) {
    const normalized = representedSection(section);
    if (represented.has(normalized)) continue;
    if (!present.has(section.heading)) {
      additions.push(section.text);
      present.add(section.heading);
      represented.add(normalized);
      continue;
    }
    const alternateHeading = legacyHeading(section, present);
    additions.push(section.text.replace(
      /^##[ \t]+.+?([ \t]*)$/m,
      `## ${alternateHeading}$1`,
    ));
    present.add(alternateHeading);
    represented.add(normalized);
  }
  if (additions.length === 0) return current;
  const separator = current.length === 0
    ? ''
    : current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n';
  return `${current}${separator}${additions.join('\n\n')}\n`;
}

function appendUniqueLines(current, imported) {
  const known = new Set(current.split(/\r?\n/).filter(Boolean));
  const additions = imported.split(/\r?\n/).filter((line) => line && !known.has(line));
  if (additions.length === 0) return current;
  const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n';
  return `${current}${separator}${additions.join('\n')}\n`;
}

async function mergeText(homeDir, target, imported, merge) {
  const current = await readTarget(homeDir, target);
  if (!current) {
    await atomicWrite(homeDir, target, Buffer.from(imported), { createOnly: true });
    return;
  }
  const merged = merge(current.bytes.toString('utf8'), imported);
  if (merged === current.bytes.toString('utf8')) return;
  await atomicWrite(homeDir, target, Buffer.from(merged), { expected: current.bytes });
}

async function treeFiles(homeDir, root) {
  const files = new Map();
  const queue = [root];
  while (queue.length > 0) {
    const directory = queue.shift();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const relative = path.relative(root, target);
      if (entry.isSymbolicLink()) throw new Error(`refusing symlink in imported tree: ${target}`);
      if (entry.isDirectory()) queue.push(target);
      else if (entry.isFile()) {
        const { bytes } = await readRegularFile(homeDir, target);
        files.set(relative, bytes);
      } else {
        throw new Error(`imported tree entry must be regular: ${target}`);
      }
    }
  }
  return files;
}

async function copyTree(homeDir, source, destination) {
  if (source.kind === 'file') {
    const { bytes } = await readRegularFile(homeDir, source.path);
    const current = await readTarget(homeDir, destination);
    if (current) {
      if (!current.bytes.equals(bytes)) {
        throw new Error(`different content occupies import file: ${destination}`);
      }
      return false;
    }
    await atomicWrite(homeDir, destination, bytes, { createOnly: true });
    return true;
  }
  const sourceFiles = await treeFiles(homeDir, source.path);
  const targetState = await lstatOrNull(destination);
  if (targetState) {
    if (targetState.isSymbolicLink() || !targetState.isDirectory()) {
      throw new Error(`import tree collision must be a directory: ${destination}`);
    }
    const targetFiles = await treeFiles(homeDir, destination);
    if (
      targetFiles.size !== sourceFiles.size
      || [...sourceFiles].some(([name, bytes]) => !targetFiles.get(name)?.equals(bytes))
    ) {
      throw new Error(`different content occupies import tree: ${destination}`);
    }
    return false;
  }
  await ensureDirectory(homeDir, destination);
  for (const [relative, bytes] of sourceFiles) {
    const target = path.join(destination, relative);
    await ensureDirectory(homeDir, path.dirname(target));
    await atomicWrite(homeDir, target, bytes, { createOnly: true });
  }
  return true;
}

export async function importLegacyData({ inventory, paths }) {
  const homeDir = await canonicalHome(paths?.homeDir ?? inventory?.homeDir);
  if (inventory?.schemaVersion !== 1 || inventory.homeDir !== homeDir) {
    throw new Error('invalid migration inventory for import');
  }
  const dataDir = assertConfined(homeDir, paths.dataDir);
  if (dataDir !== path.join(homeDir, '.fast-browser')) {
    throw new Error('migration data directory must use the stable home path');
  }
  const stableTargets = [
    [paths.macrosDir, path.join(dataDir, 'macros')],
    [paths.macroIndexFile, path.join(dataDir, 'macros', 'MACROS.md')],
    [paths.macroFailuresFile, path.join(dataDir, 'macro-failures.md')],
    [paths.sessionsDir, path.join(dataDir, 'sessions')],
    [paths.archiveDir, path.join(dataDir, 'archive')],
  ];
  for (const [target, expected] of stableTargets) {
    if (path.resolve(target) !== expected) {
      throw new Error('migration import target must use the stable data path');
    }
    await assertNoSymlinkPath(homeDir, target);
  }
  await ensureDirectory(homeDir, paths.macrosDir);

  const macros = [];
  for (const source of inventory.imports.macros) {
    macros.push(await installMacro(homeDir, source, paths.macrosDir));
  }
  const names = new Map(macros.map(({ sourceName, name }) => [sourceName, name]));

  if (inventory.imports.macroIndex) {
    const { bytes } = await readRegularFile(homeDir, inventory.imports.macroIndex.path);
    const rewritten = rewriteScriptLines(bytes.toString('utf8'), names);
    await mergeText(homeDir, paths.macroIndexFile, rewritten, appendSections);
  }
  if (inventory.imports.failureRecord) {
    const { bytes } = await readRegularFile(homeDir, inventory.imports.failureRecord.path);
    await mergeText(
      homeDir,
      paths.macroFailuresFile,
      bytes.toString('utf8'),
      appendUniqueLines,
    );
  }

  const sessions = [];
  for (const source of inventory.imports.sessions) {
    const target = path.join(paths.sessionsDir, source.name);
    await copyTree(homeDir, source, target);
    sessions.push({ name: source.name, path: target });
  }
  const archive = [];
  for (const source of inventory.imports.archive) {
    const target = path.join(paths.archiveDir, source.name);
    await copyTree(homeDir, source, target);
    archive.push({ name: source.name, path: target });
  }

  return {
    macros: macros.map(({ sourceName, ...entry }) => entry),
    macroIndex: inventory.imports.macroIndex ? paths.macroIndexFile : null,
    failureRecord: inventory.imports.failureRecord ? paths.macroFailuresFile : null,
    sessions,
    archive,
  };
}
