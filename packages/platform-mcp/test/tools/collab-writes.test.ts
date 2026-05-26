/**
 * Tests for collaborator + app-transfer writes.
 *
 * collaborators_delete confirms on the email (not the app name) per the
 * Phase 2a target-confirm table.
 */

import { describe, expect, it } from 'vitest';
import type { CapabilityResult } from '@heroku-mcp/core';
import { parseEnvelope, spinUpServer } from '../helpers.js';

const appsOnly: CapabilityResult = {
  schemaVersion: 1,
  tokenFingerprint: 'fp',
  probedAt: new Date().toISOString(),
  ttlSeconds: 3600,
  tiers: { account: { available: true }, apps: { available: true } },
};

describe('collaborators + app transfers writes', () => {
  it('collaborators_create POSTs user + silent', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/apps/demo/collaborators' && init?.method === 'POST',
          body: { id: 'c-1' },
        },
      ],
    });
    await client.callTool({
      name: 'collaborators_create',
      arguments: { app: 'demo', user: 'bob@example.com', silent: true },
    });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      user: 'bob@example.com',
      silent: true,
    });
  });

  it('collaborators_delete confirm target is the collaborator email', async () => {
    const { client, calls } = await spinUpServer({ capabilities: appsOnly, responses: [] });
    const result = (await client.callTool({
      name: 'collaborators_delete',
      arguments: { app: 'demo', collaborator: 'bob@example.com', confirm: 'demo' },
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('collaborators_delete dry_run pre-fetches and surfaces created_at', async () => {
    const { client } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url) =>
            url === 'https://api.heroku.com/apps/demo/collaborators/bob%40example.com',
          body: { id: 'c-1', created_at: '2024-04-01T00:00:00Z' },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'collaborators_delete',
      arguments: { app: 'demo', collaborator: 'bob@example.com', dry_run: true },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ description: string }>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.description).toContain('bob@example.com');
    expect(env.data?.description).toContain('2024-04-01');
  });

  it('app_transfers_create POSTs to /account/app-transfers', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/account/app-transfers' && init?.method === 'POST',
          body: { id: 't-1' },
        },
      ],
    });
    await client.callTool({
      name: 'app_transfers_create',
      arguments: { app: 'demo', recipient: 'alice@example.com', silent: false },
    });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      app: 'demo',
      recipient: 'alice@example.com',
      silent: false,
    });
  });

  it('app_transfers_update confirm target is the app name (the transferred app)', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/account/app-transfers/t-1' && init?.method === 'PATCH',
          body: { id: 't-1', state: 'accepted' },
        },
      ],
    });
    // Wrong confirm.
    const reject = (await client.callTool({
      name: 'app_transfers_update',
      arguments: { transfer: 't-1', state: 'accepted', app: 'demo', confirm: 't-1' },
    })) as { isError?: boolean };
    expect(reject.isError).toBe(true);

    const ok = (await client.callTool({
      name: 'app_transfers_update',
      arguments: { transfer: 't-1', state: 'accepted', app: 'demo', confirm: 'demo' },
    })) as { content: unknown[] };
    expect(parseEnvelope(ok).ok).toBe(true);
    expect(calls.find((c) => c.method === 'PATCH')?.body).toBeDefined();
  });
});
