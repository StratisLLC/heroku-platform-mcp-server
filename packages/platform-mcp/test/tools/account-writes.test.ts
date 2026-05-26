/**
 * Account-tier write tool tests. Covers registration map, body shape, dry_run
 * pre-fetch for deletes, confirm gates, and tier gating.
 */

import { describe, expect, it } from 'vitest';
import type { CapabilityResult } from '@heroku-mcp/core';
import { parseEnvelope, spinUpServer } from '../helpers.js';

const accountOnly: CapabilityResult = {
  schemaVersion: 1,
  tokenFingerprint: 'fp',
  probedAt: new Date().toISOString(),
  ttlSeconds: 3600,
  tiers: {
    account: { available: true },
  },
};

describe('account-tier writes', () => {
  it('registers the documented set of account writes', async () => {
    const { client } = await spinUpServer({ capabilities: accountOnly });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'account_update',
        'account_features_update',
        'account_sms_number_recover',
        'keys_create',
        'keys_delete',
        'oauth_authorizations_create',
        'oauth_authorizations_delete',
        'oauth_authorizations_regenerate',
        'invoice_address_update',
        'credits_create',
        'user_preferences_update',
      ]),
    );
    // Intentionally not exposed — see Phase 2b Decision 1.
    expect(names).not.toContain('account_delete');
    expect(names).not.toContain('oauth_tokens_create');
  });

  it('account_update PATCHes /account with the provided fields', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: accountOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/account' && init?.method === 'PATCH',
          body: { id: 'u-1', name: 'New Name' },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'account_update',
      arguments: { name: 'New Name', beta: true },
    })) as { content: unknown[] };
    expect(parseEnvelope(result).ok).toBe(true);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ name: 'New Name', beta: true });
  });

  it('account_update dry_run returns a preview without calling Heroku', async () => {
    const { client, calls } = await spinUpServer({ capabilities: accountOnly, responses: [] });
    const result = (await client.callTool({
      name: 'account_update',
      arguments: { name: 'Preview Name', dry_run: true },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ request: { method: string; body: unknown }; description: string }>(
      result,
    );
    expect(env.ok).toBe(true);
    expect(env.data?.request.method).toBe('PATCH');
    expect(env.data?.request.body).toEqual({ name: 'Preview Name' });
    expect(env.data?.description).toContain('Preview Name');
    expect(calls).toHaveLength(0);
  });

  it('account_features_update PATCHes /account/features/{feature}', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: accountOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/account/features/the-feature' &&
            init?.method === 'PATCH',
          body: { name: 'the-feature', enabled: false },
        },
      ],
    });
    await client.callTool({
      name: 'account_features_update',
      arguments: { feature: 'the-feature', enabled: false },
    });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ enabled: false });
  });

  it('account_sms_number_recover POSTs to the recover action', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: accountOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/account/sms-number/actions/recover' &&
            init?.method === 'POST',
          body: { sms_number: '+15555550100' },
        },
      ],
    });
    await client.callTool({ name: 'account_sms_number_recover', arguments: {} });
    expect(calls[0]?.method).toBe('POST');
  });

  it('keys_create POSTs the public_key body', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: accountOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/account/keys' && init?.method === 'POST',
          body: { id: 'k-1', fingerprint: 'aa:bb' },
        },
      ],
    });
    await client.callTool({
      name: 'keys_create',
      arguments: { public_key: 'ssh-ed25519 AAAAExample user@host' },
    });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      public_key: 'ssh-ed25519 AAAAExample user@host',
    });
  });

  it('keys_delete requires confirm matching the prefetched fingerprint', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: accountOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/account/keys/aa%3Abb',
          body: { id: 'k-1', fingerprint: 'aa:bb', comment: 'laptop' },
        },
      ],
    });
    const reject = (await client.callTool({
      name: 'keys_delete',
      arguments: { key: 'aa:bb', fingerprint: 'aa:bb', confirm: 'wrong' },
    })) as { isError?: boolean; content: unknown[] };
    expect(reject.isError).toBe(true);
    const env = parseEnvelope(reject);
    expect((env.error?.details as { expected?: string }).expected).toBe('aa:bb');
    expect((env.error?.details as { target_kind?: string }).target_kind).toBe('key');
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('keys_delete accepts confirm matching the canonical fingerprint even when the model passed the UUID as key', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: accountOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/account/keys/k-uuid' && init?.method === 'GET',
          body: { id: 'k-uuid', fingerprint: 'aa:bb' },
        },
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/account/keys/k-uuid' && init?.method === 'DELETE',
          body: { id: 'k-uuid' },
        },
      ],
    });
    const ok = (await client.callTool({
      name: 'keys_delete',
      arguments: { key: 'k-uuid', fingerprint: 'k-uuid', confirm: 'aa:bb' },
    })) as { content: unknown[] };
    expect(parseEnvelope(ok).ok).toBe(true);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it('keys_delete dry_run pre-fetches and surfaces comment + created_at', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: accountOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/account/keys/aa%3Abb',
          body: { id: 'k-1', comment: 'laptop', created_at: '2025-06-01T00:00:00Z' },
        },
      ],
    });
    const dry = (await client.callTool({
      name: 'keys_delete',
      arguments: { key: 'aa:bb', fingerprint: 'aa:bb', dry_run: true },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ description: string }>(dry);
    expect(env.ok).toBe(true);
    expect(env.data?.description).toContain('laptop');
    expect(env.data?.description).toContain('2025-06-01');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
  });

  it('oauth_authorizations_create POSTs description/scope/expires_in', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: accountOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/oauth/authorizations' && init?.method === 'POST',
          body: { id: 'oa-1' },
        },
      ],
    });
    await client.callTool({
      name: 'oauth_authorizations_create',
      arguments: { description: 'ci-token', scope: ['read'], expires_in: 3600 },
    });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      description: 'ci-token',
      scope: ['read'],
      expires_in: 3600,
    });
  });

  it('oauth_authorizations_delete confirms on the prefetched description (or id when description blank)', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: accountOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/oauth/authorizations/oa-1' && init?.method === 'GET',
          body: { id: 'oa-1', description: 'ci-token' },
        },
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/oauth/authorizations/oa-1' && init?.method === 'DELETE',
          body: {},
        },
      ],
    });
    // Wrong confirm — id rather than description.
    const reject = (await client.callTool({
      name: 'oauth_authorizations_delete',
      arguments: { id: 'oa-1', confirm_target: 'ci-token', confirm: 'oa-1' },
    })) as { isError?: boolean };
    expect(reject.isError).toBe(true);

    const ok = (await client.callTool({
      name: 'oauth_authorizations_delete',
      arguments: { id: 'oa-1', confirm_target: 'ci-token', confirm: 'ci-token' },
    })) as { content: unknown[] };
    expect(parseEnvelope(ok).ok).toBe(true);
    expect(calls.find((c) => c.method === 'DELETE')).toBeDefined();
  });

  it('oauth_authorizations_delete dry_run pre-fetches description + scope', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: accountOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/oauth/authorizations/oa-1',
          body: {
            id: 'oa-1',
            description: 'ci-token',
            scope: ['read', 'write'],
            created_at: '2025-09-01T00:00:00Z',
          },
        },
      ],
    });
    const dry = (await client.callTool({
      name: 'oauth_authorizations_delete',
      arguments: { id: 'oa-1', confirm_target: 'ci-token', dry_run: true },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ description: string }>(dry);
    expect(env.ok).toBe(true);
    expect(env.data?.description).toContain('ci-token');
    expect(env.data?.description).toContain('read');
    expect(env.data?.description).toContain('2025-09-01');
    expect(calls).toHaveLength(1);
  });

  it('oauth_authorizations_regenerate confirms on prefetched id and POSTs the action', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: accountOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/oauth/authorizations/oa-1' && init?.method === 'GET',
          body: { id: 'oa-1' },
        },
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/oauth/authorizations/oa-1/actions/regenerate-tokens' &&
            init?.method === 'POST',
          body: { id: 'oa-1' },
        },
      ],
    });
    const reject = (await client.callTool({
      name: 'oauth_authorizations_regenerate',
      arguments: { id: 'oa-1' },
    })) as { isError?: boolean };
    expect(reject.isError).toBe(true);

    const ok = (await client.callTool({
      name: 'oauth_authorizations_regenerate',
      arguments: { id: 'oa-1', confirm: 'oa-1' },
    })) as { content: unknown[] };
    expect(parseEnvelope(ok).ok).toBe(true);
    expect(calls.find((c) => c.method === 'POST')).toBeDefined();
  });

  it('invoice_address_update PUTs the supplied fields', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: accountOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/account/invoice-address' && init?.method === 'PUT',
          body: {},
        },
      ],
    });
    await client.callTool({
      name: 'invoice_address_update',
      arguments: { city: 'San Francisco', country: 'US' },
    });
    expect(calls[0]?.method).toBe('PUT');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ city: 'San Francisco', country: 'US' });
  });

  it('credits_create POSTs code + optional amount', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: accountOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/account/credits' && init?.method === 'POST',
          body: { id: 'cr-1' },
        },
      ],
    });
    await client.callTool({
      name: 'credits_create',
      arguments: { code: 'PROMO-XYZ', amount: 100 },
    });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ code: 'PROMO-XYZ', amount: 100 });
  });

  it('user_preferences_update PATCHes /users/~/preferences', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: accountOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/users/~/preferences' && init?.method === 'PATCH',
          body: {},
        },
      ],
    });
    await client.callTool({
      name: 'user_preferences_update',
      arguments: { preferences: { timezone: 'America/Los_Angeles' } },
    });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ timezone: 'America/Los_Angeles' });
  });
});
