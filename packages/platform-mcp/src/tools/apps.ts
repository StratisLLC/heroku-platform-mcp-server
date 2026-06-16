/**
 * Apps-tier read-only tools (TOOLS.md "Tier: `apps`", read-only entries).
 *
 * Exposed when the apps tier probe succeeded. Writes for this tier land in
 * Phase 2.
 *
 * Naming: identifiers accept either a UUID or a human name where Heroku does;
 * tool descriptions note `prefer UUID` per ARCHITECTURE.md §8.2.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, paginationInputShape, rangeHeader, runTool } from '../tool-helpers.js';
import type { HerokuList, HerokuRecord } from '../tool-helpers.js';
import type { ToolContext } from '../context.js';
import { envelopeFromLocal } from '../envelope.js';

const appInput = {
  app: z.string().min(1).describe('App id or name. Prefer UUID when known.'),
};

const appAndFeatureInput = {
  ...appInput,
  feature: z.string().min(1).describe('Feature id or name.'),
};

const appAndDynoInput = {
  ...appInput,
  dyno: z.string().min(1).describe('Dyno id or name.'),
};

const appAndReleaseInput = {
  ...appInput,
  release: z
    .string()
    .min(1)
    .describe('Release id or numeric version. Strings are passed verbatim to Heroku.'),
};

const appAndBuildInput = {
  ...appInput,
  build: z.string().min(1).describe('Build id (UUID).'),
};

const appAndSlugInput = {
  ...appInput,
  slug: z.string().min(1).describe('Slug id (UUID).'),
};

const appAndDomainInput = {
  ...appInput,
  domain: z.string().min(1).describe('Domain id or hostname.'),
};

const appAndSniInput = {
  ...appInput,
  endpoint: z.string().min(1).describe('SNI endpoint id or name.'),
};

const appAndLogDrainInput = {
  ...appInput,
  drain: z.string().min(1).describe('Log drain id, URL, or token.'),
};

const appAndWebhookInput = {
  ...appInput,
  webhook: z.string().min(1).describe('App webhook id (UUID).'),
};

const appAndDeliveryInput = {
  ...appInput,
  delivery: z.string().min(1).describe('App webhook delivery id (UUID).'),
};

const appAndEventInput = {
  ...appInput,
  event: z.string().min(1).describe('App webhook event id (UUID).'),
};

const appAndCollaboratorInput = {
  ...appInput,
  collaborator: z.string().min(1).describe('Collaborator id or email.'),
};

const transferIdInput = {
  transfer: z.string().min(1).describe('App transfer id or name. Prefer UUID.'),
};

const url = (s: string): string => encodeURIComponent(s);

function idOf(app: HerokuRecord): string | null {
  const id = app.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function nameOf(app: HerokuRecord): string {
  const n = app.name;
  return typeof n === 'string' ? n : '';
}

/** Register read-only apps-tier tools onto the server. */
export function registerAppsTools(server: McpServer, ctx: ToolContext): void {
  // --------------------------------------------------------------------------
  // Apps
  // --------------------------------------------------------------------------

  server.registerTool(
    'apps_list',
    {
      title: 'Apps list',
      description:
        'List Heroku apps the authenticated user has direct access to (personal + explicit collaborator), paginated. For the full union across every team use apps_list_all; for a single team use team_apps_list. Wraps GET /apps.',
      inputSchema: { ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>('/apps', {
          tool: 'apps_list',
          headers: { Range: rangeHeader(input) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'apps_list_all',
    {
      title: 'Apps list (all, including teams)',
      description:
        'Return the union of every Heroku app the authenticated user can access — personal apps, collaborator apps, AND apps owned by every team the user belongs to. Equivalent to `heroku apps:list --all`. Makes N+1 API calls (one for /apps, one for /teams, one per team). Slow for users in many teams; prefer apps_list or team_apps_list when you know exactly what slice you want. Returns `{apps, summary}` where summary carries personal_count, team_count, teams_queried, failed_teams, total_unique.',
      inputSchema: { ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) =>
      runTool(async () => {
        // 1. Personal apps (the only paginated call — caller may slice).
        const personalRes = await ctx.client.get<HerokuList>('/apps', {
          tool: 'apps_list_all',
          headers: { Range: rangeHeader(input) },
        });
        const personalApps = personalRes.body ?? [];

        // 2. Teams the user belongs to. Pull a full page (max 1000) since
        //    we have no way to recurse here.
        let teams: HerokuList = [];
        try {
          const teamsRes = await ctx.client.get<HerokuList>('/teams', {
            tool: 'apps_list_all',
            headers: { Range: rangeHeader({ page_size: 1000 }) },
          });
          teams = teamsRes.body ?? [];
        } catch {
          // No teams access (403/404 etc.) is fine — return just personal.
          teams = [];
        }

        // 3. Team apps in parallel; failures recorded, not thrown.
        const failedTeams: { name: string; reason: string }[] = [];
        const teamAppLists = await Promise.all(
          teams.map(async (t) => {
            const id = typeof t.id === 'string' || typeof t.id === 'number' ? String(t.id) : '';
            const name = typeof t.name === 'string' ? t.name : id;
            if (!name) return [];
            try {
              const res = await ctx.client.get<HerokuList>(
                `/teams/${encodeURIComponent(name)}/apps`,
                {
                  tool: 'apps_list_all',
                  headers: { Range: rangeHeader({ page_size: 1000 }) },
                },
              );
              return res.body ?? [];
            } catch (err) {
              failedTeams.push({
                name,
                reason: err instanceof Error ? err.message : String(err),
              });
              return [];
            }
          }),
        );

        // 4. Dedupe by id, sort deterministically by (name, id).
        const byId = new Map<string, HerokuRecord>();
        for (const app of personalApps) {
          const id = idOf(app);
          if (id) byId.set(id, app);
        }
        for (const list of teamAppLists) {
          for (const app of list) {
            const id = idOf(app);
            if (id && !byId.has(id)) byId.set(id, app);
          }
        }
        const apps = [...byId.values()].sort((a, b) => {
          const na = nameOf(a);
          const nb = nameOf(b);
          if (na !== nb) return na < nb ? -1 : 1;
          const ia = idOf(a) ?? '';
          const ib = idOf(b) ?? '';
          return ia < ib ? -1 : ia > ib ? 1 : 0;
        });

        return envelopeFromLocal({
          apps,
          summary: {
            personal_count: personalApps.length,
            team_count: teams.length,
            teams_queried: teams.length,
            failed_teams: failedTeams,
            total_unique: apps.length,
          },
        });
      }),
  );

  server.registerTool(
    'apps_list_owned',
    {
      title: 'Apps owned by user',
      description:
        "List apps owned by the authenticated user (excludes apps the user has access to but doesn't own). Wraps GET /users/~/apps.",
      inputSchema: { ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>('/users/~/apps', {
          tool: 'apps_list_owned',
          headers: { Range: rangeHeader(input) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'apps_info',
    {
      title: 'App info',
      description: 'Return one app by id or name. Wraps GET /apps/{id_or_name}.',
      inputSchema: appInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ app }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(`/apps/${url(app)}`, { tool: 'apps_info' });
        return ok(res);
      }),
  );

  server.registerTool(
    'apps_filter',
    {
      title: 'Apps filter',
      description:
        'Return multiple apps in one call, filtered by id. Wraps POST /filters/apps. This is a read filter despite the POST verb — body is a query, not a mutation.',
      inputSchema: {
        in: z
          .object({
            id: z.array(z.string().min(1)).min(1).describe('List of app ids to look up.'),
          })
          .describe('Filter object passed to Heroku verbatim.'),
        ...paginationInputShape,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ in: filter, page_size, cursor }) =>
      runTool(async () => {
        const headers: Record<string, string> = {
          Range: rangeHeader({ page_size, cursor }),
        };
        const res = await ctx.client.post<HerokuList>(
          '/filters/apps',
          { in: filter },
          { tool: 'apps_filter', headers, idempotent: true },
        );
        return ok(res);
      }),
  );

  // --------------------------------------------------------------------------
  // App Features
  // --------------------------------------------------------------------------

  server.registerTool(
    'app_features_list',
    {
      title: 'App features',
      description: 'List feature flags on an app. Wraps GET /apps/{id_or_name}/features.',
      inputSchema: { ...appInput, ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ app, page_size, cursor }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(`/apps/${url(app)}/features`, {
          tool: 'app_features_list',
          headers: { Range: rangeHeader({ page_size, cursor }) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'app_features_info',
    {
      title: 'App feature info',
      description: 'Return one app feature flag. Wraps GET /apps/{id_or_name}/features/{feature}.',
      inputSchema: appAndFeatureInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ app, feature }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(
          `/apps/${url(app)}/features/${url(feature)}`,
          { tool: 'app_features_info' },
        );
        return ok(res);
      }),
  );

  // --------------------------------------------------------------------------
  // Config Vars
  // --------------------------------------------------------------------------

  server.registerTool(
    'config_vars_get',
    {
      title: 'Config vars',
      description:
        'Return the current config vars for an app. Values are returned in cleartext per Heroku — this tool intentionally bypasses redaction so callers can read their own secrets. Wraps GET /apps/{id_or_name}/config-vars.',
      inputSchema: appInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ app }) =>
      runTool(async () => {
        const res = await ctx.client.get<Record<string, string | null>>(
          `/apps/${url(app)}/config-vars`,
          { tool: 'config_vars_get' },
        );
        return ok(res);
      }),
  );

  server.registerTool(
    'config_vars_get_release',
    {
      title: 'Config vars (release)',
      description:
        'Return the config vars as they were at a specific release. Values are returned in cleartext per Heroku — this tool intentionally bypasses redaction so callers can read their own secrets. Wraps GET /apps/{id_or_name}/releases/{release}/config-vars.',
      inputSchema: appAndReleaseInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ app, release }) =>
      runTool(async () => {
        const res = await ctx.client.get<Record<string, string | null>>(
          `/apps/${url(app)}/releases/${url(release)}/config-vars`,
          { tool: 'config_vars_get_release' },
        );
        return ok(res);
      }),
  );

  // --------------------------------------------------------------------------
  // Formation & Dynos
  // --------------------------------------------------------------------------

  server.registerTool(
    'formation_list',
    {
      title: 'Formation list',
      description:
        "List an app's formation (process types). Wraps GET /apps/{id_or_name}/formation.",
      inputSchema: appInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ app }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(`/apps/${url(app)}/formation`, {
          tool: 'formation_list',
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'formation_info',
    {
      title: 'Formation info',
      description:
        'Return one process type formation. Wraps GET /apps/{id_or_name}/formation/{type}.',
      inputSchema: {
        ...appInput,
        type: z.string().min(1).describe('Process type name (e.g. "web", "worker").'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ app, type }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(`/apps/${url(app)}/formation/${url(type)}`, {
          tool: 'formation_info',
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'dyno_sizes_list',
    {
      title: 'Dyno sizes',
      description: 'List the dyno sizes Heroku exposes. Wraps GET /dyno-sizes.',
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>('/dyno-sizes', { tool: 'dyno_sizes_list' });
        return ok(res);
      }),
  );

  server.registerTool(
    'dynos_list',
    {
      title: 'Dynos list',
      description: 'List running dynos for an app. Wraps GET /apps/{id_or_name}/dynos.',
      inputSchema: { ...appInput, ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ app, page_size, cursor }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(`/apps/${url(app)}/dynos`, {
          tool: 'dynos_list',
          headers: { Range: rangeHeader({ page_size, cursor }) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'dynos_info',
    {
      title: 'Dyno info',
      description:
        'Return one dyno by id or name. Wraps GET /apps/{id_or_name}/dynos/{id_or_name}.',
      inputSchema: appAndDynoInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ app, dyno }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(`/apps/${url(app)}/dynos/${url(dyno)}`, {
          tool: 'dynos_info',
        });
        return ok(res);
      }),
  );

  // --------------------------------------------------------------------------
  // Releases
  // --------------------------------------------------------------------------

  server.registerTool(
    'releases_list',
    {
      title: 'Releases list',
      description: 'List releases on an app. Wraps GET /apps/{id_or_name}/releases.',
      inputSchema: { ...appInput, ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ app, page_size, cursor }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(`/apps/${url(app)}/releases`, {
          tool: 'releases_list',
          headers: { Range: rangeHeader({ page_size, cursor }) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'releases_info',
    {
      title: 'Release info',
      description:
        'Return one release by id or version. Wraps GET /apps/{id_or_name}/releases/{id_or_version}.',
      inputSchema: appAndReleaseInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ app, release }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(
          `/apps/${url(app)}/releases/${url(release)}`,
          { tool: 'releases_info' },
        );
        return ok(res);
      }),
  );

  // --------------------------------------------------------------------------
  // Builds & Slugs
  // --------------------------------------------------------------------------

  server.registerTool(
    'builds_list',
    {
      title: 'Builds list',
      description: 'List builds on an app. Wraps GET /apps/{id_or_name}/builds.',
      inputSchema: { ...appInput, ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ app, page_size, cursor }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(`/apps/${url(app)}/builds`, {
          tool: 'builds_list',
          headers: { Range: rangeHeader({ page_size, cursor }) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'builds_info',
    {
      title: 'Build info',
      description: 'Return one build. Wraps GET /apps/{id_or_name}/builds/{id}.',
      inputSchema: appAndBuildInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ app, build }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(`/apps/${url(app)}/builds/${url(build)}`, {
          tool: 'builds_info',
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'buildpack_installations_list',
    {
      title: 'Buildpack installations',
      description:
        "List an app's buildpack installations. Wraps GET /apps/{id_or_name}/buildpack-installations.",
      inputSchema: { ...appInput, ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ app, page_size, cursor }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(`/apps/${url(app)}/buildpack-installations`, {
          tool: 'buildpack_installations_list',
          headers: { Range: rangeHeader({ page_size, cursor }) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'slugs_info',
    {
      title: 'Slug info',
      description: 'Return one slug. Wraps GET /apps/{id_or_name}/slugs/{id}.',
      inputSchema: appAndSlugInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ app, slug }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(`/apps/${url(app)}/slugs/${url(slug)}`, {
          tool: 'slugs_info',
        });
        return ok(res);
      }),
  );

  // --------------------------------------------------------------------------
  // Domains & SSL
  // --------------------------------------------------------------------------

  server.registerTool(
    'domains_list',
    {
      title: 'Domains list',
      description: 'List custom domains on an app. Wraps GET /apps/{id_or_name}/domains.',
      inputSchema: { ...appInput, ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ app, page_size, cursor }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(`/apps/${url(app)}/domains`, {
          tool: 'domains_list',
          headers: { Range: rangeHeader({ page_size, cursor }) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'domains_info',
    {
      title: 'Domain info',
      description:
        'Return one custom domain by id or hostname. Wraps GET /apps/{id_or_name}/domains/{id_or_hostname}.',
      inputSchema: appAndDomainInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ app, domain }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(`/apps/${url(app)}/domains/${url(domain)}`, {
          tool: 'domains_info',
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'sni_endpoints_list',
    {
      title: 'SNI endpoints list',
      description: 'List SNI endpoints on an app. Wraps GET /apps/{id_or_name}/sni-endpoints.',
      inputSchema: { ...appInput, ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ app, page_size, cursor }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(`/apps/${url(app)}/sni-endpoints`, {
          tool: 'sni_endpoints_list',
          headers: { Range: rangeHeader({ page_size, cursor }) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'sni_endpoints_info',
    {
      title: 'SNI endpoint info',
      description:
        'Return one SNI endpoint. Wraps GET /apps/{id_or_name}/sni-endpoints/{id_or_name}.',
      inputSchema: appAndSniInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ app, endpoint }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(
          `/apps/${url(app)}/sni-endpoints/${url(endpoint)}`,
          { tool: 'sni_endpoints_info' },
        );
        return ok(res);
      }),
  );

  // --------------------------------------------------------------------------
  // Logs
  // --------------------------------------------------------------------------

  server.registerTool(
    'log_drains_list',
    {
      title: 'Log drains list',
      description: 'List log drains on an app. Wraps GET /apps/{id_or_name}/log-drains.',
      inputSchema: { ...appInput, ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ app, page_size, cursor }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(`/apps/${url(app)}/log-drains`, {
          tool: 'log_drains_list',
          headers: { Range: rangeHeader({ page_size, cursor }) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'log_drains_info',
    {
      title: 'Log drain info',
      description:
        'Return one log drain by id, URL, or token. Wraps GET /apps/{id_or_name}/log-drains/{id_or_url_or_token}.',
      inputSchema: appAndLogDrainInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ app, drain }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(
          `/apps/${url(app)}/log-drains/${url(drain)}`,
          { tool: 'log_drains_info' },
        );
        return ok(res);
      }),
  );

  server.registerTool(
    'telemetry_drains_list',
    {
      title: 'Telemetry drains',
      description:
        'List telemetry drains visible to the caller. Wraps GET /telemetry-drains. Note: Heroku scopes telemetry drains globally rather than per-app, hence no `app` param.',
      inputSchema: { ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>('/telemetry-drains', {
          tool: 'telemetry_drains_list',
          headers: { Range: rangeHeader(input) },
        });
        return ok(res);
      }),
  );

  // --------------------------------------------------------------------------
  // Webhooks
  // --------------------------------------------------------------------------

  server.registerTool(
    'app_webhooks_list',
    {
      title: 'App webhooks list',
      description: 'List webhooks on an app. Wraps GET /apps/{id_or_name}/webhooks.',
      inputSchema: { ...appInput, ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ app, page_size, cursor }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(`/apps/${url(app)}/webhooks`, {
          tool: 'app_webhooks_list',
          headers: { Range: rangeHeader({ page_size, cursor }) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'app_webhooks_info',
    {
      title: 'App webhook info',
      description: 'Return one app webhook. Wraps GET /apps/{id_or_name}/webhooks/{id}.',
      inputSchema: appAndWebhookInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ app, webhook }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(
          `/apps/${url(app)}/webhooks/${url(webhook)}`,
          { tool: 'app_webhooks_info' },
        );
        return ok(res);
      }),
  );

  server.registerTool(
    'app_webhook_deliveries_list',
    {
      title: 'App webhook deliveries',
      description:
        'List webhook deliveries for an app. Wraps GET /apps/{id_or_name}/webhook-deliveries.',
      inputSchema: { ...appInput, ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ app, page_size, cursor }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(`/apps/${url(app)}/webhook-deliveries`, {
          tool: 'app_webhook_deliveries_list',
          headers: { Range: rangeHeader({ page_size, cursor }) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'app_webhook_deliveries_info',
    {
      title: 'App webhook delivery info',
      description:
        'Return one webhook delivery. Wraps GET /apps/{id_or_name}/webhook-deliveries/{id}.',
      inputSchema: appAndDeliveryInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ app, delivery }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(
          `/apps/${url(app)}/webhook-deliveries/${url(delivery)}`,
          { tool: 'app_webhook_deliveries_info' },
        );
        return ok(res);
      }),
  );

  server.registerTool(
    'app_webhook_events_list',
    {
      title: 'App webhook events',
      description: 'List webhook events for an app. Wraps GET /apps/{id_or_name}/webhook-events.',
      inputSchema: { ...appInput, ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ app, page_size, cursor }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(`/apps/${url(app)}/webhook-events`, {
          tool: 'app_webhook_events_list',
          headers: { Range: rangeHeader({ page_size, cursor }) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'app_webhook_events_info',
    {
      title: 'App webhook event info',
      description: 'Return one webhook event. Wraps GET /apps/{id_or_name}/webhook-events/{id}.',
      inputSchema: appAndEventInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ app, event }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(
          `/apps/${url(app)}/webhook-events/${url(event)}`,
          { tool: 'app_webhook_events_info' },
        );
        return ok(res);
      }),
  );

  // --------------------------------------------------------------------------
  // Collaborators & Transfers
  // --------------------------------------------------------------------------

  server.registerTool(
    'collaborators_list',
    {
      title: 'Collaborators list',
      description: 'List collaborators on an app. Wraps GET /apps/{id_or_name}/collaborators.',
      inputSchema: { ...appInput, ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ app, page_size, cursor }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>(`/apps/${url(app)}/collaborators`, {
          tool: 'collaborators_list',
          headers: { Range: rangeHeader({ page_size, cursor }) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'collaborators_info',
    {
      title: 'Collaborator info',
      description:
        'Return one collaborator by id or email. Wraps GET /apps/{id_or_name}/collaborators/{id_or_email}.',
      inputSchema: appAndCollaboratorInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ app, collaborator }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(
          `/apps/${url(app)}/collaborators/${url(collaborator)}`,
          { tool: 'collaborators_info' },
        );
        return ok(res);
      }),
  );

  server.registerTool(
    'app_transfers_list',
    {
      title: 'App transfers',
      description: 'List pending app transfers on the account. Wraps GET /account/app-transfers.',
      inputSchema: { ...paginationInputShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuList>('/account/app-transfers', {
          tool: 'app_transfers_list',
          headers: { Range: rangeHeader(input) },
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'app_transfers_info',
    {
      title: 'App transfer info',
      description:
        'Return one app transfer by id or app name. Wraps GET /account/app-transfers/{id_or_name}.',
      inputSchema: transferIdInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ transfer }) =>
      runTool(async () => {
        const res = await ctx.client.get<HerokuRecord>(`/account/app-transfers/${url(transfer)}`, {
          tool: 'app_transfers_info',
        });
        return ok(res);
      }),
  );
}
