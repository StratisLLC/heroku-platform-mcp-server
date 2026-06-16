/**
 * Tier 3 — token-savings benchmark (Phase 9).
 *
 * Measures the real reduction in tool-schema transmission between `/mcp` and
 * `/mcp-codemode`. Boots the FULL tool catalog (capability probes mocked to
 * pass so every tier registers), then compares:
 *
 *   baseline   = the `/mcp` tools/list wire payload (every tool's full JSON
 *                schema) — transmitted once per conversation.
 *   code mode  = the `/mcp-codemode` tools/list payload (3 meta-tools) PLUS a
 *                representative search-driven discovery sequence.
 *
 * Runnable on demand (not in CI):
 *   CODEMODE_BENCH=1 pnpm --filter @heroku-mcp/http-server test -- codemode-tokens
 *
 * Token counts are a transparent char/4 approximation (no tokenizer/ML
 * dependency, per the no-embeddings architectural rule). The number the README
 * quotes is whatever this prints; honesty over flattery.
 */

import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildSessionMcp } from '../../src/mcp/setup.js';
import { ToolCatalog, collectRegisteredTools } from '../../src/codemode/index.js';
import {
  buildDispatchMap,
  registerCodemodeMetaTools,
  type CodemodeContext,
} from '../../src/codemode/meta-tools.js';
import type { CapabilityResult, HerokuClient } from '@heroku-mcp/core';

const run = process.env.CODEMODE_BENCH ? describe : describe.skip;

/** char/4 token approximation. */
function tokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/** Fake Heroku fetch: every probe URL returns 200 so all tiers light up. */
const probePassFetch: typeof globalThis.fetch = (async () =>
  new Response('[]', {
    status: 200,
    headers: { 'content-type': 'application/json', 'content-range': 'id ..; max=200, count=0' },
  })) as unknown as typeof globalThis.fetch;

async function buildFullServer(): Promise<McpServer> {
  const built = await buildSessionMcp({
    getAccessToken: async () => 'fake-token',
    tokenFingerprint: 'benchmark0000000',
    auditSink: async () => undefined,
    getAuditContext: () => ({ userId: 'u', clientName: null, clientVersion: null }),
    version: '1.1.0',
    fetch: probePassFetch,
  });
  return built.server;
}

async function wirePayload(server: McpServer): Promise<{ count: number; json: string }> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'bench', version: '0' });
  await client.connect(ct);
  const { tools } = await client.listTools();
  const json = JSON.stringify(tools);
  await client.close();
  return { count: tools.length, json };
}

function buildCodemodeMeta(full: McpServer): McpServer {
  const collected = collectRegisteredTools(full);
  const catalog = new ToolCatalog(
    [...collected.entries()].map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  );
  const caps: CapabilityResult = {
    schemaVersion: 1,
    tokenFingerprint: 'fp',
    probedAt: '2026-06-12T00:00:00.000Z',
    ttlSeconds: 3600,
    tiers: {},
  };
  const client = {
    get: async () => ({ status: 200, body: [], headers: {} }),
  } as unknown as HerokuClient;
  const ctx: CodemodeContext = {
    catalog,
    dispatch: buildDispatchMap(collected),
    identity: { email: 'bench@example.com' },
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

run('codemode token-savings benchmark', () => {
  it('reports the reduction in tool-schema transmission', async () => {
    const full = await buildFullServer();
    const baseline = await wirePayload(full);

    const meta = buildCodemodeMeta(full);
    const codemodeList = await wirePayload(meta);

    // A representative discovery sequence: the model searches a handful of times
    // to find the tools a real task touches. Each search returns Standard-detail
    // entries (the token-lean projection). We sum the response payloads.
    const catalog = ToolCatalog.fromServer(full);
    const searches = ['app', 'config', 'addon', 'dyno', 'release', 'pg', 'log'];
    let searchTokens = 0;
    for (const q of searches) {
      const results = catalog.search(q, { limit: 10 });
      searchTokens += tokens(JSON.stringify(results));
    }

    const baselineTokens = tokens(baseline.json);
    const listOnlyTokens = tokens(codemodeList.json);
    const endToEndTokens = listOnlyTokens + searchTokens;

    const listOnlyReduction = 1 - listOnlyTokens / baselineTokens;
    const endToEndReduction = 1 - endToEndTokens / baselineTokens;

    /* eslint-disable no-console */
    console.log('\n=== Code Mode token-savings benchmark ===');
    console.log(`baseline /mcp tools/list:     ${baseline.count} tools, ~${baselineTokens} tokens`);
    console.log(
      `codemode /mcp-codemode list:  ${codemodeList.count} tools, ~${listOnlyTokens} tokens`,
    );
    console.log(
      `  → schema-transmission reduction (tools/list only): ${(listOnlyReduction * 100).toFixed(1)}%`,
    );
    console.log(`representative discovery (${searches.length} searches): ~${searchTokens} tokens`);
    console.log(
      `  → end-to-end reduction (list + searches):          ${(endToEndReduction * 100).toFixed(1)}%`,
    );
    console.log('=========================================\n');
    /* eslint-enable no-console */

    // The marketing claim depends on >= 80%. Assert the conservative
    // (end-to-end) figure so the printed number is one we can stand behind.
    expect(baseline.count).toBeGreaterThan(100);
    expect(endToEndReduction).toBeGreaterThanOrEqual(0.8);
  }, 60_000);
});
