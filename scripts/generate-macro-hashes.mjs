#!/usr/bin/env node
// Regenerate builtins/macro-hashes.json from the PUBLISHED tarballs.
//
// Git history is not a usable source here. A commit can carry a version
// string before or after that version was actually published (981728b still
// said 0.1.0-alpha.3 while holding work that shipped in 0.1.0-alpha.4), so
// walking tags or commits attributes bytes to the wrong release. The only
// ground truth for "what did version X ship" is version X's tarball.
//
// Absent files are recorded as absent, never hashed. A naive reader that
// hashes whatever readFile returns writes the empty-string digest
// (e3b0c442...) into the manifest for a macro a release never contained,
// which would later make the installer treat a truncated file as shipped
// bytes and refresh over it.
//
// Usage: node scripts/generate-macro-hashes.mjs [--check]

import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  BUILTIN_NAMES,
  INDEX_NAME,
  MACRO_HASHES_NAME,
  digestText,
  indexSectionBody,
  macroIndexName,
} from '../lib/macros/install.mjs';

const execFile = promisify(execFileCallback);
const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const manifestFile = path.join(pluginRoot, 'builtins', MACRO_HASHES_NAME);

async function packageName() {
  const packageJson = JSON.parse(await readFile(path.join(pluginRoot, 'package.json'), 'utf8'));
  return packageJson.name;
}

async function publishedVersions(name) {
  const { stdout } = await execFile('npm', ['view', name, 'versions', '--json'], {
    maxBuffer: 8 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed : [parsed];
}

// npm pack downloads the exact published artifact, which is what the manifest
// is a claim about. Extracting it gives the `package/` prefix tar layout.
async function extractPublished(name, version, workDir) {
  const versionDir = path.join(workDir, version);
  await mkdir(versionDir, { recursive: true });
  await execFile('npm', ['pack', `${name}@${version}`, '--pack-destination', versionDir], {
    cwd: pluginRoot,
    maxBuffer: 64 * 1024 * 1024,
  });
  const [tarball] = (await readdir(versionDir)).filter((entry) => entry.endsWith('.tgz'));
  if (!tarball) throw new Error(`no tarball downloaded for ${version}`);
  await execFile('tar', ['-xzf', path.join(versionDir, tarball), '-C', versionDir]);
  return path.join(versionDir, 'package');
}

async function readIfPresent(target) {
  try {
    return await readFile(target, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function append(into, key, hash) {
  const list = into[key] ?? (into[key] = []);
  if (!list.includes(hash)) list.push(hash);
}

async function collect(root, macros, indexSections, label) {
  for (const name of BUILTIN_NAMES) {
    const text = await readIfPresent(path.join(root, 'builtins', 'macros', name));
    if (text === null) {
      process.stderr.write(`${label}: ${name} absent, not recorded\n`);
      continue;
    }
    append(macros, name, digestText(text));
  }
  const index = await readIfPresent(path.join(root, 'skills', 'browser-macros', INDEX_NAME));
  if (index === null) {
    process.stderr.write(`${label}: ${INDEX_NAME} absent, no sections recorded\n`);
    return;
  }
  for (const name of BUILTIN_NAMES) {
    const section = indexSectionBody(index, macroIndexName(name));
    if (section === null) {
      process.stderr.write(`${label}: ${INDEX_NAME} has no ${macroIndexName(name)} section\n`);
      continue;
    }
    append(indexSections, macroIndexName(name), digestText(section));
  }
}

async function build() {
  const name = await packageName();
  const versions = await publishedVersions(name);
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-macro-hashes-'));
  const macros = {};
  const indexSections = {};
  try {
    for (const version of versions) {
      const root = await extractPublished(name, version, workDir);
      await collect(root, macros, indexSections, version);
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
  // The working tree's own bytes go in last so a release that changes a macro
  // records its hash here before it ships. Without this the next release would
  // see every existing install as user-edited and refuse to refresh it.
  await collect(pluginRoot, macros, indexSections, 'working tree');
  return {
    schemaVersion: 1,
    source: 'published npm tarballs',
    versions,
    macros: Object.fromEntries(BUILTIN_NAMES.map((entry) => [entry, macros[entry] ?? []])),
    indexSections: Object.fromEntries(
      BUILTIN_NAMES.map((entry) => [macroIndexName(entry), indexSections[macroIndexName(entry)] ?? []]),
    ),
  };
}

// "Out of date" is two failures wearing one name and they are not equally bad.
// A hash the tarballs hold and the file does not means every install carrying
// those bytes is about to be classified as the user's and stranded unrefreshed
// forever; a hash the file holds and the tarballs do not is a claim about a
// release that cannot be checked. Saying which one happened is the difference
// between a fixable release step and a shrug.
function differences(expected, recorded) {
  const lines = [];
  const published = expected.versions.join(', ');
  const claimed = (recorded?.versions ?? []).join(', ');
  if (published !== claimed) lines.push(`versions: recorded [${claimed}], published [${published}]`);
  for (const group of ['macros', 'indexSections']) {
    for (const [label, hashes] of Object.entries(expected[group])) {
      const held = recorded?.[group]?.[label] ?? [];
      const lost = hashes.filter((hash) => !held.includes(hash));
      const unattested = held.filter((hash) => !hashes.includes(hash));
      if (lost.length > 0) {
        lines.push(
          `${label}: ${lost.length} hash(es) a published tarball or the working tree holds`
          + ' are missing; installs holding those bytes can never be refreshed',
        );
      }
      if (unattested.length > 0) {
        lines.push(
          `${label}: ${unattested.length} recorded hash(es) match no published tarball`
          + ' and not the working tree',
        );
      }
    }
  }
  return lines;
}

const manifest = await build();
const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
if (process.argv.includes('--check')) {
  const current = await readIfPresent(manifestFile);
  if (current === serialized) {
    process.stdout.write(`${MACRO_HASHES_NAME} matches the published tarballs\n`);
  } else {
    let recorded = null;
    try {
      recorded = current === null ? null : JSON.parse(current);
    } catch {
      recorded = null;
    }
    const lines = current === null
      ? [`${MACRO_HASHES_NAME} is absent`]
      : recorded === null
        ? [`${MACRO_HASHES_NAME} is not readable JSON`]
        : differences(manifest, recorded);
    // The comparison above is over serialized bytes, so key order and spacing
    // count too. A semantic match with a byte mismatch is still a rerun.
    if (lines.length === 0) lines.push('the recorded content is equivalent but not identical');
    process.stderr.write(
      `${MACRO_HASHES_NAME} does not match the published tarballs:\n`
      + `${lines.map((line) => `  ${line}\n`).join('')}`
      + 'rerun `npm run macro-hashes` and commit the result\n',
    );
    process.exitCode = 1;
  }
} else {
  await writeFile(manifestFile, serialized, 'utf8');
  process.stdout.write(`wrote ${manifestFile}\n`);
}
