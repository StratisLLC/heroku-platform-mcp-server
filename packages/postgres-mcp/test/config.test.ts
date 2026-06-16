/**
 * Configuration & monitoring tool tests: pg_maintenance_window.
 *
 * pg_diagnostics, pg_query_insights, and pg_connection_pooling were DEFERRED in
 * the Phase 6 Part A corrections (no clean read-only Heroku Data API endpoint
 * exists — verified live and against the CLI source), so they must NOT be
 * registered.
 */

import { describe, expect, it } from 'vitest';
import { spinUpServer } from './helpers.js';

const DATA = 'https://api.data.heroku.com/client/v11';

describe('config & monitoring tools', () => {
  it('registers pg_maintenance_window and does NOT register the deferred tools', async () => {
    const { client } = await spinUpServer();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('pg_maintenance_window');
    expect(names).not.toContain('pg_connection_pooling');
    expect(names).not.toContain('pg_diagnostics');
    expect(names).not.toContain('pg_query_insights');
  });

  it('pg_maintenance_window GETs the /client/v11 maintenance endpoint', async () => {
    const { client, calls } = await spinUpServer({
      responses: [{ match: (url) => url === `${DATA}/databases/a-pg/maintenance`, body: {} }],
    });
    await client.callTool({ name: 'pg_maintenance_window', arguments: { database: 'a-pg' } });
    expect(calls[0]?.url).toBe(`${DATA}/databases/a-pg/maintenance`);
    expect(calls[0]?.headers.accept).toBe('application/json');
  });
});
