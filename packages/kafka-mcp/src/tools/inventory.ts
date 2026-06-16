/**
 * Inventory & info tools (reads).
 *
 *   kafka_list — Heroku Apache Kafka add-ons across the account (Platform API)
 *   kafka_info — detailed control-plane info for one cluster (Data API)
 *
 * Derived from heroku/cli (commit `main`, fetched 2026-06-10) and verified live
 * against kafka-clean-72346:
 *   src/commands/data/kafka/index.ts + src/lib/kafka/api.js
 *     — `kafka:info` GETs `/data/kafka/v0/clusters/{addon.id}` on
 *       api.data.heroku.com and renders the cluster object. The cluster is
 *       addressed by add-on UUID; the add-on NAME returns 404.
 *
 * `kafka_list` deviates from the CLI's app-scoped listing: it lists across the
 * whole account (no `app` input, per the Part A handoff). The Heroku Platform
 * API has no server-side service filter — `GET /addons?service=heroku-kafka`
 * ignores the query param (verified live 2026-06-10) — and `/addons` is
 * name-paginated, so we page through it following `Next-Range` and filter to
 * the `heroku-kafka` add-on service client-side, exactly as `kv_list` does.
 *
 * REDACTION: the Kafka control-plane info body carries NO credentials — the
 * connection URL and SSL keys live in app config vars (KAFKA_URL,
 * KAFKA_CLIENT_CERT, KAFKA_CLIENT_CERT_KEY, KAFKA_TRUSTED_CERT), never in this
 * response (verified live 2026-06-10). We still strip `metaas_source`, an
 * internal Heroku tenant-routing URI with no value to a client, before passing
 * the body through. See {@link redactKafkaInfo}.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { envelopeFromLocal, runTool } from '@heroku-mcp/core';
import type { ToolContext } from '@heroku-mcp/core';
import { clusterUrl, getDataBasic } from '../client.js';
import { resolveClusterId } from '../resolve.js';
import { clusterInput, type KafkaList, type KafkaRecord } from '../types.js';

/** Heroku add-on service name for Apache Kafka. */
const KAFKA_SERVICE = 'heroku-kafka';

/** Page size for the account-wide `/addons` scan. */
const LIST_PAGE_SIZE = 1000;
/** Safety cap on pages followed (1000 * 50 = 50k add-ons). If an account
 *  somehow exceeds this we stop and flag truncation rather than loop forever. */
const LIST_MAX_PAGES = 50;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const obj = (v: unknown): KafkaRecord | undefined =>
  typeof v === 'object' && v !== null ? (v as KafkaRecord) : undefined;

/** Register the inventory & info read tools. */
export function registerInventoryTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'kafka_list',
    {
      title: 'Kafka clusters (list)',
      description:
        'List the Heroku Apache Kafka add-ons on the account. Pages through GET /addons (the Platform API has no server-side service filter) and returns a compact summary of each add-on whose service is heroku-kafka.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      runTool(async () => {
        const clusters: KafkaRecord[] = [];
        let cursor: string | undefined;
        let truncated = false;
        for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
          const res = await ctx.client.get<KafkaList>('/addons', {
            tool: 'kafka_list',
            headers: { Range: cursor ?? `name ..; max=${LIST_PAGE_SIZE}` },
          });
          for (const a of res.body ?? []) {
            if (str(obj(a?.addon_service)?.name) !== KAFKA_SERVICE) continue;
            clusters.push({
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
        return envelopeFromLocal(clusters, truncated ? { pagination: { hasMore: true } } : {});
      }),
  );

  server.registerTool(
    'kafka_info',
    {
      title: 'Kafka cluster info',
      description:
        'Detailed control-plane status for one Heroku Apache Kafka cluster — plan limits, state/health, version, formation, defaults, topic prefix, topic names and throughput counters, as shown by `heroku kafka:info`. Wraps GET /data/kafka/v0/clusters/{cluster} on the Heroku Data API (the cluster is addressed by add-on UUID; a name is resolved first). Carries no credentials — connection details live in app config vars.',
      inputSchema: clusterInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ cluster }) =>
      runTool(async () => {
        const id = await resolveClusterId(cluster, ctx, 'kafka_info');
        const res = await getDataBasic<KafkaRecord>(ctx, clusterUrl(id), { tool: 'kafka_info' });
        return envelopeFromLocal(redactKafkaInfo(res.body));
      }),
  );
}

/** Fields stripped from a `kafka_info` body. `metaas_source` is an internal
 *  Heroku tenant-routing URI (`dod-kafka-tenant://…`) with no value to a client;
 *  the body carries no credentials otherwise (those live in config vars). */
const KAFKA_INFO_DROP_FIELDS = ['metaas_source'] as const;

/** Drop internal-only fields from a `kafka_info` body, leaving everything else
 *  intact. Non-object bodies pass through unchanged. */
export function redactKafkaInfo(body: unknown): unknown {
  const record = obj(body);
  if (!record) return body;
  const out: KafkaRecord = { ...record };
  for (const f of KAFKA_INFO_DROP_FIELDS) delete out[f];
  return out;
}
