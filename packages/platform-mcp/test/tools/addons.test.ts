/**
 * Add-ons tier tool tests (reads and writes).
 *
 * Covers:
 *   - Registration gating on the addons_consumer capability tier
 *   - Read tools: list, info, resolve (POST-as-read), services/plans/regions,
 *     attachments, config, actions, webhooks, sso
 *   - Write tools: create, update, destroy (with canonical-name confirm),
 *     attachments create/destroy, config update, action run, webhook
 *     create/update/delete
 */

import { describe, expect, it } from 'vitest';
import type { CapabilityResult } from '@heroku-mcp/core';
import { parseEnvelope, spinUpServer } from '../helpers.js';

const addonsOnly: CapabilityResult = {
  schemaVersion: 1,
  tokenFingerprint: 'fp',
  probedAt: new Date().toISOString(),
  ttlSeconds: 3600,
  tiers: {
    account: { available: true },
    addons_consumer: { available: true },
  },
};

const noAddons: CapabilityResult = {
  schemaVersion: 1,
  tokenFingerprint: 'fp',
  probedAt: new Date().toISOString(),
  ttlSeconds: 3600,
  tiers: {
    account: { available: true },
    addons_consumer: { available: false, reason: 'forbidden', status: 403 },
  },
};

describe('addons-tier reads', () => {
  it('registers addons read tools when the tier is available', async () => {
    const { client } = await spinUpServer({ capabilities: addonsOnly });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'addons_list',
        'addons_info',
        'addons_resolve',
        'addon_services_list',
        'addon_services_info',
        'addon_attachments_list',
        'addon_attachments_info',
        'addon_attachments_resolve',
        'addon_config_get',
        'addon_actions_list',
        'addon_regions_list',
        'addon_plans_list',
        'addon_plans_info',
        'addon_webhooks_list',
        'addon_webhooks_info',
        'sso_token_for_addon',
      ]),
    );
  });

  it('hides addons tools when the tier is unavailable', async () => {
    const { client } = await spinUpServer({ capabilities: noAddons });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('addons_list');
    expect(names).not.toContain('sso_token_for_addon');
  });

  it('addons_list sends a Range header for pagination', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: addonsOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/addons',
          body: [{ id: 'a-1', name: 'heroku-postgresql-pinkish-5310' }],
          headers: {
            'content-range': 'id 0..0; max=10',
            'next-range': 'id a-1; max=10',
          },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'addons_list',
      arguments: { page_size: 10 },
    })) as { content: unknown[] };
    const env = parseEnvelope<unknown[]>(result);
    expect(env.ok).toBe(true);
    expect(calls[0]?.headers.range).toBe('id ..; max=10');
    expect(env.meta?.pagination).toEqual({ hasMore: true, cursor: 'id a-1; max=10' });
  });

  it('addons_resolve POSTs the addon name to /actions/addons/resolve', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: addonsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/actions/addons/resolve' && init?.method === 'POST',
          body: [{ id: 'a-1', name: 'heroku-postgresql-pinkish-5310' }],
        },
      ],
    });
    await client.callTool({
      name: 'addons_resolve',
      arguments: { addon: 'heroku-postgresql-pinkish-5310' },
    });
    expect(calls[0]?.method).toBe('POST');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      addon: 'heroku-postgresql-pinkish-5310',
    });
  });

  it('sso_token_for_addon POSTs /addons/{name}/sso (read-style)', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: addonsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/addons/heroku-postgresql/sso' &&
            init?.method === 'POST',
          body: { url: 'https://addons.example.com/sso?token=xxx' },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'sso_token_for_addon',
      arguments: { addon: 'heroku-postgresql' },
    })) as { content: unknown[] };
    expect(parseEnvelope(result).ok).toBe(true);
    expect(calls[0]?.method).toBe('POST');
  });

  it('addon_plans_info URL-encodes service and plan', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: addonsOnly,
      responses: [
        {
          match: (url) => url.startsWith('https://api.heroku.com/addon-services/'),
          body: { id: 'p-1', name: 'heroku-postgresql:essential-0' },
        },
      ],
    });
    await client.callTool({
      name: 'addon_plans_info',
      arguments: { service: 'heroku-postgresql', plan: 'heroku-postgresql:essential-0' },
    });
    expect(calls[0]?.url).toBe(
      'https://api.heroku.com/addon-services/heroku-postgresql/plans/heroku-postgresql%3Aessential-0',
    );
  });
});

describe('addons-tier writes', () => {
  it('registers addons write tools when the tier is available', async () => {
    const { client } = await spinUpServer({ capabilities: addonsOnly });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'addons_create',
        'addons_update',
        'addons_destroy',
        'addons_provision_release_test_resource',
        'addons_promote_to_release',
        'addon_attachments_create',
        'addon_attachments_destroy',
        'addon_config_update',
        'addon_actions_run',
        'addon_webhooks_create',
        'addon_webhooks_update',
        'addon_webhooks_delete',
      ]),
    );
  });

  it('addons_create POSTs plan + optional attachment to /apps/{app}/addons', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: addonsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/apps/demo/addons' && init?.method === 'POST',
          body: { id: 'a-1', name: 'heroku-scheduler-pinkish-1234' },
        },
      ],
    });
    await client.callTool({
      name: 'addons_create',
      arguments: { app: 'demo', plan: 'scheduler:standard' },
    });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ plan: 'scheduler:standard' });
  });

  it('addons_destroy confirm target is the prefetched add-on name', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: addonsOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/apps/demo/addons/a-1',
          body: {
            id: 'a-1',
            name: 'heroku-postgresql-pinkish-5310',
            plan: { name: 'heroku-postgresql:standard-0' },
            addon_service: { name: 'heroku-postgresql' },
          },
        },
      ],
    });
    // Pass UUID as input but the wrong confirm value.
    const reject = (await client.callTool({
      name: 'addons_destroy',
      arguments: { app: 'demo', addon: 'a-1', confirm: 'a-1' },
    })) as { isError?: boolean };
    expect(reject.isError).toBe(true);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('addons_destroy executes when confirm matches the prefetched name', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: addonsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/apps/demo/addons/a-1' && init?.method === 'GET',
          body: {
            id: 'a-1',
            name: 'heroku-postgresql-pinkish-5310',
            plan: { name: 'heroku-postgresql:standard-0' },
          },
        },
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/apps/demo/addons/a-1' && init?.method === 'DELETE',
          body: { id: 'a-1' },
        },
      ],
    });
    const ok = (await client.callTool({
      name: 'addons_destroy',
      arguments: {
        app: 'demo',
        addon: 'a-1',
        confirm: 'heroku-postgresql-pinkish-5310',
      },
    })) as { content: unknown[] };
    expect(parseEnvelope(ok).ok).toBe(true);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it('addons_destroy dry_run surfaces plan + service in the description', async () => {
    const { client } = await spinUpServer({
      capabilities: addonsOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/apps/demo/addons/db',
          body: {
            id: 'a-1',
            name: 'heroku-postgresql-pinkish-5310',
            plan: { name: 'heroku-postgresql:standard-0' },
            addon_service: { name: 'heroku-postgresql' },
          },
        },
      ],
    });
    const dry = (await client.callTool({
      name: 'addons_destroy',
      arguments: { app: 'demo', addon: 'db', dry_run: true },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ description: string }>(dry);
    expect(env.ok).toBe(true);
    expect(env.data?.description).toContain('heroku-postgresql:standard-0');
    expect(env.data?.description).toContain('heroku-postgresql');
  });

  it('addon_attachments_destroy confirm target is the attachment name', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: addonsOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/addon-attachments/att-1',
          body: {
            id: 'att-1',
            name: 'DATABASE',
            app: { name: 'demo' },
            addon: { name: 'heroku-postgresql-pinkish-5310' },
          },
        },
      ],
    });
    const reject = (await client.callTool({
      name: 'addon_attachments_destroy',
      arguments: { attachment: 'att-1', confirm: 'att-1' },
    })) as { isError?: boolean };
    expect(reject.isError).toBe(true);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('addon_config_update PATCHes /addons/{addon}/config with the config array', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: addonsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/addons/db/config' && init?.method === 'PATCH',
          body: [],
        },
      ],
    });
    await client.callTool({
      name: 'addon_config_update',
      arguments: {
        addon: 'db',
        config: [{ name: 'LOG_LEVEL', value: 'debug' }],
      },
    });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      config: [{ name: 'LOG_LEVEL', value: 'debug' }],
    });
  });

  it('addon_actions_run POSTs to /addons/{addon}/actions/{action}', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: addonsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/addons/db/actions/promote' && init?.method === 'POST',
          body: { id: 'job-1' },
        },
      ],
    });
    await client.callTool({
      name: 'addon_actions_run',
      arguments: { addon: 'db', action: 'promote' },
    });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('https://api.heroku.com/addons/db/actions/promote');
  });

  it('addon_webhooks_delete confirm target is the parent add-on name (from prefetch)', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: addonsOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/addons/db' && init?.method === 'GET',
          body: { id: 'a-1', name: 'heroku-postgresql-pinkish-5310' },
        },
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/addons/db/webhooks/w-1' && init?.method === 'DELETE',
          body: { id: 'w-1' },
        },
      ],
    });
    const reject = (await client.callTool({
      name: 'addon_webhooks_delete',
      arguments: { addon: 'db', webhook: 'w-1', confirm: 'db' },
    })) as { isError?: boolean };
    expect(reject.isError).toBe(true);

    const ok = (await client.callTool({
      name: 'addon_webhooks_delete',
      arguments: {
        addon: 'db',
        webhook: 'w-1',
        confirm: 'heroku-postgresql-pinkish-5310',
      },
    })) as { content: unknown[] };
    expect(parseEnvelope(ok).ok).toBe(true);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });
});
