/**
 * Library entry for `@heroku-mcp/http-server`.
 *
 * The actual server-boot lives in `./start.js` and is invoked by `./bin.ts`
 * (the CLI binary). Importing this module never starts a server.
 */

export { buildApp } from './app.js';
export { loadConfig } from './config.js';
export { createPool, withTransaction } from './db/pool.js';
export { runMigrations, listAppliedMigrations } from './db/migrate.js';
export { TransportManager } from './mcp/transport.js';
