/**
 * Consumer-group tool tests: kafka_consumer_groups_list.
 *
 * Guards the divergence the research gate caught: the sub-resource path uses an
 * UNDERSCORE (`/consumer_groups`), not a hyphen.
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
const GROUPS_URL = `https://api.data.heroku.com/data/kafka/v0/clusters/${UUID}/consumer_groups`;
const expectedBasicAuth = `Basic ${Buffer.from(':HRKU-test-token').toString('base64')}`;

describe('consumer-group tools', () => {
  it('registers the consumer-group read tool', async () => {
    const { client } = await spinUpServer();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('kafka_consumer_groups_list');
  });

  it('kafka_consumer_groups_list GETs /consumer_groups (underscore) by UUID with Basic auth', async () => {
    const body = fixture('kafka-consumer-groups-list.captured.json') as Record<string, unknown>;
    const { client, calls } = await spinUpServer({
      responses: [{ match: (url) => url === GROUPS_URL, body }],
    });
    const result = (await client.callTool({
      name: 'kafka_consumer_groups_list',
      arguments: { cluster: UUID },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ consumer_groups?: { name: string }[] }>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.consumer_groups?.[0]?.name).toBe('mcp-test-group');
    expect(calls[0]?.url).toBe(GROUPS_URL);
    expect(calls[0]?.url).toContain('/consumer_groups');
    expect(calls[0]?.url).not.toContain('/consumer-groups');
    expect(calls[0]?.headers.authorization).toBe(expectedBasicAuth);
    expect(calls[0]?.headers.accept).toBe('application/json');
  });
});
