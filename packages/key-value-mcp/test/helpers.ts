/**
 * Test harness for the Key-Value MCP tools. Mirrors `@heroku-mcp/postgres`'s
 * helper: we construct a minimal `ToolContext` directly from
 * `@heroku-mcp/core` primitives and register only the Key-Value tools onto a
 * fresh `McpServer`, exercising the registration → tools/list → tools/call →
 * envelope path without the platform tool surface.
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  AuditLogger,
  ETagCache,
  RateLimitTracker,
  SchemaCache,
  createClient,
  type CapabilityResult,
} from '@heroku-mcp/core';
import { resolvePaths, type ToolContext } from '@heroku-mcp/platform';
import { registerKeyValueTools, type KeyValueRegistrationSummary } from '../src/index.js';

/** One recorded `fetch` call. */
export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** Canned response definition. The matcher is matched in array order. */
export interface FetchStubResponse {
  match: (url: string, init?: RequestInit) => boolean;
  status?: number;
  body?: string | object;
  headers?: Record<string, string>;
}

/** Build a fetch stub that walks the response array in order. Unmatched calls
 *  throw — tests should be explicit about every URL they expect. */
export function makeFetchStub(responses: FetchStubResponse[]): {
  fetch: typeof globalThis.fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method?.toUpperCase() ?? 'GET';
    const headerEntries: [string, string][] = [];
    if (init?.headers) {
      const h = new Headers(init.headers);
      for (const [k, v] of h.entries()) headerEntries.push([k.toLowerCase(), v]);
    }
    const headers = Object.fromEntries(headerEntries);
    const recorded: RecordedCall = { url, method, headers };
    if (typeof init?.body === 'string') recorded.body = init.body;
    calls.push(recorded);

    const match = responses.find((r) => r.match(url, init));
    if (!match) {
      throw new Error(`fetch stub: no canned response for ${method} ${url}`);
    }
    const status = match.status ?? 200;
    const bodyText =
      typeof match.body === 'string' ? match.body : JSON.stringify(match.body ?? null);
    const responseHeaders = new Headers({
      'content-type': 'application/json',
      ...(match.headers ?? {}),
    });
    return Promise.resolve(new Response(bodyText, { status, headers: responseHeaders }));
  };
  return { fetch, calls };
}

/** A capability result with the Key-Value root tier and the config family available. */
export function keyValueCapabilities(): CapabilityResult {
  return {
    schemaVersion: 1,
    tokenFingerprint: 'test-fp',
    probedAt: new Date().toISOString(),
    ttlSeconds: 3600,
    tiers: {
      account: { available: true },
      apps: { available: true },
      data: {
        redis: { available: true },
        kv_config: { available: true },
      },
    },
  };
}

export interface SpunUpServer {
  client: Client;
  calls: RecordedCall[];
  server: McpServer;
  context: ToolContext;
  summary: KeyValueRegistrationSummary;
}

/** Spin up a server with only the Key-Value tools registered. */
export async function spinUpServer(
  overrides: {
    capabilities?: CapabilityResult;
    responses?: FetchStubResponse[];
  } = {},
): Promise<SpunUpServer> {
  const scratchDir = await mkdtemp(join(tmpdir(), 'herokumcp-key-value-'));
  const paths = resolvePaths({ home: scratchDir, platform: 'linux' });
  const stub = makeFetchStub(overrides.responses ?? []);

  let capabilities = overrides.capabilities ?? keyValueCapabilities();
  const audit = new AuditLogger({ dir: paths.auditDir });
  const context: ToolContext = {
    token: () => 'HRKU-test-token',
    client: createClient({
      token: () => 'HRKU-test-token',
      tokenFingerprint: 'test-fp',
      server: 'platform',
      userAgent: 'herokumcp/0.0.0-test (key-value-test)',
      etagCache: new ETagCache(),
      rateLimit: new RateLimitTracker(),
      audit,
      fetch: stub.fetch,
    }),
    audit,
    paths,
    schema: new SchemaCache({ path: paths.schemaCachePath }),
    tokenFingerprint: 'test-fp',
    userAgent: 'herokumcp/0.0.0-test (key-value-test)',
    getCapabilities: () => capabilities,
    refreshCapabilities: async () => {
      capabilities = overrides.capabilities ?? keyValueCapabilities();
      return capabilities;
    },
  };

  const server = new McpServer(
    { name: 'herokumcp-key-value-test', version: '0.0.0-test' },
    { capabilities: { tools: { listChanged: true } } },
  );
  const summary = registerKeyValueTools(server, context);

  const client = new Client({ name: 'test-harness', version: '0.0.0-test' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { client, calls: stub.calls, server, context, summary };
}

/** Parse the JSON envelope from a CallToolResult content array. */
export function parseEnvelope<T = unknown>(result: {
  content: unknown[];
}): {
  ok: boolean;
  data?: T;
  meta?: Record<string, unknown>;
  error?: Record<string, unknown>;
} {
  const first = result.content[0] as { type?: string; text?: string } | undefined;
  if (first?.type !== 'text' || typeof first.text !== 'string') {
    throw new Error(`unexpected content shape: ${JSON.stringify(result)}`);
  }
  return JSON.parse(first.text) as {
    ok: boolean;
    data?: T;
    meta?: Record<string, unknown>;
    error?: Record<string, unknown>;
  };
}
