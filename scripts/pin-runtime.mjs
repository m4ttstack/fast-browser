#!/usr/bin/env node
// Re-pin the plugin to a published Fast Browser runtime release.
//
//   node scripts/pin-runtime.mjs --runtime 0.1.0-alpha.9 --plugin 0.1.0-alpha.10
//
// The version of a release is written in eight places across this repo, and a
// pin that updates seven of them fails a release gate rather than shipping.
// Doing that by hand takes several rounds of "run the suite, find the next
// missed file", so this derives every one of them from the release manifest
// instead, and refuses to write anything if the published bytes do not hash to
// what that manifest claims.
//
// Add --dry-run to print the plan without touching the working tree.

import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const RELEASE_REPO = 'm4ttheweric/playwright';

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--runtime') args.runtime = argv[++i];
    else if (argv[i] === '--plugin') args.plugin = argv[++i];
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!args.runtime) throw new Error('--runtime <version> is required (the runtime release to pin)');
  if (!args.plugin) throw new Error('--plugin <version> is required (this plugin\'s next version)');
  return args;
}

// Not every file carries every value (only the notices name the release
// manifest, for instance), so a pair that finds no match is fine. What is not
// fine is a *stale* value surviving, which is the failure this script exists to
// prevent, so each file is checked afterwards for anything left over from the
// previous pin. `stale` is asserted, `pairs` are opportunistic.
async function rewrite(relative, pairs, stale) {
  const file = path.join(repoRoot, relative);
  const before = await readFile(file, 'utf8');
  let text = before;
  for (const [from, to] of pairs)
    text = text.replaceAll(from, to);
  if (text === before)
    throw new Error(`${relative}: nothing to rewrite, is it already pinned?`);
  const leftover = stale.filter(value => text.includes(value));
  if (leftover.length)
    throw new Error(`${relative}: stale after rewrite: ${leftover.join(', ')}`);
  return { file, relative, text };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tag = `fast-browser-v${args.runtime}`;
  const base = `https://github.com/${RELEASE_REPO}/releases/download/${tag}`;
  const work = await mkdtemp(path.join(tmpdir(), 'pin-runtime-'));

  try {
    console.log(`==> downloading ${tag}`);
    await execFile('gh', ['release', 'download', tag, '--repo', RELEASE_REPO, '--dir', work, '--clobber']);

    const manifest = JSON.parse(await readFile(path.join(work, `fast-browser-release-${args.runtime}.json`), 'utf8'));

    console.log('==> verifying published bytes against the release manifest');
    for (const role of ['runtime', 'extension']) {
      const entry = manifest[role];
      const digest = createHash('sha256').update(await readFile(path.join(work, entry.file))).digest('hex');
      if (digest !== entry.sha256)
        throw new Error(`${role}: manifest claims ${entry.sha256}, published bytes hash to ${digest}`);
      console.log(`    ${role}: ${entry.file} ok`);
    }

    const old = JSON.parse(await readFile(path.join(repoRoot, 'runtime-lock.json'), 'utf8'));
    const lock = {
      ...old,
      productVersion: manifest.productVersion,
      sourceCommit: manifest.sourceCommit,
      protocolVersion: manifest.protocolVersion,
      runtime: { ...old.runtime, ...manifest.runtime, url: `${base}/${manifest.runtime.file}` },
      extension: { ...old.extension, ...manifest.extension, url: `${base}/${manifest.extension.file}` },
    };

    // Every downstream edit is expressed as old-value -> new-value taken from
    // the two locks, so nothing here needs to know the shape of the files it
    // touches beyond the values themselves.
    const v = { from: old.productVersion, to: lock.productVersion };
    const artifacts = [
      [old.runtime.file, lock.runtime.file],
      [old.extension.file, lock.extension.file],
      [`fast-browser-release-${v.from}.json`, `fast-browser-release-${v.to}.json`],
      [`fast-browser-v${v.from}`, `fast-browser-v${v.to}`],
      [old.runtime.sha256, lock.runtime.sha256],
      [old.extension.sha256, lock.extension.sha256],
      [old.sourceCommit, lock.sourceCommit],
    ];

    // Anything below that still mentions the previous release after rewriting
    // means a value was missed -- unless the new release carries that exact
    // value forward on purpose. A release that changes nothing in
    // packages/extension re-ships a byte-identical archive, so the extension
    // sha256 is the same string before and after and finding it afterwards
    // proves nothing was missed. Only values the pin actually changes can go
    // stale, so only those are asserted on.
    const carriedForward = new Set([lock.sourceCommit, lock.runtime.sha256, lock.extension.sha256,
      lock.runtime.file, lock.extension.file, `fast-browser-v${v.to}`]);
    const stale = [old.sourceCommit, old.runtime.sha256, old.extension.sha256,
      old.runtime.file, old.extension.file, `fast-browser-v${v.from}`]
        .filter(value => !carriedForward.has(value));

    const edits = [
      await rewrite('THIRD_PARTY_NOTICES.md',
        [...artifacts, [`version \`${old.extension.version}\``, `version \`${lock.extension.version}\``]], stale),
      await rewrite('tests/unit/runtime-lock.test.mjs',
        [...artifacts, [`productVersion: '${v.from}'`, `productVersion: '${v.to}'`],
          [`version: '${old.extension.version}'`, `version: '${lock.extension.version}'`]], stale),
    ];

    const pluginFrom = await currentPluginVersion();
    if (pluginFrom === args.plugin)
      throw new Error(`--plugin ${args.plugin} is already this repo's version`);
    for (const relative of ['package.json', 'package-lock.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json', '.claude-plugin/marketplace.json'])
      edits.push(await rewrite(relative, [[`"version": "${pluginFrom}"`, `"version": "${args.plugin}"`]], []));

    if (args.dryRun) {
      console.log('==> dry run, nothing written');
      console.log(`    runtime ${v.from} -> ${v.to}, extension ${old.extension.version} -> ${lock.extension.version}`);
      for (const edit of edits) console.log(`    would rewrite ${edit.relative}`);
      return;
    }

    await writeFile(path.join(repoRoot, 'runtime-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
    for (const edit of edits)
      await writeFile(edit.file, edit.text);

    console.log(`==> pinned runtime ${v.to}, extension ${lock.extension.version}, plugin ${args.plugin}`);
    console.log('==> run `npm test` to clear the release gates, then commit');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function currentPluginVersion() {
  return JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')).version;
}

main().catch(error => {
  console.error(`pin-runtime: ${error.message}`);
  process.exitCode = 1;
});
