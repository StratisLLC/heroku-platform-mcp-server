/**
 * Capability probe definitions for the Kafka-specific endpoint families.
 *
 * The probe data itself lives in `@heroku-mcp/core` (so the prober can run it
 * in the same one-shot pass as the Platform matrix). This module re-exports it
 * and names the sub-tiers each tool family depends on, so the registration and
 * call-time guards reference one source of truth. Mirrors
 * `@heroku-mcp/key-value`'s probes.ts.
 */

export { KAFKA_PROBES } from '@heroku-mcp/core';

/** The capability sub-tier (under `data`) each Kafka tool family is gated on.
 *  The package as a whole is gated on the `data.kafka` root tier. */
export const KAFKA_FAMILY_TIERS = {
  topics: 'data.kafka_topics',
  consumer_groups: 'data.kafka_consumer_groups',
} as const;

/** Probe ids emitted by {@link KAFKA_PROBES}, for assertions/tests. */
export const KAFKA_PROBE_IDS = ['kafka.api.topics', 'kafka.api.consumer_groups'] as const;
