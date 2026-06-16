/**
 * Capability probe + registration-gating tests.
 *
 * Exercises KEYVALUE_PROBES through the core prober (404 = reachable, 403 =
 * gated) and confirms the package-level registration gate on the `data.redis`
 * root tier — including that the *fixed* `data.redis_root` probe (GET
 * /redis/v0/databases/{zero} rather than the old broken HEAD /redis) lights the
 * tier up on a 404.
 */

import { describe, expect, it } from 'vitest';
import { PLATFORM_PROBES, runProbes, type CapabilityResult } from '@heroku-mcp/core';
import { KEYVALUE_PROBES, KV_PROBE_IDS } from '../src/index.js';
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

const PROBE_SET = [...PLATFORM_PROBES, ...KEYVALUE_PROBES];
const ROOT = '/redis/v0/databases/00000000-0000-0000-0000-000000000000';
const isRoot = (u: string) => u.includes(ROOT) && !u.includes('/config');
const isConfig = (u: string) => u.includes(`${ROOT}/config`);

describe('KEYVALUE_PROBES', () => {
  it('declares the config family probe under the Basic-auth /redis/v0 namespace', () => {
    expect(KEYVALUE_PROBES.map((p) => p.id)).toEqual([...KV_PROBE_IDS]);
    for (const probe of KEYVALUE_PROBES) {
      expect(probe.base).toBe('data');
      expect(probe.dependsOn).toBe('data.redis_root');
      expect(probe.authScheme).toBe('basic');
      expect(probe.path.startsWith('/redis/v0/databases/')).toBe(true);
    }
  });

  it('the data.redis_root probe is GET /redis/v0/databases/{zero} with Basic auth', () => {
    const root = PLATFORM_PROBES.find((p) => p.id === 'data.redis_root');
    expect(root).toBeDefined();
    expect(root!.method).toBe('GET');
    expect(root!.path).toBe(ROOT);
    expect(root!.authScheme).toBe('basic');
    // A 404 must count as reachable (the whole point of the fix).
    expect(root!.successCodes).toContain(404);
    expect(root!.forbiddenCodes).toEqual(expect.arrayContaining([401, 402, 403]));
  });

  it('marks redis + kv_config available when the Data API returns 404 (reachable, db absent)', async () => {
    const caps = await runProbes({
      probes: PROBE_SET,
      token: 'tok',
      tokenFingerprint: 'fp',
      fetch: statusFetch([]),
    });
    const data = caps.tiers.data as Record<string, { available?: boolean }>;
    expect(data.redis?.available).toBe(true);
    expect(data.kv_config?.available).toBe(true);
  });

  it('marks kv_config unavailable when /config returns 403 (gated)', async () => {
    const caps = await runProbes({
      probes: PROBE_SET,
      token: 'tok',
      tokenFingerprint: 'fp',
      fetch: statusFetch([{ test: isConfig, status: 403 }]),
    });
    const data = caps.tiers.data as Record<string, { available?: boolean }>;
    expect(data.redis?.available).toBe(true);
    expect(data.kv_config?.available).toBe(false);
  });

  it('skips the config family probe when the redis root is unreachable', async () => {
    const caps = await runProbes({
      probes: PROBE_SET,
      token: 'tok',
      tokenFingerprint: 'fp',
      fetch: statusFetch([{ test: isRoot, status: 403 }]),
    });
    const data = caps.tiers.data as Record<string, { available?: boolean }>;
    expect(data.redis?.available).toBe(false);
    expect(data.kv_config?.available).toBe(false);
  });
});

describe('registration gating', () => {
  it('advertises no Key-Value tools when the data.redis root tier is down', async () => {
    const caps: CapabilityResult = {
      schemaVersion: 1,
      tokenFingerprint: 'fp',
      probedAt: new Date().toISOString(),
      ttlSeconds: 3600,
      tiers: {
        account: { available: true },
        data: { redis: { available: false, reason: 'forbidden', status: 403 } },
      },
    };
    const { summary } = await spinUpServer({ capabilities: caps });
    expect(summary.keyValue).toBe(false);
  });
});
