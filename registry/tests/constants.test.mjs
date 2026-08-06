import assert from 'node:assert/strict';
import test from 'node:test';

import { EMBED_MODEL, REGISTRY_CLUSTER_THRESHOLD } from '../lib/constants.mjs';

// registry/lib/constants.mjs (WS4b plan, Task 5): the one place
// REGISTRY_CLUSTER_THRESHOLD and EMBED_MODEL are pinned. See that module's
// own doc comment for the WS4a drift-harness mis-bind citation the
// threshold's conservatism is based on.

test('REGISTRY_CLUSTER_THRESHOLD is pinned to the plan value', () => {
  assert.equal(REGISTRY_CLUSTER_THRESHOLD, 0.95);
});

test('EMBED_MODEL mirrors lib/flows/encoder.mjs\'s VOYAGE_MODEL', async () => {
  const { VOYAGE_MODEL } = await import('../../lib/flows/encoder.mjs');
  assert.equal(EMBED_MODEL, 'voyage-3.5-lite');
  assert.equal(EMBED_MODEL, VOYAGE_MODEL);
});
