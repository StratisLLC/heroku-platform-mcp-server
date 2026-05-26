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

  it('log_drains_delete requires confirm matching the app name; pre-fetches', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/apps/demo/log-drains/ld-1',
          body: { id: 'ld-1', url: 'syslog://logs.example.com' },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'log_drains_delete',
      arguments: { app: 'demo', drain: 'ld-1', dry_run: true },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ description: string }>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.description).toContain('syslog://logs.example.com');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
  });

  it('telemetry_drains_delete confirm target is the drain id', async () => {
    const { client, calls } = await spinUpServer({ capabilities: appsOnly, responses: [] });
    const result = (await client.callTool({
      name: 'telemetry_drains_delete',
      arguments: { id: 'td-uuid', confirm: 'wrong' },
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
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
