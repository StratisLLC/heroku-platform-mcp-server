/**
 * Capability probe definitions for the Key-Value-specific endpoint families.
 *
 * The probe data itself lives in `@heroku-mcp/core` (so the prober can run it
 * in the same one-shot pass as the Platform matrix). This module re-exports it
 * and names the sub-tiers each tool family depends on, so the registration and
 * call-time guards reference one source of truth. Mirrors
 * `@heroku-mcp/postgres`'s probes.ts.
 */

export { KEYVALUE_PROBES } from '@heroku-mcp/core';

/** The capability sub-tier (under `data`) each Key-Value tool family is gated
 *  on. The package as a whole is gated on the `data.redis` root tier. */
export const KV_FAMILY_TIERS = {
  config: 'data.kv_config',
} as const;

/** Probe ids emitted by {@link KEYVALUE_PROBES}, for assertions/tests. */
export const KV_PROBE_IDS = ['kv.api.config'] as const;
