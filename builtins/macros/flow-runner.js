async (page, args) => {
  // Replay engine for a compiled flow artifact (WS2a flywheel plan, Task 8).
  // Interprets the wire format lib/flows/artifact.mjs defines and returns
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
  // Every step below runs at most once. A step that throws is reported as
  // a structured failure immediately -- nothing here loops back to run the
  // same action again, which is what makes a `mutating: true` step safe to
  // replay: it either completes zero times (never reached) or exactly one
  // time (attempted, whatever the outcome).
  const started = Date.now();
  const input = args || {};
  const flow = input.flow;
  const suppliedArgs = (input.args && typeof input.args === 'object' && !Array.isArray(input.args))
    ? input.args
    : {};

  const MAX_STEPS = 60;
  const MAX_EXTRACTS = 20;
  const MAX_VALUE_LENGTH = 4096; // 4KB, treated as characters (see boundString)

  const boundString = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return text.length > MAX_VALUE_LENGTH ? text.slice(0, MAX_VALUE_LENGTH) : text;
  };

  const argFail = (message) => ({
    failedStep: 'args',
    error: message,
    url: page.url(),
    stepsCompleted: 0,
    locatorFallbacks: [],
  });

  // --- rule 1: minimal shape validation -- just enough for this runner to
  // walk `steps` and reach `origin`/`args`, never a full re-parse. ---
  if (
    !flow
    || typeof flow !== 'object'
    || Array.isArray(flow)
    || flow.schemaVersion !== 1
    || typeof flow.name !== 'string'
    || flow.name.length === 0
    || !Array.isArray(flow.steps)
  ) {
    return argFail('flow must be a schemaVersion 1 artifact with a name and a steps array');
  }
  const steps = flow.steps;
  if (steps.length === 0) return argFail('flow has no steps');
  if (steps.length > MAX_STEPS) return argFail(`flow exceeds the maximum of ${MAX_STEPS} steps`);
  const extractCount = steps.filter((step) => step && step.op === 'extract').length;
  if (extractCount > MAX_EXTRACTS) {
    return argFail(`flow exceeds the maximum of ${MAX_EXTRACTS} extract steps`);
  }

  // --- rule 1: every required arg present, checked before anything else
  // touches the page ---
  const flowArgs = (flow.args && typeof flow.args === 'object' && !Array.isArray(flow.args))
    ? flow.args
    : {};
  for (const name of Object.keys(flowArgs)) {
    const spec = flowArgs[name];
    if (spec && spec.required === true && typeof suppliedArgs[name] !== 'string') {
      return argFail(`missing required arg: ${name}`);
    }
  }

  // --- rule 2: refuse every js step up front, before any page interaction
  // -- a flow this runner is about to refuse is never half-run first. ---
  for (let i = 0; i < steps.length; i += 1) {
    if (steps[i] && steps[i].op === 'js') {
      return {
        failedStep: i,
        error: 'flow contains an opaque js step; re-record or run manually',
        url: page.url(),
        stepsCompleted: 0,
        locatorFallbacks: [],
      };
    }
  }

  const origin = typeof flow.origin === 'string' ? flow.origin : '';

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
  // brace -- is left exactly as written rather than raising.
  const TOKEN = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  const template = (text) => {
    if (typeof text !== 'string') return text;
    return text.replace(TOKEN, (whole, name) => (
      typeof suppliedArgs[name] === 'string' ? suppliedArgs[name] : whole
    ));
  };

  const locatorFallbacks = [];

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

  // Walks `target.locators` in order, probing each with a bounded waitFor
  // before it is trusted. The first candidate that clears the probe wins;
  // every earlier candidate having missed is exactly what "a fallback
  // happened" means, so only then is an entry appended to
  // `locatorFallbacks` -- the common case (index 0 hits) leaves the list
  // untouched. No semantic healing: an empty `locators` array, or every
  // candidate missing, is a step failure.
  const resolveTarget = async (target, stepIndex, probe) => {
    const locators = target && Array.isArray(target.locators) ? target.locators : [];
    for (let i = 0; i < locators.length; i += 1) {
      const candidate = locators[i];
      const located = candidateLocator(target, candidate);
      try {
        await located.waitFor({ timeout: 1500, ...probe });
      } catch {
        continue;
      }
      if (i > 0) locatorFallbacks.push({ step: stepIndex, usedKind: candidate.kind, usedIndex: i });
      return located;
    }
    throw new Error(
      locators.length === 0 ? 'target has no locator candidates' : 'no locator candidate matched',
    );
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
  // ONE listener for the whole run, removed again in the `finally` below
  // so a page reused across many replay calls never accumulates one per
  // call.
  let latestChooser = null;
  const onFileChooser = (chooser) => { latestChooser = chooser; };
  page.on('filechooser', onFileChooser);
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

  // --- rule 6: a settle wait that can never hang the replay ---
  const settleNetwork = async () => {
    await Promise.race([
      page.waitForLoadState('networkidle').catch(() => {}),
      page.waitForTimeout(5000),
    ]);
  };

  try {
    // --- rule 3: precondition -- reach the flow's own origin before
    // running anything, including a step 0 that is not itself a goto. The
    // main loop below still runs every step from index 0 afterward, so a
    // step 0 that IS a goto to this same path simply navigates again; that
    // redundancy is harmless and simpler than special-casing it away.
    if (origin && originOf(page.url()) !== origin) {
      const firstGoto = steps.find((step) => step && step.op === 'goto');
      const preconditionPath = firstGoto && typeof firstGoto.url === 'string'
        ? template(firstGoto.url)
        : '';
      try {
        await page.goto(`${origin}${preconditionPath}`);
        await page.waitForLoadState('domcontentloaded');
      } catch (error) {
        return {
          failedStep: 0,
          error: `could not reach the flow's origin: ${String(error && error.message)}`,
          url: page.url(),
          stepsCompleted: 0,
          locatorFallbacks,
        };
      }
    }

    // --- rule 5: the replay loop -- one op per step, no repeats ---
    const result = {};
    let extracted = false;
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      try {
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
            const source = await resolveTarget(step.target, index);
            const destination = await resolveTarget(step.to, index);
            await source.dragTo(destination);
            break;
          }
          case 'upload': {
            const files = (Array.isArray(step.files) ? step.files : []).map((file) => template(file));
            if (step.target) {
              const locator = await resolveTarget(step.target, index);
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

        if (step.waitAfter && step.waitAfter.networkSettled) {
          await settleNetwork();
        }
      } catch (error) {
        return {
          failedStep: index,
          error: String(error && error.message ? error.message : error),
          url: page.url(),
          stepsCompleted: index,
          locatorFallbacks,
        };
      }
    }

    return {
      ok: true,
      result: extracted ? result : { completed: true },
      stepsRun: steps.length,
      locatorFallbacks,
      ms: Date.now() - started,
    };
  } finally {
    page.off('filechooser', onFileChooser);
  }
}
