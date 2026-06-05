/**
 * Inventory & info tool tests: pg_list, pg_info, pg_plans, pg_credentials_list,
 * pg_credentials_url.
 */

import { describe, expect, it } from 'vitest';
import { connectionUrlFrom } from '../src/index.js';
import { parseEnvelope, spinUpServer } from './helpers.js';

describe('inventory tools', () => {
  it('registers the inventory read tools', async () => {
    const { client } = await spinUpServer();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'pg_list',
        'pg_info',
        'pg_plans',
        'pg_credentials_list',
        'pg_credentials_url',
      ]),
    );
  });

  it('pg_list filters app add-ons to heroku-postgresql and maps a summary', async () => {
    const { client } = await spinUpServer({
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/apps/demo/addons',
          body: [
            {
              id: 'a-pg',
              name: 'heroku-postgresql-curved-12345',
              addon_service: { name: 'heroku-postgresql' },
              plan: { name: 'heroku-postgresql:standard-0' },
              state: 'provisioned',
              app: { name: 'demo' },
              created_at: '2024-01-01T00:00:00Z',
            },
            {
              id: 'a-redis',
              name: 'heroku-redis-rounded-1',
              addon_service: { name: 'heroku-redis' },
              plan: { name: 'heroku-redis:mini' },
              state: 'provisioned',
              app: { name: 'demo' },
            },
          ],
        },
      ],
    });
    const result = (await client.callTool({
      name: 'pg_list',
      arguments: { app: 'demo' },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ addon_name: string; plan: string }[]>(result);
    expect(env.ok).toBe(true);
    expect(env.data).toHaveLength(1);
    expect(env.data?.[0]).toEqual({
      addon_id: 'a-pg',
      addon_name: 'heroku-postgresql-curved-12345',
      plan: 'heroku-postgresql:standard-0',
      status: 'provisioned',
      attached_app: 'demo',
      created_at: '2024-01-01T00:00:00Z',
    });
  });

  it('pg_info hits the Data API with a plain-JSON Accept header', async () => {
    const { client, calls } = await spinUpServer({
      responses: [
        {
          match: (url) =>
            url === 'https://api.data.heroku.com/client/v11/databases/a-pg',
          body: { info: [{ name: 'Plan', values: ['Standard 0'] }] },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'pg_info',
      arguments: { database: 'a-pg' },
    })) as { content: unknown[] };
    expect(parseEnvelope(result).ok).toBe(true);
    expect(calls[0]?.url).toBe('https://api.data.heroku.com/client/v11/databases/a-pg');
    expect(calls[0]?.headers.accept).toBe('application/json');
  });

  it('pg_plans reads the heroku-postgresql plan catalog', async () => {
    const { client, calls } = await spinUpServer({
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/addon-services/heroku-postgresql/plans',
          body: [{ name: 'heroku-postgresql:essential-0' }],
        },
      ],
    });
    const result = (await client.callTool({ name: 'pg_plans', arguments: {} })) as {
      content: unknown[];
    };
    expect(parseEnvelope(result).ok).toBe(true);
    expect(calls[0]?.url).toBe('https://api.heroku.com/addon-services/heroku-postgresql/plans');
  });

  it('pg_credentials_list redacts connection details, returning only name/state/roles', async () => {
    const { client } = await spinUpServer({
      responses: [
        {
          match: (url) =>
            url === 'https://api.data.heroku.com/client/v11/databases/a-pg/credentials',
          body: [
            {
              name: 'default',
              uuid: 'c-1',
              state: 'active',
              credentials: [
                { user: 'u1', password: 'SECRET', host: 'h', port: 5432, database: 'd', state: 'active' },
              ],
            },
          ],
        },
      ],
    });
    const result = (await client.callTool({
      name: 'pg_credentials_list',
      arguments: { database: 'a-pg' },
    })) as { content: unknown[] };
    const env = parseEnvelope(result);
    expect(env.ok).toBe(true);
    const text = JSON.stringify(env.data);
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('"host"');
    expect(env.data).toEqual([
      { credential_name: 'default', state: 'active', roles: [{ role: 'u1', state: 'active' }] },
    ]);
  });

  it('pg_credentials_url builds a connection string from the active role', async () => {
    const { client } = await spinUpServer({
      responses: [
        {
          match: (url) =>
            url ===
            'https://api.data.heroku.com/client/v11/databases/a-pg/credentials/default',
          body: {
            name: 'default',
            credentials: [
              { user: 'u1', password: 'p@ss', host: 'db.example.com', port: 5432, database: 'd1', state: 'active' },
            ],
          },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'pg_credentials_url',
      arguments: { database: 'a-pg', credential: 'default' },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ connection_url: string }>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.connection_url).toBe('postgres://u1:p%40ss@db.example.com:5432/d1');
  });

  it('pg_credentials_url is gated on the pg_credentials sub-tier', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: {
        schemaVersion: 1,
        tokenFingerprint: 'fp',
        probedAt: new Date().toISOString(),
        ttlSeconds: 3600,
        tiers: {
          account: { available: true },
          data: {
            postgres: { available: true },
            pg_credentials: { available: false, reason: 'forbidden', status: 403 },
          },
        },
      },
    });
    const result = (await client.callTool({
      name: 'pg_credentials_url',
      arguments: { database: 'a-pg', credential: 'default' },
    })) as { isError?: boolean; content: unknown[] };
    expect(result.isError).toBe(true);
    expect(parseEnvelope(result).error?.kind).toBe('forbidden');
    // No HTTP call should have been made.
    expect(calls).toHaveLength(0);
  });
});

describe('connectionUrlFrom', () => {
  it('returns null when no usable role is present', () => {
    expect(connectionUrlFrom({})).toBeNull();
    expect(connectionUrlFrom({ credentials: [] })).toBeNull();
    expect(connectionUrlFrom({ credentials: [{ user: 'u' }] })).toBeNull();
  });

  it('prefers the active role over earlier inactive ones', () => {
    const url = connectionUrlFrom({
      credentials: [
        { user: 'old', password: 'x', host: 'h', port: 5432, database: 'd', state: 'revoked' },
        { user: 'new', password: 'y', host: 'h', port: 6000, database: 'd', state: 'active' },
      ],
    });
    expect(url).toBe('postgres://new:y@h:6000/d');
  });
});
