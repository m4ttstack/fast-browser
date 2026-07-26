import { stdin, stdout } from 'node:process';
import { createInterface as createReadlineInterface } from 'node:readline/promises';

export async function confirmTty({
  input = stdin,
  output = stdout,
  createInterface = createReadlineInterface,
  prompt,
  expected,
} = {}) {
  if (
    input?.isTTY !== true
    || output?.isTTY !== true
    || typeof prompt !== 'string'
    || typeof expected !== 'string'
  ) return false;
  const readline = createInterface({ input, output, terminal: true });
  try {
    return await readline.question(prompt) === expected;
  } finally {
    readline.close();
  }
}
