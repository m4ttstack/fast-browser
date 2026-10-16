// Installs only what the compose e2e suites read: the pinned runtime (for its
// playwright-core) and the pinned chromium-headless-shell. A full
// `fast-browser setup` also needs Chrome and a Claude or Codex host, which a
// CI runner has neither of. Both installs are the ones setup itself calls, so
// they verify every download against runtime-lock.json.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolvePaths } from '../../lib/core/paths.mjs';
import { loadRuntimeLock } from '../../lib/runtime/lock.mjs';
import { installRuntime } from '../../lib/runtime/install.mjs';
import { installRenderer } from '../../lib/compose/renderer.mjs';

const pluginRoot = fileURLToPath(new URL('../../', import.meta.url));
const paths = resolvePaths({ pluginRoot });
const lock = await loadRuntimeLock({ bundledPath: path.join(pluginRoot, 'runtime-lock.json') });

const runtime = await installRuntime({ lock, paths, fetch: globalThis.fetch });
const renderer = await installRenderer({ lock, paths, fetch: globalThis.fetch });
console.log(`runtime ${runtime.version ?? lock.productVersion}, renderer ${renderer.revision} at ${renderer.executable}`);
