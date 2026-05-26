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

  it('app_webhooks_delete pre-fetches the webhook URL into the description', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/apps/demo/webhooks/wh-1',
          body: { id: 'wh-1', url: 'https://example.com/hook' },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'app_webhooks_delete',
      arguments: { app: 'demo', webhook: 'wh-1', dry_run: true },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ description: string }>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.description).toContain('example.com/hook');
    expect(calls).toHaveLength(1);
  });

  it('app_webhooks_delete confirm target is the app name', async () => {
    const { client, calls } = await spinUpServer({ capabilities: appsOnly, responses: [] });
    const result = (await client.callTool({
      name: 'app_webhooks_delete',
      arguments: { app: 'demo', webhook: 'wh-1', confirm: 'wh-1' },
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
