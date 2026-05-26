/**
 * Apps-tier write tools — core apps lifecycle (TOOLS.md "Tier: `apps` → Apps").
 *
 * Tools registered here:
 *   - apps_create        (POST)
 *   - apps_update        (PATCH, supports ETag concurrency)
 *   - apps_delete        (⚠ DELETE, confirm: <app name>)
 *   - apps_enable_acm    (POST)
 *   - apps_disable_acm   (⚠ DELETE, confirm: <app name>)
 *   - apps_refresh_acm   (PATCH)
 *
 * `apps_create` is in TOOLS.md but was omitted from the Phase 2a write list
 * in the handoff prompt; it's added here so the integration test can create
 * scratch apps (see notes/divergences.md entry "Phase 2a — apps_create
 * included"). All tools accept `dry_run`. Destructive tools require `confirm`
 * matching the app's name (case-sensitive).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../context.js';
import type { HerokuRecord } from '../tool-helpers.js';
import { registerWriteTool } from '../write-tool.js';

const url = (s: string): string => encodeURIComponent(s);

const appOnly = {
  app: z.string().min(1).describe('App id or name. Prefer UUID when known.'),
};

/** Register apps-lifecycle writes on the server. */
export function registerAppsWriteTools(server: McpServer, ctx: ToolContext): void {
  registerWriteTool<typeof createShape, HerokuRecord>(server, ctx, {
    name: 'apps_create',
    title: 'Create app',
    description:
      'Create a new app. All fields are optional — Heroku generates a name when omitted. Wraps POST /apps.',
    inputSchema: createShape,
    build: (args) => {
      const body: Record<string, unknown> = {};
      if (args.name !== undefined) body.name = args.name;
      if (args.region !== undefined) body.region = args.region;
      if (args.stack !== undefined) body.stack = args.stack;
      return { method: 'POST', path: '/apps', body };
    },
    describe: (args) => {
      const bits: string[] = [];
      if (args.name) bits.push(`name=${args.name}`);
      if (args.region) bits.push(`region=${args.region}`);
      if (args.stack) bits.push(`stack=${args.stack}`);
      return `Would create a new app${bits.length > 0 ? ` (${bits.join(', ')})` : ' (defaults)'}.`;
    },
  });

  registerWriteTool<typeof updateShape, HerokuRecord>(server, ctx, {
    name: 'apps_update',
    title: 'App update',
    description:
      'Update an app. Patches name, maintenance mode, or build_stack. Optimistic concurrency: pass expected_etag to require that the server-side ETag matches before applying the change. Wraps PATCH /apps/{id_or_name}.',
    inputSchema: updateShape,
    build: (args) => {
      const body: Record<string, unknown> = {};
      if (args.name !== undefined) body.name = args.name;
      if (args.maintenance !== undefined) body.maintenance = args.maintenance;
      if (args.build_stack !== undefined) body.build_stack = args.build_stack;
      const req: {
        method: 'PATCH';
        path: string;
        body: unknown;
        headers?: Record<string, string>;
      } = {
        method: 'PATCH',
        path: `/apps/${url(args.app)}`,
        body,
      };
      if (args.expected_etag !== undefined) {
        req.headers = { 'If-Match': args.expected_etag };
      }
      return req;
    },
    describe: (args) => {
      const updates: string[] = [];
      if (args.name !== undefined) updates.push(`name → ${args.name}`);
      if (args.maintenance !== undefined) updates.push(`maintenance → ${args.maintenance}`);
      if (args.build_stack !== undefined) updates.push(`build_stack → ${args.build_stack}`);
      const what = updates.length > 0 ? updates.join(', ') : '(no fields)';
      return `Would update app '${args.app}': ${what}.`;
    },
  });

  registerWriteTool<typeof appOnly, HerokuRecord>(server, ctx, {
    name: 'apps_delete',
    title: 'App delete',
    description:
      'Destroy an app. Irreversible: all dynos, add-ons, config vars, and releases are removed. Wraps DELETE /apps/{id_or_name}. Destructive: pass confirm matching the app name.',
    inputSchema: appOnly,
    destructive: {
      targetKind: 'app',
      expectedFromResource: (resource) => pickAppName(resource),
      expectedFromArgs: (args) => args.app,
    },
    preFetch: {
      run: (args) =>
        ctx.client.get<HerokuRecord>(`/apps/${url(args.app)}`, { tool: 'apps_delete' }),
    },
    build: (args) => ({ method: 'DELETE', path: `/apps/${url(args.app)}` }),
    describe: (args, fetched) => describeApp(`Would delete app`, args.app, fetched),
  });

  registerWriteTool<typeof appOnly, HerokuRecord>(server, ctx, {
    name: 'apps_enable_acm',
    title: 'App enable ACM',
    description:
      'Enable Automated Certificate Management on an app. Wraps POST /apps/{id_or_name}/acm.',
    inputSchema: appOnly,
    build: (args) => ({ method: 'POST', path: `/apps/${url(args.app)}/acm`, body: null }),
    describe: (args) => `Would enable ACM (Automated Certificate Management) on app '${args.app}'.`,
  });

  registerWriteTool<typeof appOnly, HerokuRecord>(server, ctx, {
    name: 'apps_disable_acm',
    title: 'App disable ACM',
    description:
      'Disable Automated Certificate Management on an app. Wraps DELETE /apps/{id_or_name}/acm. Destructive: pass confirm matching the app name.',
    inputSchema: appOnly,
    destructive: {
      targetKind: 'app',
      expectedFromResource: (resource) => pickAppName(resource),
      expectedFromArgs: (args) => args.app,
    },
    preFetch: {
      run: (args) =>
        ctx.client.get<HerokuRecord>(`/apps/${url(args.app)}`, { tool: 'apps_disable_acm' }),
    },
    build: (args) => ({ method: 'DELETE', path: `/apps/${url(args.app)}/acm` }),
    describe: (args) =>
      `Would disable ACM (Automated Certificate Management) on app '${args.app}'. Custom domains will fall back to manual certificate management.`,
  });

  registerWriteTool<typeof appOnly, HerokuRecord>(server, ctx, {
    name: 'apps_refresh_acm',
    title: 'App refresh ACM',
    description:
      'Refresh Automated Certificate Management on an app (re-issues certificates). Wraps PATCH /apps/{id_or_name}/acm.',
    inputSchema: appOnly,
    build: (args) => ({ method: 'PATCH', path: `/apps/${url(args.app)}/acm`, body: null }),
    describe: (args) =>
      `Would refresh ACM-managed certificates on app '${args.app}'. Heroku will re-issue certificates for custom domains.`,
  });
}

const createShape = {
  name: z
    .string()
    .min(1)
    .optional()
    .describe('App name. Globally unique. If omitted, Heroku generates one.'),
  region: z
    .string()
    .min(1)
    .optional()
    .describe('Region id or name (e.g. "us", "eu"). Defaults to the account default.'),
  stack: z.string().min(1).optional().describe('Stack id or name (e.g. "heroku-24").'),
};

const updateShape = {
  ...appOnly,
  name: z.string().min(1).optional().describe('New app name. Must be globally unique on Heroku.'),
  maintenance: z
    .boolean()
    .optional()
    .describe('When true, take the app offline (returns the Heroku maintenance page).'),
  build_stack: z.string().min(1).optional().describe('Name or id of the build stack to switch to.'),
  expected_etag: z
    .string()
    .min(1)
    .optional()
    .describe('Optimistic-concurrency token: sent as If-Match. Heroku returns 412 on mismatch.'),
};

function describeApp(prefix: string, app: string, fetched: HerokuRecord | undefined): string {
  if (!fetched) return `${prefix} '${app}'. This is irreversible.`;
  const owner = pickString(fetched, ['owner', 'email']) ?? unknown;
  const region = pickString(fetched, ['region', 'name']) ?? unknown;
  const stack = pickString(fetched, ['stack', 'name']) ?? unknown;
  const createdAt = (fetched.created_at as string | undefined) ?? '(unknown)';
  return `${prefix} '${app}' (owner: ${owner}, region: ${region}, stack: ${stack}, created ${createdAt}). This is irreversible.`;
}

const unknown = '(unknown)';

function pickString(record: HerokuRecord, path: string[]): string | undefined {
  let cur: unknown = record;
  for (const p of path) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return typeof cur === 'string' ? cur : undefined;
}

/** Extract the app's canonical name from a Heroku `/apps/{id_or_name}`
 *  response. Exported via local re-use for the destructive-confirm gate. */
function pickAppName(record: HerokuRecord): string | undefined {
  return typeof record.name === 'string' ? record.name : undefined;
}
