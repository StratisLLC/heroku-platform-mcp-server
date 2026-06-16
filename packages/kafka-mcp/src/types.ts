/**
 * Shared zod input shapes and TypeScript response aliases for the Kafka MCP
 * tools. Mirrors `@heroku-mcp/key-value`'s types.ts.
 *
 * Responses from the Heroku Data API are passed through to the caller verbatim
 * inside the standard tool envelope (matching `@heroku-mcp/platform`'s
 * pass-through convention), so we model them as loose records rather than
 * pinning a strict schema that would drift against Heroku's evolving payloads.
 * Inputs, by contrast, ARE strictly validated — they are the only thing the
 * model controls.
 *
 * Part A is reads only. The `confirm` guard contract (core `assertConfirm`)
 * lives in `@heroku-mcp/core` and is reused unchanged when the Part B write
 * tools land; no parallel confirmation machinery is introduced here.
 */

import { z } from 'zod';

/** A Heroku JSON object we don't strictly model — passed through verbatim. */
export type KafkaRecord = Record<string, unknown>;
/** A list of {@link KafkaRecord}. */
export type KafkaList = KafkaRecord[];

/** A Kafka cluster (add-on) identifier. The tools accept the add-on UUID or the
 *  add-on name (e.g. `kafka-clean-72346`) and resolve a name to its UUID before
 *  calling the Data API, whose cluster endpoints require the UUID. */
export const clusterInput = {
  cluster: z
    .string()
    .min(1)
    .describe(
      'Heroku Apache Kafka add-on identifier — the add-on id (UUID) or add-on name (e.g. "kafka-clean-72346").',
    ),
};

/** `kafka_topics_info` — a cluster plus a single topic name. */
export const topicInput = {
  ...clusterInput,
  topic: z
    .string()
    .min(1)
    .describe(
      'Topic name. May be given with or without the cluster KAFKA_PREFIX — ' +
        'e.g. "mcp-test-topic" or "pearl-60818.mcp-test-topic"; the prefix is ' +
        "matched leniently against the cluster's topic_prefix.",
    ),
};
