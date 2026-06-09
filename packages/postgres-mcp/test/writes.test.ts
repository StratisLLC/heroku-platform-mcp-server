/**
 * Unit tests for the Phase 6 Part B write/mutation tools (9 tools):
 *
 *   credentials: create, destroy, rotate, repair_default
 *   backups:     capture, delete, schedule
 *   connections: connection_reset
 *   settings:    maintenance_window_set
 *
 * Each tool gets a happy path (mocked HTTP, asserting the verified endpoint /
 * method / body and any secret-stripping), and — where applicable — a
 * confirm-mismatch path (structured `confirmation` error, no HTTP call) and a
 * 4xx error path. Endpoints/bodies match the live captures in test/fixtures and
 * the heroku/cli source cited in each tool.
 */

import { describe, expect, it } from 'vitest';
import { parseEnvelope, spinUpServer, type RecordedCall } from './helpers.js';

const V0 = 'https://api.data.heroku.com/postgres/v0';
const V11 = 'https://api.data.heroku.com/client/v11';
const MAINT = 'https://api.data.heroku.com/data/maintenances/v1';
const addonLookup = (id: string) => `https://api.heroku.com/addons/${id}`;

const DB_NAME = 'postgresql-foo';
const DB_UUID = 'd53b5949-1fb9-48ae-abc4-cc4f07a6dde7';

interface ToolResult {
  isError?: boolean;
  content: unknown[];
}

const call = (
  client: { callTool: (a: { name: string; arguments: Record<string, unknown> }) => unknown },
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> =>
  client.callTool({ name, arguments: args }) as Promise<ToolResult>;

const find = (calls: RecordedCall[], pred: (c: RecordedCall) => boolean) => calls.find(pred);

describe('credentials write tools', () => {
  it('registers all 9 write tools (total surface 22)', async () => {
    const { client } = await spinUpServer();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'pg_credentials_create',
        'pg_credentials_destroy',
        'pg_credentials_rotate',
        'pg_credentials_repair_default',
        'pg_backups_capture',
        'pg_backups_delete',
        'pg_backups_schedule',
        'pg_connection_reset',
        'pg_maintenance_window_set',
      ]),
    );
    expect(names).toHaveLength(22);
  });

  it('pg_credentials_create POSTs (Basic auth) and strips the password', async () => {
    const { client, calls } = await spinUpServer({
      responses: [
        {
          match: (url, init) =>
            url === `${V0}/databases/${DB_NAME}/credentials` && init?.method === 'POST',
          status: 201,
          body: {
            uuid: 'c-uuid',
            name: 'reporting',
            state: 'active',
            credentials: [{ user: 'reporting', password: 'p-SECRET-xyz', state: 'active' }],
          },
        },
      ],
    });
    const result = await call(client, 'pg_credentials_create', {
      database: DB_NAME,
      name: 'reporting',
    });
    const env = parseEnvelope(result);
    expect(env.ok).toBe(true);
    expect(JSON.stringify(env.data)).not.toContain('p-SECRET-xyz');
    expect(JSON.stringify(env.data)).not.toContain('password');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers['authorization']).toMatch(/^Basic /);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ name: 'reporting' });
  });

  it('pg_credentials_create surfaces the essential-tier 403', async () => {
    const { client } = await spinUpServer({
      responses: [
        {
          match: (url) => url === `${V0}/databases/${DB_NAME}/credentials`,
          status: 403,
          body: { message: 'Cannot create new credentials for essential-tier addons.' },
        },
      ],
    });
    const result = await call(client, 'pg_credentials_create', { database: DB_NAME, name: 'reporting' });
    expect(result.isError).toBe(true);
    expect(parseEnvelope(result).error?.kind).toBe('forbidden');
  });

  it('pg_credentials_destroy checks attachments then DELETEs (Basic auth)', async () => {
    const { client, calls } = await spinUpServer({
      responses: [
        { match: (url) => url === addonLookup(`${DB_NAME}/addon-attachments`), body: [] },
        {
          match: (url, init) =>
            url === `${V0}/databases/${DB_NAME}/credentials/reporting` && init?.method === 'DELETE',
          // The live API answers 204 (no body); the in-memory fetch stub can't
          // build a bodied 204, so we mock 200 — the tool ignores the body and
          // synthesizes the {deleted:true} envelope either way.
          status: 200,
          body: {},
        },
      ],
    });
    const result = await call(client, 'pg_credentials_destroy', {
      database: DB_NAME,
      name: 'reporting',
      confirm: DB_NAME,
    });
    const env = parseEnvelope(result);
    expect(env.ok).toBe(true);
    expect((env.data as { deleted?: boolean }).deleted).toBe(true);
    expect(find(calls, (c) => c.method === 'DELETE')?.headers['authorization']).toMatch(/^Basic /);
  });

  it('pg_credentials_destroy rejects a confirm mismatch with no HTTP call', async () => {
    const { client, calls } = await spinUpServer();
    const result = await call(client, 'pg_credentials_destroy', {
      database: DB_NAME,
      name: 'reporting',
      confirm: 'wrong',
    });
    expect(result.isError).toBe(true);
    expect(parseEnvelope(result).error?.kind).toBe('confirmation');
    expect(calls).toHaveLength(0);
  });

  it('pg_credentials_destroy refuses to destroy the default credential', async () => {
    const { client, calls } = await spinUpServer();
    const result = await call(client, 'pg_credentials_destroy', {
      database: DB_NAME,
      name: 'default',
      confirm: DB_NAME,
    });
    expect(result.isError).toBe(true);
    expect(parseEnvelope(result).error?.kind).toBe('invalid_params');
    expect(calls).toHaveLength(0);
  });

  it('pg_credentials_destroy refuses while the credential is attached to an app', async () => {
    const { client } = await spinUpServer({
      responses: [
        {
          match: (url) => url === addonLookup(`${DB_NAME}/addon-attachments`),
          body: [{ namespace: 'credential:reporting', app: { name: 'demo' } }],
        },
      ],
    });
    const result = await call(client, 'pg_credentials_destroy', {
      database: DB_NAME,
      name: 'reporting',
      confirm: DB_NAME,
    });
    expect(result.isError).toBe(true);
    expect(parseEnvelope(result).error?.kind).toBe('conflict');
  });

  it('pg_credentials_destroy maps a 404 from the DELETE', async () => {
    const { client } = await spinUpServer({
      responses: [
        { match: (url) => url === addonLookup(`${DB_NAME}/addon-attachments`), body: [] },
        {
          match: (url, init) =>
            url === `${V0}/databases/${DB_NAME}/credentials/reporting` && init?.method === 'DELETE',
          status: 404,
          body: { message: 'Not found.' },
        },
      ],
    });
    const result = await call(client, 'pg_credentials_destroy', {
      database: DB_NAME,
      name: 'reporting',
      confirm: DB_NAME,
    });
    expect(result.isError).toBe(true);
    expect(parseEnvelope(result).error?.kind).toBe('not_found');
  });

  it('pg_credentials_rotate POSTs to credentials_rotation; force sets body {forced:true}', async () => {
    const { client, calls } = await spinUpServer({
      responses: [
        {
          match: (url, init) =>
            url === `${V0}/databases/${DB_NAME}/credentials/default/credentials_rotation` &&
            init?.method === 'POST',
          status: 200,
          body: { message: `Rotating default on ${DB_NAME}` },
        },
      ],
    });
    const result = await call(client, 'pg_credentials_rotate', {
      database: DB_NAME,
      confirm: DB_NAME,
      force: true,
    });
    expect(parseEnvelope(result).ok).toBe(true);
    expect(calls[0]?.method).toBe('POST');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ forced: true });
  });

  it('pg_credentials_rotate rejects a confirm mismatch with no HTTP call', async () => {
    const { client, calls } = await spinUpServer();
    const result = await call(client, 'pg_credentials_rotate', {
      database: DB_NAME,
      confirm: 'nope',
    });
    expect(result.isError).toBe(true);
    expect(parseEnvelope(result).error?.kind).toBe('confirmation');
    expect(calls).toHaveLength(0);
  });

  it('pg_credentials_rotate maps a 404', async () => {
    const { client } = await spinUpServer({
      responses: [
        {
          match: (url) =>
            url === `${V0}/databases/${DB_NAME}/credentials/missing/credentials_rotation`,
          status: 404,
          body: { message: 'Not found.' },
        },
      ],
    });
    const result = await call(client, 'pg_credentials_rotate', {
      database: DB_NAME,
      name: 'missing',
      confirm: DB_NAME,
    });
    expect(result.isError).toBe(true);
    expect(parseEnvelope(result).error?.kind).toBe('not_found');
  });

  it('pg_credentials_repair_default POSTs to repair-default', async () => {
    const { client, calls } = await spinUpServer({
      responses: [
        {
          match: (url, init) =>
            url === `${V0}/databases/${DB_NAME}/repair-default` && init?.method === 'POST',
          status: 200,
          body: { message: 'ok' },
        },
      ],
    });
    const result = await call(client, 'pg_credentials_repair_default', {
      database: DB_NAME,
      confirm: DB_NAME,
    });
    expect(parseEnvelope(result).ok).toBe(true);
    expect(calls[0]?.headers['authorization']).toMatch(/^Basic /);
  });

  it('pg_credentials_repair_default rejects a confirm mismatch', async () => {
    const { client, calls } = await spinUpServer();
    const result = await call(client, 'pg_credentials_repair_default', {
      database: DB_NAME,
      confirm: 'x',
    });
    expect(result.isError).toBe(true);
    expect(parseEnvelope(result).error?.kind).toBe('confirmation');
    expect(calls).toHaveLength(0);
  });
});

describe('backup write tools', () => {
  it('pg_backups_capture POSTs to databases/{id}/backups and strips to_url', async () => {
    const { client } = await spinUpServer({
      responses: [
        {
          match: (url, init) =>
            url === `${V11}/databases/${DB_UUID}/backups` && init?.method === 'POST',
          status: 201,
          body: {
            uuid: 'b-uuid',
            num: 1,
            from_url: 'postgres://host:5432/db',
            to_url: 'https://s3.example.com/x?secret_access_key=SHHH&session_token=T',
          },
        },
      ],
    });
    const result = await call(client, 'pg_backups_capture', { database: DB_UUID });
    const env = parseEnvelope(result);
    expect(env.ok).toBe(true);
    expect(env.data).not.toHaveProperty('to_url');
    expect(JSON.stringify(env.data)).not.toContain('SHHH');
    expect((env.data as { from_url?: string }).from_url).toBe('postgres://host:5432/db');
  });

  it('pg_backups_capture maps a 422', async () => {
    const { client } = await spinUpServer({
      responses: [
        {
          match: (url) => url === `${V11}/databases/${DB_UUID}/backups`,
          status: 422,
          body: { message: 'cannot capture' },
        },
      ],
    });
    const result = await call(client, 'pg_backups_capture', { database: DB_UUID });
    expect(result.isError).toBe(true);
    expect(parseEnvelope(result).error?.kind).toBe('invalid_params');
  });

  it('pg_backups_delete resolves num from b001 and DELETEs the app-scoped transfer', async () => {
    const { client, calls } = await spinUpServer({
      responses: [
        {
          match: (url, init) =>
            url === `${V11}/apps/demo/transfers/1` && init?.method === 'DELETE',
          status: 200,
          body: { num: 1, deleted_at: '2026-06-09', to_url: 'https://s3/x?secret_access_key=Z' },
        },
      ],
    });
    const result = await call(client, 'pg_backups_delete', {
      app: 'demo',
      backup_id: 'b001',
      confirm: 'b001',
    });
    const env = parseEnvelope(result);
    expect(env.ok).toBe(true);
    expect(env.data).not.toHaveProperty('to_url');
    expect(calls[0]?.url).toBe(`${V11}/apps/demo/transfers/1`);
  });

  it('pg_backups_delete resolves the owning app from the database', async () => {
    const { client, calls } = await spinUpServer({
      responses: [
        { match: (url) => url === addonLookup(DB_NAME), body: { id: DB_UUID, app: { name: 'demo' } } },
        { match: (url) => url === `${V11}/apps/demo/transfers/2`, status: 200, body: { num: 2 } },
      ],
    });
    const result = await call(client, 'pg_backups_delete', {
      database: DB_NAME,
      backup_id: '2',
      confirm: '2',
    });
    expect(parseEnvelope(result).ok).toBe(true);
    expect(find(calls, (c) => c.url === addonLookup(DB_NAME))).toBeDefined();
    expect(find(calls, (c) => c.url === `${V11}/apps/demo/transfers/2`)?.method).toBe('DELETE');
  });

  it('pg_backups_delete rejects a confirm mismatch with no HTTP call', async () => {
    const { client, calls } = await spinUpServer();
    const result = await call(client, 'pg_backups_delete', {
      app: 'demo',
      backup_id: 'b001',
      confirm: 'b002',
    });
    expect(result.isError).toBe(true);
    expect(parseEnvelope(result).error?.kind).toBe('confirmation');
    expect(calls).toHaveLength(0);
  });

  it('pg_backups_delete maps a 404', async () => {
    const { client } = await spinUpServer({
      responses: [
        {
          match: (url) => url === `${V11}/apps/demo/transfers/9`,
          status: 404,
          body: { message: 'Not found.' },
        },
      ],
    });
    const result = await call(client, 'pg_backups_delete', {
      app: 'demo',
      backup_id: '9',
      confirm: '9',
    });
    expect(result.isError).toBe(true);
    expect(parseEnvelope(result).error?.kind).toBe('not_found');
  });

  it('pg_backups_schedule parses "at" and POSTs {hour,timezone,schedule_name}', async () => {
    const { client, calls } = await spinUpServer({
      responses: [
        {
          match: (url, init) =>
            url === `${V11}/databases/${DB_UUID}/transfer-schedules` && init?.method === 'POST',
          status: 201,
          body: { uuid: 's-uuid', name: 'DATABASE_URL' },
        },
      ],
    });
    const result = await call(client, 'pg_backups_schedule', {
      database: DB_UUID,
      at: '02:00 America/Los_Angeles',
    });
    expect(parseEnvelope(result).ok).toBe(true);
    // hour is passed through as the user typed it ("02" → "02"), matching the CLI.
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      hour: '02',
      timezone: 'America/Los_Angeles',
      schedule_name: 'DATABASE_URL',
    });
  });

  it('pg_backups_schedule maps a PST abbreviation and a custom name', async () => {
    const { client, calls } = await spinUpServer({
      responses: [
        { match: (url) => url === `${V11}/databases/${DB_UUID}/transfer-schedules`, status: 201, body: {} },
      ],
    });
    await call(client, 'pg_backups_schedule', { database: DB_UUID, at: '14:00 PST', name: 'HEROKU_POSTGRESQL_RED' });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      hour: '14',
      timezone: 'America/Los_Angeles',
      schedule_name: 'HEROKU_POSTGRESQL_RED_URL',
    });
  });

  it('pg_backups_schedule rejects an invalid "at" with no HTTP call', async () => {
    const { client, calls } = await spinUpServer();
    const result = await call(client, 'pg_backups_schedule', { database: DB_UUID, at: '2:30 pm' });
    expect(result.isError).toBe(true);
    expect(parseEnvelope(result).error?.kind).toBe('invalid_params');
    expect(calls).toHaveLength(0);
  });
});

describe('connection + settings write tools', () => {
  it('pg_connection_reset resolves the addon id and POSTs connection_reset', async () => {
    const { client, calls } = await spinUpServer({
      responses: [
        { match: (url) => url === addonLookup(DB_NAME), body: { id: DB_UUID, name: DB_NAME } },
        {
          match: (url, init) =>
            url === `${V11}/databases/${DB_UUID}/connection_reset` && init?.method === 'POST',
          status: 200,
          body: { message: 'Connection reset successful' },
        },
      ],
    });
    const result = await call(client, 'pg_connection_reset', { database: DB_NAME, confirm: DB_NAME });
    expect(parseEnvelope(result).ok).toBe(true);
    expect(find(calls, (c) => c.url === `${V11}/databases/${DB_UUID}/connection_reset`)?.method).toBe(
      'POST',
    );
  });

  it('pg_connection_reset rejects a confirm mismatch with no HTTP call', async () => {
    const { client, calls } = await spinUpServer();
    const result = await call(client, 'pg_connection_reset', { database: DB_NAME, confirm: 'wrong' });
    expect(result.isError).toBe(true);
    expect(parseEnvelope(result).error?.kind).toBe('confirmation');
    expect(calls).toHaveLength(0);
  });

  it('pg_connection_reset maps a 404', async () => {
    const { client } = await spinUpServer({
      responses: [
        { match: (url) => url === addonLookup(DB_NAME), body: { id: DB_UUID, name: DB_NAME } },
        {
          match: (url) => url === `${V11}/databases/${DB_UUID}/connection_reset`,
          status: 404,
          body: { message: 'Not found.' },
        },
      ],
    });
    const result = await call(client, 'pg_connection_reset', { database: DB_NAME, confirm: DB_NAME });
    expect(result.isError).toBe(true);
    expect(parseEnvelope(result).error?.kind).toBe('not_found');
  });

  it('pg_maintenance_window_set POSTs {day_of_week,time_of_day} to the maintenances API', async () => {
    const { client, calls } = await spinUpServer({
      responses: [
        { match: (url) => url === addonLookup(DB_NAME), body: { id: DB_UUID, name: DB_NAME } },
        {
          match: (url, init) =>
            url === `${MAINT}/${DB_UUID}/window` && init?.method === 'POST',
          status: 200,
          body: { window: 'Sundays 13:30 UTC', previous_window: null },
        },
      ],
    });
    const result = await call(client, 'pg_maintenance_window_set', {
      database: DB_NAME,
      day_of_week: 'sunday',
      time_of_day: '13:30',
      confirm: DB_NAME,
    });
    expect(parseEnvelope(result).ok).toBe(true);
    const post = find(calls, (c) => c.url === `${MAINT}/${DB_UUID}/window`);
    expect(post?.method).toBe('POST');
    expect(JSON.parse(post?.body ?? '{}')).toEqual({ day_of_week: 'sunday', time_of_day: '13:30' });
  });

  it('pg_maintenance_window_set rejects a confirm mismatch with no HTTP call', async () => {
    const { client, calls } = await spinUpServer();
    const result = await call(client, 'pg_maintenance_window_set', {
      database: DB_NAME,
      day_of_week: 'sunday',
      time_of_day: '13:30',
      confirm: 'wrong',
    });
    expect(result.isError).toBe(true);
    expect(parseEnvelope(result).error?.kind).toBe('confirmation');
    expect(calls).toHaveLength(0);
  });

  it('pg_maintenance_window_set maps a 422 (essential-tier)', async () => {
    const { client } = await spinUpServer({
      responses: [
        { match: (url) => url === addonLookup(DB_NAME), body: { id: DB_UUID, name: DB_NAME } },
        {
          match: (url) => url === `${MAINT}/${DB_UUID}/window`,
          status: 422,
          body: { message: 'Maintenance is not available on Essential-tier plans.' },
        },
      ],
    });
    const result = await call(client, 'pg_maintenance_window_set', {
      database: DB_NAME,
      day_of_week: 'sunday',
      time_of_day: '13:30',
      confirm: DB_NAME,
    });
    expect(result.isError).toBe(true);
    expect(parseEnvelope(result).error?.kind).toBe('invalid_params');
  });
});
