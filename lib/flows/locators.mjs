// Compile-time locator fallback synthesis (MAT-336). LEAF module: no
// imports, no I/O -- lib/flows/compile.mjs is its only caller today, and
// tests/unit/flows-locators.test.mjs pins its output shape directly.
//
// --- why this exists ---
//
// The capture layer records whatever ranked alternates the extension
// managed to enrich a target with, and for a great many targets that is
// exactly ONE selector. The MAT-330 spike measured what that costs: half
// the ready-tier mined flows were dead on arrival because their sole
// captured locator was over-specified (a `role=link[name=...]
// [description=...]` form) and matched nothing at replay. With no second
// candidate, flow-runner has nothing to fall back to and heal has nothing
// to rank -- the flow is quarantined, never repaired.
//
// So the ladder is built at COMPILE time, from evidence the trace already
// carries (the target's own role/name/description), rather than left to
// whatever the page happened to offer at capture. Every rung is strictly
// weaker than the one above it: exact captured selector, then that
// selector probed verbatim, then role+name with the extra qualifiers
// dropped, then the same query pinned to its first match, then text, then
// a structural tag+text form. A replay walks down until something hits and
// records the fallback; nothing above the winning rung is ever skipped.
//
// --- the verbatim twin (rung 2), which looks redundant and is not ---
//
// flow-runner.js's `candidateLocator` resolves a `kind: 'role'` candidate
// from the TARGET's own `role`/`name`, never from that candidate's own
// `selector` string (lib/flows/heal.mjs's DEVIATION note documents the same
// behavior from the healing side). Two consequences, both measured:
//   - an over-specified captured selector is never actually probed; its
//     `[description=...]` qualifier -- the thing that made it unambiguous --
//     is silently dropped, and the loosened query it degrades to can match
//     several elements and fail strict-mode resolution. That is precisely
//     the spike's DOA flow.
//   - two DIFFERENT captured role candidates (say `role=link[name="Travel"]`
//     and a structural `role=link >> nth=3`) collapse to the same probe key
//     and the second is deduped away before it is ever tried.
// Emitting each captured role selector a second time as `kind: 'other'`
// makes flow-runner address it verbatim through `page.locator()`, which
// recovers both without changing the runner's documented resolution
// contract.

export const MAX_LOCATOR_CANDIDATES = 8;

// Names are spliced into selector string literals, so they must survive
// quoting. Anything past this length, or containing a line break, is
// treated as unusable evidence rather than escaped into a selector nobody
// can read or debug.
const MAX_SYNTHESIZED_NAME_LENGTH = 200;

// ARIA role tokens only. A `role` carrying selector punctuation is not a
// role at all (a corrupt or hand-edited trace) and must never reach a
// selector string.
const ROLE_TOKEN_PATTERN = /^[a-z]+$/;

// The structural rung is a tag + visible-text match, which is only
// meaningful for elements whose accessible name IS their text content.
// Deliberately not extended to textbox/checkbox/radio/combobox: an input
// has no text to match, so `input:has-text(...)` would resolve nothing and
// the rung would be pure noise in every ladder.
const ROLE_TAGS = new Map([['link', 'a'], ['button', 'button']]);

function str(value) {
  return typeof value === 'string' ? value : '';
}

function escapeSelectorLiteral(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// The query flow-runner.js will actually run for a candidate, collapsed to
// a string. Kept byte-compatible with that file's own `candidateKey` so a
// ladder never carries two candidates the runner would dedupe away: a rung
// that can never be probed is worse than no rung at all, because it reads
// as coverage that is not there.
export function probeKey(target, candidate) {
  const role = str(target?.role);
  const name = str(target?.name);
  return candidate.kind === 'role' && role && name
    ? `role:${role}:${name}`
    : `${candidate.kind}:${candidate.selector}`;
}

function synthesizedRungs(captured, role, name) {
  const rungs = [];
  const escapedName = escapeSelectorLiteral(name);

  if (role) {
    const loosened = `internal:role=${role}[name="${escapedName}"i]`;
    // A captured `role` candidate is resolved by the runner as role+name,
    // which is exactly `loosened` -- so the loosened rung is already
    // covered whenever one exists, and a captured selector that IS the
    // loosened string needs no verbatim twin either. Both guards exist to
    // keep the ladder free of rungs that re-probe a query that just missed.
    let loosenedCovered = false;
    for (const candidate of captured) {
      if (candidate.kind !== 'role') continue;
      loosenedCovered = true;
      if (candidate.selector !== loosened) rungs.push({ kind: 'other', selector: candidate.selector });
    }
    if (!loosenedCovered) rungs.push({ kind: 'other', selector: loosened });
    // Strict-mode resolution treats "matched several elements" as a miss,
    // so a loosened query on a page that repeats an accessible name (a
    // thumbnail link plus a title link for the same product, say) fails
    // exactly as hard as one that matches nothing. Pinning the first match
    // is what turns that class of miss into a degraded success.
    rungs.push({ kind: 'other', selector: `${loosened} >> nth=0` });
  }

  rungs.push({ kind: 'text', selector: `internal:text="${escapedName}"i >> nth=0` });

  const tag = ROLE_TAGS.get(role);
  if (tag) rungs.push({ kind: 'css', selector: `${tag}:has-text("${escapedName}") >> nth=0` });

  return rungs;
}

// expandLocatorCandidates(target) -> Locator[]
//
// `target` is artifact.mjs's parseTarget shape (`{ locators, description?,
// role?, name? }`) or the compiler's in-progress equivalent. Returns a new
// array; the input is never mutated. Captured candidates always come first
// and are never dropped -- if they alone fill the bound, nothing is
// synthesized at all, because evidence the page actually offered outranks
// anything derived from it.
export function expandLocatorCandidates(target) {
  const captured = Array.isArray(target?.locators) ? target.locators : [];
  const rawRole = str(target?.role);
  const role = ROLE_TOKEN_PATTERN.test(rawRole) ? rawRole : '';
  const name = str(target?.name).trim();

  const synthesizable = name.length > 0
    && name.length <= MAX_SYNTHESIZED_NAME_LENGTH
    && !/[\n\r]/.test(name);
  if (!synthesizable) return [...captured];

  const expanded = [...captured];
  const seen = new Set(captured.map((candidate) => probeKey(target, candidate)));

  for (const rung of synthesizedRungs(captured, role, name)) {
    if (expanded.length >= MAX_LOCATOR_CANDIDATES) break;
    const key = probeKey(target, rung);
    if (seen.has(key)) continue;
    seen.add(key);
    expanded.push(rung);
  }

  return expanded;
}
