/**
 * Apps-tier write tools — config vars and app feature flags.
 *
 * Tools registered here:
 *   - config_vars_update  (PATCH; non-destructive — updates are reversible)
 *   - app_features_update (PATCH)
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../context.js';
import type { HerokuRecord } from '../tool-helpers.js';
import { registerWriteTool } from '../write-tool.js';

const url = (s: string): string => encodeURIComponent(s);

/** Mask the values in a config-var map returned by Heroku. The PATCH
 *  config-vars response echoes the app's ENTIRE config-var map in cleartext —
 *  including vars this call never touched (DATABASE_URL, API keys, etc.). We
 *  return the key set with each value masked so callers can confirm what
 *  exists without secrets entering the model context; null (a deleted key) is
 *  preserved so deletions remain visible. Use config_vars_get to read values. */
function maskConfigValues(body: unknown): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body;
  const masked: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    masked[key] = value === null ? null : '***';
  }
  return masked;
}

const appInput = {
  app: z.string().min(1).describe('App id or name. Prefer UUID when known.'),
};

const configVarsUpdateShape = {
  ...appInput,
  config: z
    .record(z.string(), z.union([z.string(), z.null()]))
    .describe(
      'Map of config var name → value. Passing null for a value deletes that var. Empty object is a no-op.',
    ),
};

const appFeaturesUpdateShape = {
  ...appInput,
  feature: z.string().min(1).describe('Feature id or name.'),
  enabled: z.boolean().describe('Target enabled state.'),
};

export function registerConfigWriteTools(server: McpServer, ctx: ToolContext): void {
  registerWriteTool<typeof configVarsUpdateShape, HerokuRecord>(server, ctx, {
    name: 'config_vars_update',
    title: 'Config vars update',
    description:
      'Update or delete config vars on an app. Pass null as a value to delete a key. Heroku triggers a new release on success. The response returns the full config-var key set with values masked — use config_vars_get to read values. Wraps PATCH /apps/{id_or_name}/config-vars.',
    inputSchema: configVarsUpdateShape,
    build: (args) => ({
      method: 'PATCH',
      path: `/apps/${url(args.app)}/config-vars`,
      body: args.config,
    }),
    redactResponse: maskConfigValues,
    describe: (args) => {
      const entries = Object.entries(args.config);
      const sets = entries.filter(([, v]) => v !== null).length;
      const dels = entries.filter(([, v]) => v === null).length;
      return `Would update config vars on app '${args.app}': set ${sets} key(s), delete ${dels} key(s). Triggers a new release.`;
    },
  });

  registerWriteTool<typeof appFeaturesUpdateShape, HerokuRecord>(server, ctx, {
    name: 'app_features_update',
    title: 'App feature update',
    description:
      'Toggle a feature flag on an app. Wraps PATCH /apps/{id_or_name}/features/{feature}.',
    inputSchema: appFeaturesUpdateShape,
    build: (args) => ({
      method: 'PATCH',
      path: `/apps/${url(args.app)}/features/${url(args.feature)}`,
      body: { enabled: args.enabled },
    }),
    describe: (args) =>
      `Would set feature '${args.feature}' on app '${args.app}' to enabled=${args.enabled}.`,
  });
}
