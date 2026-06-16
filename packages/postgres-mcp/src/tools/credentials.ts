/**
 * Credential write tools. All hit the `/postgres/v0/*` namespace (HTTP Basic
 * auth) and address the database by add-on NAME. Gated on the `pg_credentials`
 * capability sub-tier.
 *
 *   pg_credentials_create         — add a named credential (role)
 *   pg_credentials_destroy        — remove a named credential   (confirm)
 *   pg_credentials_rotate         — rotate a credential's password (confirm)
 *   pg_credentials_repair_default — reset default-role ownership/grants (confirm)
 *
 * Derived from heroku/cli (commit `main`, fetched 2026-06-09):
 *   src/commands/pg/credentials/create.ts        (this package; POST credentials)
 *   src/commands/pg/credentials/destroy.ts       — default-guard, attachment
 *                                                  pre-check, DELETE credentials
 *   src/commands/pg/credentials/rotate.ts        — body `{forced}`, POST
 *                                                  …/credentials/{cred}/credentials_rotation
 *   src/commands/pg/credentials/repair-default.ts — POST …/repair-default
 *
 * Confirm policy: the CLI confirms each destructive op against the owning *app*
 * name (`new ConfirmCommand().confirm(app, confirm)`). We confirm against the
 * database add-on NAME instead — it is the resource these tools target and our
 * primary input — and surface the expected value in a structured `confirmation`
 * error (core `assertConfirm`). Documented deviation; behaviourally equivalent
 * guard, more specific target.
 *
 * Sensitive data: credential responses carry a clear-text `password`. We strip
 * it on parse, before the envelope is built, so it never reaches the model.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ConflictError,
  InvalidParamsError,
  assertConfirm,
  envelopeFromLocal,
  ok,
  runTool,
} from '@heroku-mcp/core';
import type { ToolContext } from '@heroku-mcp/core';
import { assertFamilyAvailable, deleteDataBasic, postDataBasic, seg } from '../client.js';
import { resolveDatabaseName } from '../resolve.js';
import {
  credentialsCreateInput,
  credentialsDestroyInput,
  credentialsRepairDefaultInput,
  credentialsRotateInput,
  type PgList,
  type PgRecord,
} from '../types.js';

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const obj = (v: unknown): PgRecord | undefined =>
  typeof v === 'object' && v !== null ? (v as PgRecord) : undefined;

/**
 * Remove clear-text passwords from a credential payload, leaving the rest of the
 * structure (uuid/name/state/host/port/database and per-role user/state) intact.
 * Operates on a shallow-then-targeted clone; non-object inputs pass through.
 */
export function redactCredential(body: unknown): unknown {
  const record = obj(body);
  if (!record) return body;
  const out: PgRecord = { ...record };
  delete out.password;
  if (Array.isArray(record.credentials)) {
    out.credentials = (record.credentials as PgList).map((row) => {
      const r = { ...row };
      delete r.password;
      return r;
    });
  }
  return out;
}

/** Register the credential write tools. */
export function registerCredentialWriteTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'pg_credentials_create',
    {
      title: 'Postgres credential (create)',
      description:
        "Create a new named credential (role) on a database. Named credentials require a Standard-tier or higher plan (Essential-tier returns a 403). The new credential's password is stripped from the response — fetch it with pg_credentials_url. Wraps POST /postgres/v0/databases/{database}/credentials (HTTP Basic auth). Derived from heroku/cli pg/credentials/create.ts.",
      inputSchema: credentialsCreateInput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ database, name }) =>
      runTool(async () => {
        assertFamilyAvailable(ctx, 'pg_credentials', 'Postgres credentials');
        const dbName = await resolveDatabaseName(database, ctx, 'pg_credentials_create');
        const res = await postDataBasic<PgRecord>(
          ctx,
          `/databases/${seg(dbName)}/credentials`,
          { name },
          { tool: 'pg_credentials_create' },
        );
        return envelopeFromLocal(redactCredential(res.body));
      }),
  );

  server.registerTool(
    'pg_credentials_destroy',
    {
      title: 'Postgres credential (destroy)',
      description:
        'Destroy a named credential on a database. DESTRUCTIVE: requires confirm set to the database add-on name. Refuses to destroy the "default" credential, and refuses if the credential is still attached to any app (detach it first). Objects owned by the credential are reassigned to the default credential. Wraps DELETE /postgres/v0/databases/{database}/credentials/{name} (HTTP Basic auth). Derived from heroku/cli pg/credentials/destroy.ts.',
      inputSchema: credentialsDestroyInput,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    ({ database, name, confirm }) =>
      runTool(async () => {
        assertFamilyAvailable(ctx, 'pg_credentials', 'Postgres credentials');
        if (name === 'default') {
          throw new InvalidParamsError('The "default" credential cannot be destroyed.', {
            details: { credential: name },
          });
        }
        const dbName = await resolveDatabaseName(database, ctx, 'pg_credentials_destroy');
        assertConfirm({ value: confirm, expected: dbName, targetKind: 'credentials' });

        // Pre-check (mirrors the CLI): refuse while the credential is attached to
        // any app. GET /addons/{name}/addon-attachments on the Platform API and
        // filter the `credential:{name}` namespace.
        const attachmentsRes = await ctx.client.get<PgList>(
          `/addons/${seg(dbName)}/addon-attachments`,
          { tool: 'pg_credentials_destroy' },
        );
        const attachedApps = [
          ...new Set(
            (attachmentsRes.body ?? [])
              .filter((a) => str(a.namespace) === `credential:${name}`)
              .map((a) => str(obj(a.app)?.name) ?? str(obj(a.app)?.id))
              .filter((n): n is string => Boolean(n)),
          ),
        ];
        if (attachedApps.length > 0) {
          throw new ConflictError(
            `Credential "${name}" is attached to ${attachedApps.length > 1 ? 'apps' : 'app'} ${attachedApps.join(', ')}. Detach it before destroying.`,
            { details: { credential: name, attached_apps: attachedApps } },
          );
        }

        await deleteDataBasic<unknown>(ctx, `/databases/${seg(dbName)}/credentials/${seg(name)}`, {
          tool: 'pg_credentials_destroy',
        });
        return envelopeFromLocal({ deleted: true, credential: name, database: dbName });
      }),
  );

  server.registerTool(
    'pg_credentials_rotate',
    {
      title: 'Postgres credential (rotate)',
      description:
        'Rotate a credential\'s password (default credential if "name" is omitted). DESTRUCTIVE: requires confirm set to the database add-on name. Rotating "default" (or any credential with --force) resets all connections and restarts attached apps; otherwise only connections older than 30 minutes are reset. Affects every app the credential is attached to. Wraps POST /postgres/v0/databases/{database}/credentials/{name}/credentials_rotation (HTTP Basic auth). Derived from heroku/cli pg/credentials/rotate.ts.',
      inputSchema: credentialsRotateInput,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    ({ database, name, force, confirm }) =>
      runTool(async () => {
        assertFamilyAvailable(ctx, 'pg_credentials', 'Postgres credentials');
        const dbName = await resolveDatabaseName(database, ctx, 'pg_credentials_rotate');
        assertConfirm({ value: confirm, expected: dbName, targetKind: 'credentials' });
        // CLI body is `{forced: force ?? undefined}` (key is `forced`, not `force`);
        // an absent force sends no body.
        const body = force ? { forced: true } : null;
        const res = await postDataBasic<PgRecord>(
          ctx,
          `/databases/${seg(dbName)}/credentials/${seg(name)}/credentials_rotation`,
          body,
          { tool: 'pg_credentials_rotate' },
        );
        return envelopeFromLocal(redactCredential(res.body), {});
      }),
  );

  server.registerTool(
    'pg_credentials_repair_default',
    {
      title: 'Postgres credential (repair default)',
      description:
        "Reset the default role's permissions and object ownership to factory settings: ownership of objects owned by additional credentials is transferred to the default credential, which is also granted admin option over them. DESTRUCTIVE: requires confirm set to the database add-on name. Not supported on Essential-tier plans. Wraps POST /postgres/v0/databases/{database}/repair-default (HTTP Basic auth). Derived from heroku/cli pg/credentials/repair-default.ts.",
      inputSchema: credentialsRepairDefaultInput,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    ({ database, confirm }) =>
      runTool(async () => {
        assertFamilyAvailable(ctx, 'pg_credentials', 'Postgres credentials');
        const dbName = await resolveDatabaseName(database, ctx, 'pg_credentials_repair_default');
        assertConfirm({ value: confirm, expected: dbName, targetKind: 'credentials' });
        const res = await postDataBasic<PgRecord>(
          ctx,
          `/databases/${seg(dbName)}/repair-default`,
          null,
          { tool: 'pg_credentials_repair_default' },
        );
        return ok(res);
      }),
  );
}
