/**
 * Account-tier write tools (TOOLS.md "Tier: `account`", write entries).
 *
 * Tools registered here (Phase 2b Decisions 1, 4, 5, 6):
 *
 *   - account_update                   (PATCH)
 *   - account_features_update          (PATCH)
 *   - account_sms_number_recover       (POST)
 *   - keys_create                      (POST)
 *   - keys_delete                      (⚠ DELETE; confirm: <fingerprint>)
 *   - oauth_authorizations_create      (POST)
 *   - oauth_authorizations_delete      (⚠ DELETE; confirm: <id or description>)
 *   - oauth_authorizations_regenerate  (⚠ POST; confirm: <id>)
 *   - invoice_address_update           (PUT)
 *   - credits_create                   (POST)
 *   - user_preferences_update          (PATCH)
 *
 * Intentionally NOT implemented: account_delete (Phase 2b Decision 1 — requires
 * a password header and is dangerous; users should delete via the Heroku
 * Dashboard) and oauth_tokens_create (token-issuance flow, not Phase 2b scope).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../context.js';
import type { HerokuRecord } from '../tool-helpers.js';
import { registerWriteTool } from '../write-tool.js';

const url = (s: string): string => encodeURIComponent(s);

/** Strip the recovered 2FA phone number from an SMS-number record. The recover
 *  endpoint echoes the account's `phone_number`; the caller doesn't need the
 *  digits reflected back into model context to confirm the action succeeded. */
function stripPhoneNumber(body: unknown): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body;
  const { phone_number: _omit, ...rest } = body as Record<string, unknown>;
  return rest;
}

/** Register account-tier write tools onto the server. */
export function registerAccountWriteTools(server: McpServer, ctx: ToolContext): void {
  // --------------------------------------------------------------------------
  // Core account
  // --------------------------------------------------------------------------

  registerWriteTool<typeof accountUpdateShape, HerokuRecord>(server, ctx, {
    name: 'account_update',
    title: 'Account update',
    description:
      'Update the authenticated Heroku account. Wraps PATCH /account. To delete the account itself, use the Heroku Dashboard — account deletion is intentionally not exposed by this MCP.',
    inputSchema: accountUpdateShape,
    build: (args) => {
      const body: Record<string, unknown> = {};
      if (args.name !== undefined) body.name = args.name;
      if (args.beta !== undefined) body.beta = args.beta;
      if (args.allow_tracking !== undefined) body.allow_tracking = args.allow_tracking;
      return { method: 'PATCH', path: '/account', body };
    },
    describe: (args) => {
      const updates: string[] = [];
      if (args.name !== undefined) updates.push(`name → ${args.name}`);
      if (args.beta !== undefined) updates.push(`beta → ${args.beta}`);
      if (args.allow_tracking !== undefined)
        updates.push(`allow_tracking → ${args.allow_tracking}`);
      return `Would update the authenticated Heroku account: ${updates.length > 0 ? updates.join(', ') : '(no fields)'}.`;
    },
  });

  registerWriteTool<typeof accountFeaturesUpdateShape, HerokuRecord>(server, ctx, {
    name: 'account_features_update',
    title: 'Account feature update',
    description: 'Toggle an account feature flag. Wraps PATCH /account/features/{id_or_name}.',
    inputSchema: accountFeaturesUpdateShape,
    build: (args) => ({
      method: 'PATCH',
      path: `/account/features/${url(args.feature)}`,
      body: { enabled: args.enabled },
    }),
    describe: (args) => `Would set account feature '${args.feature}' to enabled=${args.enabled}.`,
  });

  registerWriteTool<Record<string, never>, HerokuRecord>(server, ctx, {
    name: 'account_sms_number_recover',
    title: 'Recover SMS number',
    description:
      'Recover the SMS number used for 2FA on the account. The phone number is stripped from the response. Wraps POST /account/sms-number/actions/recover.',
    inputSchema: {},
    build: () => ({
      method: 'POST',
      path: '/account/sms-number/actions/recover',
      body: null,
    }),
    describe: () => "Would trigger SMS-number recovery for the authenticated account's 2FA.",
    redactResponse: stripPhoneNumber,
  });

  // --------------------------------------------------------------------------
  // SSH keys
  // --------------------------------------------------------------------------

  registerWriteTool<typeof keysCreateShape, HerokuRecord>(server, ctx, {
    name: 'keys_create',
    title: 'Add SSH key',
    description:
      'Upload an SSH public key to the authenticated account. Wraps POST /account/keys. Heroku has been gradually deprecating SSH-key-based deploys, but the endpoint works for users who still rely on it.',
    inputSchema: keysCreateShape,
    build: (args) => ({
      method: 'POST',
      path: '/account/keys',
      body: { public_key: args.public_key },
    }),
    describe: (args) => {
      const preview = args.public_key.slice(0, 40);
      return `Would upload an SSH public key (${preview}…) to the account.`;
    },
  });

  registerWriteTool<typeof keysDeleteShape, HerokuRecord>(server, ctx, {
    name: 'keys_delete',
    title: 'Delete SSH key',
    description:
      'Remove an SSH key from the authenticated account. Wraps DELETE /account/keys/{id_or_fingerprint}. Destructive: pass confirm matching the key fingerprint.',
    inputSchema: keysDeleteShape,
    destructive: {
      targetKind: 'key',
      expectedFromResource: (resource) =>
        typeof resource?.fingerprint === 'string' ? resource.fingerprint : undefined,
      expectedFromArgs: (args) => args.fingerprint,
    },
    preFetch: {
      run: (args) =>
        ctx.client.get<HerokuRecord>(`/account/keys/${url(args.key)}`, {
          tool: 'keys_delete',
        }),
    },
    build: (args) => ({ method: 'DELETE', path: `/account/keys/${url(args.key)}` }),
    describe: (args, fetched) => {
      const comment = typeof fetched?.comment === 'string' ? ` "${fetched.comment}"` : '';
      const created =
        typeof fetched?.created_at === 'string' ? ` (added ${fetched.created_at})` : '';
      return `Would delete SSH key${comment} with fingerprint '${args.fingerprint}'${created} from the account.`;
    },
  });

  // --------------------------------------------------------------------------
  // OAuth authorizations
  // --------------------------------------------------------------------------

  registerWriteTool<typeof oauthAuthorizationsCreateShape, HerokuRecord>(server, ctx, {
    name: 'oauth_authorizations_create',
    title: 'Create OAuth authorization',
    description:
      'Create a new OAuth authorization (and underlying access token) on the authenticated account. Wraps POST /oauth/authorizations. The returned token is a real credential — handle carefully.',
    inputSchema: oauthAuthorizationsCreateShape,
    build: (args) => {
      const body: Record<string, unknown> = {};
      if (args.description !== undefined) body.description = args.description;
      if (args.scope !== undefined) body.scope = args.scope;
      if (args.expires_in !== undefined) body.expires_in = args.expires_in;
      if (args.client !== undefined) body.client = args.client;
      return { method: 'POST', path: '/oauth/authorizations', body };
    },
    describe: (args) => {
      const bits: string[] = [];
      if (args.description) bits.push(`description='${args.description}'`);
      if (args.scope) bits.push(`scope=[${args.scope.join(', ')}]`);
      if (args.expires_in !== undefined) bits.push(`expires_in=${args.expires_in}s`);
      return `Would create a new OAuth authorization${bits.length > 0 ? ` (${bits.join(', ')})` : ''}.`;
    },
  });

  registerWriteTool<typeof oauthAuthorizationsDeleteShape, HerokuRecord>(server, ctx, {
    name: 'oauth_authorizations_delete',
    title: 'Delete OAuth authorization',
    description:
      'Revoke an OAuth authorization. Wraps DELETE /oauth/authorizations/{id}. Destructive: pass confirm matching the authorization id or its description.',
    inputSchema: oauthAuthorizationsDeleteShape,
    destructive: {
      targetKind: 'oauth_authorization',
      // Heroku stores a `description` (often the user-friendly name) and an
      // `id` (UUID). Prefer description; fall back to id if blank.
      expectedFromResource: (resource) => {
        if (typeof resource?.description === 'string' && resource.description !== '') {
          return resource.description;
        }
        if (typeof resource?.id === 'string') return resource.id;
        return undefined;
      },
      expectedFromArgs: (args) => args.confirm_target,
    },
    preFetch: {
      run: (args) =>
        ctx.client.get<HerokuRecord>(`/oauth/authorizations/${url(args.id)}`, {
          tool: 'oauth_authorizations_delete',
        }),
    },
    build: (args) => ({ method: 'DELETE', path: `/oauth/authorizations/${url(args.id)}` }),
    describe: (args, fetched) => {
      const description =
        typeof fetched?.description === 'string' ? ` "${fetched.description}"` : '';
      const scope =
        Array.isArray(fetched?.scope) && fetched.scope.length > 0
          ? ` scope=[${(fetched.scope as string[]).join(', ')}]`
          : '';
      const created =
        typeof fetched?.created_at === 'string' ? ` (created ${fetched.created_at})` : '';
      return `Would revoke OAuth authorization '${args.id}'${description}${scope}${created}.`;
    },
  });

  registerWriteTool<typeof oauthAuthorizationsRegenerateShape, HerokuRecord>(server, ctx, {
    name: 'oauth_authorizations_regenerate',
    title: 'Regenerate OAuth tokens',
    description:
      'Regenerate the access/refresh tokens for an OAuth authorization. Old tokens stop working immediately. Wraps POST /oauth/authorizations/{id}/actions/regenerate-tokens. Destructive: pass confirm matching the authorization id.',
    inputSchema: oauthAuthorizationsRegenerateShape,
    destructive: {
      targetKind: 'oauth_authorization',
      expectedFromResource: (resource) =>
        typeof resource?.id === 'string' ? resource.id : undefined,
      expectedFromArgs: (args) => args.id,
    },
    preFetch: {
      run: (args) =>
        ctx.client.get<HerokuRecord>(`/oauth/authorizations/${url(args.id)}`, {
          tool: 'oauth_authorizations_regenerate',
        }),
    },
    build: (args) => ({
      method: 'POST',
      path: `/oauth/authorizations/${url(args.id)}/actions/regenerate-tokens`,
      body: null,
    }),
    describe: (args) =>
      `Would regenerate tokens for OAuth authorization '${args.id}'. Existing access/refresh tokens for this authorization stop working immediately.`,
  });

  // --------------------------------------------------------------------------
  // Billing / preferences
  // --------------------------------------------------------------------------

  registerWriteTool<typeof invoiceAddressUpdateShape, HerokuRecord>(server, ctx, {
    name: 'invoice_address_update',
    title: 'Invoice address update',
    description:
      'Update the invoice billing address on the authenticated account. Wraps PUT /account/invoice-address.',
    inputSchema: invoiceAddressUpdateShape,
    build: (args) => {
      const body: Record<string, unknown> = {};
      if (args.address_1 !== undefined) body.address_1 = args.address_1;
      if (args.address_2 !== undefined) body.address_2 = args.address_2;
      if (args.city !== undefined) body.city = args.city;
      if (args.country !== undefined) body.country = args.country;
      if (args.postal_code !== undefined) body.postal_code = args.postal_code;
      if (args.state !== undefined) body.state = args.state;
      if (args.heroku_tax_number !== undefined) body.heroku_tax_number = args.heroku_tax_number;
      if (args.other !== undefined) body.other = args.other;
      if (args.use_invoice_address !== undefined)
        body.use_invoice_address = args.use_invoice_address;
      return { method: 'PUT', path: '/account/invoice-address', body };
    },
    describe: (args) => {
      const fields = Object.entries(args).filter(([, v]) => v !== undefined);
      return `Would update invoice address (${fields.length} field${fields.length === 1 ? '' : 's'}).`;
    },
  });

  registerWriteTool<typeof creditsCreateShape, HerokuRecord>(server, ctx, {
    name: 'credits_create',
    title: 'Create credit',
    description: 'Apply a credit code to the authenticated account. Wraps POST /account/credits.',
    inputSchema: creditsCreateShape,
    build: (args) => {
      const body: Record<string, unknown> = { code: args.code };
      if (args.amount !== undefined) body.amount = args.amount;
      return { method: 'POST', path: '/account/credits', body };
    },
    describe: (args) =>
      `Would redeem credit code '${args.code}'${args.amount !== undefined ? ` (amount ${args.amount})` : ''}.`,
  });

  registerWriteTool<typeof userPreferencesUpdateShape, HerokuRecord>(server, ctx, {
    name: 'user_preferences_update',
    title: 'User preferences update',
    description:
      'Update the authenticated user preferences (timezone, default region, etc.). Pass-through: only the keys you supply are updated. Wraps PATCH /users/~/preferences.',
    inputSchema: userPreferencesUpdateShape,
    build: (args) => ({ method: 'PATCH', path: '/users/~/preferences', body: args.preferences }),
    describe: (args) => {
      const keys = Object.keys(args.preferences);
      return `Would update user preferences: ${keys.length > 0 ? keys.join(', ') : '(no fields)'}.`;
    },
  });
}

// ---- Schemas ----

const accountUpdateShape = {
  name: z.string().min(1).optional().describe('Display name on the account.'),
  beta: z
    .boolean()
    .optional()
    .describe('When true, opt into Heroku beta features. When false, opt out.'),
  allow_tracking: z
    .boolean()
    .optional()
    .describe('When true, allow Heroku to track usage analytics from the account.'),
};

const accountFeaturesUpdateShape = {
  feature: z.string().min(1).describe('Account feature id or name.'),
  enabled: z.boolean().describe('Target enabled state.'),
};

const keysCreateShape = {
  public_key: z
    .string()
    .min(1)
    .describe('SSH public key (OpenSSH format, e.g. "ssh-ed25519 AAAA... user@host").'),
};

const keysDeleteShape = {
  key: z
    .string()
    .min(1)
    .describe('Key id or fingerprint as understood by Heroku (e.g. "aa:bb:..." or a UUID).'),
  fingerprint: z
    .string()
    .min(1)
    .describe(
      "Key fingerprint, used as the confirm target. Must match the key's fingerprint exactly.",
    ),
};

const oauthAuthorizationsCreateShape = {
  description: z.string().min(1).optional().describe('Human-readable description of the token.'),
  scope: z
    .array(z.string().min(1))
    .optional()
    .describe('Scope strings (e.g. ["global", "read", "read-protected"]).'),
  expires_in: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Lifetime in seconds. Heroku enforces a per-account maximum.'),
  client: z
    .string()
    .min(1)
    .optional()
    .describe('OAuth client id this authorization is for. Defaults to "self" when omitted.'),
};

const oauthAuthorizationsDeleteShape = {
  id: z.string().min(1).describe('OAuth authorization id (UUID).'),
  confirm_target: z
    .string()
    .min(1)
    .describe(
      'Value passed as `confirm`. Use either the authorization id or its description, depending on what the user used to identify it.',
    ),
};

const oauthAuthorizationsRegenerateShape = {
  id: z.string().min(1).describe('OAuth authorization id (UUID).'),
};

const invoiceAddressUpdateShape = {
  address_1: z.string().min(1).optional().describe('Address line 1.'),
  address_2: z.string().min(1).optional().describe('Address line 2.'),
  city: z.string().min(1).optional().describe('City.'),
  country: z.string().min(1).optional().describe('Country.'),
  postal_code: z.string().min(1).optional().describe('Postal / ZIP code.'),
  state: z.string().min(1).optional().describe('State / region.'),
  heroku_tax_number: z
    .string()
    .min(1)
    .optional()
    .describe('Heroku-internal tax number (rarely populated by callers).'),
  other: z
    .string()
    .min(1)
    .optional()
    .describe('Free-form notes Heroku accepts on the invoice address.'),
  use_invoice_address: z
    .boolean()
    .optional()
    .describe('When true, future invoices use this address rather than the account default.'),
};

const creditsCreateShape = {
  code: z.string().min(1).describe('Credit code (e.g. a Heroku promo code).'),
  amount: z
    .number()
    .optional()
    .describe('Optional amount override; Heroku ignores this for most codes.'),
};

const userPreferencesUpdateShape = {
  preferences: z
    .record(z.string(), z.unknown())
    .describe(
      'Map of preference keys to values. Pass-through — forwarded verbatim to Heroku. Common keys include timezone, default-organization, dismissed-* announcement flags.',
    ),
};
