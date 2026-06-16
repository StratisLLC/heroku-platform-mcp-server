/**
 * Spaces-tier tool tests (reads and writes).
 *
 * Covers:
 *   - Registration gating on the spaces capability tier
 *   - Read tools (paginated list endpoints, NAT/ruleset/peering/vpn info)
 *   - Write tools: create (incl. Shield + log_drain_url enforcement, Phase 3
 *     Decision 5), update, destroy (with confirm), VPN/peering create/destroy,
 *     ruleset PUT
 */

import { describe, expect, it } from 'vitest';
import type { CapabilityResult } from '@heroku-mcp/core';
import { parseEnvelope, spinUpServer } from '../helpers.js';

const spacesOnly: CapabilityResult = {
  schemaVersion: 1,
  tokenFingerprint: 'fp',
  probedAt: new Date().toISOString(),
  ttlSeconds: 3600,
  tiers: {
    account: { available: true },
    spaces: { available: true },
  },
};

const noSpaces: CapabilityResult = {
  schemaVersion: 1,
  tokenFingerprint: 'fp',
  probedAt: new Date().toISOString(),
  ttlSeconds: 3600,
  tiers: {
    account: { available: true },
    spaces: { available: false, reason: 'forbidden', status: 403 },
  },
};

describe('spaces-tier reads', () => {
  it('registers spaces read tools when the tier is available', async () => {
    const { client } = await spinUpServer({ capabilities: spacesOnly });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'spaces_list',
        'spaces_info',
        'spaces_app_access_list',
        'spaces_nat_info',
        'spaces_inbound_ruleset_current',
        'spaces_outbound_ruleset_current',
        'spaces_inbound_rulesets_list',
        'spaces_outbound_rulesets_list',
        'vpn_connections_list',
        'vpn_connections_info',
        'peerings_list',
        'peerings_info',
        'space_transfer_list',
      ]),
    );
  });

  it('hides spaces tools when the tier is unavailable', async () => {
    const { client } = await spinUpServer({ capabilities: noSpaces });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('spaces_list');
    expect(names).not.toContain('vpn_connections_list');
  });

  it('spaces_list sends a Range header for pagination', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: spacesOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/spaces',
          body: [{ id: 's-1', name: 'demo-space' }],
          headers: {
            'content-range': 'id 0..0; max=10',
            'next-range': 'id s-1; max=10',
          },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'spaces_list',
      arguments: { page_size: 10 },
    })) as { content: unknown[] };
    const env = parseEnvelope<unknown[]>(result);
    expect(env.ok).toBe(true);
    expect(calls[0]?.headers.range).toBe('id ..; max=10');
    expect(env.meta?.pagination).toEqual({ hasMore: true, cursor: 'id s-1; max=10' });
  });

  it('spaces_nat_info wraps GET /spaces/{name}/nat', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: spacesOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/spaces/demo-space/nat',
          body: { sources: ['1.2.3.4'] },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'spaces_nat_info',
      arguments: { space: 'demo-space' },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ sources: string[] }>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.sources).toEqual(['1.2.3.4']);
    expect(calls[0]?.url).toBe('https://api.heroku.com/spaces/demo-space/nat');
  });
});

describe('spaces-tier writes', () => {
  it('registers spaces write tools when the tier is available', async () => {
    const { client } = await spinUpServer({ capabilities: spacesOnly });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'spaces_create',
        'spaces_update',
        'spaces_destroy',
        'vpn_connections_create',
        'vpn_connections_destroy',
        'peerings_create',
        'peerings_destroy',
        'space_transfer_create',
        'spaces_inbound_ruleset_create',
        'spaces_outbound_ruleset_create',
      ]),
    );
  });

  it('spaces_create description carries the Shield log_drain_url guidance verbatim', async () => {
    const { client } = await spinUpServer({ capabilities: spacesOnly });
    const tools = (await client.listTools()).tools;
    const create = tools.find((t) => t.name === 'spaces_create');
    expect(create?.description).toContain('Shield-type private spaces require a log_drain_url');
    expect(create?.description).toContain('https://localhost');
    expect(create?.description).toContain('permanently disables log-drain support');
  });

  it('spaces_create REJECTS shield=true without log_drain_url (Phase 3 Decision 5)', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: spacesOnly,
      responses: [],
    });
    const result = (await client.callTool({
      name: 'spaces_create',
      arguments: { name: 'shield-space', team: 't-1', shield: true },
    })) as { isError?: boolean; content: unknown[] };
    expect(result.isError).toBe(true);
    const env = parseEnvelope(result);
    expect(env.error?.kind).toBe('invalid_params');
    expect(env.error?.message).toContain('log_drain_url');
    expect(env.error?.message).toContain('Shield');
    // Heroku must NOT have been called.
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('spaces_create accepts shield=true when log_drain_url is provided', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: spacesOnly,
      responses: [
        {
          match: (url, init) => url === 'https://api.heroku.com/spaces' && init?.method === 'POST',
          body: { id: 's-1', name: 'shield-space', state: 'allocating' },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'spaces_create',
      arguments: {
        name: 'shield-space',
        team: 't-1',
        shield: true,
        log_drain_url: 'https://localhost',
      },
    })) as { content: unknown[] };
    expect(parseEnvelope(result).ok).toBe(true);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      name: 'shield-space',
      team: 't-1',
      shield: true,
      log_drain_url: 'https://localhost',
    });
  });

  it('spaces_create allows shield omitted (no log_drain_url enforcement)', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: spacesOnly,
      responses: [
        {
          match: (url, init) => url === 'https://api.heroku.com/spaces' && init?.method === 'POST',
          body: { id: 's-1', name: 'plain-space' },
        },
      ],
    });
    await client.callTool({
      name: 'spaces_create',
      arguments: { name: 'plain-space', team: 't-1' },
    });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ name: 'plain-space', team: 't-1' });
  });

  it('spaces_destroy requires confirm matching the prefetched space name', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: spacesOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/spaces/demo-space',
          body: {
            id: 's-1',
            name: 'demo-space',
            region: { name: 'virginia' },
            team: { name: 'acme' },
          },
        },
      ],
    });
    const missing = (await client.callTool({
      name: 'spaces_destroy',
      arguments: { space: 'demo-space' },
    })) as { isError?: boolean; content: unknown[] };
    expect(missing.isError).toBe(true);
    const env = parseEnvelope(missing);
    expect((env.error?.details as { expected?: string }).expected).toBe('demo-space');
    expect((env.error?.details as { target_kind?: string }).target_kind).toBe('space');
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('spaces_destroy dry_run surfaces region + team + shield in the description', async () => {
    const { client } = await spinUpServer({
      capabilities: spacesOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/spaces/demo-space',
          body: {
            id: 's-1',
            name: 'demo-space',
            region: { name: 'virginia' },
            team: { name: 'acme' },
            shield: true,
          },
        },
      ],
    });
    const dry = (await client.callTool({
      name: 'spaces_destroy',
      arguments: { space: 'demo-space', dry_run: true },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ description: string; request: { method: string } }>(dry);
    expect(env.ok).toBe(true);
    expect(env.data?.request.method).toBe('DELETE');
    expect(env.data?.description).toContain('demo-space');
    expect(env.data?.description).toContain('virginia');
    expect(env.data?.description).toContain('acme');
    expect(env.data?.description).toContain('SHIELD');
  });

  it('spaces_destroy executes when confirm matches the prefetched name (regardless of input id)', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: spacesOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/spaces/s-1' && init?.method === 'GET',
          body: { id: 's-1', name: 'demo-space' },
        },
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/spaces/s-1' && init?.method === 'DELETE',
          body: { id: 's-1', name: 'demo-space' },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'spaces_destroy',
      arguments: { space: 's-1', confirm: 'demo-space' },
    })) as { content: unknown[] };
    expect(parseEnvelope(result).ok).toBe(true);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it('vpn_connections_create POSTs the documented body', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: spacesOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/spaces/demo-space/vpn-connections' &&
            init?.method === 'POST',
          body: { id: 'vpn-1', name: 'office' },
        },
      ],
    });
    await client.callTool({
      name: 'vpn_connections_create',
      arguments: {
        space: 'demo-space',
        name: 'office',
        public_ip: '203.0.113.1',
        routable_cidrs: ['172.16.0.0/12'],
      },
    });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      name: 'office',
      public_ip: '203.0.113.1',
      routable_cidrs: ['172.16.0.0/12'],
    });
  });

  it('vpn_connections_destroy confirm target is the prefetched VPN name', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: spacesOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/spaces/demo-space/vpn-connections/vpn-1',
          body: { id: 'vpn-1', name: 'office', public_ip: '203.0.113.1' },
        },
      ],
    });
    const reject = (await client.callTool({
      name: 'vpn_connections_destroy',
      arguments: { space: 'demo-space', vpn: 'vpn-1', confirm: 'vpn-1' },
    })) as { isError?: boolean };
    expect(reject.isError).toBe(true);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('peerings_destroy confirm target is the prefetched pcx_id', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: spacesOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/spaces/demo-space/peerings/p-1' &&
            init?.method === 'GET',
          body: { id: 'p-1', pcx_id: 'pcx-12345', status: 'active' },
        },
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/spaces/demo-space/peerings/p-1' &&
            init?.method === 'DELETE',
          body: { id: 'p-1' },
        },
      ],
    });
    const reject = (await client.callTool({
      name: 'peerings_destroy',
      arguments: { space: 'demo-space', peering: 'p-1', confirm: 'p-1' },
    })) as { isError?: boolean };
    expect(reject.isError).toBe(true);

    const ok = (await client.callTool({
      name: 'peerings_destroy',
      arguments: { space: 'demo-space', peering: 'p-1', confirm: 'pcx-12345' },
    })) as { content: unknown[] };
    expect(parseEnvelope(ok).ok).toBe(true);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it('spaces_inbound_ruleset_create PUTs the rules array', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: spacesOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/spaces/demo-space/inbound-ruleset' &&
            init?.method === 'PUT',
          body: { id: 'r-1' },
        },
      ],
    });
    await client.callTool({
      name: 'spaces_inbound_ruleset_create',
      arguments: {
        space: 'demo-space',
        rules: [{ action: 'allow', source: '203.0.113.0/24' }],
      },
    });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      rules: [{ action: 'allow', source: '203.0.113.0/24' }],
    });
  });
});
