/**
 * Add-ons tier read-only tools (TOOLS.md "Tier: `addons_consumer`", read entries).
 *
 * Exposed when the `addons_consumer` probe (`addons.list`) succeeded. Some
 * endpoints (services, plans, region capabilities) are technically catalog
 * endpoints that work even for tokens without provisioned add-ons; we still
 * gate them under this tier so the tool surface stays coherent.
 *
 * Every list-style tool MUST go through the @heroku-mcp/core pagination
 * helper. Per-add-on detail endpoints (info, config, sso) are unpaginated by
 * Heroku.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, paginationInputShape, rangeHeader, runTool } from '../tool-helpers.js';
import type { HerokuList, HerokuRecord } from '../tool-helpers.js';
import type { ToolContext } from '../context.js';

const url = (s: string): string => encodeURIComponent(s);

const addonInput = {
  addon: z.string().min(1).describe('Add-on id or name. Prefer UUID when known.'),
};

const serviceInput = {
  service: z.string().min(1).describe('Add-on service id or name (e.g. "heroku-postgresql").'),
};

const planInput = {
  ...serviceInput,
  plan: z.string().min(1).describe('Plan id or name (e.g. "heroku-postgresql:standard-0").'),
};

const attachmentInput = {
  attachment: z.string().min(1).describe('Add-on attachment id. Prefer UUID when known.'),
};

const addonAndWebhookInput = {
  ...addonInput,
  webhook: z.string().min(1).describe('Add-on webhook id (UUID).'),
};

/** Register read-only add-ons-tier tools onto the server. */
export function registerAddonsTools(server: McpServer, ctx: ToolContext): void {
  // --------------------------------------------------------------------------
  // Add-ons
  // --------------------------------------------------------------------------

  server.registerTool(
    'addons_list',
    {
      title: 'Add-ons list',
      description:
        'List all add-ons the authenticated user has access to (across apps). Paginated. Wraps GET /addons.',
      inputSchema: { ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>('/addons', {
          tool: 'addons_list',
          headers: { Range: rangeHeader(input) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'addons_info',
    {
      title: 'Add-on info',
      description:
        'Return one add-on by id or name. The add-on name has the form `<service>-<region>-<digits>` (e.g. `flying-mountain-12345`). Wraps GET /addons/{id_or_name}.',
      inputSchema: addonInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ addon }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(`/addons/${url(addon)}`, {
          tool: 'addons_info',
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'addons_resolve',
    {
      title: 'Resolve add-on',
      description:
        'Resolve an add-on by name across all apps the user has access to. Wraps POST /actions/addons/resolve. Semantically a read: the body is a search filter, not a mutation. Useful when the user knows the add-on name (e.g. "heroku-postgresql-pinkish-5310") but not which app it is attached to.',
      inputSchema: addonResolveInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ addon, app, addon_service }) =>
      runTool(async () => {
        const body: Record<string, unknown> = { addon };
        if (app !== undefined) body.app = app;
        if (addon_service !== undefined) body.addon_service = addon_service;
        const res = await ctx.client.request<HerokuList>({
          path: '/actions/addons/resolve',
          method: 'POST',
          tool: 'addons_resolve',
          body,
        });
        return ok(res);
      }),
  );

  // --------------------------------------------------------------------------
  // Add-on services & plans (catalog)
  // --------------------------------------------------------------------------

  server.registerTool(
    'addon_services_list',
    {
      title: 'Add-on services list',
      description:
        'List add-on services available in the Heroku Elements marketplace. Paginated. Wraps GET /addon-services.',
      inputSchema: { ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>('/addon-services', {
          tool: 'addon_services_list',
          headers: { Range: rangeHeader(input) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'addon_services_info',
    {
      title: 'Add-on service info',
      description:
        'Return one add-on service by id or name. Wraps GET /addon-services/{id_or_name}.',
      inputSchema: serviceInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ service }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(`/addon-services/${url(service)}`, {
          tool: 'addon_services_info',
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'addon_regions_list',
    {
      title: 'Add-on region capabilities',
      description:
        'List the regions and capabilities for an add-on service. Wraps GET /addon-services/{id_or_name}/region-capabilities.',
      inputSchema: serviceInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ service }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(
          `/addon-services/${url(service)}/region-capabilities`,
          { tool: 'addon_regions_list' },
        );
        return ok(res);
      }),
  );

  server.registerTool(
    'addon_plans_list',
    {
      title: 'Add-on plans list',
      description:
        'List the plans offered by an add-on service. Paginated. Wraps GET /addon-services/{id_or_name}/plans.',
      inputSchema: { ...serviceInput, ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ service, page_size, cursor }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(`/addon-services/${url(service)}/plans`, {
          tool: 'addon_plans_list',
          headers: { Range: rangeHeader({ page_size, cursor }) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'addon_plans_info',
    {
      title: 'Add-on plan info',
      description:
        'Return one plan record. Wraps GET /addon-services/{service}/plans/{id_or_name}.',
      inputSchema: planInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ service, plan }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(
          `/addon-services/${url(service)}/plans/${url(plan)}`,
          { tool: 'addon_plans_info' },
        );
        return ok(res);
      }),
  );

  // --------------------------------------------------------------------------
  // Attachments
  // --------------------------------------------------------------------------

  server.registerTool(
    'addon_attachments_list',
    {
      title: 'Add-on attachments list',
      description:
        'List all add-on attachments visible to the caller. Paginated. Wraps GET /addon-attachments.',
      inputSchema: { ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>('/addon-attachments', {
          tool: 'addon_attachments_list',
          headers: { Range: rangeHeader(input) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'addon_attachments_info',
    {
      title: 'Add-on attachment info',
      description: 'Return one add-on attachment by id. Wraps GET /addon-attachments/{id}.',
      inputSchema: attachmentInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ attachment }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(`/addon-attachments/${url(attachment)}`, {
          tool: 'addon_attachments_info',
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'addon_attachments_resolve',
    {
      title: 'Resolve add-on attachment',
      description:
        'Resolve an add-on attachment by name across apps. Wraps POST /actions/addon-attachments/resolve. Semantically a read.',
      inputSchema: addonAttachmentsResolveInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ addon_attachment, app, addon_service }) =>
      runTool(async () => {
        const body: Record<string, unknown> = { addon_attachment };
        if (app !== undefined) body.app = app;
        if (addon_service !== undefined) body.addon_service = addon_service;
        const res = await ctx.client.request<HerokuList>({
          path: '/actions/addon-attachments/resolve',
          method: 'POST',
          tool: 'addon_attachments_resolve',
          body,
        });
        return ok(res);
      }),
  );

  // --------------------------------------------------------------------------
  // Config / actions
  // --------------------------------------------------------------------------

  server.registerTool(
    'addon_config_get',
    {
      title: 'Add-on config',
      description:
        'Return the configuration the add-on service has set on the parent app via Heroku. Cleartext values; not redacted. Wraps GET /addons/{id_or_name}/config.',
      inputSchema: addonInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ addon }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(`/addons/${url(addon)}/config`, {
          tool: 'addon_config_get',
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'addon_actions_list',
    {
      title: 'Add-on actions list',
      description:
        'List the custom actions published by an add-on service. Not every service publishes actions; an empty list (or 404) is normal. Wraps GET /addon-services/{id_or_name}/actions.',
      inputSchema: serviceInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ service }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(`/addon-services/${url(service)}/actions`, {
          tool: 'addon_actions_list',
        });
        return ok(res);
      }),
  );

  // --------------------------------------------------------------------------
  // Webhooks (reads)
  // --------------------------------------------------------------------------

  server.registerTool(
    'addon_webhooks_list',
    {
      title: 'Add-on webhooks list',
      description:
        'List webhook subscriptions on an add-on. Paginated. Wraps GET /addons/{id_or_name}/webhooks.',
      inputSchema: { ...addonInput, ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ addon, page_size, cursor }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(`/addons/${url(addon)}/webhooks`, {
          tool: 'addon_webhooks_list',
          headers: { Range: rangeHeader({ page_size, cursor }) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'addon_webhooks_info',
    {
      title: 'Add-on webhook info',
      description: 'Return one add-on webhook by id. Wraps GET /addons/{id_or_name}/webhooks/{id}.',
      inputSchema: addonAndWebhookInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ addon, webhook }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(
          `/addons/${url(addon)}/webhooks/${url(webhook)}`,
          { tool: 'addon_webhooks_info' },
        );
        return ok(res);
      }),
  );

  // --------------------------------------------------------------------------
  // SSO token (POST but read-semantics — exchange a token, no state change)
  // --------------------------------------------------------------------------

  server.registerTool(
    'sso_token_for_addon',
    {
      title: 'Single-sign-on token for add-on',
      description:
        "Generate a one-time SSO URL the user can open in a browser to authenticate against the add-on partner's dashboard. Wraps POST /addons/{id_or_name}/sso. Marked read-style despite the POST verb — no Heroku-side state changes.",
      inputSchema: addonInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ addon }) =>
      runTool(async () => {
        const res = await ctx.client.request<HerokuRecord>({
          path: `/addons/${url(addon)}/sso`,
          method: 'POST',
          tool: 'sso_token_for_addon',
          body: null,
        });
        return ok(res);
      }),
  );
}

// ---- Schemas ----

const addonResolveInput = {
  addon: z
    .string()
    .min(1)
    .describe(
      'Add-on identifier — usually the canonical Heroku name (e.g. "heroku-postgresql-pinkish-5310").',
    ),
  app: z
    .string()
    .min(1)
    .optional()
    .describe('Optional app id or name to narrow the search (returns one row when set).'),
  addon_service: z
    .string()
    .min(1)
    .optional()
    .describe('Optional add-on service to narrow the search.'),
};

const addonAttachmentsResolveInput = {
  addon_attachment: z.string().min(1).describe('Attachment name to resolve (e.g. "DATABASE_URL").'),
  app: z.string().min(1).optional().describe('Optional app id or name to narrow the search.'),
  addon_service: z
    .string()
    .min(1)
    .optional()
    .describe('Optional add-on service to narrow the search.'),
};
