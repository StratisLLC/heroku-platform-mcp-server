/**
 * Live integration test for the Phase 6 Part B write tools.
 *
 * Gated on `HEROKUMCP_TEST_TOKEN` + `HEROKUMCP_TEST_PG_ADDON_ID` (a database the
 * token can mutate). Skipped without them, so CI without secrets is safe.
 *
 * Self-contained and state-neutral: it rotates the default credential, resets
 * connections, and captures then deletes a backup — leaving the test database
 * with no extra credentials and no leftover backups. Run against a THROWAWAY
 * database only (rotating the default credential changes its password).
 *
 * Plan reality: the canonical test DB (`dm-pgtest`) is essential-0, which does
 * not support named-credential create/destroy (create returns 403). So those
 * two tools are verified here only for their structured-error and confirm-guard
 * behaviour, not a 201/204 success path — see the Part B verification policy.
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
  const first = result.content[0] as { text?: string };
  return JSON.parse(first.text!) as Envelope<T>;
}

describeLive('postgres-mcp writes ↔ live Heroku Data API', () => {
  it('rotates, resets, captures+deletes a backup, and guards confirm — state-neutral', async () => {
    const home = await mkdtemp(join(tmpdir(), 'herokumcp-pg-wr-'));
    const paths = resolvePaths({ home, platform: process.platform });
    const built = await buildServer({
      token: TOKEN!,
      paths,
      version: '0.0.0-int',
      forceProbe: true,
      extraProbes: POSTGRES_PROBES,
    });
    registerPostgresTools(built.server, built.context);

    const client = new Client({ name: 'pg-writes-int', version: '0.0.0-int' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([built.server.connect(b), client.connect(a)]);
    const call = (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
      client.callTool({ name, arguments: args }) as Promise<ToolResult>;

    // The destructive tools confirm against the database add-on NAME; resolve it.
    const addonRes = await built.context.client.get<{ name?: string }>(`/addons/${ADDON}`, {
      tool: 'test',
    });
    const dbName = addonRes.body?.name;
    expect(dbName).toBeTruthy();

    // ---- confirm guard (no mutation) ----
    const guarded = parseEnv(
      await call('pg_connection_reset', { database: ADDON!, confirm: 'definitely-wrong' }),
    );
    expect(guarded.ok).toBe(false);
    expect(guarded.error?.kind).toBe('confirmation');

    // ---- pg_connection_reset (Tier 1) ----
    const reset = parseEnv(
      await call('pg_connection_reset', { database: ADDON!, confirm: dbName! }),
    );
    expect(reset.ok).toBe(true);

    // ---- pg_credentials_rotate of the default credential (Tier 1) ----
    const rotate = parseEnv(
      await call('pg_credentials_rotate', { database: ADDON!, confirm: dbName! }),
    );
    expect(rotate.ok).toBe(true);

    // ---- pg_backups_capture (Tier 1) ----
    const capture = parseEnv<{ num?: number | string; to_url?: unknown; from_url?: unknown }>(
      await call('pg_backups_capture', { database: ADDON! }),
    );
    expect(capture.ok).toBe(true);
    // The presigned S3 upload URL must have been stripped.
    expect(capture.data).not.toHaveProperty('to_url');
    const num = capture.data?.num;
    expect(num).toBeDefined();

    // ---- pg_backups_delete (Tier 1) — cleans up the backup we just captured ----
    const del = parseEnv(
      await call('pg_backups_delete', {
        database: ADDON!,
        backup_id: String(num),
        confirm: String(num),
      }),
    );
    expect(del.ok).toBe(true);

    // Verify no transfers remain (state-neutral).
    const remaining = parseEnv<unknown[]>(await call('pg_backups_list', { database: ADDON! }));
    expect(remaining.ok).toBe(true);
    expect(Array.isArray(remaining.data) ? remaining.data.length : -1).toBe(0);

    // ---- pg_credentials_create — plan-gated: assert the structured 403, don't
    // fabricate a success the essential-tier test DB can't produce. ----
    const create = parseEnv(
      await call('pg_credentials_create', { database: ADDON!, name: 'mcp-int-cred' }),
    );
    expect(create.ok).toBe(false);
    expect(create.error?.kind).toBe('forbidden');

    // ---- pg_credentials_destroy — confirm guard works without any mutation. ----
    const destroyGuard = parseEnv(
      await call('pg_credentials_destroy', {
        database: ADDON!,
        name: 'mcp-int-cred',
        confirm: 'definitely-wrong',
      }),
    );
    expect(destroyGuard.ok).toBe(false);
    expect(destroyGuard.error?.kind).toBe('confirmation');
  }, 120_000);
});
