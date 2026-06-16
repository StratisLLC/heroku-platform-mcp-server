/**
 * Tier 2 integration test — the /mcp-codemode protocol surface.
 *
 * Drives a real MCP `Client` against a real Code Mode meta server over an
 * in-memory transport (no Postgres / OAuth needed — the HTTP/auth boilerplate
 * mirrors the already-tested /mcp route). Verifies the actual protocol surface:
 *   - tools/list advertises exactly the 3 meta-tools
 *   - search returns Standard-detail results across categories
 *   - execute runs a known tool and surfaces the underlying envelope
 *   - execute with bad args / unknown name → clean error envelopes
 *   - auth_status returns the full identity payload
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CapabilityResult, HerokuClient } from '@heroku-mcp/core';
import { ToolCatalog, collectRegisteredTools } from '../../src/codemode/index.js';
import {
  buildDispatchMap,
  registerCodemodeMetaTools,
  type CodemodeContext,
} from '../../src/codemode/meta-tools.js';

interface CallResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

function envelope(res: unknown): {
  ok: boolean;
  data?: unknown;
  error?: { kind: string; message: string };
} {
  const text = (res as CallResult).content[0]!.text;
  return JSON.parse(text) as never;
}

const caps: CapabilityResult = {
  schemaVersion: 1,
  tokenFingerprint: 'fp',
  probedAt: '2026-06-12T00:00:00.000Z',
  ttlSeconds: 3600,
  tiers: {
    apps: { available: true },
    addons: { available: true },
    data: { postgres: { available: true }, kafka: { available: true } },
  },
};

/** A 5-tool "full" server spanning all four categories. */
function buildFull(): McpServer {
  const full = new McpServer({ name: 'full', version: '0' }, { capabilities: { tools: {} } });
  full.registerTool(
    'apps_info',
    {
      description: 'Return one Heroku app by id or name.',
      inputSchema: { app: z.string().min(1) },
    },
    async ({ app }) => ({
      content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { app } }) }],
    }),
  );
  full.registerTool(
    'addons_list',
    { description: 'List add-ons on an app.', inputSchema: { app: z.string().min(1) } },
    async ({ app }) => ({
      content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { app, addons: [] } }) }],
    }),
  );
  full.registerTool(
    'pg_info',
    { description: 'Show Postgres database status.', inputSchema: { database: z.string().min(1) } },
    async ({ database }) => ({
      content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { database } }) }],
    }),
  );
  full.registerTool(
    'kv_info',
    { description: 'Show key-value store info.', inputSchema: { addon: z.string().min(1) } },
    async () => ({
      content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { kind: 'kv' } }) }],
    }),
  );
  full.registerTool(
    'kafka_info',
    { description: 'Show Kafka cluster info.', inputSchema: { cluster: z.string().min(1) } },
    async () => ({
      content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { kind: 'kafka' } }) }],
    }),
  );
  return full;
}

function buildMetaServer(): McpServer {
  const full = buildFull();
  const collected = collectRegisteredTools(full);
  const catalog = new ToolCatalog(
    [...collected.entries()].map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  );
  const client = {
    get: vi.fn(async (path: string) => {
      if (path === '/teams')
        return { status: 200, body: [{ id: 't1', name: 'acme' }], headers: {} };
      if (path === '/enterprise-accounts') return { status: 200, body: [], headers: {} };
      throw new Error('unexpected ' + path);
    }),
  } as unknown as HerokuClient;
  const ctx: CodemodeContext = {
    catalog,
    dispatch: buildDispatchMap(collected),
    identity: { email: 'dev@example.com' },
    client,
    getCapabilities: () => caps,
  };
  const meta = new McpServer(
    { name: 'herokumcp-codemode-http', version: '1.1.0' },
    { capabilities: { tools: { listChanged: true } } },
  );
  registerCodemodeMetaTools(meta, ctx);
  return meta;
}

async function connectedClient(): Promise<Client> {
  const meta = buildMetaServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await meta.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0' });
  await client.connect(clientTransport);
  return client;
}

describe('/mcp-codemode protocol surface', () => {
  it('advertises exactly the 3 meta-tools in tools/list', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['auth_status', 'execute', 'search']);
    await client.close();
  });

  it('search finds tools across all four categories', async () => {
    const client = await connectedClient();
    for (const [query, expected, category] of [
      ['apps', 'apps_info', undefined],
      ['pg', 'pg_info', 'postgres'],
      ['kv', 'kv_info', 'key-value'],
      ['kafka', 'kafka_info', 'kafka'],
    ] as const) {
      const args: Record<string, unknown> = { query };
      if (category) args.category = category;
      const res = await client.callTool({ name: 'search', arguments: args });
      const data = envelope(res).data as { results: { name: string }[] };
      expect(data.results.map((r) => r.name)).toContain(expected);
    }
    await client.close();
  });

  it('execute runs a known tool and returns its envelope', async () => {
    const client = await connectedClient();
    const res = await client.callTool({
      name: 'execute',
      arguments: { name: 'apps_info', args: { app: 'my-app' } },
    });
    expect((res as CallResult).isError).toBeFalsy();
    expect(envelope(res)).toMatchObject({ ok: true, data: { app: 'my-app' } });
    await client.close();
  });

  it('execute with bad args returns a clean error envelope', async () => {
    const client = await connectedClient();
    const res = await client.callTool({
      name: 'execute',
      arguments: { name: 'apps_info', args: {} },
    });
    expect((res as CallResult).isError).toBe(true);
    expect(envelope(res).error?.kind).toBe('invalid_params');
    await client.close();
  });

  it('execute with an unknown tool returns a clean error envelope', async () => {
    const client = await connectedClient();
    const res = await client.callTool({ name: 'execute', arguments: { name: 'nope', args: {} } });
    expect((res as CallResult).isError).toBe(true);
    expect(envelope(res).error?.kind).toBe('not_found');
    await client.close();
  });

  it('auth_status returns the full identity payload', async () => {
    const client = await connectedClient();
    const res = await client.callTool({ name: 'auth_status', arguments: {} });
    const data = envelope(res).data as {
      authenticated: boolean;
      email: string;
      scopes: string[];
      teams: { name: string }[];
      orgs: unknown[];
    };
    expect(data.authenticated).toBe(true);
    expect(data.email).toBe('dev@example.com');
    expect(data.scopes).toEqual(['addons', 'apps', 'data.kafka', 'data.postgres']);
    expect(data.teams).toEqual([{ id: 't1', name: 'acme' }]);
    expect(data.orgs).toEqual([]);
    await client.close();
  });
});
