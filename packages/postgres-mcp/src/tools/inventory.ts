/**
 * Inventory & info tools (reads).
 *
 *   pg_list             — Postgres databases attached to an app (Platform API)
 *   pg_info             — detailed info for one database (Data API)
 *   pg_plans            — Heroku Postgres plan catalog (Platform API)
 *   pg_credentials_list — credentials/roles on a database (Data API, redacted)
 *   pg_credentials_url  — connection string for one credential (Data API)
 *
 * `pg_credentials_url` returns a sensitive value (the full connection string,
 * including the password). We never log the response body; the audit log only
 * records the request URL (which carries no secret). If this code ever needs to
 * log a connection string, log only its scheme prefix and length.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assertConfirm } from '@heroku-mcp/core';
import { envelopeFromLocal, ok, runTool } from '@heroku-mcp/platform';
import type { ToolContext } from '@heroku-mcp/platform';
import { assertFamilyAvailable, getData, getDataBasic, postData, seg } from '../client.js';
import { resolveDatabaseId, resolveDatabaseName } from '../resolve.js';
import {
  appInput,
  connectionResetInput,
  credentialInput,
  databaseInput,
  type PgList,
  type PgRecord,
} from '../types.js';

/** Heroku add-on service name for Postgres. */
const POSTGRES_SERVICE = 'heroku-postgresql';

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const obj = (v: unknown): PgRecord | undefined =>
  typeof v === 'object' && v !== null ? (v as PgRecord) : undefined;

/** Register the inventory & info read tools. */
export function registerInventoryTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'pg_list',
    {
      title: 'Postgres databases (list)',
      description:
        'List the Heroku Postgres databases attached to an app. Filters the app\'s add-ons to the heroku-postgresql service and returns a compact summary per database. Wraps GET /apps/{app}/addons.',
      inputSchema: appInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ app }) =>
      runTool(async () => {
        const res = await ctx.client.get<PgList>(`/apps/${seg(app)}/addons`, { tool: 'pg_list' });
        const databases = (res.body ?? [])
          .filter((a) => str(obj(a?.addon_service)?.name) === POSTGRES_SERVICE)
          .map((a) => ({
            addon_id: str(a.id),
            addon_name: str(a.name),
            plan: str(obj(a.plan)?.name),
            status: str(a.state),
            attached_app: str(obj(a.app)?.name) ?? app,
            created_at: str(a.created_at),
          }));
        return envelopeFromLocal(databases);
      }),
  );

  server.registerTool(
    'pg_info',
    {
      title: 'Postgres database info',
      description:
        'Detailed status for one Heroku Postgres database — plan, size, status, version, connection counts, and the info rows shown by `pg:info` (including follower/leader relationships). Wraps GET /client/v11/databases/{database} on the Heroku Data API. The password-bearing `resource_url` field is stripped; use pg_credentials_url for a connection string.',
      inputSchema: databaseInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ database }) =>
      runTool(async () => {
        const res = await getData<PgRecord>(ctx, `/databases/${seg(database)}`, {
          tool: 'pg_info',
        });
        return envelopeFromLocal(redactPgInfo(res.body));
      }),
  );

  server.registerTool(
    'pg_plans',
    {
      title: 'Postgres plans',
      description:
        'List the Heroku Postgres plans available (essential / standard / premium tiers), including price. Wraps GET /addon-services/heroku-postgresql/plans.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      runTool(async () => {
        const res = await ctx.client.get<PgList>(`/addon-services/${POSTGRES_SERVICE}/plans`, {
          tool: 'pg_plans',
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'pg_credentials_list',
    {
      title: 'Postgres credentials (list)',
      description:
        'List the credentials (roles) on a database with their state. Does NOT return connection strings — use pg_credentials_url to fetch a connection string for a specific credential. Wraps GET /postgres/v0/databases/{database}/credentials (HTTP Basic auth).',
      inputSchema: databaseInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ database }) =>
      runTool(async () => {
        assertFamilyAvailable(ctx, 'pg_credentials', 'Postgres credentials');
        const res = await getDataBasic<PgList>(ctx, `/databases/${seg(database)}/credentials`, {
          tool: 'pg_credentials_list',
        });
        // Strip the per-role connection details (user/password/host) so the
        // listing never leaks secrets. The real shape is an array of credential
        // objects, each with `name`/`uuid`/`state` and a `credentials` array of
        // role rows carrying `user`/`password`/`state`.
        const redacted = (res.body ?? []).map((c) => ({
          credential_name: str(c.name) ?? str(c.uuid),
          state: str(c.state),
          roles: Array.isArray(c.credentials)
            ? (c.credentials as PgList).map((r) => ({
                role: str(r.user),
                state: str(r.state),
              }))
            : undefined,
        }));
        return envelopeFromLocal(redacted);
      }),
  );

  server.registerTool(
    'pg_credentials_url',
    {
      title: 'Postgres credential connection string',
      description:
        'Return the connection string (URL) for a specific credential on a database (default credential name: "default"). SENSITIVE: the returned URL contains the password — handle it like a secret and do not echo it into logs or shared transcripts. Wraps GET /postgres/v0/databases/{database}/credentials/{credential} (HTTP Basic auth).',
      inputSchema: credentialInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ database, credential }) =>
      runTool(async () => {
        assertFamilyAvailable(ctx, 'pg_credentials', 'Postgres credentials');
        const res = await getDataBasic<PgRecord>(
          ctx,
          `/databases/${seg(database)}/credentials/${seg(credential)}`,
          { tool: 'pg_credentials_url' },
        );
        return envelopeFromLocal({ connection_url: connectionUrlFrom(res.body) });
      }),
  );

  // Connection management (write). Database-scoped, so it lives alongside the
  // other database-level tools rather than in its own file.
  server.registerTool(
    'pg_connection_reset',
    {
      title: 'Postgres connections (reset)',
      description:
        'Terminate all active connections for all credentials on a database (the `pg:killall` operation). MUTATING: requires confirm set to the database add-on name. Apps will reconnect on their next query. Distinct from killing a single backend PID, which needs a direct Postgres connection and is out of scope. Wraps POST /client/v11/databases/{database}/connection_reset. Derived from heroku/cli pg/killall.ts (the CLI itself takes no confirm; we add one).',
      inputSchema: connectionResetInput,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    ({ database, confirm }) =>
      runTool(async () => {
        const dbName = await resolveDatabaseName(database, ctx, 'pg_connection_reset');
        assertConfirm({ value: confirm, expected: dbName, targetKind: 'addon' });
        const dbId = await resolveDatabaseId(database, ctx, 'pg_connection_reset');
        const res = await postData<PgRecord>(ctx, `/databases/${seg(dbId)}/connection_reset`, null, {
          tool: 'pg_connection_reset',
        });
        return ok(res);
      }),
  );
}

/** Top-level `pg_info` fields that carry the database password in clear text and
 *  must never reach the model. `resource_url` is a full `postgres://user:pass@…`
 *  connection string; we drop it from the passed-through body. Callers who need
 *  a connection string use `pg_credentials_url`, which is explicitly sensitive. */
const PG_INFO_SECRET_FIELDS = ['resource_url'] as const;

/** Strip the password-bearing fields from a `pg_info` body, leaving the `info`
 *  array and every other field intact. Non-object bodies pass through unchanged. */
export function redactPgInfo(body: unknown): unknown {
  const record = obj(body);
  if (!record) return body;
  const out: PgRecord = { ...record };
  for (const f of PG_INFO_SECRET_FIELDS) delete out[f];
  return out;
}

/**
 * Build a `postgres://` connection URL from a `/postgres/v0` credential payload.
 *
 * The real Data API shape carries the connection target at the TOP level of the
 * credential object — `host`/`port`/`database` — while the `credentials` array
 * holds role rows with only `user`/`password`/`state`. We pick the active role
 * (falling back to the first) for the user/password and read host/port/database
 * from the enclosing record. For robustness we also accept per-row host/port/
 * database (some payloads may inline them). Returns null if the essential fields
 * (`user`, `host`, `database`) are missing.
 */
export function connectionUrlFrom(body: unknown): string | null {
  const record = obj(body);
  if (!record) return null;
  const rows = Array.isArray(record.credentials) ? (record.credentials as PgList) : [];
  const row = rows.find((r) => str(r.state) === 'active') ?? rows[0];
  if (!row) return null;
  const user = str(row.user);
  const password = str(row.password);
  // Prefer top-level connection fields (the real shape); fall back to the row.
  const host = str(record.host) ?? str(row.host);
  const database = str(record.database) ?? str(row.database);
  const rawPort = record.port ?? row.port;
  if (!user || !host || !database) return null;
  const port = typeof rawPort === 'number' ? rawPort : (str(rawPort) ?? '5432');
  const auth = password ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}` : seg(user);
  return `postgres://${auth}@${host}:${port}/${database}`;
}
