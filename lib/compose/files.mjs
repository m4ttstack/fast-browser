import crypto from 'node:crypto';
import { realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

// A file that does not exist yet still has a real parent folder to resolve through.
async function real(file) {
  try { return await realpath(file); } catch { /* not there yet */ }
  try { return path.join(await realpath(path.dirname(file)), path.basename(file)); } catch { return path.resolve(file); }
}

// The default macOS volume folds case, so two spellings of one name are one
// file there; treating them as one everywhere only ever refuses more.
export async function sameFile(a, b) {
  const [ra, rb] = await Promise.all([real(a), real(b)]);
  return ra === rb || ra.toLowerCase() === rb.toLowerCase();
}

export async function writeAtomic(file, data, mode = 0o600) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temp, data, { mode });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
