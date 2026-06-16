/**
 * Tier 1 unit tests — the three Code Mode meta-tools (search/execute/auth_status).
 *
 * A small "full" McpServer stands in for the real catalog; meta-tools are
 * registered onto a separate meta server and driven through their handlers.
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CapabilityResult, HerokuClient, ToolResult } from '@heroku-mcp/core';
import { ToolCatalog, collectRegisteredTools } from '../../src/codemode/index.js';
import {
  buildDispatchMap,
  registerCodemodeMetaTools,
  summarizeScopes,
  type CodemodeContext,
} from '../../src/codemode/meta-tools.js';

/** Decode a meta-tool's CallToolResult into its parsed envelope. */
function envelopeOf(result: ToolResult): {
  ok: boolean;
  data?: unknown;
  error?: { kind: string; message: string; details?: unknown };
} {
  const text = (result.content[0] as { text: string }).text;
  return JSON.parse(text) as never;
}

function buildFullServer(): McpServer {
  const full = new McpServer({ name: 'full', version: '0' }, { capabilities: { tools: {} } });
  full.registerTool(
    'apps_info',
    { description: 'Return one app by id or name.', inputSchema: { app: z.string().min(1) } },
    async ({ app }) => ({
      content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { app } }) }],
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
    'kafka_info',
    { description: 'Show Kafka cluster info.', inputSchema: { cluster: z.string().min(1) } },
    async () => ({ content: [{ type: 'text', text: 'kafka' }] }),
  );
  full.registerTool(
    'account_info',
    { description: 'Return the authenticated account.' },
    async () => ({
      content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { who: 'me' } }) }],
    }),
  );
  return full;
}

function fakeClient(overrides?: Partial<Record<string, unknown[]>>): HerokuClient {
  const get = vi.fn(async (path: string) => {
    if (path === '/teams') {
      return {
        status: 200,
        body: overrides?.['/teams'] ?? [{ id: 't1', name: 'team-one' }],
        headers: {},
      };
    }
    if (path === '/enterprise-accounts') {
      return {
        status: 200,
        body: overrides?.['/enterprise-accounts'] ?? [{ id: 'o1', name: 'org-one' }],
        headers: {},
      };
    }
    throw new Error('unexpected path ' + path);
  });
  return { get } as unknown as HerokuClient;
}

const caps: CapabilityResult = {
  schemaVersion: 1,
  tokenFingerprint: 'fp',
  probedAt: '2026-06-12T00:00:00.000Z',
  ttlSeconds: 3600,
  tiers: {
    apps: { available: true },
    addons: { available: false, reason: 'forbidden' },
    data: {
      postgres: { available: true },
      kafka: { available: false, reason: 'not_found' },
    },
  },
};

function buildCtx(client: HerokuClient = fakeClient()): { ctx: CodemodeContext; full: McpServer } {
  const full = buildFullServer();
  const collected = collectRegisteredTools(full);
  const catalog = new ToolCatalog(
    [...collected.entries()].map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  );
  const ctx: CodemodeContext = {
    catalog,
    dispatch: buildDispatchMap(collected),
    identity: { email: 'dev@example.com' },
    client,
    getCapabilities: () => caps,
  };
  return { ctx, full };
}

/** Register meta-tools and return their handlers by name. */
function metaHandlers(ctx: CodemodeContext): Map<string, (...a: unknown[]) => unknown> {
  const meta = new McpServer({ name: 'meta', version: '0' }, { capabilities: { tools: {} } });
  registerCodemodeMetaTools(meta, ctx);
  const collected = collectRegisteredTools(meta);
  const map = new Map<string, (...a: unknown[]) => unknown>();
  for (const [name, t] of collected) map.set(name, t.handler as (...a: unknown[]) => unknown);
  return map;
}

const EXTRA = { signal: new AbortController().signal };

describe('meta server registration', () => {
  it('registers exactly the three meta-tools', () => {
    const { ctx } = buildCtx();
    const h = metaHandlers(ctx);
    expect([...h.keys()].sort()).toEqual(['auth_status', 'execute', 'search']);
  });
});

describe('search tool', () => {
  it('returns Standard-detail results with parameter lists', async () => {
    const { ctx } = buildCtx();
    const search = metaHandlers(ctx).get('search')!;
    const env = envelopeOf((await search({ query: 'apps', limit: 20 }, EXTRA)) as ToolResult);
    expect(env.ok).toBe(true);
    const data = env.data as {
      total: number;
      catalog_size: number;
      results: { name: string; parameters: unknown[] }[];
    };
    expect(data.catalog_size).toBe(4);
    const apps = data.results.find((r) => r.name === 'apps_info');
    expect(apps?.parameters).toEqual([{ name: 'app', type: 'string', required: true }]);
  });

  it('filters by category', async () => {
    const { ctx } = buildCtx();
    const search = metaHandlers(ctx).get('search')!;
    const env = envelopeOf(
      (await search({ query: 'info', category: 'postgres', limit: 20 }, EXTRA)) as ToolResult,
    );
    const data = env.data as { results: { name: string }[] };
    expect(data.results.map((r) => r.name)).toEqual(['pg_info']);
  });
});

describe('execute tool', () => {
  it('dispatches a known tool with valid args', async () => {
    const { ctx } = buildCtx();
    const execute = metaHandlers(ctx).get('execute')!;
    const result = (await execute(
      { name: 'apps_info', args: { app: 'my-app' } },
      EXTRA,
    )) as ToolResult;
    expect(result.isError).toBeFalsy();
    const env = envelopeOf(result);
    expect(env).toMatchObject({ ok: true, data: { app: 'my-app' } });
  });

  it('dispatches a no-arg tool with {}', async () => {
    const { ctx } = buildCtx();
    const execute = metaHandlers(ctx).get('execute')!;
    const result = (await execute({ name: 'account_info', args: {} }, EXTRA)) as ToolResult;
    const env = envelopeOf(result);
    expect(env).toMatchObject({ ok: true, data: { who: 'me' } });
  });

  it('returns a clean not_found envelope for an unknown tool', async () => {
    const { ctx } = buildCtx();
    const execute = metaHandlers(ctx).get('execute')!;
    const result = (await execute({ name: 'does_not_exist', args: {} }, EXTRA)) as ToolResult;
    expect(result.isError).toBe(true);
    const env = envelopeOf(result);
    expect(env.ok).toBe(false);
    expect(env.error?.kind).toBe('not_found');
    expect(env.error?.message).toMatch(/search\(\)/);
  });

  it('returns a clean invalid_params envelope for bad args', async () => {
    const { ctx } = buildCtx();
    const execute = metaHandlers(ctx).get('execute')!;
    // apps_info requires a non-empty `app`.
    const result = (await execute({ name: 'apps_info', args: {} }, EXTRA)) as ToolResult;
    expect(result.isError).toBe(true);
    const env = envelopeOf(result);
    expect(env.error?.kind).toBe('invalid_params');
    expect(env.error?.details).toBeDefined();
  });

  it('propagates the underlying tool error envelope unchanged', async () => {
    // Register a tool whose handler returns an error envelope; execute must
    // pass it straight through.
    const full = new McpServer({ name: 'full', version: '0' }, { capabilities: { tools: {} } });
    full.registerTool(
      'boom',
      { description: 'always errors', inputSchema: { x: z.string() } },
      async () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: false, error: { kind: 'server', message: 'kaboom' } }),
          },
        ],
        isError: true,
      }),
    );
    const collected = collectRegisteredTools(full);
    const ctx: CodemodeContext = {
      catalog: new ToolCatalog(
        [...collected.entries()].map(([name, t]) => ({
          name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      ),
      dispatch: buildDispatchMap(collected),
      identity: { email: 'x@y.z' },
      client: fakeClient(),
      getCapabilities: () => caps,
    };
    const execute = metaHandlers(ctx).get('execute')!;
    const result = (await execute({ name: 'boom', args: { x: 'a' } }, EXTRA)) as ToolResult;
    expect(result.isError).toBe(true);
    expect(envelopeOf(result).error?.message).toBe('kaboom');
  });
});

describe('auth_status tool', () => {
  it('returns the full payload: email, scopes, teams, orgs', async () => {
    const { ctx } = buildCtx();
    const auth = metaHandlers(ctx).get('auth_status')!;
    const env = envelopeOf((await auth({}, EXTRA)) as ToolResult);
    expect(env.ok).toBe(true);
    expect(env.data).toEqual({
      authenticated: true,
      email: 'dev@example.com',
      scopes: ['apps', 'data.postgres'],
      teams: [{ id: 't1', name: 'team-one' }],
      orgs: [{ id: 'o1', name: 'org-one' }],
    });
  });

  it('returns empty teams/orgs when the live calls fail', async () => {
    const client = {
      get: vi.fn(async () => {
        throw new Error('403');
      }),
    } as unknown as HerokuClient;
    const { ctx } = buildCtx(client);
    const auth = metaHandlers(ctx).get('auth_status')!;
    const env = envelopeOf((await auth({}, EXTRA)) as ToolResult);
    const data = env.data as { teams: unknown[]; orgs: unknown[] };
    expect(data.teams).toEqual([]);
    expect(data.orgs).toEqual([]);
  });
});

describe('summarizeScopes', () => {
  it('flattens available tiers, including nested data sub-tiers', () => {
    expect(summarizeScopes(caps)).toEqual(['apps', 'data.postgres']);
  });
});
