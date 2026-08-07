// Shared flow-fixture builder for registry tests. Adapted from
// tests/unit/flows-artifact.test.mjs's baseFlow() helper -- duplicated
// rather than imported because that file is a test module, not a library
// export, and the two suites are allowed to drift independently (this one
// only needs a valid, parseable flow shape, not artifact.mjs's own edge
// cases).

export function target(overrides = {}) {
  const built = {
    locators: [{ kind: 'role', selector: 'internal:role=button[name="Place order"i]' }],
    description: 'Place order',
    role: 'button',
    name: 'Place order',
    ...overrides,
  };
  return Object.fromEntries(Object.entries(built).filter(([, value]) => value !== undefined));
}

export function baseFlow(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'a'.repeat(64),
    name: 'place-order',
    description: 'Fill the order form and place an order',
    origin: 'http://localhost:4823',
    urlPattern: '/checkout/:plan',
    sideEffects: 'read-only',
    args: { customer: { type: 'string', required: true } },
    result: { kind: 'extracts', keys: ['confirmationText'] },
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
    provenance: {
      compiledAt: '2026-08-05T00:00:00.000Z',
      traceDir: 'trace-1754350000000',
      seqRange: [3, 9],
      productVersion: '0.1.0-alpha.10',
      successRuns: 0,
      failStreak: 0,
      lastHealed: null,
    },
    ...overrides,
  };
}
