/**
 * Follower / replication tool tests: pg_followers_list, pg_leader,
 * pg_replication_status.
 */

import { describe, expect, it } from 'vitest';
import { parseEnvelope, spinUpServer } from './helpers.js';

const DATA = 'https://api.data.heroku.com/client/v11';

const dbInfo = (entries: { name: string; values: unknown }[]) => ({ info: entries });

describe('follower tools', () => {
  it('registers the follower read tools', async () => {
    const { client } = await spinUpServer();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['pg_followers_list', 'pg_leader', 'pg_replication_status']),
    );
  });

  it('pg_followers_list derives from the database info (no dedicated endpoint)', async () => {
    const { client, calls } = await spinUpServer({
      responses: [
        {
          match: (url) => url === `${DATA}/databases/a-pg`,
          body: dbInfo([{ name: 'Followers', values: ['follower-a', 'follower-b'] }]),
        },
      ],
    });
    const result = (await client.callTool({
      name: 'pg_followers_list',
      arguments: { database: 'a-pg' },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ supported: boolean; followers: unknown }>(result);
    expect(env.ok).toBe(true);
    // It reads the same GET /databases/{id} call pg_info uses.
    expect(calls[0]?.url).toBe(`${DATA}/databases/a-pg`);
    expect(env.data?.supported).toBe(true);
    expect(env.data?.followers).toEqual(['follower-a', 'follower-b']);
  });

  it('pg_followers_list returns empty + unsupported when the plan has no fork/follow', async () => {
    const { client } = await spinUpServer({
      responses: [
        {
          match: (url) => url === `${DATA}/databases/a-pg`,
          body: dbInfo([{ name: 'Fork/Follow', values: ['Unsupported'] }]),
        },
      ],
    });
    const result = (await client.callTool({
      name: 'pg_followers_list',
      arguments: { database: 'a-pg' },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ supported: boolean; followers: unknown[] }>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.supported).toBe(false);
    expect(env.data?.followers).toEqual([]);
  });

  it('pg_leader returns the Following entry when the db is a follower', async () => {
    const { client } = await spinUpServer({
      responses: [
        {
          match: (url) => url === `${DATA}/databases/a-pg`,
          body: dbInfo([{ name: 'Following', values: ['postgres://leader-host'] }]),
        },
      ],
    });
    const result = (await client.callTool({
      name: 'pg_leader',
      arguments: { database: 'a-pg' },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ following: unknown }>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.following).toEqual(['postgres://leader-host']);
  });

  it('pg_leader errors not_found when the db is not following anything', async () => {
    const { client } = await spinUpServer({
      responses: [
        {
          match: (url) => url === `${DATA}/databases/a-pg`,
          body: dbInfo([{ name: 'Plan', values: ['Standard 0'] }]),
        },
      ],
    });
    const result = (await client.callTool({
      name: 'pg_leader',
      arguments: { database: 'a-pg' },
    })) as { isError?: boolean; content: unknown[] };
    expect(result.isError).toBe(true);
    expect(parseEnvelope(result).error?.kind).toBe('not_found');
  });

  it('pg_replication_status reports leader / follower / standalone', async () => {
    const cases: { entries: { name: string; values: unknown }[]; role: string }[] = [
      { entries: [{ name: 'Followers', values: ['f1'] }], role: 'leader' },
      { entries: [{ name: 'Following', values: ['l1'] }], role: 'follower' },
      { entries: [{ name: 'Plan', values: ['Standard 0'] }], role: 'standalone' },
    ];
    for (const { entries, role } of cases) {
      const { client } = await spinUpServer({
        responses: [{ match: (url) => url === `${DATA}/databases/a-pg`, body: dbInfo(entries) }],
      });
      const result = (await client.callTool({
        name: 'pg_replication_status',
        arguments: { database: 'a-pg' },
      })) as { content: unknown[] };
      const env = parseEnvelope<{ role: string }>(result);
      expect(env.ok).toBe(true);
      expect(env.data?.role).toBe(role);
    }
  });

  it('pg_replication_status reports role "unsupported" on plans without fork/follow', async () => {
    const { client } = await spinUpServer({
      responses: [
        {
          match: (url) => url === `${DATA}/databases/a-pg`,
          body: dbInfo([{ name: 'Fork/Follow', values: ['Unsupported'] }]),
        },
      ],
    });
    const result = (await client.callTool({
      name: 'pg_replication_status',
      arguments: { database: 'a-pg' },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ role: string; note?: string }>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.role).toBe('unsupported');
    expect(env.data?.note).toMatch(/not available/i);
  });

  it('pg_replication_status surfaces "Behind By" lag for a follower', async () => {
    const { client } = await spinUpServer({
      responses: [
        {
          match: (url) => url === `${DATA}/databases/a-pg`,
          body: dbInfo([
            { name: 'Following', values: ['leader-1'] },
            { name: 'Behind By', values: ['12 commits'] },
          ]),
        },
      ],
    });
    const result = (await client.callTool({
      name: 'pg_replication_status',
      arguments: { database: 'a-pg' },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ role: string; behind_by: unknown }>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.role).toBe('follower');
    expect(env.data?.behind_by).toEqual(['12 commits']);
  });
});
