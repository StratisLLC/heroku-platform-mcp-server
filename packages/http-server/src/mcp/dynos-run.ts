/**
 * dynos_run (buffered) — Phase 4 implementation (DECISION 8).
 *
 * Flow:
 *   1. POST /apps/{app}/dynos with { command, attach: true, size, env, type: 'run' }
 *      Heroku returns a dyno record including `attach_url` (a one-shot WS URL).
 *   2. Open the WebSocket. Read messages until any of:
 *        - close
 *        - max_duration_seconds elapsed
 *        - max_output_bytes received
 *   3. Return { output, exit_code, truncated, timed_out, duration_ms }.
 *
 * The WS dependency is injectable for tests.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  envelopeFromClientSuccess,
  envelopeFromLocal,
  runTool,
  type ToolContext,
} from '@heroku-mcp/platform';
import { buildDryRunResponse } from '@heroku-mcp/core';

const DEFAULT_MAX_DURATION_S = 30;
const MAX_MAX_DURATION_S = 60;
const DEFAULT_MAX_OUTPUT_BYTES = 65_536;
const ABS_MAX_OUTPUT_BYTES = 1_048_576;
const DEFAULT_SIZE = 'standard-1x';

const inputShape = {
  app: z.string().min(1).describe('App id or name. Prefer UUID when known.'),
  command: z.string().min(1).describe('Shell command to run inside the one-off dyno.'),
  size: z.string().min(1).default(DEFAULT_SIZE).describe('Dyno size for this command.'),
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe('Additional environment variables for this dyno only.'),
  max_duration_seconds: z
    .number()
    .int()
    .min(1)
    .max(MAX_MAX_DURATION_S)
    .default(DEFAULT_MAX_DURATION_S)
    .describe(`How long to wait for output before timing out. Max ${MAX_MAX_DURATION_S}s.`),
  max_output_bytes: z
    .number()
    .int()
    .min(1)
    .max(ABS_MAX_OUTPUT_BYTES)
    .default(DEFAULT_MAX_OUTPUT_BYTES)
    .describe(`Truncate output past this many bytes. Max ${ABS_MAX_OUTPUT_BYTES}.`),
  dry_run: z
    .boolean()
    .optional()
    .describe('When true, return the would-be POST without executing the command.'),
};

export interface WebSocketLike {
  on(event: string, handler: (...args: unknown[]) => void): void;
  close(): void;
}

export type WebSocketFactory = (attachUrl: string) => WebSocketLike;

interface DynoCreateResponse {
  id?: string;
  name?: string;
  attach_url?: string;
  exit_code?: number | null;
  command?: string;
}

interface BufferedRunResult {
  output: string;
  exit_code: number | null;
  truncated: boolean;
  timed_out: boolean;
  duration_ms: number;
  dyno: DynoCreateResponse;
}

export interface RegisterDynosRunOptions {
  /** Default real-WebSocket factory uses `ws`. Tests inject a stub. */
  webSocketFactory?: WebSocketFactory;
  /** Injectable clock; defaults to Date.now. */
  now?: () => number;
}

/**
 * Register the buffered `dynos_run` tool on the given server. Caller MUST
 * have already removed any prior registration with the same name (the
 * existing stub from platform-mcp is skipped via the `beforeRegisterTools`
 * hook in setup.ts).
 */
export function registerDynosRunBuffered(
  server: McpServer,
  ctx: ToolContext,
  opts: RegisterDynosRunOptions = {},
): void {
  const wsFactory = opts.webSocketFactory ?? defaultWsFactory;
  const now = opts.now ?? Date.now;

  server.registerTool(
    'dynos_run',
    {
      title: 'Run one-off dyno (buffered)',
      description:
        'Runs a shell command on a one-off Heroku dyno and buffers its output until the command exits, the duration limit is hit, or the output byte limit is hit. Wraps POST /apps/{app}/dynos with attach=true, type=run, and reads the rendezvous WebSocket. For interactive dyno sessions, use `heroku run` from your local CLI. Output is text only; binary writes will be lossy through this transport.',
      inputSchema: inputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (rawInput) => {
      return runTool(async () => {
        const args = rawInput as z.infer<z.ZodObject<typeof inputShape>>;
        const env = args.env;
        const body: Record<string, unknown> = {
          command: args.command,
          attach: true,
          size: args.size,
          type: 'run',
        };
        if (env !== undefined) body.env = env;

        const path = `/apps/${encodeURIComponent(args.app)}/dynos`;

        if (args.dry_run === true) {
          return envelopeFromLocal(
            buildDryRunResponse({
              method: 'POST',
              url: `https://api.heroku.com${path}`,
              headers: { Accept: 'application/vnd.heroku+json; version=3' },
              body,
              description: `Would start a one-off dyno on app '${args.app}' running: ${truncate(args.command, 200)}. Up to ${args.max_duration_seconds}s of output buffered, max ${args.max_output_bytes} bytes.`,
              rateLimitRemaining: null,
            }).data,
            { cached: false },
          );
        }

        const createRes = await ctx.client.post<DynoCreateResponse>(path, body, {
          tool: 'dynos_run',
        });
        const attachUrl = createRes.body.attach_url;
        if (!attachUrl) {
          // No attach URL means Heroku didn't honor attach=true. Surface the
          // dyno record without trying to stream.
          return envelopeFromClientSuccess(createRes);
        }

        const buffered = await readBufferedOutput({
          attachUrl,
          wsFactory,
          maxDurationMs: args.max_duration_seconds * 1000,
          maxOutputBytes: args.max_output_bytes,
          now,
        });

        const result: BufferedRunResult = {
          output: buffered.output,
          exit_code: createRes.body.exit_code ?? null,
          truncated: buffered.truncated,
          timed_out: buffered.timedOut,
          duration_ms: buffered.durationMs,
          dyno: createRes.body,
        };
        return envelopeFromLocal(result, {
          ...(createRes.requestId !== undefined ? { requestId: createRes.requestId } : {}),
        });
      });
    },
  );
}

interface ReadBufferedOptions {
  attachUrl: string;
  wsFactory: WebSocketFactory;
  maxDurationMs: number;
  maxOutputBytes: number;
  now: () => number;
}

interface BufferedReadOutcome {
  output: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

export async function readBufferedOutput(opts: ReadBufferedOptions): Promise<BufferedReadOutcome> {
  const start = opts.now();
  let total = 0;
  let truncated = false;
  let timedOut = false;
  const chunks: string[] = [];

  return new Promise<BufferedReadOutcome>((resolve) => {
    let settled = false;
    const ws = opts.wsFactory(opts.attachUrl);
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // best-effort
      }
      resolve({
        output: chunks.join(''),
        truncated,
        timedOut,
        durationMs: opts.now() - start,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      finish();
    }, opts.maxDurationMs);

    ws.on('message', (...args: unknown[]) => {
      const data = args[0];
      const text =
        typeof data === 'string'
          ? data
          : data instanceof Uint8Array
            ? new TextDecoder().decode(data)
            : Buffer.isBuffer(data)
              ? data.toString('utf8')
              : '';
      const remaining = opts.maxOutputBytes - total;
      if (remaining <= 0) {
        truncated = true;
        finish();
        return;
      }
      if (text.length > remaining) {
        chunks.push(text.slice(0, remaining));
        total = opts.maxOutputBytes;
        truncated = true;
        finish();
        return;
      }
      chunks.push(text);
      total += text.length;
    });
    ws.on('close', () => finish());
    ws.on('error', () => finish());
  });
}

let cachedWsImport: Promise<{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  WebSocket: any;
}> | null = null;

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
const defaultWsFactory: WebSocketFactory = (attachUrl) => {
  // Lazy dynamic import so test environments don't need `ws` installed.
  // The factory is async-friendly via a synchronous proxy that defers event
  // wiring until the real socket resolves.
  let realSocket: WebSocketLike | null = null;
  const pendingHandlers: { event: string; handler: (...args: unknown[]) => void }[] = [];

  const proxy: WebSocketLike = {
    on(event: string, handler: (...args: unknown[]) => void) {
      if (realSocket) {
        (realSocket as any).on(event, handler);
        return;
      }
      pendingHandlers.push({ event, handler });
    },
    close() {
      if (realSocket) realSocket.close();
    },
  };

  void (async () => {
    try {
      cachedWsImport ??= import('ws');
      const mod = await cachedWsImport;
      const sock = new mod.WebSocket(attachUrl) as WebSocketLike;
      realSocket = sock;
      for (const { event, handler } of pendingHandlers) {
        (sock as any).on(event, handler);
      }
    } catch (err) {
      // Surface as a close event so the read loop terminates cleanly.
      const errHandlers = pendingHandlers.filter((h) => h.event === 'error');
      for (const h of errHandlers) h.handler(err);
      const closeHandlers = pendingHandlers.filter((h) => h.event === 'close');
      for (const h of closeHandlers) h.handler();
    }
  })();

  return proxy;
};
/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
