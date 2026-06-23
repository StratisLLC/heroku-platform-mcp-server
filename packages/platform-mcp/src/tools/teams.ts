/**
 * Teams-tier read-only tools (TOOLS.md "Tier: `teams`", read-only entries).
 *
 * Exposed when the teams-tier probe (`teams.list`) succeeded — including the
 * case where the probe returned `200 []` (i.e. the token can read /teams but
 * the user is not a member of any team). Tools that operate on individual
 * teams will 404 cleanly if called with a nonexistent team name; the existing
 * error mapping surfaces those correctly.
 *
 * Every list-style tool MUST go through the @heroku-mcp/core pagination
 * helper. The `/teams` endpoint defaults to 25 items per page and several
 * Heroku tokens (including the test token) belong to more than 25 teams — see
 * Phase 2b Decision 8.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, paginationInputShape, rangeHeader, runTool } from '../tool-helpers.js';
import type { HerokuList, HerokuRecord } from '../tool-helpers.js';
import type { ToolContext } from '../context.js';

const url = (s: string): string => encodeURIComponent(s);

const teamInput = {
  team: z.string().min(1).describe('Team id or name. Prefer UUID when known.'),
};

const teamAndMemberInput = {
  ...teamInput,
  member: z.string().min(1).describe('Team member email or id.'),
};

const teamAndFeatureInput = {
  ...teamInput,
  feature: z.string().min(1).describe('Team feature id or name.'),
};

const teamAppInput = {
  app: z.string().min(1).describe('App id or name (team-owned). Prefer UUID when known.'),
};

const teamAndInvoiceInput = {
  ...teamInput,
  number: z
    .number()
    .int()
    .positive()
    .describe('Team invoice number (integer). See `team_invoices_list` to discover values.'),
};

// The monthly usage endpoint requires year-month (YYYY-MM); the daily endpoint
// requires a full ISO date (YYYY-MM-DD). Heroku returns 422 for the wrong
// granularity, so we validate per-endpoint client-side and describe each
// accurately rather than sharing one (misleading) shape.
const teamMonthlyUsageInput = {
  ...teamInput,
  start: z
    .string()
    .regex(/^\d{4}-\d{2}$/, 'Use year-month, e.g. "2026-05".')
    .describe('Inclusive start month, year-month YYYY-MM (e.g. "2026-05").'),
  end: z
    .string()
    .regex(/^\d{4}-\d{2}$/, 'Use year-month, e.g. "2026-05".')
    .describe('Inclusive end month, year-month YYYY-MM (e.g. "2026-06").'),
};

const teamDailyUsageInput = {
  ...teamInput,
  start: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use full date, e.g. "2026-05-01".')
    .describe('Inclusive start date, ISO date YYYY-MM-DD (e.g. "2026-05-01").'),
  end: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use full date, e.g. "2026-05-01".')
    .describe('Inclusive end date, ISO date YYYY-MM-DD (e.g. "2026-05-31").'),
};

/** Register read-only teams-tier tools onto the server. */
export function registerTeamsTools(server: McpServer, ctx: ToolContext): void {
  // --------------------------------------------------------------------------
  // Teams
  // --------------------------------------------------------------------------

  server.registerTool(
    'teams_list',
    {
      title: 'Teams list',
      description:
        'List teams the authenticated user is a member of. Paginated — Heroku defaults to page size 25, so pass `page_size` to retrieve larger batches in one call. Wraps GET /teams.',
      inputSchema: { ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>('/teams', {
          tool: 'teams_list',
          headers: { Range: rangeHeader(input) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'teams_info',
    {
      title: 'Team info',
      description: 'Return one team by id or name. Wraps GET /teams/{id_or_name}.',
      inputSchema: teamInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ team }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(`/teams/${url(team)}`, {
          tool: 'teams_info',
        });
        return ok(res);
      }),
  );

  // --------------------------------------------------------------------------
  // Members
  // --------------------------------------------------------------------------

  server.registerTool(
    'team_members_list',
    {
      title: 'Team members list',
      description: 'List members of a team. Paginated. Wraps GET /teams/{id_or_name}/members.',
      inputSchema: { ...teamInput, ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ team, page_size, cursor }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(`/teams/${url(team)}/members`, {
          tool: 'team_members_list',
          headers: { Range: rangeHeader({ page_size, cursor }) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'team_members_apps_list',
    {
      title: 'Team member apps',
      description:
        'List apps a specific team member has access to within the team. Paginated. Wraps GET /teams/{id_or_name}/members/{email_or_id}/apps.',
      inputSchema: { ...teamAndMemberInput, ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ team, member, page_size, cursor }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(
          `/teams/${url(team)}/members/${url(member)}/apps`,
          {
            tool: 'team_members_apps_list',
            headers: { Range: rangeHeader({ page_size, cursor }) },
          },
        );
        return ok(res);
      }),
  );

  // --------------------------------------------------------------------------
  // Apps
  // --------------------------------------------------------------------------

  server.registerTool(
    'team_apps_list',
    {
      title: 'Team apps list',
      description: 'List apps owned by a team. Paginated. Wraps GET /teams/{id_or_name}/apps.',
      inputSchema: { ...teamInput, ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ team, page_size, cursor }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(`/teams/${url(team)}/apps`, {
          tool: 'team_apps_list',
          headers: { Range: rangeHeader({ page_size, cursor }) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'team_apps_info',
    {
      title: 'Team app info',
      description:
        'Return one team-owned app by id or name. Wraps GET /teams/apps/{id_or_name}. The endpoint enforces team-ownership; personal apps return 404.',
      inputSchema: teamAppInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ app }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(`/teams/apps/${url(app)}`, {
          tool: 'team_apps_info',
        });
        return ok(res);
      }),
  );

  // --------------------------------------------------------------------------
  // App collaborators
  // --------------------------------------------------------------------------

  server.registerTool(
    'team_app_collaborators_list',
    {
      title: 'Team app collaborators list',
      description:
        'List collaborators on a team-owned app. Paginated. Wraps GET /teams/apps/{id_or_name}/collaborators.',
      inputSchema: { ...teamAppInput, ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ app, page_size, cursor }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(`/teams/apps/${url(app)}/collaborators`, {
          tool: 'team_app_collaborators_list',
          headers: { Range: rangeHeader({ page_size, cursor }) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'team_app_permissions_list',
    {
      title: 'Team app permissions list',
      description:
        'List the permission names that team apps support (e.g. view, deploy, manage). Account-scoped — does not require a specific team. Wraps GET /teams/permissions.',
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>('/teams/permissions', {
          tool: 'team_app_permissions_list',
        });
        return ok(res);
      }),
  );

  // --------------------------------------------------------------------------
  // Invitations
  // --------------------------------------------------------------------------

  server.registerTool(
    'team_invitations_list',
    {
      title: 'Team invitations list',
      description:
        'List outstanding invitations on a team. Paginated. Wraps GET /teams/{id_or_name}/invitations.',
      inputSchema: { ...teamInput, ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ team, page_size, cursor }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(`/teams/${url(team)}/invitations`, {
          tool: 'team_invitations_list',
          headers: { Range: rangeHeader({ page_size, cursor }) },
        });
        return ok(res);
      }),
  );

  // --------------------------------------------------------------------------
  // Invoices
  // --------------------------------------------------------------------------

  server.registerTool(
    'team_invoices_list',
    {
      title: 'Team invoices list',
      description: 'List invoices for a team. Paginated. Wraps GET /teams/{id_or_name}/invoices.',
      inputSchema: { ...teamInput, ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ team, page_size, cursor }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(`/teams/${url(team)}/invoices`, {
          tool: 'team_invoices_list',
          headers: { Range: rangeHeader({ page_size, cursor }) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'team_invoices_info',
    {
      title: 'Team invoice info',
      description:
        'Return one team invoice by number. Wraps GET /teams/{id_or_name}/invoices/{number}.',
      inputSchema: teamAndInvoiceInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ team, number }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(`/teams/${url(team)}/invoices/${number}`, {
          tool: 'team_invoices_info',
        });
        return ok(res);
      }),
  );

  // --------------------------------------------------------------------------
  // Usage
  // --------------------------------------------------------------------------

  server.registerTool(
    'team_daily_usage',
    {
      title: 'Team daily usage',
      description:
        'Return a daily usage breakdown for a team across a date window. Wraps GET /teams/{id_or_name}/usage/daily.',
      inputSchema: teamDailyUsageInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ team, start, end }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(`/teams/${url(team)}/usage/daily`, {
          tool: 'team_daily_usage',
          query: { start, end },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'team_monthly_usage',
    {
      title: 'Team monthly usage',
      description:
        'Return a monthly usage breakdown for a team across a date window. Wraps GET /teams/{id_or_name}/usage/monthly.',
      inputSchema: teamMonthlyUsageInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ team, start, end }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(`/teams/${url(team)}/usage/monthly`, {
          tool: 'team_monthly_usage',
          query: { start, end },
        });
        return ok(res);
      }),
  );

  // --------------------------------------------------------------------------
  // Features
  // --------------------------------------------------------------------------

  server.registerTool(
    'team_features_list',
    {
      title: 'Team features list',
      description:
        'List feature flags on a team. Paginated. Wraps GET /teams/{id_or_name}/features.',
      inputSchema: { ...teamInput, ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ team, page_size, cursor }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(`/teams/${url(team)}/features`, {
          tool: 'team_features_list',
          headers: { Range: rangeHeader({ page_size, cursor }) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'team_features_info',
    {
      title: 'Team feature info',
      description:
        'Return one team feature flag. Wraps GET /teams/{id_or_name}/features/{id_or_name}.',
      inputSchema: teamAndFeatureInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ team, feature }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(
          `/teams/${url(team)}/features/${url(feature)}`,
          { tool: 'team_features_info' },
        );
        return ok(res);
      }),
  );

  // --------------------------------------------------------------------------
  // Add-ons / allowed add-on services
  // --------------------------------------------------------------------------

  server.registerTool(
    'team_addons_list',
    {
      title: 'Team add-ons list',
      description:
        'List add-ons attached to apps owned by a team. Paginated. Wraps GET /teams/{id_or_name}/addons.',
      inputSchema: { ...teamInput, ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ team, page_size, cursor }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(`/teams/${url(team)}/addons`, {
          tool: 'team_addons_list',
          headers: { Range: rangeHeader({ page_size, cursor }) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'allowed_addon_services_list',
    {
      title: 'Allowed add-on services list',
      description:
        'List add-on services a team is allowed to install. Paginated. Wraps GET /teams/{id_or_name}/allowed-addon-services.',
      inputSchema: { ...teamInput, ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ team, page_size, cursor }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(`/teams/${url(team)}/allowed-addon-services`, {
          tool: 'allowed_addon_services_list',
          headers: { Range: rangeHeader({ page_size, cursor }) },
        });
        return ok(res);
      }),
  );

  // --------------------------------------------------------------------------
  // Preferences / spaces / delinquency
  // --------------------------------------------------------------------------

  server.registerTool(
    'team_preferences_get',
    {
      title: 'Team preferences',
      description: 'Return team preferences. Wraps GET /teams/{id_or_name}/preferences.',
      inputSchema: teamInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ team }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(`/teams/${url(team)}/preferences`, {
          tool: 'team_preferences_get',
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'team_spaces_list',
    {
      title: 'Team spaces list',
      description:
        'List Private Spaces owned by a team. Paginated. Wraps GET /teams/{id_or_name}/spaces. Returns an empty list (or 403) when the team has no spaces — spaces are an enterprise feature.',
      inputSchema: { ...teamInput, ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ team, page_size, cursor }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(`/teams/${url(team)}/spaces`, {
          tool: 'team_spaces_list',
          headers: { Range: rangeHeader({ page_size, cursor }) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'team_delinquency_info',
    {
      title: 'Team delinquency',
      description: "Return a team's delinquency state. Wraps GET /teams/{id_or_name}/delinquency.",
      inputSchema: teamInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ team }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(`/teams/${url(team)}/delinquency`, {
          tool: 'team_delinquency_info',
        });
        return ok(res);
      }),
  );
}
