/**
 * CLI binary for `herokumcp-platform-server`. Imports the library factory and
 * starts the Node HTTP listener.
 */

import { scrubString } from '@heroku-mcp/core';
import { main } from './start.js';

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[fatal] ${scrubString(msg)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
