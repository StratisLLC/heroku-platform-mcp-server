/**
 * Teams-tier write tools (TOOLS.md "Tier: `teams`", write entries).
 *
 * Tools registered here (mirrors Phase 2a's split-by-group pattern, kept in
 * one file because the entire teams tier shares a single capability gate):
 *
 *   - teams_create                  (POST)
 *   - teams_update                  (PATCH)
 *   - teams_delete                  (⚠ DELETE; confirm: <team name>)
 *   - team_members_create_or_update (PUT)
 *   - team_members_delete           (⚠ DELETE; confirm: <member email>)
 *   - team_apps_create              (POST)
 *   - team_apps_update_locked       (PATCH)
 *   - team_apps_transfer            (⚠ PATCH; confirm: <app name>)
 *   - team_app_collaborators_create (POST)
 *   - team_app_collaborators_update (PATCH)
 *   - team_app_collaborators_delete (⚠ DELETE; confirm: <email>)
 *   - team_invitations_create       (PUT)
 *   - team_invitations_accept       (POST)
 *   - team_invitations_revoke       (⚠ DELETE; confirm: <invited email>)
 *   - team_features_update          (PATCH)
 *   - team_preferences_update       (PATCH)
 *   - allowed_addon_services_create (POST)
 *   - allowed_addon_services_delete (⚠ DELETE; confirm: <service name>)
 *
 * Deprecation context for `teams_create` and `teams_delete`: the Heroku CLI
 * removed the corresponding `teams:create` / `teams:destroy` commands because
 * Heroku now recommends managing teams through an Enterprise account
 * dashboard. The Platform API endpoints these tools wrap still work and
 * create/destroy standalone (non-enterprise) teams. Phase 2b Decision 2.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ClientSuccess } from '@heroku-mcp/core';
import type { ToolContext } from '../context.js';
import type { HerokuList, HerokuRecord } from '../tool-helpers.js';
import { registerWriteTool } from '../write-tool.js';

const url = (s: string): string => encodeURIComponent(s);

const teamShape = {
  team: z.string().min(1).describe('Team id or name. Prefer UUID when known.'),
};

const teamAndMemberShape = {
  ...teamShape,
  member: z.string().min(1).describe('Team member email or id.'),
};

const teamAndUserShape = {
  ...teamShape,
  user: z.string().min(1).describe('Email or id of the invited user.'),
};

const teamAndServiceShape = {
  ...teamShape,
  service: z.string().min(1).describe('Add-on service id or name.'),
};

const teamAppShape = {
  app: z.string().min(1).describe('App id or name. Prefer UUID when known.'),
};

const teamAppAndEmailShape = {
  ...teamAppShape,
  email: z.string().min(1).describe('Collaborator email.'),
};

// ---- Heroku role enum (member|admin|collaborator|owner) ----
const teamRole = z
  .enum(['admin', 'member', 'collaborator', 'owner'])
  .describe('Team role: admin, member, collaborator, or owner.');

/** Register teams-tier write tools onto the server. */
export function registerTeamsWriteTools(server: McpServer, ctx: ToolContext): void {
  // --------------------------------------------------------------------------
  // Teams CRUD
  // --------------------------------------------------------------------------

  registerWriteTool<typeof teamsCreateShape, HerokuRecord>(server, ctx, {
    name: 'teams_create',
    title: 'Create team',
    description:
      'Creates a non-enterprise team via POST /teams on the Heroku Platform API. Important context: the Heroku CLI removed its `teams:create` command because Heroku now recommends creating teams through an Enterprise account dashboard (a separate endpoint at POST /enterprise-accounts/{id}/teams, exposed in a later phase). The API endpoint this tool wraps still works and creates a standalone (non-enterprise) team that has limited functionality compared to enterprise-owned teams. Use this only when you specifically want a standalone team; for enterprise users, use the enterprise team creation tool when it becomes available.',
    inputSchema: teamsCreateShape,
    build: (args) => {
      const body: Record<string, unknown> = { name: args.name };
      if (args.address_1 !== undefined) body.address_1 = args.address_1;
      if (args.address_2 !== undefined) body.address_2 = args.address_2;
      if (args.city !== undefined) body.city = args.city;
      if (args.country !== undefined) body.country = args.country;
      if (args.postal_code !== undefined) body.postal_code = args.postal_code;
      if (args.state !== undefined) body.state = args.state;
      if (args.cc_number !== undefined) body.cc_number = args.cc_number;
      if (args.expiration_month !== undefined) body.expiration_month = args.expiration_month;
      if (args.expiration_year !== undefined) body.expiration_year = args.expiration_year;
      if (args.cvv !== undefined) body.cvv = args.cvv;
      if (args.first_name !== undefined) body.first_name = args.first_name;
      if (args.last_name !== undefined) body.last_name = args.last_name;
      if (args.other !== undefined) body.other = args.other;
      return { method: 'POST', path: '/teams', body };
    },
    describe: (args) =>
      `Would create a standalone (non-enterprise) team named '${args.name}'. Standalone teams have limited functionality; for enterprise users, prefer the enterprise team creation tool when it becomes available.`,
  });

  registerWriteTool<typeof teamsUpdateShape, HerokuRecord>(server, ctx, {
    name: 'teams_update',
    title: 'Update team',
    description: 'Update a team. Wraps PATCH /teams/{id_or_name}.',
    inputSchema: teamsUpdateShape,
    build: (args) => {
      const body: Record<string, unknown> = {};
      if (args.name !== undefined) body.name = args.name;
      if (args.default !== undefined) body.default = args.default;
      return { method: 'PATCH', path: `/teams/${url(args.team)}`, body };
    },
    describe: (args) => {
      const updates: string[] = [];
      if (args.name !== undefined) updates.push(`name → ${args.name}`);
      if (args.default !== undefined) updates.push(`default → ${args.default}`);
      return `Would update team '${args.team}': ${updates.length > 0 ? updates.join(', ') : '(no fields)'}.`;
    },
  });

  registerWriteTool<typeof teamShape, HerokuRecord>(server, ctx, {
    name: 'teams_delete',
    title: 'Delete team',
    description:
      'Deletes a non-enterprise team via DELETE /teams/{id}. Important context: the Heroku CLI removed its `teams:destroy` command for the same reasons as `teams_create`. The API endpoint works and will destroy the team; apps continue to exist under the user who created them but lose team membership. Enterprise-owned teams must be deleted through the enterprise account, not this tool. Requires confirm matching the team name.',
    inputSchema: teamShape,
    destructive: {
      targetKind: 'team',
      expectedFromResource: (resource) =>
        typeof resource?.name === 'string' ? resource.name : undefined,
      expectedFromArgs: (args) => args.team,
    },
    preFetch: {
      run: (args) =>
        ctx.client.get<HerokuRecord>(`/teams/${url(args.team)}`, { tool: 'teams_delete' }),
    },
    build: (args) => ({ method: 'DELETE', path: `/teams/${url(args.team)}` }),
    describe: (args, fetched) => {
      const created =
        typeof fetched?.created_at === 'string' ? ` (created ${fetched.created_at})` : '';
      const role = typeof fetched?.role === 'string' ? ` (your role: ${fetched.role})` : '';
      return `Would delete team '${args.team}'${created}${role}. Apps owned by the team remain under their original creators but lose team membership.`;
    },
  });

  // --------------------------------------------------------------------------
  // Members
  // --------------------------------------------------------------------------

  registerWriteTool<typeof teamMembersUpsertShape, HerokuRecord>(server, ctx, {
    name: 'team_members_create_or_update',
    title: 'Create or update team member',
    description:
      'Add or update a member of a team (PUT semantics: creates if absent, updates if present). Wraps PUT /teams/{id_or_name}/members.',
    inputSchema: teamMembersUpsertShape,
    build: (args) => {
      const body: Record<string, unknown> = { email: args.email, role: args.role };
      if (args.federated !== undefined) body.federated = args.federated;
      return { method: 'PUT', path: `/teams/${url(args.team)}/members`, body };
    },
    describe: (args) =>
      `Would set '${args.email}' as a team member of '${args.team}' with role '${args.role}'.`,
  });

  registerWriteTool<typeof teamAndMemberShape, HerokuRecord>(server, ctx, {
    name: 'team_members_delete',
    title: 'Remove team member',
    description:
      'Remove a member from a team. Wraps DELETE /teams/{id_or_name}/members/{email_or_id}. Destructive: pass confirm matching the member email.',
    inputSchema: teamAndMemberShape,
    destructive: {
      targetKind: 'team',
      expectedFromResource: (resource) =>
        typeof resource?.email === 'string' ? resource.email : undefined,
      expectedFromArgs: (args) => args.member,
    },
    preFetch: {
      run: (args) =>
        ctx.client.get<HerokuRecord>(`/teams/${url(args.team)}/members/${url(args.member)}`, {
          tool: 'team_members_delete',
        }),
    },
    build: (args) => ({
      method: 'DELETE',
      path: `/teams/${url(args.team)}/members/${url(args.member)}`,
    }),
    describe: (args, fetched) => {
      const role = typeof fetched?.role === 'string' ? ` (role ${fetched.role})` : '';
      const created =
        typeof fetched?.created_at === 'string' ? ` (joined ${fetched.created_at})` : '';
      return `Would remove '${args.member}' from team '${args.team}'${role}${created}.`;
    },
  });

  // --------------------------------------------------------------------------
  // Apps
  // --------------------------------------------------------------------------

  registerWriteTool<typeof teamAppsCreateShape, HerokuRecord>(server, ctx, {
    name: 'team_apps_create',
    title: 'Create team app',
    description:
      'Create a new app owned by a team. Wraps POST /teams/apps. Pass `locked: true` to require admin-only changes by default.',
    inputSchema: teamAppsCreateShape,
    build: (args) => {
      const body: Record<string, unknown> = { team: args.team };
      if (args.name !== undefined) body.name = args.name;
      if (args.region !== undefined) body.region = args.region;
      if (args.stack !== undefined) body.stack = args.stack;
      if (args.locked !== undefined) body.locked = args.locked;
      if (args.personal !== undefined) body.personal = args.personal;
      if (args.space !== undefined) body.space = args.space;
      if (args.internal_routing !== undefined) body.internal_routing = args.internal_routing;
      return { method: 'POST', path: '/teams/apps', body };
    },
    describe: (args) => {
      const bits: string[] = [`team=${args.team}`];
      if (args.name) bits.push(`name=${args.name}`);
      if (args.region) bits.push(`region=${args.region}`);
      if (args.stack) bits.push(`stack=${args.stack}`);
      if (args.locked !== undefined) bits.push(`locked=${args.locked}`);
      return `Would create a team-owned app (${bits.join(', ')}).`;
    },
  });

  registerWriteTool<typeof teamAppsUpdateLockedShape, HerokuRecord>(server, ctx, {
    name: 'team_apps_update_locked',
    title: 'Lock or unlock team app',
    description:
      'Lock or unlock a team-owned app. When locked, only team admins can modify the app. Wraps PATCH /teams/apps/{id_or_name} with the `locked` field. Does NOT change ownership — use team_apps_transfer for that.',
    inputSchema: teamAppsUpdateLockedShape,
    build: (args) => ({
      method: 'PATCH',
      path: `/teams/apps/${url(args.app)}`,
      body: { locked: args.locked },
    }),
    describe: (args) =>
      `Would set team app '${args.app}' locked=${args.locked}. Locked apps can only be modified by team admins.`,
  });

  registerWriteTool<typeof teamAppsTransferShape, HerokuRecord>(server, ctx, {
    name: 'team_apps_transfer',
    title: 'Transfer team app',
    description:
      'Transfer ownership of a team-owned app to a different team or user. Wraps PATCH /teams/apps/{id_or_name} with the `owner` field. Destructive: pass confirm matching the app name — ownership changes immediately.',
    inputSchema: teamAppsTransferShape,
    destructive: {
      targetKind: 'app',
      expectedFromResource: (resource) =>
        typeof resource?.name === 'string' ? resource.name : undefined,
      expectedFromArgs: (args) => args.app,
    },
    preFetch: {
      run: (args) =>
        ctx.client.get<HerokuRecord>(`/teams/apps/${url(args.app)}`, {
          tool: 'team_apps_transfer',
        }),
    },
    build: (args) => ({
      method: 'PATCH',
      path: `/teams/apps/${url(args.app)}`,
      body: { owner: args.owner },
    }),
    describe: (args, fetched) => {
      const appName = typeof fetched?.name === 'string' ? fetched.name : args.app;
      return `Would transfer ownership of team app '${appName}' to '${args.owner}'. Ownership changes immediately on success.`;
    },
  });

  // --------------------------------------------------------------------------
  // Team app collaborators
  // --------------------------------------------------------------------------

  registerWriteTool<typeof teamAppCollaboratorsCreateShape, HerokuRecord>(server, ctx, {
    name: 'team_app_collaborators_create',
    title: 'Add team app collaborator',
    description:
      'Add a collaborator to a team-owned app. Wraps POST /teams/apps/{id_or_name}/collaborators.',
    inputSchema: teamAppCollaboratorsCreateShape,
    build: (args) => {
      const body: Record<string, unknown> = { user: args.user };
      if (args.permissions !== undefined) body.permissions = args.permissions;
      if (args.silent !== undefined) body.silent = args.silent;
      return { method: 'POST', path: `/teams/apps/${url(args.app)}/collaborators`, body };
    },
    describe: (args) => {
      const perms =
        args.permissions && args.permissions.length > 0
          ? ` with permissions [${args.permissions.join(', ')}]`
          : '';
      return `Would invite '${args.user}' to team app '${args.app}'${perms}${
        args.silent ? ' (silent)' : ''
      }.`;
    },
  });

  registerWriteTool<typeof teamAppCollaboratorsUpdateShape, HerokuRecord>(server, ctx, {
    name: 'team_app_collaborators_update',
    title: 'Update team app collaborator permissions',
    description:
      "Update a team-app collaborator's permissions. Wraps PATCH /teams/apps/{id_or_name}/collaborators/{email}.",
    inputSchema: teamAppCollaboratorsUpdateShape,
    build: (args) => ({
      method: 'PATCH',
      path: `/teams/apps/${url(args.app)}/collaborators/${url(args.email)}`,
      body: { permissions: args.permissions },
    }),
    describe: (args) =>
      `Would set permissions of '${args.email}' on team app '${args.app}' to [${args.permissions.join(', ')}].`,
  });

  registerWriteTool<typeof teamAppAndEmailShape, HerokuRecord>(server, ctx, {
    name: 'team_app_collaborators_delete',
    title: 'Remove team app collaborator',
    description:
      'Remove a collaborator from a team-owned app. Wraps DELETE /teams/apps/{id_or_name}/collaborators/{email}. Destructive: pass confirm matching the collaborator email.',
    inputSchema: teamAppAndEmailShape,
    destructive: {
      targetKind: 'collaborator',
      expectedFromResource: (resource) => {
        const user = resource?.user;
        if (user && typeof user === 'object') {
          const email = (user as { email?: unknown }).email;
          if (typeof email === 'string') return email;
        }
        return undefined;
      },
      expectedFromArgs: (args) => args.email,
    },
    preFetch: {
      run: (args) =>
        ctx.client.get<HerokuRecord>(
          `/teams/apps/${url(args.app)}/collaborators/${url(args.email)}`,
          { tool: 'team_app_collaborators_delete' },
        ),
    },
    build: (args) => ({
      method: 'DELETE',
      path: `/teams/apps/${url(args.app)}/collaborators/${url(args.email)}`,
    }),
    describe: (args, fetched) => {
      const role = typeof fetched?.role === 'string' ? ` (role ${fetched.role})` : '';
      return `Would remove '${args.email}' from team app '${args.app}'${role}.`;
    },
  });

  // --------------------------------------------------------------------------
  // Invitations
  // --------------------------------------------------------------------------

  registerWriteTool<typeof teamInvitationsCreateShape, HerokuRecord>(server, ctx, {
    name: 'team_invitations_create',
    title: 'Create or update team invitation',
    description:
      'Invite a user to a team (PUT semantics — re-issuing for the same email updates the role on the pending invite). Wraps PUT /teams/{id_or_name}/invitations.',
    inputSchema: teamInvitationsCreateShape,
    build: (args) => ({
      method: 'PUT',
      path: `/teams/${url(args.team)}/invitations`,
      body: { email: args.email, role: args.role },
    }),
    describe: (args) =>
      `Would invite '${args.email}' to team '${args.team}' with role '${args.role}'.`,
  });

  registerWriteTool<typeof teamInvitationsAcceptShape, HerokuRecord>(server, ctx, {
    name: 'team_invitations_accept',
    title: 'Accept team invitation',
    description:
      'Accept a pending team invitation using its opaque token. Wraps POST /teams/invitations/{token}/accept.',
    inputSchema: teamInvitationsAcceptShape,
    build: (args) => ({
      method: 'POST',
      path: `/teams/invitations/${url(args.token)}/accept`,
      body: null,
    }),
    describe: (args) =>
      `Would accept the team invitation identified by token '${args.token.slice(0, 8)}…'.`,
  });

  registerWriteTool<typeof teamAndUserShape, HerokuRecord>(server, ctx, {
    name: 'team_invitations_revoke',
    title: 'Revoke team invitation',
    description:
      'Revoke a pending team invitation. Wraps DELETE /teams/{id_or_name}/invitations/{user}. Destructive: pass confirm matching the invited email. There is no individual GET for invitations — the dry-run pre-fetch lists invitations and filters by email.',
    inputSchema: teamAndUserShape,
    destructive: {
      targetKind: 'invitation',
      expectedFromResource: (resource) => {
        const user = resource?.user;
        if (user && typeof user === 'object') {
          const email = (user as { email?: unknown }).email;
          if (typeof email === 'string') return email;
        }
        return undefined;
      },
      expectedFromArgs: (args) => args.user,
    },
    preFetch: {
      run: async (args) => {
        const list = await ctx.client.get<HerokuList>(`/teams/${url(args.team)}/invitations`, {
          tool: 'team_invitations_revoke',
        });
        const match = (list.body ?? []).find((entry) => matchInvitation(entry, args.user));
        const success: ClientSuccess<HerokuRecord | null> = {
          ok: true,
          status: list.status,
          body: match ?? null,
          headers: list.headers,
          cached: list.cached,
        };
        if (list.requestId !== undefined) success.requestId = list.requestId;
        if (list.rateLimitRemaining !== undefined)
          success.rateLimitRemaining = list.rateLimitRemaining;
        return success as ClientSuccess<HerokuRecord>;
      },
    },
    build: (args) => ({
      method: 'DELETE',
      path: `/teams/${url(args.team)}/invitations/${url(args.user)}`,
    }),
    describe: (args, fetched) => {
      if (!fetched) {
        return `Would revoke pending invitation for '${args.user}' on team '${args.team}'. (No matching invitation found in current list — Heroku may return 404 on the live call.)`;
      }
      const role = typeof fetched.role === 'string' ? ` (role ${fetched.role})` : '';
      const sentAt = typeof fetched.created_at === 'string' ? ` (sent ${fetched.created_at})` : '';
      const inviter =
        fetched.invited_by && typeof fetched.invited_by === 'object'
          ? typeof (fetched.invited_by as { email?: unknown }).email === 'string'
            ? ` by ${(fetched.invited_by as { email: string }).email}`
            : ''
          : '';
      return `Would revoke pending invitation for '${args.user}' on team '${args.team}'${role}${sentAt}${inviter}.`;
    },
  });

  // --------------------------------------------------------------------------
  // Features / preferences
  // --------------------------------------------------------------------------

  registerWriteTool<typeof teamFeaturesUpdateShape, HerokuRecord>(server, ctx, {
    name: 'team_features_update',
    title: 'Team feature update',
    description:
      'Toggle a team feature flag. Wraps PATCH /teams/{id_or_name}/features/{id_or_name}.',
    inputSchema: teamFeaturesUpdateShape,
    build: (args) => ({
      method: 'PATCH',
      path: `/teams/${url(args.team)}/features/${url(args.feature)}`,
      body: { enabled: args.enabled },
    }),
    describe: (args) =>
      `Would set team feature '${args.feature}' on team '${args.team}' to enabled=${args.enabled}.`,
  });

  registerWriteTool<typeof teamPreferencesUpdateShape, HerokuRecord>(server, ctx, {
    name: 'team_preferences_update',
    title: 'Team preferences update',
    description:
      'Update team preferences (whitelisting-enabled, addons-controls, etc.). Pass only the keys you want to change. Wraps PATCH /teams/{id_or_name}/preferences.',
    inputSchema: teamPreferencesUpdateShape,
    build: (args) => ({
      method: 'PATCH',
      path: `/teams/${url(args.team)}/preferences`,
      body: args.preferences,
    }),
    describe: (args) => {
      const keys = Object.keys(args.preferences);
      return `Would update team '${args.team}' preferences: ${keys.length > 0 ? keys.join(', ') : '(no fields)'}.`;
    },
  });

  // --------------------------------------------------------------------------
  // Allowed add-on services
  // --------------------------------------------------------------------------

  registerWriteTool<typeof allowedAddonServicesCreateShape, HerokuRecord>(server, ctx, {
    name: 'allowed_addon_services_create',
    title: 'Allow add-on service',
    description:
      'Allow a specific add-on service for a team. Wraps POST /teams/{id_or_name}/allowed-addon-services.',
    inputSchema: allowedAddonServicesCreateShape,
    build: (args) => ({
      method: 'POST',
      path: `/teams/${url(args.team)}/allowed-addon-services`,
      body: { addon_service: args.addon_service },
    }),
    describe: (args) =>
      `Would allow add-on service '${args.addon_service}' for team '${args.team}'.`,
  });

  registerWriteTool<typeof teamAndServiceShape, HerokuRecord>(server, ctx, {
    name: 'allowed_addon_services_delete',
    title: 'Disallow add-on service',
    description:
      'Remove an allowed add-on service from a team. Wraps DELETE /teams/{id_or_name}/allowed-addon-services/{id_or_name}. Destructive: pass confirm matching the service name. There is no individual GET — the dry-run pre-fetch lists allowed services and filters by name.',
    inputSchema: teamAndServiceShape,
    destructive: {
      targetKind: 'allowed_addon_service',
      // Each entry in /teams/{id}/allowed-addon-services has a nested
      // `addon_service: { name }` (the canonical addon-service name).
      expectedFromResource: (resource) => {
        const addonService = resource?.addon_service;
        if (addonService && typeof addonService === 'object') {
          const name = (addonService as { name?: unknown }).name;
          if (typeof name === 'string') return name;
        }
        return undefined;
      },
      expectedFromArgs: (args) => args.service,
    },
    preFetch: {
      run: async (args) => {
        const list = await ctx.client.get<HerokuList>(
          `/teams/${url(args.team)}/allowed-addon-services`,
          { tool: 'allowed_addon_services_delete' },
        );
        const match = (list.body ?? []).find((entry) => matchAllowedService(entry, args.service));
        const success: ClientSuccess<HerokuRecord | null> = {
          ok: true,
          status: list.status,
          body: match ?? null,
          headers: list.headers,
          cached: list.cached,
        };
        if (list.requestId !== undefined) success.requestId = list.requestId;
        if (list.rateLimitRemaining !== undefined)
          success.rateLimitRemaining = list.rateLimitRemaining;
        return success as ClientSuccess<HerokuRecord>;
      },
    },
    build: (args) => ({
      method: 'DELETE',
      path: `/teams/${url(args.team)}/allowed-addon-services/${url(args.service)}`,
    }),
    describe: (args, fetched) => {
      if (!fetched) {
        return `Would remove allowed add-on service '${args.service}' from team '${args.team}'. (No matching entry found in current list — Heroku may return 404 on the live call.)`;
      }
      const addedBy =
        fetched.added_by && typeof fetched.added_by === 'object'
          ? typeof (fetched.added_by as { email?: unknown }).email === 'string'
            ? ` (added by ${(fetched.added_by as { email: string }).email})`
            : ''
          : '';
      return `Would remove allowed add-on service '${args.service}' from team '${args.team}'${addedBy}.`;
    },
  });
}

// ---- Schemas ----

const teamsCreateShape = {
  name: z.string().min(1).describe('Team name. Globally unique within Heroku.'),
  address_1: z.string().min(1).optional().describe('Billing address line 1.'),
  address_2: z.string().min(1).optional().describe('Billing address line 2.'),
  city: z.string().min(1).optional().describe('Billing address city.'),
  country: z.string().min(1).optional().describe('Billing address country.'),
  postal_code: z.string().min(1).optional().describe('Billing address postal code.'),
  state: z.string().min(1).optional().describe('Billing address state/region.'),
  cc_number: z.string().min(1).optional().describe('Credit card number for billing setup.'),
  expiration_month: z.string().min(1).optional().describe('Credit card expiration month.'),
  expiration_year: z.string().min(1).optional().describe('Credit card expiration year.'),
  cvv: z.string().min(1).optional().describe('Credit card CVV.'),
  first_name: z.string().min(1).optional().describe('Cardholder first name.'),
  last_name: z.string().min(1).optional().describe('Cardholder last name.'),
  other: z.string().min(1).optional().describe('Free-form notes Heroku accepts on team setup.'),
};

const teamsUpdateShape = {
  ...teamShape,
  name: z.string().min(1).optional().describe('New team name. Globally unique within Heroku.'),
  default: z.boolean().optional().describe("Whether this team should be the user's default team."),
};

const teamMembersUpsertShape = {
  ...teamShape,
  email: z.string().min(1).describe('Email of the user to add or update.'),
  role: teamRole,
  federated: z
    .boolean()
    .optional()
    .describe('When true, the member is signed in via the team identity provider.'),
};

const teamAppsCreateShape = {
  team: z.string().min(1).describe('Team id or name that will own the new app.'),
  name: z.string().min(1).optional().describe('App name. Heroku generates one when omitted.'),
  region: z.string().min(1).optional().describe('Region id or name (e.g. "us", "eu").'),
  stack: z.string().min(1).optional().describe('Stack id or name (e.g. "heroku-24").'),
  locked: z
    .boolean()
    .optional()
    .describe('When true, only team admins can modify the app once created.'),
  personal: z
    .boolean()
    .optional()
    .describe('Reserved by Heroku — pass false to create a team-owned app (default).'),
  space: z.string().min(1).optional().describe('Space id or name (for Private Space apps).'),
  internal_routing: z
    .boolean()
    .optional()
    .describe('Internal-routing flag for Private Space apps.'),
};

const teamAppsUpdateLockedShape = {
  ...teamAppShape,
  locked: z.boolean().describe('Target locked state.'),
};

const teamAppsTransferShape = {
  ...teamAppShape,
  owner: z.string().min(1).describe('New owner identifier — team id/name or user email/id.'),
};

const teamAppCollaboratorsCreateShape = {
  ...teamAppShape,
  user: z.string().min(1).describe('Email or id of the user to add.'),
  permissions: z
    .array(z.string().min(1))
    .optional()
    .describe('Permission names (e.g. ["view", "deploy", "manage", "operate"]).'),
  silent: z.boolean().optional().describe('When true, suppress the invitation email.'),
};

const teamAppCollaboratorsUpdateShape = {
  ...teamAppAndEmailShape,
  permissions: z
    .array(z.string().min(1))
    .min(1)
    .describe('Permission names to set (e.g. ["view", "deploy", "manage", "operate"]).'),
};

const teamInvitationsCreateShape = {
  ...teamShape,
  email: z.string().min(1).describe('Email of the user to invite.'),
  role: teamRole,
};

const teamInvitationsAcceptShape = {
  token: z.string().min(1).describe('Opaque invitation token from the Heroku invitation email.'),
};

const teamFeaturesUpdateShape = {
  ...teamShape,
  feature: z.string().min(1).describe('Team feature id or name.'),
  enabled: z.boolean().describe('Target enabled state.'),
};

const teamPreferencesUpdateShape = {
  ...teamShape,
  preferences: z
    .record(z.string(), z.unknown())
    .describe(
      'Map of preference keys to values. Pass-through — forwarded verbatim to Heroku. Common keys include whitelisting-enabled and addons-controls.',
    ),
};

const allowedAddonServicesCreateShape = {
  ...teamShape,
  addon_service: z.string().min(1).describe('Add-on service id or name to allow.'),
};

// ---- Helpers ----

function matchInvitation(entry: HerokuRecord, identifier: string): boolean {
  const id = entry.id;
  if (typeof id === 'string' && id === identifier) return true;
  const user = entry.user;
  if (user && typeof user === 'object') {
    const email = (user as { email?: unknown }).email;
    const userId = (user as { id?: unknown }).id;
    if (typeof email === 'string' && email.toLowerCase() === identifier.toLowerCase()) return true;
    if (typeof userId === 'string' && userId === identifier) return true;
  }
  return false;
}

function matchAllowedService(entry: HerokuRecord, identifier: string): boolean {
  const id = entry.id;
  if (typeof id === 'string' && id === identifier) return true;
  const addonService = entry.addon_service;
  if (addonService && typeof addonService === 'object') {
    const name = (addonService as { name?: unknown }).name;
    const svcId = (addonService as { id?: unknown }).id;
    if (typeof name === 'string' && name === identifier) return true;
    if (typeof svcId === 'string' && svcId === identifier) return true;
  }
  const name = entry.name;
  if (typeof name === 'string' && name === identifier) return true;
  return false;
}
