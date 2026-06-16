/**
 * Spaces-tier write tool tests. Currently focused on the leak-hardening
 * guarantee that vpn_connections_create never echoes IPSec pre-shared keys.
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

describe('spaces-tier writes', () => {
  it('vpn_connections_create strips per-tunnel pre_shared_key from the response', async () => {
    const { client } = await spinUpServer({
      capabilities: spacesOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/spaces/my-space/vpn-connections' &&
            init?.method === 'POST',
          body: {
            id: 'vpn-1',
            name: 'office',
            status: 'pending',
            tunnels: [
              { ip: '203.0.113.1', pre_shared_key: 'SECRET-PSK-A', status: 'pending' },
              { ip: '203.0.113.2', pre_shared_key: 'SECRET-PSK-B', status: 'pending' },
            ],
          },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'vpn_connections_create',
      arguments: {
        space: 'my-space',
        name: 'office',
        public_ip: '198.51.100.1',
        routable_cidrs: ['172.16.0.0/12'],
      },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ tunnels: Record<string, unknown>[] }>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.tunnels).toHaveLength(2);
    for (const tunnel of env.data?.tunnels ?? []) {
      expect(tunnel).not.toHaveProperty('pre_shared_key');
    }
    // Non-secret tunnel fields survive.
    expect(env.data?.tunnels[0]).toHaveProperty('ip', '203.0.113.1');
  });
});
