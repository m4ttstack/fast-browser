import path from 'node:path';

import { assertConfinedPath } from './containment.mjs';

// Names, never paths: assertConfinedPath requires its root under dataDir, so
// honouring caller-chosen absolute paths and confining are mutually
// exclusive, and containment wins. The refusal names the field, never the
// value, because the value is caller data and is not safe to echo.
export async function confinedScreenshotPath(paths, name, field, fail) {
  if (typeof name !== 'string' || name.length === 0) throw fail(`${field} is required`);
  const candidate = path.resolve(paths.screenshotsDir, name);
  try {
    await assertConfinedPath({ dataDir: paths.dataDir, rootDir: paths.screenshotsDir, candidate });
  } catch {
    throw fail(`${field} must resolve inside the screenshots directory`);
  }
  return candidate;
}
