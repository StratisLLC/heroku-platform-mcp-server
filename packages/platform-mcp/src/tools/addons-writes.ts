/**
 * Add-ons tier write tools (TOOLS.md "Tier: `addons_consumer`", write entries).
 *
 * Tools registered here:
 *   - addons_create                          (POST)
 *   - addons_update                          (PATCH)
 *   - addons_destroy                         (⚠ DELETE; confirm: <add-on name>)
 *   - addons_provision_release_test_resource (POST — release-tier add-on)
 *   - addons_promote_to_release              (POST)
 *   - addon_attachments_create               (POST)
 *   - addon_attachments_destroy              (⚠ DELETE; confirm: <attachment name>)
 *   - addon_config_update                    (PATCH)
 *   - addon_actions_run                      (POST — per-service action)
 *   - addon_webhooks_create                  (POST)
 *   - addon_webhooks_update                  (PATCH)
 *   - addon_webhooks_delete                  (⚠ DELETE; confirm: <add-on name>)
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../context.js';
import type { HerokuRecord } from '../tool-helpers.js';
import { registerWriteTool } from '../write-tool.js';

const url = (s: string): string => encodeURIComponent(s);

const appShape = {
  app: z.string().min(1).describe('App id or name. Prefer UUID when known.'),
};

const appAndAddonShape = {
  ...appShape,
  addon: z.string().min(1).describe('Add-on id or name. Prefer UUID when known.'),
};

const addonShape = {
  addon: z.string().min(1).describe('Add-on id or name. Prefer UUID when known.'),
};

const attachmentShape = {
  attachment: z.string().min(1).describe('Add-on attachment id. Prefer UUID when known.'),
};

const addonAndWebhookShape = {
  ...addonShape,
  webhook: z.string().min(1).describe('Add-on webhook id (UUID).'),
};

/** Register add-ons-tier write tools onto the server. */
export function registerAddonsWriteTools(server: McpServer, ctx: ToolContext): void {
  // --------------------------------------------------------------------------
  // Add-ons CRUD
  // --------------------------------------------------------------------------

  registerWriteTool<typeof addonsCreateShape, HerokuRecord>(server, ctx, {
    name: 'addons_create',
    title: 'Provision add-on',
    description:
      'Provision a new add-on on an app. Wraps POST /apps/{id_or_name}/addons. Pass `plan` (required) and optional `name`, `attachment.name`, `config`. Heroku may bill immediately on paid plans — the model should request explicit verbal confirmation before issuing.',
    inputSchema: addonsCreateShape,
    build: (args) => {
      const body: Record<string, unknown> = { plan: args.plan };
      if (args.name !== undefined) body.name = args.name;
      if (args.attachment !== undefined) body.attachment = args.attachment;
      if (args.config !== undefined) body.config = args.config;
      if (args.confirm !== undefined) body.confirm = args.confirm;
      return { method: 'POST', path: `/apps/${url(args.app)}/addons`, body };
    },
    describe: (args) => {
      const name = args.name ? ` (name=${args.name})` : '';
      const att = args.attachment?.name ? `, attachment=${args.attachment.name}` : '';
      return `Would provision add-on plan '${args.plan}' on app '${args.app}'${name}${att}. Heroku may bill immediately on paid plans.`;
    },
  });

  registerWriteTool<typeof addonsUpdateShape, HerokuRecord>(server, ctx, {
    name: 'addons_update',
    title: 'Change add-on plan',
    description:
      'Change the plan of an existing add-on (upgrade or downgrade). Wraps PATCH /apps/{id_or_name}/addons/{id_or_name}. Plan changes may trigger data migration on data-store add-ons — review the service vendor docs first.',
    inputSchema: addonsUpdateShape,
    build: (args) => ({
      method: 'PATCH',
      path: `/apps/${url(args.app)}/addons/${url(args.addon)}`,
      body: { plan: args.plan },
    }),
    describe: (args) =>
      `Would change add-on '${args.addon}' on app '${args.app}' to plan '${args.plan}'. Some plan changes trigger data migration.`,
  });

  registerWriteTool<typeof appAndAddonShape, HerokuRecord>(server, ctx, {
    name: 'addons_destroy',
    title: 'Destroy add-on',
    description:
      'Destroy an add-on attached to an app. Irreversible: data stored by the add-on is removed per the service vendor policy. Wraps DELETE /apps/{id_or_name}/addons/{id_or_name}. Destructive: pass confirm matching the add-on name (e.g. "heroku-postgresql-pinkish-5310").',
    inputSchema: appAndAddonShape,
    destructive: {
      targetKind: 'addon',
      expectedFromResource: (resource) =>
        typeof resource?.name === 'string' ? resource.name : undefined,
      expectedFromArgs: (args) => args.addon,
    },
    preFetch: {
      run: (args) =>
        ctx.client.get<HerokuRecord>(`/apps/${url(args.app)}/addons/${url(args.addon)}`, {
          tool: 'addons_destroy',
        }),
    },
    build: (args) => ({
      method: 'DELETE',
      path: `/apps/${url(args.app)}/addons/${url(args.addon)}`,
    }),
    describe: (args, fetched) => {
      const plan =
        fetched?.plan && typeof fetched.plan === 'object'
          ? ` (plan ${(fetched.plan as { name?: string }).name ?? 'unknown'})`
          : '';
      const service =
        fetched?.addon_service && typeof fetched.addon_service === 'object'
          ? ` (service ${(fetched.addon_service as { name?: string }).name ?? 'unknown'})`
          : '';
      return `Would destroy add-on '${args.addon}' on app '${args.app}'${plan}${service}. Add-on data is removed per the vendor policy.`;
    },
  });

  registerWriteTool<typeof appAndAddonShape, HerokuRecord>(server, ctx, {
    name: 'addons_provision_release_test_resource',
    title: 'Provision release-test add-on',
    description:
      'Provision a release-tier-test resource for an add-on (creates a temporary copy used to validate releases). Wraps POST /apps/{id_or_name}/addons/{id_or_name}/actions/provision-release-test-resource.',
    inputSchema: appAndAddonShape,
    build: (args) => ({
      method: 'POST',
      path: `/apps/${url(args.app)}/addons/${url(args.addon)}/actions/provision-release-test-resource`,
      body: null,
    }),
    describe: (args) =>
      `Would provision a release-test resource for add-on '${args.addon}' on app '${args.app}'.`,
  });

  registerWriteTool<typeof appAndAddonShape, HerokuRecord>(server, ctx, {
    name: 'addons_promote_to_release',
    title: 'Promote add-on test resource to release',
    description:
      'Promote a release-test resource so it becomes the active production add-on. Wraps POST /apps/{id_or_name}/addons/{id_or_name}/actions/promote-to-release.',
    inputSchema: appAndAddonShape,
    build: (args) => ({
      method: 'POST',
      path: `/apps/${url(args.app)}/addons/${url(args.addon)}/actions/promote-to-release`,
      body: null,
    }),
    describe: (args) =>
      `Would promote the release-test resource of add-on '${args.addon}' on app '${args.app}' to be the active production resource.`,
  });

  // --------------------------------------------------------------------------
  // Attachments
  // --------------------------------------------------------------------------

  registerWriteTool<typeof addonAttachmentsCreateShape, HerokuRecord>(server, ctx, {
    name: 'addon_attachments_create',
    title: 'Create add-on attachment',
    description:
      'Attach an existing add-on to an additional app (with an optional new config-var name). Wraps POST /addon-attachments.',
    inputSchema: addonAttachmentsCreateShape,
    build: (args) => {
      const body: Record<string, unknown> = { addon: args.addon, app: args.app };
      if (args.name !== undefined) body.name = args.name;
      if (args.namespace !== undefined) body.namespace = args.namespace;
      if (args.confirm !== undefined) body.confirm = args.confirm;
      return { method: 'POST', path: '/addon-attachments', body };
    },
    describe: (args) => {
      const name = args.name ? ` as ${args.name}` : '';
      return `Would attach add-on '${args.addon}' to app '${args.app}'${name}.`;
    },
  });

  registerWriteTool<typeof attachmentShape, HerokuRecord>(server, ctx, {
    name: 'addon_attachments_destroy',
    title: 'Destroy add-on attachment',
    description:
      'Detach an add-on from an app. Removes the attachment but does NOT destroy the underlying add-on. Wraps DELETE /addon-attachments/{id}. Destructive: pass confirm matching the attachment name (e.g. "DATABASE" or "HEROKU_POSTGRESQL_BLUE").',
    inputSchema: attachmentShape,
    destructive: {
      targetKind: 'addon_attachment',
      expectedFromResource: (resource) =>
        typeof resource?.name === 'string' ? resource.name : undefined,
      expectedFromArgs: (args) => args.attachment,
    },
    preFetch: {
      run: (args) =>
        ctx.client.get<HerokuRecord>(`/addon-attachments/${url(args.attachment)}`, {
          tool: 'addon_attachments_destroy',
        }),
    },
    build: (args) => ({
      method: 'DELETE',
      path: `/addon-attachments/${url(args.attachment)}`,
    }),
    describe: (args, fetched) => {
      const app =
        fetched?.app && typeof fetched.app === 'object'
          ? ` from app '${(fetched.app as { name?: string }).name ?? 'unknown'}'`
          : '';
      const addon =
        fetched?.addon && typeof fetched.addon === 'object'
          ? ` (add-on ${(fetched.addon as { name?: string }).name ?? 'unknown'})`
          : '';
      return `Would destroy add-on attachment '${args.attachment}'${app}${addon}. The underlying add-on is NOT destroyed.`;
    },
  });

  // --------------------------------------------------------------------------
  // Config update
  // --------------------------------------------------------------------------

  registerWriteTool<typeof addonConfigUpdateShape, HerokuRecord>(server, ctx, {
    name: 'addon_config_update',
    title: 'Update add-on config',
    description:
      'Update the config-var pairs the add-on service publishes to its parent app. Wraps PATCH /addons/{id_or_name}/config. Pass {name, value} pairs; pass null on the value to remove.',
    inputSchema: addonConfigUpdateShape,
    build: (args) => ({
      method: 'PATCH',
      path: `/addons/${url(args.addon)}/config`,
      body: { config: args.config },
    }),
    describe: (args) => {
      const keys = args.config.map((c) => c.name);
      return `Would update add-on '${args.addon}' config: ${keys.length > 0 ? keys.join(', ') : '(no fields)'}.`;
    },
  });

  // --------------------------------------------------------------------------
  // Actions (per-service)
  // --------------------------------------------------------------------------

  registerWriteTool<typeof addonActionsRunShape, HerokuRecord>(server, ctx, {
    name: 'addon_actions_run',
    title: 'Run add-on action',
    description:
      'Run a custom action published by an add-on service. Actions are per-service — only services that publish actions support this; most add-ons return 404. Use `addon_actions_list` on the parent service first to discover available actions. Wraps POST /addons/{id_or_name}/actions/{action}.',
    inputSchema: addonActionsRunShape,
    build: (args) => ({
      method: 'POST',
      path: `/addons/${url(args.addon)}/actions/${url(args.action)}`,
      body: args.body ?? null,
    }),
    describe: (args) =>
      `Would run action '${args.action}' on add-on '${args.addon}'. Action semantics are defined by the add-on partner.`,
  });

  // --------------------------------------------------------------------------
  // Webhooks
  // --------------------------------------------------------------------------

  registerWriteTool<typeof addonWebhooksCreateShape, HerokuRecord>(server, ctx, {
    name: 'addon_webhooks_create',
    title: 'Create add-on webhook',
    description:
      'Subscribe a webhook endpoint to events from an add-on. Wraps POST /addons/{id_or_name}/webhooks.',
    inputSchema: addonWebhooksCreateShape,
    build: (args) => {
      const body: Record<string, unknown> = {
        url: args.url,
        include: args.include,
        level: args.level,
      };
      if (args.secret !== undefined) body.secret = args.secret;
      if (args.authorization !== undefined) body.authorization = args.authorization;
      return { method: 'POST', path: `/addons/${url(args.addon)}/webhooks`, body };
    },
    describe: (args) =>
      `Would subscribe webhook ${args.url} to add-on '${args.addon}' events [${args.include.join(', ')}] at level '${args.level}'.`,
  });

  registerWriteTool<typeof addonWebhooksUpdateShape, HerokuRecord>(server, ctx, {
    name: 'addon_webhooks_update',
    title: 'Update add-on webhook',
    description:
      'Update an add-on webhook subscription. Wraps PATCH /addons/{id_or_name}/webhooks/{id}.',
    inputSchema: addonWebhooksUpdateShape,
    build: (args) => {
      const body: Record<string, unknown> = {};
      if (args.url !== undefined) body.url = args.url;
      if (args.include !== undefined) body.include = args.include;
      if (args.level !== undefined) body.level = args.level;
      if (args.secret !== undefined) body.secret = args.secret;
      if (args.authorization !== undefined) body.authorization = args.authorization;
      return {
        method: 'PATCH',
        path: `/addons/${url(args.addon)}/webhooks/${url(args.webhook)}`,
        body,
      };
    },
    describe: (args) => {
      const updates: string[] = [];
      if (args.url !== undefined) updates.push(`url → ${args.url}`);
      if (args.level !== undefined) updates.push(`level → ${args.level}`);
      if (args.include !== undefined) updates.push(`include → [${args.include.join(', ')}]`);
      const what = updates.length > 0 ? updates.join(', ') : '(no fields)';
      return `Would update webhook '${args.webhook}' on add-on '${args.addon}': ${what}.`;
    },
  });

  registerWriteTool<typeof addonAndWebhookShape, HerokuRecord>(server, ctx, {
    name: 'addon_webhooks_delete',
    title: 'Delete add-on webhook',
    description:
      'Delete an add-on webhook subscription. Wraps DELETE /addons/{id_or_name}/webhooks/{id}. Destructive: pass confirm matching the parent add-on name (webhook URLs are not user-friendly identifiers, so confirm targets the add-on instead).',
    inputSchema: addonAndWebhookShape,
    destructive: {
      targetKind: 'webhook',
      expectedFromResource: (resource) =>
        typeof resource?.name === 'string' ? resource.name : undefined,
      expectedFromArgs: (args) => args.addon,
    },
    preFetch: {
      // Pre-fetch the parent add-on (its name is the confirm target); the
      // webhook URL is not a stable human identifier.
      run: (args) =>
        ctx.client.get<HerokuRecord>(`/addons/${url(args.addon)}`, {
          tool: 'addon_webhooks_delete',
        }),
    },
    build: (args) => ({
      method: 'DELETE',
      path: `/addons/${url(args.addon)}/webhooks/${url(args.webhook)}`,
    }),
    describe: (args, fetched) => {
      const name = typeof fetched?.name === 'string' ? fetched.name : args.addon;
      return `Would delete webhook '${args.webhook}' on add-on '${name}'.`;
    },
  });
}

// ---- Schemas ----

const addonsCreateShape = {
  ...appShape,
  plan: z
    .string()
    .min(1)
    .describe(
      'Plan identifier (e.g. "heroku-postgresql:essential-0" or just "heroku-postgresql" to use the default plan).',
    ),
  name: z
    .string()
    .min(1)
    .optional()
    .describe('Optional add-on instance name. Heroku generates one when omitted.'),
  attachment: z
    .object({
      name: z.string().min(1).describe('Attachment name (e.g. "DATABASE").'),
    })
    .optional()
    .describe('Attachment configuration for the new add-on.'),
  config: z
    .record(z.string(), z.string())
    .optional()
    .describe('Optional config-var pairs forwarded to the add-on service at provisioning.'),
  confirm: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Confirm token Heroku may require for paid plans (e.g. the app name). Distinct from our destructive-op confirm — this is a Heroku-side billing acknowledgement.',
    ),
};

const addonsUpdateShape = {
  ...appAndAddonShape,
  plan: z.string().min(1).describe('Target plan identifier.'),
};

const addonAttachmentsCreateShape = {
  addon: z.string().min(1).describe('Add-on id or name to attach.'),
  app: z.string().min(1).describe('Target app id or name to attach to.'),
  name: z.string().min(1).optional().describe('Optional config-var name for the new attachment.'),
  namespace: z
    .string()
    .min(1)
    .optional()
    .describe('Optional add-on namespace (used by some data-store partners).'),
  confirm: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Heroku-side confirmation token (e.g. when attaching to a different team). Distinct from our destructive-op confirm.',
    ),
};

const addonConfigUpdateShape = {
  ...addonShape,
  config: z
    .array(
      z.object({
        name: z.string().min(1).describe('Config-var name.'),
        value: z.string().nullable().describe('Config-var value, or null to remove.'),
      }),
    )
    .min(1)
    .describe('List of {name, value} pairs to upsert; pass null on the value to remove.'),
};

const addonActionsRunShape = {
  ...addonShape,
  action: z
    .string()
    .min(1)
    .describe('Action name — see `addon_actions_list` for available actions.'),
  body: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Optional action-specific body; passed through to the partner verbatim.'),
};

const webhookIncludeShape = z
  .array(z.string().min(1))
  .min(1)
  .describe('Event names to subscribe to (e.g. ["api:release"]). At least one entry.');

const webhookLevelShape = z
  .enum(['notify', 'sync'])
  .describe('Delivery level: notify (fire-and-forget) or sync (wait for HTTP 200).');

const addonWebhooksCreateShape = {
  ...addonShape,
  url: z.string().min(1).describe('HTTPS endpoint the webhook posts to.'),
  include: webhookIncludeShape,
  level: webhookLevelShape,
  secret: z
    .string()
    .min(1)
    .optional()
    .describe('Optional shared secret. Heroku signs the request with this value.'),
  authorization: z
    .string()
    .min(1)
    .optional()
    .describe('Optional Authorization header value sent with each delivery.'),
};

const addonWebhooksUpdateShape = {
  ...addonAndWebhookShape,
  url: z.string().min(1).optional().describe('New endpoint URL.'),
  include: webhookIncludeShape.optional(),
  level: webhookLevelShape.optional(),
  secret: z.string().min(1).optional().describe('New shared secret.'),
  authorization: z.string().min(1).optional().describe('New Authorization header value.'),
};
