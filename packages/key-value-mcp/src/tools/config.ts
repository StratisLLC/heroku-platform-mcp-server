/**
 * Configuration & maintenance write tools. All hit the `/redis/v0/*` namespace
 * (HTTP Basic auth). The three config setters are gated on the `kv_config`
 * capability sub-tier; `kv_stats_reset` is gated only on the package root tier.
 *
 *   kv_maxmemory_set               — eviction policy            (confirm)
 *   kv_timeout_set                 — idle connection timeout     (confirm)
 *   kv_keyspace_notifications_set  — keyspace notifications      (confirm)
 *   kv_stats_reset                 — reset RESETSTAT counters    (confirm)
 *
 * Derived from heroku/cli (commit `main`, fetched 2026-06-10):
 *   src/commands/redis/maxmemory.ts
 *     — PATCH /redis/v0/databases/{addon.name}/config {maxmemory_policy}
 *   src/commands/redis/timeout.ts
 *     — PATCH /redis/v0/databases/{addon.id}/config {timeout}
 *   src/commands/redis/keyspace-notifications.ts
 *     — PATCH /redis/v0/databases/{addon.name}/config {notify_keyspace_events}
 *   src/commands/redis/stats-reset.ts
 *     — POST  /redis/v0/databases/{addon.id}/stats/reset {}  (CLI takes -c/--confirm)
 *
 * Note the CLI's mixed id/name usage per endpoint — we mirror it exactly
 * (maxmemory/keyspace by name, timeout/stats by id), though the `/redis/v0/*`
 * endpoints accept either form (verified live 2026-06-10).
 *
 * Confirm policy: the CLI confirms `redis:stats-reset` against the owning *app*
 * name and the config setters not at all. We gate every mutation behind a
 * `confirm` equal to the add-on NAME (core `assertConfirm`) — a stricter, more
 * specific guard. Documented deviation.
 *
 * A `PATCH .../config` returns the FULL config object; we project the single
 * field the tool changed (its `.value`) so the response is unambiguous.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assertConfirm, envelopeFromLocal, runTool } from '@heroku-mcp/core';
import type { ToolContext } from '@heroku-mcp/core';
import { assertFamilyAvailable, patchDataBasic, postDataBasic, seg } from '../client.js';
import { resolveAddonId, resolveAddonName } from '../resolve.js';
import {
  keyspaceNotificationsSetInput,
  maxmemorySetInput,
  statsResetInput,
  timeoutSetInput,
  type KvRecord,
} from '../types.js';

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const obj = (v: unknown): KvRecord | undefined =>
  typeof v === 'object' && v !== null ? (v as KvRecord) : undefined;

/** Pull `{field}.value` out of a PATCH `/config` response. */
function configValue(body: unknown, field: string): unknown {
  return obj(obj(body)?.[field])?.value ?? null;
}

/** Register the configuration & maintenance write tools. */
export function registerConfigTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'kv_maxmemory_set',
    {
      title: 'Key-Value maxmemory policy (set)',
      description:
        'Set the key eviction policy applied when a Key-Value Store (Redis) instance reaches its memory limit (e.g. "noeviction", "allkeys-lru", "volatile-ttl"). MUTATING: requires confirm set to the add-on name. Wraps PATCH /redis/v0/databases/{addon}/config {maxmemory_policy}. Derived from heroku/cli redis/maxmemory.ts.',
      inputSchema: maxmemorySetInput,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    ({ addon, policy, confirm }) =>
      runTool(async () => {
        assertFamilyAvailable(ctx, 'kv_config', 'Key-Value configuration');
        const name = await resolveAddonName(addon, ctx, 'kv_maxmemory_set');
        assertConfirm({ value: confirm, expected: name, targetKind: 'addon' });
        const res = await patchDataBasic<KvRecord>(
          ctx,
          `/databases/${seg(name)}/config`,
          { maxmemory_policy: policy },
          { tool: 'kv_maxmemory_set' },
        );
        return envelopeFromLocal({
          addon: name,
          maxmemory_policy: configValue(res.body, 'maxmemory_policy'),
        });
      }),
  );

  server.registerTool(
    'kv_timeout_set',
    {
      title: 'Key-Value idle timeout (set)',
      description:
        'Set the number of seconds an idle client connection may stay open before the Key-Value Store (Redis) instance closes it. 0 means connections never time out. MUTATING: requires confirm set to the add-on name. Wraps PATCH /redis/v0/databases/{addon}/config {timeout}. Derived from heroku/cli redis/timeout.ts.',
      inputSchema: timeoutSetInput,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    ({ addon, seconds, confirm }) =>
      runTool(async () => {
        assertFamilyAvailable(ctx, 'kv_config', 'Key-Value configuration');
        const name = await resolveAddonName(addon, ctx, 'kv_timeout_set');
        assertConfirm({ value: confirm, expected: name, targetKind: 'addon' });
        // The CLI addresses this endpoint by addon.id (not name); resolve it.
        const id = await resolveAddonId(addon, ctx, 'kv_timeout_set');
        const res = await patchDataBasic<KvRecord>(
          ctx,
          `/databases/${seg(id)}/config`,
          { timeout: seconds },
          { tool: 'kv_timeout_set' },
        );
        return envelopeFromLocal({ addon: name, timeout: configValue(res.body, 'timeout') });
      }),
  );

  server.registerTool(
    'kv_keyspace_notifications_set',
    {
      title: 'Key-Value keyspace notifications (set)',
      description:
        'Set the keyspace notifications class string (Redis `notify-keyspace-events`) for a Key-Value Store instance. Empty string disables; "AKE" enables all events except key-miss. MUTATING: requires confirm set to the add-on name. Lower-risk than the other config writes (purely observational), but gated for symmetry. Wraps PATCH /redis/v0/databases/{addon}/config {notify_keyspace_events}. Derived from heroku/cli redis/keyspace-notifications.ts.',
      inputSchema: keyspaceNotificationsSetInput,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    ({ addon, config, confirm }) =>
      runTool(async () => {
        assertFamilyAvailable(ctx, 'kv_config', 'Key-Value configuration');
        const name = await resolveAddonName(addon, ctx, 'kv_keyspace_notifications_set');
        assertConfirm({ value: confirm, expected: name, targetKind: 'addon' });
        const res = await patchDataBasic<KvRecord>(
          ctx,
          `/databases/${seg(name)}/config`,
          { notify_keyspace_events: config },
          { tool: 'kv_keyspace_notifications_set' },
        );
        return envelopeFromLocal({
          addon: name,
          notify_keyspace_events: configValue(res.body, 'notify_keyspace_events'),
        });
      }),
  );

  server.registerTool(
    'kv_stats_reset',
    {
      title: 'Key-Value stats (reset)',
      description:
        'Reset all stats covered by Redis RESETSTAT (commandstats, latency, error and keyspace hit/miss counters) on a Key-Value Store instance. MUTATING (irreversible, but does not touch stored data): requires confirm set to the add-on name. Wraps POST /redis/v0/databases/{addon}/stats/reset. Derived from heroku/cli redis/stats-reset.ts.',
      inputSchema: statsResetInput,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    ({ addon, confirm }) =>
      runTool(async () => {
        const name = await resolveAddonName(addon, ctx, 'kv_stats_reset');
        assertConfirm({ value: confirm, expected: name, targetKind: 'addon' });
        // The CLI addresses this endpoint by addon.id (not name); resolve it.
        const id = await resolveAddonId(addon, ctx, 'kv_stats_reset');
        const res = await postDataBasic<KvRecord>(
          ctx,
          `/databases/${seg(id)}/stats/reset`,
          {},
          { tool: 'kv_stats_reset' },
        );
        return envelopeFromLocal({ reset: true, addon: name, message: str(res.body?.message) });
      }),
  );
}
