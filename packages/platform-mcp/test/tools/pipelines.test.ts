/**
 * Pipelines-tier tool tests (reads and writes).
 *
 * Covers:
 *   - Registration gating on the pipelines capability tier
 *   - Read tools: list, info, couplings, releases/deployments, promotions
 *   - Write tools: CRUD, couplings CRUD, promotion (NOT destructive per Phase
 *     3 Decision 2), promote_to_new, transfer, review-app config
 */

import { describe, expect, it } from 'vitest';
import type { CapabilityResult } from '@heroku-mcp/core';
import { parseEnvelope, spinUpServer } from '../helpers.js';

const pipelinesOnly: CapabilityResult = {
  schemaVersion: 1,
  tokenFingerprint: 'fp',
  probedAt: new Date().toISOString(),
  ttlSeconds: 3600,
  tiers: {
    account: { available: true },
    pipelines: { available: true },
  },
};

const noPipelines: CapabilityResult = {
  schemaVersion: 1,
  tokenFingerprint: 'fp',
  probedAt: new Date().toISOString(),
  ttlSeconds: 3600,
  tiers: {
    account: { available: true },
    pipelines: { available: false, reason: 'forbidden', status: 403 },
  },
};

describe('pipelines-tier reads', () => {
  it('registers pipelines read tools when the tier is available', async () => {
    const { client } = await spinUpServer({ capabilities: pipelinesOnly });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'pipelines_list',
        'pipelines_info',
        'pipeline_couplings_list',
        'pipeline_couplings_info',
        'pipeline_couplings_by_app',
        'pipeline_releases_list',
        'pipeline_promotions_list',
        'pipeline_promotions_info',
        'pipeline_promotion_targets_list',
        'pipeline_deployments_list',
        'pipeline_review_app_config_info',
      ]),
    );
  });

  it('hides pipelines tools when the tier is unavailable', async () => {
    const { client } = await spinUpServer({ capabilities: noPipelines });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('pipelines_list');
  });

  it('pipelines_list sends a Range header for pagination', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: pipelinesOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/pipelines',
          body: [{ id: 'p-1', name: 'demo-pipeline' }],
          headers: {
            'content-range': 'id 0..0; max=10',
            'next-range': 'id p-1; max=10',
          },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'pipelines_list',
      arguments: { page_size: 10 },
    })) as { content: unknown[] };
    const env = parseEnvelope<unknown[]>(result);
    expect(env.ok).toBe(true);
    expect(calls[0]?.headers.range).toBe('id ..; max=10');
    expect(env.meta?.pagination).toEqual({ hasMore: true, cursor: 'id p-1; max=10' });
  });

  it('pipeline_couplings_by_app wraps GET /apps/{app}/pipeline-couplings', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: pipelinesOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/apps/demo/pipeline-couplings',
          body: { id: 'pc-1', stage: 'staging' },
        },
      ],
    });
    await client.callTool({
      name: 'pipeline_couplings_by_app',
      arguments: { app: 'demo' },
    });
    expect(calls[0]?.url).toBe('https://api.heroku.com/apps/demo/pipeline-couplings');
  });
});

describe('pipelines-tier writes', () => {
  it('registers pipelines write tools when the tier is available', async () => {
    const { client } = await spinUpServer({ capabilities: pipelinesOnly });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'pipelines_create',
        'pipelines_update',
        'pipelines_destroy',
        'pipeline_couplings_create',
        'pipeline_couplings_update',
        'pipeline_couplings_destroy',
        'pipelines_promote',
        'pipelines_promote_to_new',
        'pipeline_transfer',
        'pipeline_review_app_config_update',
        'pipeline_review_apps_enable',
      ]),
    );
  });

  it('pipelines_promote does NOT require confirm (Phase 3 Decision 2)', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: pipelinesOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/pipeline-promotions' && init?.method === 'POST',
          body: { id: 'pp-1' },
        },
      ],
    });
    // No confirm arg: should still succeed.
    const result = (await client.callTool({
      name: 'pipelines_promote',
      arguments: {
        pipeline: 'p-1',
        source: 'staging-app-id',
        targets: ['prod-app-id'],
      },
    })) as { content: unknown[] };
    expect(parseEnvelope(result).ok).toBe(true);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      pipeline: { id: 'p-1' },
      source: { app: { id: 'staging-app-id' } },
      targets: [{ app: { id: 'prod-app-id' } }],
    });
  });

  it('pipelines_promote dry_run surfaces source → targets', async () => {
    const { client } = await spinUpServer({
      capabilities: pipelinesOnly,
      responses: [],
    });
    const dry = (await client.callTool({
      name: 'pipelines_promote',
      arguments: {
        pipeline: 'p-1',
        source: 'staging-app-id',
        targets: ['prod-1', 'prod-2'],
        dry_run: true,
      },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ description: string }>(dry);
    expect(env.ok).toBe(true);
    expect(env.data?.description).toContain('staging-app-id');
    expect(env.data?.description).toContain('prod-1');
    expect(env.data?.description).toContain('prod-2');
  });

  it('pipelines_promote_to_new dry_run surfaces the NEW app name + stage', async () => {
    const { client } = await spinUpServer({
      capabilities: pipelinesOnly,
      responses: [],
    });
    const dry = (await client.callTool({
      name: 'pipelines_promote_to_new',
      arguments: {
        pipeline: 'p-1',
        source: 'staging-app-id',
        new_app_name: 'my-new-prod',
        new_app_stage: 'production',
        dry_run: true,
      },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ description: string }>(dry);
    expect(env.ok).toBe(true);
    expect(env.data?.description).toContain('my-new-prod');
    expect(env.data?.description).toContain('production');
    expect(env.data?.description).toContain('NEW');
  });

  it('pipelines_destroy confirm target is the prefetched pipeline name', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: pipelinesOnly,
      responses: [
        {
          match: (url) => url === 'https://api.heroku.com/pipelines/p-1',
          body: { id: 'p-1', name: 'demo-pipeline', created_at: '2025-01-01T00:00:00Z' },
        },
      ],
    });
    const reject = (await client.callTool({
      name: 'pipelines_destroy',
      arguments: { pipeline: 'p-1', confirm: 'p-1' },
    })) as { isError?: boolean };
    expect(reject.isError).toBe(true);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('pipelines_destroy executes when confirm matches the canonical name', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: pipelinesOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/pipelines/p-1' && init?.method === 'GET',
          body: { id: 'p-1', name: 'demo-pipeline' },
        },
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/pipelines/p-1' && init?.method === 'DELETE',
          body: { id: 'p-1' },
        },
      ],
    });
    const ok = (await client.callTool({
      name: 'pipelines_destroy',
      arguments: { pipeline: 'p-1', confirm: 'demo-pipeline' },
    })) as { content: unknown[] };
    expect(parseEnvelope(ok).ok).toBe(true);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it('pipeline_couplings_destroy confirm target is the parent pipeline name', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: pipelinesOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/pipeline-couplings/pc-1' && init?.method === 'GET',
          body: {
            id: 'pc-1',
            stage: 'staging',
            app: { name: 'demo-staging' },
            pipeline: { id: 'p-1', name: 'demo-pipeline' },
          },
        },
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/pipeline-couplings/pc-1' && init?.method === 'DELETE',
          body: { id: 'pc-1' },
        },
      ],
    });
    const reject = (await client.callTool({
      name: 'pipeline_couplings_destroy',
      arguments: { coupling: 'pc-1', confirm: 'pc-1' },
    })) as { isError?: boolean };
    expect(reject.isError).toBe(true);

    const ok = (await client.callTool({
      name: 'pipeline_couplings_destroy',
      arguments: { coupling: 'pc-1', confirm: 'demo-pipeline' },
    })) as { content: unknown[] };
    expect(parseEnvelope(ok).ok).toBe(true);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it('pipeline_couplings_create POSTs app + pipeline + stage', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: pipelinesOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/pipeline-couplings' && init?.method === 'POST',
          body: { id: 'pc-1' },
        },
      ],
    });
    await client.callTool({
      name: 'pipeline_couplings_create',
      arguments: { app: 'demo-staging', pipeline: 'demo-pipeline', stage: 'staging' },
    });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      app: 'demo-staging',
      pipeline: 'demo-pipeline',
      stage: 'staging',
    });
  });

  it('pipeline_review_apps_enable POSTs review-app-config', async () => {
    const { client, calls } = await spinUpServer({
      capabilities: pipelinesOnly,
      responses: [
        {
          match: (url, init) =>
            url === 'https://api.heroku.com/pipelines/p-1/review-app-config' &&
            init?.method === 'POST',
          body: { id: 'rac-1' },
        },
      ],
    });
    await client.callTool({
      name: 'pipeline_review_apps_enable',
      arguments: { pipeline: 'p-1', repo: 'acme/demo', automatic_review_apps: true },
    });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      repo: 'acme/demo',
      automatic_review_apps: true,
    });
  });
});
