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
import { envelopeFromLocal, ok, runTool } from '@heroku-mcp/platform';
import type { ToolContext } from '@heroku-mcp/platform';
import { assertFamilyAvailable, getData, seg } from '../client.js';
import { appInput, credentialInput, databaseInput, type PgList, type PgRecord } from '../types.js';

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
        'Detailed status for one Heroku Postgres database — plan, size, status, region, version, HA, connection counts, and timestamps. Wraps GET /client/v11/databases/{database} on the Heroku Data API.',
      inputSchema: databaseInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ database }) =>
      runTool(async () => {
        const res = await getData<PgRecord>(ctx, `/databases/${seg(database)}`, {
          tool: 'pg_info',
        });
        return ok(res);
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
        'List the credentials (roles) on a database with their state. Does NOT return connection strings — use pg_credentials_url to fetch a connection string for a specific credential. Wraps GET /client/v11/databases/{database}/credentials.',
      inputSchema: databaseInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ database }) =>
      runTool(async () => {
        assertFamilyAvailable(ctx, 'pg_credentials', 'Postgres credentials');
        const res = await getData<PgList>(ctx, `/databases/${seg(database)}/credentials`, {
          tool: 'pg_credentials_list',
        });
        // Strip the per-role connection details (user/password/host) so the
        // listing never leaks secrets.
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
        'Return the connection string (URL) for a specific credential on a database. SENSITIVE: the returned URL contains the password — handle it like a secret and do not echo it into logs or shared transcripts. Wraps GET /client/v11/databases/{database}/credentials/{credential}.',
      inputSchema: credentialInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ database, credential }) =>
      runTool(async () => {
        assertFamilyAvailable(ctx, 'pg_credentials', 'Postgres credentials');
        const res = await getData<PgRecord>(
          ctx,
          `/databases/${seg(database)}/credentials/${seg(credential)}`,
          { tool: 'pg_credentials_url' },
        );
        return envelopeFromLocal({ connection_url: connectionUrlFrom(res.body) });
      }),
  );
}

/**
 * Build a `postgres://` connection URL from a Data API credential payload.
 *
 * The Data API returns a credential object whose `credentials` array holds one
 * or more role rows, each with `user`/`password`/`host`/`port`/`database`. We
 * pick the active row (falling back to the first) and assemble a standard libpq
 * URL. Returns null if the payload doesn't carry the expected fields.
 */
export function connectionUrlFrom(body: unknown): string | null {
  const record = obj(body);
  if (!record) return null;
  const rows = Array.isArray(record.credentials) ? (record.credentials as PgList) : [];
  const row = rows.find((r) => str(r.state) === 'active') ?? rows[0];
  if (!row) return null;
  const user = str(row.user);
  const password = str(row.password);
  const host = str(row.host);
  const database = str(row.database);
  if (!user || !host || !database) return null;
  const port = typeof row.port === 'number' ? row.port : (str(row.port) ?? '5432');
  const auth = password ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}` : seg(user);
  return `postgres://${auth}@${host}:${port}/${database}`;
}
