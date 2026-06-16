/**
 * Pipelines-tier read-only tools (TOOLS.md "Tier: `pipelines`", read entries).
 *
 * Exposed when the pipelines tier probe (`pipelines.list`) succeeded.
 *
 * Note: review-app-LEVEL operations (per-review-app create/delete) live in the
 * apps tier — Phase 2a ships those tools (`review_apps_create`,
 * `review_apps_delete`, `review_apps_config_*`). The pipelines tier here adds
 * pipeline-wide review-app configuration.
 *
 * Every list-style tool MUST go through the @heroku-mcp/core pagination
 * helper.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, paginationInputShape, rangeHeader, runTool } from '../tool-helpers.js';
import type { HerokuList, HerokuRecord } from '../tool-helpers.js';
import type { ToolContext } from '../context.js';

const url = (s: string): string => encodeURIComponent(s);

const pipelineInput = {
  pipeline: z.string().min(1).describe('Pipeline id or name. Prefer UUID when known.'),
};

const couplingInput = {
  coupling: z.string().min(1).describe('Pipeline-coupling id (UUID).'),
};

const appInput = {
  app: z.string().min(1).describe('App id or name. Prefer UUID when known.'),
};

const promotionInput = {
  promotion: z.string().min(1).describe('Pipeline-promotion id (UUID).'),
};

/** Register read-only pipelines-tier tools onto the server. */
export function registerPipelinesTools(server: McpServer, ctx: ToolContext): void {
  // --------------------------------------------------------------------------
  // Pipelines
  // --------------------------------------------------------------------------

  server.registerTool(
    'pipelines_list',
    {
      title: 'Pipelines list',
      description:
        'List pipelines the authenticated user has access to. Paginated. Wraps GET /pipelines.',
      inputSchema: { ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>('/pipelines', {
          tool: 'pipelines_list',
          headers: { Range: rangeHeader(input) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'pipelines_info',
    {
      title: 'Pipeline info',
      description: 'Return one pipeline by id or name. Wraps GET /pipelines/{id_or_name}.',
      inputSchema: pipelineInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ pipeline }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(`/pipelines/${url(pipeline)}`, {
          tool: 'pipelines_info',
        });
        return ok(res);
      }),
  );

  // --------------------------------------------------------------------------
  // Couplings
  // --------------------------------------------------------------------------

  server.registerTool(
    'pipeline_couplings_list',
    {
      title: 'Pipeline couplings list',
      description:
        'List pipeline couplings visible to the caller (across pipelines). Paginated. Wraps GET /pipeline-couplings.',
      inputSchema: { ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>('/pipeline-couplings', {
          tool: 'pipeline_couplings_list',
          headers: { Range: rangeHeader(input) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'pipeline_couplings_info',
    {
      title: 'Pipeline coupling info',
      description: 'Return one pipeline coupling by id. Wraps GET /pipeline-couplings/{id}.',
      inputSchema: couplingInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ coupling }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(`/pipeline-couplings/${url(coupling)}`, {
          tool: 'pipeline_couplings_info',
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'pipeline_couplings_by_app',
    {
      title: 'Pipeline coupling by app',
      description:
        'Return the pipeline coupling for a specific app, if any. Wraps GET /apps/{id_or_name}/pipeline-couplings.',
      inputSchema: appInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ app }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(`/apps/${url(app)}/pipeline-couplings`, {
          tool: 'pipeline_couplings_by_app',
        });
        return ok(res);
      }),
  );

  // --------------------------------------------------------------------------
  // Releases / deployments
  // --------------------------------------------------------------------------

  server.registerTool(
    'pipeline_releases_list',
    {
      title: 'Pipeline releases list',
      description:
        'List the latest release across each app in a pipeline. Paginated. Wraps GET /pipelines/{id}/latest-releases.',
      inputSchema: { ...pipelineInput, ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ pipeline, page_size, cursor }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(
          `/pipelines/${url(pipeline)}/latest-releases`,
          {
            tool: 'pipeline_releases_list',
            headers: { Range: rangeHeader({ page_size, cursor }) },
          },
        );
        return ok(res);
      }),
  );

  server.registerTool(
    'pipeline_deployments_list',
    {
      title: 'Pipeline deployments list',
      description:
        'List the latest deployment across each app in a pipeline. Paginated. Wraps GET /pipelines/{id}/latest-deployments.',
      inputSchema: { ...pipelineInput, ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ pipeline, page_size, cursor }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(
          `/pipelines/${url(pipeline)}/latest-deployments`,
          {
            tool: 'pipeline_deployments_list',
            headers: { Range: rangeHeader({ page_size, cursor }) },
          },
        );
        return ok(res);
      }),
  );

  // --------------------------------------------------------------------------
  // Promotions
  // --------------------------------------------------------------------------

  server.registerTool(
    'pipeline_promotions_list',
    {
      title: 'Pipeline promotions list',
      description:
        'List pipeline promotions visible to the caller. Paginated. Wraps GET /pipeline-promotions.',
      inputSchema: { ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>('/pipeline-promotions', {
          tool: 'pipeline_promotions_list',
          headers: { Range: rangeHeader(input) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'pipeline_promotions_info',
    {
      title: 'Pipeline promotion info',
      description: 'Return one pipeline promotion by id. Wraps GET /pipeline-promotions/{id}.',
      inputSchema: promotionInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ promotion }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(`/pipeline-promotions/${url(promotion)}`, {
          tool: 'pipeline_promotions_info',
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'pipeline_promotion_targets_list',
    {
      title: 'Pipeline promotion targets',
      description:
        'List the targets (apps) that received a given pipeline promotion. Paginated. Wraps GET /pipeline-promotions/{id}/promotion-targets.',
      inputSchema: { ...promotionInput, ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ promotion, page_size, cursor }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(
          `/pipeline-promotions/${url(promotion)}/promotion-targets`,
          {
            tool: 'pipeline_promotion_targets_list',
            headers: { Range: rangeHeader({ page_size, cursor }) },
          },
        );
        return ok(res);
      }),
  );

  // --------------------------------------------------------------------------
  // Review-app pipeline config
  // --------------------------------------------------------------------------

  server.registerTool(
    'pipeline_review_app_config_info',
    {
      title: 'Pipeline review-app config',
      description:
        'Return the pipeline-wide review-app configuration (auto-deploy settings, env-var inheritance, etc.). Wraps GET /pipelines/{id_or_name}/review-app-config. Per-review-app operations live in the apps tier.',
      inputSchema: pipelineInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ pipeline }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(
          `/pipelines/${url(pipeline)}/review-app-config`,
          { tool: 'pipeline_review_app_config_info' },
        );
        return ok(res);
      }),
  );
}
