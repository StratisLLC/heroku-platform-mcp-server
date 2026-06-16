/**
 * Kafka MCP tool registration coordinator. Mirrors `@heroku-mcp/key-value`'s
 * registration coordinator.
 *
 * The whole tool surface is gated on the `data.kafka` root capability tier
 * (probed by the Platform matrix's `data.kafka_root` probe). When that tier is
 * unavailable — the token can't reach the Kafka Data API at all — no Kafka tools
 * are advertised, so `tools/list` stays honest.
 *
 * The topic and consumer-group families additionally guard their `kafka_topics`
 * / `kafka_consumer_groups` sub-tiers at call time (see {@link
 * assertFamilyAvailable}) so they fail fast with an actionable message instead
 * of a blind 4xx.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { tierAvailable } from '@heroku-mcp/core';
import type { ToolContext } from '@heroku-mcp/core';
import { registerConsumerGroupTools } from './consumer-groups.js';
import { registerInventoryTools } from './inventory.js';
import { registerTopicTools } from './topics.js';

/** Summary of what {@link registerKafkaTools} advertised. */
export interface KafkaRegistrationSummary {
  /** True iff the `data.kafka` root tier was available and tools were registered. */
  kafka: boolean;
}

/** Register every Kafka tool the capability matrix authorises. */
export function registerKafkaTools(server: McpServer, ctx: ToolContext): KafkaRegistrationSummary {
  if (!tierAvailable(ctx.getCapabilities(), 'data.kafka')) {
    return { kafka: false };
  }
  registerInventoryTools(server, ctx);
  registerTopicTools(server, ctx);
  registerConsumerGroupTools(server, ctx);
  return { kafka: true };
}
