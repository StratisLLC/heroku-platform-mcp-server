/**
 * Apps-tier tool tests. The list is large, so we exercise representative tools
 * (a list, an info, a config-vars getter, the apps_filter POST) end-to-end and
 * spot-check tier gating against the rest of the registration map.
 */

import { describe, expect, it } from 'vitest';
import { parseEnvelope, spinUpServer } from '../helpers.js';
import type { CapabilityResult } from '@heroku-mcp/core';

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

describe('apps-tier tools', () => {
  it('registers the documented set of read-only apps tools', async () => {
    const { client } = await spinUpServer({ capabilities: appsOnly });
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'apps_list',
        'apps_list_owned',
        'apps_info',
        'apps_filter',
        'app_features_list',
        'app_features_info',
        'config_vars_get',
        'config_vars_get_release',
        'formation_list',
        'formation_info',
        'dyno_sizes_list',
        'dynos_list',
        'dynos_info',
        'releases_list',
        'releases_info',
        'builds_list',
        'builds_info',
        'buildpack_installations_list',
        'slugs_info',
        'domains_list',
        'domains_info',
        'sni_endpoints_list',
        'sni_endpoints_info',
        'log_drains_list',
        'log_drains_info',
        'telemetry_drains_list',
        'app_webhooks_list',
        'app_webhooks_info',
        'app_webhook_deliveries_list',
        'app_webhook_deliveries_info',
        'app_webhook_events_list',
        'app_webhook_events_info',
        'collaborators_list',
        'collaborators_info',
        'app_transfers_list',
        'app_transfers_info',
      ]),
    );
  });

  it('apps_list paginates via Range header and surfaces hasMore in meta', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/apps',
          body: [{ id: 'a-1', name: 'demo' }],
          headers: {
            'content-range': 'id 0..0; max=200',
            'next-range': 'id a-1; max=200',
          },
        },
      ],
    });
    const result = (await client.callTool({ name: 'apps_list', arguments: {} })) as {
      content: unknown[];
    };
    const env = parseEnvelope<unknown[]>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.[0]).toMatchObject({ id: 'a-1', name: 'demo' });
    expect(env.meta?.pagination).toEqual({ hasMore: true, cursor: 'id a-1; max=200' });
    expect(calls[0]?.headers.range).toBe('id ..; max=200');
  });

  it('apps_info encodes the app param', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url) => url.startsWith('https://api.heroku.com/apps/'),
          body: { id: 'a-1', name: 'demo' },
        },
      ],
    });
    await client.callTool({ name: 'apps_info', arguments: { app: 'demo' } });
    expect(calls[0]?.url).toBe('https://api.heroku.com/apps/demo');
  });

  it('config_vars_get returns the cleartext map without redaction', async () => {
    const { client } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/apps/demo/config-vars',
          body: { DATABASE_URL: 'postgres://secret', API_TOKEN: 'sk-live-xxxxxxxx' },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'config_vars_get',
      arguments: { app: 'demo' },
    })) as { content: unknown[] };
    const env = parseEnvelope<Record<string, string | null>>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.DATABASE_URL).toBe('postgres://secret');
    expect(env.data?.API_TOKEN).toBe('sk-live-xxxxxxxx');
  });

  it('apps_filter sends a POST body and Range header', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/filters/apps' && init?.method === 'POST',
          body: [{ id: 'a-1' }, { id: 'a-2' }],
        },
      ],
    });
    await client.callTool({
      name: 'apps_filter',
      arguments: { in: { id: ['a-1', 'a-2'] }, page_size: 50 },
    });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers.range).toBe('id ..; max=50');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ in: { id: ['a-1', 'a-2'] } });
  });

  it('omits apps tools when the apps tier is unavailable', async () => {
    const { client } = await spinUpServer({
      capabilities: {
        ...appsOnly,
        tiers: {
          account: { available: true },
          apps: { available: false, reason: 'forbidden', status: 403 },
        },
      },
    });
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name);
    expect(names).not.toContain('apps_list');
    expect(names).not.toContain('apps_info');
    // account-tier reads + diagnostics remain.
    expect(names).toContain('account_info');
    expect(names).toContain('whoami');
  });
});
