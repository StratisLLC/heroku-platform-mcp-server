/**
 * Shared zod input shapes and TypeScript response aliases for the Key-Value MCP
 * tools. Mirrors `@heroku-mcp/postgres`'s types.ts.
 *
 * Responses from the Heroku Data API are passed through to the caller verbatim
 * inside the standard tool envelope (matching `@heroku-mcp/platform`'s
 * pass-through convention), so we model them as loose records rather than
 * pinning a strict schema that would drift against Heroku's evolving payloads.
 * Inputs, by contrast, ARE strictly validated — they are the only thing the
 * model controls.
 */

import { z } from 'zod';

/** A Heroku JSON object we don't strictly model — passed through verbatim. */
export type KvRecord = Record<string, unknown>;
/** A list of {@link KvRecord}. */
export type KvList = KvRecord[];

/** An add-on identifier. The Key-Value Data API accepts the add-on UUID or the
 *  add-on name (e.g. `redis-shallow-89243`) interchangeably. */
export const addonInput = {
  addon: z
    .string()
    .min(1)
    .describe(
      'Heroku Key-Value Store (Redis) add-on identifier — the add-on id (UUID) or add-on name (e.g. "redis-shallow-89243").',
    ),
};

/** Build a `confirm` field whose description tells the model what to pass.
 *  Identical contract to `@heroku-mcp/postgres`: the value must equal the
 *  resolved add-on name, surfaced here so a model can fill it correctly on the
 *  second attempt after a structured `confirmation` error. */
export const confirmField = (passWhat: string) =>
  z
    .string()
    .min(1)
    .describe(
      `Confirmation guard for this destructive operation. Pass ${passWhat} to proceed; ` +
        `any other value is rejected with a structured "confirmation" error (no API call is made). ` +
        `Only fill this once the user has explicitly confirmed the action.`,
    );

/** `kv_credentials_reset` — destructive (rotates credentials, kicks clients). */
export const credentialsResetInput = {
  ...addonInput,
  confirm: confirmField('the add-on name'),
};

/** `kv_stats_reset` — destructive per the CLI (`redis:stats-reset` takes -c). */
export const statsResetInput = {
  ...addonInput,
  confirm: confirmField('the add-on name'),
};

/** The eviction policies accepted by `redis:maxmemory` (CLI source
 *  `src/commands/redis/maxmemory.ts`). */
export const MAXMEMORY_POLICIES = [
  'noeviction',
  'allkeys-lfu',
  'volatile-lfu',
  'allkeys-lru',
  'volatile-lru',
  'allkeys-random',
  'volatile-random',
  'volatile-ttl',
] as const;

/** `kv_maxmemory_set` — mutating. */
export const maxmemorySetInput = {
  ...addonInput,
  policy: z
    .enum(MAXMEMORY_POLICIES)
    .describe(
      'Key eviction policy applied when the instance reaches its memory limit. ' +
        'e.g. "noeviction" (return errors), "allkeys-lru" (evict least-recently-used), ' +
        '"volatile-ttl" (evict shortest-TTL keys with an expiry).',
    ),
  confirm: confirmField('the add-on name'),
};

/** `kv_timeout_set` — mutating. */
export const timeoutSetInput = {
  ...addonInput,
  seconds: z
    .number()
    .int()
    .min(0)
    .describe(
      'Seconds an idle client connection may stay open before being closed. 0 means connections never time out.',
    ),
  confirm: confirmField('the add-on name'),
};

/** `kv_keyspace_notifications_set` — mutating. */
export const keyspaceNotificationsSetInput = {
  ...addonInput,
  config: z
    .string()
    .describe(
      'Keyspace notifications class string (Redis `notify-keyspace-events`). ' +
        'Empty string disables notifications; "AKE" enables all events except key-miss. ' +
        'Character set: K (keyspace), E (keyevent), g/$/l/s/h/z/t (command classes), ' +
        'x (expired), e (evicted), m (key miss), A (alias for "g$lshzxet").',
    ),
  confirm: confirmField('the add-on name'),
};
