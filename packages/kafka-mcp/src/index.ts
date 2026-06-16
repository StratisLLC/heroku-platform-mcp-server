/**
 * `@heroku-mcp/kafka` — Heroku Apache Kafka MCP tools (Part A: admin/control-
 * plane reads + capability probing).
 *
 * This package is a library, not a standalone server. The hosted HTTP server
 * (`@heroku-mcp/http-server`) imports {@link registerKafkaTools} and calls it
 * against the same per-session `McpServer` and `ToolContext` it builds for
 * `@heroku-mcp/platform`, `@heroku-mcp/postgres` and `@heroku-mcp/key-value`,
 * so the user sees one merged tool catalog.
 *
 * Capability probing for the Kafka-specific endpoint families is wired through
 * the Platform server's `extraProbes` option using {@link KAFKA_PROBES}.
 *
 * Scope note: Part A ships admin/control-plane READ tools only. Topic/consumer-
 * group writes (`kafka_topics_create`, `kafka_topics_destroy`,
 * `kafka_*_set`, …), node-failure triggers (`kafka_fail`), and Kafka-protocol
 * data operations (produce/consume/list-offsets) are deliberately NOT
 * implemented here.
 */

export { registerKafkaTools } from './tools/index.js';
export type { KafkaRegistrationSummary } from './tools/index.js';
export { KAFKA_PROBES, KAFKA_FAMILY_TIERS, KAFKA_PROBE_IDS } from './probes.js';
export { redactKafkaInfo } from './tools/inventory.js';
export { DATA_API_BASE, KAFKA_V0_PREFIX, kafkaV0Url, clusterUrl } from './client.js';
export type { KafkaFamily } from './client.js';
export { isUuid, resolveClusterId, resolveClusterName, resolveOwningApp } from './resolve.js';
