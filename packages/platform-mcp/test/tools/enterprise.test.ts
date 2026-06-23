/**
 * Enterprise-tier tool tests (reads and writes).
 *
 * Covers:
 *   - Registration gating on the enterprise capability tier
 *   - Read tools: paginated list endpoints, info, usage, members, permissions
 *   - Write tools: update, members upsert + delete (with confirm), team
 *     creation (the recommended enterprise path)
 */

import { describe, expect, it } from 'vitest';
import type { CapabilityResult } from '@heroku-mcp/core';
import { parseEnvelope, spinUpServer } from '../helpers.js';

const enterpriseOnly: CapabilityResult = {
  schemaVersion: 1,
  tokenFingerprint: 'fp',
  probedAt: new Date().toISOString(),
  ttlSeconds: 3600,
  tiers: {
    account: { available: true },
    enterprise: { available: true },
  },
};

const noEnterprise: CapabilityResult = {
  schemaVersion: 1,
  tokenFingerprint: 'fp',
  probedAt: new Date().toISOString(),
  ttlSeconds: 3600,
  tiers: {
    account: { available: true },
    enterprise: { available: false, reason: 'forbidden', status: 403 },
  },
};

describe('enterprise-tier reads', () => {
  it('registers enterprise read tools when the tier is available', async () => {
    const { client } = await spinUpServer({ capabilities: enterpriseOnly });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'enterprise_accounts_list',
        'enterprise_accounts_info',
        'enterprise_account_daily_usage',
        'enterprise_account_monthly_usage',
        'enterprise_account_members_list',
        'enterprise_account_member_apps_list',
        'enterprise_account_permissions_list',
        'enterprise_account_addons_list',
        'enterprise_account_teams_list',
        'credit_pool_info',
      ]),
    );
  });

  it('hides enterprise tools when the tier is unavailable', async () => {
    const { client } = await spinUpServer({ capabilities: noEnterprise });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('enterprise_accounts_list');
    expect(names).not.toContain('enterprise_account_teams_list');
  });

  it('enterprise_accounts_list sends a Range header for pagination', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: enterpriseOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/enterprise-accounts',
          body: [{ id: 'ea-1', name: 'acme-ent' }],
          headers: {
            'content-range': 'id 0..0; max=10',
            'next-range': 'id ea-1; max=10',
          },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'enterprise_accounts_list',
      arguments: { page_size: 10 },
    })) as { content: unknown[] };
    const env = parseEnvelope<unknown[]>(result);
    expect(env.ok).toBe(true);
    expect(calls[0]?.headers.range).toBe('id ..; max=10');
    expect(env.meta?.pagination).toEqual({ hasMore: true, cursor: 'id ea-1; max=10' });
  });

  it('enterprise_account_monthly_usage passes year-month start + end query params', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: enterpriseOnly,
      responses: [
        {
          match: (url) =>
            url.startsWith('https://api.heroku.com/enterprise-accounts/acme-ent/usage/monthly'),
          body: [],
        },
      ],
    });
    await client.callTool({
      name: 'enterprise_account_monthly_usage',
      arguments: { enterprise: 'acme-ent', start: '2026-05', end: '2026-06' },
    });
    expect(calls[0]?.url).toContain('start=2026-05');
    expect(calls[0]?.url).toContain('end=2026-06');
  });

  it('enterprise_account_monthly_usage rejects a full date before any HTTP call', async () => {
    const { client, calls } = await spinUpServer({ capabilities: enterpriseOnly, responses: [] });
    const result = (await client.callTool({
      name: 'enterprise_account_monthly_usage',
      arguments: { enterprise: 'acme-ent', start: '2026-05-01', end: '2026-06-01' },
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('enterprise_account_daily_usage passes full-date start + end query params', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: enterpriseOnly,
      responses: [
        {
          match: (url) =>
            url.startsWith('https://api.heroku.com/enterprise-accounts/acme-ent/usage/daily'),
          body: [],
        },
      ],
    });
    await client.callTool({
      name: 'enterprise_account_daily_usage',
      arguments: { enterprise: 'acme-ent', start: '2026-05-01', end: '2026-05-31' },
    });
    expect(calls[0]?.url).toContain('start=2026-05-01');
    expect(calls[0]?.url).toContain('end=2026-05-31');
  });

  it('enterprise_account_daily_usage rejects a year-month value before any HTTP call', async () => {
    const { client, calls } = await spinUpServer({ capabilities: enterpriseOnly, responses: [] });
    const result = (await client.callTool({
      name: 'enterprise_account_daily_usage',
      arguments: { enterprise: 'acme-ent', start: '2026-05', end: '2026-06' },
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('enterprise_account_member_apps_list URL-encodes the user email', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: enterpriseOnly,
      responses: [
        {
          match: (url) =>
            url.startsWith('https://api.heroku.com/enterprise-accounts/ea-1/members/'),
          body: [],
        },
      ],
    });
    await client.callTool({
      name: 'enterprise_account_member_apps_list',
      arguments: { enterprise: 'ea-1', user: 'bob@example.com' },
    });
    expect(calls[0]?.url).toContain('/members/bob%40example.com/apps');
  });
});

describe('enterprise-tier writes', () => {
  it('registers enterprise write tools when the tier is available', async () => {
    const { client } = await spinUpServer({ capabilities: enterpriseOnly });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'enterprise_accounts_update',
        'enterprise_account_members_create_or_update',
        'enterprise_account_members_delete',
        'enterprise_account_teams_create',
        'enterprise_account_teams_update',
      ]),
    );
  });

  it('enterprise_accounts_update PATCHes only the provided fields', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: enterpriseOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/enterprise-accounts/ea-1' && init?.method === 'PATCH',
          body: { id: 'ea-1', name: 'acme-renamed' },
        },
      ],
    });
    await client.callTool({
      name: 'enterprise_accounts_update',
      arguments: { enterprise: 'ea-1', name: 'acme-renamed' },
    });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ name: 'acme-renamed' });
  });

  it('enterprise_account_members_create_or_update uses PUT with user + permissions', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: enterpriseOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/enterprise-accounts/ea-1/members' &&
            init?.method === 'PUT',
          body: { id: 'm-1' },
        },
      ],
    });
    await client.callTool({
      name: 'enterprise_account_members_create_or_update',
      arguments: {
        enterprise: 'ea-1',
        user: 'bob@example.com',
        permissions: ['view', 'manage'],
        federated: true,
      },
    });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      user: 'bob@example.com',
      permissions: ['view', 'manage'],
      federated: true,
    });
  });

  it('enterprise_account_members_delete confirm target is the prefetched member email', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: enterpriseOnly,
      responses: [
        {
          match: (url) =>
            url === 'https://api.heroku.com/enterprise-accounts/ea-1/members/bob%40example.com',
          body: { id: 'm-1', email: 'bob@example.com', permissions: [{ name: 'view' }] },
        },
      ],
    });
    // Missing confirm: rejected.
    const missing = (await client.callTool({
      name: 'enterprise_account_members_delete',
      arguments: { enterprise: 'ea-1', user: 'bob@example.com' },
    })) as { isError?: boolean; content: unknown[] };
    expect(missing.isError).toBe(true);
    const env = parseEnvelope(missing);
    expect((env.error?.details as { expected?: string }).expected).toBe('bob@example.com');
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('enterprise_account_members_delete rejects when confirm is the user id, not the email', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: enterpriseOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/enterprise-accounts/ea-1/members/u-1',
          body: { id: 'm-1', email: 'bob@example.com' },
        },
      ],
    });
    // Pass user id as input, but the email is what the user typed in chat.
    const reject = (await client.callTool({
      name: 'enterprise_account_members_delete',
      arguments: { enterprise: 'ea-1', user: 'u-1', confirm: 'u-1' },
    })) as { isError?: boolean };
    expect(reject.isError).toBe(true);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('enterprise_account_members_delete executes when confirm matches the canonical email', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: enterpriseOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/enterprise-accounts/ea-1/members/u-1' &&
            init?.method === 'GET',
          body: { id: 'm-1', email: 'bob@example.com' },
        },
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/enterprise-accounts/ea-1/members/u-1' &&
            init?.method === 'DELETE',
          body: { id: 'm-1' },
        },
      ],
    });
    const ok = (await client.callTool({
      name: 'enterprise_account_members_delete',
      arguments: { enterprise: 'ea-1', user: 'u-1', confirm: 'bob@example.com' },
    })) as { content: unknown[] };
    expect(parseEnvelope(ok).ok).toBe(true);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it('enterprise_account_members_delete dry_run returns the would-be request and pre-fetched permissions', async () => {
    const { client } = await spinUpServer({
      capabilities: enterpriseOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/enterprise-accounts/ea-1/members/bob%40example.com' &&
            init?.method === 'GET',
          body: { id: 'm-1', email: 'bob@example.com', permissions: [{ name: 'view' }] },
        },
      ],
    });
    const dry = (await client.callTool({
      name: 'enterprise_account_members_delete',
      arguments: { enterprise: 'ea-1', user: 'bob@example.com', dry_run: true },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ description: string; request: { method: string } }>(dry);
    expect(env.ok).toBe(true);
    expect(env.data?.request.method).toBe('DELETE');
    expect(env.data?.description).toContain('bob@example.com');
    expect(env.data?.description).toContain('view');
  });

  it('enterprise_account_teams_create POSTs under the enterprise account', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: enterpriseOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/enterprise-accounts/ea-1/teams' &&
            init?.method === 'POST',
          body: { id: 't-1', name: 'newteam' },
        },
      ],
    });
    await client.callTool({
      name: 'enterprise_account_teams_create',
      arguments: { enterprise: 'ea-1', name: 'newteam' },
    });
    expect(calls[0]?.method).toBe('POST');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ name: 'newteam' });
  });

  it('enterprise_account_teams_create description references the recommended enterprise path', async () => {
    const { client } = await spinUpServer({ capabilities: enterpriseOnly });
    const tools = (await client.listTools()).tools;
    const create = tools.find((t) => t.name === 'enterprise_account_teams_create');
    expect(create?.description).toContain('recommended');
    expect(create?.description).toContain('deprecated');
  });
});
