/**
 * Small adapters used by every tool implementation.
 *
 *   - {@link runTool} converts a tool body that may throw into a
 *     CallToolResult-shaped object with our standard envelope.
 *   - {@link rangeHeader} centralises the `page_size`/`cursor` → `Range`
 *     header conversion so each list tool stays one-liner.
 *   - {@link paginationInputShape} defines the shared shape (`page_size`,
 *     `cursor`) of paginated tool inputs in a single place so we don't drift.
 */

import { z } from 'zod';
import { buildRangeHeader, toToolEnvelope } from '@heroku-mcp/core';
import type { ClientSuccess } from '@heroku-mcp/core';
import { envelopeFromClientSuccess, toolContent } from './envelope.js';
import type { ToolEnvelope } from './envelope.js';

/** Standard CallToolResult shape (the bit the MCP SDK reads). The
 *  index signature exists so the type is assignable to the SDK's
 *  CallToolResult, which is declared with an open `[x: string]: unknown`. */
export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  [k: string]: unknown;
}

/** Run a tool implementation and convert thrown values into a typed error
 *  envelope. Returns a CallToolResult with `isError: true` when the body
 *  threw, so MCP hosts can react in the standard way. */
export async function runTool(body: () => Promise<ToolEnvelope>): Promise<ToolResult> {
  try {
    const env = await body();
    const result: ToolResult = { content: toolContent(env) };
    if (env.ok === false) result.isError = true;
    return result;
  } catch (err) {
    const env = toToolEnvelope(err);
    return { content: toolContent(env), isError: true };
  }
}

/** Marker type for Heroku resources we don't model: pass through verbatim. */
export type HerokuRecord = Record<string, unknown>;
export type HerokuList = HerokuRecord[];

/** Build the `Range` header from optional `page_size`/`cursor` tool inputs.
 *  Accepts undefined for either field so callers can spread parsed Zod inputs
 *  directly without first stripping undefineds (compatible with
 *  `exactOptionalPropertyTypes`). */
export function rangeHeader(input: {
  page_size?: number | undefined;
  cursor?: string | undefined;
}): string {
  const opts: { pageSize?: number; cursor?: string } = {};
  if (input.page_size !== undefined) opts.pageSize = input.page_size;
  if (input.cursor !== undefined) opts.cursor = input.cursor;
  return buildRangeHeader(opts);
}

/** Helper that turns a `ClientSuccess` into a success envelope; thin alias so
 *  tool bodies read uniformly. */
export function ok<T>(success: ClientSuccess<T>): ToolEnvelope<T> {
  return envelopeFromClientSuccess(success);
}

/** Zod shape shared by every paginated list tool. */
export const paginationInputShape = {
  page_size: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe('Items per page (max 1000). Defaults to 200.'),
  cursor: z
    .string()
    .optional()
    .describe('Opaque cursor returned in a previous response (`meta.pagination.cursor`).'),
};
