async (page, args) => {
  // Replay engine for a compiled flow artifact (WS2a flywheel plan, Task 8).
  // Interprets the wire format lib/flows/artifact.mjs defines and produces
  // exactly one of the two contracts documented in
  // skills/browser-macros/MACROS.md's `## flow-runner` entry. This file has
  // no imports and no Node host globals in scope -- only `page` and `args`
  // exist, same as every other built-in here -- so the artifact shape is
  // re-checked by hand rather than by importing artifact.mjs's own
  // `parseFlow`, and only as much of it as this runner actually depends on
  // (schemaVersion, steps, name). A caller who wants full validation runs
  // `flows compile`/`flows approve` first, which does have artifact.mjs
  // available.
  //
  // SUCCESS returns a value normally: `{ ok: true, result, stepsRun,
  // locatorFallbacks, ms }`. FAILURE throws a single Error instead of
  // returning a failure object (fix round 1, controller ruling): a browser
  // macro RETURNING any value at all is a successful tool call, so a
  // returned `{ failedStep, ... }` reads as a success to anything scoring
  // replay health -- Task 9's sweep, in particular, counts `successRuns`
  // off the call completing at all, never off inspecting what it returned.
  // Every failure path below therefore calls `fail(shape)`, which throws
  // `new Error('FLOW_RUNNER_FAILURE: ' + JSON.stringify(shape))` -- the
  // tool call itself fails, and a caller recovers the exact same `{
  // failedStep, error, url, stepsCompleted, locatorFallbacks }` shape by
  // parsing the JSON out of the error message after that fixed prefix.
  //
  // Every step below runs at most once. A step that throws is reported as
  // a structured failure immediately -- nothing here loops back to run the
  // same action again, which is what makes a `mutating: true` step safe to
  // replay: it either completes zero times (never reached) or exactly one
  // time (attempted, whatever the outcome). A post-action network-settle
  // wait is a soft signal, never a step failure: only the ACTION itself
  // gates whether a step counts as completed, so a settle stall after an
  // action that already succeeded is not reported as an incomplete step
  // (which would invite a caller to run it again and double-mutate).
  const started = Date.now();
  const input = args || {};
  const flow = input.flow;

  const MAX_STEPS = 60;
  const MAX_EXTRACTS = 20;
  const MAX_VALUE_LENGTH = 4096; // 4KB, treated as characters (see boundString)

  const boundString = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return text.length > MAX_VALUE_LENGTH ? text.slice(0, MAX_VALUE_LENGTH) : text;
  };

  // rule 8: every supplied arg VALUE is clamped to 4KB up front, before it
  // is ever used in a template substitution -- not only extracted result
  // values.
  const rawArgs = (input.args && typeof input.args === 'object' && !Array.isArray(input.args))
    ? input.args
    : {};
  const suppliedArgs = {};
  for (const key of Object.keys(rawArgs)) {
    const value = rawArgs[key];
    suppliedArgs[key] = typeof value === 'string' ? boundString(value) : value;
  }

  const locatorFallbacks = [];

  // ONE listener for the whole run, registered before anything else can
  // fail (rule 5 says "at runner start", taken literally: first, before
  // even argument validation) so the `finally` below can unconditionally
  // cover every failure path, including the earliest ones. Removed again
  // in `finally` so a page reused across many replay calls never
  // accumulates one per call.
  let latestChooser = null;
  const onFileChooser = (chooser) => { latestChooser = chooser; };
  page.on('filechooser', onFileChooser);

  const fail = (shape) => {
    throw new Error(`FLOW_RUNNER_FAILURE: ${JSON.stringify(shape)}`);
  };
  const failArgs = (message) => fail({
    failedStep: 'args',
    error: message,
    url: page.url(),
    stepsCompleted: 0,
    locatorFallbacks: [],
  });

  // page.url()'s own scheme://host[:port] prefix, computed without a `URL`
  // parser -- this file has no Web platform globals of its own (see the
  // header note), only `page`/`args`. Shaped to match artifact.mjs's own
  // origin validation: scheme, authority, nothing else.
  const ORIGIN_PREFIX = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*/;
  const originOf = (href) => {
    const match = ORIGIN_PREFIX.exec(typeof href === 'string' ? href : '');
    return match ? match[0] : null;
  };

  // {arg} substitution: only a token whose name is a known, supplied string
  // argument is replaced; anything else -- an unrecognised name, a stray
  // brace -- is left exactly as written rather than raising. Values are
  // already clamped to 4KB (see `suppliedArgs` above), so a substitution
  // can never inject more than that.
  const TOKEN = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  const template = (text) => {
    if (typeof text !== 'string') return text;
    return text.replace(TOKEN, (whole, name) => (
      typeof suppliedArgs[name] === 'string' ? suppliedArgs[name] : whole
    ));
  };

  // --- rule 4: target resolution ---
  // `target.role`/`target.name` (recorded on the TARGET once, not per
  // candidate) win over a bare `role=...` selector whenever both are
  // present -- it is the more re-derivable of the two forms. Every other
  // kind, and a `role` candidate without a name, addresses through
  // `page.locator()` verbatim, which also accepts the `internal:`-prefixed
  // strings Playwright's own selectors can carry.
  const candidateLocator = (target, candidate) => (
    candidate.kind === 'role' && target.role && target.name
      ? page.getByRole(target.role, { name: target.name })
      : page.locator(candidate.selector)
  );

  // The same resolution precedence as `candidateLocator` above, collapsed
  // to a string: two candidates that would resolve to the identical
  // locator -- same `kind`, same selector they actually probe (a `role`
  // candidate ignores its own `selector` once `target.role`/`target.name`
  // are both set) -- share a key. Used by rung 1 below to probe each
  // distinct locator at most once per pass.
  const candidateKey = (target, candidate) => (
    candidate.kind === 'role' && target.role && target.name
      ? `role:${target.role}:${target.name}`
      : `${candidate.kind}:${candidate.selector}`
  );

  // Walks `target.locators`, probing each DISTINCT candidate (rung 1: two
  // byte-identical candidates are deduplicated up front, since probing the
  // same locator twice teaches the walk nothing the first probe didn't
  // already) with a bounded waitFor before it is trusted.
  //
  // Rung 1 is one pass at 1500ms per deduped candidate; the first one that
  // clears the probe wins outright. Rung 2 fires only when that whole pass
  // comes up empty: one more, probe-only pass over the SAME deduped
  // candidates at 3000ms each, in case the page was merely slow to settle
  // rather than genuinely different -- this never performs the step's own
  // action, only locates; the caller still acts exactly once, after
  // whichever pass returns a locator. Every earlier candidate (and, for
  // rung 2, the whole first pass) having missed is exactly what "a
  // fallback happened" means, so only then is an entry appended to
  // `locatorFallbacks` -- the common case (index 0 hits on the first pass)
  // leaves the list untouched -- and an entry the second pass produced
  // also carries `escalated: true`, absent otherwise. No semantic
  // healing: an empty `locators` array, or every candidate missing across
  // both passes, is a step failure. `part` is an optional tag
  // ('source'/'dest') for `drag`, whose one step resolves two independent
  // targets -- every other op passes it as `undefined` and it is simply
  // omitted from the recorded entry.
  //
  // `dedupeLocators`/`probeCandidates`/`resolveEscalated` are split out of
  // what used to be this function's own body so WS3a Task 3's post-quirk
  // pass can reuse the exact same probe-and-record mechanics for a step's
  // ORIGINAL target -- see `forcedEscalatedOnly` below -- instead of
  // duplicating them.
  const dedupeLocators = (target) => {
    const locators = target && Array.isArray(target.locators) ? target.locators : [];
    const seenKeys = new Set();
    const deduped = [];
    for (let i = 0; i < locators.length; i += 1) {
      const candidate = locators[i];
      const key = candidateKey(target, candidate);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      deduped.push({ candidate, index: i });
    }
    return deduped;
  };

  // One probe pass over an already-deduped candidate list at a single
  // timeout, returning the first hit (or null). Never touches
  // `locatorFallbacks` itself -- that stays the caller's job, since WS3a
  // Task 3's quirk walk below also calls this for a quirk's OWN target,
  // which must never be recorded as a step fallback.
  const probeCandidates = async (target, deduped, timeout, probe) => {
    for (const candidateEntry of deduped) {
      const located = candidateLocator(target, candidateEntry.candidate);
      try {
        await located.waitFor({ timeout, ...probe });
      } catch {
        continue;
      }
      return { located, candidateEntry };
    }
    return null;
  };

  // The escalated, single-pass probe: dedupes fresh (the caller may be
  // probing a target this exact walk never touched before -- WS3a Task
  // 3's post-quirk pass reuses this for the step's original target after
  // rung 1+2 already missed) and, on a hit, ALWAYS records a
  // `locatorFallbacks` entry with `escalated: true` regardless of which
  // candidate index won -- needing the slower timeout at all is the
  // fallback being recorded. Throws the same rung-2 miss message on a
  // miss that `resolveTarget` always has.
  const resolveEscalated = async (target, stepIndex, timeout, probe, part) => {
    const deduped = dedupeLocators(target);
    if (deduped.length === 0) {
      throw new Error('target has no locator candidates');
    }
    const hit = await probeCandidates(target, deduped, timeout, probe);
    if (!hit) {
      throw new Error('no locator candidate matched');
    }
    const entry = {
      step: stepIndex,
      usedKind: hit.candidateEntry.candidate.kind,
      usedIndex: hit.candidateEntry.index,
      escalated: true,
    };
    if (part) entry.part = part;
    locatorFallbacks.push(entry);
    return hit.located;
  };

  // WS3a Task 3: when true, `resolveTarget` below skips straight to the
  // single escalated 3000ms pass instead of running its own rung 1
  // (1500ms) probe first. Set ONLY around the one post-quirk pass a step
  // gets after a successful interrupt dismissal -- never during a step's
  // normal walk -- and always reset in a `finally` immediately after, so
  // it can never leak into a later step or a later target within the same
  // step.
  let forcedEscalatedOnly = false;

  const resolveTarget = async (target, stepIndex, probe, part) => {
    if (forcedEscalatedOnly) {
      return resolveEscalated(target, stepIndex, 3000, probe, part);
    }

    const deduped = dedupeLocators(target);
    if (deduped.length === 0) {
      throw new Error('target has no locator candidates');
    }

    const firstHit = await probeCandidates(target, deduped, 1500, probe);
    if (firstHit) {
      if (firstHit.candidateEntry.index > 0) {
        const entry = {
          step: stepIndex,
          usedKind: firstHit.candidateEntry.candidate.kind,
          usedIndex: firstHit.candidateEntry.index,
        };
        if (part) entry.part = part;
        locatorFallbacks.push(entry);
      }
      return firstHit.located;
    }

    return resolveEscalated(target, stepIndex, 3000, probe, part);
  };

  // --- WS3a Task 2: candidate enrichment for a locator-miss step failure ---
  // A locator-miss (both probe passes above exhausted every deduped
  // candidate -- exactly the `'no locator candidate matched'` throw) is the
  // one failure a host-side heal module can act on: it needs bounded
  // evidence of what the page actually offers so it can propose a
  // replacement locator. Every other failure path -- args validation, a
  // refused js step, a precondition/goto navigation failure, or a step
  // action that throws AFTER its target already resolved -- has nothing a
  // healer could rank against (its target was never the problem, or there
  // was no target), so `candidates` is attached only at the one call site
  // below that checks for this exact message.
  const MAX_CANDIDATES = 12;
  const CANDIDATE_STRING_CAP = 80;
  const MAX_PAYLOAD_LENGTH = 8192; // 8KB, treated as characters (see boundString above)
  // One bounded compound-selector scan rather than one `page.getByRole()`
  // query per role this runner's own targets can use (button, link,
  // textbox, combobox, checkbox, radio, tab, menuitem): a single locator
  // query costs one round trip through the page no matter how many of
  // those roles are actually present, where enumerating each role
  // separately costs one round trip PER role -- up to 8x the work for the
  // same evidence. `button, a, input, select, [role]` covers every element
  // any of those 8 roles could be declared on, explicit or implicit.
  const CANDIDATE_SELECTOR = 'button, a, input, select, [role]';

  const clampCandidateString = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return text.length > CANDIDATE_STRING_CAP ? text.slice(0, CANDIDATE_STRING_CAP) : text;
  };

  // `.all()` snapshots the compound scan's match list in one call; only the
  // first MAX_CANDIDATES elements are ever touched, so a page with
  // hundreds of matches costs the same as one with twelve. Left fully
  // unguarded here -- the ONE call site below wraps this whole function in
  // its own try/catch, so any throw (a missing `.all()`/`.getAttribute()`
  // method, a rejected page call, anything) is caught there rather than
  // handled per-element, matching the documented all-or-nothing degrade.
  // Every per-element call below passes an explicit `{ timeout: 1000 }`,
  // same as every other page wait in this file (1500/3000/1500/5000/5000
  // elsewhere) -- a locator miss is exactly the state where the page is
  // likely to have re-rendered out from under a stale `.all()` handle, and
  // Playwright's own 30s default would otherwise let one stale element
  // stall the whole failure report by up to 30s before this function's
  // own catch (see the call site below) can even fire.
  const collectCandidates = async () => {
    const elements = await page.locator(CANDIDATE_SELECTOR).all();
    const candidates = [];
    for (const element of elements.slice(0, MAX_CANDIDATES)) {
      const [role, name, testid, text] = await Promise.all([
        element.getAttribute('role', { timeout: 1000 }),
        element.getAttribute('aria-label', { timeout: 1000 }),
        element.getAttribute('data-testid', { timeout: 1000 }),
        element.innerText({ timeout: 1000 }),
      ]);
      candidates.push({
        role: clampCandidateString(role),
        name: clampCandidateString(name),
        testid: clampCandidateString(testid),
        text: clampCandidateString(text),
      });
    }
    return candidates;
  };

  // Drops candidates from the END, one at a time, until the WHOLE payload
  // (`shape`'s existing keys plus `candidates`) re-serializes under 8KB --
  // `shape` itself is untouched; the caller assigns whatever this returns.
  const boundCandidatesToPayload = (shape, candidates) => {
    const trimmed = candidates.slice();
    while (
      trimmed.length > 0
      && JSON.stringify({ ...shape, candidates: trimmed }).length > MAX_PAYLOAD_LENGTH
    ) {
      trimmed.pop();
    }
    return trimmed;
  };

  // --- WS3a Task 3: quirk-based interrupt recovery (rung 3) ---
  // v1 quirks are exclusively human/agent-authored through `sites quirk
  // add` (source: 'agent' -- nothing here mines them). Running one during
  // replay is permitted ONLY as interrupt recovery: it only ever runs
  // after a step's full locator walk has already missed (rung 2
  // included), which proves the step's own action never fired. At most
  // one quirk attempt happens per step -- a fresh budget every step, so a
  // later step's own miss is never blocked by an earlier step already
  // having used one -- the quirk's own `action` is `click` only, that
  // click is never attempted a second time, and after it the step gets
  // exactly one more probe-then-act pass. Clicking a matched interrupt
  // element is a dismissal a human already performed once by hand when
  // recording the quirk with `sites quirk add`; that prior, manual
  // dismissal is the consent basis for performing it again here,
  // automatically, during replay.
  //
  // `args.quirks` is embedded by the caller (a later task: `flows find`)
  // and is entirely advisory -- absent or empty disables this rung
  // outright, and every entry is shape-checked before use (`name` a
  // string, `target.locators` an array, `action === 'click'`) so a
  // malformed or non-click entry is skipped silently rather than failing
  // a replay over quirk data this runner never itself validated.
  const rawQuirks = Array.isArray(input.quirks) ? input.quirks : [];
  const quirks = rawQuirks.filter((quirk) => (
    quirk
    && typeof quirk === 'object'
    && typeof quirk.name === 'string'
    && quirk.target
    && typeof quirk.target === 'object'
    && Array.isArray(quirk.target.locators)
    && quirk.action === 'click'
  ));

  // `urlPattern: null` matches the whole origin (always matches); a
  // non-null pattern matches only via an EXACT string match against the
  // current page's PATH -- no query, no hash, no `:id`-style collapse.
  // This file has no URL parser of its own (see `originOf` above), so the
  // path is hand-rolled the same way: everything after the origin
  // prefix, cut at the first `?` or `#`, defaulting to '/' when nothing
  // remains.
  const pathOf = (href) => {
    const text = typeof href === 'string' ? href : '';
    const origin = originOf(text) || '';
    const rest = text.slice(origin.length);
    const cut = rest.search(/[?#]/);
    const path = cut === -1 ? rest : rest.slice(0, cut);
    return path.length > 0 ? path : '/';
  };
  const quirkMatchesUrl = (quirk) => (
    quirk.urlPattern === null ? true : quirk.urlPattern === pathOf(page.url())
  );

  // Walks the shape-checked quirks in order, skipping any whose
  // `urlPattern` does not match the CURRENT page -- checked fresh on
  // every call, never cached, since an earlier step in the same replay
  // may have navigated since the last check. The first one whose own
  // target locator probes present (1500ms, a single pass -- this is a
  // dismissal check, not the step's own walk, so it never escalates) is
  // clicked and its name returned; the click itself is best-effort -- a
  // throw from it is swallowed rather than attempted again, matching the
  // consent ruling above -- and no later quirk is considered once one has
  // been chosen, even when the click itself failed. Returns null, no
  // click performed at all, when nothing matches or nothing is present.
  const dismissInterrupt = async () => {
    for (const quirk of quirks) {
      if (!quirkMatchesUrl(quirk)) continue;
      const deduped = dedupeLocators(quirk.target);
      if (deduped.length === 0) continue;
      let hit;
      try {
        hit = await probeCandidates(quirk.target, deduped, 1500, undefined);
      } catch {
        continue;
      }
      if (!hit) continue;
      try {
        await hit.located.click();
      } catch {
        // Best-effort dismissal: never attempted a second time regardless
        // of outcome (consent ruling above).
      }
      return quirk.name;
    }
    return null;
  };

  // --- rule 5, expect ---
  // 'visible'/'hidden' are handled by resolution itself: Locator#waitFor's
  // own `state` option natively understands both, so the same probe that
  // picks the winning candidate also proves the expected state -- no
  // second call needed. 'enabled'/'disabled'/'checked'/'unchecked' are the
  // other four states the artifact schema allows, and Playwright's
  // waitFor `state` option does not understand any of them (only
  // attached/detached/visible/hidden), so those four resolve against
  // 'attached' -- proving the element exists -- and are then polled
  // directly against the locator's own boolean getters, bounded by the
  // same 1500ms budget every candidate probe uses.
  const expectHolds = async (locator, state) => {
    if (state === 'enabled') return locator.isEnabled();
    if (state === 'disabled') return !(await locator.isEnabled());
    if (state === 'checked') return locator.isChecked();
    return !(await locator.isChecked()); // 'unchecked'
  };
  const pollExpect = async (locator, state) => {
    const deadline = Date.now() + 1500;
    for (;;) {
      if (await expectHolds(locator, state).catch(() => false)) return;
      if (Date.now() >= deadline) throw new Error(`element did not reach expected state: ${state}`);
      await page.waitForTimeout(50);
    }
  };

  // --- rule 5, upload's file-chooser branch ---
  const waitForChooser = async () => {
    const deadline = Date.now() + 5000;
    while (!latestChooser && Date.now() < deadline) {
      await page.waitForTimeout(50);
    }
    const chooser = latestChooser;
    latestChooser = null;
    if (!chooser) throw new Error('timed out waiting for a file chooser');
    return chooser;
  };

  // --- rule 6: a settle wait that can never hang the replay and never
  // rejects -- a single bounded call, not a race against a separate manual
  // timer that would otherwise dangle and could still reject after the
  // page itself has already closed. ---
  const settleNetwork = async () => {
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  };

  try {
    // --- rule 1: minimal shape validation -- just enough for this runner
    // to walk `steps` and reach `origin`/`args`, never a full re-parse. ---
    if (
      !flow
      || typeof flow !== 'object'
      || Array.isArray(flow)
      || flow.schemaVersion !== 1
      || typeof flow.name !== 'string'
      || flow.name.length === 0
      || !Array.isArray(flow.steps)
    ) {
      failArgs('flow must be a schemaVersion 1 artifact with a name and a steps array');
    }
    const steps = flow.steps;
    if (steps.length === 0) failArgs('flow has no steps');
    if (steps.length > MAX_STEPS) failArgs(`flow exceeds the maximum of ${MAX_STEPS} steps`);
    const extractCount = steps.filter((step) => step && step.op === 'extract').length;
    if (extractCount > MAX_EXTRACTS) {
      failArgs(`flow exceeds the maximum of ${MAX_EXTRACTS} extract steps`);
    }

    // --- rule 1: every required arg present, checked before anything else
    // touches the page ---
    const flowArgs = (flow.args && typeof flow.args === 'object' && !Array.isArray(flow.args))
      ? flow.args
      : {};
    for (const name of Object.keys(flowArgs)) {
      const spec = flowArgs[name];
      if (spec && spec.required === true && typeof suppliedArgs[name] !== 'string') {
        failArgs(`missing required arg: ${name}`);
      }
    }

    // --- rule 2: refuse every js step up front, before any page
    // interaction -- a flow this runner is about to refuse is never
    // half-run first. ---
    for (let i = 0; i < steps.length; i += 1) {
      if (steps[i] && steps[i].op === 'js') {
        fail({
          failedStep: i,
          error: 'flow contains an opaque js step; re-record or run manually',
          url: page.url(),
          stepsCompleted: 0,
          locatorFallbacks: [],
        });
      }
    }

    const origin = typeof flow.origin === 'string' ? flow.origin : '';

    // --- rule 3: precondition -- reach the flow's own origin before
    // running anything, including a step 0 that is not itself a goto.
    // ONLY step 0 is eligible to seed the precondition's own navigation --
    // scanning every step for the first goto would happily pick one from
    // the MIDDLE of a compiled segment that legitimately does not start
    // with one, running every step before it against the wrong page. When
    // step 0 IS a goto,
    // the precondition performs its exact navigation and the main loop
    // below then SKIPS index 0 (still counted as completed/run) rather
    // than fetching the entry URL a second time; otherwise the
    // precondition lands on the flow's bare origin root and the main loop
    // still runs every step, step 0 included.
    let startIndex = 0;
    if (origin && originOf(page.url()) !== origin) {
      const first = steps[0];
      const usesStepZero = !!(first && first.op === 'goto' && typeof first.url === 'string');
      const preconditionPath = usesStepZero ? template(first.url) : '/';
      try {
        await page.goto(`${origin}${preconditionPath}`);
        await page.waitForLoadState('domcontentloaded');
      } catch (error) {
        fail({
          failedStep: 0,
          error: `could not reach the flow's origin: ${String(error && error.message)}`,
          url: page.url(),
          stepsCompleted: 0,
          locatorFallbacks,
        });
      }
      if (usesStepZero) startIndex = 1;
    }

    // --- rule 5: the replay loop -- one op per step, no repeats ---
    // `Object.create(null)` rather than `{}`: an `extract` step whose `as`
    // is literally `'__proto__'` must still land as an own key on this
    // object rather than silently reassigning its prototype -- a
    // null-prototype object has no inherited `__proto__` accessor for that
    // assignment to trigger. Spread into a plain object only at the very
    // end, for the return value.
    const result = Object.create(null);
    let extracted = false;

    // The whole per-op switch, extracted so WS3a Task 3's post-quirk pass
    // can run it a second time for the SAME step without duplicating every
    // case. It always calls `resolveTarget` by name, never a passed-in
    // resolver -- `resolveTarget` itself is what changes behavior for
    // that second run, via `forcedEscalatedOnly` above. This keeps "the
    // step's own action happens at most once" intact: the second run is
    // only ever reached from the catch below, and only after the FIRST
    // run's target resolution -- never its action -- has thrown.
    const runStep = async (step, index) => {
      switch (step && step.op) {
        case 'goto': {
          await page.goto(`${origin}${template(step.url)}`);
          await page.waitForLoadState('domcontentloaded');
          break;
        }
        case 'click': {
          const locator = await resolveTarget(step.target, index);
          await locator.click();
          break;
        }
        case 'fill': {
          const locator = await resolveTarget(step.target, index);
          await locator.fill(template(step.value));
          break;
        }
        case 'select': {
          const locator = await resolveTarget(step.target, index);
          await locator.selectOption(template(step.value));
          break;
        }
        case 'press': {
          if (step.target) {
            const locator = await resolveTarget(step.target, index);
            await locator.press(step.key);
          } else {
            await page.keyboard.press(step.key);
          }
          break;
        }
        case 'hover': {
          const locator = await resolveTarget(step.target, index);
          await locator.hover();
          break;
        }
        case 'drag': {
          const source = await resolveTarget(step.target, index, undefined, 'source');
          const destination = await resolveTarget(step.to, index, undefined, 'dest');
          await source.dragTo(destination);
          break;
        }
        case 'upload': {
          const files = (Array.isArray(step.files) ? step.files : []).map((file) => template(file));
          if (step.target) {
            // File inputs are hidden by design (rule M1) -- the default
            // probe's implicit 'visible' state would miss every real
            // one, so this branch resolves against 'attached' instead.
            const locator = await resolveTarget(step.target, index, { state: 'attached' });
            await locator.setInputFiles(files);
          } else {
            const chooser = await waitForChooser();
            await chooser.setFiles(files);
          }
          break;
        }
        case 'wait': {
          const value = Number(step.value);
          const ms = Number.isFinite(value) && value > 0 ? value : 0;
          await page.waitForTimeout(Math.min(ms, 5000));
          break;
        }
        case 'expect': {
          if (step.state === 'visible' || step.state === 'hidden') {
            await resolveTarget(step.target, index, { state: step.state });
          } else {
            const locator = await resolveTarget(step.target, index, { state: 'attached' });
            await pollExpect(locator, step.state);
          }
          break;
        }
        case 'extract': {
          const locator = await resolveTarget(step.target, index);
          const text = await locator.innerText();
          result[step.as] = boundString(text);
          extracted = true;
          break;
        }
        default: {
          throw new Error(`unsupported step op: ${step && step.op}`);
        }
      }
    };

    for (let index = startIndex; index < steps.length; index += 1) {
      const step = steps[index];
      try {
        await runStep(step, index);
      } catch (error) {
        const message = String(error && error.message ? error.message : error);

        // --- WS3a Task 3: one interrupt-recovery pass before failing ---
        // Only a locator miss is eligible (never an action failure after
        // resolution, never args/js/navigation) -- it is the one failure
        // that proves the step's own action never fired (see the doc
        // comment above `dismissInterrupt`). `quirks` empty (rung
        // disabled) skips this whole block, and `quirkAttempted` starts
        // fresh on every step, so an earlier step's attempt (successful or
        // not) never affects a later one.
        let quirkAttempted = null;
        let recovered = false;
        let finalMessage = message;
        if (message === 'no locator candidate matched' && quirks.length > 0) {
          const dismissedQuirk = await dismissInterrupt();
          if (dismissedQuirk) {
            quirkAttempted = dismissedQuirk;
            forcedEscalatedOnly = true;
            try {
              await runStep(step, index);
              recovered = true;
            } catch (secondFailure) {
              finalMessage = String(
                secondFailure && secondFailure.message ? secondFailure.message : secondFailure,
              );
            } finally {
              forcedEscalatedOnly = false;
            }
          }
        }

        // A recovered step falls through here with nothing further to do
        // -- exactly like a step that never missed at all -- since the
        // post-quirk pass just above already ran the step's one act.
        if (!recovered) {
          const shape = {
            failedStep: index,
            error: finalMessage,
            url: page.url(),
            stepsCompleted: index,
            locatorFallbacks,
          };
          // Recorded whenever rung 3 fired, regardless of what the step
          // ultimately failed with: `quirkAttempted` documents that a
          // dismissal was tried, not that the miss itself was (once
          // again) a locator miss -- the post-quirk pass's ACTION can
          // still throw something else, and that failure still deserves
          // the note.
          if (quirkAttempted) shape.quirkAttempted = quirkAttempted;
          // Gated on the exact message `resolveTarget`'s own rung-2 miss
          // throws above -- not "any step failure" -- so an action that
          // throws AFTER its target already resolved (or any other failure
          // sharing this catch) never picks up candidates it has no use for.
          if (finalMessage === 'no locator candidate matched') {
            try {
              const candidates = boundCandidatesToPayload(shape, await collectCandidates());
              if (candidates.length > 0) shape.candidates = candidates;
            } catch {
              // Enrichment must never mask the original step failure: on any
              // collection error, `shape` above (sans `candidates`) is
              // exactly the pre-Task-2 payload.
            }
          }
          fail(shape);
        }
      }

      // Deliberately its OWN try, separate from the action's above: a
      // settle stall or rejection here must never fail a step whose action
      // already completed -- doing so would report `stepsCompleted:
      // index` (this step NOT done) for a mutating action that, in truth,
      // already ran exactly once, inviting a caller to run it again and
      // double-mutate. `settleNetwork` itself never rejects (its own
      // `waitForLoadState` call is already `.catch`-guarded), but this
      // stays a real try/catch rather than relying on that alone, so the
      // "the action completing is what advances stepsCompleted" guarantee
      // holds even if that internal swallow is ever changed.
      if (step.waitAfter && step.waitAfter.networkSettled) {
        try {
          await settleNetwork();
        } catch {
          // A stall or failure here is a soft signal only.
        }
      }
    }

    return {
      ok: true,
      result: extracted ? { ...result } : { completed: true },
      stepsRun: steps.length,
      locatorFallbacks,
      ms: Date.now() - started,
    };
  } finally {
    page.off('filechooser', onFileChooser);
  }
}
