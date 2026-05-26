/**
 * Teams-tier read-only tool tests. Spot-checks tier gating, registration map,
 * pagination wiring, and URL encoding. Heavy coverage of every read endpoint
 * is unnecessary: they share the same code path as the apps reads, which are
 * already exercised exhaustively.
 */

import { describe, expect, it } from 'vitest';
import type { CapabilityResult } from '@heroku-mcp/core';
import { parseEnvelope, spinUpServer } from '../helpers.js';

const teamsOnly: CapabilityResult = {
  schemaVersion: 1,
  tokenFingerprint: 'fp',
  probedAt: new Date().toISOString(),
  ttlSeconds: 3600,
  tiers: {
    account: { available: true },
    apps: { available: false, reason: 'forbidden', status: 403 },
    teams: { available: true },
  },
};

const teamsEmpty: CapabilityResult = {
  schemaVersion: 1,
  tokenFingerprint: 'fp',
  probedAt: new Date().toISOString(),
  ttlSeconds: 3600,
  tiers: {
    account: { available: true },
    // teams.list 200 [] → still available per Phase 2b Decision 7.
    teams: { available: true },
  },
};

const teamsUnavailable: CapabilityResult = {
  schemaVersion: 1,
  tokenFingerprint: 'fp',
  probedAt: new Date().toISOString(),
  ttlSeconds: 3600,
  tiers: {
    account: { available: true },
    teams: { available: false, reason: 'forbidden', status: 403 },
  },
};

describe('teams-tier reads', () => {
  it('registers the documented set of teams reads', async () => {
    const { client } = await spinUpServer({ capabilities: teamsOnly });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'teams_list',
        'teams_info',
        'team_members_list',
        'team_members_apps_list',
        'team_apps_list',
        'team_apps_info',
        'team_app_collaborators_list',
        'team_app_permissions_list',
        'team_invitations_list',
        'team_invoices_list',
        'team_invoices_info',
        'team_daily_usage',
        'team_monthly_usage',
        'team_features_list',
        'team_features_info',
        'team_addons_list',
        'allowed_addon_services_list',
        'team_preferences_get',
        'team_spaces_list',
        'team_delinquency_info',
      ]),
    );
  });

  it('lights up the teams tier when the probe returned 200 []', async () => {
    const { client } = await spinUpServer({ capabilities: teamsEmpty });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('teams_list');
    expect(names).toContain('teams_create');
  });

  it('does NOT register teams tools when the tier is unavailable', async () => {
    const { client } = await spinUpServer({ capabilities: teamsUnavailable });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('teams_list');
    expect(names).not.toContain('teams_create');
    // Diagnostics stay on.
    expect(names).toContain('whoami');
  });

  it('teams_list paginates via Range header and surfaces hasMore in meta', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: teamsOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/teams',
          body: [{ id: 't-1', name: 'acme' }],
          headers: {
            'content-range': 'id 0..0; max=50',
            'next-range': 'id t-1; max=50',
          },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'teams_list',
      arguments: { page_size: 50 },
    })) as { content: unknown[] };
    const env = parseEnvelope<unknown[]>(result);
    expect(env.ok).toBe(true);
    expect(calls[0]?.headers.range).toBe('id ..; max=50');
    expect(env.meta?.pagination).toEqual({ hasMore: true, cursor: 'id t-1; max=50' });
  });

  it('teams_info encodes the team param', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: teamsOnly,
      responses: [
        {
          match: (url) => url.startsWith('https://api.heroku.com/teams/'),
          body: { id: 't-1', name: 'acme' },
        },
      ],
    });
    await client.callTool({ name: 'teams_info', arguments: { team: 'acme team' } });
    expect(calls[0]?.url).toBe('https://api.heroku.com/teams/acme%20team');
  });

  it('team_apps_info uses the /teams/apps/{id_or_name} path (not /teams/{team}/apps/{app})', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: teamsOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/teams/apps/demo',
          body: { id: 'a-1', name: 'demo' },
        },
      ],
    });
    await client.callTool({ name: 'team_apps_info', arguments: { app: 'demo' } });
    expect(calls[0]?.url).toBe('https://api.heroku.com/teams/apps/demo');
  });

  it('team_daily_usage encodes start/end as query params', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: teamsOnly,
      responses: [
        {
          match: (url) =>
            url.startsWith('https://api.heroku.com/teams/acme/usage/daily?') &&
            url.includes('start=2026-05-01') &&
            url.includes('end=2026-05-31'),
          body: [],
        },
      ],
    });
    const result = (await client.callTool({
      name: 'team_daily_usage',
      arguments: { team: 'acme', start: '2026-05-01', end: '2026-05-31' },
    })) as { content: unknown[] };
    expect(parseEnvelope(result).ok).toBe(true);
    expect(calls[0]?.url).toContain('start=2026-05-01');
    expect(calls[0]?.url).toContain('end=2026-05-31');
  });
});
