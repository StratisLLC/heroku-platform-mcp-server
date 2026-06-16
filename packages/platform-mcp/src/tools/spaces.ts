/**
 * Spaces-tier read-only tools (TOOLS.md "Tier: `spaces`", read entries).
 *
 * Exposed when the spaces tier probe (`spaces.list`) succeeded — i.e. the
 * calling token can read `GET /spaces`. Private Spaces are an Enterprise-only
 * feature, so this tier will 403 for most accounts.
 *
 * Every list-style tool MUST go through the @heroku-mcp/core pagination
 * helper. NAT / ruleset / peering / VPN endpoints are not paginated by Heroku
 * (they return a single record or a short fixed-size list).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, paginationInputShape, rangeHeader, runTool } from '../tool-helpers.js';
import type { HerokuList, HerokuRecord } from '../tool-helpers.js';
import type { ToolContext } from '../context.js';

const url = (s: string): string => encodeURIComponent(s);

const spaceInput = {
  space: z.string().min(1).describe('Space id or name. Prefer UUID when known.'),
};

const spaceAndVpnInput = {
  ...spaceInput,
  vpn: z.string().min(1).describe('VPN connection id or name. Prefer UUID when known.'),
};

const spaceAndPeeringInput = {
  ...spaceInput,
  peering: z.string().min(1).describe('Peering id (PCX id). Prefer UUID when known.'),
};

/** Register read-only spaces-tier tools onto the server. */
export function registerSpacesTools(server: McpServer, ctx: ToolContext): void {
  // --------------------------------------------------------------------------
  // Spaces
  // --------------------------------------------------------------------------

  server.registerTool(
    'spaces_list',
    {
      title: 'Private Spaces list',
      description:
        'List Private Spaces the authenticated user has access to. Paginated. Wraps GET /spaces.',
      inputSchema: { ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>('/spaces', {
          tool: 'spaces_list',
          headers: { Range: rangeHeader(input) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'spaces_info',
    {
      title: 'Private Space info',
      description: 'Return one Private Space by id or name. Wraps GET /spaces/{id_or_name}.',
      inputSchema: spaceInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ space }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(`/spaces/${url(space)}`, {
          tool: 'spaces_info',
        });
        return ok(res);
      }),
  );

  // --------------------------------------------------------------------------
  // Access / NAT / rulesets / VPN / peering
  // --------------------------------------------------------------------------

  server.registerTool(
    'spaces_app_access_list',
    {
      title: 'Space access list',
      description:
        'List members with access to a Private Space. Paginated. Wraps GET /spaces/{id_or_name}/members.',
      inputSchema: { ...spaceInput, ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ space, page_size, cursor }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(`/spaces/${url(space)}/members`, {
          tool: 'spaces_app_access_list',
          headers: { Range: rangeHeader({ page_size, cursor }) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'spaces_nat_info',
    {
      title: 'Space NAT info',
      description:
        'Return the outbound NAT configuration for a Private Space (source IPs Heroku traffic egresses from). Wraps GET /spaces/{id_or_name}/nat.',
      inputSchema: spaceInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ space }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(`/spaces/${url(space)}/nat`, {
          tool: 'spaces_nat_info',
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'spaces_inbound_ruleset_current',
    {
      title: 'Current inbound ruleset',
      description:
        'Return the currently-active inbound ruleset for a Private Space. Wraps GET /spaces/{id_or_name}/inbound-ruleset.',
      inputSchema: spaceInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ space }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(`/spaces/${url(space)}/inbound-ruleset`, {
          tool: 'spaces_inbound_ruleset_current',
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'spaces_outbound_ruleset_current',
    {
      title: 'Current outbound ruleset',
      description:
        'Return the currently-active outbound ruleset for a Private Space. Wraps GET /spaces/{id_or_name}/outbound-ruleset.',
      inputSchema: spaceInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ space }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(`/spaces/${url(space)}/outbound-ruleset`, {
          tool: 'spaces_outbound_ruleset_current',
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'spaces_inbound_rulesets_list',
    {
      title: 'Inbound rulesets list',
      description:
        'List historical inbound rulesets for a Private Space. Paginated. Wraps GET /spaces/{id_or_name}/inbound-rulesets.',
      inputSchema: { ...spaceInput, ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ space, page_size, cursor }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(`/spaces/${url(space)}/inbound-rulesets`, {
          tool: 'spaces_inbound_rulesets_list',
          headers: { Range: rangeHeader({ page_size, cursor }) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'spaces_outbound_rulesets_list',
    {
      title: 'Outbound rulesets list',
      description:
        'List historical outbound rulesets for a Private Space. Paginated. Wraps GET /spaces/{id_or_name}/outbound-rulesets.',
      inputSchema: { ...spaceInput, ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ space, page_size, cursor }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(`/spaces/${url(space)}/outbound-rulesets`, {
          tool: 'spaces_outbound_rulesets_list',
          headers: { Range: rangeHeader({ page_size, cursor }) },
        });
        return ok(res);
      }),
  );

  // --------------------------------------------------------------------------
  // VPN connections
  // --------------------------------------------------------------------------

  server.registerTool(
    'vpn_connections_list',
    {
      title: 'VPN connections list',
      description:
        'List VPN connections attached to a Private Space. Paginated. Wraps GET /spaces/{id_or_name}/vpn-connections.',
      inputSchema: { ...spaceInput, ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ space, page_size, cursor }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(`/spaces/${url(space)}/vpn-connections`, {
          tool: 'vpn_connections_list',
          headers: { Range: rangeHeader({ page_size, cursor }) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'vpn_connections_info',
    {
      title: 'VPN connection info',
      description:
        'Return one VPN connection by id or name. Wraps GET /spaces/{id_or_name}/vpn-connections/{id_or_name}.',
      inputSchema: spaceAndVpnInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ space, vpn }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(
          `/spaces/${url(space)}/vpn-connections/${url(vpn)}`,
          { tool: 'vpn_connections_info' },
        );
        return ok(res);
      }),
  );

  // --------------------------------------------------------------------------
  // Peerings
  // --------------------------------------------------------------------------

  server.registerTool(
    'peerings_list',
    {
      title: 'Peerings list',
      description:
        'List VPC peerings attached to a Private Space. Paginated. Wraps GET /spaces/{id_or_name}/peerings.',
      inputSchema: { ...spaceInput, ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ space, page_size, cursor }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(`/spaces/${url(space)}/peerings`, {
          tool: 'peerings_list',
          headers: { Range: rangeHeader({ page_size, cursor }) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'peerings_info',
    {
      title: 'Peering info',
      description:
        'Return one VPC peering by PCX id. Wraps GET /spaces/{id_or_name}/peerings/{id}.',
      inputSchema: spaceAndPeeringInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ space, peering }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(
          `/spaces/${url(space)}/peerings/${url(peering)}`,
          { tool: 'peerings_info' },
        );
        return ok(res);
      }),
  );

  // --------------------------------------------------------------------------
  // Space transfer (read side — list pending transfers)
  // --------------------------------------------------------------------------

  server.registerTool(
    'space_transfer_list',
    {
      title: 'Space transfer list',
      description:
        'List pending Private Space ownership transfers (across all spaces visible to the caller). Paginated. Wraps GET /space-transfers. Use space_transfer_create to initiate a new transfer.',
      inputSchema: { ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>('/space-transfers', {
          tool: 'space_transfer_list',
          headers: { Range: rangeHeader(input) },
        });
        return ok(res);
      }),
  );
}
