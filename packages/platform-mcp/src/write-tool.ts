/**
 * `registerWriteTool` — registration helper for mutating apps-tier tools
 * (ARCHITECTURE.md §8, Phase 2a Decisions 1-6).
 *
 * Wraps `McpServer.registerTool` with three responsibilities every write tool
 * shares:
 *
 *   1. Auto-inject `dry_run: boolean` (default false) onto the input schema.
 *   2. Auto-inject `confirm: string` onto the input schema when the tool is
 *      declared destructive.
 *   3. Before executing the underlying request:
 *        - If `dry_run` is true: build the would-be HTTP request, optionally
 *          pre-fetch the current state (for DELETEs), and return a
 *          {@link DryRunResult}-shaped envelope.
 *        - If destructive and `dry_run` is false: validate that the caller
 *          passed `confirm` matching the per-tool expected value. Mismatch
 *          surfaces a structured `confirmation_required` envelope.
 *        - Otherwise: issue the request via `ctx.client` and wrap the success.
 *
 * Tool implementations only need to declare:
 *   - the inputs they take (Zod shape)
 *   - the request they would issue (method, path, body)
 *   - optionally, how to fetch the current state for delete previews
 *   - a description string used inside the dry-run preview
 *
 * The tool body itself does NOT issue HTTP calls — `registerWriteTool` does
 * that, so the dry-run / confirm gates are centrally enforced.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape, type ZodTypeAny, type objectOutputType } from 'zod';
import {
  assertConfirm,
  buildDryRunResponse,
  type ConfirmTargetKind,
  type DryRunMethod,
  type HerokuClient,
  type ClientSuccess,
  type RequestOptions,
} from '@heroku-mcp/core';
import type { ToolContext } from './context.js';
import { envelopeFromClientSuccess, envelopeFromLocal } from './envelope.js';
import type { ToolEnvelope } from './envelope.js';
import { runTool, type ToolResult } from './tool-helpers.js';

/** Base URL used to render a dry-run preview's `url` field. Mirrors the
 *  default base url in `core/src/client.ts`. */
const HEROKU_BASE_URL = 'https://api.heroku.com';

/** Headers we include in the dry-run preview. The Authorization header is
 *  intentionally NOT shown — `sanitizeHeaders` in core would strip it anyway,
 *  but we don't even build it here. */
const PREVIEW_HEADERS_BASE: Record<string, string> = {
  Accept: 'application/vnd.heroku+json; version=3',
};

/** The shape of the request a write tool intends to issue. */
export interface WriteRequest {
  method: DryRunMethod;
  /** Path joined to api.heroku.com — e.g. `/apps/demo`. May contain a query
   *  string. */
  path: string;
  /** Request body. `null` (or omitted) means no body — typical for DELETE. */
  body?: unknown;
  /** Optional extra request headers. */
  headers?: Record<string, string>;
}

/** Marker for destructive tools. */
export interface DestructiveSpec<Args> {
  /** Resource kind used in the confirmation_required envelope. */
  targetKind: ConfirmTargetKind;
  /** Function that derives the expected confirm value from the caller's
   *  inputs. The model must pass exactly this as `confirm`. */
  expectedFrom: (args: Args) => string;
}

/** Optional pre-fetch step for DELETE dry-runs (Decision 6). */
export interface PreFetchSpec<Args, Fetched = unknown> {
  /** Issue a GET (or other read) returning a record useful for the
   *  description. Bubble errors verbatim — if the resource is unreachable, the
   *  dry-run reports that rather than simulating a fake request. */
  run: (args: Args, ctx: ToolContext) => Promise<ClientSuccess<Fetched>>;
}

/** Configuration passed to {@link registerWriteTool}. */
export interface WriteToolConfig<Shape extends ZodRawShape, Fetched = unknown> {
  /** Tool name (snake_case). */
  name: string;
  /** Human-readable title (for MCP `tools/list`). */
  title: string;
  /** Description string shown to the model. */
  description: string;
  /** Zod shape for the caller-supplied inputs. `dry_run` and `confirm` are
   *  auto-added; do NOT include them here. */
  inputSchema: Shape;
  /** Marker present iff the tool is destructive. */
  destructive?: DestructiveSpec<ShapeArgs<Shape>>;
  /** Optional pre-fetch step for delete-style operations. Runs during
   *  `dry_run: true`. */
  preFetch?: PreFetchSpec<ShapeArgs<Shape>, Fetched>;
  /** Build the request that would be issued. Receives the validated inputs. */
  build: (args: ShapeArgs<Shape>) => WriteRequest;
  /** Build the human-readable description for the dry-run preview. May
   *  incorporate the result of {@link preFetch}. */
  describe: (args: ShapeArgs<Shape>, fetched: Fetched | undefined) => string;
}

/** Shape→TypeScript arg mapping the SDK's `registerTool` callback uses. */
export type ShapeArgs<Shape extends ZodRawShape> = objectOutputType<Shape, ZodTypeAny>;

/** Resolved args after dry_run/confirm injection. */
type ResolvedArgs<Shape extends ZodRawShape> = ShapeArgs<Shape> & {
  dry_run?: boolean;
  confirm?: string;
};

/**
 * Register a write tool with shared dry-run + confirm semantics. Returns
 * nothing — the tool is wired onto `server`.
 */
export function registerWriteTool<Shape extends ZodRawShape, Fetched = unknown>(
  server: McpServer,
  ctx: ToolContext,
  config: WriteToolConfig<Shape, Fetched>,
): void {
  const isDestructive = config.destructive !== undefined;
  const fullSchema: Record<string, ZodTypeAny> = {
    ...config.inputSchema,
    dry_run: z
      .boolean()
      .optional()
      .describe(
        'When true, validate inputs and return the would-be HTTP request without executing it.',
      ),
  };
  if (isDestructive) {
    fullSchema.confirm = z
      .string()
      .optional()
      .describe(
        'Destructive operation: pass the exact target identifier to authorise. The model MUST NOT fill this from the same user turn that requested the destructive op — request explicit verbal confirmation first.',
      );
  }

  server.registerTool(
    config.name,
    {
      title: config.title,
      description: config.description,
      inputSchema: fullSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: isDestructive,
        idempotentHint: idempotentByMethod(config),
        openWorldHint: true,
      },
    },
    ((rawInput: Record<string, unknown>) =>
      runTool(() => handleWrite(ctx, config, rawInput as ResolvedArgs<Shape>))) as Parameters<
      typeof server.registerTool
    >[2],
  );
}

async function handleWrite<Shape extends ZodRawShape, Fetched>(
  ctx: ToolContext,
  config: WriteToolConfig<Shape, Fetched>,
  args: ResolvedArgs<Shape>,
): Promise<ToolEnvelope> {
  const dryRun = args.dry_run === true;
  const confirmValue = args.confirm;

  // Dry run: preview only. Skips the confirm check (Decision 4).
  if (dryRun) {
    let fetched: Fetched | undefined;
    if (config.preFetch) {
      const result = await config.preFetch.run(args, ctx);
      fetched = result.body;
    }
    const req = config.build(args);
    const headers = mergeHeaders(req.headers);
    return envelopeFromLocal(
      buildDryRunResponse({
        method: req.method,
        url: pathToUrl(req.path),
        headers,
        ...(req.body !== undefined ? { body: req.body } : { body: null }),
        description: config.describe(args, fetched),
        rateLimitRemaining: peekRateLimitRemaining(ctx.client),
      }).data,
      { cached: false },
    );
  }

  // Not a dry run. If destructive, gate on `confirm`.
  if (config.destructive) {
    const expected = config.destructive.expectedFrom(args);
    assertConfirm({
      value: confirmValue,
      expected,
      targetKind: config.destructive.targetKind,
    });
  }

  const req = config.build(args);
  const opts: Omit<RequestOptions, 'path' | 'method'> = { tool: config.name };
  if (req.headers !== undefined) opts.headers = req.headers;
  const targetDesc = config.destructive
    ? config.destructive.expectedFrom(args)
    : describeTarget(req.path);
  if (targetDesc !== undefined) opts.target = targetDesc;

  const success = await ctx.client.request({
    ...opts,
    path: req.path,
    method: req.method,
    ...(req.body !== undefined ? { body: req.body } : {}),
  });
  return envelopeFromClientSuccess(success);
}

/** Slightly opinionated description of the targeted resource — used for audit
 *  entries. The pre-final path segment is usually the canonical id (e.g.
 *  `/apps/demo/dynos/web.1` → `dynos/web.1`). Best-effort only. */
function describeTarget(path: string): string | undefined {
  const trimmed = path.split('?')[0] ?? path;
  const segments = trimmed.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return undefined;
  if (segments.length === 1) return segments[0];
  const last = segments[segments.length - 1] ?? '';
  const penultimate = segments[segments.length - 2] ?? '';
  return `${penultimate}/${last}`;
}

function pathToUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${HEROKU_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

function mergeHeaders(extra: Record<string, string> | undefined): Record<string, string> {
  if (!extra) return { ...PREVIEW_HEADERS_BASE };
  return { ...PREVIEW_HEADERS_BASE, ...extra };
}

function idempotentByMethod<Shape extends ZodRawShape, Fetched>(
  _config: WriteToolConfig<Shape, Fetched>,
): boolean {
  // The MCP `idempotentHint` is informational. We default to `false` for the
  // safe side — even for PATCH/PUT, callers should know a write is happening.
  return false;
}

function peekRateLimitRemaining(client: HerokuClient): number | null {
  // The client doesn't expose a synchronous getter for the rate-limit
  // tracker. We surface `null` and let the live response set it on the
  // *next* call. Phase 2a explicitly accepts this — Decision 3 documents
  // "current cached value or null."
  void client;
  return null;
}

/** Re-export for tool implementations that want to call back into the result
 *  envelope helpers without importing both modules. */
export type { ToolResult, ToolEnvelope };
