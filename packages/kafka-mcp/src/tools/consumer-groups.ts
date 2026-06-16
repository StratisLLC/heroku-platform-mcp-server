/**
 * Consumer-group tools (reads).
 *
 *   kafka_consumer_groups_list — consumer groups on a cluster (Data API)
 *
 * Derived from heroku/cli (commit `main`, fetched 2026-06-10) and verified live
 * against kafka-clean-72346:
 *   src/commands/data/kafka/consumer-groups/index.ts + src/lib/kafka/api.js
 *     — `kafka:consumer-groups` GETs
 *       `/data/kafka/v0/clusters/{addon.id}/consumer_groups`.
 *
 * PATH NOTE: the sub-resource is spelled with an UNDERSCORE
 * (`/consumer_groups`), not a hyphen — the hyphenated form 404s (verified live
 * 2026-06-10). The CLI command name uses a hyphen; the API path does not.
 *
 * The response is `{attachment_name, consumer_groups:[{name}]}`; group names are
 * SHORT (the cluster KAFKA_PREFIX is not echoed per-group). There is no
 * per-group detail endpoint, so Part A ships only the list.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { envelopeFromLocal, runTool } from '@heroku-mcp/core';
import type { ToolContext } from '@heroku-mcp/core';
import { assertFamilyAvailable, clusterUrl, getDataBasic } from '../client.js';
import { resolveClusterId } from '../resolve.js';
import { clusterInput, type KafkaRecord } from '../types.js';

/** Register the consumer-group read tools. Gated on the `kafka_consumer_groups`
 *  sub-tier. */
export function registerConsumerGroupTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'kafka_consumer_groups_list',
    {
      title: 'Kafka consumer groups (list)',
      description:
        'List the consumer groups on a Heroku Apache Kafka cluster. Wraps GET /data/kafka/v0/clusters/{cluster}/consumer_groups (note the underscore). Group names are returned without the cluster KAFKA_PREFIX.',
      inputSchema: clusterInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ cluster }) =>
      runTool(async () => {
        assertFamilyAvailable(ctx, 'kafka_consumer_groups', 'Kafka consumer groups');
        const id = await resolveClusterId(cluster, ctx, 'kafka_consumer_groups_list');
        const res = await getDataBasic<KafkaRecord>(ctx, clusterUrl(id, '/consumer_groups'), {
          tool: 'kafka_consumer_groups_list',
        });
        return envelopeFromLocal(res.body);
      }),
  );
}
