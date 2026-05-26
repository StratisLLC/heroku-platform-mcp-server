/**
 * Tool-response envelope (ARCHITECTURE.md §8.5).
 *
 * Every tool returns a single MCP `TextContent` carrying the JSON-serialised
 * envelope below. Success and failure share the same outer shape so MCP hosts
 * (and the model reading the response) can switch on `ok` without parsing the
 * full payload.
 *
 *   { ok: true,  data: <heroku response>, meta: {...} }
 *   { ok: false, error: {...} }
 */

import type { ClientSuccess, ToolErrorEnvelope } from '@heroku-mcp/core';

/** Optional per-call hints surfaced under `meta`. */
export interface SuccessMeta {
  requestId?: string;
  rateLimitRemaining?: number;
  pagination?: {
    hasMore: boolean;
    cursor?: string;
  };
  cached?: boolean;
}

export interface ToolSuccessEnvelope<T = unknown> {
  ok: true;
  data: T;
  meta: SuccessMeta;
}

/** Either-shape used for all tool responses. */
export type ToolEnvelope<T = unknown> = ToolSuccessEnvelope<T> | ToolErrorEnvelope;

/** Build a success envelope from a {@link ClientSuccess}. */
export function envelopeFromClientSuccess<T>(success: ClientSuccess<T>): ToolSuccessEnvelope<T> {
  const meta: SuccessMeta = {};
  if (success.requestId !== undefined) meta.requestId = success.requestId;
  if (success.rateLimitRemaining !== undefined)
    meta.rateLimitRemaining = success.rateLimitRemaining;
  if (success.cached) meta.cached = true;
  if (success.pagination?.hasMore) {
    const page: { hasMore: boolean; cursor?: string } = { hasMore: true };
    if (success.pagination.cursor !== undefined) page.cursor = success.pagination.cursor;
    meta.pagination = page;
  } else if (success.pagination !== undefined) {
    meta.pagination = { hasMore: false };
  }
  return { ok: true, data: success.body, meta };
}

/** Wrap an arbitrary payload as a success envelope (no HTTP call involved). */
export function envelopeFromLocal<T>(data: T, meta: SuccessMeta = {}): ToolSuccessEnvelope<T> {
  return { ok: true, data, meta };
}

/** Build the MCP `content` array carrying a stringified envelope. The MCP
 *  spec models tool output as an array of typed content items; for data tools
 *  we use a single `text` item with `application/json`-shaped content. */
export function toolContent(envelope: ToolEnvelope): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(envelope, null, 2) }];
}
