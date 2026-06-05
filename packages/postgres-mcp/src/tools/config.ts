/**
 * Configuration & monitoring tools (reads).
 *
 *   pg_maintenance_window  — maintenance window settings
 *   pg_connection_pooling  — PgBouncer connection-pooling config
 *   pg_diagnostics         — Heroku's database diagnostics report
 *   pg_query_insights      — top queries by duration (gated on pg_query_insights)
 *
 * All but query insights are gated only on the package-level `data.postgres`
 * root tier. Query insights is a plan-gated feature, so it carries its own
 * sub-tier guard and returns an actionable error when the feature is off.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, runTool } from '@heroku-mcp/platform';
import type { ToolContext } from '@heroku-mcp/platform';
import { assertFamilyAvailable, dataUrl, DATA_API_ACCEPT, getData, seg } from '../client.js';
import { databaseInput, limitInput, type PgList, type PgRecord } from '../types.js';

/** Register the configuration & monitoring read tools. */
export function registerConfigTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'pg_maintenance_window',
    {
      title: 'Postgres maintenance window',
      description:
        'Show the maintenance window settings for a database (day/time the weekly maintenance may run). Wraps GET /client/v11/databases/{database}/maintenance.',
      inputSchema: databaseInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ database }) =>
      runTool(async () => {
        const res = await getData<PgRecord>(ctx, `/databases/${seg(database)}/maintenance`, {
          tool: 'pg_maintenance_window',
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'pg_connection_pooling',
    {
      title: 'Postgres connection pooling',
      description:
        'Show the PgBouncer connection-pooling configuration for a database (enabled, mode, pool sizes). Wraps GET /client/v11/databases/{database}/connection-pooling.',
      inputSchema: databaseInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ database }) =>
      runTool(async () => {
        const res = await getData<PgRecord>(ctx, `/databases/${seg(database)}/connection-pooling`, {
          tool: 'pg_connection_pooling',
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'pg_diagnostics',
    {
      title: 'Postgres diagnostics',
      description:
        "Show Heroku's database diagnostics report (warnings and recommendations). Wraps GET /client/v11/databases/{database}/diagnostics.",
      inputSchema: databaseInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ database }) =>
      runTool(async () => {
        const res = await getData<PgRecord>(ctx, `/databases/${seg(database)}/diagnostics`, {
          tool: 'pg_diagnostics',
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'pg_query_insights',
    {
      title: 'Postgres query insights',
      description:
        'Show the top queries by mean duration from Heroku Postgres query insights. Requires the query insights feature to be enabled on the plan; returns a forbidden error if it is not. Wraps GET /client/v11/databases/{database}/query-stats.',
      inputSchema: { ...databaseInput, ...limitInput },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ database, limit }) =>
      runTool(async () => {
        assertFamilyAvailable(ctx, 'pg_query_insights', 'Postgres query insights');
        const res = await ctx.client.get<PgList>(
          dataUrl(`/databases/${seg(database)}/query-stats`),
          {
            tool: 'pg_query_insights',
            headers: { Accept: DATA_API_ACCEPT },
            query: { limit: limit ?? 20 },
          },
        );
        return ok(res);
      }),
  );
}
