/**
 * Tests for review-app and app-setup writes.
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

describe('review apps + setups writes', () => {
  it('registers the expected tools', async () => {
    const { client } = await spinUpServer({ capabilities: appsOnly });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'review_apps_create',
        'review_apps_delete',
        'review_apps_config_create',
        'review_apps_config_update',
        'review_apps_config_delete',
        'app_setups_create',
      ]),
    );
  });

  it('review_apps_create POSTs to /review-apps with required fields', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/review-apps' && init?.method === 'POST',
          body: { id: 'ra-1' },
        },
      ],
    });
    await client.callTool({
      name: 'review_apps_create',
      arguments: {
        branch: 'feature/x',
        pipeline: 'pl-1',
        source_blob: { url: 'https://example.com/tar.gz' },
      },
    });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      branch: 'feature/x',
      pipeline: 'pl-1',
      source_blob: { url: 'https://example.com/tar.gz' },
    });
  });

  it('review_apps_delete confirm target is the review app id; pre-fetches', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/review-apps/ra-1',
          body: { id: 'ra-1', branch: 'feature/x' },
        },
      ],
    });
    const dryRun = (await client.callTool({
      name: 'review_apps_delete',
      arguments: { review_app: 'ra-1', dry_run: true },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ description: string }>(dryRun);
    expect(env.ok).toBe(true);
    expect(env.data?.description).toContain('feature/x');
    expect(calls).toHaveLength(1);
  });

  it('review_apps_config_delete requires confirm matching the pipeline name', async () => {
    const { client, calls } = await spinUpServer({ capabilities: appsOnly, responses: [] });
    const result = (await client.callTool({
      name: 'review_apps_config_delete',
      arguments: { pipeline: 'pl-1', confirm: 'wrong' },
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('app_setups_create POSTs to /app-setups with source_blob', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/app-setups' && init?.method === 'POST',
          body: { id: 'as-1' },
        },
      ],
    });
    await client.callTool({
      name: 'app_setups_create',
      arguments: {
        source_blob: { url: 'https://example.com/src.tar.gz' },
        app: { name: 'demo2' },
      },
    });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      source_blob: { url: 'https://example.com/src.tar.gz' },
      app: { name: 'demo2' },
    });
  });
});
