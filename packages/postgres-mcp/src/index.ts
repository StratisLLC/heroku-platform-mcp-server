/**
 * `@heroku-mcp/postgres` — Heroku Postgres MCP tools (Phase 6 Part A: reads +
 * capability probing).
 *
 * This package is a library, not a standalone server. The hosted HTTP server
 * (`@heroku-mcp/http-server`) imports {@link registerPostgresTools} and calls
 * it against the same per-session `McpServer` and `ToolContext` it builds for
 * `@heroku-mcp/platform`, so the user sees one merged tool catalog.
 *
 * Capability probing for the Postgres-specific endpoint families is wired
 * through the Platform server's `extraProbes` option using {@link POSTGRES_PROBES}.
 */

export { registerPostgresTools } from './tools/index.js';
export type { PostgresRegistrationSummary } from './tools/index.js';
export { POSTGRES_PROBES, PG_FAMILY_TIERS, PG_PROBE_IDS } from './probes.js';
export { connectionUrlFrom } from './tools/inventory.js';
export { DATA_API_BASE, DATA_API_PREFIX, dataUrl } from './client.js';
export type { PgFamily } from './client.js';
