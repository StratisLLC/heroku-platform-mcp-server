/**
 * Identifier resolution for Key-Value write tools. Mirrors
 * `@heroku-mcp/postgres`'s resolve.ts.
 *
 * A Key-Value add-on can be addressed two ways, and the Heroku CLI's
 * `redis:*` commands use different forms for different endpoints (verified
 * against the CLI source `src/commands/redis/*.ts`):
 *
 *   - **add-on NAME** (`redis-shallow-89243`) — used by the path of
 *     `redis:maxmemory` / `redis:keyspace-notifications` / `redis:credentials`,
 *     and the value our destructive tools expect as `confirm`.
 *   - **add-on UUID** (`03a8ea32-…`) — used by `redis:timeout` and
 *     `redis:stats-reset`.
 *
 * The `/redis/v0/*` endpoints accept either form interchangeably (verified
 * live 2026-06-10), so resolution is only about matching the CLI's exact call
 * shape and producing the canonical name for the `confirm` guard. Each resolver
 * passes the input straight through when it is already in the wanted form (a
 * UUID is recognised by shape; everything else is treated as a name), and
 * otherwise makes a single Platform API `GET /addons/{id}` to derive the
 * canonical fields.
 */

import { NotFoundError } from '@heroku-mcp/core';
import type { ToolContext } from '@heroku-mcp/platform';
import { seg } from './client.js';
import type { KvRecord } from './types.js';

/** Canonical add-on UUID shape. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True iff `s` looks like an add-on UUID (vs a `redis-…` add-on name). */
export const isUuid = (s: string): boolean => UUID_RE.test(s);

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const obj = (v: unknown): KvRecord | undefined =>
  typeof v === 'object' && v !== null ? (v as KvRecord) : undefined;

/** The fields we derive from a single `GET /addons/{id}` Platform API lookup. */
interface AddonView {
  id: string | undefined;
  name: string | undefined;
  appName: string | undefined;
}

/** One Platform API add-on lookup, accepting either a name or UUID as `{id}`. */
async function fetchAddon(ctx: ToolContext, input: string, tool: string): Promise<AddonView> {
  const res = await ctx.client.get<KvRecord>(`/addons/${seg(input)}`, { tool });
  return {
    id: str(res.body?.id),
    name: str(res.body?.name),
    appName: str(obj(res.body?.app)?.name) ?? str(obj(res.body?.app)?.id),
  };
}

/**
 * Resolve an add-on name OR UUID to the canonical add-on NAME. Names pass
 * through untouched — the `/redis/v0/*` endpoints accept them directly — so
 * only a UUID triggers a lookup.
 */
export async function resolveAddonName(
  input: string,
  ctx: ToolContext,
  tool = 'kv_resolve',
): Promise<string> {
  if (!isUuid(input)) return input;
  const addon = await fetchAddon(ctx, input, tool);
  if (!addon.name) {
    throw new NotFoundError(`No Heroku Key-Value Store add-on found for "${input}".`, {
      details: { addon: input },
    });
  }
  return addon.name;
}

/**
 * Resolve an add-on name OR UUID to the add-on UUID. UUIDs pass through; a name
 * triggers a lookup. Used by `kv_timeout_set` and `kv_stats_reset`, which the
 * CLI addresses by `addon.id`.
 */
export async function resolveAddonId(
  input: string,
  ctx: ToolContext,
  tool = 'kv_resolve',
): Promise<string> {
  if (isUuid(input)) return input;
  const addon = await fetchAddon(ctx, input, tool);
  if (!addon.id) {
    throw new NotFoundError(`No Heroku Key-Value Store add-on found for "${input}".`, {
      details: { addon: input },
    });
  }
  return addon.id;
}

/**
 * Resolve the owning APP name for a Key-Value add-on (name or UUID). Always
 * performs the lookup. Not used by the Part A tools (they are add-on-scoped)
 * but provided for symmetry with `@heroku-mcp/postgres` and future parts.
 */
export async function resolveOwningApp(
  input: string,
  ctx: ToolContext,
  tool = 'kv_resolve',
): Promise<string> {
  const addon = await fetchAddon(ctx, input, tool);
  if (!addon.appName) {
    throw new NotFoundError(
      `Could not resolve the owning app for add-on "${input}". Pass an explicit "app" argument.`,
      { details: { addon: input } },
    );
  }
  return addon.appName;
}
