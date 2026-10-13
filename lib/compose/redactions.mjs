import crypto from 'node:crypto';
import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { writeAtomic } from './files.mjs';

export const REDACTIONS_SCHEMA = 'compose-redactions/1';
export const recordName = (stem) => `${stem}.redactions.json`;
export const cropName = (stem, n) => `${stem}.redact-${n}.png`;
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const serialise = (record) => `${JSON.stringify(record, null, 2)}\n`;

// Case is ignored: on the default macOS volume two spellings name one file.
export function isRedactionArtifact(name, stem) {
  const lower = name.toLowerCase(); const prefix = `${stem.toLowerCase()}.`;
  if (!lower.startsWith(prefix)) return false;
  const rest = lower.slice(prefix.length);
  return rest === 'redactions.json' || /^redact-\d+\.png$/.test(rest);
}

// A board named like another board's crop or record would be deleted, then
// overwritten, when that board renders.
export const isReservedName = (name) => /\.(redact-\d+\.png|redactions\.json)$/i.test(name);

export async function clearRedactionArtifacts(dir, stem) {
  let entries;
  try { entries = await readdir(dir); } catch { return; }
  await Promise.all(entries.filter((name) => isRedactionArtifact(name, stem)).map((name) => rm(path.join(dir, name), { force: true })));
}

// `confine` resolves a bundle file name to a path inside the screenshots folder.
// It runs after the clear, which is what removes a symlink planted at a crop's name.
export async function writeRedactionRecord({ stem, boardPath, boardBytes, crops, confine, fail }) {
  const targets = [];
  for (const index of crops.keys()) targets.push(await confine(cropName(stem, index + 1)));
  const record = await confine(recordName(stem));
  try {
    const redactions = [];
    for (const [index, crop] of crops.entries()) {
      await writeAtomic(targets[index], crop.bytes);
      redactions.push({ crop: cropName(stem, index + 1), sha256: sha256(crop.bytes), panel: crop.panel, confirmed: false });
    }
    await writeAtomic(record, serialise({
      schemaVersion: REDACTIONS_SCHEMA, board: path.basename(boardPath), boardSha256: sha256(boardBytes), redactions,
    }));
  } catch { throw fail('the redaction crops and record could not be written'); }
  return { record, crops: targets };
}

export async function confirmRedactions({ dir, stem, confine, fail }) {
  const recordPath = path.join(dir, recordName(stem));
  let record;
  try { record = JSON.parse(await readFile(recordPath, 'utf8')); } catch { throw fail('this board has no redaction record; render it first'); }
  const entries = record?.redactions;
  if (record?.schemaVersion !== REDACTIONS_SCHEMA || record.board !== `${stem}.png` || !Array.isArray(entries)
    || entries.some((entry, index) => entry?.crop !== cropName(stem, index + 1) || typeof entry.sha256 !== 'string')) {
    throw fail('the redaction record is malformed; render the board again');
  }
  if (entries.length === 0) throw fail('the redaction record holds no redactions; render the board again');
  let board;
  try { board = await readFile(path.join(dir, record.board)); } catch { throw fail('the board is missing; render it again'); }
  if (sha256(board) !== record.boardSha256) throw fail('the board changed since it was rendered; render it again');
  for (const entry of entries) {
    let bytes;
    try { bytes = await readFile(path.join(dir, entry.crop)); } catch { throw fail('a redaction crop is missing; render the board again'); }
    if (sha256(bytes) !== entry.sha256) throw fail('a redaction crop changed since it was rendered; render the board again');
  }
  const target = await confine(recordName(stem));
  try {
    await writeAtomic(target, serialise({ ...record, redactions: entries.map((entry) => ({ ...entry, confirmed: true })) }));
  } catch { throw fail('the redaction record could not be updated'); }
  return { record: target, confirmed: entries.length };
}
