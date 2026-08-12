import assert from 'node:assert/strict';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { OFFERED_PALETTES } from '../../lib/annotate/palette.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
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

// Never part of the npm package: dependency, VCS, and gitignored scratch dirs.
const unpackagedDirectories = new Set(['node_modules', '.git', '.superpowers', '.worktrees']);

async function packagedTextFiles(directory, relative = '') {
  const files = [];
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'tests' || unpackagedDirectories.has(entry.name)) continue;
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

test('macro index exposes only the portable built-in macros', async () => {
  const text = await readFile(path.join(pluginRoot, 'skills/browser-macros/MACROS.md'), 'utf8');

  assert.equal((text.match(/^## /gm) || []).length, 4);
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
  assert.match(text, /^## flow-runner$/m);
  // The replay contract: this is the one place an agent will look to learn
  // both invocation shapes and both return shapes without reading the macro
  // source.
  assert.match(text, /flow: <artifact object>, args: \{ <argName>: <string>/);
  assert.match(text, /ok:\s+true, result: \{ <extract keys> \} \| \{ completed: true \}/);
  // Fix round 1, controller ruling: a returned failure object is a
  // successful tool call, so failure has to fail the CALL -- pin both the
  // stated reasoning and the exact thrown-error contract an agent parses.
  assert.match(text, /tool call itself errors rather than returning a value/);
  assert.match(text, /`FLOW_RUNNER_FAILURE: `/);
  assert.match(
    text,
    /failedStep: <step index or 'args'>, error, url, stepsCompleted,\s+locatorFallbacks, quirkAttempted\?, candidates\? \}`;\s+parse that shape back\s+out of the\s+error\s+text/,
  );
  // WS3a Task 2: `candidates` is additive, optional, present ONLY on a
  // locator-miss step failure, and always the last key -- the index has to
  // say all four or a caller reading only this doc would assume it is
  // always present, or present on failures it never appears on.
  assert.match(text, /present ONLY when the failed step is a\s+locator-miss/);
  assert.match(text, /always the LAST key in the payload/);
  assert.match(text, /capped at 12 entries/);
  assert.match(text, /clamped to 80 characters/);
  assert.match(text, /the payload silently\s+degrades to the pre-Task-2 shape/);
  // WS3a Task 3: `quirks` (Params) and rung 3's own failure field --
  // `quirkAttempted` -- must both be documented, plus the consent basis a
  // reader has to see before trusting the runner clicks anything at all.
  assert.match(text, /quirks\?: \[\{ name, urlPattern, target: \{ locators \}, action \}\]/);
  assert.match(text, /disables rung 3\s+above entirely/);
  assert.match(text, /At most one quirk is\s+attempted per step/);
  assert.match(text, /its own click is never attempted a second time/);
  assert.match(text, /human already performed the same\s+click once by hand/);
  assert.match(text, /consent basis for repeating it automatically here/);
  assert.match(text, /present ONLY\s+when a quirk was actually clicked/);
  assert.match(text, /`quirkAttempted`\s+\(when present\) immediately before it/);
  assert.match(text, /~\/\.fast-browser\/macros\/flow-runner\.js/);
  assert.equal((text.match(/Status: built-in/g) || []).length, 4);

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

// The delegated result is the only artifact that survives the subagent; the
// page state dies with its context, so a distilled answer that dropped
// something load-bearing is undetectable by construction. The contract makes
// every claim carry its own evidence (selector, verbatim value, URL) and
// every gap announce itself in a miss list, the same shape capture-annotated
// uses for missed. Pinned in BOTH host variants: whether a delegated result
// is auditable must not depend on which host ran it.
test('the browser-driver return contract makes distilled results checkable', async () => {
  const claude = await readFile(path.join(pluginRoot, 'agents/browser-driver.md'), 'utf8');
  const codex = await readFile(
    path.join(pluginRoot, 'templates/codex/browser_driver.toml'),
    'utf8',
  );

  // \s+ between every word: the markdown variant wraps these phrases at
  // different columns than the TOML one, and the assertion is about the words
  // sitting together, not about where prose happens to break.
  const phrase = (words) => new RegExp(words.split(' ').join('\\s+'));
  for (const [host, text] of [['claude', claude], ['codex', codex]]) {
    assert.match(text, phrase('the selector \\(or macro and key\\)'), host);
    assert.match(text, phrase('verbatim as the page showed it'), host);
    assert.match(text, phrase('at the moment of the read'), host);
    assert.match(text, phrase('miss list with a reason'), host);
    assert.match(text, phrase('never silently omit'), host);
  }

  // The callers' side: routing guidance names when NOT to delegate, since a
  // spawn that costs more than the snapshot it avoids and an audit that
  // cannot survive distillation are both worse than doing the work directly.
  const claudeRouting = await readFile(
    path.join(pluginRoot, 'templates/routing/claude/fast-browser-routing.md'),
    'utf8',
  );
  const codexRouting = await readFile(
    path.join(pluginRoot, 'templates/routing/codex/fast-browser.md'),
    'utf8',
  );
  for (const [host, text] of [['claude', claudeRouting], ['codex', codexRouting]]) {
    assert.match(text, phrase('costs more than the snapshot it avoids'), host);
    assert.match(text, /audit/, host);
  }
});

// The reconciliation between script-first automation and the flow compiler:
// `flows find` first still wins regardless of what runs next, but the
// compiler (lib/flows/compile.mjs) only turns discrete tool-call sessions
// into replayable steps -- a scripted `browser_run_code_unsafe` run compiles
// to a single opaque `js` step that can never become a runnable candidate on
// its own (the same "not replayable in v1" case the flows section above
// already names). Losing this subsection sends an agent back to scripting a
// repeatable journey it should instead be driving discretely so the next
// sweep can compile it.
test('fast-browsing reconciles script-first automation with flow compilation', async () => {
  const text = await readFile(path.join(pluginRoot, 'skills/fast-browsing/SKILL.md'), 'utf8');

  assert.match(text, /discrete tool calls/);
  assert.match(text, /opaque `js` step/);
  assert.match(text, /not replayable in v1/);
  assert.match(text, /flows compile/);
  // The rule ordering must survive the new subsection: `flows find` first,
  // unconditionally, is restated rather than only implied.
  assert.match(text, /`flows find` first stays the rule/);
});

// WS4a Task 9: the stats-surfacing sentence, pinned against the real
// command name/flag and the real `stats()` return shape
// (lib/commands/stats.mjs) rather than trusting the skill's own prose --
// same posture as the sites-affordances pin immediately below.
test('fast-browsing tells agents how to report flywheel health, pinned against the real stats command', async () => {
  const text = await readFile(path.join(pluginRoot, 'skills/fast-browsing/SKILL.md'), 'utf8');
  const parseArgsSource = await readFile(path.join(pluginRoot, 'lib/cli/parse-args.mjs'), 'utf8');
  const statsSource = await readFile(path.join(pluginRoot, 'lib/commands/stats.mjs'), 'utf8');

  assert.match(text, /fast-browser\s+stats --json/);
  assert.match(parseArgsSource, /'stats'/, 'expected "stats" registered as a real CLI command');

  const statsReturn = statsSource.match(/export async function stats\([\s\S]*?return \{([\s\S]*?)\};/);
  assert.ok(statsReturn, 'stats() return shape found in lib/commands/stats.mjs');
  const statsFields = [...statsReturn[1].matchAll(/^\s*(\w+)(?::|,)/gm)].map(([, name]) => name);
  assert.deepEqual(
    statsFields,
    ['command', 'replays', 'outcomes', 'healRate', 'cleanRate', 'quarantined', 'flowsHealed'],
  );
  for (const field of ['replays', 'outcomes', 'healRate', 'cleanRate', 'quarantined', 'flowsHealed']) {
    assert.match(text, new RegExp('`' + field + '`'), field);
  }
});

// The know-the-site section quotes `sites affordances`/`sites show` field
// names and command lines from memory; nothing gated them against CLI drift
// the way the flows-first section is pinned elsewhere in this file. Cross-
// checked against the real return shapes in lib/commands/sites.mjs (not
// against the skill's own internal consistency) so a renamed field breaks
// this test instead of silently drifting from what the skill tells agents to
// look for.
test('fast-browsing pins the sites affordances/show CLI shapes against the real command', async () => {
  const text = await readFile(path.join(pluginRoot, 'skills/fast-browsing/SKILL.md'), 'utf8');
  const sitesSource = await readFile(path.join(pluginRoot, 'lib/commands/sites.mjs'), 'utf8');

  assert.match(text, /fast-browser\s+sites affordances --url <url> --json/);
  assert.match(text, /fast-browser sites show <origin> --json/);

  const affordancesReturn = sitesSource.match(
    /async function affordances\([\s\S]*?return \{([\s\S]*?)\};/,
  );
  assert.ok(affordancesReturn, 'affordances() return shape found in lib/commands/sites.mjs');
  const affordancesFields = [...affordancesReturn[1].matchAll(/^\s*(\w+)(?::|,)/gm)]
    .map(([, name]) => name);
  assert.deepEqual(
    affordancesFields,
    ['command', 'sub', 'found', 'stale', 'savedAt', 'pattern', 'digest', 'inventory'],
  );
  for (const field of ['found', 'stale', 'inventory', 'digest']) {
    assert.match(text, new RegExp('`' + field + '`'), field);
  }

  const showReturn = sitesSource.match(/async function show\([\s\S]*?return \{([\s\S]*?)\};/);
  assert.ok(showReturn, 'show() return shape found in lib/commands/sites.mjs');
  assert.match(showReturn[1], /^\s*edges:/m);
  assert.match(text, /`edges`/);
});

// WS3a shipped the flows-first check, sites-affordances guidance, and quirk
// interrupt recovery in the Claude agent file only; the Codex template never
// caught up (MAT-150 item 2). Pinned in BOTH hosts, on the same load-bearing
// substrings, so a future edit to one host without the other regresses
// silently instead of failing here.
test('the codex template matches the Claude agent on flow-first, site-affordances, and quirk-recovery guidance', async () => {
  const claude = await readFile(path.join(pluginRoot, 'agents/browser-driver.md'), 'utf8');
  const codex = await readFile(
    path.join(pluginRoot, 'templates/codex/browser_driver.toml'),
    'utf8',
  );

  for (const [host, text] of [['claude', claude], ['codex', codex]]) {
    assert.match(text, /flows find --intent/, host);
    assert.match(text, /flows approve/, host);
    assert.match(text, /sites affordances --url/, host);
    assert.match(text, /sites quirk add/, host);
    // The WS3b Task 6 extension: quirk recovery also fires when a step
    // resolves cleanly but its click is blocked by an intercepting overlay,
    // not only when the locator walk missed outright.
    assert.match(text, /blocked by an intercepting overlay/, host);
  }
});

// WS4b Task 10: the registry exists now (push/pull/search over compiled
// flow artifacts), but sync with it is a HUMAN-invoked action -- `registry
// init`, `registry push`, and `registry pull` are commands Matt runs
// himself, never something an agent decides to run on its own (there is no
// autonomous-sync path anywhere in this codebase; see lib/commands/
// registry.mjs's own consent-surface comment). Losing this sentence risks
// an agent inferring it should push or pull flows unprompted the first time
// it notices the registry commands exist.
test('fast-browsing states registry sync is human-invoked, never run by an agent on its own', async () => {
  const text = await readFile(path.join(pluginRoot, 'skills/fast-browsing/SKILL.md'), 'utf8');

  assert.match(text, /registry init/);
  assert.match(text, /registry push/);
  assert.match(text, /registry pull/);
  assert.match(text, /human-invoked/);
  assert.match(text, /never\s+push or pull\s+on\s+(?:its|your) own/);
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

// MAT-237: the distill fast path closes the flywheel loop in the same
// conversation. Its load-bearing mechanical fact -- a live session never
// compiles, and `browser_close` finalizes the current recording without
// ending the MCP session (verified against the pinned runtime's trace
// lifecycle; the next tool call starts a fresh recording) -- lives only in
// the runtime, so the skill text is the sole place an agent learns it.
// The compile-report diagnostic field is cross-checked against the real
// sweep source (lib/flows/sweep.mjs), not the docs' own consistency.
test('fast-browsing distills the just-performed session with a same-conversation fast path', async () => {
  const text = await readFile(path.join(pluginRoot, 'skills/fast-browsing/SKILL.md'), 'utf8');
  const sweepSource = await readFile(path.join(pluginRoot, 'lib/flows/sweep.mjs'), 'utf8');

  // The trigger floor and the mechanics, in order: close, compile, find,
  // offer.
  assert.match(text, /3 or more discrete\s+tool calls/);
  assert.match(text, /`browser_close`/);
  assert.match(text, /fast-browser flows compile --json/);
  assert.match(text, /flows find --intent "<the task>" --origin <origin>\s+--json/);
  assert.match(text, /live session never compiles/);
  assert.match(text, /without ending your MCP session/);
  // The approval boundary reuses mine-macros semantics on the flows CLI:
  // the human runs approve, the agent never does, and reject records an
  // explicit decline only.
  assert.match(text, /fast-browser flows approve <name>/);
  assert.match(text, /never run it yourself, in any form/);
  assert.match(text, /delegation to the task is not approval of the flow/);
  assert.match(text, /fast-browser flows reject <name>/);
  // The nothing-compiled diagnostic reads a real field of the real sweep
  // report.
  assert.match(text, /`skippedBySession`/);
  assert.match(sweepSource, /skippedBySession/);
  // Parameterization stays compiler-owned; the flows section's never-edit
  // rule holds on this path too.
  assert.match(text, /never hand-edit the artifact/);
});

// The subagent variant of the same fast path: browser-driver has no user in
// its loop, so the offer must ride back inside the distilled result as a
// flowProposal block for the caller to relay -- and the approve boundary
// must be restated where the subagent reads, since a delegated task is the
// exact "broad delegation is not approval" situation mine-macros warns
// about.
test('the browser-driver returns a flowProposal instead of asking a user it does not have', async () => {
  const text = await readFile(path.join(pluginRoot, 'agents/browser-driver.md'), 'utf8');

  assert.match(text, /3 or more discrete\s+tool calls/);
  assert.match(text, /`browser_close`/);
  assert.match(text, /fast-browser flows compile --json/);
  assert.match(text, /`flowProposal` block/);
  assert.match(text, /fast-browser flows approve <name>/);
  assert.match(text, /never run `flows approve` yourself/);
  assert.match(text, /never treat the delegation as approval/);
  assert.match(text, /flowProposal: none/);
  assert.match(text, /skippedBySession/);
});

// The delineation must hold from both sides: mine-macros stays the batch
// path (2+ session evidence, conversational per-macro approval, macros
// family) and names the flows fast path rather than absorbing it; the fast
// path never imports the occurrence threshold, since a single session
// distills.
test('mine-macros delineates the batch path from the flows fast path', async () => {
  const mineMacros = await readFile(path.join(pluginRoot, 'skills/mine-macros/SKILL.md'), 'utf8');
  const fastBrowsing = await readFile(path.join(pluginRoot, 'skills/fast-browsing/SKILL.md'), 'utf8');

  assert.match(mineMacros, /batch path/);
  assert.match(mineMacros, /flow distillation/);
  assert.match(mineMacros, /fast-browser flows compile/);
  assert.match(mineMacros, /fast-browser flows approve/);
  assert.match(mineMacros, /at least two sessions/);
  assert.match(mineMacros, /2\+ session rule never migrates onto the flows path/);
  assert.match(mineMacros, /never installs a macro/);
  assert.match(fastBrowsing, /Distill the session after an ad hoc solve/);
  assert.doesNotMatch(fastBrowsing, /two sessions|2\+/);
});

// The approve literal is pinned against the CLI's own `expected` value rather
// than against the skill's internal consistency: a skill that told a human to
// type the wrong word would fail every approval while looking correct.
test('the reviewing-flows skill pins its buckets, its safety contract, and the real approve literal', async () => {
  const text = await readFile(
    path.join(pluginRoot, 'skills/reviewing-flows/SKILL.md'),
    'utf8',
  );
  const command = await readFile(
    path.join(pluginRoot, 'lib/commands/flows.mjs'),
    'utf8',
  );

  // The literal the human must type, taken from the command that demands it.
  assert.match(command, /expected: 'APPROVE'/);
  assert.match(text, /type APPROVE/i);

  // The safety contract, which is the whole reason this skill is allowed to
  // act on its own. Each of these is a claim a reviewer should be able to
  // check against behavior.
  assert.match(text, /may reject/i);
  assert.match(text, /never approve/i);
  assert.match(text, /less runnable/);
  assert.match(text, /needs a TTY this skill does not have/);

  // The four buckets, first match wins.
  assert.match(text, /unapprovable/);
  assert.match(text, /dead-origin/);
  assert.match(text, /superseded/);
  assert.match(text, /reviewable/);
  assert.match(text, /first match wins/i);

  // Only the content fact earns autonomous rejection. Both of these open a
  // sentence in the skill, so they are matched case-insensitively.
  assert.match(text, /only `unapprovable` is rejected automatically/i);
  assert.match(text, /propose, never act/i);

  // Corrupt artifacts are reported, never rejected.
  assert.match(text, /unparseable means unjudgeable/i);

  // Cleaning is auditable, which is what makes a large batch reasonable to
  // accept, and a name collision names the colliding flow.
  assert.match(text, /rejected ledger/);
  assert.match(text, /which name collided/);

  // The data sources, including the fact that `list` does not carry steps.
  assert.match(text, /flows list --json/);
  assert.match(text, /~\/\.fast-browser\/flows-pending\//);
  assert.match(text, /does not carry steps/);

  // Drift: a heal rewrites approved content with no gate.
  assert.match(text, /lastHealed/);
  assert.match(text, /without re-entering the gate/);

  // The skill must never automate the prompt.
  assert.doesNotMatch(text, /echo APPROVE/);
});

// FB-23: Every skill must declare itself to the Codex host via agents/openai.yaml.
// This is the guard that makes a missing parity file impossible for any future skill.
test('every skill ships a Codex parity file with a populated interface', async () => {
  const skillsDir = path.join(pluginRoot, 'skills');
  const names = (await readdir(skillsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  assert.ok(names.includes('reviewing-flows'), 'reviewing-flows is missing');

  for (const name of names) {
    const parity = await readFile(
      path.join(skillsDir, name, 'agents/openai.yaml'),
      'utf8',
    );
    // A skill whose parity file exists but is blank is invisible to the Codex
    // host in exactly the same way a missing one is.
    assert.match(parity, /^interface:/m, `${name}: no interface block`);
    assert.match(parity, /display_name: "[^"]+"/, `${name}: no display_name`);
    assert.match(parity, /short_description: "[^"]+"/, `${name}: no short_description`);
    assert.match(parity, /default_prompt: "[^"]+"/, `${name}: no default_prompt`);
  }
});
