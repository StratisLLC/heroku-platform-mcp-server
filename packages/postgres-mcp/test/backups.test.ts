/**
 * Backup tool tests: pg_backups_list, pg_backups_info, pg_backups_url,
 * pg_backups_schedules, plus sub-tier gating behaviour.
 */

import { describe, expect, it } from 'vitest';
import type { CapabilityResult } from '@heroku-mcp/core';
import { parseEnvelope, postgresCapabilities, spinUpServer } from './helpers.js';

const DATA = 'https://api.data.heroku.com/client/v11';
const ADDON_LOOKUP = (db: string) => `https://api.heroku.com/addons/${db}`;
/** Canned Platform-API addon→app resolution response. */
const addonAppResp = (db: string, app: string) => ({
  match: (url: string) => url === ADDON_LOOKUP(db),
  body: { id: db, app: { id: 'app-uuid', name: app } },
});

describe('backup tools', () => {
  it('registers the backup read tools', async () => {
    const { client } = await spinUpServer();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'pg_backups_list',
        'pg_backups_info',
        'pg_backups_url',
        'pg_backups_schedules',
      ]),
    );
  });

  it('pg_backups_list resolves the owning app, then GETs app-scoped transfers', async () => {
    const { client, calls } = await spinUpServer({
      responses: [
        addonAppResp('a-pg', 'demo'),
        { match: (url) => url === `${DATA}/apps/demo/transfers`, body: [{ num: 1 }] },
      ],
    });
    const result = (await client.callTool({
      name: 'pg_backups_list',
      arguments: { database: 'a-pg' },
    })) as { content: unknown[] };
    expect(parseEnvelope(result).ok).toBe(true);
    expect(calls[0]?.url).toBe(ADDON_LOOKUP('a-pg')); // app resolution
    expect(calls[1]?.method).toBe('GET');
    expect(calls[1]?.url).toBe(`${DATA}/apps/demo/transfers`);
  });

  it('pg_backups_list uses an explicit app argument without an addon lookup', async () => {
    const { client, calls } = await spinUpServer({
      responses: [{ match: (url) => url === `${DATA}/apps/myapp/transfers`, body: [] }],
    });
    await client.callTool({
      name: 'pg_backups_list',
      arguments: { database: 'a-pg', app: 'myapp' },
    });
    // No Platform-API addon lookup — app was supplied directly.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${DATA}/apps/myapp/transfers`);
  });

  it('pg_backups_info GETs one app-scoped transfer', async () => {
    const { client, calls } = await spinUpServer({
      responses: [
        { match: (url) => url === `${DATA}/apps/myapp/transfers/b001`, body: { num: 'b001' } },
      ],
    });
    await client.callTool({
      name: 'pg_backups_info',
      arguments: { database: 'a-pg', app: 'myapp', backup: 'b001' },
    });
    expect(calls[0]?.url).toBe(`${DATA}/apps/myapp/transfers/b001`);
  });

  it('pg_backups_url POSTs to the app-scoped public-url action', async () => {
    const { client, calls } = await spinUpServer({
      responses: [
        {
          match: (url, init) =>
            url === `${DATA}/apps/myapp/transfers/b001/actions/public-url` &&
            init?.method === 'POST',
          body: { url: 'https://signed.example.com/dump', expires_at: '2026-01-01T00:00:00Z' },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'pg_backups_url',
      arguments: { database: 'a-pg', app: 'myapp', backup: 'b001' },
    })) as { content: unknown[] };
    expect(parseEnvelope(result).ok).toBe(true);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe(`${DATA}/apps/myapp/transfers/b001/actions/public-url`);
  });

  it('pg_backups_schedules GETs the database-scoped transfer schedules', async () => {
    const { client, calls } = await spinUpServer({
      responses: [
        { match: (url) => url === `${DATA}/databases/a-pg/transfer-schedules`, body: [] },
      ],
    });
    await client.callTool({ name: 'pg_backups_schedules', arguments: { database: 'a-pg' } });
    expect(calls[0]?.url).toBe(`${DATA}/databases/a-pg/transfer-schedules`);
  });

  it('returns a forbidden error (no HTTP call) when pg_backups is probed-unavailable', async () => {
    const caps: CapabilityResult = {
      schemaVersion: 1,
      tokenFingerprint: 'fp',
      probedAt: new Date().toISOString(),
      ttlSeconds: 3600,
      tiers: {
        account: { available: true },
        data: {
          postgres: { available: true },
          pg_backups: { available: false, reason: 'forbidden', status: 403 },
        },
      },
    };
    const { client, calls } = await spinUpServer({ capabilities: caps });
    const result = (await client.callTool({
      name: 'pg_backups_list',
      arguments: { database: 'a-pg' },
    })) as { isError?: boolean; content: unknown[] };
    expect(result.isError).toBe(true);
    expect(parseEnvelope(result).error?.kind).toBe('forbidden');
    expect(calls).toHaveLength(0);
  });

  it('allows the call through when the sub-tier was never probed (absent)', async () => {
    // Root postgres tier up, but no pg_backups sub-tier present in the map.
    const caps = postgresCapabilities();
    delete (caps.tiers.data as Record<string, unknown>).pg_backups;
    const { client, calls } = await spinUpServer({
      capabilities: caps,
      responses: [
        addonAppResp('a-pg', 'demo'),
        { match: (url) => url === `${DATA}/apps/demo/transfers`, body: [] },
      ],
    });
    const result = (await client.callTool({
      name: 'pg_backups_list',
      arguments: { database: 'a-pg' },
    })) as { content: unknown[] };
    expect(parseEnvelope(result).ok).toBe(true);
    // addon lookup + transfers list.
    expect(calls).toHaveLength(2);
  });
});
