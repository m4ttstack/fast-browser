import assert from 'node:assert/strict';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { OFFERED_PALETTES } from '../../lib/annotate/palette.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repositoryRoot = path.resolve(pluginRoot, '../..');
const skillNames = [
  'fast-browsing',
  'browser-macros',
  'mine-macros',
  'annotating-screenshots',
  'capturing-flows',
];

const deployTextExtensions = new Set([
  '.json',
  '.js',
  '.md',
  '.mjs',
  '.toml',
  '.yaml',
  '.yml',
]);

async function packagedTextFiles(directory, relative = '') {
  const files = [];
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'tests') continue;
      files.push(...await packagedTextFiles(directory, child));
    } else if (entry.isFile() && deployTextExtensions.has(path.extname(entry.name))) {
      files.push(child);
    }
  }
  return files.sort();
}

test('packages portable skill and macro files without host-specific remnants', async () => {
  const packagedFiles = await packagedTextFiles(pluginRoot);
  assert.ok(packagedFiles.includes('package.json'));
  assert.ok(packagedFiles.includes('templates/codex/browser_driver.toml'));
  assert.ok(packagedFiles.includes('lib/macros/install.mjs'));
  assert.equal(packagedFiles.some((file) => file.startsWith('tests/')), false);

  for (const relativeFile of packagedFiles) {
    const text = await readFile(path.join(pluginRoot, relativeFile), 'utf8');

    assert.doesNotMatch(
      text,
      /\/Users\/matt|~\/\.claude|~\/\.codex|~\/\.playwright-mcp/,
      relativeFile,
    );
    assert.doesNotMatch(text, /order-wizard|pw-bench/, relativeFile);
  }
});

test('skill frontmatter contains only portable discovery fields', async () => {
  for (const name of skillNames) {
    const skillFile = path.join(pluginRoot, 'skills', name, 'SKILL.md');
    const text = await readFile(skillFile, 'utf8');
    const match = text.match(/^---\n([\s\S]*?)\n---\n/);

    assert.ok(match, `${name} has YAML frontmatter`);
    const fields = match[1]
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(0, line.indexOf(':')));

    assert.deepEqual(fields, ['name', 'description'], `${name} frontmatter fields`);
    assert.match(match[1], new RegExp(`^name: ${name}$`, 'm'));
    assert.match(match[1], /^description: Use when\b.+$/m);
  }
});

test('old skill locations are repository-relative transition links to real packaged files', async () => {
  for (const name of skillNames) {
    const oldDirectory = path.join(repositoryRoot, 'skills', 'browser', name);
    const packagedDirectory = path.join(pluginRoot, 'skills', name);

    assert.equal((await lstat(oldDirectory)).isSymbolicLink(), true, name);
    const target = await readlink(oldDirectory);
    assert.equal(path.isAbsolute(target), false, `${name} link is relative`);
    assert.equal(
      path.resolve(path.dirname(oldDirectory), target),
      packagedDirectory,
      `${name} link target`,
    );
    assert.equal((await lstat(packagedDirectory)).isSymbolicLink(), false, name);
    assert.equal((await lstat(path.join(packagedDirectory, 'SKILL.md'))).isFile(), true, name);
  }
});

test('macro index exposes only the portable built-in macros', async () => {
  const text = await readFile(path.join(pluginRoot, 'skills/browser-macros/MACROS.md'), 'utf8');

  assert.equal((text.match(/^## /gm) || []).length, 3);
  assert.match(text, /^## page-recon$/m);
  assert.match(text, /maxLinks\?: number \(default 10\)/);
  assert.match(text, /~\/\.fast-browser\/macros\/page-recon\.js/);
  assert.match(text, /^## page-affordances$/m);
  assert.match(text, /~\/\.fast-browser\/macros\/page-affordances\.js/);
  // The two properties that make this macro worth reaching for instead of
  // browser_snapshot, and the one that makes its output trustworthy. An entry
  // that drops either sends an agent back to the expensive path or, worse,
  // lets it read the digest as the whole page.
  assert.match(text, /maxFields\?: number \(default 30\)/);
  assert.match(text, /Auto-generated ids .+ are never\s+emitted/);
  assert.match(text, /counted in `skipped`/);
  assert.match(text, /^## capture-annotated$/m);
  assert.match(text, /targets: Record<string, string>, out\?: string \(default "capture"\)/);
  // `home` is required, not optional: the macro cannot read the caller's home
  // directory itself, so an index entry that omits it documents a call that
  // fails on its first argument check. Pinned separately from the `targets`
  // substring above, which a docs edit dropping `home` would still satisfy.
  assert.match(text, /home: string \(your absolute home directory path\)/);
  // The space measurement is what lets a label be placed from measured
  // numbers when no addressable element exists near it; an index entry that
  // drops it sends agents back to hunting for spacer elements.
  assert.match(text, /space\?: boolean \(default true/);
  assert.match(text, /up to four measured empty bands/);
  // The emptiness judgment has blind spots the geometric scan cannot see,
  // and the index has to state them: a reviewed MAT-112 build shipped a rule
  // whose misses were documented nowhere while the docs asserted proof,
  // which is exactly the confident wrongness the feature exists to avoid.
  assert.match(text, /judged by geometry, not hit-testing/);
  assert.match(text, /stated blind spots/);
  assert.match(text, /measured evidence, not a substitute for reviewing/);
  assert.match(text, /~\/\.fast-browser\/macros\/capture-annotated\.js/);
  assert.equal((text.match(/Status: built-in/g) || []).length, 3);

  // The Script paths above are written with `~`, which the runtime does not
  // expand: a bare or tilde filename resolves against the browser server's
  // own cwd and is then refused by its allowed-roots check. The index has to
  // say so itself, because it is the first (sometimes only) document an agent
  // reads before calling a macro; the annotation skill learned this live and
  // page-recon kept documenting the broken form for two more releases.
  assert.match(text, /written out in full/);
  assert.match(text, /outside allowed roots/);
});

// Each assertion here pins one instruction that a baseline run without the
// skill got wrong. Agents already measure rather than eyeball the PNG, so the
// failures worth guarding are provenance ones: a PNG and a measurement taken
// from different page loads, a hand-authored `measured` block that satisfies
// the base-image check by lying to it, and geometry the agent could only find
// by reading lib/annotate/svg.mjs. Losing any of these lines is a silent
// regression to boxes that look right and are not.
test('the annotation skill states the rules the baseline runs violated', async () => {
  const text = await readFile(
    path.join(pluginRoot, 'skills/annotating-screenshots/SKILL.md'),
    'utf8',
  );

  // Atomicity: one macro call is the source of both the PNG and the boxes.
  assert.match(text, /capture-annotated\.js/);
  // Step 1 does not run at all with a bare `filename`. Live evidence: the
  // runtime resolves a relative filename against the Playwright server
  // process's own working directory, not the macros directory, and then
  // enforces containment against its allowed roots, so a bare name yields
  // `ENOENT` or an "outside allowed roots" refusal. The installed path has to
  // be written out in full, and the failure table has to name that refusal,
  // or the first instruction in the pipeline is one an agent cannot execute.
  assert.doesNotMatch(text, /filename: 'capture-annotated\.js'/);
  assert.match(text, /~\/\.fast-browser\/macros\/capture-annotated\.js/);
  assert.match(text, /outside the allowed roots/);
  assert.match(text, /same return value of the same call/);
  assert.match(text, /Annotate a PNG captured by an earlier call/);
  assert.match(text, /Measure with your own `boundingBox\(\)`/);
  // The macro was absent in one baseline environment and went uninstalled.
  assert.match(text, /fast-browser setup/);

  // Corroboration must be copied, never authored. `\s+` rather than an
  // explicit newline: the assertion is about the two field names sitting
  // beside "verbatim", not about where the prose happens to wrap.
  assert.match(text, /Copy `schemaVersion` and\s+`viewport` verbatim/);

  // A missed key never becomes an annotation, and never resolves by first hit.
  assert.match(text, /Never take the first of N matches/);
  assert.match(text, /has not been redacted/);

  // Chip geometry, and the fact that `annotate` cannot catch a clipped label.
  assert.match(text, /`chip\.xy` is its \*\*top left\*\* corner/);
  assert.match(text, /bounds-checks only the anchor point/);

  // Every annotation point needs a measured source, not just the box-bearing
  // ones. Without this a label is the one coordinate an agent may eyeball,
  // which is the discipline the rest of the skill exists to buy. Labels
  // anchor inside the macro's measured `space` bands, and when no band came
  // back the fallback is the target's own padded corner, stated plainly --
  // never a spot judged clear by looking at the PNG.
  assert.match(text, /up to four verified-empty bands/);
  assert.match(
    text,
    /`chip\.xy`, `counter\.xy` and `arrow\.tail` anchor inside a band from the\s+macro's `space` map/,
  );
  assert.match(text, /anchor at the target's own padded\s+box corner/);
  assert.match(text, /Eyeballing empty space on a live capture remains forbidden/);
  assert.match(text, /Nothing was read off the image/);

  // The three anchored primitives are not anchored alike, so one shared
  // centring formula cannot serve them. `chip.xy` is a top left, but
  // `counter.xy` is the circle's centre (lib/annotate/svg.mjs), so the chip
  // formula offsets every counter up and left by its radius, about 16 px at
  // the default size. A skill that turns perfect measurements into
  // systematically wrong placement defeats the premise of the whole feature,
  // so the counter's own derivation is pinned.
  assert.match(text, /`xy = \[x \+ w \/ 2, y \+ h \/ 2\]`/);

  // Padding and blur strength were improvised in every baseline sample. The
  // rounding and the clamp are part of the instruction: "half the box height"
  // alone still leaves the strength to taste.
  assert.match(text, /Pad every measured box by 6 px/);
  assert.match(
    text,
    /`blur\.amount` is half the box height rounded up,\s+clamped to 8 through 40/,
  );
  // The clamp bound is ambiguous unless sourced: the two reported widths
  // differ whenever the page has a classic scrollbar, and clamping to the
  // larger one yields boxes `annotate` rejects as outside the image.
  assert.match(text, /`min\(inner, client\)`/);
  // An ellipse is the one primitive a resolved box does not drop straight
  // into, so the conversion has to be stated or it gets improvised.
  assert.match(text, /`rx = w \/ 2 \+ 6`/);

  // Spec requirements: composition, palette, approval prompt, purge.
  assert.match(text, /Never blur the value the screenshot exists to prove/);
  // "Evidence", never "proof": the emptiness scan is geometric and strong,
  // but it has blind spots (closed shadow roots, border/shadow/colour-only
  // decoration) the skill must name rather than paper over, and the output
  // review in step 4 is the backstop for exactly those.
  assert.match(text, /only measured evidence a spot is\s+empty/);
  assert.match(text, /stated blind spots/);
  assert.match(text, /read the output PNG before reporting/);
  // Compare the whole offered list, not each name in isolation: a per-name
  // check passes just as happily when the skill keeps a palette that
  // OFFERED_PALETTES has dropped, so the drift guard has to run both ways.
  const offer = text.match(/Offer these ten[\s\S]*?```bash/);
  assert.ok(offer, 'the skill offers the palettes');
  assert.deepEqual(
    [...offer[0].matchAll(/`([a-z]+)`/g)].map(([, name]) => name),
    [...OFFERED_PALETTES],
  );
  assert.match(text, /configure --palette/);
  assert.match(text, /it is not a failure/);
  assert.match(text, /uninstall --purge-data/);
});

// Each assertion pins one instruction an agent would otherwise get wrong from
// first principles: what recording covers (the relay-attached tabs Fast
// Browser drives, nothing beyond them), that a webm is only complete once its
// tab or session closes cleanly, and that a recording has no redaction pass,
// so PII forces a re-record or a fall back to annotated stills. Losing any of
// these lines ships confident, wrong motion evidence.
test('the capturing-flows skill states recording scope, finalization, and the PII rule', async () => {
  const text = await readFile(
    path.join(pluginRoot, 'skills/capturing-flows/SKILL.md'),
    'utf8',
  );

  assert.match(text, /configure --video/);
  assert.match(text, /--video off/);
  // The scope, stated to match the fast-browsing boundaries: recording covers
  // the relay-attached real-Chrome tabs Fast Browser controls, and promises
  // no other browser to record in.
  assert.match(text, /extension relay/);
  assert.match(text, /tabs Fast Browser controls/);
  assert.match(text, /no separate isolated browser/);
  assert.doesNotMatch(text, /managed session/);
  // One flow per tab, finalized by closing, collected from the ledgerless
  // videos directory, converted by the real CLI.
  assert.match(text, /one flow per tab/i);
  assert.match(text, /when the tab or the session closes/);
  assert.match(text, /~\/\.fast-browser\/videos\//);
  assert.match(text, /fast-browser gif/);
  assert.match(text, /brew install ffmpeg/);
  // The PII rule: no blur pass exists for motion, so the choices are a
  // cleaner re-record or annotated stills, said plainly.
  assert.match(text, /cannot carry `annotate`'s redactions/);
  assert.match(text, /re-record a cleaner flow/);
  assert.match(text, /annotated stills/);
  assert.match(text, /never deliver motion evidence\s+containing PII/);
});

// The invocation form is pinned against what the runtime actually accepts,
// not against the docs' own internal consistency: the runtime resolves a
// relative filename against its own cwd and refuses paths outside its allowed
// roots (established live, see tests/e2e/annotate.test.mjs's file-level
// comment), so the skill must demand the absolute written-out path and name
// the refusal an agent will see if it forgets.
test('browser-macros documents the invocation form the runtime accepts', async () => {
  const text = await readFile(
    path.join(pluginRoot, 'skills/browser-macros/SKILL.md'),
    'utf8',
  );

  assert.match(text, /absolute path, your home directory written out in full/);
  assert.match(text, /outside allowed roots/);
  assert.doesNotMatch(text, /with the entry's `filename` and `args`\s+exactly/);
});

test('skills and delegated browser guidance use authoritative live ledgers', async () => {
  const browserMacros = await readFile(
    path.join(pluginRoot, 'skills/browser-macros/SKILL.md'),
    'utf8',
  );
  const mineMacros = await readFile(path.join(pluginRoot, 'skills/mine-macros/SKILL.md'), 'utf8');
  const guidanceFiles = [
    'agents/browser-driver.md',
    'templates/codex/browser_driver.toml',
    'skills/fast-browsing/SKILL.md',
    'skills/browser-macros/SKILL.md',
    'skills/mine-macros/SKILL.md',
  ];

  for (const relativeFile of guidanceFiles) {
    assert.match(
      await readFile(path.join(pluginRoot, relativeFile), 'utf8'),
      /~\/\.fast-browser\/macros\/MACROS\.md/,
      relativeFile,
    );
  }
  assert.doesNotMatch(browserMacros, /\[MACROS\.md\]\(MACROS\.md\)/);
  assert.match(mineMacros, /~\/\.fast-browser\/macro-failures\.md/);
  assert.match(mineMacros, /~\/\.fast-browser\/rejected-macros\.md/);
  assert.doesNotMatch(mineMacros, /\[rejected\.md\]\(rejected\.md\)/);
});
