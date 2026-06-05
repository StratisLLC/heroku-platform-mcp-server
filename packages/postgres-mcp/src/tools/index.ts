/**
 * Postgres MCP tool registration coordinator.
 *
 * The whole tool surface is gated on the `data.postgres` root capability tier
 * (probed by the Platform matrix's `data.postgres_root` probe). When that tier
 * is unavailable — the token can't reach the Heroku Data API at all — no
 * Postgres tools are advertised, so `tools/list` stays honest.
 *
 * Finer-grained families (backups, followers, credentials, query insights) are
 * still registered when the root tier is up; each tool guards its own sub-tier
 * at call time (see {@link assertFamilyAvailable}) so it fails fast with an
 * actionable message instead of a blind 4xx.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { tierAvailable } from '@heroku-mcp/platform';
import type { ToolContext } from '@heroku-mcp/platform';
import { registerBackupTools } from './backups.js';
import { registerConfigTools } from './config.js';
import { registerFollowerTools } from './followers.js';
import { registerInventoryTools } from './inventory.js';

/** Summary of what {@link registerPostgresTools} advertised. */
export interface PostgresRegistrationSummary {
  /** True iff the `data.postgres` root tier was available and tools were registered. */
  postgres: boolean;
}

/** Register every Postgres read tool the capability matrix authorises. */
export function registerPostgresTools(
  server: McpServer,
  ctx: ToolContext,
): PostgresRegistrationSummary {
  if (!tierAvailable(ctx.getCapabilities(), 'data.postgres')) {
    return { postgres: false };
  }
  registerInventoryTools(server, ctx);
  registerBackupTools(server, ctx);
  registerFollowerTools(server, ctx);
  registerConfigTools(server, ctx);
  return { postgres: true };
}
