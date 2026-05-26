/**
 * Tests for app webhook writes.
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

describe('webhooks-tier writes', () => {
  it('app_webhooks_create posts include + level + url', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/apps/demo/webhooks' && init?.method === 'POST',
          body: { id: 'wh-1' },
        },
      ],
    });
    await client.callTool({
      name: 'app_webhooks_create',
      arguments: {
        app: 'demo',
        url: 'https://example.com/hook',
        include: ['api:app'],
        level: 'notify',
      },
    });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      url: 'https://example.com/hook',
      include: ['api:app'],
      level: 'notify',
    });
  });

  it('app_webhooks_delete pre-fetches the parent app for the dry-run description', async () => {
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
      name: 'app_webhooks_delete',
      arguments: { app: 'demo', webhook: 'wh-1', dry_run: true },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ description: string }>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.description).toContain('wh-1');
    expect(env.data?.description).toContain('demo');
    expect(calls).toHaveLength(1);
  });

  it('app_webhooks_delete rejects confirm that echoes the input webhook id', async () => {
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
      name: 'app_webhooks_delete',
      arguments: { app: 'demo', webhook: 'wh-1', confirm: 'wh-1' },
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    // Only the prefetch should have fired; the DELETE must not run.
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('app_webhooks_delete accepts confirm matching the prefetched app name even when the model passed a UUID as app', async () => {
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
              'https://api.heroku.com/apps/2925e383-d2f8-4d2c-9c2e-000000000000/webhooks/wh-1' &&
            init?.method === 'DELETE',
          body: { id: 'wh-1' },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'app_webhooks_delete',
      arguments: {
        app: '2925e383-d2f8-4d2c-9c2e-000000000000',
        webhook: 'wh-1',
        confirm: 'demo',
      },
    })) as { content: unknown[] };
    expect(parseEnvelope(result).ok).toBe(true);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });
});
