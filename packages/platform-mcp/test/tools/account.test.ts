/**
 * Account-tier tool tests. Verifies registration is tier-gated and that each
 * tool issues the documented Heroku request and returns the envelope shape
 * tools downstream of an MCP host depend on.
 */

import { describe, expect, it } from 'vitest';
import { parseEnvelope, spinUpServer } from '../helpers.js';
import type { CapabilityResult } from '@heroku-mcp/core';

const accountOnly: CapabilityResult = {
  schemaVersion: 1,
  tokenFingerprint: 'fp',
  probedAt: new Date().toISOString(),
  ttlSeconds: 3600,
  tiers: {
    account: { available: true },
    apps: { available: false, reason: 'forbidden', status: 403 },
  },
};

const noAccount: CapabilityResult = {
  schemaVersion: 1,
  tokenFingerprint: 'fp',
  probedAt: new Date().toISOString(),
  ttlSeconds: 3600,
  tiers: {
    account: { available: false, reason: 'forbidden', status: 403 },
  },
};

describe('account-tier tools', () => {
  it('registers account read-only tools when the tier is available', async () => {
    const { client } = await spinUpServer({ capabilities: accountOnly });
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'account_info',
        'account_delinquency_info',
        'account_features_list',
        'account_sms_number_get',
        'keys_list',
        'keys_info',
        'oauth_authorizations_list',
        'oauth_authorizations_info',
        'oauth_clients_list',
        'oauth_clients_info',
        'invoices_list',
        'invoices_info',
        'invoice_address_info',
        'credits_list',
        'user_preferences_get',
      ]),
    );
  });

  it('does NOT register account tools when the tier is unavailable', async () => {
    const { client } = await spinUpServer({ capabilities: noAccount });
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name);
    expect(names).not.toContain('keys_list');
    expect(names).not.toContain('invoices_list');
    // Diagnostics stay on.
    expect(names).toContain('whoami');
  });

  it('account_info wraps GET /account', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: accountOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/account',
          body: { id: 'u-1', email: 'me@example.com', name: 'Me' },
        },
      ],
    });
    const result = (await client.callTool({ name: 'account_info' })) as { content: unknown[] };
    const env = parseEnvelope<{ email: string }>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.email).toBe('me@example.com');
    expect(calls[0]?.url).toBe('https://api.heroku.com/account');
  });

  it('keys_list sends a Range header for pagination', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: accountOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/account/keys',
          body: [{ id: 'k-1' }],
          headers: {
            'content-range': 'id 0..0; max=10',
            'next-range': 'id k-1; max=10',
          },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'keys_list',
      arguments: { page_size: 10 },
    })) as { content: unknown[] };
    const env = parseEnvelope<unknown[]>(result);
    expect(env.ok).toBe(true);
    expect(calls[0]?.headers.range).toBe('id ..; max=10');
    expect(env.meta?.pagination).toEqual({ hasMore: true, cursor: 'id k-1; max=10' });
  });

  it('keys_info URL-encodes the key parameter', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: accountOnly,
      responses: [
        {
          match: (url) => url.startsWith('https://api.heroku.com/account/keys/'),
          body: { id: 'k-1', fingerprint: 'aa:bb' },
        },
      ],
    });
    await client.callTool({ name: 'keys_info', arguments: { key: 'aa:bb' } });
    expect(calls[0]?.url).toBe('https://api.heroku.com/account/keys/aa%3Abb');
  });

  it('returns a typed forbidden envelope when Heroku returns 403', async () => {
    const { client } = await spinUpServer({
      capabilities: accountOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/account/sms-number',
          status: 403,
          body: { id: 'forbidden', message: 'No SMS for you' },
        },
      ],
    });
    const result = (await client.callTool({ name: 'account_sms_number_get' })) as {
      content: unknown[];
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    const env = parseEnvelope(result);
    expect(env.ok).toBe(false);
    expect(env.error?.kind).toBe('forbidden');
    expect(env.error?.message).toBe('No SMS for you');
  });
});
