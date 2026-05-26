/**
 * Diagnostic tools — always exposed, even when the account tier is in
 * diagnostic-only mode (delinquent / suspended) or every probe failed.
 *
 *   whoami              — wraps GET /account
 *   refresh_capabilities — re-runs the probe matrix, emits tools/list_changed
 *   rate_limit_status   — wraps GET /account/rate-limits (doesn't consume budget)
 *   audit_tail          — reads recent local audit lines (no network)
 *   schema_info         — reports the cached Heroku schema's version + age
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { envelopeFromLocal } from '../envelope.js';
import { ok, runTool } from '../tool-helpers.js';
import type { ToolContext } from '../context.js';

/** Heroku /account body — just the subset we touch directly. */
interface HerokuAccount {
  id: string;
  email: string;
  name?: string | null;
  default_organization?: { id: string; name: string } | null;
  default_team?: { id: string; name: string } | null;
  federated?: boolean;
  two_factor_authentication?: boolean;
  verified?: boolean;
}

/** Heroku /account/rate-limits body. */
interface HerokuRateLimit {
  remaining: number;
}

/** Register the always-on diagnostic tools onto the server. */
export function registerDiagnosticTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'whoami',
    {
      title: 'Who am I?',
      description:
        'Return the Heroku account associated with the configured token (email, id, federated status, default team). Wraps GET /account.',
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuAccount>('/account', { tool: 'whoami' });
        return ok(res);
      }),
  );

  server.registerTool(
    'refresh_capabilities',
    {
      title: 'Refresh capability probes',
      description:
        'Re-run the capability probe matrix against Heroku. Updates the on-disk capability cache and emits notifications/tools/list_changed so MCP hosts re-fetch the tool list.',
      inputSchema: {
        force: z
          .boolean()
          .optional()
          .describe(
            'When true, ignore the cache freshness check and always re-probe. Defaults to true for this tool.',
          ),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ force }) =>
      runTool(async () => {
        const capabilities = await ctx.refreshCapabilities({ force: force ?? true });
        server.sendToolListChanged();
        return envelopeFromLocal(capabilities);
      }),
  );

  server.registerTool(
    'rate_limit_status',
    {
      title: 'Rate-limit status',
      description:
        "Return the current per-hour Heroku rate-limit remaining count. Doesn't consume rate-limit budget. Wraps GET /account/rate-limits.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRateLimit>('/account/rate-limits', {
          tool: 'rate_limit_status',
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'audit_tail',
    {
      title: 'Audit log tail',
      description:
        "Read the last N entries from today's local audit log (mutating Heroku calls). Phase 1 has no writes; expect an empty tail.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe('Number of trailing entries to return (default 50, max 1000).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit }) =>
      runTool(async () => {
        const entries = await ctx.audit.tail(limit ?? 50);
        return envelopeFromLocal({ entries });
      }),
  );

  server.registerTool(
    'schema_info',
    {
      title: 'Heroku schema info',
      description:
        'Report metadata about the cached Heroku JSON schema (definitions count, when it was last fetched). Does not contact Heroku.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      runTool(async () => {
        const envelope = await ctx.schema.readCache();
        if (!envelope) {
          return envelopeFromLocal({
            present: false,
            schemaCachePath: ctx.paths.schemaCachePath,
          });
        }
        const definitionsCount = envelope.schema.definitions
          ? Object.keys(envelope.schema.definitions).length
          : 0;
        return envelopeFromLocal({
          present: true,
          schemaCachePath: ctx.paths.schemaCachePath,
          storedAt: new Date(envelope.storedAt).toISOString(),
          etag: envelope.etag,
          definitionsCount,
        });
      }),
  );
}
