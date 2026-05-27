/**
 * Enterprise-tier read-only tools (TOOLS.md "Tier: `enterprise`", read entries).
 *
 * Exposed when the enterprise tier probe (`enterprise.list`) succeeded — i.e.
 * the calling token can read `GET /enterprise-accounts`. The probe lights up
 * even when the response is an empty list; individual enterprise account tools
 * 404 cleanly when called with a nonexistent enterprise id.
 *
 * Heroku reports per-endpoint permission errors (401/403) on the individual
 * Members / Permissions / Usage endpoints. We do NOT probe for permissions
 * sub-levels (admin vs collaborator vs viewer); permission errors flow through
 * the standard envelope.
 *
 * Every list-style tool MUST go through the @heroku-mcp/core pagination helper.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, paginationInputShape, rangeHeader, runTool } from '../tool-helpers.js';
import type { HerokuList, HerokuRecord } from '../tool-helpers.js';
import type { ToolContext } from '../context.js';

const url = (s: string): string => encodeURIComponent(s);

const enterpriseInput = {
  enterprise: z.string().min(1).describe('Enterprise account id or name. Prefer UUID when known.'),
};

const enterpriseAndUserInput = {
  ...enterpriseInput,
  user: z.string().min(1).describe('Enterprise account member email or id.'),
};

const enterpriseAndUsageRangeInput = {
  ...enterpriseInput,
  start: z
    .string()
    .min(1)
    .describe('Inclusive start of the usage window, ISO 8601 date (e.g. "2026-05-01").'),
  end: z
    .string()
    .min(1)
    .describe('Inclusive end of the usage window, ISO 8601 date (e.g. "2026-05-31").'),
};

/** Register read-only enterprise-tier tools onto the server. */
export function registerEnterpriseTools(server: McpServer, ctx: ToolContext): void {
  // --------------------------------------------------------------------------
  // Enterprise accounts
  // --------------------------------------------------------------------------

  server.registerTool(
    'enterprise_accounts_list',
    {
      title: 'Enterprise accounts list',
      description:
        'List enterprise accounts the authenticated user has access to. Paginated. Wraps GET /enterprise-accounts.',
      inputSchema: { ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>('/enterprise-accounts', {
          tool: 'enterprise_accounts_list',
          headers: { Range: rangeHeader(input) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'enterprise_accounts_info',
    {
      title: 'Enterprise account info',
      description:
        'Return one enterprise account by id or name. Wraps GET /enterprise-accounts/{id_or_name}.',
      inputSchema: enterpriseInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ enterprise }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(`/enterprise-accounts/${url(enterprise)}`, {
          tool: 'enterprise_accounts_info',
        });
        return ok(res);
      }),
  );

  // --------------------------------------------------------------------------
  // Usage
  // --------------------------------------------------------------------------

  server.registerTool(
    'enterprise_account_daily_usage',
    {
      title: 'Enterprise daily usage',
      description:
        'Daily usage breakdown for an enterprise account across a date window. Wraps GET /enterprise-accounts/{id_or_name}/usage/daily.',
      inputSchema: enterpriseAndUsageRangeInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ enterprise, start, end }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(
          `/enterprise-accounts/${url(enterprise)}/usage/daily`,
          {
            tool: 'enterprise_account_daily_usage',
            query: { start, end },
          },
        );
        return ok(res);
      }),
  );

  server.registerTool(
    'enterprise_account_monthly_usage',
    {
      title: 'Enterprise monthly usage',
      description:
        'Monthly usage breakdown for an enterprise account across a date window. Wraps GET /enterprise-accounts/{id_or_name}/usage/monthly.',
      inputSchema: enterpriseAndUsageRangeInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ enterprise, start, end }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(
          `/enterprise-accounts/${url(enterprise)}/usage/monthly`,
          {
            tool: 'enterprise_account_monthly_usage',
            query: { start, end },
          },
        );
        return ok(res);
      }),
  );

  // --------------------------------------------------------------------------
  // Members
  // --------------------------------------------------------------------------

  server.registerTool(
    'enterprise_account_members_list',
    {
      title: 'Enterprise members list',
      description:
        'List members of an enterprise account. Paginated. Wraps GET /enterprise-accounts/{id_or_name}/members.',
      inputSchema: { ...enterpriseInput, ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ enterprise, page_size, cursor }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(
          `/enterprise-accounts/${url(enterprise)}/members`,
          {
            tool: 'enterprise_account_members_list',
            headers: { Range: rangeHeader({ page_size, cursor }) },
          },
        );
        return ok(res);
      }),
  );

  server.registerTool(
    'enterprise_account_member_apps_list',
    {
      title: 'Enterprise member apps',
      description:
        'List apps a specific enterprise account member has access to. Wraps GET /enterprise-accounts/{id_or_name}/members/{user_email_or_id}/apps. Returns 404 if the member is not found.',
      inputSchema: { ...enterpriseAndUserInput, ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ enterprise, user, page_size, cursor }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(
          `/enterprise-accounts/${url(enterprise)}/members/${url(user)}/apps`,
          {
            tool: 'enterprise_account_member_apps_list',
            headers: { Range: rangeHeader({ page_size, cursor }) },
          },
        );
        return ok(res);
      }),
  );

  // --------------------------------------------------------------------------
  // Permissions / teams / addons
  // --------------------------------------------------------------------------

  server.registerTool(
    'enterprise_account_permissions_list',
    {
      title: 'Enterprise permission entities',
      description:
        'List the permission entities defined on an enterprise account. Paginated. Wraps GET /enterprise-accounts/{id_or_name}/permissions.',
      inputSchema: { ...enterpriseInput, ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ enterprise, page_size, cursor }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(
          `/enterprise-accounts/${url(enterprise)}/permissions`,
          {
            tool: 'enterprise_account_permissions_list',
            headers: { Range: rangeHeader({ page_size, cursor }) },
          },
        );
        return ok(res);
      }),
  );

  server.registerTool(
    'enterprise_account_addons_list',
    {
      title: 'Enterprise add-ons list',
      description:
        'List add-ons attached to apps across all teams owned by an enterprise account. Paginated. Wraps GET /enterprise-accounts/{id_or_name}/addons. The endpoint may not be exposed on every enterprise plan — Heroku returns 404 if the rollup is not available.',
      inputSchema: { ...enterpriseInput, ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ enterprise, page_size, cursor }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(
          `/enterprise-accounts/${url(enterprise)}/addons`,
          {
            tool: 'enterprise_account_addons_list',
            headers: { Range: rangeHeader({ page_size, cursor }) },
          },
        );
        return ok(res);
      }),
  );

  server.registerTool(
    'enterprise_account_teams_list',
    {
      title: 'Enterprise teams list',
      description:
        'List teams owned by an enterprise account. Paginated. Wraps GET /enterprise-accounts/{id_or_name}/teams. Enterprise-owned teams are the recommended Heroku organisational unit (the deprecated standalone teams API still works via the `teams_*` tools).',
      inputSchema: { ...enterpriseInput, ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ enterprise, page_size, cursor }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(
          `/enterprise-accounts/${url(enterprise)}/teams`,
          {
            tool: 'enterprise_account_teams_list',
            headers: { Range: rangeHeader({ page_size, cursor }) },
          },
        );
        return ok(res);
      }),
  );

  // --------------------------------------------------------------------------
  // Credit pool (Phase 3 surface — exposure varies by enterprise plan)
  // --------------------------------------------------------------------------

  server.registerTool(
    'credit_pool_info',
    {
      title: 'Enterprise credit pool',
      description:
        'Return the credit pool record for an enterprise account, if exposed on this plan. Wraps GET /enterprise-accounts/{id_or_name}/credit-pool. Heroku returns 404 when the credit-pool resource is not enabled — the tool surfaces that as a not_found envelope rather than throwing.',
      inputSchema: enterpriseInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ enterprise }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(
          `/enterprise-accounts/${url(enterprise)}/credit-pool`,
          { tool: 'credit_pool_info' },
        );
        return ok(res);
      }),
  );
}
