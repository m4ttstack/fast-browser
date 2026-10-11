import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolvePaths } from '../../../lib/core/paths.mjs';
import { loadRuntimeLock } from '../../../lib/runtime/lock.mjs';
import { rendererExecutable, rendererPlatform } from '../../../lib/compose/renderer.mjs';
import { playwrightCorePath } from '../../../lib/compose/engine.mjs';

const pluginRoot = fileURLToPath(new URL('../../../', import.meta.url));

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

function unavailable(reason) {
  if (process.env.FAST_BROWSER_SKIP_COMPOSE_E2E === '1') return null;
  throw new Error(`${reason}; run \`fast-browser setup\`, set FAST_BROWSER_TEST_RENDERER to a`
    + ' chrome-headless-shell, or set FAST_BROWSER_SKIP_COMPOSE_E2E=1 to skip the compose e2e suites');
}

// The e2e compose tests use the developer's installed runtime and renderer
// read-only (never written). A missing renderer fails loudly, as the other
// e2e helpers do, so a green run can never mean "skipped everything"; only
// FAST_BROWSER_SKIP_COMPOSE_E2E=1 turns that into a skip.
export async function rendererForTests() {
  const paths = resolvePaths();
  const lock = await loadRuntimeLock({ bundledPath: path.join(pluginRoot, 'runtime-lock.json') });
  const playwrightCore = playwrightCorePath(paths, lock);
  if (!(await exists(playwrightCore))) return unavailable('no installed fast-browser runtime for the compose e2e suites');
  const platform = rendererPlatform();
  if (lock.renderer && platform) {
    const executablePath = rendererExecutable(paths, lock, platform);
    if (await exists(executablePath)) return { executablePath, playwrightCore };
  }
  const override = process.env.FAST_BROWSER_TEST_RENDERER;
  if (override && await exists(override)) return { executablePath: override, playwrightCore };
  return unavailable('no compose renderer for the compose e2e suites');
}
