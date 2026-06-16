/**
 * Apps-tier write tools — collaborators and app transfers.
 *
 * Tools registered here:
 *   - collaborators_create  (POST)
 *   - collaborators_delete  (⚠ DELETE; confirm: <email>)
 *   - app_transfers_create  (POST)
 *   - app_transfers_update  (⚠ PATCH; confirm: <app name>) — accepts/declines a pending transfer
 *   - app_transfers_delete  (⚠ DELETE; confirm: <app name>)
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

const collaboratorsCreateShape = {
  ...appInput,
  user: z.string().min(1).describe('Email or id of the user to add.'),
  silent: z
    .boolean()
    .optional()
    .describe('When true, suppress the invitation email Heroku would normally send.'),
  permissions: z
    .array(z.string().min(1))
    .optional()
    .describe('Permission names (for team apps). Ignored for personal apps.'),
};

const collaboratorsDeleteShape = {
  ...appInput,
  collaborator: z.string().min(1).describe('Collaborator email or id.'),
};

const appTransfersCreateShape = {
  ...appInput,
  recipient: z.string().min(1).describe('Email or id of the receiving user or team.'),
  silent: z.boolean().optional().describe('When true, suppress the transfer notification email.'),
};

const appTransfersUpdateShape = {
  transfer: z.string().min(1).describe('App transfer id or app name.'),
  /** Heroku accepts state values `pending`, `accepted`, `declined`. */
  state: z
    .enum(['pending', 'accepted', 'declined'])
    .describe('Target state. Use accepted/declined to act on a transfer addressed to you.'),
  app: z
    .string()
    .min(1)
    .describe('App name (used as the confirm target — the transfer affects this app).'),
};

const appTransfersDeleteShape = {
  transfer: z.string().min(1).describe('App transfer id or app name.'),
  app: z
    .string()
    .min(1)
    .describe('App name (used as the confirm target — the transfer affects this app).'),
};

export function registerCollabWriteTools(server: McpServer, ctx: ToolContext): void {
  registerWriteTool<typeof collaboratorsCreateShape, HerokuRecord>(server, ctx, {
    name: 'collaborators_create',
    title: 'Add collaborator',
    description: 'Add a collaborator to an app. Wraps POST /apps/{id_or_name}/collaborators.',
    inputSchema: collaboratorsCreateShape,
    build: (args) => {
      const body: Record<string, unknown> = { user: args.user };
      if (args.silent !== undefined) body.silent = args.silent;
      if (args.permissions !== undefined) body.permissions = args.permissions;
      return { method: 'POST', path: `/apps/${url(args.app)}/collaborators`, body };
    },
    describe: (args) =>
      `Would invite '${args.user}' as a collaborator on app '${args.app}'${
        args.silent ? ' (silent — no email)' : ''
      }.`,
  });

  registerWriteTool<typeof collaboratorsDeleteShape, HerokuRecord>(server, ctx, {
    name: 'collaborators_delete',
    title: 'Remove collaborator',
    description:
      'Remove a collaborator from an app. Wraps DELETE /apps/{id_or_name}/collaborators/{id_or_email}. Destructive: pass confirm matching the collaborator email.',
    inputSchema: collaboratorsDeleteShape,
    destructive: {
      targetKind: 'collaborator',
      // Heroku returns the collaborator's user as `user: { email, id }`.
      expectedFromResource: (resource) => {
        const user = resource?.user;
        if (user && typeof user === 'object') {
          const email = (user as { email?: unknown }).email;
          if (typeof email === 'string') return email;
        }
        return undefined;
      },
      expectedFromArgs: (args) => args.collaborator,
    },
    preFetch: {
      run: (args) =>
        ctx.client.get<HerokuRecord>(
          `/apps/${url(args.app)}/collaborators/${url(args.collaborator)}`,
          { tool: 'collaborators_delete' },
        ),
    },
    build: (args) => ({
      method: 'DELETE',
      path: `/apps/${url(args.app)}/collaborators/${url(args.collaborator)}`,
    }),
    describe: (args, fetched) => {
      const created =
        typeof fetched?.created_at === 'string' ? ` (added ${fetched.created_at})` : '';
      return `Would remove collaborator '${args.collaborator}' from app '${args.app}'${created}.`;
    },
  });

  registerWriteTool<typeof appTransfersCreateShape, HerokuRecord>(server, ctx, {
    name: 'app_transfers_create',
    title: 'Create app transfer',
    description:
      'Offer ownership of an app to another user or team. The recipient must accept via app_transfers_update. Wraps POST /account/app-transfers.',
    inputSchema: appTransfersCreateShape,
    build: (args) => {
      const body: Record<string, unknown> = { app: args.app, recipient: args.recipient };
      if (args.silent !== undefined) body.silent = args.silent;
      return { method: 'POST', path: '/account/app-transfers', body };
    },
    describe: (args) =>
      `Would create a transfer offer for app '${args.app}' to recipient '${args.recipient}'${
        args.silent ? ' (silent)' : ''
      }. The recipient must accept before ownership changes.`,
  });

  registerWriteTool<typeof appTransfersUpdateShape, HerokuRecord>(server, ctx, {
    name: 'app_transfers_update',
    title: 'Accept or decline app transfer',
    description:
      'Change the state of a pending app transfer (accept or decline). Wraps PATCH /account/app-transfers/{id_or_name}. Destructive: pass confirm matching the app name — accepting transfers ownership of the live app.',
    inputSchema: appTransfersUpdateShape,
    destructive: {
      targetKind: 'transfer',
      expectedFromResource: pickTransferAppName,
      expectedFromArgs: (args) => args.app,
    },
    preFetch: {
      run: (args) =>
        ctx.client.get<HerokuRecord>(`/account/app-transfers/${url(args.transfer)}`, {
          tool: 'app_transfers_update',
        }),
    },
    build: (args) => ({
      method: 'PATCH',
      path: `/account/app-transfers/${url(args.transfer)}`,
      body: { state: args.state },
    }),
    describe: (args, fetched) => {
      const appName = pickTransferAppName(fetched) ?? args.app;
      return `Would set app transfer '${args.transfer}' (app '${appName}') to state '${args.state}'. Accepting changes ownership of the live app.`;
    },
  });

  registerWriteTool<typeof appTransfersDeleteShape, HerokuRecord>(server, ctx, {
    name: 'app_transfers_delete',
    title: 'Cancel app transfer',
    description:
      'Cancel a pending app transfer offer. Wraps DELETE /account/app-transfers/{id_or_name}. Destructive: pass confirm matching the app name.',
    inputSchema: appTransfersDeleteShape,
    destructive: {
      targetKind: 'transfer',
      expectedFromResource: pickTransferAppName,
      expectedFromArgs: (args) => args.app,
    },
    preFetch: {
      run: (args) =>
        ctx.client.get<HerokuRecord>(`/account/app-transfers/${url(args.transfer)}`, {
          tool: 'app_transfers_delete',
        }),
    },
    build: (args) => ({
      method: 'DELETE',
      path: `/account/app-transfers/${url(args.transfer)}`,
    }),
    describe: (args, fetched) => {
      const state = typeof fetched?.state === 'string' ? ` (current state ${fetched.state})` : '';
      const appName = pickTransferAppName(fetched) ?? args.app;
      return `Would cancel app transfer '${args.transfer}' for app '${appName}'${state}.`;
    },
  });
}

/** Pick the app's canonical name from a `/account/app-transfers/{id}`
 *  response. Heroku nests it as `app: { id, name }`. */
function pickTransferAppName(record: HerokuRecord | undefined): string | undefined {
  if (!record) return undefined;
  const app = record.app;
  if (app && typeof app === 'object') {
    const name = (app as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return undefined;
}
