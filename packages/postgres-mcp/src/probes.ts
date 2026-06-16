/**
 * Capability probe definitions for the Postgres-specific endpoint families.
 *
 * The probe data itself lives in `@heroku-mcp/core` (so the prober can run it
 * in the same one-shot pass as the Platform matrix). This module re-exports it
 * and names the sub-tiers each tool family depends on, so the registration and
 * call-time guards reference one source of truth.
 */

export { POSTGRES_PROBES } from '@heroku-mcp/core';

/** The capability sub-tier (under `data`) each Postgres tool family is gated
 *  on. The package as a whole is gated on the `data.postgres` root tier. */
export const PG_FAMILY_TIERS = {
  credentials: 'data.pg_credentials',
  backups: 'data.pg_backups',
  followers: 'data.pg_followers',
  queryInsights: 'data.pg_query_insights',
} as const;

/** Probe ids emitted by {@link POSTGRES_PROBES}, for assertions/tests. */
export const PG_PROBE_IDS = [
  'pg.api.credentials',
  'pg.api.backups',
  'pg.api.followers',
  'pg.api.query_insights',
] as const;
