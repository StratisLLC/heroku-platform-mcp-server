/**
 * Apps-tier write tools — formation (process scaling) and dynos.
 *
 * Tools registered here:
 *   - formation_scale     (PATCH; scaling is reversible, no confirm)
 *   - dynos_run           (POST; NOT destructive but warns about command access)
 *   - dynos_restart       (⚠ DELETE; confirm: <app name>)
 *   - dynos_restart_all   (⚠ DELETE; confirm: <app name>)
 *   - dynos_stop          (⚠ POST /actions/stop; confirm: <dyno name>)
 *
 * `dynos_run` returns dyno metadata (id, name, state, command, type). Streaming
 * the command's output requires the rendezvous protocol and is deferred to a
 * later phase (see Phase 2a Decision 7).
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

const formationUpdateShape = {
  ...appInput,
  updates: z
    .array(
      z.object({
        type: z.string().min(1).describe('Process type (e.g. "web", "worker").'),
        quantity: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Target dyno count. 0 scales the process type to zero.'),
        size: z
          .string()
          .min(1)
          .optional()
          .describe('Dyno size name (e.g. "Standard-1X", "Performance-M").'),
      }),
    )
    .min(1)
    .describe('Updates to apply. Each entry mutates exactly one process type.'),
};

const dynosRunShape = {
  ...appInput,
  command: z.string().min(1).describe('Shell command to run inside the one-off dyno.'),
  attach: z
    .boolean()
    .optional()
    .describe(
      'Set true for an interactive (rendezvous) dyno. Phase 2a returns dyno metadata only; streaming output is deferred to a later phase.',
    ),
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe('Additional environment variables for this dyno only.'),
  size: z.string().min(1).optional().describe('Override the dyno size for this command.'),
  type: z.string().min(1).optional().describe('Override the process type label.'),
  time_to_live: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Force-kill the dyno after this many seconds.'),
  force_no_tty: z.boolean().optional().describe('Disable TTY allocation on the dyno.'),
};

const dynosRestartShape = {
  ...appInput,
  dyno: z.string().min(1).describe('Dyno id or name (e.g. "web.1").'),
};

const dynosStopShape = {
  ...appInput,
  dyno: z.string().min(1).describe('Dyno id or name to stop (e.g. "run.1234").'),
};

export function registerFormationWriteTools(server: McpServer, ctx: ToolContext): void {
  registerWriteTool<typeof formationUpdateShape, HerokuRecord>(server, ctx, {
    name: 'formation_scale',
    title: 'Formation scale',
    description:
      'Scale (or resize) one or more process types on an app. Pass quantity to change dyno count, size to change dyno size. Wraps PATCH /apps/{id_or_name}/formation. Scaling is reversible; no confirm required.',
    inputSchema: formationUpdateShape,
    build: (args) => ({
      method: 'PATCH',
      path: `/apps/${url(args.app)}/formation`,
      body: { updates: args.updates },
    }),
    describe: (args) => {
      const parts = args.updates.map((u) => {
        const bits: string[] = [u.type];
        if (u.quantity !== undefined) bits.push(`qty=${u.quantity}`);
        if (u.size !== undefined) bits.push(`size=${u.size}`);
        return bits.join(' ');
      });
      return `Would scale process types on app '${args.app}': ${parts.join(', ')}.`;
    },
  });

  registerWriteTool<typeof dynosRunShape, HerokuRecord>(server, ctx, {
    name: 'dynos_run',
    title: 'Run one-off dyno',
    description:
      "Runs an arbitrary command on a one-off dyno with full app credentials. The command has the same access as your app. Review the command carefully before authorizing. This tool returns the dyno metadata only; streaming the command's output is deferred to a future phase. Wraps POST /apps/{id_or_name}/dynos.",
    inputSchema: dynosRunShape,
    build: (args) => {
      const body: Record<string, unknown> = { command: args.command };
      if (args.attach !== undefined) body.attach = args.attach;
      if (args.env !== undefined) body.env = args.env;
      if (args.size !== undefined) body.size = args.size;
      if (args.type !== undefined) body.type = args.type;
      if (args.time_to_live !== undefined) body.time_to_live = args.time_to_live;
      if (args.force_no_tty !== undefined) body.force_no_tty = args.force_no_tty;
      return { method: 'POST', path: `/apps/${url(args.app)}/dynos`, body };
    },
    describe: (args) =>
      `Would start a one-off dyno on app '${args.app}' running: ${truncate(args.command, 200)}. Returns the dyno record; output streaming is not implemented in this phase.`,
  });

  registerWriteTool<typeof dynosRestartShape, HerokuRecord>(server, ctx, {
    name: 'dynos_restart',
    title: 'Restart dyno',
    description:
      'Restart a single dyno on an app. Wraps DELETE /apps/{id_or_name}/dynos/{id_or_name}. Destructive: pass confirm matching the app name.',
    inputSchema: dynosRestartShape,
    destructive: {
      targetKind: 'dyno',
      expectedFromResource: (resource) =>
        typeof resource?.name === 'string' ? resource.name : undefined,
      expectedFromArgs: (args) => args.app,
    },
    preFetch: {
      run: (args) =>
        ctx.client.get<HerokuRecord>(`/apps/${url(args.app)}`, { tool: 'dynos_restart' }),
    },
    build: (args) => ({
      method: 'DELETE',
      path: `/apps/${url(args.app)}/dynos/${url(args.dyno)}`,
    }),
    describe: (args) =>
      `Would restart dyno '${args.dyno}' on app '${args.app}'. The dyno will briefly be unavailable.`,
  });

  registerWriteTool<typeof appInput, HerokuRecord>(server, ctx, {
    name: 'dynos_restart_all',
    title: 'Restart all dynos',
    description:
      'Restart every dyno on an app. Wraps DELETE /apps/{id_or_name}/dynos. Destructive: pass confirm matching the app name. Briefly interrupts service across all process types.',
    inputSchema: appInput,
    destructive: {
      targetKind: 'app',
      expectedFromResource: (resource) =>
        typeof resource?.name === 'string' ? resource.name : undefined,
      expectedFromArgs: (args) => args.app,
    },
    preFetch: {
      run: (args) =>
        ctx.client.get<HerokuRecord>(`/apps/${url(args.app)}`, { tool: 'dynos_restart_all' }),
    },
    build: (args) => ({ method: 'DELETE', path: `/apps/${url(args.app)}/dynos` }),
    describe: (args) =>
      `Would restart all dynos on app '${args.app}'. Every process type is briefly unavailable.`,
  });

  registerWriteTool<typeof dynosStopShape, HerokuRecord>(server, ctx, {
    name: 'dynos_stop',
    title: 'Stop dyno',
    description:
      'Stop a single dyno (web, worker, or one-off). Wraps POST /apps/{id_or_name}/dynos/{id_or_name}/actions/stop. Destructive: pass confirm matching the dyno name (not the app name).',
    inputSchema: dynosStopShape,
    destructive: {
      targetKind: 'dyno',
      expectedFromResource: (resource) =>
        typeof resource?.name === 'string' ? resource.name : undefined,
      expectedFromArgs: (args) => args.dyno,
    },
    preFetch: {
      run: (args) =>
        ctx.client.get<HerokuRecord>(`/apps/${url(args.app)}/dynos/${url(args.dyno)}`, {
          tool: 'dynos_stop',
        }),
    },
    build: (args) => ({
      method: 'POST',
      path: `/apps/${url(args.app)}/dynos/${url(args.dyno)}/actions/stop`,
      body: null,
    }),
    describe: (args) =>
      `Would stop dyno '${args.dyno}' on app '${args.app}'. The Heroku platform will not restart it automatically until the next deploy or scale.`,
  });
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
