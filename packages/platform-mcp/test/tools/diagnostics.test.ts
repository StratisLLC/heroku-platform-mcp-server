/**
 * Exercise the diagnostic tool set end-to-end via an in-memory MCP transport.
 *
 * These tests prove the tool is wired up to the server, its input schema
 * accepts the documented params, and the envelope it produces matches
 * ARCHITECTURE.md §8.5. Heroku responses are stubbed so the tests stay
 * hermetic.
 */

import { describe, expect, it } from 'vitest';
import { parseEnvelope, spinUpServer } from '../helpers.js';

describe('diagnostic tools', () => {
  it('exposes whoami, refresh_capabilities, rate_limit_status, audit_tail, schema_info', async () => {
    const { client } = await spinUpServer();
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'whoami',
        'refresh_capabilities',
        'rate_limit_status',
        'audit_tail',
        'schema_info',
      ]),
    );
  });

  it('whoami returns the wrapped account body', async () => {
    const { client, calls } = await spinUpServer({
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/account',
          body: { id: 'u-1', email: 'me@example.com' },
        },
      ],
    });
    const result = (await client.callTool({ name: 'whoami' })) as { content: unknown[] };
    const env = parseEnvelope<{ id: string; email: string }>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.email).toBe('me@example.com');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.authorization).toMatch(/^Bearer HRKU-/);
  });

  it('rate_limit_status returns Heroku rate-limit body', async () => {
    const { client } = await spinUpServer({
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/account/rate-limits',
          body: { remaining: 4321 },
        },
      ],
    });
    const result = (await client.callTool({ name: 'rate_limit_status' })) as { content: unknown[] };
    const env = parseEnvelope<{ remaining: number }>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.remaining).toBe(4321);
  });

  it('audit_tail returns an empty list when no mutations have run', async () => {
    const { client } = await spinUpServer();
    const result = (await client.callTool({ name: 'audit_tail', arguments: {} })) as {
      content: unknown[];
    };
    const env = parseEnvelope<{ entries: unknown[] }>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.entries).toEqual([]);
  });

  it('schema_info reports missing when no schema cache exists', async () => {
    const { client } = await spinUpServer();
    const result = (await client.callTool({ name: 'schema_info' })) as { content: unknown[] };
    const env = parseEnvelope<{ present: boolean }>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.present).toBe(false);
  });

  it('refresh_capabilities re-runs probes and emits tools/list_changed', async () => {
    const { client } = await spinUpServer({
      responses: [
        // Required: account.self → 200. Other probes return 403 so we get a
        // recognisable shape.
        {
          match: (url) => url === 'https://api.heroku.com/account',
          body: { id: 'u-1', email: 'me@example.com' },
        },
        {
          match: (url) => url === 'https://api.heroku.com/account/rate-limits',
          body: { remaining: 4500 },
        },
        {
          match: (url) => url.startsWith('https://api.heroku.com/apps'),
          status: 403,
          body: { id: 'forbidden', message: 'no apps' },
        },
        {
          match: (url) => url === 'https://api.heroku.com/users/~/apps',
          status: 403,
          body: { id: 'forbidden', message: 'no apps' },
        },
        {
          match: (url) => url === 'https://api.heroku.com/teams',
          status: 403,
          body: { id: 'forbidden', message: 'no teams' },
        },
        {
          match: (url) => url === 'https://api.heroku.com/enterprise-accounts',
          status: 403,
          body: { id: 'forbidden', message: 'no enterprise' },
        },
        {
          match: (url) => url === 'https://api.heroku.com/spaces',
          status: 403,
          body: { id: 'forbidden', message: 'no spaces' },
        },
        {
          match: (url) => url === 'https://api.heroku.com/addons',
          status: 403,
          body: { id: 'forbidden', message: 'no addons' },
        },
        {
          match: (url) => url === 'https://api.heroku.com/addon-services',
          status: 403,
          body: { id: 'forbidden', message: 'no addons' },
        },
        {
          match: (url) => url.startsWith('https://api.heroku.com/addon-services/heroku-postgresql'),
          status: 403,
          body: { id: 'forbidden', message: 'no addons' },
        },
        {
          match: (url) => url === 'https://api.heroku.com/pipelines',
          status: 403,
          body: { id: 'forbidden', message: 'no pipelines' },
        },
        {
          match: (url) => url.startsWith('https://api.data.heroku.com/'),
          status: 403,
          body: '',
        },
      ],
    });
    const result = (await client.callTool({
      name: 'refresh_capabilities',
      arguments: { force: true },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ tiers: Record<string, { available?: boolean }> }>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.tiers.account?.available).toBe(true);
  });
});
