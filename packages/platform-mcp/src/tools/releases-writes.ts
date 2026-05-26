/**
 * Apps-tier write tools — releases, builds, slugs, OCI images, sources.
 *
 * Tools registered here:
 *   - releases_create               (POST)
 *   - releases_rollback             (⚠ POST; confirm: <app name>)
 *   - builds_create                 (POST)
 *   - builds_delete_cache           (⚠ DELETE; confirm: <app name>)
 *   - buildpack_installations_update (PUT)
 *   - slugs_create                  (POST)
 *   - oci_image_create              (POST)
 *   - source_create                 (POST — no app, no confirm)
 *
 * `releases_rollback` confirms on the app name (NOT the version) because the
 * rollback affects the live app, per Phase 2a Decision.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../context.js';
import type { HerokuRecord } from '../tool-helpers.js';
import { registerWriteTool } from '../write-tool.js';

const url = (s: string): string => encodeURIComponent(s);

const appInput = {
  app: z.string().min(1).describe('App id or name. Prefer UUID when known.'),
};

const releasesCreateShape = {
  ...appInput,
  slug: z.string().min(1).describe('Slug id to release.'),
  description: z.string().optional().describe('Human-readable description of the release.'),
};

const releasesRollbackShape = {
  ...appInput,
  release: z
    .string()
    .min(1)
    .describe('Version (e.g. "v42") or id of the prior release to roll back to.'),
};

const buildsCreateShape = {
  ...appInput,
  source_blob: z
    .object({
      url: z.string().url().describe('HTTPS URL to the tarball Heroku will fetch.'),
      version: z.string().optional().describe('Commit SHA or version string to record.'),
      checksum: z.string().optional().describe('Optional SHA-256 checksum of the source blob.'),
    })
    .describe('Pointer to the source the builder should fetch.'),
  buildpacks: z
    .array(z.object({ url: z.string().url(), name: z.string().optional() }))
    .optional()
    .describe('Buildpacks to apply, in order.'),
};

const buildpackUpdatesShape = {
  ...appInput,
  updates: z
    .array(
      z.object({
        buildpack: z
          .string()
          .min(1)
          .describe('Buildpack url, shorthand (e.g. "heroku/ruby"), or id.'),
      }),
    )
    .min(1)
    .describe('Ordered list of buildpacks. Replaces the current set entirely — PUT semantics.'),
};

const slugsCreateShape = {
  ...appInput,
  process_types: z
    .record(z.string(), z.string())
    .describe('Map of process type → command (e.g. {"web": "bin/server"}).'),
  checksum: z.string().optional().describe('SHA-256 checksum of the slug tarball.'),
  commit: z.string().optional().describe('Commit SHA the slug was built from.'),
  commit_description: z.string().optional().describe('Optional commit description.'),
  stack: z.string().min(1).optional().describe('Stack name or id the slug runs on.'),
  buildpack_provided_description: z
    .string()
    .optional()
    .describe('Description recorded by the buildpack.'),
};

const ociImageCreateShape = {
  ...appInput,
  image: z
    .object({
      digest: z.string().min(1).describe('OCI image digest (e.g. "sha256:..." form).'),
      process_type: z.string().min(1).optional().describe('Process type the image runs.'),
    })
    .passthrough()
    .describe('OCI image descriptor. Pass-through — extra fields are forwarded verbatim.'),
};

const sourceCreateShape = {} as const;

export function registerReleasesWriteTools(server: McpServer, ctx: ToolContext): void {
  registerWriteTool<typeof releasesCreateShape, HerokuRecord>(server, ctx, {
    name: 'releases_create',
    title: 'Create release',
    description:
      'Create a new release from an existing slug. Wraps POST /apps/{id_or_name}/releases.',
    inputSchema: releasesCreateShape,
    build: (args) => {
      const body: Record<string, unknown> = { slug: args.slug };
      if (args.description !== undefined) body.description = args.description;
      return { method: 'POST', path: `/apps/${url(args.app)}/releases`, body };
    },
    describe: (args) =>
      `Would create a release on app '${args.app}' from slug '${args.slug}'${args.description ? ` (${args.description})` : ''}.`,
  });

  registerWriteTool<typeof releasesRollbackShape, HerokuRecord>(server, ctx, {
    name: 'releases_rollback',
    title: 'Rollback release',
    description:
      'Roll the app back to a prior release version. Wraps POST /apps/{id_or_name}/releases with the prior release id. Destructive: pass confirm matching the app name (not the version), because the rollback affects the live app.',
    inputSchema: releasesRollbackShape,
    destructive: { targetKind: 'app', expectedFrom: (args) => args.app },
    build: (args) => ({
      method: 'POST',
      path: `/apps/${url(args.app)}/releases`,
      body: { release: args.release },
    }),
    describe: (args) =>
      `Would roll app '${args.app}' back to release '${args.release}'. The current code/config snapshot will be replaced; the prior release stays accessible in history.`,
  });

  registerWriteTool<typeof buildsCreateShape, HerokuRecord>(server, ctx, {
    name: 'builds_create',
    title: 'Create build',
    description: 'Start a build from a source tarball. Wraps POST /apps/{id_or_name}/builds.',
    inputSchema: buildsCreateShape,
    build: (args) => {
      const body: Record<string, unknown> = { source_blob: args.source_blob };
      if (args.buildpacks !== undefined) body.buildpacks = args.buildpacks;
      return { method: 'POST', path: `/apps/${url(args.app)}/builds`, body };
    },
    describe: (args) =>
      `Would start a build on app '${args.app}' from source ${args.source_blob.url}.`,
  });

  registerWriteTool<typeof appInput, HerokuRecord>(server, ctx, {
    name: 'builds_delete_cache',
    title: 'Delete build cache',
    description:
      'Purge the buildpack cache for an app. Next deploy will rebuild from scratch. Wraps DELETE /apps/{id_or_name}/build-cache. Destructive: pass confirm matching the app name.',
    inputSchema: appInput,
    destructive: { targetKind: 'app', expectedFrom: (args) => args.app },
    build: (args) => ({ method: 'DELETE', path: `/apps/${url(args.app)}/build-cache` }),
    describe: (args) =>
      `Would purge the buildpack cache for app '${args.app}'. The next build will be slower because dependencies must be re-fetched.`,
  });

  registerWriteTool<typeof buildpackUpdatesShape, HerokuRecord>(server, ctx, {
    name: 'buildpack_installations_update',
    title: 'Buildpack installations update',
    description:
      "Replace the app's buildpacks. PUT semantics — the provided list overwrites the current set entirely. Wraps PUT /apps/{id_or_name}/buildpack-installations.",
    inputSchema: buildpackUpdatesShape,
    build: (args) => ({
      method: 'PUT',
      path: `/apps/${url(args.app)}/buildpack-installations`,
      body: { updates: args.updates },
    }),
    describe: (args) =>
      `Would replace buildpacks on app '${args.app}' with: ${args.updates
        .map((u) => u.buildpack)
        .join(', ')}.`,
  });

  registerWriteTool<typeof slugsCreateShape, HerokuRecord>(server, ctx, {
    name: 'slugs_create',
    title: 'Create slug',
    description:
      'Create a slug record on an app. Returns the slug + a temporary upload URL. Wraps POST /apps/{id_or_name}/slugs.',
    inputSchema: slugsCreateShape,
    build: (args) => {
      const body: Record<string, unknown> = { process_types: args.process_types };
      if (args.checksum !== undefined) body.checksum = args.checksum;
      if (args.commit !== undefined) body.commit = args.commit;
      if (args.commit_description !== undefined) body.commit_description = args.commit_description;
      if (args.stack !== undefined) body.stack = args.stack;
      if (args.buildpack_provided_description !== undefined)
        body.buildpack_provided_description = args.buildpack_provided_description;
      return { method: 'POST', path: `/apps/${url(args.app)}/slugs`, body };
    },
    describe: (args) => {
      const types = Object.keys(args.process_types).join(', ');
      return `Would create a slug on app '${args.app}' with process types: ${types || '(none)'}.`;
    },
  });

  registerWriteTool<typeof ociImageCreateShape, HerokuRecord>(server, ctx, {
    name: 'oci_image_create',
    title: 'Create OCI image record',
    description: 'Register an OCI image on an app. Wraps POST /apps/{id_or_name}/oci-images.',
    inputSchema: ociImageCreateShape,
    build: (args) => ({
      method: 'POST',
      path: `/apps/${url(args.app)}/oci-images`,
      body: args.image,
    }),
    describe: (args) =>
      `Would register OCI image (digest ${args.image.digest}) on app '${args.app}'.`,
  });

  registerWriteTool<typeof sourceCreateShape, HerokuRecord>(server, ctx, {
    name: 'source_create',
    title: 'Create source upload URL',
    description:
      'Allocate a one-time source upload URL. Wraps POST /sources. No app required; the response carries get_url and put_url for the caller to use.',
    inputSchema: sourceCreateShape,
    build: () => ({ method: 'POST', path: '/sources', body: null }),
    describe: () =>
      'Would allocate a one-time source upload location at /sources. The response contains put_url (PUT a tarball there) and get_url (pass into builds_create.source_blob.url).',
  });
}
