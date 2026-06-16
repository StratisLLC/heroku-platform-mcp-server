/**
 * Tests for apps-tier write tools. The write tools all flow through
 * `registerWriteTool`, so we exercise the shared dry_run / confirm gates here
 * once via `apps_delete` (the canonical destructive DELETE with pre-fetch),
 * `apps_update` (PATCH with ETag), and `apps_enable_acm` (POST without
 * confirm). The same gates apply across all -writes files; the other test
 * files cover tool-specific request shape.
 */

import { describe, expect, it } from 'vitest';
import type { CapabilityResult } from '@heroku-mcp/core';
import { parseEnvelope, spinUpServer } from '../helpers.js';

const appsOnly: CapabilityResult = {
  schemaVersion: 1,
  tokenFingerprint: 'fp',
  probedAt: new Date().toISOString(),
  ttlSeconds: 3600,
  tiers: {
    account: { available: true },
    apps: { available: true },
  },
};

describe('apps-tier writes', () => {
  it('registers the documented set of apps-writes tools', async () => {
    const { client } = await spinUpServer({ capabilities: appsOnly });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'apps_create',
        'apps_update',
        'apps_delete',
        'apps_enable_acm',
        'apps_disable_acm',
        'apps_refresh_acm',
      ]),
    );
  });

  it('apps_create POSTs to /apps with name+region+stack', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url, init) => url === 'https://api.heroku.com/apps' && init?.method === 'POST',
          body: { id: 'a-1', name: 'demo', region: { name: 'us' } },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'apps_create',
      arguments: { name: 'demo', region: 'us', stack: 'heroku-24' },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ name: string }>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.name).toBe('demo');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      name: 'demo',
      region: 'us',
      stack: 'heroku-24',
    });
  });

  it('apps_delete rejects when confirm is missing (pre-fetches the app to derive the canonical name)', async () => {
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
      name: 'apps_delete',
      arguments: { app: 'demo' },
    })) as { content: unknown[]; isError?: boolean };
    expect(result.isError).toBe(true);
    const env = parseEnvelope(result);
    expect(env.ok).toBe(false);
    expect(env.error?.kind).toBe('confirmation');
    expect((env.error?.details as { expected?: string }).expected).toBe('demo');
    expect((env.error?.details as { target_kind?: string }).target_kind).toBe('app');
    expect((env.error?.details as { kind?: string }).kind).toBe('confirmation_required');
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('apps_delete rejects when confirm is mismatched', async () => {
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
      name: 'apps_delete',
      arguments: { app: 'demo', confirm: 'oops' },
    })) as { content: unknown[]; isError?: boolean };
    expect(result.isError).toBe(true);
    const env = parseEnvelope(result);
    expect(env.error?.kind).toBe('confirmation');
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('apps_delete is case-sensitive on confirm', async () => {
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
      name: 'apps_delete',
      arguments: { app: 'demo', confirm: 'Demo' },
    })) as { content: unknown[]; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('apps_delete rejects when confirm echoes the input UUID instead of the canonical name', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url) =>
            url === 'https://api.heroku.com/apps/2925e383-d2f8-4d2c-9c2e-000000000000',
          body: { id: '2925e383-d2f8-4d2c-9c2e-000000000000', name: 'demo' },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'apps_delete',
      arguments: {
        app: '2925e383-d2f8-4d2c-9c2e-000000000000',
        confirm: '2925e383-d2f8-4d2c-9c2e-000000000000',
      },
    })) as { content: unknown[]; isError?: boolean };
    expect(result.isError).toBe(true);
    const env = parseEnvelope(result);
    expect(env.error?.kind).toBe('confirmation');
    expect((env.error?.details as { expected?: string }).expected).toBe('demo');
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('apps_delete accepts confirm matching the canonical app name even when the model passed a UUID as args.app', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/apps/2925e383-d2f8-4d2c-9c2e-000000000000' &&
            init?.method === 'GET',
          body: { id: '2925e383-d2f8-4d2c-9c2e-000000000000', name: 'demo' },
        },
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/apps/2925e383-d2f8-4d2c-9c2e-000000000000' &&
            init?.method === 'DELETE',
          body: { id: '2925e383-d2f8-4d2c-9c2e-000000000000', name: 'demo' },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'apps_delete',
      arguments: { app: '2925e383-d2f8-4d2c-9c2e-000000000000', confirm: 'demo' },
    })) as { content: unknown[] };
    expect(parseEnvelope(result).ok).toBe(true);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it('apps_delete dry_run pre-fetches and returns a descriptive preview', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/apps/demo' && init?.method === 'GET',
          body: {
            id: 'a-1',
            name: 'demo',
            owner: { email: 'owner@example.com' },
            region: { name: 'us' },
            stack: { name: 'heroku-24' },
            created_at: '2024-03-15T00:00:00Z',
          },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'apps_delete',
      arguments: { app: 'demo', dry_run: true },
    })) as { content: unknown[] };
    const env = parseEnvelope<{
      request: { method: string; url: string; headers: Record<string, string>; body: unknown };
      description: string;
    }>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.request.method).toBe('DELETE');
    expect(env.data?.request.url).toBe('https://api.heroku.com/apps/demo');
    expect(env.data?.request.body).toBeNull();
    expect(env.data?.request.headers.Authorization).toBeUndefined();
    expect(env.data?.description).toContain('demo');
    expect(env.data?.description).toContain('owner@example.com');
    expect(env.data?.description).toContain('us');
    expect(env.data?.description).toContain('heroku-24');
    // The single HTTP call should be the GET pre-fetch, NOT a DELETE.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
  });

  it('apps_delete dry_run does not require confirm', async () => {
    const { client } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/apps/demo',
          body: { id: 'a-1', name: 'demo' },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'apps_delete',
      arguments: { app: 'demo', dry_run: true },
    })) as { content: unknown[] };
    const env = parseEnvelope(result);
    expect(env.ok).toBe(true);
  });

  it('apps_delete executes when confirm matches', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/apps/demo' && init?.method === 'GET',
          body: { id: 'a-1', name: 'demo' },
        },
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/apps/demo' && init?.method === 'DELETE',
          body: { id: 'a-1', name: 'demo' },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'apps_delete',
      arguments: { app: 'demo', confirm: 'demo' },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ id: string; name: string }>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.name).toBe('demo');
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it('apps_delete: dry_run wins over a correct confirm (no real request issued)', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/apps/demo' && init?.method === 'GET',
          body: { id: 'a-1', name: 'demo' },
        },
      ],
    });
    await client.callTool({
      name: 'apps_delete',
      arguments: { app: 'demo', confirm: 'demo', dry_run: true },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET'); // pre-fetch only
  });

  it('apps_update PATCH builds the right body and sends If-Match when expected_etag is passed', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/apps/demo' && init?.method === 'PATCH',
          body: { id: 'a-1', name: 'demo2' },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'apps_update',
      arguments: { app: 'demo', name: 'demo2', maintenance: true, expected_etag: 'W/"v1"' },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ name: string }>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.name).toBe('demo2');
    const call = calls[0]!;
    expect(call.method).toBe('PATCH');
    expect(JSON.parse(call.body ?? '{}')).toEqual({ name: 'demo2', maintenance: true });
    expect(call.headers['if-match']).toBe('W/"v1"');
  });

  it('apps_update dry_run returns the preview without calling Heroku', async () => {
    const { client, calls } = await spinUpServer({ capabilities: appsOnly, responses: [] });
    const result = (await client.callTool({
      name: 'apps_update',
      arguments: { app: 'demo', name: 'demo2', dry_run: true },
    })) as { content: unknown[] };
    const env = parseEnvelope<{
      request: { method: string; url: string; body: unknown };
      description: string;
    }>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.request.method).toBe('PATCH');
    expect(env.data?.request.body).toEqual({ name: 'demo2' });
    expect(env.data?.description).toContain('demo2');
    expect(calls).toHaveLength(0);
  });

  it('apps_enable_acm is non-destructive and posts to /apps/{app}/acm', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/apps/demo/acm' && init?.method === 'POST',
          body: { acm: true },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'apps_enable_acm',
      arguments: { app: 'demo' },
    })) as { content: unknown[] };
    expect(parseEnvelope(result).ok).toBe(true);
    expect(calls[0]?.method).toBe('POST');
  });

  it('apps_disable_acm is destructive and requires confirm matching the prefetched app name', async () => {
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
      name: 'apps_disable_acm',
      arguments: { app: 'demo' },
    })) as { content: unknown[]; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('apps_update rejects invalid params before any HTTP call', async () => {
    const { client, calls } = await spinUpServer({ capabilities: appsOnly, responses: [] });
    // app is required; an empty string fails min(1).
    const result = (await client.callTool({
      name: 'apps_update',
      arguments: { app: '' },
    })) as { content: unknown[]; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
