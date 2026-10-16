import assert from 'node:assert/strict';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { OFFERED_PALETTES } from '../../lib/annotate/palette.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function skillNamesFromDisk() {
  const entries = await readdir(path.join(pluginRoot, 'skills'), { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

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
const unpackagedDirectories = new Set([
  'node_modules', '.git', '.superpowers', '.worktrees', '.local-dev',
]);

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
  for (const name of await skillNamesFromDisk()) {
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
  assert.match(text, /~\/\.fast-browser\/output\/videos\//);
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
    ['command', 'sub', 'found', 'stale', 'savedAt', 'pattern', 'digest', 'inventory', 'quirks'],
  );
  for (const field of ['found', 'stale', 'inventory', 'digest', 'quirks']) {
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

// `flows find` writes `<REQUIRED: ...>` placeholders into the invocation's
// arg values and the runner types whatever string it gets, so a driver that
// replays the invocation unedited types the placeholder on the real site.
test('the browser-driver fills flow arg placeholders and checks macros before affordances, in both hosts', async () => {
  const claude = await readFile(path.join(pluginRoot, 'agents/browser-driver.md'), 'utf8');
  const codex = await readFile(
    path.join(pluginRoot, 'templates/codex/browser_driver.toml'),
    'utf8',
  );

  for (const [host, text] of [['claude', claude], ['codex', codex]]) {
    assert.doesNotMatch(
      text.replace(/verbatim\s+as\s+the\s+page\s+showed\s+it/g, ''),
      /verbatim/,
      host,
    );
    assert.match(text, /invocation\.arguments\.args\.args/, host);
    assert.match(text, /<REQUIRED: string>/, host);
    assert.match(text, /<OPTIONAL: string>/, host);
    assert.match(text, /`flows\s+find`\s+writes\s+a\s+placeholder/, host);
    assert.match(text, /never\s+guess\s+it\s+and\s+never\s+run\s+the\s+placeholder/, host);
    assert.match(text, /put\s+the\s+question\s+in\s+your\s+distilled\s+result/, host);
    assert.match(text, /Never\s+put\s+a\s+credential\s+in\s+an\s+arg/, host);
    assert.match(text, /contains js step: not replayable in v1/, host);
    assert.match(text, /When only[^.]*come back, never run one/, host);

    const find = text.indexOf('flows find --intent');
    const macros = text.indexOf('~/.fast-browser/macros/MACROS.md');
    const affordances = text.indexOf('sites affordances --url');
    assert.match(text, /have\s+not\s+yet\s+scouted\s+this\s+page/, host);
    assert.match(text, /by\s+its\s+`?filename`?\s+and\s+`?args`?\s+only\s+\(never\s+inline\s+code\)/, host);
    assert.ok(find !== -1 && macros !== -1 && affordances !== -1, host);
    assert.ok(find < macros, `${host}: flows find precedes MACROS.md`);
    assert.ok(macros < affordances, `${host}: MACROS.md precedes sites affordances`);
  }
});

// A click or submit can land before its step throws or the connection drops,
// so the step in flight counts as possibly mutated, and a resume that skips
// only "after the mutated one" can repeat a later completed mutation.
test('fast-browsing treats an in-flight mutating step as possibly landed and resumes only unfinished steps', async () => {
  const text = await readFile(path.join(pluginRoot, 'skills/fast-browsing/SKILL.md'), 'utf8');

  assert.match(text, /"A completed or failed flow step mutated\?"/);
  assert.doesNotMatch(text, /"A completed flow step mutated\?"/);
  assert.match(text, /flow\.steps\[failedStep\]`?\s+counts\s+too/);
  assert.match(text, /could\s+not\s+reach\s+the\s+flow's\s+origin`?\s+means\s+no\s+step\s+ran/);
  assert.match(text, /a\s+completed\s+or\s+in-flight\s+step\s+was\s+mutating/);
  assert.doesNotMatch(text, /steps\s+after\s+the\s+(mutated|landed)\s+one/);
  assert.doesNotMatch(text, /steps\s+after\s+the\s+mutation/);

  for (const gate of [
    '### Off-script gate: a flow step mutated before FLOW_RUNNER_FAILURE',
    '### Off-script gate: a mutating step landed before SIDECAR_LOST',
  ]) {
    const start = text.indexOf(gate);
    const end = text.indexOf('\n### ', start + gate.length);
    assert.ok(start !== -1 && end > start, gate);
    const section = text.slice(start, end);
    assert.match(section, /only\s+the\s+steps\s+the\s+flow\s+did\s+not\s+complete/, gate);
    assert.match(section, /never\s+a\s+completed\s+mutating\s+step/, gate);
    assert.match(section, /redo\s+a\s+completed\s+non-mutating\s+step/, gate);
  }
});

// Going on to macros after a flow step already mutated the site redoes the
// whole task, repeating that mutation (a second order, a second submit).
test('the browser-driver hands back when a failed flow already mutated the site, in both hosts', async () => {
  const claude = await readFile(path.join(pluginRoot, 'agents/browser-driver.md'), 'utf8');
  const codex = await readFile(
    path.join(pluginRoot, 'templates/codex/browser_driver.toml'),
    'utf8',
  );

  for (const [host, text] of [['claude', claude], ['codex', codex]]) {
    const start = text.search(/On a `?FLOW_RUNNER_FAILURE:?`? error/);
    const end = text.indexOf('SIDECAR_LOST', start);
    assert.ok(start !== -1 && end > start, host);
    const rule = text.slice(start, end);

    assert.match(rule, /never\s+retry\s+the\s+flow\s+and\s+never\s+hand-edit/, host);
    assert.match(rule, /Parse\s+the\s+JSON\s+payload\s+after\s+the\s+prefix/, host);
    assert.match(rule, /stepsCompleted/, host);
    assert.match(rule, /invocation\.arguments\.args\.flow\.steps/, host);
    assert.match(rule, /mutating`?\s+is\s+`?true/, host);
    assert.match(rule, /flow\.steps\[failedStep\]`?\s+counts\s+too/, host);
    assert.match(rule, /could\s+not\s+reach\s+the\s+flow's\s+origin`?\s+means\s+no\s+step\s+ran/, host);
    assert.match(rule, /only\s+the\s+steps\s+the\s+flow\s+did\s+not\s+complete/, host);
    assert.match(rule, /check\s+a\s+mutating\s+failed\s+step's\s+effect/, host);
    assert.match(rule, /do\s+not\s+go\s+on\s+to\s+macros/, host);
    assert.match(rule, /hand\s+back/, host);
    assert.match(rule, /finish\s+the\s+rest\s+by\s+hand/, host);
    assert.match(rule, /one\s+line\s+for\s+each\s+step\s+from\s+`?failedStep`?\s+on/, host);
    assert.match(rule, /never\s+repeat\s+a\s+completed\s+mutating\s+step/, host);
    assert.doesNotMatch(rule, /steps\s+after\s+the\s+mutat/, host);
    assert.match(rule, /redo\s+the\s+whole\s+task\s+from\s+MACROS\.md/, host);
    assert.match(rule, /hold\s+with\s+nothing\s+moved/, host);
    assert.match(text, /after\s+a\s+`?FLOW_RUNNER_FAILURE:?`?\s+whose\s+completed\s+steps\s+and\s+failed\s+step\s+mutated\s+nothing/, host);
    assert.match(text, /may\s+have\s+mutated\s+the\s+site\s+before\s+it\s+failed,\s+skip\s+`?flows\s+find`?/, host);
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

// A session holds its tab group in the user's Chrome until it closes, and
// before this rule only the distill path closed one. The runtime's
// 30-minute idle release is the backstop; every task-ending surface must
// still say to close when finished, and say why, or groups pile up.
test('every task-ending surface closes the browser when finished with it', async () => {
  for (const file of [
    'skills/fast-browsing/SKILL.md',
    'agents/browser-driver.md',
    'templates/codex/browser_driver.toml',
  ]) {
    const text = await readFile(path.join(pluginRoot, file), 'utf8');
    assert.match(text, /finished with the browser/, file);
    assert.match(text, /browser_close/, file);
    assert.match(text, /tab group/, file);
    assert.match(text, /30 minutes/, file);
    assert.match(text, /leave (?:the page|it) open/i, file);
    assert.match(text, /asked to see the page|verify again after the next edit|brief says to leave the page open/, file);
  }
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

  // `reject` is a real subcommand, not a skill invention.
  assert.match(command, /SUBCOMMANDS = new Set\(\[[^\]]*'reject'[^\]]*\]\)/);

  // A js step is identified by `op === 'js'`, pinned against the artifact
  // module's own step-op classification.
  const artifact = await readFile(
    path.join(pluginRoot, 'lib/flows/artifact.mjs'),
    'utf8',
  );
  assert.match(artifact, /op === 'js'/);

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

  // The superseded rule has two failure modes that were found by running it
  // against a real 50-flow queue, and both are pinned here so a later
  // simplification cannot quietly reintroduce them.
  //
  // 1. A family of byte-identical recordings: every member covers every
  //    other, so without a keeper tiebreak all of them bucket as superseded
  //    and NONE survives. Observed live on four identical `toggle-todo`
  //    recordings, which the rule proposed deleting in full.
  // 2. Two recordings of the same journey under unrelated names: `selenium`
  //    is a strict prefix of `submit` on the same origin, and a rule scoped
  //    to a shared name family misses it entirely.
  //
  // Hence: the rule keys on origin, explicitly NOT on the name, and states a
  // tiebreak that guarantees exactly one survivor.
  assert.match(text, /tiebreak/i);
  assert.match(text, /exactly\s+one\s+survivor/i);
  assert.match(text, /same\s+origin/i);
  assert.match(text, /name\s+is\s+not\s+part\s+of\s+this\s+rule/i);

  // A fresh agent handed only this document produced the right buckets but
  // had to guess on four points. Each guess is now stated, because a rule
  // that needs guessing is not reproducible run to run:
  //   - which flows can do the covering (both tiers, not just pending)
  //   - what "sorts first" means (byte order, so it is deterministic)
  //   - whether the tiebreak is judged pairwise or against all rivals
  //   - whether the port is part of the loopback host test
  assert.match(text, /both\s+tiers/i);
  assert.match(text, /byte\s+order/i);
  assert.match(text, /pairwise/i);
  assert.match(text, /ignoring\s+the\s+port/i);

  // Coverage may come from either tier, and `flows list --json` carries no
  // steps, so BOTH artifact directories have to be named or the ready half
  // of that rule is unreachable. A re-test agent hit exactly this: it read
  // "B may come from either tier" and had no documented way to get a ready
  // flow's steps.
  assert.match(text, /~\/\.fast-browser\/flows-pending\//);
  assert.match(text, /~\/\.fast-browser\/flows\/</);

  // Only the content fact earns autonomous rejection. Both of these open a
  // sentence in the skill, so they are matched case-insensitively.
  assert.match(text, /only `unapprovable` is rejected automatically/i);
  assert.match(text, /propose, never act/i);

  // Corrupt artifacts are reported, never rejected.
  assert.match(text, /unparseable\s+means\s+unjudgeable/i);

  // Cleaning is auditable, which is what makes a large batch reasonable to
  // accept, and a name collision names the colliding flow.
  assert.match(text, /rejected ledger/);
  assert.match(text, /which\s+name\s+collided/);

  // The data sources, including the fact that `list` does not carry steps.
  assert.match(text, /flows list --json/);
  assert.match(text, /~\/\.fast-browser\/flows-pending\//);
  assert.match(text, /does not carry steps/);

  // Drift: a heal rewrites approved content with no gate.
  assert.match(text, /lastHealed/);
  assert.match(text, /without re-entering the gate/);

  // The skill must never automate the prompt: echo/printf piped in, a
  // heredoc/herestring, `expect`, or `yes` piping the literal.
  assert.doesNotMatch(
    text,
    /echo\s+APPROVE|printf[^\n]*APPROVE|\bexpect\b|<<<\s*APPROVE|yes\s+APPROVE/,
  );
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

test('fast-browsing runs a saved dev login by devlogin names only and returns the contract outcomes', async () => {
  const text = await readFile(path.join(pluginRoot, 'skills/fast-browsing/SKILL.md'), 'utf8');
  assert.match(text, /`rt logins list --json`/);
  assert.match(text, /`devlogin:`/);
  for (const outcome of ['no-saved-login', 'saved-login-failed', 'login-limited', 'needs-human']) {
    assert.match(text, new RegExp(`\`${outcome}\``), `missing outcome ${outcome}`);
  }
  assert.match(text, /"Saved login for this origin\?" \[shape=diamond\]/);
  assert.match(text, /reload once/);
  assert.doesNotMatch(text, /\u2014|\u2013/);
});

// Browsing costs page reads and round trips, not thinking: Haiku drives by
// default, Sonnet is the only escalation, and the routing template the setup
// installs is where callers learn that, so both halves are pinned together.
test('the browser-driver defaults to haiku at medium and the routing caps it at sonnet', async () => {
  const agent = await readFile(path.join(pluginRoot, 'agents/browser-driver.md'), 'utf8');
  assert.match(agent, /^model: haiku$/m);
  assert.match(agent, /^effort: medium$/m);

  const routing = await readFile(
    path.join(pluginRoot, 'templates/routing/claude/fast-browser-routing.md'),
    'utf8',
  );
  const phrase = (words) => new RegExp(words.split(' ').join('\\s+'));
  assert.match(routing, phrase('escalate to `sonnet`'));
  assert.match(routing, phrase('never `opus` or `fable`'));
  assert.match(routing, phrase('never `low` effort'));
});

// A judgment the brief does not settle comes back as one question with the
// tab left in place, and the caller resumes the same agent: a fresh spawn
// loses the page the question was about.
test('the browser-driver asks back and the caller resumes the same agent', async () => {
  const agent = await readFile(path.join(pluginRoot, 'agents/browser-driver.md'), 'utf8');
  const phrase = (words) => new RegExp(words.split(' ').join('\\s+'));
  assert.match(agent, phrase('do not guess'));
  assert.match(agent, phrase('leave the tab where it is'));
  assert.match(agent, phrase('Never ask back for a credential'));

  const routing = await readFile(
    path.join(pluginRoot, 'templates/routing/claude/fast-browser-routing.md'),
    'utf8',
  );
  assert.match(routing, phrase('SendMessage to that same agent'));
});

// Each line pinned here is a mistake a blind run made without the skill, or
// a contract of the capture tool or the compose CLI as it ships: a sidecar
// edited by hand, a spec written away from its sidecar, a lift that cut a fact in
// half, a thin-strip crop accepted as is, a board reported unread. The skill
// must also name every mark kind and layout the validator accepts.
test('composing-evidence states the compose contract and the blind-run lessons', async () => {
  const text = await readFile(path.join(pluginRoot, 'skills/composing-evidence/SKILL.md'), 'utf8');
  const phrase = (words) => new RegExp(words.split(' ').join('\\s+'));
  const { STATES, TAGS, MARK_KINDS, LAYOUTS } = await import('../../lib/compose/spec.mjs');

  assert.match(text, /`browser_capture_evidence`/);
  assert.match(text, /targets: \{ <key>: "<selector>" \}, frame: "auto", out: "<board>\.c1"/);
  // Step 2 said `frame: "auto"` while the rules below named a frame.
  assert.match(text, phrase('Pass `frame: "<css selector>"` instead when a rule below names the frame'));
  // Two drivers passed a `role=` frame and were refused.
  assert.match(text, phrase('A `frame` selector is CSS'));
  assert.match(text, phrase('The capture refuses `role=` and `text=` frames'));
  assert.match(text, phrase('build the selector from an id, a data attribute or an aria attribute'));
  assert.doesNotMatch(text, /frame: "<selector>"/);
  assert.doesNotMatch(text, /browser_run_code_unsafe/);
  assert.doesNotMatch(text, /--seal/);
  assert.doesNotMatch(text, /capture-evidence\.js/);
  assert.match(text, /Never edit the sidecar/);
  assert.match(text, phrase('the frame selector is larger than the viewport'));
  assert.match(text, phrase('inside a shadow root or an iframe'));
  assert.match(text, phrase('capture again once'));
  assert.match(text, phrase('read `error`, then fix what that step names'));
  assert.match(text, phrase('The return carries its path as `sidecar`'));
  assert.match(text, phrase('A return is finished only when `missed` is empty'));
  assert.match(text, phrase('`frameSnap` is not `union`'));
  assert.match(text, phrase('only when `missed` is empty, `frameSnap` is not `union` and there is no `failedStep`'));
  assert.match(text, phrase('until then fix the cause, capture again, and write no spec'));
  assert.match(text, phrase('Remove a key the board does not need from `targets`'));
  assert.match(text, phrase('If the same key misses on the second capture, report it and stop that board'));
  assert.match(text, phrase('other boards in the same job continue'));
  assert.doesNotMatch(text, /after two captures/);
  assert.doesNotMatch(text, /nothing to seal/i);
  assert.match(text, phrase('`frameSnap` is `union`: pass `frame: "<css selector>"` for the element that holds the targets'));
  assert.doesNotMatch(text, phrase('If it is still `union`'));
  assert.match(text, phrase('for the element that holds the targets and capture again. The frame from that capture is final, thin strip or not; if it is a thin strip, say so in the report.'));
  // One frame selector that is too large does not show that no element fits:
  // a blind run stopped its board there with a capture still in hand.
  assert.doesNotMatch(text, phrase('because no element both holds the targets and fits the viewport'));
  assert.match(text, phrase('If that capture fails at `frame` saying the frame selector is larger than the viewport, try once more with a smaller element inside it that still holds every target'));
  assert.match(text, phrase('for a section heading, the heading\'s own header block with what sits beside it, not the whole section'));
  assert.match(text, phrase('if the only one that fits is a thin strip, pass it, and its frame is final as above'));
  // A smaller holder that misses a target must not send the driver one
  // ancestor up, back to the element that was too large.
  assert.match(text, phrase('Stop that board, and say so in the report, when that capture fails too, at any step \\(do not go one ancestor up from it\\), or when the budget is spent'));
  assert.match(text, phrase('when the tool chose the frame, that is `frameSnap` is neither `union` nor `selector`: try once with'));
  assert.match(text, phrase('If it fails, the earlier files are untouched: keep them and say so in the report'));
  assert.doesNotMatch(text, phrase('keep the frame the tool chose'));
  assert.match(text, phrase('If that capture succeeds and is no better, capture once more with `frame: "auto"` to get the tool\'s frame back, and say so in the report'));
  assert.match(text, phrase('If it fails the same way, report it and stop that board; other boards in the same job continue'));
  assert.match(text, phrase('run `fast-browser setup`, ask the human to restart the Fast Browser session, and capture once it is back'));
  assert.doesNotMatch(text, phrase('run `fast-browser setup`, then capture'));
  assert.match(text, phrase('Compose refuses a sidecar whose image, frame, boxes or scale were changed afterwards'));
  assert.match(text, phrase('`count` says how many elements matched'));
  assert.doesNotMatch(text, phrase('If it does not drop to one after scoping'));
  assert.match(text, phrase('`count` says how many elements matched; read the structure of that region'));
  assert.match(text, phrase('before the second capture, then scope to the smallest element'));
  assert.match(text, phrase('smallest element that holds the wanted match and none of the others'));
  assert.match(text, phrase('Changing the words inside the same kind of selector is not a fix'));
  assert.match(text, phrase('`failedStep: "resolve"` or `"frame"` saying the element is inside a shadow root'));
  assert.match(text, /fast-browser compose <spec\.json>/);
  assert.match(text, phrase('beside the sidecar'));
  assert.match(text, /failedStep/);
  assert.match(text, phrase('Never edit the sidecar'));
  // Only no-match and ambiguous are selector problems; the other two misses
  // and a too-large frame need the page or the viewport changed instead.
  assert.match(text, phrase('`no-match` or `ambiguous`: the selector is wrong'));
  assert.match(text, phrase('`not-visible` \\(zero-size box\\): the element is collapsed or hidden'));
  assert.match(text, phrase('`out-of-view`: it fell outside the viewport'));
  assert.match(text, /`frameSnap: "too-large"`/);
  assert.match(text, /browser_resize/);
  assert.equal((text.match(/`fast-browser setup`/g) || []).length, 2);
  assert.match(text, /\bnever `nth=`/);
  assert.match(text, /browser_find/);
  assert.match(text, phrase('Lift the whole fact'));
  // A frame round two far-apart places takes in the personal details between them.
  assert.match(text, phrase('That frame also holds everything between them'));
  assert.match(text, /`union`/);
  assert.match(text, phrase('thin strip'));
  assert.match(text, phrase('compose refuses it'));
  // The fill is drawn over the measured box only, never a blur of the area.
  assert.match(text, phrase('with a solid fill, not a blur'));
  assert.match(text, phrase("the fill covers that element's box only"));
  assert.doesNotMatch(text, /`redact` blurs/);
  // A fill on an imported image grows over ink that continues its value, up to a limit.
  // Compose grows only an imported redaction, so the guidance lives with the ticket steps.
  const ticketSteps = text.slice(text.indexOf('## A screenshot from a ticket'));
  assert.match(ticketSteps, phrase('starts `a redaction on panel <n> (<mark>)`'.replace(/[()]/g, '\\$&')));
  assert.match(ticketSteps, /\| `grew to cover ink beside it` \| warning \|/);
  assert.match(ticketSteps, /\| `covered a line beside it to that line's end, past its <side> edge` \| warning \|/);
  assert.match(ticketSteps, /\| `covered ink past a gap at its <side> edge` \| warning \|/);
  assert.match(ticketSteps, /\| `stopped at a gap with more ink just past its <side> edge` \| warning \|/);
  assert.match(ticketSteps, phrase('Each crop shows a margin of what lies just past its fill, so you can check that nothing of the value continues beyond it'));
  assert.match(ticketSteps, /\| `met another mark's box with ink still at its <side> edge` \| warning, or a refusal \|/);
  assert.match(ticketSteps, /\| `reached the frame with ink still at its <side> edge` \| a refusal when the ink is on the value's own line, otherwise a warning \|/);
  assert.match(ticketSteps, phrase('On `stopped at a gap`, if any of the value shows past the fill, draw the redact box over the whole value, every line of it, and render again'));
  // The growth limit refuses every time; it is never a warning to read past.
  assert.match(ticketSteps, /\| `reached its growth limit with ink still at its <side> edge` \| always a refusal \|/);
  assert.match(ticketSteps, phrase('A covered neighbouring line is expected, because hiding comes first'));
  assert.match(ticketSteps, phrase('the message goes on `Draw that redact box over the whole value` and no board was written'));
  assert.match(ticketSteps, phrase('or move the frame edge so the rest is cropped out, then render again'));
  assert.match(ticketSteps, phrase('do not shrink the box to clear a neighbour'));
  assert.doesNotMatch(text, phrase('reached its growth limit with ink still at its <side> edge` means read the crop'));
  assert.doesNotMatch(text, phrase('some of the value may show beside the fill'));
  assert.doesNotMatch(text, phrase('grew to cover ink beside it` means read that redaction\'s crop'));
  assert.doesNotMatch(text, phrase('no board was written: the redact box covers only part of a value'));
  assert.match(text, phrase('Read the PNG'));
  for (const state of STATES) assert.ok(text.includes(`\`${state}\``), state);
  for (const tag of TAGS) assert.ok(text.includes(`\`${tag}\``), tag);
  const between = (from, to) => text.slice(text.indexOf(from), text.indexOf(to));
  const layoutRows = between('### Layouts', '### Marks');
  const markRows = between('### Marks', '## A screenshot from a ticket');
  for (const kind of MARK_KINDS) assert.match(markRows, new RegExp(`^\\|[^|]*\\|\\s*\`${kind}\``, 'm'), kind);
  for (const layout of Object.keys(LAYOUTS)) assert.match(layoutRows, new RegExp(`^\\| \`${layout}\` \\|`, 'm'), layout);
  assert.match(text, phrase('too small to read'));
  assert.match(text, phrase('exactly two keys'));
  assert.match(text, phrase('One capture per panel'));
  assert.match(text, phrase('the same selectors and the same frame selector'));
  assert.match(text, phrase('all panels at one height'));
  assert.match(text, /fast-browser compose --import <image> --out <board>\.c1 --origin <ticket link>/);
  assert.match(text, phrase("the image's real pixels"));
  assert.match(text, phrase('in a `pair` of one region, both panels show the same region'));
  assert.doesNotMatch(text, phrase('every panel shows the same region'));
  assert.match(text, phrase('Read every crop'));
  assert.match(text, phrase('Read every crop as well as the board'));
  assert.match(text, phrase('the crop is where a redaction is checked'));
  assert.match(text, phrase('because a shrunken board is how a readable sliver survives'));
  assert.match(text, phrase('On a ticket image compose never widens the frame you give'));
  assert.match(text, phrase('move that edge yourself'));
  assert.match(text, /fast-browser compose --confirm <spec\.json>/);
  assert.match(text, phrase('Never run it yourself'));
  assert.match(text, phrase('renders it unconfirmed again'));
  assert.match(text, phrase('unless the operator confirmed the crops of the latest render'));
  assert.match(text, phrase('ask again after any re-render'));
  assert.match(text, phrase('attach or post the board nowhere until then'));
  assert.match(text, phrase("one per redaction on the board, live panels' included"));
  assert.match(text, phrase("also report each crop's path, that you read each one, and that the board is unconfirmed"));
  assert.match(text, phrase('naming what that panel is'));
  assert.match(text, phrase("A `pair` board shows each panel's frame whole"));
  assert.match(text, phrase('less any blank margin at its edges'));
  assert.match(text, phrase('A `steps` panel is already cropped to its marks, so there mark fewer things in the panel'));
  assert.match(text, phrase('| `a crop edge cuts through content` | A `steps` panel was cut'));
  assert.match(text, phrase('A `single` board and each panel of a `steps` board are cropped to their marks'));
  assert.match(text, phrase('never a thin strip'));
  assert.match(text, phrase("the page's `main` region, or any container that holds most of the page, is the whole page"));
  assert.match(text, phrase('the element that holds the value together with the label or heading that says what it is'));
  assert.match(text, phrase('every place that value, or a part of it, appears inside the frame'));
  assert.match(text, phrase('A box that cuts an icon or a word in half reads as a glitch'));
  assert.match(text, phrase('Look for every place the value, or a part of it, appears'));
  assert.match(text, phrase('Make each box cover whole elements, or stop short of them'));
  assert.match(text, phrase('redact each or frame them out; then check the board for it by eye'));
  assert.match(text, phrase('in a `pair` of one region, capture both panels again on the same tighter region, with one selector where one names it on both pages'));
  assert.doesNotMatch(text, phrase('capture both panels again with the same tighter selector'));
  assert.match(text, phrase("for a ticket image, shrink the panel's `frame` rectangle instead"));
  assert.match(text, phrase('| `a panel is drawn small; frame the card that holds its marks` | The panel shows too much to read at its size'));
  assert.match(text, phrase("An element in a card's header or toolbar is often not inside the container the card's body has"));
  assert.match(text, phrase('A capture that comes back `no-match` is a capture spent'));
  assert.match(text, phrase('a different icon beside it carries a name'));
  assert.match(text, phrase('whose accessible name is `Pinned`, selected as'));
  assert.match(text, phrase('report the case as not done'));
  // The state table: a neutral comparison of two things is AFTER, and FLOW is narrow.
  assert.match(text, /\| `AFTER` \| a fact on the page as it is now, in one panel or two, including a neutral comparison of two things/);
  assert.match(text, /\| `FOUND` \| a problem on the page/);
  assert.match(text, /\| `BEFORE → AFTER` \| only a `pair` that shows one thing before and after a change/);
  assert.match(text, /\| `FLOW` \| only a `steps` board, or a single panel the brief calls the start of a flow/);
  assert.match(text, phrase('`lift` that text instead'));
  assert.match(text, phrase('one, with no `label`: the board\'s `state` already says what it is'));
  assert.match(text, phrase('give each capture its own frame selector for the element that holds that same visible region'));
  assert.match(text, phrase('never one outside the frame'));
  // A blind run left the absent side of a pair unmarked, so its whole panel sat under the wash.
  assert.match(text, phrase("Mark that element with a `lift` whose callout says the thing is not there and where it would sit"));
  assert.match(text, phrase('a heading, block or card lifted here is the one exception to lifting the whole fact'));
  // A later run lifted the absent side's tab in the strip, and the judge read it as pointing at the wrong place.
  assert.match(text, phrase('at the spot where the thing sits on the other page'));
  assert.match(text, phrase('each thin strip the tool chose and the frame selector you retried it with, or that its retry was skipped for budget'));
  assert.match(text, phrase('not a tab or label in the strip both pages share, and never one outside the frame'));
  assert.match(text, phrase('saying the frame selector does not contain every target: the frame is too tight'));
  assert.match(text, phrase('Another selector for the same element is not a fix'));
  assert.match(text, phrase('is not a fix. If that fails too, report it and stop that board'));
  assert.match(text, phrase('`ISSUE` goes only on a problem; a neutral fact gets no tag, or `OK`'));
  assert.doesNotMatch(text, phrase('no problem in it'));
  assert.match(text, phrase('A fact with a sub-line under it is one item'));
  assert.match(text, phrase('This retry is required, not optional'));
  assert.match(text, phrase('a thin strip the tool chose has had its retry'));
  assert.match(text, phrase('mark that thing with its status in it, not a chip inside it'));
  assert.match(text, phrase('Lift the whole fact, not its header or card, unless the brief names that header, row or card'));
  assert.match(text, phrase('In a `pair` across two pages, that region is the same band on each page: the same place on screen at about the same size'));
  // A blind run framed a container that fills the viewport, on two pages at
  // two viewport heights: two regions at two sizes, one too small to read.
  assert.match(text, phrase('Take both captures of a `pair` at one viewport size: if step 3 resized the viewport for one panel, capture the other again at that size, within the budget'));
  assert.match(text, phrase('When the only element that holds the band fills the viewport, read where the first block under the strip ends from the first capture\'s `boxes`, or its PNG divided by the sidecar\'s `scale`'));
  assert.match(text, phrase('set the viewport height a little more than it with one `browser_resize`, the same for both captures'));
  assert.doesNotMatch(text, phrase('until that frame holds the strip'));
  assert.match(text, phrase('That shortened container is the one exception to never the whole page; never frame it at full height'));
  assert.match(text, phrase('Restore the starting viewport size after the last capture'));
  assert.match(text, phrase('named in the brief or not, all in the first capture'));
  assert.match(text, phrase("In `steps`, each panel's mark sits on the thing its `label` names"));
  assert.match(text, phrase("its panel `tag` and its panel `note`. So a mark inside a step may go without text"));
  assert.doesNotMatch(text, phrase("calls it by the label's words"));
  // A context mark far from a step's mark made the crop huge and the marked item small.
  // The old rule named the record in the label and allowed context only when the label did not: it never applied.
  assert.match(text, phrase("When the mark does not show the record, name it in the step's `label`. If what identifies it \\(its name, the selected tab\\) sits about one card from the mark, also add"));
  assert.match(text, phrase('Never add context for anything farther'));
  // A run that added context dropped the record from the label.
  assert.match(text, phrase('the `label` still names the record, because `context` draws no words'));
  assert.doesNotMatch(text, phrase("only when the step's `label` does not name the record"));
  assert.doesNotMatch(text, phrase('Distance is no reason to leave it out'));
  assert.doesNotMatch(text, phrase('target that element too and add `{ "context": "<key>" }`'));
  // A blind run framed a whole wide card round a tiny badge at its edge.
  assert.match(text, phrase('A tiny target at the edge of a wide card gets a frame on its row or column, not the card'));
  assert.match(text, phrase('a small target is framed on its row or column instead \\(see Marks\\)'));
  // Blind runs paraphrased the field in the board title.
  assert.match(text, phrase("The board title uses the page's own words for the field it proves"));
  // Bare lifts lost the callouts reviewers read: a title naming the thing and a note with its state.
  assert.match(text, phrase('Every `lift`, `loupe`, `ghost` and `empty` outside `steps` gets a callout: a `title` naming the record, field or control in a few words'));
  // An empty's text is drawn inside the blank; compose drops it when it does not fit.
  assert.match(text, phrase('An `empty` keeps its `text`, drawn inside the blank to say what is missing; compose drops it when it does not fit, so then say it in the `note`'));
  assert.match(text, phrase('and a `note` giving what that title does not: the value, the state, or where on the page it is'));
  assert.match(text, phrase('Outside `steps`, `lift`, `loupe`, `ghost` and `empty` need a `title` and a `note`; `bracket` and `link` always need a `title`'));
  assert.match(text, /\{ "loupe": "badge", "zoom": 4, "title": "Tiny badge", "note": "One line" \}/);
  assert.doesNotMatch(text, phrase("Leave that lift bare"));
  assert.doesNotMatch(text, /goes\s+bare/);
  // Boards titled with the record and section name left the claim to the labels.
  assert.match(text, phrase('The board title states the fact the board proves, as a short sentence'));
  // A status line lifted alone faded out whose status it was; the whole record row kept it.
  assert.match(text, phrase("lift the smallest header or card row that holds the record's name, tag or picture and the status with its icon, never the status line alone"));
  assert.match(text, phrase('With two or more such records, the board title states each fact'));
  assert.doesNotMatch(text, phrase("lift each one's status line with its icon"));
  assert.doesNotMatch(text, phrase('The board title then names the field'));
  assert.doesNotMatch(text, phrase('never the whole headers'));
  assert.doesNotMatch(text, phrase("When two or more headers each show that status"));
  // A note quoted a cut-short sub-line and drew the eye to noise.
  assert.match(text, phrase('No label quotes that sub-line'));
  assert.doesNotMatch(text, phrase('or its `note` says what the sub-line is'));
  // A ghost box that took in a neighbouring glyph read as holding something.
  assert.match(text, phrase('draw that over the empty gap only, unpadded, clear of any glyph, icon or text beside it'));
  assert.match(text, phrase('compose grows a small `ghost` to a readable size'));
  assert.doesNotMatch(text, phrase('A box over a gap covers the empty gap only'));
  // A blind run marked the heading a menu click revealed, not the menu item left selected.
  assert.match(text, phrase('A step reached by clicking a control that stays selected, such as a tab or a menu item, marks that selected control'));
  assert.match(text, phrase('so every step marks the same kind of thing'));
  assert.match(text, phrase('Mark a heading the click revealed only when no control stays selected'));
  assert.match(text, phrase("If a wider viewport leaves it wrapped, the page wraps it: write the value on one line in the mark's `note`"));
  assert.match(text, phrase('Spend captures on hiding first: the targets this rule needs, then any retry for looks'));
  assert.match(text, phrase('A board that would still show a personal detail is not written'));
  assert.match(text, phrase('write no spec and report the case as not done for that reason'));
  assert.match(text, phrase('a thin strip left unretried for budget is kept and reported'));
  // The thin-strip retry and the hiding budget gave a driver two opposite instructions.
  assert.match(text, phrase('This retry is required, not optional, unless the budget went to hiding personal details'));
  assert.match(text, phrase('a report that names a thin strip names its retry, or says the retry was skipped for budget'));
  assert.match(text, phrase('a thin strip the tool chose has had its retry or was left for the hiding budget'));
  assert.doesNotMatch(text, phrase('not optional: a report that names a thin strip names its retry too'));
  assert.match(text, phrase("report the case as not done and do not give that board's path as a result"));
  // The exceptions cover the lifted words only; a label that repeats the title still warns.
  assert.match(text, phrase("never copies its sentence or the tag, never quotes the lifted words \\(except a value the page wraps"));
  assert.doesNotMatch(text, phrase("never repeats the board's title, the tag or the lifted words, except"));
  assert.match(text, phrase('lifted words \\(see Marks for the exceptions\\)'));
  assert.doesNotMatch(text, phrase('unless it names a status two or more headers show'));
  // Drivers cleared the warning by making the board title vaguer.
  assert.match(text, phrase("Reword the label so it says what the title does not"));
  assert.match(text, phrase("never weaken the board title: it keeps stating the fact"));
  assert.doesNotMatch(text, phrase("Reword the label or the board title"));
  assert.match(text, phrase('\\("Sprint 4, Release panel"\\) or how an element looks'));
  assert.doesNotMatch(text, phrase("rewrite or drop that label's line"));
  // Step 7 pointed at itself.
  assert.match(text, phrase('unless cut short or meaningless alone; see below'));
  assert.doesNotMatch(text, phrase('meaningless alone; see step 7\\)'));
  // One snapshot rule, in step 1, that also covers a frame the tool chooses.
  const stepOne = text.slice(text.indexOf('1. **Choose selectors.**'), text.indexOf('2. **Capture.**'));
  assert.match(stepOne, phrase('Before the first capture of any frame, take a snapshot scoped to the frame element'));
  assert.match(stepOne, phrase('with `frame: "auto"`, snapshot the card that holds the targets'));
  assert.equal(text.split(/Before\s+the\s+first\s+capture\s+of\s+any\s+frame/).length, 2);
  assert.match(text, phrase('so its snapshot \\(step 1\\) needs a `redact` target'));
  assert.doesNotMatch(text, phrase('and the snapshot of the frame element under Marks'));
  assert.doesNotMatch(text, phrase('To know what the frame will hold'));
  assert.doesNotMatch(text, phrase('and a snapshot scoped to the frame if you need one'));
  assert.match(text, phrase('a value the board compares wrapped onto two lines: widen the viewport with `browser_resize`'));
  // A board titled after one of its two facts left the second lift a label
  // that described the layout ("Separate summary point").
  assert.match(text, phrase('When the board proves more than one fact, the title states each of them'));
  assert.match(text, phrase('and so does a board of two or more records\' statuses'));
  assert.doesNotMatch(text, phrase('there the title names the field'));
  assert.match(text, phrase('never describes the board\'s layout \\("separate point"\\)'));
  assert.match(text, phrase("or that describes the board's layout, so it adds what the title does not; outside `steps`, never leave a mark without its callout"));
  assert.doesNotMatch(text, phrase('Delete any label line'));
  assert.doesNotMatch(text, phrase("already states may go without a label"));
  // A lift that left its sub-line out still showed the sub-line's top under the card.
  assert.match(text, phrase("check the PNG for a part of that sub-line peeking out under the lift's card. If any of it shows, target the whole item instead"));
  // Compose evens step zooms out only above a floor, so steps need comparable frames.
  assert.match(text, phrase('Steps share one zoom only when compose can'));
  assert.match(text, phrase('unless that would draw a panel below about 0.55'));
  assert.match(text, phrase('frame each step on a comparable region'));
  assert.doesNotMatch(text, phrase('none of that needs anything from you'));

  const pointer = await readFile(path.join(pluginRoot, 'skills/annotating-screenshots/SKILL.md'), 'utf8');
  const body = pointer.replace(/^---\n[\s\S]*?\n---\n/, '');
  assert.match(body.slice(0, 900), /composing-evidence/);
});

// A short callout may name the record or status the board title states; a
// label that copies the board title must still warn.
test('composing-evidence: its record-status example matches the wording check', async () => {
  const text = await readFile(path.join(pluginRoot, 'skills/composing-evidence/SKILL.md'), 'utf8');
  const flat = text.replace(/\s+/g, ' ');
  const calloutTitle = flat.match(/Its `title` names the record \("([^"]+)"\)/)?.[1];
  const calloutNote = flat.match(/gives the status in the page's words \("([^"]+)"\)/)?.[1];
  const title = flat.match(/the board title states each fact \("([^"]+)"\)/)?.[1];
  assert.equal(calloutTitle, 'Atlas project');
  assert.equal(calloutNote, 'Budget approved');
  assert.equal(title, "Atlas has its budget approved; Borealis's budget is pending");

  const sandbox = {};
  vm.runInNewContext(await readFile(path.join(pluginRoot, 'lib/compose/wording.js'), 'utf8'), sandbox);
  const { wordingWarnings } = sandbox.__composeWording;
  const check = (marks) => [...wordingWarnings({ title, panels: [{ marks }] }, [{ source: 'live' }])];
  assert.deepEqual(check([
    { lift: 'atlasCard', title: calloutTitle, note: calloutNote },
    { lift: 'borealisCard', title: 'Borealis project', note: 'Budget pending' },
  ]), []);
  assert.deepEqual(check([{ lift: 'atlasCard', title: 'Atlas has its budget approved' }]), ["a label repeats the board's title"]);
});
