/**
 * Inventory & info tools (reads).
 *
 *   kv_list — Heroku Key-Value Store add-ons across the account (Platform API)
 *   kv_info — detailed info for one instance (Data API, password stripped)
 *
 * Derived from heroku/cli (commit `main`, fetched 2026-06-10):
 *   src/commands/redis/info.ts + src/lib/redis/api.js
 *     — `redis:info` GETs `/redis/v0/databases/{addon.name}` on api.data.heroku.com
 *       and renders the `info[]` array; the CLI lists instances by filtering an
 *       app's add-ons to the `heroku-redis` service.
 *
 * `kv_list` deviates from the CLI's app-scoped listing: it lists across the
 * whole account (no `app` input, per the Part A handoff). The Heroku Platform
 * API has no server-side service filter — `GET /addons?service=heroku-redis`
 * ignores the query param (verified live 2026-06-10) — and `/addons` is
 * name-paginated, so we page through it following `Next-Range` and filter to
 * the `heroku-redis` add-on service client-side, exactly as the CLI filters its
 * single-app response.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { envelopeFromLocal, runTool } from '@heroku-mcp/platform';
import type { ToolContext } from '@heroku-mcp/platform';
import { getDataBasic, seg } from '../client.js';
import { addonInput, type KvList, type KvRecord } from '../types.js';

/** Heroku add-on service name for Key-Value Store. */
const KEYVALUE_SERVICE = 'heroku-redis';

/** Page size for the account-wide `/addons` scan. */
const LIST_PAGE_SIZE = 1000;
/** Safety cap on pages followed (1000 * 50 = 50k add-ons). If an account
 *  somehow exceeds this we stop and flag truncation rather than loop forever. */
const LIST_MAX_PAGES = 50;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const obj = (v: unknown): KvRecord | undefined =>
  typeof v === 'object' && v !== null ? (v as KvRecord) : undefined;

/** Register the inventory & info read tools. */
export function registerInventoryTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'kv_list',
    {
      title: 'Key-Value stores (list)',
      description:
        'List the Heroku Key-Value Store (Redis) add-ons on the account. Pages through GET /addons (the Platform API has no server-side service filter) and returns a compact summary of each add-on whose service is heroku-redis.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      runTool(async () => {
        const stores: KvRecord[] = [];
        let cursor: string | undefined;
        let truncated = false;
        for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
          const res = await ctx.client.get<KvList>('/addons', {
            tool: 'kv_list',
            headers: { Range: cursor ?? `name ..; max=${LIST_PAGE_SIZE}` },
          });
          for (const a of res.body ?? []) {
            if (str(obj(a?.addon_service)?.name) !== KEYVALUE_SERVICE) continue;
            stores.push({
              addon_id: str(a.id),
              addon_name: str(a.name),
              plan: str(obj(a.plan)?.name),
              status: str(a.state),
              attached_app: str(obj(a.app)?.name) ?? str(obj(a.app)?.id),
              created_at: str(a.created_at),
            });
          }
          if (!res.pagination?.hasMore || !res.pagination.cursor) break;
          cursor = res.pagination.cursor;
          if (page === LIST_MAX_PAGES - 1) truncated = true;
        }
        return envelopeFromLocal(stores, truncated ? { pagination: { hasMore: true } } : {});
      }),
  );

  server.registerTool(
    'kv_info',
    {
      title: 'Key-Value store info',
      description:
        'Detailed status for one Heroku Key-Value Store (Redis) instance — plan, version, status, timeout, maxmemory policy, maintenance window, keyspace notifications, and the info rows shown by `heroku redis:info`. Wraps GET /redis/v0/databases/{addon} on the Heroku Data API. The password-bearing `resource_url` field is stripped; use kv_credentials for a (masked) connection URL.',
      inputSchema: addonInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ addon }) =>
      runTool(async () => {
        const res = await getDataBasic<KvRecord>(ctx, `/databases/${seg(addon)}`, {
          tool: 'kv_info',
        });
        return envelopeFromLocal(redactKvInfo(res.body));
      }),
  );
}

/** Top-level `kv_info` fields that carry the instance password in clear text
 *  and must never reach the model. `resource_url` is a full
 *  `rediss://:password@host:port` connection string; we drop it from the
 *  passed-through body. Callers who need a connection target use kv_credentials,
 *  which returns a MASKED URL plus the bare host/port. */
const KV_INFO_SECRET_FIELDS = ['resource_url'] as const;

/** Strip the password-bearing fields from a `kv_info` body, leaving the `info`
 *  array and every other field intact. Non-object bodies pass through unchanged. */
export function redactKvInfo(body: unknown): unknown {
  const record = obj(body);
  if (!record) return body;
  const out: KvRecord = { ...record };
  for (const f of KV_INFO_SECRET_FIELDS) delete out[f];
  return out;
}
