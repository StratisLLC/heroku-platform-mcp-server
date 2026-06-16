/**
 * Spaces-tier write tools (TOOLS.md "Tier: `spaces`", write entries).
 *
 * Tools registered here:
 *   - spaces_create                  (POST)
 *   - spaces_update                  (PATCH)
 *   - spaces_destroy                 (⚠ DELETE; confirm: <space name>)
 *   - vpn_connections_create         (POST)
 *   - vpn_connections_destroy        (⚠ DELETE; confirm: <vpn name>)
 *   - peerings_create                (POST)
 *   - peerings_destroy               (⚠ DELETE; confirm: <peering pcx_id>)
 *   - space_transfer_create          (POST)
 *   - spaces_inbound_ruleset_create  (PUT)
 *   - spaces_outbound_ruleset_create (PUT)
 *
 * Decision 5 (Phase 3): when `spaces_create` is called with `shield: true`,
 * the `log_drain_url` parameter MUST be provided — Heroku permanently disables
 * log-drain support on a Shield space if it is created without one. The schema
 * enforces this with a Zod refinement; the tool description carries verbatim
 * guidance for the model.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InvalidParamsError } from '@heroku-mcp/core';
import type { ToolContext } from '../context.js';
import type { HerokuRecord } from '../tool-helpers.js';
import { registerWriteTool } from '../write-tool.js';

const url = (s: string): string => encodeURIComponent(s);

/** Strip the IPSec pre-shared keys from a VPN-connection record. The create
 *  response volunteers `tunnels[].pre_shared_key` — live VPN credentials that
 *  must not enter model context. The PSKs remain retrievable out-of-band via
 *  the dedicated VPN-connection read; we drop them from the create echo. */
function stripVpnPreSharedKeys(body: unknown): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.tunnels)) return body;
  const tunnels = (record.tunnels as unknown[]).map((tunnel) => {
    if (tunnel === null || typeof tunnel !== 'object') return tunnel;
    const { pre_shared_key: _omit, ...rest } = tunnel as Record<string, unknown>;
    return rest;
  });
  return { ...record, tunnels };
}

const spaceShape = {
  space: z.string().min(1).describe('Space id or name. Prefer UUID when known.'),
};

const spaceAndVpnShape = {
  ...spaceShape,
  vpn: z.string().min(1).describe('VPN connection id or name. Prefer UUID when known.'),
};

const spaceAndPeeringShape = {
  ...spaceShape,
  peering: z.string().min(1).describe('Peering id (PCX id). Prefer UUID when known.'),
};

/** Schema for `spaces_create`. The Shield + log_drain_url enforcement (Phase 3
 *  Decision 5) lives on the `inputSchema` shape via a Zod refinement, wrapped
 *  in `superRefine` so the error message references the docs guidance. */
const spacesCreateShape = {
  name: z.string().min(1).describe('Space name. Must be unique within the Heroku account.'),
  team: z.string().min(1).describe('Team that will own the space (id or name).'),
  region: z
    .string()
    .min(1)
    .optional()
    .describe('Region id or name (e.g. "us", "virginia"). Defaults to the team region.'),
  shield: z
    .boolean()
    .optional()
    .describe(
      'When true, provision a Shield Private Space (PCI/HIPAA-compatible posture). REQUIRES log_drain_url at creation time — see the tool description.',
    ),
  cidr: z
    .string()
    .min(1)
    .optional()
    .describe('CIDR block for the space subnet (e.g. "10.0.0.0/16").'),
  data_cidr: z
    .string()
    .min(1)
    .optional()
    .describe('CIDR block for the data-services subnet (e.g. "172.23.0.0/20").'),
  log_drain_url: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Log drain URL. REQUIRED when `shield: true` — Heroku permanently disables log-drain support on Shield spaces created without one. Use https://localhost as a placeholder if you do not yet have a real drain URL.',
    ),
};

/** Register spaces-tier write tools onto the server. */
export function registerSpacesWriteTools(server: McpServer, ctx: ToolContext): void {
  // --------------------------------------------------------------------------
  // Spaces CRUD
  // --------------------------------------------------------------------------

  registerWriteTool<typeof spacesCreateShape, HerokuRecord>(server, ctx, {
    name: 'spaces_create',
    title: 'Create Private Space',
    description:
      'Create a new Private Space. Provisioning takes 8-10 minutes; the response is the initial space record (state="allocating"). Wraps POST /spaces.\n\nShield-type private spaces require a log_drain_url at creation time. If you don\'t have a drain URL configured yet, use https://localhost as a placeholder — you can update it later via log_drains_create. Omitting log_drain_url on a Shield space permanently disables log-drain support on that space.',
    inputSchema: spacesCreateShape,
    build: (args) => {
      // Shield + log_drain_url enforcement: validated here so the call never
      // reaches Heroku without it (the API has no equivalent guard and silently
      // disables log-drain support).
      if (args.shield === true) {
        const drainUrl = args.log_drain_url;
        if (typeof drainUrl !== 'string' || drainUrl.length === 0) {
          throw new InvalidParamsError(
            'spaces_create: log_drain_url is required when shield: true. Heroku permanently disables log-drain support on Shield spaces created without one — pass https://localhost as a placeholder if you do not have a real drain URL yet, and update it later via log_drains_create.',
            { fields: ['log_drain_url'] },
          );
        }
      }
      const body: Record<string, unknown> = { name: args.name, team: args.team };
      if (args.region !== undefined) body.region = args.region;
      if (args.shield !== undefined) body.shield = args.shield;
      if (args.cidr !== undefined) body.cidr = args.cidr;
      if (args.data_cidr !== undefined) body.data_cidr = args.data_cidr;
      if (args.log_drain_url !== undefined) body.log_drain_url = args.log_drain_url;
      return { method: 'POST', path: '/spaces', body };
    },
    describe: (args) => {
      const shield = args.shield === true ? ' (SHIELD)' : '';
      const region = args.region ? `, region=${args.region}` : '';
      const cidr = args.cidr ? `, cidr=${args.cidr}` : '';
      const drain = args.log_drain_url ? `, log_drain_url=${args.log_drain_url}` : '';
      return `Would create Private Space '${args.name}'${shield} for team '${args.team}'${region}${cidr}${drain}. Provisioning takes 8-10 minutes; the initial response will show state="allocating".`;
    },
  });

  registerWriteTool<typeof spacesUpdateShape, HerokuRecord>(server, ctx, {
    name: 'spaces_update',
    title: 'Update Private Space',
    description: 'Update a Private Space (currently: rename). Wraps PATCH /spaces/{id_or_name}.',
    inputSchema: spacesUpdateShape,
    build: (args) => {
      const body: Record<string, unknown> = {};
      if (args.name !== undefined) body.name = args.name;
      return { method: 'PATCH', path: `/spaces/${url(args.space)}`, body };
    },
    describe: (args) => {
      const updates: string[] = [];
      if (args.name !== undefined) updates.push(`name → ${args.name}`);
      const what = updates.length > 0 ? updates.join(', ') : '(no fields)';
      return `Would update space '${args.space}': ${what}.`;
    },
  });

  registerWriteTool<typeof spaceShape, HerokuRecord>(server, ctx, {
    name: 'spaces_destroy',
    title: 'Destroy Private Space',
    description:
      'Destroy a Private Space. Irreversible: all apps in the space, its NAT IPs, peerings, and VPN connections are removed. Wraps DELETE /spaces/{id_or_name}. Destructive: pass confirm matching the space name.',
    inputSchema: spaceShape,
    destructive: {
      targetKind: 'space',
      expectedFromResource: (resource) =>
        typeof resource?.name === 'string' ? resource.name : undefined,
      expectedFromArgs: (args) => args.space,
    },
    preFetch: {
      run: (args) =>
        ctx.client.get<HerokuRecord>(`/spaces/${url(args.space)}`, { tool: 'spaces_destroy' }),
    },
    build: (args) => ({ method: 'DELETE', path: `/spaces/${url(args.space)}` }),
    describe: (args, fetched) => {
      const region =
        fetched?.region && typeof fetched.region === 'object'
          ? ` (region ${(fetched.region as { name?: string }).name ?? 'unknown'})`
          : '';
      const team =
        fetched?.team && typeof fetched.team === 'object'
          ? ` (team ${(fetched.team as { name?: string }).name ?? 'unknown'})`
          : '';
      const shield = fetched?.shield === true ? ' [SHIELD]' : '';
      return `Would destroy Private Space '${args.space}'${region}${team}${shield}. All apps, NAT IPs, peerings, and VPN connections in the space are removed. This is irreversible.`;
    },
  });

  // --------------------------------------------------------------------------
  // VPN connections
  // --------------------------------------------------------------------------

  registerWriteTool<typeof vpnConnectionsCreateShape, HerokuRecord>(server, ctx, {
    name: 'vpn_connections_create',
    title: 'Create VPN connection',
    description:
      "Create a new VPN connection on a Private Space. The response's per-tunnel IPSec pre-shared keys are stripped; retrieve them out-of-band via the Heroku Dashboard or CLI. Wraps POST /spaces/{id_or_name}/vpn-connections.",
    inputSchema: vpnConnectionsCreateShape,
    build: (args) => ({
      method: 'POST',
      path: `/spaces/${url(args.space)}/vpn-connections`,
      body: {
        name: args.name,
        public_ip: args.public_ip,
        routable_cidrs: args.routable_cidrs,
      },
    }),
    describe: (args) =>
      `Would create VPN connection '${args.name}' on space '${args.space}' to public IP ${args.public_ip} for routable CIDRs [${args.routable_cidrs.join(', ')}].`,
    redactResponse: stripVpnPreSharedKeys,
  });

  registerWriteTool<typeof spaceAndVpnShape, HerokuRecord>(server, ctx, {
    name: 'vpn_connections_destroy',
    title: 'Destroy VPN connection',
    description:
      'Destroy a VPN connection on a Private Space. Wraps DELETE /spaces/{id_or_name}/vpn-connections/{id_or_name}. Destructive: pass confirm matching the VPN connection name.',
    inputSchema: spaceAndVpnShape,
    destructive: {
      targetKind: 'vpn_connection',
      expectedFromResource: (resource) =>
        typeof resource?.name === 'string' ? resource.name : undefined,
      expectedFromArgs: (args) => args.vpn,
    },
    preFetch: {
      run: (args) =>
        ctx.client.get<HerokuRecord>(
          `/spaces/${url(args.space)}/vpn-connections/${url(args.vpn)}`,
          { tool: 'vpn_connections_destroy' },
        ),
    },
    build: (args) => ({
      method: 'DELETE',
      path: `/spaces/${url(args.space)}/vpn-connections/${url(args.vpn)}`,
    }),
    describe: (args, fetched) => {
      const ip = typeof fetched?.public_ip === 'string' ? ` (public_ip ${fetched.public_ip})` : '';
      return `Would destroy VPN connection '${args.vpn}' on space '${args.space}'${ip}.`;
    },
  });

  // --------------------------------------------------------------------------
  // Peerings
  // --------------------------------------------------------------------------

  registerWriteTool<typeof peeringsCreateShape, HerokuRecord>(server, ctx, {
    name: 'peerings_create',
    title: 'Create VPC peering',
    description:
      'Initiate a new VPC peering on a Private Space. Wraps POST /spaces/{id_or_name}/peerings. The peering is in `pending` state until accepted from the AWS side.',
    inputSchema: peeringsCreateShape,
    build: (args) => ({
      method: 'POST',
      path: `/spaces/${url(args.space)}/peerings`,
      body: {
        pcx_id: args.pcx_id,
      },
    }),
    describe: (args) =>
      `Would initiate VPC peering on space '${args.space}' with PCX id ${args.pcx_id}.`,
  });

  registerWriteTool<typeof spaceAndPeeringShape, HerokuRecord>(server, ctx, {
    name: 'peerings_destroy',
    title: 'Destroy VPC peering',
    description:
      'Destroy a VPC peering on a Private Space. Wraps DELETE /spaces/{id_or_name}/peerings/{id}. Destructive: pass confirm matching the peering PCX id.',
    inputSchema: spaceAndPeeringShape,
    destructive: {
      targetKind: 'peering',
      expectedFromResource: (resource) => {
        if (typeof resource?.pcx_id === 'string') return resource.pcx_id;
        if (typeof resource?.id === 'string') return resource.id;
        return undefined;
      },
      expectedFromArgs: (args) => args.peering,
    },
    preFetch: {
      run: (args) =>
        ctx.client.get<HerokuRecord>(`/spaces/${url(args.space)}/peerings/${url(args.peering)}`, {
          tool: 'peerings_destroy',
        }),
    },
    build: (args) => ({
      method: 'DELETE',
      path: `/spaces/${url(args.space)}/peerings/${url(args.peering)}`,
    }),
    describe: (args, fetched) => {
      const status = typeof fetched?.status === 'string' ? ` (status ${fetched.status})` : '';
      return `Would destroy VPC peering '${args.peering}' on space '${args.space}'${status}.`;
    },
  });

  // --------------------------------------------------------------------------
  // Space transfer
  // --------------------------------------------------------------------------

  registerWriteTool<typeof spaceTransferCreateShape, HerokuRecord>(server, ctx, {
    name: 'space_transfer_create',
    title: 'Initiate space transfer',
    description:
      'Initiate ownership transfer of a Private Space to a new team. Wraps POST /spaces/{id_or_name}/transfer. The recipient team must accept the transfer separately.',
    inputSchema: spaceTransferCreateShape,
    build: (args) => ({
      method: 'POST',
      path: `/spaces/${url(args.space)}/transfer`,
      body: { new_owner: args.new_owner },
    }),
    describe: (args) =>
      `Would initiate ownership transfer of space '${args.space}' to team '${args.new_owner}'. The recipient must accept the transfer separately.`,
  });

  // --------------------------------------------------------------------------
  // Rulesets (create = "put new current")
  // --------------------------------------------------------------------------

  registerWriteTool<typeof inboundRulesetCreateShape, HerokuRecord>(server, ctx, {
    name: 'spaces_inbound_ruleset_create',
    title: 'Create inbound ruleset',
    description:
      'Replace the active inbound ruleset on a Private Space. Each ruleset is immutable; PUTing a new one creates a new ruleset and marks it current. Wraps PUT /spaces/{id_or_name}/inbound-ruleset.',
    inputSchema: inboundRulesetCreateShape,
    build: (args) => ({
      method: 'PUT',
      path: `/spaces/${url(args.space)}/inbound-ruleset`,
      body: { rules: args.rules },
    }),
    describe: (args) =>
      `Would set a new inbound ruleset on space '${args.space}' with ${args.rules.length} rule(s). The previous ruleset is archived.`,
  });

  registerWriteTool<typeof outboundRulesetCreateShape, HerokuRecord>(server, ctx, {
    name: 'spaces_outbound_ruleset_create',
    title: 'Create outbound ruleset',
    description:
      'Replace the active outbound ruleset on a Private Space. Wraps PUT /spaces/{id_or_name}/outbound-ruleset.',
    inputSchema: outboundRulesetCreateShape,
    build: (args) => ({
      method: 'PUT',
      path: `/spaces/${url(args.space)}/outbound-ruleset`,
      body: { rules: args.rules },
    }),
    describe: (args) =>
      `Would set a new outbound ruleset on space '${args.space}' with ${args.rules.length} rule(s). The previous ruleset is archived.`,
  });
}

// ---- Schemas ----

const spacesUpdateShape = {
  ...spaceShape,
  name: z.string().min(1).optional().describe('New space name. Must be unique on the account.'),
};

const vpnConnectionsCreateShape = {
  ...spaceShape,
  name: z.string().min(1).describe('VPN connection name. Unique within the space.'),
  public_ip: z.string().min(1).describe("Public IPv4 address of the customer's VPN endpoint."),
  routable_cidrs: z
    .array(z.string().min(1))
    .min(1)
    .describe('IPv4 CIDRs routable through this VPN (e.g. ["172.16.0.0/12"]). At least one entry.'),
};

const peeringsCreateShape = {
  ...spaceShape,
  pcx_id: z
    .string()
    .min(1)
    .describe(
      'AWS VPC peering connection id (e.g. "pcx-1234abcd"). Must already exist on the AWS side.',
    ),
};

const spaceTransferCreateShape = {
  ...spaceShape,
  new_owner: z.string().min(1).describe('Recipient team id or name.'),
};

const ruleZodShape = z
  .object({
    action: z.string().min(1).describe('Action: "allow" or "deny".'),
    source: z.string().min(1).describe('Source CIDR in IPv4 notation.'),
  })
  .describe('A single inbound/outbound rule.');

const inboundRulesetCreateShape = {
  ...spaceShape,
  rules: z.array(ruleZodShape).min(1).describe('List of rules for the new inbound ruleset.'),
};

const outboundRulesetCreateShape = {
  ...spaceShape,
  rules: z.array(ruleZodShape).min(1).describe('List of rules for the new outbound ruleset.'),
};
