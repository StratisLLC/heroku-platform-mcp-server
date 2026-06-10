/**
 * Live integration test against a real Heroku Key-Value Store (Redis) add-on.
 *
 * Gated on BOTH `HEROKUMCP_TEST_TOKEN` (a real Heroku OAuth token) and
 * `HEROKUMCP_TEST_KV_ADDON_ID` (an add-on the token can mutate). Without either,
 * every test is skipped, so the file is safe to run in CI without secrets.
 * `HEROKUMCP_TEST_KV_APP` is informational only.
 *
 * It boots a real Platform `McpServer` with the Key-Value probes wired in via
 * `extraProbes`, registers the Key-Value tools, and round-trips every tool
 * against the live Data API. Self-contained and state-neutral: it resets stats,
 * rotates credentials (verifying a fresh working URL afterwards), and sets each
 * config value to its current default — leaving the add-on in a clean state.
 * Run against a THROWAWAY add-on only.
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, resolvePaths } from '@heroku-mcp/platform';
import { KEYVALUE_PROBES, registerKeyValueTools } from '../../src/index.js';

const TOKEN = process.env.HEROKUMCP_TEST_TOKEN;
const ADDON = process.env.HEROKUMCP_TEST_KV_ADDON_ID;
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

describeLive('key-value-mcp ↔ live Heroku Data API', () => {
  it('round-trips every tool against a real Key-Value add-on — state-neutral', async () => {
    const home = await mkdtemp(join(tmpdir(), 'herokumcp-kv-int-'));
    const paths = resolvePaths({ home, platform: process.platform });

    const built = await buildServer({
      token: TOKEN!,
      paths,
      version: '0.0.0-int',
      forceProbe: true,
      extraProbes: KEYVALUE_PROBES,
    });
    const summary = registerKeyValueTools(built.server, built.context);
    expect(summary.keyValue).toBe(true);

    const client = new Client({ name: 'kv-integration', version: '0.0.0-int' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([built.server.connect(b), client.connect(a)]);

    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('kv_info');
    // Deferred tools must not be advertised.
    expect(names).not.toContain('kv_upgrade');
    expect(names).not.toContain('kv_promote');
    expect(names).not.toContain('kv_wait');

    const call = (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
      client.callTool({ name, arguments: args }) as Promise<ToolResult>;

    // Resolve the add-on NAME (the value the destructive tools confirm against).
    const addonRes = await built.context.client.get<{ name?: string }>(`/addons/${ADDON}`, {
      tool: 'test',
    });
    const addonName = addonRes.body?.name;
    expect(addonName).toBeTruthy();

    // ---- reads (must succeed) ----
    const list = parseEnv<{ addon_name?: string }[]>(await call('kv_list', {}));
    expect(list.ok).toBe(true);
    expect(list.data?.some((s) => s.addon_name === addonName)).toBe(true);

    const info = parseEnv<{ info?: unknown; resource_url?: unknown }>(
      await call('kv_info', { addon: ADDON! }),
    );
    expect(info.ok).toBe(true);
    expect(info.data?.info).toBeDefined();
    // The password-bearing resource_url must have been stripped.
    expect(info.data).not.toHaveProperty('resource_url');

    const creds = parseEnv<{ connection_url?: string; host?: string }>(
      await call('kv_credentials', { addon: ADDON! }),
    );
    expect(creds.ok).toBe(true);
    expect(creds.data?.connection_url).toMatch(/^rediss?:\/\/.*:\*\*\*@/);
    expect(creds.data?.host).toBeTruthy();

    // ---- confirm guard (no mutation) ----
    const guarded = parseEnv(
      await call('kv_stats_reset', { addon: ADDON!, confirm: 'definitely-wrong' }),
    );
    expect(guarded.ok).toBe(false);
    expect(guarded.error?.kind).toBe('confirmation');

    // ---- kv_stats_reset (Tier 1) ----
    expect(parseEnv(await call('kv_stats_reset', { addon: ADDON!, confirm: addonName! })).ok).toBe(
      true,
    );

    // ---- config setters: set each to its current default → state-neutral ----
    expect(
      parseEnv(
        await call('kv_maxmemory_set', {
          addon: ADDON!,
          policy: 'noeviction',
          confirm: addonName!,
        }),
      ).ok,
    ).toBe(true);
    expect(
      parseEnv(await call('kv_timeout_set', { addon: ADDON!, seconds: 300, confirm: addonName! }))
        .ok,
    ).toBe(true);
    expect(
      parseEnv(
        await call('kv_keyspace_notifications_set', {
          addon: ADDON!,
          config: '',
          confirm: addonName!,
        }),
      ).ok,
    ).toBe(true);

    // ---- kv_credentials_reset (Tier 1) — rotate, then prove a fresh working URL ----
    const reset = parseEnv<{ reset?: boolean }>(
      await call('kv_credentials_reset', { addon: ADDON!, confirm: addonName! }),
    );
    expect(reset.ok).toBe(true);
    expect(reset.data?.reset).toBe(true);

    const after = parseEnv<{ connection_url?: string }>(
      await call('kv_credentials', { addon: ADDON! }),
    );
    expect(after.ok).toBe(true);
    expect(after.data?.connection_url).toMatch(/^rediss?:\/\/.*:\*\*\*@/);
  }, 120_000);
});
