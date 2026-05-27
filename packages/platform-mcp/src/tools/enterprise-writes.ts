/**
 * Enterprise-tier write tools (TOOLS.md "Tier: `enterprise`", write entries).
 *
 * Tools registered here:
 *   - enterprise_accounts_update              (PATCH)
 *   - enterprise_account_members_create_or_update  (PUT)
 *   - enterprise_account_members_delete       (⚠ DELETE; confirm: <member email>)
 *   - enterprise_account_teams_create         (POST)
 *   - enterprise_account_teams_update         (PATCH)
 *
 * `enterprise_account_teams_create` is the recommended path for creating teams
 * owned by an enterprise account (the Phase 2b `teams_create` tool now carries
 * deprecation context pointing users here for enterprise contexts). See
 * notes/divergences.md "Phase 2b — `teams_create` and `teams_delete` carry
 * deprecation context".
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../context.js';
import type { HerokuRecord } from '../tool-helpers.js';
import { registerWriteTool } from '../write-tool.js';

const url = (s: string): string => encodeURIComponent(s);

const enterpriseShape = {
  enterprise: z.string().min(1).describe('Enterprise account id or name. Prefer UUID when known.'),
};

const enterpriseAndUserShape = {
  ...enterpriseShape,
  user: z.string().min(1).describe('Enterprise account member email or id.'),
};

/** Register enterprise-tier write tools onto the server. */
export function registerEnterpriseWriteTools(server: McpServer, ctx: ToolContext): void {
  // --------------------------------------------------------------------------
  // Enterprise account update
  // --------------------------------------------------------------------------

  registerWriteTool<typeof enterpriseUpdateShape, HerokuRecord>(server, ctx, {
    name: 'enterprise_accounts_update',
    title: 'Update enterprise account',
    description:
      'Update an enterprise account record (name, address, etc.). Wraps PATCH /enterprise-accounts/{id_or_name}.',
    inputSchema: enterpriseUpdateShape,
    build: (args) => {
      const body: Record<string, unknown> = {};
      if (args.name !== undefined) body.name = args.name;
      if (args.address_1 !== undefined) body.address_1 = args.address_1;
      if (args.address_2 !== undefined) body.address_2 = args.address_2;
      if (args.city !== undefined) body.city = args.city;
      if (args.country !== undefined) body.country = args.country;
      if (args.postal_code !== undefined) body.postal_code = args.postal_code;
      if (args.state !== undefined) body.state = args.state;
      return { method: 'PATCH', path: `/enterprise-accounts/${url(args.enterprise)}`, body };
    },
    describe: (args) => {
      const updates: string[] = [];
      if (args.name !== undefined) updates.push(`name → ${args.name}`);
      if (args.address_1 !== undefined) updates.push(`address_1 → ${args.address_1}`);
      if (args.city !== undefined) updates.push(`city → ${args.city}`);
      if (args.country !== undefined) updates.push(`country → ${args.country}`);
      const what = updates.length > 0 ? updates.join(', ') : '(no fields)';
      return `Would update enterprise account '${args.enterprise}': ${what}.`;
    },
  });

  // --------------------------------------------------------------------------
  // Members
  // --------------------------------------------------------------------------

  registerWriteTool<typeof enterpriseMembersUpsertShape, HerokuRecord>(server, ctx, {
    name: 'enterprise_account_members_create_or_update',
    title: 'Create or update enterprise member',
    description:
      'Add or update a member of an enterprise account (PUT semantics: creates if absent, updates the permission set if present). Wraps PUT /enterprise-accounts/{id_or_name}/members.',
    inputSchema: enterpriseMembersUpsertShape,
    build: (args) => {
      const body: Record<string, unknown> = {
        user: args.user,
        permissions: args.permissions,
      };
      if (args.federated !== undefined) body.federated = args.federated;
      if (args.identity_provider !== undefined) body.identity_provider = args.identity_provider;
      return {
        method: 'PUT',
        path: `/enterprise-accounts/${url(args.enterprise)}/members`,
        body,
      };
    },
    describe: (args) =>
      `Would set '${args.user}' as an enterprise account member of '${args.enterprise}' with permissions [${args.permissions.join(', ')}].`,
  });

  registerWriteTool<typeof enterpriseAndUserShape, HerokuRecord>(server, ctx, {
    name: 'enterprise_account_members_delete',
    title: 'Remove enterprise member',
    description:
      'Remove a member from an enterprise account. Wraps DELETE /enterprise-accounts/{id_or_name}/members/{user_email_or_id}. Destructive: pass confirm matching the member email.',
    inputSchema: enterpriseAndUserShape,
    destructive: {
      targetKind: 'enterprise',
      expectedFromResource: (resource) => {
        // Prefer top-level email; some responses nest under `user.email`.
        if (typeof resource?.email === 'string') return resource.email;
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
      run: (args) =>
        ctx.client.get<HerokuRecord>(
          `/enterprise-accounts/${url(args.enterprise)}/members/${url(args.user)}`,
          { tool: 'enterprise_account_members_delete' },
        ),
    },
    build: (args) => ({
      method: 'DELETE',
      path: `/enterprise-accounts/${url(args.enterprise)}/members/${url(args.user)}`,
    }),
    describe: (args, fetched) => {
      const perms = Array.isArray(fetched?.permissions)
        ? ` (permissions [${(fetched.permissions as unknown[])
            .map((p) => (typeof p === 'object' && p !== null ? (p as { name?: string }).name : p))
            .join(', ')}])`
        : '';
      return `Would remove '${args.user}' from enterprise account '${args.enterprise}'${perms}.`;
    },
  });

  // --------------------------------------------------------------------------
  // Enterprise-owned teams (the recommended Heroku flow for team creation)
  // --------------------------------------------------------------------------

  registerWriteTool<typeof enterpriseTeamsCreateShape, HerokuRecord>(server, ctx, {
    name: 'enterprise_account_teams_create',
    title: 'Create enterprise team',
    description:
      'Create a team owned by an enterprise account. This is the recommended Heroku path for team creation (the standalone `teams_create` tool wraps a deprecated endpoint that the Heroku CLI removed). Wraps POST /enterprise-accounts/{id_or_name}/teams.',
    inputSchema: enterpriseTeamsCreateShape,
    build: (args) => {
      const body: Record<string, unknown> = { name: args.name };
      if (args.address_1 !== undefined) body.address_1 = args.address_1;
      if (args.address_2 !== undefined) body.address_2 = args.address_2;
      if (args.city !== undefined) body.city = args.city;
      if (args.country !== undefined) body.country = args.country;
      if (args.postal_code !== undefined) body.postal_code = args.postal_code;
      if (args.state !== undefined) body.state = args.state;
      return {
        method: 'POST',
        path: `/enterprise-accounts/${url(args.enterprise)}/teams`,
        body,
      };
    },
    describe: (args) =>
      `Would create team '${args.name}' under enterprise account '${args.enterprise}'.`,
  });

  registerWriteTool<typeof enterpriseTeamsUpdateShape, HerokuRecord>(server, ctx, {
    name: 'enterprise_account_teams_update',
    title: 'Update enterprise team',
    description:
      'Update an enterprise-owned team. Wraps PATCH /teams/{id_or_name} — same API path as `teams_update`, but exposed here for the enterprise workflow so the tool description can clarify the enterprise context. Requires admin-level access to the enterprise account.',
    inputSchema: enterpriseTeamsUpdateShape,
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
      const what = updates.length > 0 ? updates.join(', ') : '(no fields)';
      return `Would update enterprise team '${args.team}': ${what}.`;
    },
  });
}

// ---- Schemas ----

const enterpriseUpdateShape = {
  ...enterpriseShape,
  name: z.string().min(1).optional().describe('New enterprise account name.'),
  address_1: z.string().min(1).optional().describe('Billing address line 1.'),
  address_2: z.string().min(1).optional().describe('Billing address line 2.'),
  city: z.string().min(1).optional().describe('Billing address city.'),
  country: z.string().min(1).optional().describe('Billing address country.'),
  postal_code: z.string().min(1).optional().describe('Billing address postal code.'),
  state: z.string().min(1).optional().describe('Billing address state/region.'),
};

const enterpriseMembersUpsertShape = {
  ...enterpriseShape,
  user: z.string().min(1).describe('Email or id of the user to add/update.'),
  permissions: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      'Permission names to grant (e.g. ["view", "create", "manage", "billing"]). See `enterprise_account_permissions_list` for the available set.',
    ),
  federated: z
    .boolean()
    .optional()
    .describe('When true, the member must sign in via the enterprise identity provider.'),
  identity_provider: z
    .string()
    .min(1)
    .optional()
    .describe('Optional identity-provider id to bind the member to.'),
};

const enterpriseTeamsCreateShape = {
  ...enterpriseShape,
  name: z.string().min(1).describe('Team name. Globally unique within Heroku.'),
  address_1: z.string().min(1).optional().describe('Billing address line 1 (if separate).'),
  address_2: z.string().min(1).optional().describe('Billing address line 2.'),
  city: z.string().min(1).optional().describe('Billing address city.'),
  country: z.string().min(1).optional().describe('Billing address country.'),
  postal_code: z.string().min(1).optional().describe('Billing address postal code.'),
  state: z.string().min(1).optional().describe('Billing address state/region.'),
};

const enterpriseTeamsUpdateShape = {
  team: z.string().min(1).describe('Team id or name to update. Prefer UUID.'),
  name: z.string().min(1).optional().describe('New team name.'),
  default: z.boolean().optional().describe("Whether this team should be the user's default."),
};
