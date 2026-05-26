/**
 * Tests for releases/builds/slugs writes. The rollback's confirm target is
 * the app name (not the version) per Phase 2a Decision.
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

describe('releases-tier writes', () => {
  it('registers the expected tools', async () => {
    const { client } = await spinUpServer({ capabilities: appsOnly });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'releases_create',
        'releases_rollback',
        'builds_create',
        'builds_delete_cache',
        'buildpack_installations_update',
        'slugs_create',
        'oci_image_create',
        'source_create',
      ]),
    );
  });

  it('releases_create posts slug + description', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/apps/demo/releases' && init?.method === 'POST',
          body: { id: 'r-1', version: 42 },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'releases_create',
      arguments: { app: 'demo', slug: 's-1', description: 'cut' },
    })) as { content: unknown[] };
    expect(parseEnvelope(result).ok).toBe(true);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ slug: 's-1', description: 'cut' });
  });

  it('releases_rollback confirm targets the app name (pre-fetches the app)', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/apps/demo',
          body: { id: 'a-1', name: 'demo' },
        },
      ],
    });
    // Wrong confirm (version, not app name).
    const reject = (await client.callTool({
      name: 'releases_rollback',
      arguments: { app: 'demo', release: 'v40', confirm: 'v40' },
    })) as { isError?: boolean };
    expect(reject.isError).toBe(true);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('releases_rollback executes with correct confirm (from prefetched app name)', async () => {
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
            url === 'https://api.heroku.com/apps/2925e383-d2f8-4d2c-9c2e-000000000000/releases' &&
            init?.method === 'POST',
          body: { id: 'r-2', version: 43 },
        },
      ],
    });
    // Model passes UUID as args.app; user typed the app's name as confirm.
    const result = (await client.callTool({
      name: 'releases_rollback',
      arguments: {
        app: '2925e383-d2f8-4d2c-9c2e-000000000000',
        release: 'v40',
        confirm: 'demo',
      },
    })) as { content: unknown[] };
    expect(parseEnvelope(result).ok).toBe(true);
    const post = calls.find((c) => c.method === 'POST')!;
    expect(JSON.parse(post.body ?? '{}')).toEqual({ release: 'v40' });
  });

  it('builds_create posts source_blob and optional buildpacks', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/apps/demo/builds' && init?.method === 'POST',
          body: { id: 'b-1', status: 'pending' },
        },
      ],
    });
    await client.callTool({
      name: 'builds_create',
      arguments: {
        app: 'demo',
        source_blob: { url: 'https://example.com/tar.gz' },
        buildpacks: [{ url: 'https://github.com/heroku/heroku-buildpack-ruby' }],
      },
    });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      source_blob: { url: 'https://example.com/tar.gz' },
      buildpacks: [{ url: 'https://github.com/heroku/heroku-buildpack-ruby' }],
    });
  });

  it('buildpack_installations_update PUTs the new ordered list', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/apps/demo/buildpack-installations' &&
            init?.method === 'PUT',
          body: [],
        },
      ],
    });
    await client.callTool({
      name: 'buildpack_installations_update',
      arguments: { app: 'demo', updates: [{ buildpack: 'heroku/ruby' }] },
    });
    expect(calls[0]?.method).toBe('PUT');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      updates: [{ buildpack: 'heroku/ruby' }],
    });
  });

  it('source_create POSTs /sources with no body required', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url, init) => url === 'https://api.heroku.com/sources' && init?.method === 'POST',
          body: {
            source_blob: {
              get_url: 'https://example.com/get',
              put_url: 'https://example.com/put',
            },
          },
        },
      ],
    });
    const result = (await client.callTool({ name: 'source_create', arguments: {} })) as {
      content: unknown[];
    };
    expect(parseEnvelope(result).ok).toBe(true);
    expect(calls[0]?.method).toBe('POST');
  });

  it('builds_delete_cache requires confirm matching the prefetched app name', async () => {
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
      name: 'builds_delete_cache',
      arguments: { app: 'demo' },
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });
});
