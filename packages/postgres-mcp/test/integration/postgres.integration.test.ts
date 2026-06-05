/**
 * Live integration test against a real Heroku Postgres database.
 *
 * Gated on BOTH `HEROKUMCP_TEST_TOKEN` (a real Heroku OAuth token) and
 * `HEROKUMCP_TEST_PG_ADDON_ID` (a database the token can read). Without either,
 * every test is skipped, so the file is safe to run in CI without secrets.
 *
 * It boots a real Platform `McpServer` with the Postgres probes wired in via
 * `extraProbes`, registers the Postgres tools onto it, and round-trips the read
 * tools against the live Data API.
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, resolvePaths } from '@heroku-mcp/platform';
import { POSTGRES_PROBES, registerPostgresTools } from '../../src/index.js';

const TOKEN = process.env.HEROKUMCP_TEST_TOKEN;
const ADDON = process.env.HEROKUMCP_TEST_PG_ADDON_ID;
const describeLive = TOKEN && ADDON ? describe : describe.skip;

interface Envelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { kind?: string; message?: string };
}

function parseEnv<T = unknown>(result: { content: unknown[] }): Envelope<T> {
  const first = result.content[0] as { type?: string; text?: string };
  return JSON.parse(first.text!) as Envelope<T>;
}

describeLive('postgres-mcp ↔ live Heroku Data API', () => {
  it('probes, registers, and round-trips read tools against a real database', async () => {
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

    const info = (await client.callTool({
      name: 'pg_info',
      arguments: { database: ADDON },
    })) as { content: unknown[] };
    expect(parseEnv(info).ok).toBe(true);

    const creds = (await client.callTool({
      name: 'pg_credentials_list',
      arguments: { database: ADDON },
    })) as { content: unknown[]; isError?: boolean };
    expect(creds.isError === true || parseEnv(creds).ok === true).toBe(true);

    const backups = (await client.callTool({
      name: 'pg_backups_list',
      arguments: { database: ADDON },
    })) as { content: unknown[]; isError?: boolean };
    expect(backups.isError === true || parseEnv(backups).ok === true).toBe(true);
  }, 60_000);
});
