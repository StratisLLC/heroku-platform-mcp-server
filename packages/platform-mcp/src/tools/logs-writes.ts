/**
 * Apps-tier write tools — log sessions, log drains, telemetry drains.
 *
 * Tools registered here:
 *   - log_sessions_create     (POST; creates ephemeral log URL — no confirm)
 *   - log_drains_create       (POST)
 *   - log_drains_delete       (⚠ DELETE; confirm: <app name>)
 *   - telemetry_drains_create (POST; app-scoped)
 *   - telemetry_drains_update (PATCH; account-scoped, by drain id)
 *   - telemetry_drains_delete (⚠ DELETE; confirm: <drain id>)
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../context.js';
import type { HerokuRecord } from '../tool-helpers.js';
import { registerWriteTool } from '../write-tool.js';

const url = (s: string): string => encodeURIComponent(s);

const appInput = {
  app: z.string().min(1).describe('App id or name. Prefer UUID when known.'),
};

const logSessionsShape = {
  ...appInput,
  dyno: z.string().min(1).optional().describe('Limit to a single dyno id or name.'),
  source: z
    .string()
    .min(1)
    .optional()
    .describe('Limit to a single source (e.g. "app", "heroku", "router").'),
  lines: z.number().int().positive().optional().describe('Tail this many recent lines.'),
  tail: z.boolean().optional().describe('When true, the returned URL streams indefinitely.'),
};

const logDrainsCreateShape = {
  ...appInput,
  url: z.string().min(1).describe('Drain URL (syslog://, https://, etc.).'),
};

const logDrainsDeleteShape = {
  ...appInput,
  drain: z.string().min(1).describe('Log drain id, URL, or token.'),
};

const telemetryDrainsCreateShape = {
  ...appInput,
  drain: z
    .object({
      signals: z
        .array(z.string().min(1))
        .min(1)
        .describe('Telemetry signal types to forward (e.g. ["metrics", "logs", "traces"]).'),
      exporter: z
        .object({
          type: z.string().min(1).describe('Exporter type (e.g. "otlphttp").'),
          endpoint: z.string().min(1).describe('Receiving endpoint URL.'),
          headers: z.record(z.string(), z.string()).optional(),
        })
        .passthrough()
        .describe('Exporter config. Extra fields are forwarded verbatim.'),
    })
    .passthrough()
    .describe('Drain configuration. Pass-through — fields are forwarded verbatim to Heroku.'),
};

const telemetryDrainsUpdateShape = {
  id: z.string().min(1).describe('Telemetry drain id (UUID).'),
  drain: z
    .object({})
    .passthrough()
    .describe('Patch fields. Pass-through — forwarded verbatim to Heroku.'),
};

const telemetryDrainsDeleteShape = {
  id: z.string().min(1).describe('Telemetry drain id (UUID).'),
};

export function registerLogsWriteTools(server: McpServer, ctx: ToolContext): void {
  registerWriteTool<typeof logSessionsShape, HerokuRecord>(server, ctx, {
    name: 'log_sessions_create',
    title: 'Create log session',
    description:
      'Allocate an ephemeral log-session URL for an app. The returned URL is a short-lived HTTPS endpoint the caller can stream. Wraps POST /apps/{id_or_name}/log-sessions.',
    inputSchema: logSessionsShape,
    build: (args) => {
      const body: Record<string, unknown> = {};
      if (args.dyno !== undefined) body.dyno = args.dyno;
      if (args.source !== undefined) body.source = args.source;
      if (args.lines !== undefined) body.lines = args.lines;
      if (args.tail !== undefined) body.tail = args.tail;
      return { method: 'POST', path: `/apps/${url(args.app)}/log-sessions`, body };
    },
    describe: (args) => {
      const bits: string[] = [];
      if (args.dyno) bits.push(`dyno=${args.dyno}`);
      if (args.source) bits.push(`source=${args.source}`);
      if (args.lines) bits.push(`lines=${args.lines}`);
      if (args.tail) bits.push(`tail=true`);
      return `Would create a log session on app '${args.app}'${
        bits.length > 0 ? ` (${bits.join(', ')})` : ''
      }. Returns a short-lived log URL.`;
    },
  });

  registerWriteTool<typeof logDrainsCreateShape, HerokuRecord>(server, ctx, {
    name: 'log_drains_create',
    title: 'Create log drain',
    description:
      "Forward an app's logs to an external endpoint. Wraps POST /apps/{id_or_name}/log-drains.",
    inputSchema: logDrainsCreateShape,
    build: (args) => ({
      method: 'POST',
      path: `/apps/${url(args.app)}/log-drains`,
      body: { url: args.url },
    }),
    describe: (args) => `Would add a log drain on app '${args.app}' forwarding to ${args.url}.`,
  });

  registerWriteTool<typeof logDrainsDeleteShape, HerokuRecord>(server, ctx, {
    name: 'log_drains_delete',
    title: 'Delete log drain',
    description:
      'Remove a log drain from an app. Wraps DELETE /apps/{id_or_name}/log-drains/{id_or_url_or_token}. Destructive: pass confirm matching the app name.',
    inputSchema: logDrainsDeleteShape,
    destructive: { targetKind: 'drain', expectedFrom: (args) => args.app },
    preFetch: {
      run: (args) =>
        ctx.client.get<HerokuRecord>(`/apps/${url(args.app)}/log-drains/${url(args.drain)}`, {
          tool: 'log_drains_delete',
        }),
    },
    build: (args) => ({
      method: 'DELETE',
      path: `/apps/${url(args.app)}/log-drains/${url(args.drain)}`,
    }),
    describe: (args, fetched) => {
      const target = typeof fetched?.url === 'string' ? fetched.url : args.drain;
      return `Would remove log drain '${target}' from app '${args.app}'. Forwarded log delivery stops immediately.`;
    },
  });

  registerWriteTool<typeof telemetryDrainsCreateShape, HerokuRecord>(server, ctx, {
    name: 'telemetry_drains_create',
    title: 'Create telemetry drain',
    description:
      'Add a telemetry drain to an app. Heroku exports the configured signals to the exporter URL. Wraps POST /apps/{id_or_name}/telemetry-drains.',
    inputSchema: telemetryDrainsCreateShape,
    build: (args) => ({
      method: 'POST',
      path: `/apps/${url(args.app)}/telemetry-drains`,
      body: args.drain,
    }),
    describe: (args) => {
      const signals = (args.drain as { signals?: unknown }).signals;
      const signalsStr = Array.isArray(signals) ? signals.join(', ') : '(unspecified)';
      return `Would add a telemetry drain on app '${args.app}' forwarding signals: ${signalsStr}.`;
    },
  });

  registerWriteTool<typeof telemetryDrainsUpdateShape, HerokuRecord>(server, ctx, {
    name: 'telemetry_drains_update',
    title: 'Update telemetry drain',
    description:
      'Update a telemetry drain configuration. The drain is account-scoped — addressed by id, not app. Wraps PATCH /telemetry-drains/{id}.',
    inputSchema: telemetryDrainsUpdateShape,
    build: (args) => ({
      method: 'PATCH',
      path: `/telemetry-drains/${url(args.id)}`,
      body: args.drain,
    }),
    describe: (args) => `Would update telemetry drain '${args.id}'.`,
  });

  registerWriteTool<typeof telemetryDrainsDeleteShape, HerokuRecord>(server, ctx, {
    name: 'telemetry_drains_delete',
    title: 'Delete telemetry drain',
    description:
      'Remove a telemetry drain. Wraps DELETE /telemetry-drains/{id}. Destructive: pass confirm matching the drain id.',
    inputSchema: telemetryDrainsDeleteShape,
    destructive: { targetKind: 'drain', expectedFrom: (args) => args.id },
    preFetch: {
      run: (args) =>
        ctx.client.get<HerokuRecord>(`/telemetry-drains/${url(args.id)}`, {
          tool: 'telemetry_drains_delete',
        }),
    },
    build: (args) => ({ method: 'DELETE', path: `/telemetry-drains/${url(args.id)}` }),
    describe: (args, fetched) => {
      const exporter =
        fetched && typeof fetched.exporter === 'object' && fetched.exporter !== null
          ? (fetched.exporter as { endpoint?: string }).endpoint
          : undefined;
      return `Would remove telemetry drain '${args.id}'${exporter ? ` (exporter ${exporter})` : ''}. Signal export stops immediately.`;
    },
  });
}
