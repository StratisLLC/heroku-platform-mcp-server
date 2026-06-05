/**
 * Configuration & monitoring tool tests: pg_maintenance_window,
 * pg_connection_pooling, pg_diagnostics, pg_query_insights.
 */

import { describe, expect, it } from 'vitest';
import type { CapabilityResult } from '@heroku-mcp/core';
import { parseEnvelope, spinUpServer } from './helpers.js';

const DATA = 'https://api.data.heroku.com/client/v11';

describe('config & monitoring tools', () => {
  it('registers the config read tools', async () => {
    const { client } = await spinUpServer();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'pg_maintenance_window',
        'pg_connection_pooling',
        'pg_diagnostics',
        'pg_query_insights',
      ]),
    );
  });

  it('pg_maintenance_window GETs the maintenance endpoint', async () => {
    const { client, calls } = await spinUpServer({
      responses: [{ match: (url) => url === `${DATA}/databases/a-pg/maintenance`, body: {} }],
    });
    await client.callTool({ name: 'pg_maintenance_window', arguments: { database: 'a-pg' } });
    expect(calls[0]?.url).toBe(`${DATA}/databases/a-pg/maintenance`);
  });

  it('pg_connection_pooling GETs the connection-pooling endpoint', async () => {
    const { client, calls } = await spinUpServer({
      responses: [
        { match: (url) => url === `${DATA}/databases/a-pg/connection-pooling`, body: {} },
      ],
    });
    await client.callTool({ name: 'pg_connection_pooling', arguments: { database: 'a-pg' } });
    expect(calls[0]?.url).toBe(`${DATA}/databases/a-pg/connection-pooling`);
  });

  it('pg_diagnostics GETs the diagnostics endpoint', async () => {
    const { client, calls } = await spinUpServer({
      responses: [{ match: (url) => url === `${DATA}/databases/a-pg/diagnostics`, body: {} }],
    });
    await client.callTool({ name: 'pg_diagnostics', arguments: { database: 'a-pg' } });
    expect(calls[0]?.url).toBe(`${DATA}/databases/a-pg/diagnostics`);
  });

  it('pg_query_insights applies the limit query param (default 20)', async () => {
    const { client, calls } = await spinUpServer({
      responses: [
        { match: (url) => url.startsWith(`${DATA}/databases/a-pg/query-stats`), body: [] },
      ],
    });
    await client.callTool({ name: 'pg_query_insights', arguments: { database: 'a-pg' } });
    expect(calls[0]?.url).toBe(`${DATA}/databases/a-pg/query-stats?limit=20`);

    const { client: c2, calls: calls2 } = await spinUpServer({
      responses: [
        { match: (url) => url.startsWith(`${DATA}/databases/a-pg/query-stats`), body: [] },
      ],
    });
    await c2.callTool({ name: 'pg_query_insights', arguments: { database: 'a-pg', limit: 5 } });
    expect(calls2[0]?.url).toBe(`${DATA}/databases/a-pg/query-stats?limit=5`);
  });

  it('pg_query_insights returns a forbidden error when the feature is gated', async () => {
    const caps: CapabilityResult = {
      schemaVersion: 1,
      tokenFingerprint: 'fp',
      probedAt: new Date().toISOString(),
      ttlSeconds: 3600,
      tiers: {
        account: { available: true },
        data: {
          postgres: { available: true },
          pg_query_insights: { available: false, reason: 'forbidden', status: 403 },
        },
      },
    };
    const { client, calls } = await spinUpServer({ capabilities: caps });
    const result = (await client.callTool({
      name: 'pg_query_insights',
      arguments: { database: 'a-pg' },
    })) as { isError?: boolean; content: unknown[] };
    expect(result.isError).toBe(true);
    expect(parseEnvelope(result).error?.kind).toBe('forbidden');
    expect(calls).toHaveLength(0);
  });
});
