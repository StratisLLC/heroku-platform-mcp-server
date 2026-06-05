/**
 * Follower / replication tools (reads). Gated on the `pg_followers` sub-tier.
 *
 *   pg_followers_list     — read replicas of a leader database
 *   pg_leader             — the leader of a given follower (404 if standalone)
 *   pg_replication_status — leader / follower / standalone role + lag
 *
 * Heroku does not expose a single "what is my leader" endpoint; the leader and
 * follower relationships surface in the database `info` payload (the "Following"
 * and "Followers" rows). pg_leader and pg_replication_status derive their answer
 * from that payload so callers don't have to parse it themselves.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NotFoundError } from '@heroku-mcp/core';
import { envelopeFromLocal, ok, runTool } from '@heroku-mcp/platform';
import type { ToolContext } from '@heroku-mcp/platform';
import { assertFamilyAvailable, getData, seg } from '../client.js';
import { databaseInput, type PgList, type PgRecord } from '../types.js';

/** Find an entry in the Data API `info` array by its display name (case-insensitive). */
function infoEntry(body: unknown, name: string): { name: string; values: unknown } | undefined {
  const record = typeof body === 'object' && body !== null ? (body as PgRecord) : undefined;
  const info = record && Array.isArray(record.info) ? (record.info as PgList) : [];
  const lower = name.toLowerCase();
  const hit = info.find(
    (e) => typeof e.name === 'string' && e.name.toLowerCase() === lower,
  );
  if (!hit) return undefined;
  return { name: hit.name as string, values: hit.values };
}

/** Register the follower / replication read tools. */
export function registerFollowerTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'pg_followers_list',
    {
      title: 'Postgres followers (list)',
      description:
        'List the followers (read replicas) of a leader database. Wraps GET /client/v11/databases/{database}/followers.',
      inputSchema: databaseInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ database }) =>
      runTool(async () => {
        assertFamilyAvailable(ctx, 'pg_followers', 'Postgres followers');
        const res = await getData<PgList>(ctx, `/databases/${seg(database)}/followers`, {
          tool: 'pg_followers_list',
        });
        return ok(res);
      }),
  );

  server.registerTool(
    'pg_leader',
    {
      title: 'Postgres leader (of a follower)',
      description:
        'Given a follower database, return the leader it follows. Errors with not_found if the database is a standalone or a leader (i.e. not following anything). Derived from GET /client/v11/databases/{database}.',
      inputSchema: databaseInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ database }) =>
      runTool(async () => {
        assertFamilyAvailable(ctx, 'pg_followers', 'Postgres followers');
        const res = await getData<PgRecord>(ctx, `/databases/${seg(database)}`, {
          tool: 'pg_leader',
        });
        const following = infoEntry(res.body, 'Following');
        if (!following) {
          throw new NotFoundError(
            `Database ${database} is not a follower — it does not follow a leader.`,
            { details: { database } },
          );
        }
        return envelopeFromLocal({ following: following.values });
      }),
  );

  server.registerTool(
    'pg_replication_status',
    {
      title: 'Postgres replication status',
      description:
        'Report whether a database is a leader, a follower, or standalone, with the relevant lag/peer details. Derived from GET /client/v11/databases/{database}.',
      inputSchema: databaseInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ database }) =>
      runTool(async () => {
        assertFamilyAvailable(ctx, 'pg_followers', 'Postgres followers');
        const res = await getData<PgRecord>(ctx, `/databases/${seg(database)}`, {
          tool: 'pg_replication_status',
        });
        const following = infoEntry(res.body, 'Following');
        const followers = infoEntry(res.body, 'Followers');
        const role = following ? 'follower' : followers ? 'leader' : 'standalone';
        return envelopeFromLocal({
          role,
          following: following?.values ?? null,
          followers: followers?.values ?? null,
        });
      }),
  );
}
