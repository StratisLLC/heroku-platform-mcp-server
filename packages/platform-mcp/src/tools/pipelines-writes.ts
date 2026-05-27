/**
 * Pipelines-tier write tools (TOOLS.md "Tier: `pipelines`", write entries).
 *
 * Tools registered here:
 *   - pipelines_create                  (POST)
 *   - pipelines_update                  (PATCH)
 *   - pipelines_destroy                 (⚠ DELETE; confirm: <pipeline name>)
 *   - pipeline_couplings_create         (POST)
 *   - pipeline_couplings_update         (PATCH)
 *   - pipeline_couplings_destroy        (⚠ DELETE; confirm: <pipeline name>)
 *   - pipelines_promote                 (POST — no confirm per Phase 3 Decision 2)
 *   - pipelines_promote_to_new          (POST — no confirm per Phase 3 Decision 2)
 *   - pipeline_transfer                 (POST)
 *   - pipeline_review_app_config_update (PATCH)
 *   - pipeline_review_apps_enable      (POST)
 *
 * Phase 3 Decision 2: pipeline promotion is NOT marked destructive. Promotion
 * is the normal CI/CD flow; requiring confirm for every promotion would be
 * hostile UX. `dry_run` previews show source app → target app(s) so the user
 * can see what is being promoted.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../context.js';
import type { HerokuRecord } from '../tool-helpers.js';
import { registerWriteTool } from '../write-tool.js';

const url = (s: string): string => encodeURIComponent(s);

const pipelineShape = {
  pipeline: z.string().min(1).describe('Pipeline id or name. Prefer UUID when known.'),
};

const couplingShape = {
  coupling: z.string().min(1).describe('Pipeline-coupling id (UUID).'),
};

/** Register pipelines-tier write tools onto the server. */
export function registerPipelinesWriteTools(server: McpServer, ctx: ToolContext): void {
  // --------------------------------------------------------------------------
  // Pipelines CRUD
  // --------------------------------------------------------------------------

  registerWriteTool<typeof pipelinesCreateShape, HerokuRecord>(server, ctx, {
    name: 'pipelines_create',
    title: 'Create pipeline',
    description: 'Create a new pipeline. Wraps POST /pipelines.',
    inputSchema: pipelinesCreateShape,
    build: (args) => {
      const body: Record<string, unknown> = { name: args.name };
      if (args.owner !== undefined) body.owner = args.owner;
      return { method: 'POST', path: '/pipelines', body };
    },
    describe: (args) => {
      const owner = args.owner ? `, owner=${JSON.stringify(args.owner)}` : '';
      return `Would create pipeline '${args.name}'${owner}.`;
    },
  });

  registerWriteTool<typeof pipelinesUpdateShape, HerokuRecord>(server, ctx, {
    name: 'pipelines_update',
    title: 'Update pipeline',
    description: 'Update a pipeline record (rename). Wraps PATCH /pipelines/{id_or_name}.',
    inputSchema: pipelinesUpdateShape,
    build: (args) => {
      const body: Record<string, unknown> = {};
      if (args.name !== undefined) body.name = args.name;
      return { method: 'PATCH', path: `/pipelines/${url(args.pipeline)}`, body };
    },
    describe: (args) => {
      const updates: string[] = [];
      if (args.name !== undefined) updates.push(`name → ${args.name}`);
      const what = updates.length > 0 ? updates.join(', ') : '(no fields)';
      return `Would update pipeline '${args.pipeline}': ${what}.`;
    },
  });

  registerWriteTool<typeof pipelineShape, HerokuRecord>(server, ctx, {
    name: 'pipelines_destroy',
    title: 'Destroy pipeline',
    description:
      'Destroy a pipeline. Existing apps in the pipeline are NOT destroyed — they remain unaffiliated. Wraps DELETE /pipelines/{id_or_name}. Destructive: pass confirm matching the pipeline name.',
    inputSchema: pipelineShape,
    destructive: {
      targetKind: 'pipeline',
      expectedFromResource: (resource) =>
        typeof resource?.name === 'string' ? resource.name : undefined,
      expectedFromArgs: (args) => args.pipeline,
    },
    preFetch: {
      run: (args) =>
        ctx.client.get<HerokuRecord>(`/pipelines/${url(args.pipeline)}`, {
          tool: 'pipelines_destroy',
        }),
    },
    build: (args) => ({ method: 'DELETE', path: `/pipelines/${url(args.pipeline)}` }),
    describe: (args, fetched) => {
      const created =
        typeof fetched?.created_at === 'string' ? ` (created ${fetched.created_at})` : '';
      return `Would destroy pipeline '${args.pipeline}'${created}. Apps in the pipeline remain unaffiliated; they are NOT destroyed.`;
    },
  });

  // --------------------------------------------------------------------------
  // Couplings
  // --------------------------------------------------------------------------

  registerWriteTool<typeof pipelineCouplingsCreateShape, HerokuRecord>(server, ctx, {
    name: 'pipeline_couplings_create',
    title: 'Create pipeline coupling',
    description:
      'Attach an app to a pipeline at a given stage (review, development, staging, production). Wraps POST /pipeline-couplings.',
    inputSchema: pipelineCouplingsCreateShape,
    build: (args) => ({
      method: 'POST',
      path: '/pipeline-couplings',
      body: { app: args.app, pipeline: args.pipeline, stage: args.stage },
    }),
    describe: (args) =>
      `Would attach app '${args.app}' to pipeline '${args.pipeline}' at stage '${args.stage}'.`,
  });

  registerWriteTool<typeof pipelineCouplingsUpdateShape, HerokuRecord>(server, ctx, {
    name: 'pipeline_couplings_update',
    title: 'Update pipeline coupling',
    description: "Update an app's pipeline-coupling stage. Wraps PATCH /pipeline-couplings/{id}.",
    inputSchema: pipelineCouplingsUpdateShape,
    build: (args) => ({
      method: 'PATCH',
      path: `/pipeline-couplings/${url(args.coupling)}`,
      body: { stage: args.stage },
    }),
    describe: (args) =>
      `Would update pipeline coupling '${args.coupling}' to stage '${args.stage}'.`,
  });

  registerWriteTool<typeof couplingShape, HerokuRecord>(server, ctx, {
    name: 'pipeline_couplings_destroy',
    title: 'Destroy pipeline coupling',
    description:
      "Detach an app from a pipeline. The app itself is NOT destroyed. Wraps DELETE /pipeline-couplings/{id}. Destructive: pass confirm matching the parent pipeline's name — coupling ids are opaque UUIDs that would not capture user intent.",
    inputSchema: couplingShape,
    destructive: {
      targetKind: 'pipeline_coupling',
      expectedFromResource: (resource) => {
        // The coupling response nests pipeline.name; use it as the confirm
        // target so the user types something they recognise.
        const pipeline = resource?.pipeline;
        if (pipeline && typeof pipeline === 'object') {
          const name = (pipeline as { name?: unknown }).name;
          if (typeof name === 'string') return name;
        }
        return undefined;
      },
      expectedFromArgs: (args) => args.coupling,
    },
    preFetch: {
      run: (args) =>
        ctx.client.get<HerokuRecord>(`/pipeline-couplings/${url(args.coupling)}`, {
          tool: 'pipeline_couplings_destroy',
        }),
    },
    build: (args) => ({
      method: 'DELETE',
      path: `/pipeline-couplings/${url(args.coupling)}`,
    }),
    describe: (args, fetched) => {
      const stage = typeof fetched?.stage === 'string' ? ` (stage ${fetched.stage})` : '';
      const app =
        fetched?.app && typeof fetched.app === 'object'
          ? ` (app ${(fetched.app as { name?: string }).name ?? 'unknown'})`
          : '';
      const pipeline =
        fetched?.pipeline && typeof fetched.pipeline === 'object'
          ? ` (pipeline ${(fetched.pipeline as { name?: string }).name ?? 'unknown'})`
          : '';
      return `Would detach pipeline coupling '${args.coupling}'${app}${pipeline}${stage}. The app itself is NOT destroyed.`;
    },
  });

  // --------------------------------------------------------------------------
  // Promotions (Phase 3 Decision 2 — not destructive)
  // --------------------------------------------------------------------------

  registerWriteTool<typeof pipelinesPromoteShape, HerokuRecord>(server, ctx, {
    name: 'pipelines_promote',
    title: 'Promote pipeline (source → existing targets)',
    description:
      'Promote a release from the source app to one or more existing target apps in the same pipeline. This is the standard CI/CD operation; no confirm is required per Phase 3 Decision 2 (the dry_run preview shows source → target(s)). Wraps POST /pipeline-promotions.',
    inputSchema: pipelinesPromoteShape,
    build: (args) => ({
      method: 'POST',
      path: '/pipeline-promotions',
      body: {
        pipeline: { id: args.pipeline },
        source: { app: { id: args.source } },
        targets: args.targets.map((t) => ({ app: { id: t } })),
      },
    }),
    describe: (args) =>
      `Would promote source app '${args.source}' to target app(s) [${args.targets.join(', ')}] in pipeline '${args.pipeline}'.`,
  });

  registerWriteTool<typeof pipelinesPromoteToNewShape, HerokuRecord>(server, ctx, {
    name: 'pipelines_promote_to_new',
    title: 'Promote pipeline (source → new app)',
    description:
      'Promote a release from the source app to a NEW app created at the given downstream stage. Wraps POST /pipeline-promotions with a target descriptor that creates the app. No confirm required (Phase 3 Decision 2).',
    inputSchema: pipelinesPromoteToNewShape,
    build: (args) => ({
      method: 'POST',
      path: '/pipeline-promotions',
      body: {
        pipeline: { id: args.pipeline },
        source: { app: { id: args.source } },
        targets: [
          {
            app: { name: args.new_app_name },
            stage: args.new_app_stage,
          },
        ],
      },
    }),
    describe: (args) =>
      `Would promote source app '${args.source}' to a NEW app '${args.new_app_name}' (created at stage '${args.new_app_stage}') in pipeline '${args.pipeline}'.`,
  });

  // --------------------------------------------------------------------------
  // Pipeline transfer
  // --------------------------------------------------------------------------

  registerWriteTool<typeof pipelineTransferShape, HerokuRecord>(server, ctx, {
    name: 'pipeline_transfer',
    title: 'Transfer pipeline ownership',
    description:
      'Transfer ownership of a pipeline to a different team or user. Wraps POST /pipeline-transfers. The recipient must accept the transfer separately.',
    inputSchema: pipelineTransferShape,
    build: (args) => ({
      method: 'POST',
      path: '/pipeline-transfers',
      body: {
        pipeline: { id: args.pipeline },
        new_owner: { id: args.new_owner, type: args.new_owner_type },
      },
    }),
    describe: (args) =>
      `Would transfer pipeline '${args.pipeline}' to ${args.new_owner_type} '${args.new_owner}'. The recipient must accept the transfer separately.`,
  });

  // --------------------------------------------------------------------------
  // Review-app pipeline config
  // --------------------------------------------------------------------------

  registerWriteTool<typeof reviewAppConfigUpdateShape, HerokuRecord>(server, ctx, {
    name: 'pipeline_review_app_config_update',
    title: 'Update review-app pipeline config',
    description:
      'Update the pipeline-wide review-app configuration. Wraps PATCH /pipelines/{id_or_name}/review-app-config. To create the initial config or wholesale replace it, use `pipeline_review_apps_enable`.',
    inputSchema: reviewAppConfigUpdateShape,
    build: (args) => {
      const body: Record<string, unknown> = {};
      if (args.automatic_review_apps !== undefined) {
        body.automatic_review_apps = args.automatic_review_apps;
      }
      if (args.destroy_stale_apps !== undefined) body.destroy_stale_apps = args.destroy_stale_apps;
      if (args.stale_days !== undefined) body.stale_days = args.stale_days;
      if (args.deploy_target !== undefined) body.deploy_target = args.deploy_target;
      if (args.wait_for_ci !== undefined) body.wait_for_ci = args.wait_for_ci;
      if (args.base_name !== undefined) body.base_name = args.base_name;
      return {
        method: 'PATCH',
        path: `/pipelines/${url(args.pipeline)}/review-app-config`,
        body,
      };
    },
    describe: (args) => {
      const bits: string[] = [];
      if (args.automatic_review_apps !== undefined)
        bits.push(`automatic_review_apps=${args.automatic_review_apps}`);
      if (args.destroy_stale_apps !== undefined)
        bits.push(`destroy_stale_apps=${args.destroy_stale_apps}`);
      if (args.stale_days !== undefined) bits.push(`stale_days=${args.stale_days}`);
      if (args.deploy_target !== undefined)
        bits.push(`deploy_target=${JSON.stringify(args.deploy_target)}`);
      if (args.wait_for_ci !== undefined) bits.push(`wait_for_ci=${args.wait_for_ci}`);
      if (args.base_name !== undefined) bits.push(`base_name=${args.base_name}`);
      return `Would update review-app config for pipeline '${args.pipeline}': ${bits.length > 0 ? bits.join(', ') : '(no fields)'}.`;
    },
  });

  registerWriteTool<typeof reviewAppsEnableShape, HerokuRecord>(server, ctx, {
    name: 'pipeline_review_apps_enable',
    title: 'Enable review apps on pipeline',
    description:
      'Enable the review-app workflow on a pipeline (creates the initial review-app config if absent). Wraps POST /pipelines/{id_or_name}/review-app-config.',
    inputSchema: reviewAppsEnableShape,
    build: (args) => {
      const body: Record<string, unknown> = { repo: args.repo };
      if (args.automatic_review_apps !== undefined) {
        body.automatic_review_apps = args.automatic_review_apps;
      }
      if (args.destroy_stale_apps !== undefined) body.destroy_stale_apps = args.destroy_stale_apps;
      if (args.stale_days !== undefined) body.stale_days = args.stale_days;
      if (args.deploy_target !== undefined) body.deploy_target = args.deploy_target;
      if (args.wait_for_ci !== undefined) body.wait_for_ci = args.wait_for_ci;
      if (args.base_name !== undefined) body.base_name = args.base_name;
      return {
        method: 'POST',
        path: `/pipelines/${url(args.pipeline)}/review-app-config`,
        body,
      };
    },
    describe: (args) =>
      `Would enable review apps on pipeline '${args.pipeline}' (repo=${args.repo}, automatic=${args.automatic_review_apps ?? '(default)'}, destroy_stale=${args.destroy_stale_apps ?? '(default)'}).`,
  });
}

// ---- Schemas ----

const pipelinesCreateShape = {
  name: z.string().min(1).describe('Pipeline name. Must be unique on the account.'),
  owner: z
    .object({
      id: z.string().min(1).describe('Owner id (user or team UUID).'),
      type: z.enum(['user', 'team']).describe('Owner type — usually `team` for shared pipelines.'),
    })
    .optional()
    .describe('Optional owner descriptor; defaults to the authenticated user.'),
};

const pipelinesUpdateShape = {
  ...pipelineShape,
  name: z.string().min(1).optional().describe('New pipeline name.'),
};

const pipelineStage = z
  .enum(['review', 'development', 'staging', 'production'])
  .describe('Pipeline stage: review, development, staging, or production.');

const pipelineCouplingsCreateShape = {
  app: z.string().min(1).describe('App id or name to attach.'),
  pipeline: z.string().min(1).describe('Pipeline id or name to attach to.'),
  stage: pipelineStage,
};

const pipelineCouplingsUpdateShape = {
  ...couplingShape,
  stage: pipelineStage,
};

const pipelinesPromoteShape = {
  pipeline: z.string().min(1).describe('Pipeline id (UUID).'),
  source: z.string().min(1).describe('Source app id to promote from.'),
  targets: z
    .array(z.string().min(1))
    .min(1)
    .describe('List of target app ids in the same pipeline to promote to.'),
};

const pipelinesPromoteToNewShape = {
  pipeline: z.string().min(1).describe('Pipeline id (UUID).'),
  source: z.string().min(1).describe('Source app id to promote from.'),
  new_app_name: z
    .string()
    .min(1)
    .describe('Name for the new app to create as the promotion target.'),
  new_app_stage: pipelineStage,
};

const pipelineTransferShape = {
  pipeline: z.string().min(1).describe('Pipeline id (UUID).'),
  new_owner: z.string().min(1).describe('Recipient id (user or team UUID).'),
  new_owner_type: z.enum(['user', 'team']).describe('Recipient kind: user or team.'),
};

const reviewAppConfigUpdateShape = {
  ...pipelineShape,
  automatic_review_apps: z
    .boolean()
    .optional()
    .describe('When true, Heroku creates a review app for each pull request.'),
  destroy_stale_apps: z
    .boolean()
    .optional()
    .describe('When true, Heroku destroys idle review apps after `stale_days`.'),
  stale_days: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Idle period after which a review app is destroyed (1-30 days).'),
  deploy_target: z
    .object({
      id: z.string().min(1).describe('Deploy target id (e.g. a region or space name).'),
      type: z.string().min(1).describe('Deploy target type (e.g. "region" or "space").'),
    })
    .optional()
    .describe('Optional deploy target for the review apps.'),
  wait_for_ci: z
    .boolean()
    .optional()
    .describe('When true, only deploy a review app after CI status passes.'),
  base_name: z
    .string()
    .min(1)
    .optional()
    .describe('Base name for generated review apps (Heroku appends the PR number).'),
};

const reviewAppsEnableShape = {
  ...pipelineShape,
  repo: z.string().min(1).describe('GitHub repository in `owner/repo` form.'),
  automatic_review_apps: z
    .boolean()
    .optional()
    .describe('When true, Heroku creates a review app for each pull request.'),
  destroy_stale_apps: z
    .boolean()
    .optional()
    .describe('When true, Heroku destroys idle review apps after `stale_days`.'),
  stale_days: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Idle period after which a review app is destroyed (1-30 days).'),
  deploy_target: z
    .object({
      id: z.string().min(1).describe('Deploy target id.'),
      type: z.string().min(1).describe('Deploy target type.'),
    })
    .optional()
    .describe('Optional deploy target.'),
  wait_for_ci: z.boolean().optional().describe('Only deploy review apps after CI passes.'),
  base_name: z.string().min(1).optional().describe('Base name for generated review apps.'),
};
