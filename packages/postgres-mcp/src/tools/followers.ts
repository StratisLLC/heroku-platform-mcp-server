/**
 * Follower / replication tools (reads). Gated on the `pg_followers` sub-tier.
 *
 *   pg_followers_list     — read replicas of a leader database
 *   pg_leader             — the leader of a given follower (404 if standalone)
 *   pg_replication_status — leader / follower / standalone role + lag
 *
 * Heroku does NOT expose a dedicated followers endpoint. The leader/follower
 * relationship surfaces in the standard database `info` payload (the same array
 * `pg:info` renders): a "Following" row means this DB follows a leader, a
 * "Followers" row means it has replicas, and a "Behind By" row reports lag. On
 * plans that don't support replication the "Fork/Follow" row reads "Unsupported".
 *
 * All three tools therefore read `GET /client/v11/databases/{id}` (the same call
 * `pg_info` makes) and project the relevant rows out of `info`.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NotFoundError } from '@heroku-mcp/core';
import { envelopeFromLocal, runTool } from '@heroku-mcp/platform';
import type { ToolContext } from '@heroku-mcp/platform';
import { assertFamilyAvailable, getData, seg } from '../client.js';
import { databaseInput, type PgList, type PgRecord } from '../types.js';

/** Find an entry in the Data API `info` array by its display name (case-insensitive). */
function infoEntry(body: unknown, name: string): { name: string; values: unknown } | undefined {
  const record = typeof body === 'object' && body !== null ? (body as PgRecord) : undefined;
  const info = record && Array.isArray(record.info) ? (record.info as PgList) : [];
  const lower = name.toLowerCase();
  const hit = info.find((e) => typeof e.name === 'string' && e.name.toLowerCase() === lower);
  if (!hit) return undefined;
  return { name: hit.name as string, values: hit.values };
}

/** True when the database's plan does not support fork/follow (replication). */
function forkFollowUnsupported(body: unknown): boolean {
  const ff = infoEntry(body, 'Fork/Follow');
  const values = Array.isArray(ff?.values) ? (ff.values as unknown[]) : [];
  return values.some((v) => typeof v === 'string' && v.toLowerCase() === 'unsupported');
}

/** Fetch the database `info` payload (the same call `pg_info` makes). */
function getDbInfo(ctx: ToolContext, database: string, tool: string): Promise<{ body: PgRecord }> {
  return getData<PgRecord>(ctx, `/databases/${seg(database)}`, { tool });
}

/** Register the follower / replication read tools. */
export function registerFollowerTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'pg_followers_list',
    {
      title: 'Postgres followers (list)',
      description:
        'List the followers (read replicas) of a leader database. Derived from the "Followers" row of GET /client/v11/databases/{database}; returns an empty list when the database has no followers or its plan does not support replication.',
      inputSchema: databaseInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ database }) =>
      runTool(async () => {
        assertFamilyAvailable(ctx, 'pg_followers', 'Postgres followers');
        const res = await getDbInfo(ctx, database, 'pg_followers_list');
        if (forkFollowUnsupported(res.body)) {
          return envelopeFromLocal({ supported: false, followers: [] });
        }
        const followers = infoEntry(res.body, 'Followers');
        return envelopeFromLocal({ supported: true, followers: followers?.values ?? [] });
      }),
  );

  server.registerTool(
    'pg_leader',
    {
      title: 'Postgres leader (of a follower)',
      description:
        'Given a follower database, return the leader it follows. Errors with not_found if the database is a standalone or a leader (i.e. not following anything). Derived from the "Following" row of GET /client/v11/databases/{database}.',
      inputSchema: databaseInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ database }) =>
      runTool(async () => {
        assertFamilyAvailable(ctx, 'pg_followers', 'Postgres followers');
        const res = await getDbInfo(ctx, database, 'pg_leader');
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
        'Report whether a database is a leader, a follower, or standalone, with the relevant lag/peer details. Derived from the "Following" / "Followers" / "Behind By" rows of GET /client/v11/databases/{database}.',
      inputSchema: databaseInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ database }) =>
      runTool(async () => {
        assertFamilyAvailable(ctx, 'pg_followers', 'Postgres followers');
        const res = await getDbInfo(ctx, database, 'pg_replication_status');
        if (forkFollowUnsupported(res.body)) {
          return envelopeFromLocal({
            role: 'unsupported',
            note: 'Replication (fork/follow) is not available on this database plan.',
            following: null,
            followers: null,
            behind_by: null,
          });
        }
        const following = infoEntry(res.body, 'Following');
        const followers = infoEntry(res.body, 'Followers');
        const behindBy = infoEntry(res.body, 'Behind By');
        const role = following ? 'follower' : followers ? 'leader' : 'standalone';
        return envelopeFromLocal({
          role,
          following: following?.values ?? null,
          followers: followers?.values ?? null,
          behind_by: behindBy?.values ?? null,
        });
      }),
  );
}
