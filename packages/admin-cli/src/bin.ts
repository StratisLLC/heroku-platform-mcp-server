/**
 * CLI binary entry — runs the program. Library consumers import buildProgram
 * from ./index.js.
 */

import { buildProgram } from './index.js';

const program = buildProgram();
program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
});
