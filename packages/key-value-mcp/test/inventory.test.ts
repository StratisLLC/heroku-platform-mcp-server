/**
 * Inventory & info tool tests: kv_list, kv_info.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { redactKvInfo } from '../src/index.js';
import { parseEnvelope, spinUpServer } from './helpers.js';

/** Load a captured live fixture (real API response shape) by basename. */
function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8'));
}

const REDIS_V0 = 'https://api.data.heroku.com/redis/v0';
const expectedBasicAuth = `Basic ${Buffer.from(':HRKU-test-token').toString('base64')}`;
const rangeOf = (init?: RequestInit): string | null => new Headers(init?.headers).get('range');

describe('inventory tools', () => {
  it('registers the inventory read tools', async () => {
    const { client } = await spinUpServer();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['kv_list', 'kv_info']));
  });

  it('kv_list pages /addons and filters to the heroku-redis service', async () => {
    const { client, calls } = await spinUpServer({
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/addons',
          body: [
            {
              id: 'a-kv',
              name: 'redis-shallow-89243',
              addon_service: { name: 'heroku-redis' },
              plan: { name: 'heroku-redis:mini' },
              state: 'provisioned',
              app: { name: 'dm-kvtest' },
              created_at: '2026-06-09T19:31:45Z',
            },
            {
              id: 'a-pg',
              name: 'postgresql-curved-12345',
              addon_service: { name: 'heroku-postgresql' },
              plan: { name: 'heroku-postgresql:standard-0' },
              state: 'provisioned',
              app: { name: 'dm-kvtest' },
            },
          ],
        },
      ],
    });
    const result = (await client.callTool({ name: 'kv_list', arguments: {} })) as {
      content: unknown[];
    };
    const env = parseEnvelope<{ addon_name: string }[]>(result);
    expect(env.ok).toBe(true);
    expect(env.data).toHaveLength(1);
    expect(env.data?.[0]).toEqual({
      addon_id: 'a-kv',
      addon_name: 'redis-shallow-89243',
      plan: 'heroku-redis:mini',
      status: 'provisioned',
      attached_app: 'dm-kvtest',
      created_at: '2026-06-09T19:31:45Z',
    });
    // First page used a fresh Range header (no cursor yet).
    expect(calls[0]?.headers.range).toMatch(/^name \.\.; max=/);
  });

  it('kv_list follows Next-Range across pages (test addon sorts onto a later page)', async () => {
    const { client, calls } = await spinUpServer({
      responses: [
        {
          // page 2: the cursor page (Range carries a `]` start marker from the
          // prior Next-Range) holds the redis add-on. Listed first so its more
          // specific matcher wins over page 1's.
          match: (url, init) =>
            url === 'https://api.heroku.com/addons' && rangeOf(init)?.includes(']') === true,
          body: [
            {
              id: 'a-kv',
              name: 'redis-shallow-89243',
              addon_service: { name: 'heroku-redis' },
              plan: { name: 'heroku-redis:mini' },
              state: 'provisioned',
              app: { name: 'dm-kvtest' },
            },
          ],
        },
        {
          // page 1: a fresh `name ..` range, no redis; signals more via next-range.
          match: (url, init) =>
            url === 'https://api.heroku.com/addons' &&
            rangeOf(init)?.startsWith('name ..') === true,
          headers: { 'next-range': 'name ]inference-rigid-89489..; max=1000' },
          body: [{ id: 'x', name: 'acme-1', addon_service: { name: 'cloudinary' } }],
        },
      ],
    });
    const result = (await client.callTool({ name: 'kv_list', arguments: {} })) as {
      content: unknown[];
    };
    const env = parseEnvelope<{ addon_name: string }[]>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.map((d) => d.addon_name)).toEqual(['redis-shallow-89243']);
    expect(calls).toHaveLength(2);
  });

  it('kv_info hits the Data API with Basic auth + a plain-JSON Accept header', async () => {
    const { client, calls } = await spinUpServer({
      responses: [
        {
          match: (url) => url === `${REDIS_V0}/databases/redis-shallow-89243`,
          body: { name: 'redis-shallow-89243', info: [{ name: 'Plan', values: ['Mini'] }] },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'kv_info',
      arguments: { addon: 'redis-shallow-89243' },
    })) as { content: unknown[] };
    expect(parseEnvelope(result).ok).toBe(true);
    expect(calls[0]?.url).toBe(`${REDIS_V0}/databases/redis-shallow-89243`);
    expect(calls[0]?.headers.accept).toBe('application/json');
    expect(calls[0]?.headers.authorization).toBe(expectedBasicAuth);
  });

  it('kv_info strips the password-bearing resource_url but keeps the info array', async () => {
    const body = fixture('kv-info.captured.json') as Record<string, unknown>;
    expect(typeof body.resource_url).toBe('string'); // sanity: fixture has the field
    const { client } = await spinUpServer({
      responses: [{ match: (url) => url === `${REDIS_V0}/databases/redis-shallow-89243`, body }],
    });
    const result = (await client.callTool({
      name: 'kv_info',
      arguments: { addon: 'redis-shallow-89243' },
    })) as { content: unknown[] };
    const env = parseEnvelope<Record<string, unknown>>(result);
    expect(env.ok).toBe(true);
    expect(env.data).not.toHaveProperty('resource_url');
    expect(JSON.stringify(env.data)).not.toContain('REDACTED_TEST_PASSWORD');
    expect(env.data?.info).toBeDefined();
    expect(env.data?.name).toBe(body.name);
  });
});

describe('redactKvInfo', () => {
  it('drops resource_url and leaves everything else', () => {
    const out = redactKvInfo({ name: 'r', resource_url: 'rediss://:p@h:1', info: [1] }) as Record<
      string,
      unknown
    >;
    expect(out).not.toHaveProperty('resource_url');
    expect(out.name).toBe('r');
    expect(out.info).toEqual([1]);
  });
  it('passes non-object bodies through unchanged', () => {
    expect(redactKvInfo(null)).toBeNull();
    expect(redactKvInfo('x')).toBe('x');
  });
});
