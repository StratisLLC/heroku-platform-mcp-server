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
import {
  InvalidParamsError,
  NotFoundError,
  assertConfirm,
  envelopeFromLocal,
  ok,
  runTool,
} from '@heroku-mcp/core';
import type { ToolContext } from '@heroku-mcp/core';
import {
  assertFamilyAvailable,
  dataUrl,
  DATA_API_ACCEPT,
  deleteData,
  getData,
  postData,
  seg,
} from '../client.js';
import { resolveDatabaseId, resolveOwningApp } from '../resolve.js';
import {
  backupInput,
  backupListInput,
  backupsCaptureInput,
  backupsDeleteInput,
  backupsScheduleInput,
  databaseInput,
  type PgList,
  type PgRecord,
} from '../types.js';

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
        const res = await getData<PgRecord>(ctx, `/apps/${seg(appName)}/transfers/${seg(backup)}`, {
          tool: 'pg_backups_info',
        });
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

/** A captured/deleted transfer's `to_url` is a presigned S3 URL carrying an AWS
 *  `secret_access_key` and `session_token`. Strip it before the envelope reaches
 *  the model (mirrors {@link redactPgInfo}'s treatment of `resource_url`). The
 *  `from_url` is a credential-free `postgres://host:port/db` string and is kept. */
export function redactTransfer(body: unknown): unknown {
  const record = obj(body);
  if (!record) return body;
  const out: PgRecord = { ...record };
  delete out.to_url;
  return out;
}

/** IANA timezone map for the schedule `at` parser, copied from heroku/cli
 *  pg/backups/schedule.ts so abbreviations resolve the same way. */
const SCHEDULE_TZ: Record<string, string> = {
  BST: 'Europe/London',
  CDT: 'America/Chicago',
  CEST: 'Europe/Paris',
  CET: 'Europe/Paris',
  CST: 'America/Chicago',
  EDT: 'America/New_York',
  EST: 'America/New_York',
  GMT: 'Europe/London',
  MDT: 'America/Boise',
  MST: 'America/Boise',
  PDT: 'America/Los_Angeles',
  PST: 'America/Los_Angeles',
  Z: 'UTC',
};

/**
 * Parse a schedule `at` string into `{hour, timezone}`, mirroring the CLI's
 * `parseDate` (pg/backups/schedule.ts). The grammar is strict: `HH:00` (minutes
 * must be literally `00`) and an optional timezone (abbreviation or IANA name,
 * defaulting to UTC). `hour` stays a STRING, exactly as the CLI sends it.
 */
export function parseScheduleAt(at: string): { hour: string; timezone: string } {
  const m = /^(0?\d|1\d|2[0-3]):00 ?(\S*)$/.exec(at);
  if (!m) {
    throw new InvalidParamsError(
      `Invalid schedule "${at}": expected "HH:00 [TIMEZONE]" (minutes must be 00).`,
      { details: { at } },
    );
  }
  const hour = m[1] ?? '';
  const tz = m[2] ?? '';
  return { hour, timezone: SCHEDULE_TZ[tz.toUpperCase()] ?? (tz.length > 0 ? tz : 'UTC') };
}

/**
 * Resolve a backup identifier to its numeric `num`. The CLI accepts letter-
 * prefixed names like `b001`/`a002` (`^[abcr](\d+)$`); we additionally accept a
 * bare integer (`1`) for convenience.
 */
export function parseBackupNum(backupId: string): number {
  const digits = /^[abcr]?0*(\d+)$/i.exec(backupId)?.[1];
  const n = digits ? Number.parseInt(digits, 10) : Number.NaN;
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidParamsError(
      `Invalid backup id "${backupId}": expected a backup num like "b001" or "1".`,
      { details: { backup_id: backupId } },
    );
  }
  return n;
}

/**
 * Register the backup write tools (Phase 6 Part B). Derived from heroku/cli
 * (commit `main`, fetched 2026-06-09):
 *   src/commands/pg/backups/capture.ts  — POST /client/v11/databases/{id}/backups
 *   src/commands/pg/backups/delete.ts   — DELETE /client/v11/apps/{app}/transfers/{num}
 *   src/commands/pg/backups/schedule.ts — POST /client/v11/databases/{id}/transfer-schedules
 */
export function registerBackupWriteTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'pg_backups_capture',
    {
      title: 'Postgres backup (capture)',
      description:
        "Capture a new logical backup of a database. Returns the in-progress transfer immediately (it does not wait for completion; check progress with pg_backups_info). The response's signed upload URL (to_url, which carries AWS credentials) is stripped. Wraps POST /client/v11/databases/{database}/backups (empty body). Derived from heroku/cli pg/backups/capture.ts.",
      inputSchema: backupsCaptureInput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ database, wait }) =>
      runTool(async () => {
        assertFamilyAvailable(ctx, 'pg_backups', 'Postgres backups');
        const dbId = await resolveDatabaseId(database, ctx, 'pg_backups_capture');
        const res = await postData<PgRecord>(ctx, `/databases/${seg(dbId)}/backups`, null, {
          tool: 'pg_backups_capture',
        });
        const data = redactTransfer(res.body);
        // `wait` is accepted for CLI parity but capture never polls; when set, we
        // annotate the transfer so the caller knows completion wasn't awaited.
        const annotated =
          wait && obj(data)
            ? {
                ...(data as PgRecord),
                _note:
                  'wait is not supported here; the transfer was started and returned without polling. Use pg_backups_info to check progress.',
              }
            : data;
        return envelopeFromLocal(annotated);
      }),
  );

  server.registerTool(
    'pg_backups_delete',
    {
      title: 'Postgres backup (delete)',
      description:
        'Delete a backup (transfer). DESTRUCTIVE: requires confirm set to the backup_id. Backups are app-scoped; the owning app is resolved from the database unless "app" is given. Wraps DELETE /client/v11/apps/{app}/transfers/{num}. Derived from heroku/cli pg/backups/delete.ts.',
      inputSchema: backupsDeleteInput,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    ({ database, app, backup_id, confirm }) =>
      runTool(async () => {
        assertFamilyAvailable(ctx, 'pg_backups', 'Postgres backups');
        assertConfirm({ value: confirm, expected: backup_id, targetKind: 'transfer' });
        const appName =
          app ??
          (database ? await resolveOwningApp(database, ctx, 'pg_backups_delete') : undefined);
        if (!appName) {
          throw new InvalidParamsError('Provide "app" or "database" to locate the backup.', {
            details: { backup_id },
          });
        }
        const num = parseBackupNum(backup_id);
        const res = await deleteData<PgRecord>(ctx, `/apps/${seg(appName)}/transfers/${num}`, {
          tool: 'pg_backups_delete',
        });
        return envelopeFromLocal(redactTransfer(res.body));
      }),
  );

  server.registerTool(
    'pg_backups_schedule',
    {
      title: 'Postgres backup (schedule)',
      description:
        'Schedule automatic daily backups for a database at a given hour. The "at" string is "HH:00 [TIMEZONE]" (UTC if no timezone). Additive — does not remove existing schedules. Wraps POST /client/v11/databases/{database}/transfer-schedules. Derived from heroku/cli pg/backups/schedule.ts.',
      inputSchema: backupsScheduleInput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ database, at, name }) =>
      runTool(async () => {
        assertFamilyAvailable(ctx, 'pg_backups', 'Postgres backups');
        const dbId = await resolveDatabaseId(database, ctx, 'pg_backups_schedule');
        const { hour, timezone } = parseScheduleAt(at);
        const schedule_name = `${name ?? 'DATABASE'}_URL`;
        const res = await postData<PgRecord>(
          ctx,
          `/databases/${seg(dbId)}/transfer-schedules`,
          { hour, timezone, schedule_name },
          { tool: 'pg_backups_schedule' },
        );
        return ok(res);
      }),
  );
}
