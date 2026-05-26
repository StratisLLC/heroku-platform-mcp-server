/**
 * Tests for domains + SNI writes. Confirms that destructive variants
 * pre-fetch state for the dry_run preview.
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

describe('domains-tier writes', () => {
  it('registers the expected tools', async () => {
    const { client } = await spinUpServer({ capabilities: appsOnly });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'domains_create',
        'domains_update',
        'domains_delete',
        'sni_endpoints_create',
        'sni_endpoints_update',
        'sni_endpoints_delete',
      ]),
    );
  });

  it('domains_create POSTs the hostname', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/apps/demo/domains' && init?.method === 'POST',
          body: { id: 'd-1', hostname: 'www.example.com' },
        },
      ],
    });
    await client.callTool({
      name: 'domains_create',
      arguments: { app: 'demo', hostname: 'www.example.com' },
    });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ hostname: 'www.example.com' });
  });

  it('domains_delete confirm target is the hostname; dry_run pre-fetches', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/apps/demo/domains/www.example.com' &&
            init?.method === 'GET',
          body: {
            hostname: 'www.example.com',
            cname: 'demo-12345.herokudns.com',
          },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'domains_delete',
      arguments: { app: 'demo', domain: 'www.example.com', dry_run: true },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ description: string }>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.description).toContain('www.example.com');
    expect(env.data?.description).toContain('herokudns.com');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
  });

  it('domains_delete rejects when confirm does not match the hostname', async () => {
    const { client, calls } = await spinUpServer({ capabilities: appsOnly, responses: [] });
    const result = (await client.callTool({
      name: 'domains_delete',
      arguments: { app: 'demo', domain: 'www.example.com', confirm: 'demo' },
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('sni_endpoints_create sends certificate_chain + private_key in the body', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/apps/demo/sni-endpoints' && init?.method === 'POST',
          body: { id: 'sni-1' },
        },
      ],
    });
    await client.callTool({
      name: 'sni_endpoints_create',
      arguments: { app: 'demo', certificate_chain: '----CERT----', private_key: '----KEY----' },
    });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      certificate_chain: '----CERT----',
      private_key: '----KEY----',
    });
  });
});
