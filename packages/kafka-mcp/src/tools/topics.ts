/**
 * Topic tools (reads).
 *
 *   kafka_topics_list — every topic on a cluster              (Data API)
 *   kafka_topics_info — one topic's partitions/retention/etc  (Data API, filtered)
 *
 * Derived from heroku/cli (commit `main`, fetched 2026-06-10) and verified live
 * against kafka-clean-72346:
 *   src/commands/data/kafka/topics/index.ts + src/lib/kafka/api.js
 *     — `kafka:topics` GETs `/data/kafka/v0/clusters/{addon.id}/topics`.
 *   src/commands/data/kafka/topics/info.ts
 *     — `kafka:topics:info` reuses the SAME list endpoint and filters to the
 *       requested topic CLIENT-SIDE. There is NO per-topic endpoint:
 *       `GET .../topics/{name}` returns 404 (verified live 2026-06-10), so
 *       `kafka_topics_info` fetches the list and selects one entry.
 *
 * The list response is `{attachment_name, prefix, topics:[{name, prefix,
 * partitions, replication_factor, retention_time_ms, compaction, cleanup_policy,
 * …}], limits}`. Topic `name`s are SHORT (unprefixed); the cluster KAFKA_PREFIX
 * is the separate top-level `prefix`. We match a requested topic leniently
 * against the short name with the prefix optionally present.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NotFoundError, envelopeFromLocal, runTool } from '@heroku-mcp/core';
import type { ToolContext } from '@heroku-mcp/core';
import { assertFamilyAvailable, clusterUrl, getDataBasic } from '../client.js';
import { resolveClusterId } from '../resolve.js';
import { clusterInput, topicInput, type KafkaList, type KafkaRecord } from '../types.js';

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const obj = (v: unknown): KafkaRecord | undefined =>
  typeof v === 'object' && v !== null ? (v as KafkaRecord) : undefined;

/** Pull the topic array out of a `/topics` response body. */
function topicsOf(body: unknown): KafkaRecord[] {
  const list = obj(body)?.topics;
  return Array.isArray(list) ? (list as KafkaList) : [];
}

/**
 * True iff `topic` (a `/topics` entry) is the one the caller asked for.
 *
 * Topic entries carry a SHORT `name` plus their own `prefix`. The caller may
 * pass the short name, or the fully-prefixed name. We accept a match against the
 * short name, the prefix+name, or the request with the entry's prefix stripped.
 */
function topicMatches(topic: KafkaRecord, requested: string): boolean {
  const name = str(topic.name);
  if (!name) return false;
  const prefix = str(topic.prefix) ?? '';
  const full = `${prefix}${name}`;
  const requestedStripped =
    prefix && requested.startsWith(prefix) ? requested.slice(prefix.length) : requested;
  return requested === name || requested === full || requestedStripped === name;
}

/** Register the topic read tools. Both are gated on the `kafka_topics` sub-tier. */
export function registerTopicTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'kafka_topics_list',
    {
      title: 'Kafka topics (list)',
      description:
        'List the topics on a Heroku Apache Kafka cluster, each with its partition count, replication factor, retention, compaction/cleanup policy and throughput. Wraps GET /data/kafka/v0/clusters/{cluster}/topics. Topic names are returned without the cluster KAFKA_PREFIX, which is reported separately as `prefix`.',
      inputSchema: clusterInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ cluster }) =>
      runTool(async () => {
        assertFamilyAvailable(ctx, 'kafka_topics', 'Kafka topics');
        const id = await resolveClusterId(cluster, ctx, 'kafka_topics_list');
        const res = await getDataBasic<KafkaRecord>(ctx, clusterUrl(id, '/topics'), {
          tool: 'kafka_topics_list',
        });
        return envelopeFromLocal(res.body);
      }),
  );

  server.registerTool(
    'kafka_topics_info',
    {
      title: 'Kafka topic info',
      description:
        'Details for a single topic on a Heroku Apache Kafka cluster — partitions, replication factor, retention, compaction and cleanup policy. The Kafka Data API has no per-topic endpoint, so this fetches the cluster topic list and selects the requested topic (matched with or without the KAFKA_PREFIX). Returns a not_found error if no such topic exists.',
      inputSchema: topicInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ cluster, topic }) =>
      runTool(async () => {
        assertFamilyAvailable(ctx, 'kafka_topics', 'Kafka topics');
        const id = await resolveClusterId(cluster, ctx, 'kafka_topics_info');
        const res = await getDataBasic<KafkaRecord>(ctx, clusterUrl(id, '/topics'), {
          tool: 'kafka_topics_info',
        });
        const match = topicsOf(res.body).find((t) => topicMatches(t, topic));
        if (!match) {
          throw new NotFoundError(`No topic "${topic}" found on Kafka cluster "${cluster}".`, {
            details: { cluster, topic },
          });
        }
        return envelopeFromLocal(match);
      }),
  );
}
