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
        'apps_list_all',
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

  it('apps_list description points to apps_list_all / team_apps_list for team apps', async () => {
    const { client } = await spinUpServer({ capabilities: appsOnly });
    const list = await client.listTools();
    const apps_list = list.tools.find((t) => t.name === 'apps_list');
    expect(apps_list?.description).toMatch(/direct access/);
    expect(apps_list?.description).toMatch(/apps_list_all/);
    expect(apps_list?.description).toMatch(/team_apps_list/);
  });

  it('apps_list_all returns personal apps only when the user has no teams', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/apps',
          body: [{ id: 'a-1', name: 'demo' }],
        },
        {
          match: (url) => url === 'https://api.heroku.com/teams',
          body: [],
        },
      ],
    });
    const result = (await client.callTool({ name: 'apps_list_all', arguments: {} })) as {
      content: unknown[];
    };
    const env = parseEnvelope<{
      apps: { id: string; name: string }[];
      summary: {
        personal_count: number;
        team_count: number;
        teams_queried: number;
        failed_teams: { name: string; reason: string }[];
        total_unique: number;
      };
    }>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.apps.map((a) => a.id)).toEqual(['a-1']);
    expect(env.data?.summary).toEqual({
      personal_count: 1,
      team_count: 0,
      teams_queried: 0,
      failed_teams: [],
      total_unique: 1,
    });
    // Two calls: /apps + /teams (no team-apps calls).
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.heroku.com/apps',
      'https://api.heroku.com/teams',
    ]);
  });

  it('apps_list_all merges personal + team apps, dedupes by id, sorts deterministically', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/apps',
          // Personal: includes one app that is ALSO owned by team eng.
          body: [
            { id: 'a-2', name: 'beta' },
            { id: 'a-shared', name: 'shared' },
          ],
        },
        {
          match: (url) => url === 'https://api.heroku.com/teams',
          body: [
            { id: 't1', name: 'eng' },
            { id: 't2', name: 'ops' },
          ],
        },
        {
          match: (url) => url === 'https://api.heroku.com/teams/eng/apps',
          // Different copy of the shared app — should appear once in the union.
          body: [
            { id: 'a-shared', name: 'shared' },
            { id: 'a-3', name: 'gamma' },
          ],
        },
        {
          match: (url) => url === 'https://api.heroku.com/teams/ops/apps',
          body: [{ id: 'a-1', name: 'alpha' }],
        },
      ],
    });
    const result = (await client.callTool({ name: 'apps_list_all', arguments: {} })) as {
      content: unknown[];
    };
    const env = parseEnvelope<{
      apps: { id: string; name: string }[];
      summary: { personal_count: number; team_count: number; total_unique: number };
    }>(result);
    expect(env.ok).toBe(true);
    // 4 unique apps after dedupe (a-shared collapsed to one).
    expect(env.data?.apps).toHaveLength(4);
    // Sorted by name then id.
    expect(env.data?.apps.map((a) => a.name)).toEqual(['alpha', 'beta', 'gamma', 'shared']);
    expect(env.data?.summary).toMatchObject({
      personal_count: 2,
      team_count: 2,
      teams_queried: 2,
      total_unique: 4,
    });

    // Order independence: shuffle the same response stub and assert identical
    // output.
    const { client: client2 } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/apps',
          body: [
            { id: 'a-shared', name: 'shared' },
            { id: 'a-2', name: 'beta' },
          ],
        },
        {
          match: (url) => url === 'https://api.heroku.com/teams',
          body: [
            { id: 't2', name: 'ops' },
            { id: 't1', name: 'eng' },
          ],
        },
        {
          match: (url) => url === 'https://api.heroku.com/teams/eng/apps',
          body: [
            { id: 'a-3', name: 'gamma' },
            { id: 'a-shared', name: 'shared' },
          ],
        },
        {
          match: (url) => url === 'https://api.heroku.com/teams/ops/apps',
          body: [{ id: 'a-1', name: 'alpha' }],
        },
      ],
    });
    const result2 = (await client2.callTool({ name: 'apps_list_all', arguments: {} })) as {
      content: unknown[];
    };
    const env2 = parseEnvelope<{ apps: { id: string; name: string }[] }>(result2);
    expect(env2.data?.apps.map((a) => a.id)).toEqual(env.data?.apps.map((a) => a.id));

    // Single-team-with-no-apps case is implicit in this test (each team has
    // apps); covered separately below.
    expect(calls.some((c) => c.url === 'https://api.heroku.com/teams/eng/apps')).toBe(true);
  });

  it('apps_list_all handles a team with zero apps', async () => {
    const { client } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        { match: (u) => u === 'https://api.heroku.com/apps', body: [{ id: 'a-1', name: 'x' }] },
        { match: (u) => u === 'https://api.heroku.com/teams', body: [{ id: 't1', name: 'eng' }] },
        { match: (u) => u === 'https://api.heroku.com/teams/eng/apps', body: [] },
      ],
    });
    const result = (await client.callTool({ name: 'apps_list_all', arguments: {} })) as {
      content: unknown[];
    };
    const env = parseEnvelope<{
      apps: unknown[];
      summary: { team_count: number; teams_queried: number; total_unique: number };
    }>(result);
    expect(env.data?.apps).toHaveLength(1);
    expect(env.data?.summary).toMatchObject({
      team_count: 1,
      teams_queried: 1,
      total_unique: 1,
    });
  });

  it('apps_list_all records failed team calls in summary.failed_teams; others still succeed', async () => {
    const { client } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        { match: (u) => u === 'https://api.heroku.com/apps', body: [] },
        {
          match: (u) => u === 'https://api.heroku.com/teams',
          body: [
            { id: 't1', name: 'eng' },
            { id: 't2', name: 'ops' },
          ],
        },
        // eng's team-apps call fails with 500.
        {
          match: (u) => u === 'https://api.heroku.com/teams/eng/apps',
          status: 500,
          body: { id: 'internal_server_error', message: 'kaboom' },
        },
        // ops's call succeeds.
        {
          match: (u) => u === 'https://api.heroku.com/teams/ops/apps',
          body: [{ id: 'a-1', name: 'alpha' }],
        },
      ],
    });
    const result = (await client.callTool({ name: 'apps_list_all', arguments: {} })) as {
      content: unknown[];
    };
    const env = parseEnvelope<{
      apps: { name: string }[];
      summary: {
        failed_teams: { name: string; reason: string }[];
        teams_queried: number;
        total_unique: number;
      };
    }>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.apps.map((a) => a.name)).toEqual(['alpha']);
    expect(env.data?.summary.failed_teams).toHaveLength(1);
    expect(env.data?.summary.failed_teams[0]?.name).toBe('eng');
    expect(env.data?.summary.teams_queried).toBe(2);
    expect(env.data?.summary.total_unique).toBe(1);
  });

  it('apps_list_all returns just personal apps when /teams itself is forbidden', async () => {
    const { client } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        { match: (u) => u === 'https://api.heroku.com/apps', body: [{ id: 'a-1', name: 'alpha' }] },
        // /teams returns 403 — should be treated as "no teams" without aborting.
        {
          match: (u) => u === 'https://api.heroku.com/teams',
          status: 403,
          body: { id: 'forbidden', message: 'no team access' },
        },
      ],
    });
    const result = (await client.callTool({ name: 'apps_list_all', arguments: {} })) as {
      content: unknown[];
    };
    const env = parseEnvelope<{
      apps: { name: string }[];
      summary: { team_count: number };
    }>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.apps.map((a) => a.name)).toEqual(['alpha']);
    expect(env.data?.summary.team_count).toBe(0);
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
