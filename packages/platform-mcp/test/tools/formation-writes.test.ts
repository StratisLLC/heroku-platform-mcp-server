/**
 * Tests for formation/dyno writes. Verifies the destructive ones gate on the
 * documented confirm target (dynos_stop on dyno name, others on app name).
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

describe('formation-tier writes', () => {
  it('registers the expected tools', async () => {
    const { client } = await spinUpServer({ capabilities: appsOnly });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'formation_scale',
        'dynos_run',
        'dynos_restart',
        'dynos_restart_all',
        'dynos_stop',
      ]),
    );
  });

  it('formation_scale PATCHes /apps/{app}/formation with updates', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/apps/demo/formation' && init?.method === 'PATCH',
          body: [{ type: 'web', quantity: 2 }],
        },
      ],
    });
    const result = (await client.callTool({
      name: 'formation_scale',
      arguments: { app: 'demo', updates: [{ type: 'web', quantity: 2, size: 'Standard-1X' }] },
    })) as { content: unknown[] };
    expect(parseEnvelope(result).ok).toBe(true);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      updates: [{ type: 'web', quantity: 2, size: 'Standard-1X' }],
    });
  });

  it('dynos_run POSTs to /apps/{app}/dynos with the command body', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/apps/demo/dynos' && init?.method === 'POST',
          body: { id: 'd-1', name: 'run.1234', command: 'rake db:migrate', state: 'starting' },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'dynos_run',
      arguments: { app: 'demo', command: 'rake db:migrate', time_to_live: 600 },
    })) as { content: unknown[] };
    expect(parseEnvelope(result).ok).toBe(true);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      command: 'rake db:migrate',
      time_to_live: 600,
    });
  });

  it('dynos_restart requires confirm matching app name', async () => {
    const { client, calls } = await spinUpServer({ capabilities: appsOnly, responses: [] });
    const result = (await client.callTool({
      name: 'dynos_restart',
      arguments: { app: 'demo', dyno: 'web.1', confirm: 'web.1' /* wrong target */ },
    })) as { content: unknown[]; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('dynos_stop requires confirm matching dyno name (not the app)', async () => {
    const { client } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/apps/demo/dynos/run.1234/actions/stop' &&
            init?.method === 'POST',
          body: { id: 'd-1', state: 'stopped' },
        },
      ],
    });
    // Mismatched confirm — passing app name, not dyno name.
    const reject = (await client.callTool({
      name: 'dynos_stop',
      arguments: { app: 'demo', dyno: 'run.1234', confirm: 'demo' },
    })) as { isError?: boolean };
    expect(reject.isError).toBe(true);

    // Correct confirm — dyno name.
    const ok = (await client.callTool({
      name: 'dynos_stop',
      arguments: { app: 'demo', dyno: 'run.1234', confirm: 'run.1234' },
    })) as { content: unknown[] };
    expect(parseEnvelope(ok).ok).toBe(true);
  });

  it('dynos_restart_all is destructive and DELETEs /apps/{app}/dynos', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: appsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/apps/demo/dynos' && init?.method === 'DELETE',
          body: {},
        },
      ],
    });
    const result = (await client.callTool({
      name: 'dynos_restart_all',
      arguments: { app: 'demo', confirm: 'demo' },
    })) as { content: unknown[] };
    expect(parseEnvelope(result).ok).toBe(true);
    expect(calls[0]?.method).toBe('DELETE');
  });
});
