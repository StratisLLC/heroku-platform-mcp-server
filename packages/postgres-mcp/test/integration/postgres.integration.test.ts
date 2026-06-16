/**
 * Live integration test against a real Heroku Postgres database.
 *
 * Gated on BOTH `HEROKUMCP_TEST_TOKEN` (a real Heroku OAuth token) and
 * `HEROKUMCP_TEST_PG_ADDON_ID` (a database the token can read). Without either,
 * every test is skipped, so the file is safe to run in CI without secrets.
 * `HEROKUMCP_TEST_PG_APP` is optional and only needed to exercise `pg_list`.
 *
 * It boots a real Platform `McpServer` with the Postgres probes wired in via
 * `extraProbes`, registers the Postgres tools onto it, and round-trips every
 * surviving read tool against the live Data API. Tools whose data may not exist
 * on a fresh database (backups, followers, maintenance on small plans) are
 * checked "skip-graceful": a structured error OR a success envelope both pass.
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '@heroku-mcp/platform';
import { resolvePaths } from '@heroku-mcp/core';
import { POSTGRES_PROBES, registerPostgresTools } from '../../src/index.js';

const TOKEN = process.env.HEROKUMCP_TEST_TOKEN;
const ADDON = process.env.HEROKUMCP_TEST_PG_ADDON_ID;
const APP = process.env.HEROKUMCP_TEST_PG_APP;
const describeLive = TOKEN && ADDON ? describe : describe.skip;

interface Envelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { kind?: string; message?: string };
}

interface ToolResult {
  content: unknown[];
  isError?: boolean;
}

function parseEnv<T = unknown>(result: ToolResult): Envelope<T> {
  const first = result.content[0] as { type?: string; text?: string };
  return JSON.parse(first.text!) as Envelope<T>;
}

/** Skip-graceful assertion: either a structured error or a successful envelope. */
function okOrError(result: ToolResult, label: string): Envelope {
  const env = parseEnv(result);
  const passed = result.isError === true || env.ok === true;
  if (!passed) {
    throw new Error(`${label}: neither ok nor a structured error — ${JSON.stringify(env)}`);
  }
  return env;
}

describeLive('postgres-mcp ↔ live Heroku Data API', () => {
  it('round-trips every surviving read tool against a real database', async () => {
    const home = await mkdtemp(join(tmpdir(), 'herokumcp-pg-int-'));
    const paths = resolvePaths({ home, platform: process.platform });

    const built = await buildServer({
      token: TOKEN!,
      paths,
      version: '0.0.0-int',
      forceProbe: true,
      extraProbes: POSTGRES_PROBES,
    });
    const summary = registerPostgresTools(built.server, built.context);
    expect(summary.postgres).toBe(true);

    const client = new Client({ name: 'pg-integration', version: '0.0.0-int' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([built.server.connect(b), client.connect(a)]);

    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('pg_info');
    // Deferred tools must not be advertised.
    expect(names).not.toContain('pg_diagnostics');
    expect(names).not.toContain('pg_query_insights');
    expect(names).not.toContain('pg_connection_pooling');

    const call = (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
      client.callTool({ name, arguments: args }) as Promise<ToolResult>;

    // ---- core happy paths (must succeed) ----
    const info = parseEnv<{ info?: unknown; resource_url?: unknown }>(
      await call('pg_info', { database: ADDON! }),
    );
    expect(info.ok).toBe(true);
    expect(info.data?.info).toBeDefined();
    // The password-bearing resource_url must have been stripped.
    expect(info.data).not.toHaveProperty('resource_url');

    expect(parseEnv(await call('pg_plans', {})).ok).toBe(true);

    const creds = parseEnv<unknown[]>(await call('pg_credentials_list', { database: ADDON! }));
    expect(creds.ok).toBe(true);
    // The redacted listing never carries a raw password.
    expect(JSON.stringify(creds.data)).not.toContain('password');

    const credUrl = parseEnv<{ connection_url: string }>(
      await call('pg_credentials_url', { database: ADDON!, credential: 'default' }),
    );
    expect(credUrl.ok).toBe(true);
    expect(credUrl.data?.connection_url).toMatch(/^postgres:\/\//);

    const backups = parseEnv(await call('pg_backups_list', { database: ADDON! }));
    expect(backups.ok).toBe(true);

    expect(parseEnv(await call('pg_backups_schedules', { database: ADDON! })).ok).toBe(true);

    expect(parseEnv(await call('pg_replication_status', { database: ADDON! })).ok).toBe(true);
    expect(parseEnv(await call('pg_followers_list', { database: ADDON! })).ok).toBe(true);

    // ---- skip-graceful (data may not exist / plan-gated) ----
    // pg_leader 404s when the DB isn't a follower; that's a valid structured error.
    okOrError(await call('pg_leader', { database: ADDON! }), 'pg_leader');
    // Maintenance is 422 on Essential-tier plans.
    okOrError(await call('pg_maintenance_window', { database: ADDON! }), 'pg_maintenance_window');

    // pg_list only when an app is supplied.
    if (APP) {
      const list = parseEnv<unknown[]>(await call('pg_list', { app: APP }));
      expect(list.ok).toBe(true);
    }

    // pg_backups_info / pg_backups_url need an existing backup; exercise them
    // only if the list returned one, otherwise skip (don't fabricate data).
    const firstBackup = Array.isArray(backups.data)
      ? (backups.data as { num?: number | string }[])[0]
      : undefined;
    if (firstBackup?.num !== undefined) {
      const num = String(firstBackup.num);
      okOrError(
        await call('pg_backups_info', { database: ADDON!, backup: num }),
        'pg_backups_info',
      );
      okOrError(await call('pg_backups_url', { database: ADDON!, backup: num }), 'pg_backups_url');
    }
  }, 120_000);
});
