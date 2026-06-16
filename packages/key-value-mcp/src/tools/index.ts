/**
 * Key-Value MCP tool registration coordinator. Mirrors
 * `@heroku-mcp/postgres`'s registration coordinator.
 *
 * The whole tool surface is gated on the `data.redis` root capability tier
 * (probed by the Platform matrix's `data.redis_root` probe). When that tier is
 * unavailable — the token can't reach the Key-Value Data API at all — no
 * Key-Value tools are advertised, so `tools/list` stays honest.
 *
 * The config-write family additionally guards its `kv_config` sub-tier at call
 * time (see {@link assertFamilyAvailable}) so it fails fast with an actionable
 * message instead of a blind 4xx.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { tierAvailable } from '@heroku-mcp/core';
import type { ToolContext } from '@heroku-mcp/core';
import { registerConfigTools } from './config.js';
import { registerCredentialTools } from './credentials.js';
import { registerInventoryTools } from './inventory.js';

/** Summary of what {@link registerKeyValueTools} advertised. */
export interface KeyValueRegistrationSummary {
  /** True iff the `data.redis` root tier was available and tools were registered. */
  keyValue: boolean;
}

/** Register every Key-Value tool the capability matrix authorises. */
export function registerKeyValueTools(
  server: McpServer,
  ctx: ToolContext,
): KeyValueRegistrationSummary {
  if (!tierAvailable(ctx.getCapabilities(), 'data.redis')) {
    return { keyValue: false };
  }
  registerInventoryTools(server, ctx);
  registerCredentialTools(server, ctx);
  registerConfigTools(server, ctx);
  return { keyValue: true };
}
