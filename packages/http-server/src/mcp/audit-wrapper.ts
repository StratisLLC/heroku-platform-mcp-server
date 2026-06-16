/**
 * Audit wrapper for tool calls dispatched by the MCP server.
 *
 * The wrapper hooks `McpServer.server.setRequestHandler(CallToolRequestSchema, ...)`.
 * Concretely we monkey-patch the underlying `Server`'s tool-call dispatcher by
 * replacing the high-level `McpServer.registerTool` callback with a wrapped
 * version that:
 *
 *   1. Records the start time and the (sanitized) call args.
 *   2. Calls the underlying handler.
 *   3. Records the outcome: status (ok / error / rejected), duration, response
 *      shape hints (whether it was a dry-run, whether confirm was passed).
 *   4. Writes one audit_log entry.
 *
 * The wrapper has no opinion on the result shape; it inspects the returned
 * `CallToolResult` only to set `status` (`isError` → "error"). All other
 * details come from the inputs and timing.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { redact } from '@heroku-mcp/core';
import { appendAuditEntry } from '../db/repos/audit-log.js';
import type { AuditCategory, AuditStatus } from '../db/repos/audit-log.js';
import type { Queryable } from '../db/pool.js';

export interface AuditedRequestContext {
  userId: string | null;
  clientName: string | null;
  clientVersion: string | null;
  /** Caller-supplied — we don't have a Heroku request id at this layer; the
   *  underlying client may set one and we'd ideally pull it through, but the
   *  HTTP/MCP boundary obscures it. For now we leave it null. */
  requestId?: string | null;
}

/** Pluggable shape so tests can swap the audit destination. */
export type AuditSink = (entry: {
  userId: string | null;
  category: AuditCategory;
  eventName: string;
  status: AuditStatus;
  durationMs: number;
  clientName: string | null;
  clientVersion: string | null;
  details: Record<string, unknown>;
}) => Promise<void>;

/** Build an audit sink backed by `audit_log` table writes. */
export function dbAuditSink(db: Queryable): AuditSink {
  return async (entry) => {
    await appendAuditEntry(db, {
      userId: entry.userId,
      category: entry.category,
      eventName: entry.eventName,
      status: entry.status,
      durationMs: entry.durationMs,
      clientName: entry.clientName,
      clientVersion: entry.clientVersion,
      details: entry.details,
    });
  };
}

/**
 * Install an audit-recording wrapper around `McpServer.registerTool` so every
 * subsequent registration is wrapped. Returns a function that lifts the wrap —
 * useful for tests.
 *
 * `getRequestCtx` is called per-invocation (an MCP server hosts a single user
 * per session, established at session creation; the wrapper reads the current
 * user from the per-session context).
 */
export function installAuditWrapper(
  server: McpServer,
  sink: AuditSink,
  getRequestCtx: () => AuditedRequestContext,
): () => void {
  const original = server.registerTool.bind(server) as (
    name: string,
    config: unknown,
    handler: (...args: unknown[]) => unknown,
  ) => unknown;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
  (server as any).registerTool = (name: string, config: unknown, handler: any) => {
    const wrapped = async (...args: unknown[]): Promise<unknown> => {
      const start = Date.now();
      const requestCtx = getRequestCtx();
      const callArgs = (args[0] ?? {}) as Record<string, unknown>;
      const sanitizedArgs = sanitizeCallArgs(callArgs);
      const dryRun = callArgs.dry_run === true;
      const confirmPresent = typeof callArgs.confirm === 'string' && callArgs.confirm !== '';

      let result: unknown;
      let status: AuditStatus = 'ok';
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        result = await handler(...args);
      } catch (err) {
        status = 'error';
        const durationMs = Date.now() - start;
        await sink({
          userId: requestCtx.userId,
          category: 'tool_call',
          eventName: name,
          status,
          durationMs,
          clientName: requestCtx.clientName,
          clientVersion: requestCtx.clientVersion,
          details: {
            args: sanitizedArgs,
            dry_run: dryRun,
            confirm_present: confirmPresent,
            error: err instanceof Error ? err.message : String(err),
          },
        }).catch(() => undefined);
        throw err;
      }

      const isError =
        typeof result === 'object' &&
        result !== null &&
        (result as { isError?: boolean }).isError === true;
      if (isError) status = 'error';

      const durationMs = Date.now() - start;
      await sink({
        userId: requestCtx.userId,
        category: 'tool_call',
        eventName: name,
        status,
        durationMs,
        clientName: requestCtx.clientName,
        clientVersion: requestCtx.clientVersion,
        details: {
          args: sanitizedArgs,
          dry_run: dryRun,
          confirm_present: confirmPresent,
        },
      }).catch(() => undefined);

      return result;
    };

    return original(name, config, wrapped);
  };

  return () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (server as any).registerTool = original;
  };
}

/** Run `redact` over the call args and drop the literal `confirm` value. We
 *  record whether confirm was present, not what it was. */
function sanitizeCallArgs(args: Record<string, unknown>): unknown {
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === 'confirm') continue;
    copy[k] = v;
  }
  return redact(copy);
}
