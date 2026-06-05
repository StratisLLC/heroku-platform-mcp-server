/**
 * Backup tools (reads). All are gated on the `pg_backups` capability sub-tier.
 *
 *   pg_backups_list      — list backups/transfers for a database
 *   pg_backups_info      — detail for one backup
 *   pg_backups_url       — signed, time-limited download URL for a backup
 *   pg_backups_schedules — automatic backup (transfer) schedules
 *
 * Heroku models backups as "transfers" under the Data API. Responses are passed
 * through verbatim — the exact field set evolves and the caller benefits from
 * seeing everything Heroku returns.
 *
 * `pg_backups_url` returns a signed URL that grants temporary read access to the
 * dump. Treat it as sensitive: do not log it or paste it into shared channels.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, runTool } from '@heroku-mcp/platform';
import type { ToolContext } from '@heroku-mcp/platform';
import { assertFamilyAvailable, dataUrl, DATA_API_ACCEPT, getData, seg } from '../client.js';
import { backupInput, databaseInput, type PgList, type PgRecord } from '../types.js';

/** Register the backup read tools. */
export function registerBackupTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'pg_backups_list',
    {
      title: 'Postgres backups (list)',
      description:
        'List the backups for a database (most recent first). Heroku models these as transfers. Wraps GET /client/v11/databases/{database}/backups.',
      inputSchema: databaseInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ database }) =>
      runTool(async () => {
        assertFamilyAvailable(ctx, 'pg_backups', 'Postgres backups');
        const res = await getData<PgList>(ctx, `/databases/${seg(database)}/backups`, {
          tool: 'pg_backups_list',
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'pg_backups_info',
    {
      title: 'Postgres backup info',
      description:
        'Detail for one backup, including transfer status and expiration. Wraps GET /client/v11/databases/{database}/backups/{backup}.',
      inputSchema: backupInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ database, backup }) =>
      runTool(async () => {
        assertFamilyAvailable(ctx, 'pg_backups', 'Postgres backups');
        const res = await getData<PgRecord>(
          ctx,
          `/databases/${seg(database)}/backups/${seg(backup)}`,
          { tool: 'pg_backups_info' },
        );
        return ok(res);
      }),
  );

  server.registerTool(
    'pg_backups_url',
    {
      title: 'Postgres backup download URL',
      description:
        'Return a signed, time-limited download URL for a backup. SENSITIVE: anyone with this URL can download the dump until it expires — do not log or share it. Read-style despite the POST verb: it mints a URL, it does not change the backup. Wraps POST /client/v11/databases/{database}/backups/{backup}/actions/public-url.',
      inputSchema: backupInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ database, backup }) =>
      runTool(async () => {
        assertFamilyAvailable(ctx, 'pg_backups', 'Postgres backups');
        const res = await ctx.client.request<PgRecord>({
          path: dataUrl(`/databases/${seg(database)}/backups/${seg(backup)}/actions/public-url`),
          method: 'POST',
          body: null,
          tool: 'pg_backups_url',
          headers: { Accept: DATA_API_ACCEPT },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'pg_backups_schedules',
    {
      title: 'Postgres backup schedules',
      description:
        'List the automatic backup (transfer) schedules configured on a database. Wraps GET /client/v11/databases/{database}/transfer-schedules.',
      inputSchema: databaseInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ database }) =>
      runTool(async () => {
        assertFamilyAvailable(ctx, 'pg_backups', 'Postgres backups');
        const res = await getData<PgList>(ctx, `/databases/${seg(database)}/transfer-schedules`, {
          tool: 'pg_backups_schedules',
        });
        return ok(res);
      }),
  );
}
