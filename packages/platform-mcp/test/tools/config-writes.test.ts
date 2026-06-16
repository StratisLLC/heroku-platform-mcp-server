/**
 * Tests for config-tier writes. Confirms the PATCH body shape (config var
 * map; nulls delete) and the app_features_update endpoint.
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

describe('config-tier writes', () => {
  it('config_vars_update PATCHes the config map and triggers a release', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/apps/demo/config-vars' && init?.method === 'PATCH',
          // Heroku echoes the FULL config map (incl. untouched secrets) on PATCH.
          body: { FOO: 'bar', DATABASE_URL: 'postgres://u:p@h/db', OLD: null },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'config_vars_update',
      arguments: { app: 'demo', config: { FOO: 'bar', OLD: null } },
    })) as { content: unknown[] };
    const env = parseEnvelope<Record<string, string | null>>(result);
    expect(env.ok).toBe(true);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ FOO: 'bar', OLD: null });
    // Response values are masked so secrets (incl. untouched vars like
    // DATABASE_URL) never enter model context; deleted keys stay null.
    expect(env.data).toEqual({ FOO: '***', DATABASE_URL: '***', OLD: null });
  });

  it('config_vars_update dry_run previews without calling Heroku', async () => {
    const { client, calls } = await spinUpServer({ capabilities: appsOnly, responses: [] });
    const result = (await client.callTool({
      name: 'config_vars_update',
      arguments: { app: 'demo', config: { FOO: 'bar' }, dry_run: true },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ request: { body: unknown }; description: string }>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.request.body).toEqual({ FOO: 'bar' });
    expect(env.data?.description).toContain('config vars');
    expect(calls).toHaveLength(0);
  });

  it('config_vars_update is non-destructive (no confirm needed)', async () => {
    const { client } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/apps/demo/config-vars',
          body: {},
        },
      ],
    });
    const result = (await client.callTool({
      name: 'config_vars_update',
      arguments: { app: 'demo', config: {} },
    })) as { content: unknown[] };
    expect(parseEnvelope(result).ok).toBe(true);
  });

  it('app_features_update toggles a feature flag', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/apps/demo/features/runtime-new-cgroups' &&
            init?.method === 'PATCH',
          body: { name: 'runtime-new-cgroups', enabled: true },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'app_features_update',
      arguments: { app: 'demo', feature: 'runtime-new-cgroups', enabled: true },
    })) as { content: unknown[] };
    expect(parseEnvelope(result).ok).toBe(true);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ enabled: true });
  });
});
