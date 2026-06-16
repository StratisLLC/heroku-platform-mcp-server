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
import { assertConfirm, ok, runTool } from '@heroku-mcp/core';
import type { ToolContext } from '@heroku-mcp/core';
import { getData, postDataMaint, seg } from '../client.js';
import { resolveDatabaseId, resolveDatabaseName } from '../resolve.js';
import { databaseInput, maintenanceWindowSetInput, type PgRecord } from '../types.js';

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

  server.registerTool(
    'pg_maintenance_window_set',
    {
      title: 'Postgres maintenance window (set)',
      description:
        'Set the weekly UTC maintenance window for a database to a day-of-week and time-of-day (e.g. "sunday" + "13:30"). MUTATING: requires confirm set to the database add-on name. Not available on Essential-tier plans. Wraps POST /data/maintenances/v1/{database}/window. Derived from heroku/cli data/maintenances/window/update.ts.',
      inputSchema: maintenanceWindowSetInput,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    ({ database, day_of_week, time_of_day, confirm }) =>
      runTool(async () => {
        const dbName = await resolveDatabaseName(database, ctx, 'pg_maintenance_window_set');
        assertConfirm({ value: confirm, expected: dbName, targetKind: 'addon' });
        const dbId = await resolveDatabaseId(database, ctx, 'pg_maintenance_window_set');
        const res = await postDataMaint<PgRecord>(
          ctx,
          `/${seg(dbId)}/window`,
          { day_of_week, time_of_day },
          { tool: 'pg_maintenance_window_set' },
        );
        return ok(res);
      }),
  );
}
