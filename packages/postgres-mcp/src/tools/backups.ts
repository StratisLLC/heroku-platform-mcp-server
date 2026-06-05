/**
 * Backup tools (reads). All are gated on the `pg_backups` capability sub-tier.
 *
 *   pg_backups_list      — list backups/transfers for the database's app
 *   pg_backups_info      — detail for one backup
 *   pg_backups_url       — signed, time-limited download URL for a backup
 *   pg_backups_schedules — automatic backup (transfer) schedules
 *
 * Heroku models backups as "transfers". An important asymmetry in Heroku's own
 * API: list/info/url are scoped to the **app** (`/client/v11/apps/{app}/
 * transfers...`), while schedules are scoped to the **database**
 * (`/client/v11/databases/{id}/transfer-schedules`). The list/info/url tools
 * therefore resolve the owning app from the database add-on (via the Platform
 * API) unless the caller passes `app` explicitly.
 *
 * Responses are passed through verbatim — the exact field set evolves and the
 * caller benefits from seeing everything Heroku returns.
 *
 * `pg_backups_url` returns a signed URL that grants temporary read access to the
 * dump. Treat it as sensitive: do not log it or paste it into shared channels.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NotFoundError } from '@heroku-mcp/core';
import { ok, runTool } from '@heroku-mcp/platform';
import type { ToolContext } from '@heroku-mcp/platform';
import { assertFamilyAvailable, dataUrl, DATA_API_ACCEPT, getData, seg } from '../client.js';
import { backupInput, backupListInput, databaseInput, type PgList, type PgRecord } from '../types.js';

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const obj = (v: unknown): PgRecord | undefined =>
  typeof v === 'object' && v !== null ? (v as PgRecord) : undefined;

/**
 * Resolve the owning app for a database add-on. If the caller supplied `app`,
 * trust it. Otherwise look up the add-on on the Platform API and read its
 * `app.name`. Throws {@link NotFoundError} if the add-on has no resolvable app.
 */
async function resolveApp(
  ctx: ToolContext,
  args: { app?: string | undefined; database: string },
  tool: string,
): Promise<string> {
  if (args.app) return args.app;
  const res = await ctx.client.get<PgRecord>(`/addons/${seg(args.database)}`, { tool });
  const appName = str(obj(res.body?.app)?.name) ?? str(obj(res.body?.app)?.id);
  if (!appName) {
    throw new NotFoundError(
      `Could not resolve the owning app for database "${args.database}". Pass an explicit "app" argument.`,
      { details: { database: args.database } },
    );
  }
  return appName;
}

/** Register the backup read tools. */
export function registerBackupTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'pg_backups_list',
    {
      title: 'Postgres backups (list)',
      description:
        'List the backups (transfers) for a database, most recent first. Backups are app-scoped in Heroku, so this resolves the database\'s owning app (or uses the optional "app" argument) and wraps GET /client/v11/apps/{app}/transfers.',
      inputSchema: backupListInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ database, app }) =>
      runTool(async () => {
        assertFamilyAvailable(ctx, 'pg_backups', 'Postgres backups');
        const appName = await resolveApp(ctx, { app, database }, 'pg_backups_list');
        const res = await getData<PgList>(ctx, `/apps/${seg(appName)}/transfers`, {
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
        'Detail for one backup, including transfer status and expiration. Wraps GET /client/v11/apps/{app}/transfers/{backup}. The owning app is resolved from the database unless "app" is given.',
      inputSchema: backupInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ database, app, backup }) =>
      runTool(async () => {
        assertFamilyAvailable(ctx, 'pg_backups', 'Postgres backups');
        const appName = await resolveApp(ctx, { app, database }, 'pg_backups_info');
        const res = await getData<PgRecord>(
          ctx,
          `/apps/${seg(appName)}/transfers/${seg(backup)}`,
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
        'Return a signed, time-limited download URL for a backup. SENSITIVE: anyone with this URL can download the dump until it expires — do not log or share it. Read-style despite the POST verb: it mints a URL, it does not change the backup. Wraps POST /client/v11/apps/{app}/transfers/{backup}/actions/public-url.',
      inputSchema: backupInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ database, app, backup }) =>
      runTool(async () => {
        assertFamilyAvailable(ctx, 'pg_backups', 'Postgres backups');
        const appName = await resolveApp(ctx, { app, database }, 'pg_backups_url');
        const res = await ctx.client.request<PgRecord>({
          path: dataUrl(`/apps/${seg(appName)}/transfers/${seg(backup)}/actions/public-url`),
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
        'List the automatic backup (transfer) schedules configured on a database. Unlike the other backup tools this is database-scoped. Wraps GET /client/v11/databases/{database}/transfer-schedules.',
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
