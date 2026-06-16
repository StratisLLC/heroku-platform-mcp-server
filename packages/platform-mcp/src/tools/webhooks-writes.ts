/**
 * Apps-tier write tools — app webhooks.
 *
 * Tools registered here:
 *   - app_webhooks_create (POST)
 *   - app_webhooks_update (PATCH)
 *   - app_webhooks_delete (⚠ DELETE; confirm: <app name>)
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

const webhookFieldsBase = {
  url: z.string().url().describe('HTTPS URL Heroku will POST events to.'),
  include: z
    .array(z.string().min(1))
    .min(1)
    .describe('List of event types to subscribe to (e.g. ["api:app", "api:release"]).'),
  level: z.enum(['notify', 'sync']).describe('Delivery semantics: notify (at-most-once) or sync.'),
  secret: z
    .string()
    .min(1)
    .optional()
    .describe('Optional shared secret. Heroku signs each delivery with it.'),
  authorization: z
    .string()
    .min(1)
    .optional()
    .describe('Optional Authorization header value Heroku will send with each delivery.'),
};

const webhooksCreateShape = {
  ...appInput,
  ...webhookFieldsBase,
};

const webhooksUpdateShape = {
  ...appInput,
  webhook: z.string().min(1).describe('App webhook id (UUID).'),
  url: z.string().url().optional().describe('Updated delivery URL.'),
  include: z.array(z.string().min(1)).min(1).optional().describe('Updated event-type list.'),
  level: z.enum(['notify', 'sync']).optional().describe('Updated delivery semantics.'),
  secret: z.string().min(1).optional().describe('Updated shared secret.'),
  authorization: z.string().min(1).optional().describe('Updated Authorization header value.'),
};

const webhooksDeleteShape = {
  ...appInput,
  webhook: z.string().min(1).describe('App webhook id (UUID).'),
};

export function registerWebhooksWriteTools(server: McpServer, ctx: ToolContext): void {
  registerWriteTool<typeof webhooksCreateShape, HerokuRecord>(server, ctx, {
    name: 'app_webhooks_create',
    title: 'Create app webhook',
    description:
      'Create an app webhook subscription that POSTs selected events to your URL. The `secret` you pass is write-only — Heroku does not return it. Wraps POST /apps/{id_or_name}/webhooks.',
    inputSchema: webhooksCreateShape,
    build: (args) => {
      const body: Record<string, unknown> = {
        url: args.url,
        include: args.include,
        level: args.level,
      };
      if (args.secret !== undefined) body.secret = args.secret;
      if (args.authorization !== undefined) body.authorization = args.authorization;
      return { method: 'POST', path: `/apps/${url(args.app)}/webhooks`, body };
    },
    describe: (args) =>
      `Would create app webhook on '${args.app}' → ${args.url} (events: ${args.include.join(', ')}, level: ${args.level}).`,
  });

  registerWriteTool<typeof webhooksUpdateShape, HerokuRecord>(server, ctx, {
    name: 'app_webhooks_update',
    title: 'Update app webhook',
    description: 'Modify an app webhook. Wraps PATCH /apps/{id_or_name}/webhooks/{id}.',
    inputSchema: webhooksUpdateShape,
    build: (args) => {
      const body: Record<string, unknown> = {};
      if (args.url !== undefined) body.url = args.url;
      if (args.include !== undefined) body.include = args.include;
      if (args.level !== undefined) body.level = args.level;
      if (args.secret !== undefined) body.secret = args.secret;
      if (args.authorization !== undefined) body.authorization = args.authorization;
      return {
        method: 'PATCH',
        path: `/apps/${url(args.app)}/webhooks/${url(args.webhook)}`,
        body,
      };
    },
    describe: (args) =>
      `Would update app webhook '${args.webhook}' on '${args.app}' (${
        Object.entries({
          url: args.url,
          include: args.include,
          level: args.level,
        })
          .filter(([, v]) => v !== undefined)
          .map(([k]) => k)
          .join(', ') || 'no fields'
      }).`,
  });

  registerWriteTool<typeof webhooksDeleteShape, HerokuRecord>(server, ctx, {
    name: 'app_webhooks_delete',
    title: 'Delete app webhook',
    description:
      'Delete an app webhook. Wraps DELETE /apps/{id_or_name}/webhooks/{id}. Destructive: pass confirm matching the app name.',
    inputSchema: webhooksDeleteShape,
    destructive: {
      targetKind: 'webhook',
      // app_webhooks_delete confirms on the *app* name (per Phase 2a Decision),
      // so we fetch the parent app instead of the webhook itself.
      expectedFromResource: (resource) =>
        typeof resource?.name === 'string' ? resource.name : undefined,
      expectedFromArgs: (args) => args.app,
    },
    preFetch: {
      run: (args) =>
        ctx.client.get<HerokuRecord>(`/apps/${url(args.app)}`, { tool: 'app_webhooks_delete' }),
    },
    build: (args) => ({
      method: 'DELETE',
      path: `/apps/${url(args.app)}/webhooks/${url(args.webhook)}`,
    }),
    describe: (args, fetched) => {
      // `fetched` is now the parent app (so we can derive the confirm name).
      const appName = typeof fetched?.name === 'string' ? fetched.name : args.app;
      return `Would remove app webhook '${args.webhook}' from '${appName}'. Event delivery stops immediately.`;
    },
  });
}
