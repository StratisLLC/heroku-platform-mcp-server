/**
 * Configuration & monitoring tools (reads).
 *
 *   pg_maintenance_window  — maintenance window settings
 *
 * Three tools the original Phase 6 Part A draft assumed are DEFERRED here
 * because no clean read-only Heroku Data API endpoint exists for them (verified
 * live against a real database and against the Heroku CLI source):
 *
 *   - pg_diagnostics      — the CLI posts to a SEPARATE diagnostics service
 *                           (`PGDIAGNOSE_HOST`) with a generated metrics body;
 *                           `/client/v11/databases/{id}/diagnostics` is 404.
 *                           Non-trivial; deferred to a later phase (Correction 7).
 *   - pg_query_insights   — `pg:outliers` reads `pg_stat_statements` over a
 *                           direct database connection, not an HTTP API;
 *                           `/client/v11/databases/{id}/query-stats` is 404.
 *                           Out of scope for an HTTP MCP (Correction 8).
 *   - pg_connection_pooling — the CLI has only `pg:connection-pooling:attach`
 *                           (a mutation that provisions a PgBouncer credential);
 *                           there is no read endpoint, and both guessed paths
 *                           404. Deferred (Correction 9).
 *
 * `pg_maintenance_window` keeps its `/client/v11/databases/{id}/maintenance`
 * (Bearer) path — verified correct: it returns 422 "Maintenance is not available
 * on Essential-tier plans" on small plans, i.e. the endpoint is reachable and the
 * tool surfaces Heroku's own message for plans that don't support it.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, runTool } from '@heroku-mcp/platform';
import type { ToolContext } from '@heroku-mcp/platform';
import { getData, seg } from '../client.js';
import { databaseInput, type PgRecord } from '../types.js';

/** Register the configuration & monitoring read tools. */
export function registerConfigTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'pg_maintenance_window',
    {
      title: 'Postgres maintenance window',
      description:
        'Show the maintenance window settings for a database (day/time the weekly maintenance may run). Not available on Essential-tier plans. Wraps GET /client/v11/databases/{database}/maintenance.',
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
}
