/**
 * Identifier resolution for Postgres write tools.
 *
 * A database can be addressed three ways, and different Heroku namespaces want
 * different forms:
 *
 *   - **add-on NAME** (`postgresql-dimensional-08540`) — required by the path of
 *     the `/postgres/v0/*` credential endpoints, and the value our destructive
 *     tools expect as `confirm`.
 *   - **add-on UUID** (`d53b5949-…`) — used by `/client/v11/databases/{id}/…`
 *     and `/data/maintenances/v1/{id}/…`.
 *   - **owning APP name** — backups (transfers) are deleted under
 *     `/client/v11/apps/{app}/transfers/{num}`.
 *
 * Each resolver passes the input straight through when it is already in the
 * wanted form (a UUID is recognised by shape; everything else is treated as a
 * name), and otherwise makes a single Platform API `GET /addons/{id}` to derive
 * the canonical fields. We deliberately keep these as small independent lookups
 * rather than a shared per-request cache — a write tool needs at most one or two
 * of these, so the worst case is a single extra round-trip, not the repeated
 * fan-out the cache in the Part B design note was guarding against.
 */

import { NotFoundError } from '@heroku-mcp/core';
import type { ToolContext } from '@heroku-mcp/core';
import { seg } from './client.js';
import type { PgRecord } from './types.js';

/** Canonical add-on UUID shape. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True iff `s` looks like an add-on UUID (vs a `postgresql-…` add-on name). */
export const isUuid = (s: string): boolean => UUID_RE.test(s);

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const obj = (v: unknown): PgRecord | undefined =>
  typeof v === 'object' && v !== null ? (v as PgRecord) : undefined;

/** The fields we derive from a single `GET /addons/{id}` Platform API lookup. */
interface AddonView {
  id: string | undefined;
  name: string | undefined;
  appName: string | undefined;
}

/** One Platform API add-on lookup, accepting either a name or UUID as `{id}`. */
async function fetchAddon(ctx: ToolContext, input: string, tool: string): Promise<AddonView> {
  const res = await ctx.client.get<PgRecord>(`/addons/${seg(input)}`, { tool });
  return {
    id: str(res.body?.id),
    name: str(res.body?.name),
    appName: str(obj(res.body?.app)?.name) ?? str(obj(res.body?.app)?.id),
  };
}

/**
 * Resolve an add-on name OR UUID to the canonical add-on NAME. Names pass
 * through untouched — the `/postgres/v0/*` endpoints accept them directly — so
 * only a UUID triggers a lookup.
 */
export async function resolveDatabaseName(
  input: string,
  ctx: ToolContext,
  tool = 'pg_resolve',
): Promise<string> {
  if (!isUuid(input)) return input;
  const addon = await fetchAddon(ctx, input, tool);
  if (!addon.name) {
    throw new NotFoundError(`No Heroku Postgres add-on found for "${input}".`, {
      details: { database: input },
    });
  }
  return addon.name;
}

/**
 * Resolve an add-on name OR UUID to the add-on UUID. UUIDs pass through; a name
 * triggers a lookup. Used by the `/client/v11/databases/{id}/…` and
 * `/data/maintenances/v1/{id}/…` endpoints.
 */
export async function resolveDatabaseId(
  input: string,
  ctx: ToolContext,
  tool = 'pg_resolve',
): Promise<string> {
  if (isUuid(input)) return input;
  const addon = await fetchAddon(ctx, input, tool);
  if (!addon.id) {
    throw new NotFoundError(`No Heroku Postgres add-on found for "${input}".`, {
      details: { database: input },
    });
  }
  return addon.id;
}

/**
 * Resolve the owning APP name for a database add-on (name or UUID). Always
 * performs the lookup. Backups (transfers) are app-scoped for delete.
 */
export async function resolveOwningApp(
  input: string,
  ctx: ToolContext,
  tool = 'pg_resolve',
): Promise<string> {
  const addon = await fetchAddon(ctx, input, tool);
  if (!addon.appName) {
    throw new NotFoundError(
      `Could not resolve the owning app for database "${input}". Pass an explicit "app" argument.`,
      { details: { database: input } },
    );
  }
  return addon.appName;
}
