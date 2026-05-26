/**
 * Teams-tier write tool tests. Covers:
 *   - registration map under the teams capability tier
 *   - deprecation context in teams_create / teams_delete descriptions
 *   - confirm-required envelopes (missing, mismatched, case-sensitive)
 *   - dry_run pre-fetch behaviour for deletes WITH an individual GET
 *     (teams_delete, team_members_delete, team_app_collaborators_delete)
 *   - dry_run pre-fetch via list-and-filter (team_invitations_revoke,
 *     allowed_addon_services_delete) per Phase 2b Decision 5
 *   - request body shape for the upsert/transfer flows
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
    teams: { available: true },
  },
};

describe('teams-tier writes', () => {
  it('registers the documented set of teams writes', async () => {
    const { client } = await spinUpServer({ capabilities: teamsOnly });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'teams_create',
        'teams_update',
        'teams_delete',
        'team_members_create_or_update',
        'team_members_delete',
        'team_apps_create',
        'team_apps_update_locked',
        'team_apps_transfer',
        'team_app_collaborators_create',
        'team_app_collaborators_update',
        'team_app_collaborators_delete',
        'team_invitations_create',
        'team_invitations_accept',
        'team_invitations_revoke',
        'team_features_update',
        'team_preferences_update',
        'allowed_addon_services_create',
        'allowed_addon_services_delete',
      ]),
    );
  });

  it('teams_create description surfaces the deprecation/standalone context', async () => {
    const { client } = await spinUpServer({ capabilities: teamsOnly });
    const tools = (await client.listTools()).tools;
    const create = tools.find((t) => t.name === 'teams_create');
    const del = tools.find((t) => t.name === 'teams_delete');
    expect(create?.description).toContain('CLI');
    expect(create?.description).toContain('Enterprise');
    expect(create?.description).toContain('standalone');
    expect(del?.description).toContain('CLI');
    expect(del?.description).toContain('Enterprise');
  });

  it('teams_create POSTs the name field', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: teamsOnly,
      responses: [
        {
          match: (url, init) => url === 'https://api.heroku.com/teams' && init?.method === 'POST',
          body: { id: 't-1', name: 'newteam' },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'teams_create',
      arguments: { name: 'newteam' },
    })) as { content: unknown[] };
    expect(parseEnvelope(result).ok).toBe(true);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ name: 'newteam' });
  });

  it('teams_delete requires confirm matching the prefetched team name', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: teamsOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/teams/acme',
          body: { id: 't-1', name: 'acme' },
        },
      ],
    });
    const missing = (await client.callTool({
      name: 'teams_delete',
      arguments: { team: 'acme' },
    })) as { isError?: boolean; content: unknown[] };
    expect(missing.isError).toBe(true);
    const env = parseEnvelope(missing);
    expect((env.error?.details as { expected?: string }).expected).toBe('acme');
    expect((env.error?.details as { target_kind?: string }).target_kind).toBe('team');
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('teams_delete dry_run pre-fetches GET /teams/{id} and surfaces created_at', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: teamsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/teams/acme' && init?.method === 'GET',
          body: { id: 't-1', name: 'acme', created_at: '2025-01-01T00:00:00Z', role: 'admin' },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'teams_delete',
      arguments: { team: 'acme', dry_run: true },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ description: string; request: { method: string } }>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.request.method).toBe('DELETE');
    expect(env.data?.description).toContain('acme');
    expect(env.data?.description).toContain('2025-01-01');
    expect(env.data?.description).toContain('admin');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
  });

  it('teams_delete executes when confirm matches the prefetched team name', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: teamsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/teams/t-1' && init?.method === 'GET',
          body: { id: 't-1', name: 'acme' },
        },
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/teams/t-1' && init?.method === 'DELETE',
          body: { id: 't-1', name: 'acme' },
        },
      ],
    });
    // Model passes UUID-ish id `t-1` as input; user typed `acme` in chat.
    const result = (await client.callTool({
      name: 'teams_delete',
      arguments: { team: 't-1', confirm: 'acme' },
    })) as { content: unknown[] };
    expect(parseEnvelope(result).ok).toBe(true);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it('team_members_create_or_update uses PUT with email + role', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: teamsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/teams/acme/members' && init?.method === 'PUT',
          body: { id: 'm-1' },
        },
      ],
    });
    await client.callTool({
      name: 'team_members_create_or_update',
      arguments: { team: 'acme', email: 'bob@example.com', role: 'member' },
    });
    expect(calls[0]?.method).toBe('PUT');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      email: 'bob@example.com',
      role: 'member',
    });
  });

  it('team_members_delete confirm target is the prefetched member email', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: teamsOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/teams/acme/members/bob%40example.com',
          body: { id: 'm-1', email: 'bob@example.com', role: 'member' },
        },
      ],
    });
    const reject = (await client.callTool({
      name: 'team_members_delete',
      arguments: { team: 'acme', member: 'bob@example.com', confirm: 'acme' },
    })) as { isError?: boolean };
    expect(reject.isError).toBe(true);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('team_apps_transfer confirm target is the app name; PATCH body carries owner', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: teamsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/teams/apps/demo' && init?.method === 'GET',
          body: { id: 'a-1', name: 'demo' },
        },
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/teams/apps/demo' && init?.method === 'PATCH',
          body: { id: 'a-1', name: 'demo' },
        },
      ],
    });
    const reject = (await client.callTool({
      name: 'team_apps_transfer',
      arguments: { app: 'demo', owner: 'alice@example.com', confirm: 'alice@example.com' },
    })) as { isError?: boolean };
    expect(reject.isError).toBe(true);

    const ok = (await client.callTool({
      name: 'team_apps_transfer',
      arguments: { app: 'demo', owner: 'alice@example.com', confirm: 'demo' },
    })) as { content: unknown[] };
    expect(parseEnvelope(ok).ok).toBe(true);
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(JSON.parse(patch.body ?? '{}')).toEqual({ owner: 'alice@example.com' });
  });

  it('team_apps_update_locked toggles via PATCH /teams/apps/{app}', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: teamsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/teams/apps/demo' && init?.method === 'PATCH',
          body: { id: 'a-1', name: 'demo', locked: true },
        },
      ],
    });
    await client.callTool({
      name: 'team_apps_update_locked',
      arguments: { app: 'demo', locked: true },
    });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ locked: true });
  });

  it('team_app_collaborators_delete confirms on email and pre-fetches role', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: teamsOnly,
      responses: [
        {
          match: (url) =>
            url === 'https://api.heroku.com/teams/apps/demo/collaborators/bob%40example.com',
          body: { id: 'c-1', role: 'member', user: { email: 'bob@example.com', id: 'u-1' } },
        },
      ],
    });
    const dry = (await client.callTool({
      name: 'team_app_collaborators_delete',
      arguments: { app: 'demo', email: 'bob@example.com', dry_run: true },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ description: string }>(dry);
    expect(env.ok).toBe(true);
    expect(env.data?.description).toContain('bob@example.com');
    expect(env.data?.description).toContain('member');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
  });

  it('team_invitations_create uses PUT with email + role', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: teamsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/teams/acme/invitations' && init?.method === 'PUT',
          body: { id: 'i-1' },
        },
      ],
    });
    await client.callTool({
      name: 'team_invitations_create',
      arguments: { team: 'acme', email: 'newbie@example.com', role: 'member' },
    });
    expect(calls[0]?.method).toBe('PUT');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      email: 'newbie@example.com',
      role: 'member',
    });
  });

  it('team_invitations_revoke dry_run pre-fetches via list-and-filter', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: teamsOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/teams/acme/invitations',
          body: [
            {
              id: 'i-1',
              role: 'member',
              created_at: '2026-05-10T00:00:00Z',
              invited_by: { email: 'admin@example.com' },
              user: { email: 'newbie@example.com', id: 'u-1' },
            },
            {
              id: 'i-2',
              role: 'admin',
              user: { email: 'other@example.com', id: 'u-2' },
            },
          ],
        },
      ],
    });
    const dry = (await client.callTool({
      name: 'team_invitations_revoke',
      arguments: { team: 'acme', user: 'newbie@example.com', dry_run: true },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ description: string; request: { method: string; url: string } }>(
      dry,
    );
    expect(env.ok).toBe(true);
    expect(env.data?.description).toContain('newbie@example.com');
    expect(env.data?.description).toContain('member');
    expect(env.data?.description).toContain('2026-05-10');
    expect(env.data?.description).toContain('admin@example.com');
    expect(env.data?.request.method).toBe('DELETE');
    expect(env.data?.request.url).toContain('/invitations/newbie%40example.com');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
  });

  it('team_invitations_revoke dry_run is graceful when no match is found', async () => {
    const { client } = await spinUpServer({
      capabilities: teamsOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/teams/acme/invitations',
          body: [],
        },
      ],
    });
    const dry = (await client.callTool({
      name: 'team_invitations_revoke',
      arguments: { team: 'acme', user: 'missing@example.com', dry_run: true },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ description: string }>(dry);
    expect(env.ok).toBe(true);
    expect(env.data?.description).toContain('No matching invitation');
  });

  it('team_invitations_revoke confirms on the prefetched invited email (list-filter)', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: teamsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/teams/acme/invitations' && init?.method === 'GET',
          body: [
            {
              id: 'i-1',
              role: 'member',
              user: { email: 'newbie@example.com', id: 'u-1' },
            },
          ],
        },
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/teams/acme/invitations/newbie%40example.com' &&
            init?.method === 'DELETE',
          body: {},
        },
      ],
    });
    const reject = (await client.callTool({
      name: 'team_invitations_revoke',
      arguments: { team: 'acme', user: 'newbie@example.com', confirm: 'acme' },
    })) as { isError?: boolean };
    expect(reject.isError).toBe(true);
    const ok = (await client.callTool({
      name: 'team_invitations_revoke',
      arguments: {
        team: 'acme',
        user: 'newbie@example.com',
        confirm: 'newbie@example.com',
      },
    })) as { content: unknown[] };
    expect(parseEnvelope(ok).ok).toBe(true);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it('team_invitations_revoke falls back to args.user when the prefetch returns no match', async () => {
    // List-and-filter race: the user references an invitation that was just
    // revoked between dry-run and the real call. We still need *some* confirm
    // value so the gate stays evaluable — the fallback is args.user.
    const { client, calls } = await spinUpServer({
      capabilities: teamsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/teams/acme/invitations' && init?.method === 'GET',
          body: [], // no matching invitation in current list
        },
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/teams/acme/invitations/newbie%40example.com' &&
            init?.method === 'DELETE',
          body: {},
        },
      ],
    });
    const ok = (await client.callTool({
      name: 'team_invitations_revoke',
      arguments: {
        team: 'acme',
        user: 'newbie@example.com',
        confirm: 'newbie@example.com',
      },
    })) as { content: unknown[] };
    expect(parseEnvelope(ok).ok).toBe(true);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it('team_invitations_accept POSTs the token', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: teamsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/teams/invitations/abc123/accept' &&
            init?.method === 'POST',
          body: { id: 'i-1' },
        },
      ],
    });
    await client.callTool({
      name: 'team_invitations_accept',
      arguments: { token: 'abc123' },
    });
    expect(calls[0]?.method).toBe('POST');
  });

  it('team_features_update PATCHes the feature endpoint with enabled', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: teamsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/teams/acme/features/the-feature' &&
            init?.method === 'PATCH',
          body: { name: 'the-feature', enabled: true },
        },
      ],
    });
    await client.callTool({
      name: 'team_features_update',
      arguments: { team: 'acme', feature: 'the-feature', enabled: true },
    });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ enabled: true });
  });

  it('team_preferences_update forwards the preferences map verbatim', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: teamsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/teams/acme/preferences' && init?.method === 'PATCH',
          body: {},
        },
      ],
    });
    await client.callTool({
      name: 'team_preferences_update',
      arguments: {
        team: 'acme',
        preferences: { 'whitelisting-enabled': true, 'addons-controls': false },
      },
    });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      'whitelisting-enabled': true,
      'addons-controls': false,
    });
  });

  it('allowed_addon_services_create POSTs the addon_service id', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: teamsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/teams/acme/allowed-addon-services' &&
            init?.method === 'POST',
          body: { id: 'aas-1' },
        },
      ],
    });
    await client.callTool({
      name: 'allowed_addon_services_create',
      arguments: { team: 'acme', addon_service: 'heroku-postgresql' },
    });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ addon_service: 'heroku-postgresql' });
  });

  it('allowed_addon_services_delete dry_run pre-fetches via list-and-filter', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: teamsOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/teams/acme/allowed-addon-services',
          body: [
            {
              id: 'aas-1',
              addon_service: { name: 'heroku-postgresql', id: 'svc-1' },
              added_by: { email: 'admin@example.com' },
            },
          ],
        },
      ],
    });
    const dry = (await client.callTool({
      name: 'allowed_addon_services_delete',
      arguments: { team: 'acme', service: 'heroku-postgresql', dry_run: true },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ description: string; request: { url: string } }>(dry);
    expect(env.ok).toBe(true);
    expect(env.data?.description).toContain('heroku-postgresql');
    expect(env.data?.description).toContain('admin@example.com');
    expect(env.data?.request.url).toContain('/allowed-addon-services/heroku-postgresql');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
  });

  it('allowed_addon_services_delete confirms on the service name (from prefetch)', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: teamsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/teams/acme/allowed-addon-services' &&
            init?.method === 'GET',
          body: [
            {
              id: 'aas-1',
              addon_service: { name: 'heroku-postgresql', id: 'svc-1' },
            },
          ],
        },
      ],
    });
    const reject = (await client.callTool({
      name: 'allowed_addon_services_delete',
      arguments: { team: 'acme', service: 'heroku-postgresql', confirm: 'acme' },
    })) as { isError?: boolean };
    expect(reject.isError).toBe(true);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('rejects schema-invalid params (empty team name) before any HTTP call', async () => {
    const { client, calls } = await spinUpServer({ capabilities: teamsOnly, responses: [] });
    const result = (await client.callTool({
      name: 'team_members_create_or_update',
      arguments: { team: '', email: 'bob@example.com', role: 'member' },
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
