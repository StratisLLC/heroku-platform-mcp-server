/**
 * Apps-tier write tools — review apps, review-app config, and app setups.
 *
 * Tools registered here:
 *   - review_apps_create        (POST)
 *   - review_apps_delete        (⚠ DELETE; confirm: <review app id>)
 *   - review_apps_config_create (POST)
 *   - review_apps_config_update (PATCH)
 *   - review_apps_config_delete (⚠ DELETE; confirm: <pipeline name>)
 *   - app_setups_create         (POST)
 *
 * Review-app endpoints sit under the apps tier because they require app-level
 * access on the parent pipeline. Pipelines as a top-level tier lands in a
 * later phase.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../context.js';
import type { HerokuRecord } from '../tool-helpers.js';
import { registerWriteTool } from '../write-tool.js';

const url = (s: string): string => encodeURIComponent(s);

const reviewAppsCreateShape = {
  branch: z.string().min(1).describe('Source branch the review app is built from.'),
  pipeline: z.string().min(1).describe('Pipeline id (UUID) the review app attaches to.'),
  source_blob: z
    .object({
      url: z.string().url().describe('HTTPS URL to the source tarball.'),
      version: z.string().optional().describe('Commit SHA or version.'),
    })
    .describe('Source the review app is built from.'),
  fork_repo_id: z.number().int().optional().describe('GitHub repository id (numeric).'),
  pr_number: z.number().int().optional().describe('Pull request number that triggered this app.'),
  environment: z
    .record(z.string(), z.string())
    .optional()
    .describe('Extra environment variables to merge into the review app.'),
};

const reviewAppsDeleteShape = {
  review_app: z.string().min(1).describe('Review app id (UUID).'),
};

const reviewAppsConfigCreateShape = {
  pipeline: z.string().min(1).describe('Pipeline id or name.'),
  repo: z.string().min(1).describe('GitHub "owner/repo" identifier.'),
  automatic_review_apps: z
    .boolean()
    .optional()
    .describe('When true, automatically open a review app for every PR.'),
  destroy_stale_apps: z
    .boolean()
    .optional()
    .describe('When true, destroy review apps after the PR closes.'),
  stale_days: z.number().int().min(1).max(30).optional().describe('Days before destruction.'),
  base_name: z.string().min(1).optional().describe('Prefix for generated app names.'),
  deploy_target: z
    .object({ id: z.string().min(1), type: z.string().min(1) })
    .optional()
    .describe('Target space or region for review apps.'),
};

const reviewAppsConfigUpdateShape = {
  pipeline: z.string().min(1).describe('Pipeline id or name.'),
  automatic_review_apps: z.boolean().optional(),
  destroy_stale_apps: z.boolean().optional(),
  stale_days: z.number().int().min(1).max(30).optional(),
  base_name: z.string().min(1).optional(),
  deploy_target: z.object({ id: z.string().min(1), type: z.string().min(1) }).optional(),
};

const reviewAppsConfigDeleteShape = {
  pipeline: z.string().min(1).describe('Pipeline id or name.'),
};

const appSetupsCreateShape = {
  source_blob: z
    .object({
      url: z.string().url().describe('HTTPS URL to the source tarball.'),
      checksum: z.string().optional(),
      version: z.string().optional(),
    })
    .describe('Source to install from.'),
  app: z
    .object({
      name: z.string().min(1).optional(),
      region: z.string().min(1).optional(),
      stack: z.string().min(1).optional(),
      organization: z.string().min(1).optional(),
      personal: z.boolean().optional(),
      space: z.string().min(1).optional(),
      locked: z.boolean().optional(),
    })
    .optional()
    .describe('Optional overrides for the created app.'),
  overrides: z
    .object({
      buildpacks: z
        .array(z.object({ url: z.string().url() }))
        .optional()
        .describe('Override the buildpack list from app.json.'),
      env: z.record(z.string(), z.string()).optional().describe('Override env from app.json.'),
    })
    .optional()
    .describe('Overrides applied on top of the source app.json.'),
};

export function registerReviewAppsWriteTools(server: McpServer, ctx: ToolContext): void {
  registerWriteTool<typeof reviewAppsCreateShape, HerokuRecord>(server, ctx, {
    name: 'review_apps_create',
    title: 'Create review app',
    description: 'Open a review app for a branch on a pipeline. Wraps POST /review-apps.',
    inputSchema: reviewAppsCreateShape,
    build: (args) => {
      const body: Record<string, unknown> = {
        branch: args.branch,
        pipeline: args.pipeline,
        source_blob: args.source_blob,
      };
      if (args.fork_repo_id !== undefined) body.fork_repo_id = args.fork_repo_id;
      if (args.pr_number !== undefined) body.pr_number = args.pr_number;
      if (args.environment !== undefined) body.environment = args.environment;
      return { method: 'POST', path: '/review-apps', body };
    },
    describe: (args) =>
      `Would open a review app on pipeline '${args.pipeline}' for branch '${args.branch}'.`,
  });

  registerWriteTool<typeof reviewAppsDeleteShape, HerokuRecord>(server, ctx, {
    name: 'review_apps_delete',
    title: 'Delete review app',
    description:
      'Delete a review app. Wraps DELETE /review-apps/{id}. Destructive: pass confirm matching the review app id.',
    inputSchema: reviewAppsDeleteShape,
    destructive: { targetKind: 'review_app', expectedFrom: (args) => args.review_app },
    preFetch: {
      run: (args) =>
        ctx.client.get<HerokuRecord>(`/review-apps/${url(args.review_app)}`, {
          tool: 'review_apps_delete',
        }),
    },
    build: (args) => ({ method: 'DELETE', path: `/review-apps/${url(args.review_app)}` }),
    describe: (args, fetched) => {
      const branch = typeof fetched?.branch === 'string' ? ` (branch ${fetched.branch})` : '';
      return `Would delete review app '${args.review_app}'${branch}. The underlying Heroku app is destroyed.`;
    },
  });

  registerWriteTool<typeof reviewAppsConfigCreateShape, HerokuRecord>(server, ctx, {
    name: 'review_apps_config_create',
    title: 'Create review-app config',
    description:
      'Enable review apps on a pipeline by attaching a config. Wraps POST /pipelines/{id_or_name}/review-app-config.',
    inputSchema: reviewAppsConfigCreateShape,
    build: (args) => {
      const body: Record<string, unknown> = { repo: args.repo };
      if (args.automatic_review_apps !== undefined)
        body.automatic_review_apps = args.automatic_review_apps;
      if (args.destroy_stale_apps !== undefined) body.destroy_stale_apps = args.destroy_stale_apps;
      if (args.stale_days !== undefined) body.stale_days = args.stale_days;
      if (args.base_name !== undefined) body.base_name = args.base_name;
      if (args.deploy_target !== undefined) body.deploy_target = args.deploy_target;
      return {
        method: 'POST',
        path: `/pipelines/${url(args.pipeline)}/review-app-config`,
        body,
      };
    },
    describe: (args) =>
      `Would enable review apps on pipeline '${args.pipeline}' (repo ${args.repo}).`,
  });

  registerWriteTool<typeof reviewAppsConfigUpdateShape, HerokuRecord>(server, ctx, {
    name: 'review_apps_config_update',
    title: 'Update review-app config',
    description:
      'Update the review-app config on a pipeline. Wraps PATCH /pipelines/{id_or_name}/review-app-config.',
    inputSchema: reviewAppsConfigUpdateShape,
    build: (args) => {
      const body: Record<string, unknown> = {};
      if (args.automatic_review_apps !== undefined)
        body.automatic_review_apps = args.automatic_review_apps;
      if (args.destroy_stale_apps !== undefined) body.destroy_stale_apps = args.destroy_stale_apps;
      if (args.stale_days !== undefined) body.stale_days = args.stale_days;
      if (args.base_name !== undefined) body.base_name = args.base_name;
      if (args.deploy_target !== undefined) body.deploy_target = args.deploy_target;
      return {
        method: 'PATCH',
        path: `/pipelines/${url(args.pipeline)}/review-app-config`,
        body,
      };
    },
    describe: (args) => `Would update review-app config on pipeline '${args.pipeline}'.`,
  });

  registerWriteTool<typeof reviewAppsConfigDeleteShape, HerokuRecord>(server, ctx, {
    name: 'review_apps_config_delete',
    title: 'Disable review apps',
    description:
      'Disable review apps on a pipeline. Wraps DELETE /pipelines/{id_or_name}/review-app-config. Destructive: pass confirm matching the pipeline name.',
    inputSchema: reviewAppsConfigDeleteShape,
    destructive: { targetKind: 'pipeline', expectedFrom: (args) => args.pipeline },
    build: (args) => ({
      method: 'DELETE',
      path: `/pipelines/${url(args.pipeline)}/review-app-config`,
    }),
    describe: (args) =>
      `Would disable review apps on pipeline '${args.pipeline}'. Existing review apps remain until manually deleted.`,
  });

  registerWriteTool<typeof appSetupsCreateShape, HerokuRecord>(server, ctx, {
    name: 'app_setups_create',
    title: 'Create app setup',
    description: 'Provision an app from a source tarball + app.json. Wraps POST /app-setups.',
    inputSchema: appSetupsCreateShape,
    build: (args) => {
      const body: Record<string, unknown> = { source_blob: args.source_blob };
      if (args.app !== undefined) body.app = args.app;
      if (args.overrides !== undefined) body.overrides = args.overrides;
      return { method: 'POST', path: '/app-setups', body };
    },
    describe: (args) =>
      `Would create an app setup from source ${args.source_blob.url}${
        args.app?.name ? ` (app name '${args.app.name}')` : ''
      }.`,
  });
}
