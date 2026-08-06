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
