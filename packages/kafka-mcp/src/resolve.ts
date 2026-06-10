/**
 * Identifier resolution for Kafka tools. Mirrors `@heroku-mcp/key-value`'s
 * resolve.ts, but inverted: the Kafka Data API addresses clusters by add-on
 * UUID, so the primary resolver produces the UUID (KV's produced the name).
 *
 * A Kafka add-on can be addressed two ways:
 *
 *   - **add-on UUID** (`a47a6373-…`) — REQUIRED by the
 *     `/data/kafka/v0/clusters/{id}/*` endpoints. The add-on NAME returns 404
 *     there (verified live 2026-06-10), so a name must be resolved to its UUID
 *     before any Data API call.
 *   - **add-on NAME** (`kafka-clean-72346`) — what a human passes and the value
 *     a future Part B destructive tool would `confirm` against.
 *
 * Each resolver passes the input straight through when it is already in the
 * wanted form (a UUID is recognised by shape; everything else is treated as a
 * name), and otherwise makes a single Platform API `GET /addons/{id}` to derive
 * the canonical fields.
 */

import { NotFoundError } from '@heroku-mcp/core';
import type { ToolContext } from '@heroku-mcp/platform';
import { seg } from './client.js';
import type { KafkaRecord } from './types.js';

/** Canonical add-on UUID shape. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True iff `s` looks like an add-on UUID (vs a `kafka-…` add-on name). */
export const isUuid = (s: string): boolean => UUID_RE.test(s);

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const obj = (v: unknown): KafkaRecord | undefined =>
  typeof v === 'object' && v !== null ? (v as KafkaRecord) : undefined;

/** The fields we derive from a single `GET /addons/{id}` Platform API lookup. */
interface AddonView {
  id: string | undefined;
  name: string | undefined;
  appName: string | undefined;
}

/** One Platform API add-on lookup, accepting either a name or UUID as `{id}`. */
async function fetchAddon(ctx: ToolContext, input: string, tool: string): Promise<AddonView> {
  const res = await ctx.client.get<KafkaRecord>(`/addons/${seg(input)}`, { tool });
  return {
    id: str(res.body?.id),
    name: str(res.body?.name),
    appName: str(obj(res.body?.app)?.name) ?? str(obj(res.body?.app)?.id),
  };
}

/**
 * Resolve an add-on name OR UUID to the cluster UUID — the form the
 * `/data/kafka/v0/clusters/{id}/*` endpoints require. UUIDs pass through
 * untouched; a name triggers a single Platform API lookup.
 */
export async function resolveClusterId(
  input: string,
  ctx: ToolContext,
  tool = 'kafka_resolve',
): Promise<string> {
  if (isUuid(input)) return input;
  const addon = await fetchAddon(ctx, input, tool);
  if (!addon.id) {
    throw new NotFoundError(`No Heroku Apache Kafka add-on found for "${input}".`, {
      details: { addon: input },
    });
  }
  return addon.id;
}

/**
 * Resolve an add-on name OR UUID to the canonical add-on NAME. Names pass
 * through untouched; a UUID triggers a lookup. Not used by the Part A read
 * tools (which key off the UUID) but provided for symmetry with
 * `@heroku-mcp/key-value` and for the future Part B `confirm` guard.
 */
export async function resolveClusterName(
  input: string,
  ctx: ToolContext,
  tool = 'kafka_resolve',
): Promise<string> {
  if (!isUuid(input)) return input;
  const addon = await fetchAddon(ctx, input, tool);
  if (!addon.name) {
    throw new NotFoundError(`No Heroku Apache Kafka add-on found for "${input}".`, {
      details: { addon: input },
    });
  }
  return addon.name;
}

/**
 * Resolve the owning APP name for a Kafka add-on (name or UUID). Always
 * performs the lookup. Not used by the Part A tools (they are add-on-scoped)
 * but provided for symmetry with the sibling packages and future parts.
 */
export async function resolveOwningApp(
  input: string,
  ctx: ToolContext,
  tool = 'kafka_resolve',
): Promise<string> {
  const addon = await fetchAddon(ctx, input, tool);
  if (!addon.appName) {
    throw new NotFoundError(
      `Could not resolve the owning app for add-on "${input}". Pass an explicit "app" argument.`,
      { details: { addon: input } },
    );
  }
  return addon.appName;
}
