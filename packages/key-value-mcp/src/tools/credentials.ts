/**
 * Credential tools.
 *
 *   kv_credentials       — masked connection URL + bare host/port (read)
 *   kv_credentials_reset — rotate credentials, emit a new REDIS_URL (confirm)
 *
 * Derived from heroku/cli (commit `main`, fetched 2026-06-10):
 *   src/commands/redis/credentials.ts + src/lib/redis/api.js
 *     — `redis:credentials` reads `redis.resource_url` straight out of
 *       `GET /redis/v0/databases/{addon.name}` (there is NO `/credentials`
 *       sub-resource); `--reset` POSTs an empty body to
 *       `/redis/v0/databases/{addon.name}/credentials_rotation`.
 *
 * SENSITIVE DATA: the `resource_url` is a `rediss://:<password>@host:port`
 * string. We NEVER return the raw password to the model. `kv_credentials`
 * returns the URL with the password masked to `***`, plus the bare host and
 * port for callers that need the endpoint without a secret.
 *
 * Confirm policy: the CLI's stats-reset confirms against the owning *app* name;
 * `redis:credentials --reset` takes no confirm at all. We gate the rotation
 * behind a `confirm` equal to the add-on NAME instead — the resource the tool
 * targets and our primary input — via core `assertConfirm`. Documented
 * deviation; a stricter, more specific guard than the CLI's.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assertConfirm, envelopeFromLocal, runTool } from '@heroku-mcp/core';
import type { ToolContext } from '@heroku-mcp/core';
import { getDataBasic, postDataBasic, seg } from '../client.js';
import { resolveAddonName } from '../resolve.js';
import { addonInput, credentialsResetInput, type KvRecord } from '../types.js';

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Parsed, password-free view of a Redis connection URL. */
export interface MaskedRedisUrl {
  /** The connection URL with the password replaced by `***`. */
  connection_url: string;
  /** Connection scheme (`rediss` for TLS, `redis` for plaintext). */
  scheme: string;
  /** Hostname (safe to expose). */
  host: string;
  /** Port (safe to expose). */
  port: string;
}

/**
 * Parse a `redis(s)://[user]:<password>@host:port[/db]` resource URL into a
 * masked view. Returns null when the URL is absent or unparseable, so the tool
 * can surface a structured "no connection URL" result rather than leak a
 * half-parsed secret. The password is replaced with `***` and never returned.
 */
export function maskRedisUrl(resourceUrl: unknown): MaskedRedisUrl | null {
  const raw = str(resourceUrl);
  if (!raw) return null;
  // scheme://user:password@host:port[/...]  — user and password may be empty.
  const m = /^(rediss?):\/\/([^:@/]*):([^@]*)@([^:/]+):(\d+)(\/.*)?$/.exec(raw);
  if (!m) return null;
  const scheme = m[1] ?? 'rediss';
  const user = m[2] ?? '';
  const host = m[4] ?? '';
  const port = m[5] ?? '';
  const tail = m[6] ?? '';
  if (!host || !port) return null;
  const auth = user ? `${user}:***` : ':***';
  return {
    connection_url: `${scheme}://${auth}@${host}:${port}${tail}`,
    scheme,
    host,
    port,
  };
}

/** Register the credential tools. */
export function registerCredentialTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'kv_credentials',
    {
      title: 'Key-Value credentials (masked)',
      description:
        'Return the connection details for a Key-Value Store (Redis) instance with the password MASKED: a `rediss://:***@host:port` URL plus the bare `host` and `port`. The raw password is never returned — rotate or read it out-of-band if you need to connect. Derived from the `resource_url` of GET /redis/v0/databases/{addon} (the CLI reads the same field).',
      inputSchema: addonInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ addon }) =>
      runTool(async () => {
        const res = await getDataBasic<KvRecord>(ctx, `/databases/${seg(addon)}`, {
          tool: 'kv_credentials',
        });
        const masked = maskRedisUrl(res.body?.resource_url);
        return envelopeFromLocal({
          addon: str(res.body?.name) ?? addon,
          connection_url: masked?.connection_url ?? null,
          scheme: masked?.scheme ?? null,
          host: masked?.host ?? null,
          port: masked?.port ?? null,
          prefer_native_tls: res.body?.prefer_native_tls ?? null,
        });
      }),
  );

  server.registerTool(
    'kv_credentials_reset',
    {
      title: 'Key-Value credentials (reset)',
      description:
        'Rotate (reset) the credentials for a Key-Value Store (Redis) instance, emitting a new REDIS_URL. DESTRUCTIVE: requires confirm set to the add-on name. This disconnects every currently-connected client; apps reconnect with the new URL once their config var updates. Wraps POST /redis/v0/databases/{addon}/credentials_rotation. Derived from heroku/cli redis/credentials.ts (the --reset branch).',
      inputSchema: credentialsResetInput,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    ({ addon, confirm }) =>
      runTool(async () => {
        const name = await resolveAddonName(addon, ctx, 'kv_credentials_reset');
        assertConfirm({ value: confirm, expected: name, targetKind: 'credentials' });
        const res = await postDataBasic<KvRecord>(
          ctx,
          `/databases/${seg(name)}/credentials_rotation`,
          {},
          { tool: 'kv_credentials_reset' },
        );
        // Response is a `{message}` acknowledgement; it carries no secret.
        return envelopeFromLocal({ reset: true, addon: name, message: str(res.body?.message) });
      }),
  );
}
