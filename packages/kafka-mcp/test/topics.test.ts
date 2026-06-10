/**
 * Topic tool tests: kafka_topics_list, kafka_topics_info.
 *
 * `kafka_topics_info` has no per-topic endpoint — it fetches the topic list and
 * filters client-side — so these tests assert it dials only `.../topics` and
 * selects the right entry (matched with or without the cluster KAFKA_PREFIX).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseEnvelope, spinUpServer } from './helpers.js';

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8'));
}

const UUID = 'a47a6373-58fd-46bd-886d-9f505a8812ad';
const TOPICS_URL = `https://api.data.heroku.com/data/kafka/v0/clusters/${UUID}/topics`;
const expectedBasicAuth = `Basic ${Buffer.from(':HRKU-test-token').toString('base64')}`;

describe('topic tools', () => {
  it('registers the topic read tools', async () => {
    const { client } = await spinUpServer();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['kafka_topics_list', 'kafka_topics_info']));
  });

  it('kafka_topics_list GETs /topics by UUID with Basic auth and passes the body through', async () => {
    const body = fixture('kafka-topics-list.captured.json') as Record<string, unknown>;
    const { client, calls } = await spinUpServer({
      responses: [{ match: (url) => url === TOPICS_URL, body }],
    });
    const result = (await client.callTool({
      name: 'kafka_topics_list',
      arguments: { cluster: UUID },
    })) as { content: unknown[] };
    const env = parseEnvelope<Record<string, unknown>>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.prefix).toBe('pearl-60818.');
    expect(Array.isArray(env.data?.topics)).toBe(true);
    expect(calls[0]?.url).toBe(TOPICS_URL);
    expect(calls[0]?.headers.authorization).toBe(expectedBasicAuth);
    expect(calls[0]?.headers.accept).toBe('application/json');
  });

  it('kafka_topics_info selects the topic by its short name', async () => {
    const body = fixture('kafka-topics-list.captured.json') as Record<string, unknown>;
    const { client, calls } = await spinUpServer({
      responses: [{ match: (url) => url === TOPICS_URL, body }],
    });
    const result = (await client.callTool({
      name: 'kafka_topics_info',
      arguments: { cluster: UUID, topic: 'mcp-test-topic' },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ name?: string; partitions?: number }>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.name).toBe('mcp-test-topic');
    expect(env.data?.partitions).toBe(8);
    // No per-topic endpoint was dialed — only the list.
    expect(calls.map((c) => c.url)).toEqual([TOPICS_URL]);
  });

  it('kafka_topics_info matches a fully-prefixed topic name too', async () => {
    const body = fixture('kafka-topics-list.captured.json') as Record<string, unknown>;
    const { client } = await spinUpServer({
      responses: [{ match: (url) => url === TOPICS_URL, body }],
    });
    const result = (await client.callTool({
      name: 'kafka_topics_info',
      arguments: { cluster: UUID, topic: 'pearl-60818.mcp-test-topic' },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ name?: string }>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.name).toBe('mcp-test-topic');
  });

  it('kafka_topics_info returns a not_found error for an unknown topic', async () => {
    const body = fixture('kafka-topics-list.captured.json') as Record<string, unknown>;
    const { client } = await spinUpServer({
      responses: [{ match: (url) => url === TOPICS_URL, body }],
    });
    const result = (await client.callTool({
      name: 'kafka_topics_info',
      arguments: { cluster: UUID, topic: 'does-not-exist' },
    })) as { content: unknown[] };
    const env = parseEnvelope(result);
    expect(env.ok).toBe(false);
    expect(env.error?.kind).toBe('not_found');
  });
});
