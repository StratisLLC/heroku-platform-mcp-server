/**
 * Capability probe + registration-gating tests.
 *
 * Exercises POSTGRES_PROBES through the core prober (classification of 404 =
 * reachable vs 403 = gated) and confirms the package-level registration gate on
 * the `data.postgres` root tier.
 */

import { describe, expect, it } from 'vitest';
import { PLATFORM_PROBES, runProbes, type CapabilityResult } from '@heroku-mcp/core';
import { POSTGRES_PROBES, PG_PROBE_IDS } from '../src/index.js';
import { spinUpServer } from './helpers.js';

/** Build a fetch that returns per-URL statuses, defaulting to 404. */
function statusFetch(rules: { test: (url: string) => boolean; status: number }[]) {
  const fn: typeof globalThis.fetch = (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const rule = rules.find((r) => r.test(url));
    const status = rule?.status ?? 404;
    const body = status === 200 || status === 204 ? null : '{}';
    return Promise.resolve(new Response(body, { status }));
  };
  return fn;
}

const PROBE_SET = [...PLATFORM_PROBES, ...POSTGRES_PROBES];

describe('POSTGRES_PROBES', () => {
  it('declares the four Data API family probes', () => {
    expect(POSTGRES_PROBES.map((p) => p.id)).toEqual([...PG_PROBE_IDS]);
    for (const probe of POSTGRES_PROBES) {
      expect(probe.base).toBe('data');
      expect(probe.dependsOn).toBe('data.postgres_root');
      expect(probe.path.startsWith('/client/v11/databases/')).toBe(true);
    }
  });

  it('marks families available when the Data API returns 404 (reachable, db absent)', async () => {
    const caps = await runProbes({
      probes: PROBE_SET,
      token: 'tok',
      tokenFingerprint: 'fp',
      // data root reachable (200), families 404 → "empty" → available.
      fetch: statusFetch([{ test: (u) => u === 'https://api.data.heroku.com/postgres', status: 200 }]),
    });
    const data = caps.tiers.data as Record<string, { available?: boolean }>;
    expect(data.postgres?.available).toBe(true);
    expect(data.pg_backups?.available).toBe(true);
    expect(data.pg_credentials?.available).toBe(true);
    expect(data.pg_followers?.available).toBe(true);
    expect(data.pg_query_insights?.available).toBe(true);
  });

  it('marks a family unavailable when the Data API returns 403 (gated)', async () => {
    const caps = await runProbes({
      probes: PROBE_SET,
      token: 'tok',
      tokenFingerprint: 'fp',
      fetch: statusFetch([
        { test: (u) => u === 'https://api.data.heroku.com/postgres', status: 200 },
        { test: (u) => u.includes('/query-stats'), status: 403 },
      ]),
    });
    const data = caps.tiers.data as Record<string, { available?: boolean }>;
    expect(data.pg_query_insights?.available).toBe(false);
    expect(data.pg_backups?.available).toBe(true);
  });

  it('skips family probes when the postgres root is unreachable', async () => {
    const caps = await runProbes({
      probes: PROBE_SET,
      token: 'tok',
      tokenFingerprint: 'fp',
      // Everything (incl. /postgres root) defaults to 404 → root not reachable.
      fetch: statusFetch([]),
    });
    const data = caps.tiers.data as Record<string, { available?: boolean }>;
    expect(data.postgres?.available).toBe(false);
    // Dependent family probes are skipped (unavailable), not crashed.
    expect(data.pg_backups?.available).toBe(false);
  });
});

describe('registration gating', () => {
  it('advertises no Postgres tools when the data.postgres root tier is down', async () => {
    const caps: CapabilityResult = {
      schemaVersion: 1,
      tokenFingerprint: 'fp',
      probedAt: new Date().toISOString(),
      ttlSeconds: 3600,
      tiers: {
        account: { available: true },
        data: { postgres: { available: false, reason: 'forbidden', status: 403 } },
      },
    };
    const { summary } = await spinUpServer({ capabilities: caps });
    // With the root tier down, no Postgres tools are registered at all (the MCP
    // server therefore advertises no tools/list handler — assert on the
    // registration summary rather than round-tripping listTools).
    expect(summary.postgres).toBe(false);
  });
});
