/**
 * Inventory & info tool tests: kafka_list, kafka_info.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { redactKafkaInfo } from '../src/index.js';
import { parseEnvelope, spinUpServer } from './helpers.js';

/** Load a captured live fixture (real API response shape) by basename. */
function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8'));
}

const CLUSTER = 'https://api.data.heroku.com/data/kafka/v0/clusters';
const UUID = 'a47a6373-58fd-46bd-886d-9f505a8812ad';
const expectedBasicAuth = `Basic ${Buffer.from(':HRKU-test-token').toString('base64')}`;
const rangeOf = (init?: RequestInit): string | null => new Headers(init?.headers).get('range');

describe('inventory tools', () => {
  it('registers the inventory read tools', async () => {
    const { client } = await spinUpServer();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['kafka_list', 'kafka_info']));
  });

  it('kafka_list pages /addons and filters to the heroku-kafka service', async () => {
    const { client, calls } = await spinUpServer({
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/addons',
          body: [
            {
              id: UUID,
              name: 'kafka-clean-72346',
              addon_service: { name: 'heroku-kafka' },
              plan: { name: 'heroku-kafka:basic-0' },
              state: 'provisioned',
              app: { name: 'dm-kafkatest' },
              created_at: '2026-06-10T13:57:20Z',
            },
            {
              id: 'a-pg',
              name: 'postgresql-curved-12345',
              addon_service: { name: 'heroku-postgresql' },
              plan: { name: 'heroku-postgresql:standard-0' },
              state: 'provisioned',
              app: { name: 'dm-kafkatest' },
            },
          ],
        },
      ],
    });
    const result = (await client.callTool({ name: 'kafka_list', arguments: {} })) as {
      content: unknown[];
    };
    const env = parseEnvelope<{ addon_name: string }[]>(result);
    expect(env.ok).toBe(true);
    expect(env.data).toHaveLength(1);
    expect(env.data?.[0]).toEqual({
      addon_id: UUID,
      addon_name: 'kafka-clean-72346',
      plan: 'heroku-kafka:basic-0',
      status: 'provisioned',
      attached_app: 'dm-kafkatest',
      created_at: '2026-06-10T13:57:20Z',
    });
    // First page used a fresh Range header (no cursor yet).
    expect(calls[0]?.headers.range).toMatch(/^name \.\.; max=/);
  });

  it('kafka_list follows Next-Range across pages (test addon sorts onto a later page)', async () => {
    const { client, calls } = await spinUpServer({
      responses: [
        {
          // page 2: the cursor page (Range carries a `]` start marker from the
          // prior Next-Range) holds the kafka add-on. Listed first so its more
          // specific matcher wins over page 1's.
          match: (url, init) =>
            url === 'https://api.heroku.com/addons' && rangeOf(init)?.includes(']') === true,
          body: [
            {
              id: UUID,
              name: 'kafka-clean-72346',
              addon_service: { name: 'heroku-kafka' },
              plan: { name: 'heroku-kafka:basic-0' },
              state: 'provisioned',
              app: { name: 'dm-kafkatest' },
            },
          ],
        },
        {
          // page 1: a fresh `name ..` range, no kafka; signals more via next-range.
          match: (url, init) =>
            url === 'https://api.heroku.com/addons' &&
            rangeOf(init)?.startsWith('name ..') === true,
          headers: { 'next-range': 'name ]inference-rigid-89489..; max=1000' },
          body: [{ id: 'x', name: 'acme-1', addon_service: { name: 'cloudinary' } }],
        },
      ],
    });
    const result = (await client.callTool({ name: 'kafka_list', arguments: {} })) as {
      content: unknown[];
    };
    const env = parseEnvelope<{ addon_name: string }[]>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.map((d) => d.addon_name)).toEqual(['kafka-clean-72346']);
    expect(calls).toHaveLength(2);
  });

  it('kafka_info hits the Data API by UUID with Basic auth + a plain-JSON Accept header', async () => {
    const { client, calls } = await spinUpServer({
      responses: [
        {
          match: (url) => url === `${CLUSTER}/${UUID}`,
          body: { name: 'kafka-clean-72346', state: { status: 'green' } },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'kafka_info',
      arguments: { cluster: UUID },
    })) as { content: unknown[] };
    expect(parseEnvelope(result).ok).toBe(true);
    expect(calls[0]?.url).toBe(`${CLUSTER}/${UUID}`);
    expect(calls[0]?.headers.accept).toBe('application/json');
    expect(calls[0]?.headers.authorization).toBe(expectedBasicAuth);
  });

  it('kafka_info resolves an add-on NAME to its UUID before calling the Data API', async () => {
    const { client, calls } = await spinUpServer({
      responses: [
        {
          // name → UUID lookup on the Platform API
          match: (url) => url === 'https://api.heroku.com/addons/kafka-clean-72346',
          body: { id: UUID, name: 'kafka-clean-72346', app: { name: 'dm-kafkatest' } },
        },
        {
          match: (url) => url === `${CLUSTER}/${UUID}`,
          body: { name: 'kafka-clean-72346' },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'kafka_info',
      arguments: { cluster: 'kafka-clean-72346' },
    })) as { content: unknown[] };
    expect(parseEnvelope(result).ok).toBe(true);
    // The cluster endpoint was dialed with the resolved UUID, not the name.
    expect(calls.map((c) => c.url)).toContain(`${CLUSTER}/${UUID}`);
  });

  it('kafka_info drops the internal metaas_source but keeps the control-plane body', async () => {
    const body = fixture('kafka-info.captured.json') as Record<string, unknown>;
    expect(typeof body.metaas_source).toBe('string'); // sanity: fixture has the field
    const { client } = await spinUpServer({
      responses: [{ match: (url) => url === `${CLUSTER}/${UUID}`, body }],
    });
    const result = (await client.callTool({
      name: 'kafka_info',
      arguments: { cluster: UUID },
    })) as { content: unknown[] };
    const env = parseEnvelope<Record<string, unknown>>(result);
    expect(env.ok).toBe(true);
    expect(env.data).not.toHaveProperty('metaas_source');
    expect(env.data?.name).toBe(body.name);
    expect(env.data?.limits).toBeDefined();
    expect(env.data?.topic_prefix).toBe('pearl-60818.');
  });
});

describe('redactKafkaInfo', () => {
  it('drops metaas_source and leaves everything else', () => {
    const out = redactKafkaInfo({
      name: 'k',
      metaas_source: 'dod-kafka-tenant://x',
      limits: { max_topics: 40 },
    }) as Record<string, unknown>;
    expect(out).not.toHaveProperty('metaas_source');
    expect(out.name).toBe('k');
    expect(out.limits).toEqual({ max_topics: 40 });
  });
  it('passes non-object bodies through unchanged', () => {
    expect(redactKafkaInfo(null)).toBeNull();
    expect(redactKafkaInfo('x')).toBe('x');
  });
});
