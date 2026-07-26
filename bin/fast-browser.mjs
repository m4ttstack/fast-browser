#!/usr/bin/env node
import { main } from '../lib/cli/main.mjs';
import { parseArgs } from '../lib/cli/parse-args.mjs';

try {
  process.exitCode = await main(parseArgs(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(`fast-browser: ${error.message}\n`);
  process.exitCode = error.exitCode ?? 1;
}
