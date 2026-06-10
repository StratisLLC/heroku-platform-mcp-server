/**
 * Configuration & maintenance write tool tests:
 *   kv_maxmemory_set, kv_timeout_set, kv_keyspace_notifications_set, kv_stats_reset.
 *
 * Each gets a happy path (mocked HTTP asserting the verified endpoint/method/body
 * and field projection), a confirm-mismatch path (structured `confirmation`
 * error, no HTTP call), and — where applicable — a sub-tier gate or 4xx path.
 * Endpoints/bodies match the live captures in test/fixtures and the heroku/cli
 * source cited in each tool.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CapabilityResult } from '@heroku-mcp/core';
import { parseEnvelope, spinUpServer, type RecordedCall } from './helpers.js';

function fixture(name: string): Record<string, unknown> {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

const REDIS_V0 = 'https://api.data.heroku.com/redis/v0';
const addonLookup = (id: string) => `https://api.heroku.com/addons/${id}`;
const NAME = 'redis-shallow-89243';
const UUID = '03a8ea32-bbc7-49ac-afac-e20dd35895bb';
const find = (calls: RecordedCall[], pred: (c: RecordedCall) => boolean) => calls.find(pred);

/** Caps with the redis root up but the kv_config sub-tier explicitly down. */
const configGated: CapabilityResult = {
  schemaVersion: 1,
  tokenFingerprint: 'fp',
  probedAt: new Date().toISOString(),
  ttlSeconds: 3600,
  tiers: {
    account: { available: true },
    data: {
      redis: { available: true },
      kv_config: { available: false, reason: 'forbidden', status: 403 },
    },
  },
};

describe('config & maintenance write tools', () => {
  it('registers the full 8-tool surface', async () => {
    const { client } = await spinUpServer();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'kv_list',
        'kv_info',
        'kv_credentials',
        'kv_credentials_reset',
        'kv_maxmemory_set',
        'kv_timeout_set',
        'kv_keyspace_notifications_set',
        'kv_stats_reset',
      ]),
    );
    expect(names).toHaveLength(8);
  });

  it('kv_maxmemory_set PATCHes config {maxmemory_policy} by name and projects the value', async () => {
    const { client, calls } = await spinUpServer({
      responses: [
        {
          match: (url, init) =>
            url === `${REDIS_V0}/databases/${NAME}/config` && init?.method === 'PATCH',
          body: fixture('kv-maxmemory-set.captured.json'),
        },
      ],
    });
    const result = (await client.callTool({
      name: 'kv_maxmemory_set',
      arguments: { addon: NAME, policy: 'allkeys-lru', confirm: NAME },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ addon: string; maxmemory_policy: string }>(result);
    expect(env.ok).toBe(true);
    expect(env.data).toEqual({ addon: NAME, maxmemory_policy: 'allkeys-lru' });
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.headers.authorization).toMatch(/^Basic /);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ maxmemory_policy: 'allkeys-lru' });
  });

  it('kv_maxmemory_set rejects a confirm mismatch with no HTTP call', async () => {
    const { client, calls } = await spinUpServer();
    const result = (await client.callTool({
      name: 'kv_maxmemory_set',
      arguments: { addon: NAME, policy: 'noeviction', confirm: 'wrong' },
    })) as { isError?: boolean; content: unknown[] };
    expect(result.isError).toBe(true);
    expect(parseEnvelope(result).error?.kind).toBe('confirmation');
    expect(calls).toHaveLength(0);
  });

  it('kv_maxmemory_set is gated on the kv_config sub-tier (no HTTP call when down)', async () => {
    const { client, calls } = await spinUpServer({ capabilities: configGated });
    const result = (await client.callTool({
      name: 'kv_maxmemory_set',
      arguments: { addon: NAME, policy: 'noeviction', confirm: NAME },
    })) as { isError?: boolean; content: unknown[] };
    expect(result.isError).toBe(true);
    expect(parseEnvelope(result).error?.kind).toBe('forbidden');
    expect(calls).toHaveLength(0);
  });

  it('kv_timeout_set resolves the addon id and PATCHes config {timeout}', async () => {
    const { client, calls } = await spinUpServer({
      responses: [
        { match: (url) => url === addonLookup(NAME), body: { id: UUID, name: NAME } },
        {
          match: (url, init) =>
            url === `${REDIS_V0}/databases/${UUID}/config` && init?.method === 'PATCH',
          body: fixture('kv-timeout-set.captured.json'),
        },
      ],
    });
    const result = (await client.callTool({
      name: 'kv_timeout_set',
      arguments: { addon: NAME, seconds: 60, confirm: NAME },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ addon: string; timeout: number }>(result);
    expect(env.ok).toBe(true);
    expect(env.data).toEqual({ addon: NAME, timeout: 60 });
    const patch = find(calls, (c) => c.method === 'PATCH');
    expect(patch?.url).toBe(`${REDIS_V0}/databases/${UUID}/config`);
    expect(JSON.parse(patch?.body ?? '{}')).toEqual({ timeout: 60 });
  });

  it('kv_timeout_set rejects a confirm mismatch with no HTTP call', async () => {
    const { client, calls } = await spinUpServer();
    const result = (await client.callTool({
      name: 'kv_timeout_set',
      arguments: { addon: NAME, seconds: 0, confirm: 'nope' },
    })) as { isError?: boolean; content: unknown[] };
    expect(result.isError).toBe(true);
    expect(parseEnvelope(result).error?.kind).toBe('confirmation');
    expect(calls).toHaveLength(0);
  });

  it('kv_keyspace_notifications_set PATCHes config {notify_keyspace_events} by name', async () => {
    const { client, calls } = await spinUpServer({
      responses: [
        {
          match: (url, init) =>
            url === `${REDIS_V0}/databases/${NAME}/config` && init?.method === 'PATCH',
          body: fixture('kv-keyspace-notifications-set.captured.json'),
        },
      ],
    });
    const result = (await client.callTool({
      name: 'kv_keyspace_notifications_set',
      arguments: { addon: NAME, config: 'AKE', confirm: NAME },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ addon: string; notify_keyspace_events: string }>(result);
    expect(env.ok).toBe(true);
    expect(env.data).toEqual({ addon: NAME, notify_keyspace_events: 'AKE' });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ notify_keyspace_events: 'AKE' });
  });

  it('kv_keyspace_notifications_set accepts the empty string (disable) and confirms', async () => {
    const { client, calls } = await spinUpServer();
    const result = (await client.callTool({
      name: 'kv_keyspace_notifications_set',
      arguments: { addon: NAME, config: '', confirm: 'wrong' },
    })) as { isError?: boolean; content: unknown[] };
    // Confirm guard fires before any HTTP; proves the empty-string config is a
    // valid input (not rejected by schema) yet still gated.
    expect(result.isError).toBe(true);
    expect(parseEnvelope(result).error?.kind).toBe('confirmation');
    expect(calls).toHaveLength(0);
  });

  it('kv_stats_reset resolves the addon id and POSTs stats/reset', async () => {
    const { client, calls } = await spinUpServer({
      responses: [
        { match: (url) => url === addonLookup(NAME), body: { id: UUID, name: NAME } },
        {
          match: (url, init) =>
            url === `${REDIS_V0}/databases/${UUID}/stats/reset` && init?.method === 'POST',
          body: fixture('kv-stats-reset.captured.json'),
        },
      ],
    });
    const result = (await client.callTool({
      name: 'kv_stats_reset',
      arguments: { addon: NAME, confirm: NAME },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ reset: boolean; message: string }>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.reset).toBe(true);
    expect(env.data?.message).toMatch(/reset successful/i);
    const post = find(calls, (c) => c.method === 'POST');
    expect(post?.url).toBe(`${REDIS_V0}/databases/${UUID}/stats/reset`);
    expect(JSON.parse(post?.body ?? 'null')).toEqual({});
  });

  it('kv_stats_reset rejects a confirm mismatch with no HTTP call', async () => {
    const { client, calls } = await spinUpServer();
    const result = (await client.callTool({
      name: 'kv_stats_reset',
      arguments: { addon: NAME, confirm: 'x' },
    })) as { isError?: boolean; content: unknown[] };
    expect(result.isError).toBe(true);
    expect(parseEnvelope(result).error?.kind).toBe('confirmation');
    expect(calls).toHaveLength(0);
  });

  it('kv_stats_reset maps a 404', async () => {
    const { client } = await spinUpServer({
      responses: [
        { match: (url) => url === addonLookup(NAME), body: { id: UUID, name: NAME } },
        {
          match: (url) => url === `${REDIS_V0}/databases/${UUID}/stats/reset`,
          status: 404,
          body: { message: 'Not found.' },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'kv_stats_reset',
      arguments: { addon: NAME, confirm: NAME },
    })) as { isError?: boolean; content: unknown[] };
    expect(result.isError).toBe(true);
    expect(parseEnvelope(result).error?.kind).toBe('not_found');
  });
});
