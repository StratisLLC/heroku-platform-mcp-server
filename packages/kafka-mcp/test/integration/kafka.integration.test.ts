/**
 * Live integration test against a real Heroku Apache Kafka add-on.
 *
 * Gated on BOTH `HEROKUMCP_TEST_TOKEN` (a real Heroku OAuth token) and
 * `HEROKUMCP_TEST_KAFKA_ADDON_ID` (a cluster the token can read). Without either,
 * every test is skipped, so the file is safe to run in CI without secrets.
 * `HEROKUMCP_TEST_KAFKA_APP` / `_PREFIX` are informational only.
 *
 * READ-ONLY and state-neutral by construction: Part A ships no write tools and
 * this test creates/destroys nothing. It reads whatever the operator
 * pre-provisioned on the cluster (a `mcp-test-topic` topic and a
 * `mcp-test-group` consumer group). The operator owns the environment lifecycle,
 * including teardown — agent/test code stays pure-HTTP and never shells out.
 *
 * It boots a real Platform `McpServer` with the Kafka probes wired in via
 * `extraProbes`, registers the Kafka tools, and round-trips every read tool
 * against the live Data API.
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, resolvePaths } from '@heroku-mcp/platform';
import { KAFKA_PROBES, registerKafkaTools } from '../../src/index.js';

const TOKEN = process.env.HEROKUMCP_TEST_TOKEN;
const ADDON = process.env.HEROKUMCP_TEST_KAFKA_ADDON_ID;
const describeLive = TOKEN && ADDON ? describe : describe.skip;

interface Envelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { kind?: string; message?: string };
}
interface ToolResult {
  content: unknown[];
  isError?: boolean;
}
function parseEnv<T = unknown>(result: ToolResult): Envelope<T> {
  const first = result.content[0] as { text?: string };
  return JSON.parse(first.text!) as Envelope<T>;
}

describeLive('kafka-mcp ↔ live Heroku Data API (read-only)', () => {
  it('round-trips every read tool against a real Kafka cluster', async () => {
    const home = await mkdtemp(join(tmpdir(), 'herokumcp-kafka-int-'));
    const paths = resolvePaths({ home, platform: process.platform });

    const built = await buildServer({
      token: TOKEN!,
      paths,
      version: '0.0.0-int',
      forceProbe: true,
      extraProbes: KAFKA_PROBES,
    });
    const summary = registerKafkaTools(built.server, built.context);
    expect(summary.kafka).toBe(true);

    const client = new Client({ name: 'kafka-integration', version: '0.0.0-int' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([built.server.connect(b), client.connect(a)]);

    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'kafka_list',
        'kafka_info',
        'kafka_topics_list',
        'kafka_topics_info',
        'kafka_consumer_groups_list',
      ]),
    );
    // Deferred write / protocol tools must not be advertised.
    expect(names).not.toContain('kafka_topics_create');
    expect(names).not.toContain('kafka_topics_destroy');
    expect(names).not.toContain('kafka_fail');

    const call = (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
      client.callTool({ name, arguments: args }) as Promise<ToolResult>;

    // Resolve the add-on NAME via the Platform API (exercise both id + name paths).
    const addonRes = await built.context.client.get<{ name?: string }>(`/addons/${ADDON}`, {
      tool: 'test',
    });
    const addonName = addonRes.body?.name;
    expect(addonName).toBeTruthy();

    // ---- kafka_list: the cluster shows up by name ----
    const list = parseEnv<{ addon_name?: string }[]>(await call('kafka_list', {}));
    expect(list.ok).toBe(true);
    expect(list.data?.some((c) => c.addon_name === addonName)).toBe(true);

    // ---- kafka_info: by UUID, then by NAME (exercises resolveClusterId) ----
    const infoById = parseEnv<{ limits?: unknown; state?: unknown; metaas_source?: unknown }>(
      await call('kafka_info', { cluster: ADDON! }),
    );
    expect(infoById.ok).toBe(true);
    expect(infoById.data?.limits).toBeDefined();
    expect(infoById.data?.state).toBeDefined();
    // The internal tenant-routing URI must have been stripped.
    expect(infoById.data).not.toHaveProperty('metaas_source');

    const infoByName = parseEnv(await call('kafka_info', { cluster: addonName! }));
    expect(infoByName.ok).toBe(true);

    // ---- kafka_topics_list ----
    const topics = parseEnv<{ topics?: { name?: string }[]; prefix?: string }>(
      await call('kafka_topics_list', { cluster: ADDON! }),
    );
    expect(topics.ok).toBe(true);
    expect(Array.isArray(topics.data?.topics)).toBe(true);
    const firstTopic = topics.data?.topics?.[0]?.name;
    expect(firstTopic).toBeTruthy();

    // ---- kafka_topics_info: select the pre-provisioned topic by its short name ----
    const topicInfo = parseEnv<{ name?: string; partitions?: number }>(
      await call('kafka_topics_info', { cluster: ADDON!, topic: firstTopic! }),
    );
    expect(topicInfo.ok).toBe(true);
    expect(topicInfo.data?.name).toBe(firstTopic);

    // An unknown topic surfaces a structured not_found (no per-topic endpoint).
    const missing = parseEnv(
      await call('kafka_topics_info', { cluster: ADDON!, topic: 'definitely-not-a-real-topic' }),
    );
    expect(missing.ok).toBe(false);
    expect(missing.error?.kind).toBe('not_found');

    // ---- kafka_consumer_groups_list ----
    const groups = parseEnv<{ consumer_groups?: { name?: string }[] }>(
      await call('kafka_consumer_groups_list', { cluster: ADDON! }),
    );
    expect(groups.ok).toBe(true);
    expect(Array.isArray(groups.data?.consumer_groups)).toBe(true);
  }, 120_000);
});
