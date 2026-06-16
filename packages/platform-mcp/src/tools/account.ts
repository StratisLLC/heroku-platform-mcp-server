/**
 * Account-tier read-only tools (TOOLS.md "Tier: `account`", read-only entries).
 *
 * Exposed when the account tier probe succeeded. Writes for this tier land in
 * Phase 2.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, paginationInputShape, rangeHeader, runTool } from '../tool-helpers.js';
import type { HerokuList, HerokuRecord } from '../tool-helpers.js';
import type { ToolContext } from '../context.js';

const keyIdInput = {
  key: z.string().min(1).describe('Key id or fingerprint. Prefer id when known.'),
};

const oauthIdInput = {
  id: z.string().min(1).describe('OAuth authorization or client id. UUID when known.'),
};

const invoiceNumberInput = {
  number: z
    .number()
    .int()
    .positive()
    .describe('Invoice number (integer). See `invoices_list` to discover values.'),
};

/** Remove the cleartext `secret` from OAuth client record(s). Heroku returns
 *  the OAuth client secret in `GET /oauth/clients` responses; it is a live
 *  credential and must not enter model context. Handles a single record or a
 *  list. */
function stripClientSecret<T>(body: T): T {
  const strip = (client: unknown): unknown => {
    if (client === null || typeof client !== 'object' || Array.isArray(client)) return client;
    const { secret: _omit, ...rest } = client as Record<string, unknown>;
    return rest;
  };
  if (Array.isArray(body)) return body.map(strip) as T;
  return strip(body) as T;
}

/** Register read-only account-tier tools onto the server. */
export function registerAccountTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'account_info',
    {
      title: 'Account info',
      description: 'Return the authenticated Heroku account record. Wraps GET /account.',
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>('/account', { tool: 'account_info' });
        return ok(res);
      }),
  );

  server.registerTool(
    'account_delinquency_info',
    {
      title: 'Account delinquency',
      description:
        "Return the authenticated account's delinquency state. Wraps GET /account/delinquency.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>('/account/delinquency', {
          tool: 'account_delinquency_info',
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'account_features_list',
    {
      title: 'Account features',
      description:
        'List feature flags on the authenticated account. Paginated. Wraps GET /account/features.',
      inputSchema: { ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>('/account/features', {
          tool: 'account_features_list',
          headers: { Range: rangeHeader(input) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'account_sms_number_get',
    {
      title: 'Account SMS number',
      description: 'Return the SMS number for 2FA. Wraps GET /account/sms-number.',
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>('/account/sms-number', {
          tool: 'account_sms_number_get',
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'keys_list',
    {
      title: 'SSH keys list',
      description: 'List the SSH keys on the account. Paginated. Wraps GET /account/keys.',
      inputSchema: { ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>('/account/keys', {
          tool: 'keys_list',
          headers: { Range: rangeHeader(input) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'keys_info',
    {
      title: 'SSH key info',
      description: 'Return a single SSH key by id or fingerprint. Wraps GET /account/keys/{id}.',
      inputSchema: keyIdInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ key }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(`/account/keys/${encodeURIComponent(key)}`, {
          tool: 'keys_info',
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'oauth_authorizations_list',
    {
      title: 'OAuth authorizations',
      description:
        'List the OAuth authorizations for the account. Wraps GET /oauth/authorizations.',
      inputSchema: { ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>('/oauth/authorizations', {
          tool: 'oauth_authorizations_list',
          headers: { Range: rangeHeader(input) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'oauth_authorizations_info',
    {
      title: 'OAuth authorization info',
      description: 'Return one OAuth authorization. Wraps GET /oauth/authorizations/{id}.',
      inputSchema: oauthIdInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ id }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(
          `/oauth/authorizations/${encodeURIComponent(id)}`,
          { tool: 'oauth_authorizations_info' },
        );
        return ok(res);
      }),
  );

  server.registerTool(
    'oauth_clients_list',
    {
      title: 'OAuth clients',
      description:
        'List the OAuth clients registered on the account. The client `secret` is stripped from the response. Wraps GET /oauth/clients.',
      inputSchema: { ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>('/oauth/clients', {
          tool: 'oauth_clients_list',
          headers: { Range: rangeHeader(input) },
        });
        return ok({ ...res, body: stripClientSecret(res.body) });
      }),
  );

  server.registerTool(
    'oauth_clients_info',
    {
      title: 'OAuth client info',
      description:
        'Return one OAuth client. The client `secret` is stripped from the response. Wraps GET /oauth/clients/{id}.',
      inputSchema: oauthIdInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ id }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(`/oauth/clients/${encodeURIComponent(id)}`, {
          tool: 'oauth_clients_info',
        });
        return ok({ ...res, body: stripClientSecret(res.body) });
      }),
  );

  server.registerTool(
    'invoices_list',
    {
      title: 'Account invoices',
      description: 'List invoices on the account. Paginated. Wraps GET /account/invoices.',
      inputSchema: { ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>('/account/invoices', {
          tool: 'invoices_list',
          headers: { Range: rangeHeader(input) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'invoices_info',
    {
      title: 'Invoice info',
      description: 'Return one invoice. Wraps GET /account/invoices/{number}.',
      inputSchema: invoiceNumberInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ number }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(`/account/invoices/${number}`, {
          tool: 'invoices_info',
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'invoice_address_info',
    {
      title: 'Invoice address',
      description: 'Return the invoice billing address. Wraps GET /account/invoice-address.',
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>('/account/invoice-address', {
          tool: 'invoice_address_info',
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'credits_list',
    {
      title: 'Account credits',
      description: 'List Heroku credits on the account. Wraps GET /account/credits.',
      inputSchema: { ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>('/account/credits', {
          tool: 'credits_list',
          headers: { Range: rangeHeader(input) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'user_preferences_get',
    {
      title: 'User preferences',
      description: 'Return the authenticated user preferences. Wraps GET /users/~/preferences.',
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>('/users/~/preferences', {
          tool: 'user_preferences_get',
        });
        return ok(res);
      }),
  );
}
