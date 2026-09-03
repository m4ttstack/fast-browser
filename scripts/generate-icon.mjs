#!/usr/bin/env node
// Regenerate the app icon assets (PNG preview, .iconset, .icns) from
// assets/logo.svg, the single source of truth for the glyph.
//
//   node scripts/generate-icon.mjs
//
// Requires rsvg-convert (brew install librsvg) and macOS's iconutil.

import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const assetsDir = path.join(repoRoot, 'assets');
const svgPath = path.join(assetsDir, 'logo.svg');
const iconsetDir = path.join(assetsDir, 'icon.iconset');
const icnsPath = path.join(assetsDir, 'icon.icns');

// macOS iconset naming convention: base size plus an optional @2x variant
// rendered from double the pixel size.
const ICONSET_SIZES = [
  { name: 'icon_16x16.png', size: 16 },
  { name: 'icon_16x16@2x.png', size: 32 },
  { name: 'icon_32x32.png', size: 32 },
  { name: 'icon_32x32@2x.png', size: 64 },
  { name: 'icon_128x128.png', size: 128 },
  { name: 'icon_128x128@2x.png', size: 256 },
  { name: 'icon_256x256.png', size: 256 },
  { name: 'icon_256x256@2x.png', size: 512 },
  { name: 'icon_512x512.png', size: 512 },
  { name: 'icon_512x512@2x.png', size: 1024 },
];

async function renderPng(outPath, size) {
  await execFile('rsvg-convert', ['-w', String(size), '-h', String(size), '-o', outPath, svgPath]);
}

async function main() {
  await rm(iconsetDir, { recursive: true, force: true });
  await mkdir(iconsetDir, { recursive: true });

  for (const { name, size } of ICONSET_SIZES) {
    await renderPng(path.join(iconsetDir, name), size);
  }

  await execFile('iconutil', ['-c', 'icns', iconsetDir, '-o', icnsPath]);

  // README preview asset, referenced by an absolute GitHub raw URL.
  await renderPng(path.join(assetsDir, 'logo-128.png'), 128);

  console.log(`wrote ${path.relative(repoRoot, iconsetDir)}/ (${ICONSET_SIZES.length} sizes)`);
  console.log(`wrote ${path.relative(repoRoot, icnsPath)}`);
  console.log(`wrote ${path.relative(repoRoot, path.join(assetsDir, 'logo-128.png'))}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
