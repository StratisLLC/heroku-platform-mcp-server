/**
 * Capability probe + registration-gating tests.
 *
 * Exercises KAFKA_PROBES through the core prober (404 = reachable, 403 = gated)
 * and confirms the package-level registration gate on the `data.kafka` root
 * tier — including that the *fixed* `data.kafka_root` probe (GET
 * /data/kafka/v0/clusters/{zero} rather than the old broken HEAD /data/kafka)
 * lights the tier up on a 404.
 */

import { describe, expect, it } from 'vitest';
import { PLATFORM_PROBES, runProbes, type CapabilityResult } from '@heroku-mcp/core';
import { KAFKA_PROBES, KAFKA_PROBE_IDS } from '../src/index.js';
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

const PROBE_SET = [...PLATFORM_PROBES, ...KAFKA_PROBES];
const ROOT = '/data/kafka/v0/clusters/00000000-0000-0000-0000-000000000000';
const isRoot = (u: string) =>
  u.includes(ROOT) && !u.includes('/topics') && !u.includes('/consumer_groups');
const isTopics = (u: string) => u.includes(`${ROOT}/topics`);
const isGroups = (u: string) => u.includes(`${ROOT}/consumer_groups`);

describe('KAFKA_PROBES', () => {
  it('declares the topic + consumer-group family probes under the Basic-auth /data/kafka/v0 namespace', () => {
    expect(KAFKA_PROBES.map((p) => p.id)).toEqual([...KAFKA_PROBE_IDS]);
    for (const probe of KAFKA_PROBES) {
      expect(probe.base).toBe('data');
      expect(probe.dependsOn).toBe('data.kafka_root');
      expect(probe.authScheme).toBe('basic');
      expect(probe.path.startsWith('/data/kafka/v0/clusters/')).toBe(true);
    }
    // The consumer-group probe uses the underscore path, not a hyphen.
    const groups = KAFKA_PROBES.find((p) => p.id === 'kafka.api.consumer_groups');
    expect(groups?.path).toContain('/consumer_groups');
    expect(groups?.path).not.toContain('/consumer-groups');
  });

  it('the data.kafka_root probe is GET /data/kafka/v0/clusters/{zero} with Basic auth', () => {
    const root = PLATFORM_PROBES.find((p) => p.id === 'data.kafka_root');
    expect(root).toBeDefined();
    expect(root!.method).toBe('GET');
    expect(root!.path).toBe(ROOT);
    expect(root!.authScheme).toBe('basic');
    // A 404 must count as reachable (the whole point of the fix).
    expect(root!.successCodes).toContain(404);
    expect(root!.forbiddenCodes).toEqual(expect.arrayContaining([401, 402, 403]));
  });

  it('marks kafka + sub-families available when the Data API returns 404 (reachable, cluster absent)', async () => {
    const caps = await runProbes({
      probes: PROBE_SET,
      token: 'tok',
      tokenFingerprint: 'fp',
      fetch: statusFetch([]),
    });
    const data = caps.tiers.data as Record<string, { available?: boolean }>;
    expect(data.kafka?.available).toBe(true);
    expect(data.kafka_topics?.available).toBe(true);
    expect(data.kafka_consumer_groups?.available).toBe(true);
  });

  it('marks a sub-family unavailable when its probe returns 403 (gated)', async () => {
    const caps = await runProbes({
      probes: PROBE_SET,
      token: 'tok',
      tokenFingerprint: 'fp',
      fetch: statusFetch([{ test: isTopics, status: 403 }]),
    });
    const data = caps.tiers.data as Record<string, { available?: boolean }>;
    expect(data.kafka?.available).toBe(true);
    expect(data.kafka_topics?.available).toBe(false);
    expect(data.kafka_consumer_groups?.available).toBe(true);
  });

  it('skips the sub-family probes when the kafka root is unreachable', async () => {
    const caps = await runProbes({
      probes: PROBE_SET,
      token: 'tok',
      tokenFingerprint: 'fp',
      fetch: statusFetch([
        { test: isRoot, status: 403 },
        { test: isTopics, status: 200 },
        { test: isGroups, status: 200 },
      ]),
    });
    const data = caps.tiers.data as Record<string, { available?: boolean }>;
    expect(data.kafka?.available).toBe(false);
    expect(data.kafka_topics?.available).toBe(false);
    expect(data.kafka_consumer_groups?.available).toBe(false);
  });
});

describe('registration gating', () => {
  it('advertises no Kafka tools when the data.kafka root tier is down', async () => {
    const caps: CapabilityResult = {
      schemaVersion: 1,
      tokenFingerprint: 'fp',
      probedAt: new Date().toISOString(),
      ttlSeconds: 3600,
      tiers: {
        account: { available: true },
        data: { kafka: { available: false, reason: 'forbidden', status: 403 } },
      },
    };
    const { summary } = await spinUpServer({ capabilities: caps });
    expect(summary.kafka).toBe(false);
  });
});
