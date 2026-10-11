import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('the bundled Inter font is a woff2 file with its licence beside it', async () => {
  const font = await readFile(new URL('../../assets/fonts/InterVariable.woff2', import.meta.url));
  assert.equal(font.subarray(0, 4).toString('latin1'), 'wOF2');
  const licence = await readFile(new URL('../../assets/fonts/OFL.txt', import.meta.url), 'utf8');
  assert.match(licence, /SIL OPEN FONT LICENSE/i);
});
