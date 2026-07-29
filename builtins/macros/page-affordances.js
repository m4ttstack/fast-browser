async (page, args) => {
  // Actionable structure for the current page, small enough to keep in context.
  //
  // page-recon says what a page IS. This says what can be DONE to it, which is
  // the gap that made an agent read page-recon and then call browser_snapshot
  // anyway: a full accessibility tree is 5k to 35k tokens, it never leaves the
  // context once read, and it is re-read on every later turn.
  //
  // The whole risk here is confident wrongness. A naive extractor happily
  // emits `{ label: "", selector: "#_R_eqd5_" }` -- no label, and a React id
  // that looks stable and is regenerated on the next render -- so an agent
  // that stores it gets a silent miss later. The rules below therefore refuse
  // more than they emit, and every refusal is counted in `skipped` so the
  // caller knows the digest is partial instead of believing it is complete.
  //
  // Runs with no Node globals in scope (no `process`, no `require`); only
  // `page` and `args` exist. Nothing here writes a file, so unlike
  // capture-annotated it needs no `home` argument.
  const options = args || {};

  const bounded = (value, fallback, cap) => {
    const parsed = Math.floor(Number(value));
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, cap);
  };

  const limits = {
    fields: bounded(options.maxFields, 30, 100),
    buttons: bounded(options.maxButtons, 30, 100),
    links: bounded(options.maxLinks, 40, 150),
    landmarks: bounded(options.maxLandmarks, 12, 40),
    scan: bounded(options.maxScan, 2000, 8000),
    // Deliberately equal to the quoting cap in quotable() below. A label is only
    // ever shortened when it was already too long to appear inside a selector,
    // so a truncated label and its selector can never disagree.
    label: 100,
  };

  // Whether a value can go inside `[attr="..."]` or `role=x[name="..."]`.
  // Refusing quotes, backslashes and control characters is cheaper and safer
  // than escaping them, and a value over 100 characters is not a handle anyone
  // wants in a digest. Character codes rather than escape sequences so the
  // rule reads plainly: 34 is `"`, 92 is `\`, 127 is DEL, under 32 is a
  // control character.
  const quotable = (value) => {
    if (typeof value !== 'string' || value.length < 1 || value.length > 100) return false;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code < 32 || code === 34 || code === 92 || code === 127) return false;
    }
    return true;
  };
  const ROLE_SHAPE = /^[a-z]+$/;
  const ID_SHAPE = /^[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*$/;
  const WORD_SEGMENT = /^[A-Za-z]+$/;
  const WORD_WITH_COUNTER = /^[A-Za-z]+[0-9]{1,3}$/;
  const VOWEL = /[aeiouy]/i;

  // Auto-generated ids are the trap this macro exists to avoid. Enumerating
  // every framework's generator is a losing game (React 18 `:r0:`, React 19
  // `_R_eqd5_`, Radix `radix-:r1:`, Angular Material `mat-input-3`, Ember
  // `ember1054`, Emotion `css-1a2b3c` are only the ones in fashion this year),
  // so this is an ALLOWLIST of what an author-written id looks like rather
  // than a blocklist of what a generated one looks like. Unknown generators
  // then fail closed instead of open.
  //
  // An id is usable only if all of these hold:
  //   1. 2..64 characters matching ID_SHAPE: starts with a letter, ASCII
  //      letters and digits joined by single `-` or `_`. This alone rejects
  //      every colon, bracket, dot and leading-underscore form, and as a bonus
  //      guarantees `#id` needs no CSS escaping.
  //   2. It does not end in a digit. A trailing number is a counter until
  //      proven otherwise, and a counter renumbers when a sibling is inserted.
  //   3. Every `-`/`_` segment is a word, or a word with at most three
  //      trailing digits (`h2`, `col12`). A segment that mixes letters and
  //      digits any other way (`1a2b3c`, `4f2a`, `x7f3k9`) reads as entropy.
  //   4. No all-letter segment of six or more characters without a vowel.
  //   5. No segment over 24 characters.
  //
  // Rules 2 and 3 knowingly over-reject: `section-2` and `step-3` are perfectly
  // good author ids and are refused. That is the safe direction. A wrongly
  // refused id costs the element its place in the digest, where it is COUNTED
  // in `skipped` and the agent can go look; a wrongly accepted id is a silent
  // miss on a later turn, which is the failure this project keeps hitting.
  //
  // What this heuristic cannot catch, stated plainly:
  //   * A generated id made only of letters with a plausible vowel passes.
  //     Google's search box is `id="APjFqb"`, which is machine-minted and
  //     indistinguishable by shape from an abbreviation. Entropy in a short
  //     alphabetic token is not detectable without a dictionary. The blast
  //     radius is limited by ordering, not by this test: `id` is the LAST
  //     strategy, so that box is addressed as `[name="q"]` long before its id
  //     is considered.
  //   * A stable server-rendered id built from a record key (`user-4f2a`) is
  //     refused as entropy even though it is stable for that record.
  //   * Nothing here proves an id survives a re-render. It proves only that
  //     the id does not look machine-minted. A page that hand-writes
  //     `id="r_1_"` is refused and a generator that mimics prose is accepted.
  //   * An id that is stable but duplicated across elements is caught by the
  //     document-wide uniqueness count, not by this function.
  const isAuthoredId = (id) => {
    if (typeof id !== 'string' || id.length < 2 || id.length > 64) return false;
    if (!ID_SHAPE.test(id)) return false;
    if (/[0-9]$/.test(id)) return false;
    for (const segment of id.split(/[-_]/)) {
      if (segment.length > 24) return false;
      const word = WORD_SEGMENT.test(segment);
      if (!word && !WORD_WITH_COUNTER.test(segment)) return false;
      if (word && segment.length >= 6 && !VOWEL.test(segment)) return false;
    }
    return true;
  };

  // Everything the browser can see, and nothing decided. The judgment calls
  // (selector preference, id rejection, bounds, skip accounting) all happen on
  // the caller's side of `evaluate`, where they can be unit tested against a
  // fake page instead of only against a real one.
  const collect = (input) => {
    const SCAN = [
      'input', 'textarea', 'select', 'button', 'a[href]', '[role]',
      '[contenteditable=""]', '[contenteditable="true"]',
    ].join(',');
    const LANDMARK_TAGS = {
      HEADER: 'banner',
      NAV: 'navigation',
      MAIN: 'main',
      ASIDE: 'complementary',
      FOOTER: 'contentinfo',
      FORM: 'form',
      SECTION: 'region',
      SEARCH: 'search',
    };
    const LANDMARK_ROLES = [
      'banner', 'navigation', 'main', 'complementary', 'contentinfo',
      'search', 'form', 'region',
    ];
    const FIELD_ROLES = [
      'checkbox', 'radio', 'combobox', 'textbox', 'searchbox', 'slider',
      'spinbutton', 'listbox', 'switch',
    ];
    const BUTTON_ROLES = ['button', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab'];

    const norm = (text) => String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    const attribute = (element, name) => norm(element.getAttribute(name));

    const hidden = (element) => {
      const style = window.getComputedStyle(element);
      return style.display === 'none'
        || style.visibility === 'hidden'
        || style.visibility === 'collapse';
    };

    const visible = (element) => {
      if (element.hasAttribute('hidden')) return false;
      if (element.closest('[aria-hidden="true"]')) return false;
      if (hidden(element)) return false;
      const rect = element.getBoundingClientRect();
      // Playwright's own notion of visible: a non-empty box and no hiding
      // style. Being scrolled out of the viewport is not hidden, and an
      // element below the fold is still perfectly clickable.
      return rect.width > 0 && rect.height > 0;
    };

    // Accessible-name-ish text content. Follows enough of the accname rules to
    // agree with Playwright on ordinary controls: hidden subtrees contribute
    // nothing, `aria-label` on a descendant wins over its text, and an image
    // contributes its alt text. `budget` bounds the walk so one pathological
    // element cannot dominate the scan.
    const contentName = (element, depth, budget) => {
      let out = '';
      for (const node of element.childNodes) {
        if (budget.left <= 0) break;
        budget.left -= 1;
        if (node.nodeType === 3) {
          out += node.nodeValue;
          continue;
        }
        if (node.nodeType !== 1) continue;
        if (node.getAttribute('aria-hidden') === 'true') continue;
        if (hidden(node)) continue;
        const label = norm(node.getAttribute('aria-label'));
        if (label) {
          out += ` ${label} `;
          continue;
        }
        if (node.tagName === 'IMG') {
          out += ` ${norm(node.getAttribute('alt'))} `;
          continue;
        }
        if (depth > 0) out += ` ${contentName(node, depth - 1, budget)} `;
      }
      return norm(out);
    };

    const referencedName = (element) => {
      const ids = attribute(element, 'aria-labelledby').split(' ').filter(Boolean).slice(0, 8);
      const parts = [];
      for (const id of ids) {
        const target = document.getElementById(id);
        if (target) parts.push(contentName(target, 4, { left: 120 }) || norm(target.textContent));
      }
      return norm(parts.join(' '));
    };

    const explicitRole = (element) => {
      const declared = attribute(element, 'role').toLowerCase().split(' ')[0];
      return declared || '';
    };

    // Only roles a `role=` selector can actually resolve. Where HTML-AAM gives
    // an element no role -- password, file, colour and date inputs, a bare
    // contenteditable -- this returns null so the role strategy is skipped
    // rather than emitting `role=textbox[name="Password"]`, which matches
    // nothing and would be exactly the confident wrongness this macro is for.
    const roleOf = (element) => {
      const declared = explicitRole(element);
      if (declared) return declared;
      const tag = element.tagName;
      if (tag === 'BUTTON') return 'button';
      if (tag === 'A') return element.hasAttribute('href') ? 'link' : null;
      if (tag === 'TEXTAREA') return 'textbox';
      if (tag === 'SELECT') return element.multiple || element.size > 1 ? 'listbox' : 'combobox';
      if (tag === 'INPUT') {
        const type = (element.getAttribute('type') || 'text').toLowerCase();
        if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'range') return 'slider';
        if (type === 'number') return 'spinbutton';
        if (type === 'search') return element.hasAttribute('list') ? 'combobox' : 'searchbox';
        if (type === 'email' || type === 'tel' || type === 'url' || type === 'text') {
          return element.hasAttribute('list') ? 'combobox' : 'textbox';
        }
        return null;
      }
      return null;
    };

    const kindOf = (element, role) => {
      const tag = element.tagName;
      if (tag === 'INPUT') {
        const type = (element.getAttribute('type') || 'text').toLowerCase();
        if (type === 'hidden') return null;
        if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') {
          return 'button';
        }
        return 'field';
      }
      if (tag === 'TEXTAREA' || tag === 'SELECT') return 'field';
      if (BUTTON_ROLES.indexOf(role) >= 0) return 'button';
      if (tag === 'BUTTON') return 'button';
      if (role === 'link') return 'link';
      if (tag === 'A' && element.hasAttribute('href')) return 'link';
      if (FIELD_ROLES.indexOf(role) >= 0) return 'field';
      if (element.isContentEditable) return 'field';
      return null;
    };

    const typeOf = (element) => {
      const tag = element.tagName;
      if (tag === 'TEXTAREA') return 'textarea';
      if (tag === 'SELECT') return element.multiple ? 'select-multiple' : 'select';
      if (tag === 'INPUT') return (element.getAttribute('type') || 'text').toLowerCase();
      if (element.isContentEditable) return 'contenteditable';
      return explicitRole(element) || tag.toLowerCase();
    };

    const labels = new Map();
    for (const label of document.querySelectorAll('label[for]')) {
      const target = label.getAttribute('for');
      if (target && !labels.has(target)) labels.set(target, label);
    }

    const fieldName = (element) => {
      const referenced = referencedName(element) || attribute(element, 'aria-label');
      if (referenced) return referenced;
      const id = element.getAttribute('id');
      const associated = id ? labels.get(id) : null;
      if (associated) {
        const text = contentName(associated, 4, { left: 120 });
        if (text) return text;
      }
      const wrapper = element.closest('label');
      if (wrapper) {
        const text = contentName(wrapper, 4, { left: 120 });
        if (text) return text;
      }
      return attribute(element, 'placeholder') || attribute(element, 'title');
    };

    const actionName = (element) => {
      const referenced = referencedName(element) || attribute(element, 'aria-label');
      if (referenced) return referenced;
      if (element.tagName === 'INPUT') {
        const type = (element.getAttribute('type') || '').toLowerCase();
        // An image button's name is its alt text; every other input button's
        // name is its `value`. A submit with neither has a browser-supplied,
        // locale-dependent default that is not readable from here, so it is
        // reported unlabelled rather than guessed at.
        if (type === 'image') return attribute(element, 'alt') || attribute(element, 'title');
        return attribute(element, 'value') || attribute(element, 'title');
      }
      return contentName(element, 5, { left: 200 }) || attribute(element, 'title');
    };

    // One document-wide pass, so a candidate can be told whether the attribute
    // it would be addressed by is unique WITHOUT a selector per element.
    // Null-prototype tallies: an id of `__proto__` or `constructor` would
    // otherwise collide with an inherited property.
    const tally = {
      testid: Object.create(null),
      name: Object.create(null),
      ariaLabel: Object.create(null),
      id: Object.create(null),
    };
    const bump = (into, value) => {
      if (typeof value !== 'string' || value === '') return;
      into[value] = (into[value] || 0) + 1;
    };
    let counted = 0;
    for (const element of document.querySelectorAll('[data-testid],[name],[aria-label],[id]')) {
      if (counted >= 20000) break;
      counted += 1;
      bump(tally.testid, element.getAttribute('data-testid'));
      bump(tally.name, element.getAttribute('name'));
      bump(tally.ariaLabel, element.getAttribute('aria-label'));
      bump(tally.id, element.getAttribute('id'));
    }

    const landmarks = [];
    for (const element of document.querySelectorAll(
      'header,nav,main,aside,footer,form,section,search,[role]',
    )) {
      if (landmarks.length >= input.landmarks * 4) break;
      const declared = explicitRole(element);
      const role = declared
        ? (LANDMARK_ROLES.indexOf(declared) >= 0 ? declared : null)
        : (LANDMARK_TAGS[element.tagName] || null);
      if (!role) continue;
      // A header or footer is only a banner or contentinfo at the top level.
      const nested = element.parentElement
        && element.parentElement.closest('article,aside,main,nav,section');
      if (!declared && nested && (element.tagName === 'HEADER' || element.tagName === 'FOOTER')) {
        continue;
      }
      const label = referencedName(element) || attribute(element, 'aria-label');
      // A form or a plain section is a landmark only once it is named.
      if (!declared && (role === 'form' || role === 'region') && !label) continue;
      if (!visible(element)) continue;
      landmarks.push({ role, label });
    }

    const all = document.querySelectorAll(SCAN);
    const candidates = [];
    let scanned = 0;
    for (const element of all) {
      if (scanned >= input.scan) break;
      scanned += 1;
      const role = roleOf(element);
      const kind = kindOf(element, role || '');
      if (!kind) continue;
      if (!visible(element)) continue;
      const name = kind === 'field' ? fieldName(element) : actionName(element);
      const record = {
        kind,
        role: role && /^[a-z]+$/.test(role) ? role : null,
        name,
        attrs: {
          testid: element.getAttribute('data-testid'),
          name: element.getAttribute('name'),
          ariaLabel: element.getAttribute('aria-label'),
          id: element.getAttribute('id'),
        },
        counts: {
          testid: tally.testid[element.getAttribute('data-testid')] || 0,
          name: tally.name[element.getAttribute('name')] || 0,
          ariaLabel: tally.ariaLabel[element.getAttribute('aria-label')] || 0,
          id: tally.id[element.getAttribute('id')] || 0,
        },
      };
      if (kind === 'field') record.type = typeOf(element);
      if (kind === 'link') record.href = element.href || element.getAttribute('href') || '';
      if (element.disabled === true || element.getAttribute('aria-disabled') === 'true') {
        record.disabled = true;
      }
      candidates.push(record);
    }

    return {
      url: location.href,
      title: document.title,
      landmarks,
      candidates,
      scanTruncated: all.length > scanned,
      scanTotal: all.length,
    };
  };

  let collected = null;
  try {
    collected = await page.evaluate(collect, { scan: limits.scan, landmarks: limits.landmarks });
  } catch (error) {
    return { failedStep: 'collect', error: String(error && error.message), url: page.url() };
  }

  if (!collected || typeof collected !== 'object') {
    return { failedStep: 'collect', error: 'the page returned no structure', url: page.url() };
  }

  const candidates = Array.isArray(collected.candidates) ? collected.candidates : [];

  // Bounded by construction: one entry per (list, reason) pair, never one per
  // element. Mirrors capture-annotated's `missed` list, which is the
  // convention here: never silently omit, always say what could not be
  // resolved and why.
  const skipped = [];
  const skipIndex = new Map();
  const skip = (list, reason, amount) => {
    if (!(amount > 0)) return;
    const key = `${list}|${reason}`;
    const existing = skipIndex.get(key);
    if (existing) {
      existing.count += amount;
      return;
    }
    const entry = { list, reason, count: amount };
    skipIndex.set(key, entry);
    skipped.push(entry);
  };

  // `role=x[name="y"]` is only safe when nothing else on the page answers to
  // it. The Playwright role engine matches the accessible name EXACTLY,
  // measured live rather than assumed: on MDN,
  // `role=button[name="Web APIs"]` resolves to one element and
  // `role=button[name="Web"]` resolves to none. Containment is still treated
  // as ambiguity, because `getByRole`'s own `exact: false` is a substring
  // match and a caller who reaches for it must not silently land on a
  // different control. Refusing both readings costs a few entries and buys a
  // selector that is unique under either.
  const namesByRole = new Map();
  for (const candidate of candidates) {
    if (!candidate || !candidate.role || !candidate.name) continue;
    const bucket = namesByRole.get(candidate.role) || [];
    bucket.push(String(candidate.name).toLowerCase());
    namesByRole.set(candidate.role, bucket);
  }
  const uniqueRoleName = (role, name) => {
    const bucket = namesByRole.get(role) || [];
    // O(n squared) over one role's names, so the containment pass is dropped
    // on absurd pages and uniqueness falls back to exact equality. Stated
    // rather than hidden: past that size the selector is unique under exact
    // matching only.
    const needle = name.toLowerCase();
    let hits = 0;
    if (bucket.length > 400) {
      for (const entry of bucket) if (entry === needle) hits += 1;
      return hits === 1;
    }
    for (const entry of bucket) if (entry.indexOf(needle) >= 0) hits += 1;
    return hits === 1;
  };

  // Preference order, most re-derivable first. An agent can read a role and an
  // accessible name straight off the page and off this digest, so that comes
  // first; `data-testid` is written to be addressed; `name` is semantic and
  // survives restyling; `aria-label` is author-written text; a real id is last
  // because ids are the attribute frameworks most love to mint.
  const resolveSelector = (candidate) => {
    const role = candidate.role;
    const name = typeof candidate.name === 'string' ? candidate.name : '';
    if (role && ROLE_SHAPE.test(role) && name && quotable(name) && uniqueRoleName(role, name)) {
      return { selector: `role=${role}[name="${name}"]` };
    }
    const attrs = candidate.attrs || {};
    const counts = candidate.counts || {};
    for (const [attribute, value, count] of [
      ['data-testid', attrs.testid, counts.testid],
      ['name', attrs.name, counts.name],
      ['aria-label', attrs.ariaLabel, counts.ariaLabel],
    ]) {
      if (quotable(value) && count === 1) return { selector: `[${attribute}="${value}"]` };
    }
    const id = attrs.id;
    if (quotable(id) && isAuthoredId(id) && counts.id === 1) return { selector: `#${id}` };
    if (typeof id === 'string' && id !== '' && !isAuthoredId(id)) {
      return { reason: 'generated-id' };
    }
    return { reason: 'no-stable-selector' };
  };

  const shorten = (text, cap) => (
    text.length > cap ? `${text.slice(0, cap)}...` : text
  );

  const take = (list, entries, limit) => {
    if (entries.length > limit) skip(list, 'over-limit', entries.length - limit);
    return entries.slice(0, limit);
  };

  const fields = [];
  const buttons = [];
  const links = [];
  const seenLinks = new Set();

  for (const candidate of candidates) {
    if (!candidate) continue;
    const list = candidate.kind === 'field'
      ? 'fields'
      : candidate.kind === 'button' ? 'buttons' : candidate.kind === 'link' ? 'links' : null;
    if (!list) continue;
    const name = typeof candidate.name === 'string' ? candidate.name : '';
    // Requirement one of two: no label, no entry. An unlabelled control in a
    // digest is worse than an absent one, because the agent cannot tell the
    // caller what it is about to press.
    if (!name) {
      skip(list, 'no-label', 1);
      continue;
    }
    if (list === 'links') {
      const href = typeof candidate.href === 'string' ? candidate.href : '';
      // Requirement two of two: no address, no entry. A link's address is its
      // href, and a truncated href is a wrong href, so an oversized one is a
      // skip rather than a shortening.
      if (!href || href.length > 500) {
        skip('links', 'no-usable-href', 1);
        continue;
      }
      const key = `${name}\n${href}`;
      if (seenLinks.has(key)) {
        skip('links', 'duplicate', 1);
        continue;
      }
      seenLinks.add(key);
      links.push({ label: shorten(name, limits.label), href });
      continue;
    }
    const resolved = resolveSelector(candidate);
    if (!resolved.selector) {
      skip(list, resolved.reason, 1);
      continue;
    }
    const entry = list === 'fields'
      ? {
        label: shorten(name, limits.label),
        type: typeof candidate.type === 'string' ? candidate.type : 'text',
        selector: resolved.selector,
      }
      : { label: shorten(name, limits.label), selector: resolved.selector };
    if (candidate.disabled === true) entry.disabled = true;
    (list === 'fields' ? fields : buttons).push(entry);
  }

  // Landmarks are orientation, not targets, so they carry no selector and a
  // nameless one still earns its place: knowing a page has a `navigation` and
  // a `main` is the point.
  const landmarks = take(
    'landmarks',
    (Array.isArray(collected.landmarks) ? collected.landmarks : [])
      .filter((entry) => entry && typeof entry.role === 'string' && entry.role !== '')
      .map((entry) => (
        entry.label
          ? { role: entry.role, label: shorten(String(entry.label), 60) }
          : { role: entry.role }
      )),
    limits.landmarks,
  );

  const boundedFields = take('fields', fields, limits.fields);
  const boundedButtons = take('buttons', buttons, limits.buttons);
  const boundedLinks = take('links', links, limits.links);

  if (collected.scanTruncated) {
    skip('page', 'scan-limit', Math.max(0, (collected.scanTotal || 0) - limits.scan));
  }

  return {
    schemaVersion: 1,
    url: collected.url,
    title: collected.title,
    landmarks,
    fields: boundedFields,
    buttons: boundedButtons,
    links: boundedLinks,
    skipped,
  };
}
