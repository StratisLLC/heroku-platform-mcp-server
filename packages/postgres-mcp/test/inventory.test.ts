/**
 * Inventory & info tool tests: pg_list, pg_info, pg_plans, pg_credentials_list,
 * pg_credentials_url.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { connectionUrlFrom } from '../src/index.js';
import { parseEnvelope, spinUpServer } from './helpers.js';

/** Load a captured live fixture (real API response shape) by basename. */
function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8'));
}

const DATA_V0 = 'https://api.data.heroku.com/postgres/v0';
const expectedBasicAuth = `Basic ${Buffer.from(':HRKU-test-token').toString('base64')}`;

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

  it('pg_info strips the password-bearing resource_url but keeps the info array', async () => {
    // Drive this with the real captured shape: it has a top-level resource_url
    // (postgres://user:pass@…) which must never reach the model.
    const body = fixture('pg-info.captured.json') as Record<string, unknown>;
    expect(typeof body.resource_url).toBe('string'); // sanity: fixture has the field
    const { client } = await spinUpServer({
      responses: [
        {
          match: (url) => url === 'https://api.data.heroku.com/client/v11/databases/a-pg',
          body,
        },
      ],
    });
    const result = (await client.callTool({
      name: 'pg_info',
      arguments: { database: 'a-pg' },
    })) as { content: unknown[] };
    const env = parseEnvelope<Record<string, unknown>>(result);
    expect(env.ok).toBe(true);
    expect(env.data).not.toHaveProperty('resource_url');
    expect(JSON.stringify(env.data)).not.toContain('REDACTED_TEST_PASSWORD');
    // The info array and other non-secret fields survive untouched.
    expect(env.data?.info).toBeDefined();
    expect(env.data?.name).toBe(body.name);
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

  it('pg_credentials_list uses /postgres/v0 + Basic auth and redacts to name/state/roles', async () => {
    // Real shape: array of credential objects with top-level host/port/database
    // and a `credentials` array of role rows (user/password/state).
    const { client, calls } = await spinUpServer({
      responses: [
        {
          match: (url) => url === `${DATA_V0}/databases/a-pg/credentials`,
          body: [
            {
              uuid: 'c-1',
              name: 'default',
              state: 'active',
              database: 'd',
              host: 'h',
              port: 5432,
              credentials: [{ user: 'u1', password: 'SECRET', state: 'active' }],
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
    expect(calls[0]?.url).toBe(`${DATA_V0}/databases/a-pg/credentials`);
    expect(calls[0]?.headers.authorization).toBe(expectedBasicAuth);
    const text = JSON.stringify(env.data);
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('"host"');
    expect(env.data).toEqual([
      { credential_name: 'default', state: 'active', roles: [{ role: 'u1', state: 'active' }] },
    ]);
  });

  it('pg_credentials_url builds a connection string (real top-level host/db shape)', async () => {
    // The real /postgres/v0 credential body carries host/port/database at the
    // TOP level; the role rows only have user/password/state.
    const { client, calls } = await spinUpServer({
      responses: [
        {
          match: (url) => url === `${DATA_V0}/databases/a-pg/credentials/default`,
          body: {
            uuid: 'c-1',
            name: 'default',
            state: 'active',
            database: 'd1',
            host: 'db.example.com',
            port: 5432,
            credentials: [{ user: 'u1', password: 'p@ss', state: 'active' }],
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
    expect(calls[0]?.url).toBe(`${DATA_V0}/databases/a-pg/credentials/default`);
    expect(calls[0]?.headers.authorization).toBe(expectedBasicAuth);
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
    // Role present but no host/database anywhere → cannot build a URL.
    expect(connectionUrlFrom({ credentials: [{ user: 'u' }] })).toBeNull();
  });

  it('reads host/port/database from the TOP level (the real /postgres/v0 shape)', () => {
    const url = connectionUrlFrom({
      host: 'db.example.com',
      port: 5432,
      database: 'd1',
      credentials: [
        { user: 'old', password: 'x', state: 'revoked' },
        { user: 'new', password: 'y', state: 'active' },
      ],
    });
    // Picks the active role for user/password; connection target from top level.
    expect(url).toBe('postgres://new:y@db.example.com:5432/d1');
  });

  it('falls back to per-row host/port/database when not present at the top level', () => {
    const url = connectionUrlFrom({
      credentials: [{ user: 'u', password: 'p', host: 'h', port: 6000, database: 'd', state: 'active' }],
    });
    expect(url).toBe('postgres://u:p@h:6000/d');
  });

  it('builds a URL from the captured live fixture (password redacted)', () => {
    const url = connectionUrlFrom(fixture('pg-credentials-url.captured.json'));
    expect(url).toMatch(/^postgres:\/\/u9tkqu8ssu7ab7:REDACTED_TEST_PASSWORD@/);
  });
});
