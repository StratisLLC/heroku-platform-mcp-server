/**
 * Tests for log + telemetry drain writes.
 */

import { describe, expect, it } from 'vitest';
import type { CapabilityResult } from '@heroku-mcp/core';
import { parseEnvelope, spinUpServer } from '../helpers.js';

const appsOnly: CapabilityResult = {
  schemaVersion: 1,
  tokenFingerprint: 'fp',
  probedAt: new Date().toISOString(),
  ttlSeconds: 3600,
  tiers: { account: { available: true }, apps: { available: true } },
};

describe('logs-tier writes', () => {
  it('log_sessions_create POSTs to /apps/{app}/log-sessions', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/apps/demo/log-sessions' && init?.method === 'POST',
          body: { logplex_url: 'https://logplex.example.com/sessions/abc' },
        },
      ],
    });
    await client.callTool({
      name: 'log_sessions_create',
      arguments: { app: 'demo', lines: 100, tail: true },
    });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ lines: 100, tail: true });
  });

  it('log_drains_create POSTs the drain URL', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/apps/demo/log-drains' && init?.method === 'POST',
          body: { id: 'ld-1', url: 'syslog://logs.example.com' },
        },
      ],
    });
    await client.callTool({
      name: 'log_drains_create',
      arguments: { app: 'demo', url: 'syslog://logs.example.com' },
    });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ url: 'syslog://logs.example.com' });
  });

  it('log_drains_delete pre-fetches the parent app (for canonical-name confirm)', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/apps/demo',
          body: { id: 'a-1', name: 'demo' },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'log_drains_delete',
      arguments: { app: 'demo', drain: 'ld-1', dry_run: true },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ description: string }>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.description).toContain('ld-1');
    expect(env.data?.description).toContain('demo');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
  });

  it('log_drains_delete accepts confirm matching the prefetched app name even when args.app is a UUID', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url) =>
            url === 'https://api.heroku.com/apps/2925e383-d2f8-4d2c-9c2e-000000000000',
          body: { id: '2925e383-d2f8-4d2c-9c2e-000000000000', name: 'demo' },
        },
        {
          match: (url, init) =>
            url ===
              'https://api.heroku.com/apps/2925e383-d2f8-4d2c-9c2e-000000000000/log-drains/ld-1' &&
            init?.method === 'DELETE',
          body: { id: 'ld-1' },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'log_drains_delete',
      arguments: {
        app: '2925e383-d2f8-4d2c-9c2e-000000000000',
        drain: 'ld-1',
        confirm: 'demo',
      },
    })) as { content: unknown[] };
    expect(parseEnvelope(result).ok).toBe(true);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it('telemetry_drains_delete confirm target is the drain id (no human name)', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/telemetry-drains/td-uuid',
          body: { id: 'td-uuid', exporter: { endpoint: 'https://otel.example.com' } },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'telemetry_drains_delete',
      arguments: { id: 'td-uuid', confirm: 'wrong' },
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('telemetry_drains_update PATCHes /telemetry-drains/{id}', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/telemetry-drains/td-uuid' && init?.method === 'PATCH',
          body: { id: 'td-uuid' },
        },
      ],
    });
    await client.callTool({
      name: 'telemetry_drains_update',
      arguments: { id: 'td-uuid', drain: { signals: ['metrics'] } },
    });
    expect(calls[0]?.method).toBe('PATCH');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ signals: ['metrics'] });
  });
});
