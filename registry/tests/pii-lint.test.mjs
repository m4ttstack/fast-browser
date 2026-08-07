import assert from 'node:assert/strict';
import test from 'node:test';

import { parseFlow } from '../../lib/flows/artifact.mjs';
import { lintArtifact } from '../lib/pii-lint.mjs';
import { baseFlow, target } from './helpers/fixtures.mjs';

// registry/lib/pii-lint.mjs (WS4b plan, Task 2): reject loudly, never
// sanitize. Two passes over every relevant string field of a flow
// artifact -- see the module's own top comment for the exact scope and the
// WS2b discriminator family this mirrors (lib/flows/compile.mjs's
// isHighEntropyValue/UUID_PATTERN for the entropy check).

test('a clean compiled artifact from the repo\'s real fixtures passes', () => {
  const flow = parseFlow(baseFlow());
  const result = lintArtifact(flow);
  assert.deepEqual(result, { ok: true, reasons: [] });
});

test('a literal email in the flow description rejects with rule "email"', () => {
  const flow = parseFlow(baseFlow({
    description: 'Contact support at jane.doe@example.com if this fails',
  }));
  const result = lintArtifact(flow);
  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, [{ path: 'description', rule: 'email' }]);
});

test('a key-shaped string rejects with rule "secret-pattern"', () => {
  const flow = parseFlow(baseFlow({
    description: 'sk-abcdEFGH12345678ijklMNOP',
  }));
  const result = lintArtifact(flow);
  assert.equal(result.ok, false);
  // A real key-shaped secret is ALSO long/mixed-alphabet/letter+digit, so it
  // legitimately trips 'entropy' too (reject loudly: every true reason is
  // reported, not just the first one found) -- this only pins that
  // 'secret-pattern' is among them, at the right path.
  assert.ok(result.reasons.some((reason) => reason.rule === 'secret-pattern' && reason.path === 'description'));
});

test('each known key-shape prefix is recognized', () => {
  const prefixes = ['sk-abcdEFGH12345678ijklMNOP', 'pk-abcdEFGH12345678ijklMNOP', 'ghp-abcdEFGH12345678ijklMNOP', 'xoxb-abcdEFGH12345678ijklMNOP'];
  for (const value of prefixes) {
    const flow = parseFlow(baseFlow({ description: value }));
    const result = lintArtifact(flow);
    assert.equal(result.ok, false, `expected ${value} to be rejected`);
    assert.ok(
      result.reasons.some((reason) => reason.rule === 'secret-pattern'),
      `expected ${value} to trip secret-pattern`,
    );
  }
});

test('a high-entropy string rejects with rule "entropy"', () => {
  const flow = parseFlow(baseFlow({
    description: 'aB3xQ9zK2mN7pL4vR8tW1yUf',
  }));
  const result = lintArtifact(flow);
  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, [{ path: 'description', rule: 'entropy' }]);
});

test('a UUID is exempt from the entropy rule', () => {
  const flow = parseFlow(baseFlow({
    description: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  }));
  const result = lintArtifact(flow);
  assert.deepEqual(result, { ok: true, reasons: [] });
});

test('a literal in a value-bearing fill step rejects with rule "literal-survived"', () => {
  const flow = parseFlow(baseFlow({
    steps: [
      { op: 'goto', url: '/checkout/{plan}' },
      {
        op: 'fill',
        target: target({
          locators: [{ kind: 'role', selector: 'internal:role=textbox[name="Customer"i]' }],
          description: 'Customer',
          role: 'textbox',
          name: 'Customer',
        }),
        value: 'a raw literal that was never lifted',
      },
      {
        op: 'click',
        target: target(),
        waitAfter: { networkSettled: true },
        mutating: true,
      },
      {
        op: 'expect',
        target: target({
          locators: [{ kind: 'text', selector: 'internal:text="Order placed"' }],
          description: 'Order placed',
          role: undefined,
          name: undefined,
        }),
        state: 'visible',
      },
    ],
  }));
  const result = lintArtifact(flow);
  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, [{ path: 'steps[1].value', rule: 'literal-survived' }]);
});

test('an empty fill value passes the literal-survived check', () => {
  const flow = parseFlow(baseFlow({
    steps: [
      { op: 'goto', url: '/checkout/{plan}' },
      {
        op: 'fill',
        target: target({
          locators: [{ kind: 'role', selector: 'internal:role=textbox[name="Customer"i]' }],
          description: 'Customer',
          role: 'textbox',
          name: 'Customer',
        }),
        value: '',
      },
      {
        op: 'click',
        target: target(),
        waitAfter: { networkSettled: true },
        mutating: true,
      },
      {
        op: 'expect',
        target: target({
          locators: [{ kind: 'text', selector: 'internal:text="Order placed"' }],
          description: 'Order placed',
          role: undefined,
          name: undefined,
        }),
        state: 'visible',
      },
    ],
  }));
  const result = lintArtifact(flow);
  assert.deepEqual(result, { ok: true, reasons: [] });
});

test('a literal upload file path rejects with rule "literal-survived"', () => {
  const flow = parseFlow(baseFlow({
    steps: [
      { op: 'goto', url: '/checkout/{plan}' },
      {
        op: 'upload',
        files: ['/Users/matt/Desktop/resume.pdf'],
      },
      {
        op: 'click',
        target: target(),
        waitAfter: { networkSettled: true },
        mutating: true,
      },
      {
        op: 'expect',
        target: target({
          locators: [{ kind: 'text', selector: 'internal:text="Order placed"' }],
          description: 'Order placed',
          role: undefined,
          name: undefined,
        }),
        state: 'visible',
      },
    ],
  }));
  const result = lintArtifact(flow);
  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, [{ path: 'steps[1].files[0]', rule: 'literal-survived' }]);
});

test('a templated upload file path passes', () => {
  const flow = parseFlow(baseFlow({
    steps: [
      { op: 'goto', url: '/checkout/{plan}' },
      {
        op: 'upload',
        files: ['{file}'],
      },
      {
        op: 'click',
        target: target(),
        waitAfter: { networkSettled: true },
        mutating: true,
      },
      {
        op: 'expect',
        target: target({
          locators: [{ kind: 'text', selector: 'internal:text="Order placed"' }],
          description: 'Order placed',
          role: undefined,
          name: undefined,
        }),
        state: 'visible',
      },
    ],
  }));
  const result = lintArtifact(flow);
  assert.deepEqual(result, { ok: true, reasons: [] });
});

test('a Bearer-token-shaped substring rejects with rule "bearer"', () => {
  const flow = parseFlow(baseFlow({
    description: 'sends Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  }));
  const result = lintArtifact(flow);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((reason) => reason.rule === 'bearer' && reason.path === 'description'));
});

test('reasons carry the exact JSON path of the offending field, including nested step targets', () => {
  const flow = parseFlow(baseFlow({
    steps: [
      { op: 'goto', url: '/checkout/{plan}' },
      {
        op: 'fill',
        target: target({
          locators: [{ kind: 'role', selector: 'internal:role=textbox[name="Customer"i]' }],
          description: 'Customer',
          role: 'textbox',
          name: 'Customer',
        }),
        value: '{customer}',
      },
      {
        op: 'click',
        target: target({
          description: 'jane.doe@example.com',
        }),
        waitAfter: { networkSettled: true },
        mutating: true,
      },
      {
        op: 'expect',
        target: target({
          locators: [{ kind: 'text', selector: 'internal:text="Order placed"' }],
          description: 'Order placed',
          role: undefined,
          name: undefined,
        }),
        state: 'visible',
      },
    ],
  }));
  const result = lintArtifact(flow);
  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, [{ path: 'steps[2].target.description', rule: 'email' }]);
});

test('a locator selector carrying an email rejects at its exact path', () => {
  const flow = parseFlow(baseFlow({
    steps: [
      { op: 'goto', url: '/checkout/{plan}' },
      {
        op: 'fill',
        target: target({
          locators: [{ kind: 'css', selector: '[data-testid="jane.doe@example.com"]' }],
          description: 'Customer',
          role: 'textbox',
          name: 'Customer',
        }),
        value: '{customer}',
      },
      {
        op: 'click',
        target: target(),
        waitAfter: { networkSettled: true },
        mutating: true,
      },
      {
        op: 'expect',
        target: target({
          locators: [{ kind: 'text', selector: 'internal:text="Order placed"' }],
          description: 'Order placed',
          role: undefined,
          name: undefined,
        }),
        state: 'visible',
      },
    ],
  }));
  const result = lintArtifact(flow);
  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, [{ path: 'steps[1].target.locators[0].selector', rule: 'email' }]);
});

test('never mutates the artifact it lints', () => {
  const flow = parseFlow(baseFlow({
    description: 'sk-abcdEFGH12345678ijklMNOP',
  }));
  const snapshot = structuredClone(flow);
  lintArtifact(flow);
  assert.deepEqual(flow, snapshot);
});

test('multiple offending fields each produce their own reason', () => {
  const flow = parseFlow(baseFlow({
    name: 'place-order',
    description: 'jane.doe@example.com',
    steps: [
      { op: 'goto', url: '/checkout/{plan}' },
      {
        op: 'fill',
        target: target({
          locators: [{ kind: 'role', selector: 'internal:role=textbox[name="Customer"i]' }],
          description: 'Customer',
          role: 'textbox',
          name: 'Customer',
        }),
        value: 'a raw literal that was never lifted',
      },
      {
        op: 'click',
        target: target(),
        waitAfter: { networkSettled: true },
        mutating: true,
      },
      {
        op: 'expect',
        target: target({
          locators: [{ kind: 'text', selector: 'internal:text="Order placed"' }],
          description: 'Order placed',
          role: undefined,
          name: undefined,
        }),
        state: 'visible',
      },
    ],
  }));
  const result = lintArtifact(flow);
  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons.sort((a, b) => a.path.localeCompare(b.path)), [
    { path: 'description', rule: 'email' },
    { path: 'steps[1].value', rule: 'literal-survived' },
  ]);
});

// --- fix round 1 ---

// Finding 1 (CRITICAL): 'secret-pattern'/'entropy' were anchored to the
// WHOLE field, so a secret embedded inside a url/selector/prose string
// (surrounded by '/', '?', '=', ':', '"', or a space) passed clean.
// compile.mjs only ever hands isHighEntropyValue ONE already-isolated
// segment; these tests pin that the fixed per-token scan catches a secret
// embedded in each of the four shapes the review named.

test('an entropy secret embedded in a goto url path segment rejects', () => {
  const flow = parseFlow(baseFlow({
    steps: [
      { op: 'goto', url: '/share/aB3xQ9zK2mN7pL4vR8tW1yUf' },
      {
        op: 'fill',
        target: target({
          locators: [{ kind: 'role', selector: 'internal:role=textbox[name="Customer"i]' }],
          description: 'Customer',
          role: 'textbox',
          name: 'Customer',
        }),
        value: '{customer}',
      },
      {
        op: 'click',
        target: target(),
        waitAfter: { networkSettled: true },
        mutating: true,
      },
      {
        op: 'expect',
        target: target({
          locators: [{ kind: 'text', selector: 'internal:text="Order placed"' }],
          description: 'Order placed',
          role: undefined,
          name: undefined,
        }),
        state: 'visible',
      },
    ],
  }));
  const result = lintArtifact(flow);
  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, [{ path: 'steps[0].url', rule: 'entropy' }]);
});

test('a key-shaped secret embedded in a goto query value rejects', () => {
  const flow = parseFlow(baseFlow({
    steps: [
      { op: 'goto', url: '/callback?token=sk-AbCdEfGh12345678ijklMNOP' },
      {
        op: 'fill',
        target: target({
          locators: [{ kind: 'role', selector: 'internal:role=textbox[name="Customer"i]' }],
          description: 'Customer',
          role: 'textbox',
          name: 'Customer',
        }),
        value: '{customer}',
      },
      {
        op: 'click',
        target: target(),
        waitAfter: { networkSettled: true },
        mutating: true,
      },
      {
        op: 'expect',
        target: target({
          locators: [{ kind: 'text', selector: 'internal:text="Order placed"' }],
          description: 'Order placed',
          role: undefined,
          name: undefined,
        }),
        state: 'visible',
      },
    ],
  }));
  const result = lintArtifact(flow);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((reason) => reason.rule === 'secret-pattern' && reason.path === 'steps[0].url'));
});

test('a key-shaped secret embedded in a selector attribute value rejects', () => {
  const flow = parseFlow(baseFlow({
    steps: [
      { op: 'goto', url: '/checkout/{plan}' },
      {
        op: 'fill',
        target: target({
          locators: [{ kind: 'css', selector: '[data-token="sk-AbCdEfGh12345678ijklMNOP"]' }],
          description: 'Customer',
          role: 'textbox',
          name: 'Customer',
        }),
        value: '{customer}',
      },
      {
        op: 'click',
        target: target(),
        waitAfter: { networkSettled: true },
        mutating: true,
      },
      {
        op: 'expect',
        target: target({
          locators: [{ kind: 'text', selector: 'internal:text="Order placed"' }],
          description: 'Order placed',
          role: undefined,
          name: undefined,
        }),
        state: 'visible',
      },
    ],
  }));
  const result = lintArtifact(flow);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some(
    (reason) => reason.rule === 'secret-pattern' && reason.path === 'steps[1].target.locators[0].selector',
  ));
});

test('an entropy secret embedded in free-text description prose rejects', () => {
  const flow = parseFlow(baseFlow({
    description: 'On failure, the token aB3xQ9zK2mN7pL4vR8tW1yUf is logged for support',
  }));
  const result = lintArtifact(flow);
  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, [{ path: 'description', rule: 'entropy' }]);
});

// Finding 2 (IMPORTANT): 'literal-survived' was stricter than the real
// compile contract -- compile.mjs's liftLiteral excludes literals shorter
// than 2 chars and exactly 'true'/'false' from lifting, so a valid
// compiled flow with a checkbox toggle or a single-char fill legitimately
// carries a raw literal there.

test('a compiled-shape flow with a checkbox "true" value and a single-char fill value passes', () => {
  const flow = parseFlow(baseFlow({
    steps: [
      { op: 'goto', url: '/checkout/{plan}' },
      {
        op: 'fill',
        target: target({
          locators: [{ kind: 'role', selector: 'internal:role=checkbox[name="Subscribe"i]' }],
          description: 'Subscribe',
          role: 'checkbox',
          name: 'Subscribe',
        }),
        value: 'true',
      },
      {
        op: 'fill',
        target: target({
          locators: [{ kind: 'role', selector: 'internal:role=textbox[name="Rating"i]' }],
          description: 'Rating',
          role: 'textbox',
          name: 'Rating',
        }),
        value: 'y',
      },
      {
        op: 'click',
        target: target(),
        waitAfter: { networkSettled: true },
        mutating: true,
      },
      {
        op: 'expect',
        target: target({
          locators: [{ kind: 'text', selector: 'internal:text="Order placed"' }],
          description: 'Order placed',
          role: undefined,
          name: undefined,
        }),
        state: 'visible',
      },
    ],
  }));
  const result = lintArtifact(flow);
  assert.deepEqual(result, { ok: true, reasons: [] });
});

test('a multi-char literal that is not "true"/"false" still rejects literal-survived, and email if it looks like one', () => {
  const flow = parseFlow(baseFlow({
    steps: [
      { op: 'goto', url: '/checkout/{plan}' },
      {
        op: 'fill',
        target: target({
          locators: [{ kind: 'role', selector: 'internal:role=textbox[name="Customer"i]' }],
          description: 'Customer',
          role: 'textbox',
          name: 'Customer',
        }),
        value: 'jane@x.com',
      },
      {
        op: 'click',
        target: target(),
        waitAfter: { networkSettled: true },
        mutating: true,
      },
      {
        op: 'expect',
        target: target({
          locators: [{ kind: 'text', selector: 'internal:text="Order placed"' }],
          description: 'Order placed',
          role: undefined,
          name: undefined,
        }),
        state: 'visible',
      },
    ],
  }));
  const result = lintArtifact(flow);
  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons.sort((a, b) => a.rule.localeCompare(b.rule)), [
    { path: 'steps[1].value', rule: 'email' },
    { path: 'steps[1].value', rule: 'literal-survived' },
  ]);
});

test('an un-lifted short/boolean literal exemption does NOT extend to upload files', () => {
  const flow = parseFlow(baseFlow({
    steps: [
      { op: 'goto', url: '/checkout/{plan}' },
      {
        op: 'upload',
        files: ['x'],
      },
      {
        op: 'click',
        target: target(),
        waitAfter: { networkSettled: true },
        mutating: true,
      },
      {
        op: 'expect',
        target: target({
          locators: [{ kind: 'text', selector: 'internal:text="Order placed"' }],
          description: 'Order placed',
          role: undefined,
          name: undefined,
        }),
        state: 'visible',
      },
    ],
  }));
  const result = lintArtifact(flow);
  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, [{ path: 'steps[1].files[0]', rule: 'literal-survived' }]);
});

// Finding 3 (IMPORTANT): KEY_SHAPE_PATTERN matched ordinary kebab-case
// prose that merely starts with a key-prefix-shaped substring
// ('skip-...', 'skateboard-...') -- resolveName mints exactly this shape
// from click verbs/path roots. A real key's separator is immediate.

test('ordinary kebab-case names that start with a key-shape prefix do not trip secret-pattern', () => {
  const prose = ['skip-onboarding-and-continue', 'skateboard-2024-checkout'];
  for (const name of prose) {
    const flow = parseFlow(baseFlow({ name }));
    const result = lintArtifact(flow);
    assert.deepEqual(result, { ok: true, reasons: [] }, `expected "${name}" to pass cleanly`);
  }
});

test('real key shapes with either separator are still recognized', () => {
  const values = [
    'sk-AbCdEfGh12345678ijklMNOP',
    'ghp_AbCdEfGh12345678ijklMNOP',
    'xoxb-AbCdEfGh12345678ijklMNOP',
  ];
  for (const value of values) {
    const flow = parseFlow(baseFlow({ description: value }));
    const result = lintArtifact(flow);
    assert.equal(result.ok, false, `expected ${value} to be rejected`);
    assert.ok(
      result.reasons.some((reason) => reason.rule === 'secret-pattern' && reason.path === 'description'),
      `expected ${value} to trip secret-pattern`,
    );
  }
});

// Finding 4 (IMPORTANT): js-step args were never scanned at all. compile.mjs's
// redactScriptArgs redacts VALUES only -- key names survive verbatim -- and
// parseFlow allows arbitrary JSON under args, so it's a real tamper channel
// pass 2 must cover.

test('an email in a js-step arg key rejects at that key\'s path', () => {
  const flow = parseFlow(baseFlow({
    steps: [
      { op: 'goto', url: '/checkout/{plan}' },
      {
        op: 'fill',
        target: target({
          locators: [{ kind: 'role', selector: 'internal:role=textbox[name="Customer"i]' }],
          description: 'Customer',
          role: 'textbox',
          name: 'Customer',
        }),
        value: '{customer}',
      },
      {
        op: 'click',
        target: target(),
        waitAfter: { networkSettled: true },
        mutating: true,
      },
      {
        op: 'js',
        sha256: 'a'.repeat(64),
        args: { 'jane.doe@example.com': '<REDACTED: captured value not stored>' },
      },
    ],
  }));
  const result = lintArtifact(flow);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some(
    (reason) => reason.rule === 'email' && reason.path === 'steps[3].args.jane.doe@example.com',
  ));
});

test('a key-shaped string in a nested js-step arg value rejects at its exact path', () => {
  const flow = parseFlow(baseFlow({
    steps: [
      { op: 'goto', url: '/checkout/{plan}' },
      {
        op: 'fill',
        target: target({
          locators: [{ kind: 'role', selector: 'internal:role=textbox[name="Customer"i]' }],
          description: 'Customer',
          role: 'textbox',
          name: 'Customer',
        }),
        value: '{customer}',
      },
      {
        op: 'click',
        target: target(),
        waitAfter: { networkSettled: true },
        mutating: true,
      },
      {
        op: 'js',
        sha256: 'a'.repeat(64),
        args: { config: { apiKey: 'sk-AbCdEfGh12345678ijklMNOP' } },
      },
    ],
  }));
  const result = lintArtifact(flow);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some(
    (reason) => reason.rule === 'secret-pattern' && reason.path === 'steps[3].args.config.apiKey',
  ));
});

// --- MAT-160: provenance is a tamper channel too (traceDir/compiledAt/
// productVersion/lastHealed are all plain strings that travel inside the
// signed artifact), so pass 2's secret scan covers them -- pass 1's
// literal-survived check does NOT, since provenance is compile-generated
// metadata, never step/value-bearing content. See pii-lint.mjs's top
// comment and `collectFields` comment for the full rationale.

test('an email in provenance.traceDir rejects with rule "email" at path "provenance.traceDir"', () => {
  const flow = parseFlow(baseFlow({
    provenance: {
      compiledAt: '2026-08-05T00:00:00.000Z',
      traceDir: 'trace-jane.doe@example.com',
      seqRange: [3, 9],
      productVersion: '0.1.0-alpha.10',
      successRuns: 0,
      failStreak: 0,
      lastHealed: null,
    },
  }));
  const result = lintArtifact(flow);
  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, [{ path: 'provenance.traceDir', rule: 'email' }]);
});

test('a key-shaped string in provenance.productVersion rejects with rule "secret-pattern" at path "provenance.productVersion"', () => {
  const flow = parseFlow(baseFlow({
    provenance: {
      compiledAt: '2026-08-05T00:00:00.000Z',
      traceDir: 'trace-1754350000000',
      seqRange: [3, 9],
      productVersion: 'sk-AbCdEfGh12345678ijklMNOP',
      successRuns: 0,
      failStreak: 0,
      lastHealed: null,
    },
  }));
  const result = lintArtifact(flow);
  assert.equal(result.ok, false);
  // Same as the plain 'secret-pattern' test above: a real key-shaped value
  // is also long/mixed-alphabet/letter+digit, so it legitimately trips
  // 'entropy' too -- this only pins that 'secret-pattern' is among the
  // reasons, at provenance's own path.
  assert.ok(result.reasons.some(
    (reason) => reason.rule === 'secret-pattern' && reason.path === 'provenance.productVersion',
  ));
});

test('a normal basename traceDir and a real version string in provenance both pass', () => {
  const flow = parseFlow(baseFlow({
    provenance: {
      compiledAt: '2026-08-05T00:00:00.000Z',
      traceDir: 'trace-1754350000000',
      seqRange: [3, 9],
      productVersion: '0.1.0-alpha.10',
      successRuns: 3,
      failStreak: 0,
      lastHealed: '2026-08-04T12:00:00.000Z',
    },
  }));
  const result = lintArtifact(flow);
  assert.deepEqual(result, { ok: true, reasons: [] });
});

test('an absolute-path traceDir carrying a username segment passes clean -- OUT OF SCOPE for the secret scan on purpose', () => {
  // A path segment like "someone" alone is not email-shaped, not
  // key-shaped, and (at 7 chars) far short of the entropy floor -- the
  // scan's four rules genuinely have nothing to catch here. This is a
  // known, accepted gap: the decision behind MAT-160 was secret-scan
  // COVERAGE over provenance's existing rules, not a new path-shape rule.
  // The structural defense against this is upstream, not in this lint --
  // compile.mjs's compileSession always writes traceDir as a bare trace
  // folder BASENAME (see the repo's real fixtures, e.g.
  // "trace-1754350000000"), never an absolute path, so this shape should
  // never occur in a legitimately compiled artifact; it would only appear
  // via direct tampering with a compiled flow file, which pass 1 style
  // guards exist for elsewhere, not here.
  const flow = parseFlow(baseFlow({
    provenance: {
      compiledAt: '2026-08-05T00:00:00.000Z',
      traceDir: '/Users/someone/traces/trace-123',
      seqRange: [3, 9],
      productVersion: '0.1.0-alpha.10',
      successRuns: 0,
      failStreak: 0,
      lastHealed: null,
    },
  }));
  const result = lintArtifact(flow);
  assert.deepEqual(result, { ok: true, reasons: [] });
});
