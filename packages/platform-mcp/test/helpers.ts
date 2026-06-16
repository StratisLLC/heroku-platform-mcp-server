/**
 * Shared test helpers for spinning a built `McpServer` up against an in-memory
 * MCP client transport, plus a small fetch stub that records calls and serves
 * canned responses keyed by URL pattern.
 *
 * Tests use this to exercise the full registration → tools/list → tools/call
 * → envelope path without touching the network or the filesystem outside of a
 * tmp directory.
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.js';
import type { BuildServerOptions, BuiltServer } from '../src/server.js';
import { resolvePaths } from '../src/paths.js';
import { writeCapabilityFile } from '../src/capabilities.js';
import type { CapabilityResult } from '@heroku-mcp/core';
import { fingerprintToken } from '../src/fingerprint.js';

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
  /** Status code; defaults to 200. */
  status?: number;
  /** Response body; if not a string, JSON.stringify'd. */
  body?: string | object;
  /** Extra response headers. */
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

/** Build a capability result that lights up the diagnostic + account + apps
 *  tiers (Phase 1's full set). */
export function fullCapabilityResult(tokenFingerprint = 'test-fp'): CapabilityResult {
  return {
    schemaVersion: 1,
    tokenFingerprint,
    probedAt: new Date().toISOString(),
    ttlSeconds: 3600,
    tiers: {
      account: { available: true },
      apps: { available: true },
    },
  };
}

export interface SpunUpServer extends BuiltServer {
  client: Client;
  scratchDir: string;
}

/** Spin up a server with an in-memory MCP client wired up. */
export async function spinUpServer(
  overrides: Partial<BuildServerOptions> & {
    capabilities?: CapabilityResult;
    responses?: FetchStubResponse[];
  } = {},
): Promise<SpunUpServer & { calls: RecordedCall[] }> {
  const scratchDir = await mkdtemp(join(tmpdir(), 'herokumcp-platform-'));
  const paths = resolvePaths({ home: scratchDir, platform: 'linux' });
  const token = overrides.token ?? 'HRKU-test-token';
  // Tests always pass strings here; the function-token variant is for the
  // HTTP server's per-session boot.
  const fp = fingerprintToken(typeof token === 'string' ? token : 'fn-token');

  // Pre-seed the capability cache to avoid live probing.
  await writeCapabilityFile(
    paths.capabilityFile(fp),
    overrides.capabilities ?? fullCapabilityResult(fp),
  );

  const stub = makeFetchStub(overrides.responses ?? []);

  const built = await buildServer({
    token,
    paths,
    fetch: stub.fetch,
    version: '0.0.0-test',
    ...(overrides.forceProbe !== undefined ? { forceProbe: overrides.forceProbe } : {}),
  });

  const client = new Client({ name: 'test-harness', version: '0.0.0-test' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);

  return { ...built, client, calls: stub.calls, scratchDir };
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
  try {
    return JSON.parse(first.text) as { ok: boolean; data?: T; meta?: Record<string, unknown> };
  } catch (err) {
    throw new Error(
      `tool returned non-JSON content (isError=${(result as { isError?: boolean }).isError ?? 'undefined'}): ${first.text}`,
      { cause: err },
    );
  }
}
