/**
 * Credential tool tests: kv_credentials, kv_credentials_reset, maskRedisUrl.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { maskRedisUrl } from '../src/index.js';
import { parseEnvelope, spinUpServer, type RecordedCall } from './helpers.js';

function fixture(name: string): Record<string, unknown> {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

const REDIS_V0 = 'https://api.data.heroku.com/redis/v0';
const NAME = 'redis-shallow-89243';
const find = (calls: RecordedCall[], pred: (c: RecordedCall) => boolean) => calls.find(pred);

describe('kv_credentials', () => {
  it('registers the credential tools', async () => {
    const { client } = await spinUpServer();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['kv_credentials', 'kv_credentials_reset']));
  });

  it('masks the password and exposes bare host/port from the captured fixture', async () => {
    const body = fixture('kv-credentials.captured.json');
    const { client, calls } = await spinUpServer({
      responses: [{ match: (url) => url === `${REDIS_V0}/databases/${NAME}`, body }],
    });
    const result = (await client.callTool({
      name: 'kv_credentials',
      arguments: { addon: NAME },
    })) as { content: unknown[] };
    const env = parseEnvelope<{
      connection_url: string;
      host: string;
      port: string;
      scheme: string;
    }>(result);
    expect(env.ok).toBe(true);
    expect(calls[0]?.headers.authorization).toMatch(/^Basic /);
    // Password masked; the raw (redacted) secret never appears in output.
    expect(env.data?.connection_url).toMatch(/^rediss:\/\/:\*\*\*@/);
    expect(JSON.stringify(env.data)).not.toContain('REDACTED_TEST_PASSWORD');
    expect(env.data?.scheme).toBe('rediss');
    expect(env.data?.host).toBeTruthy();
    expect(env.data?.port).toMatch(/^\d+$/);
    // host/port agree with the fixture's resource_url.
    const m = /@([^:]+):(\d+)/.exec(String(body.resource_url));
    expect(env.data?.host).toBe(m?.[1]);
    expect(env.data?.port).toBe(m?.[2]);
  });

  it('returns nulls when the instance has no usable resource_url', async () => {
    const { client } = await spinUpServer({
      responses: [
        { match: (url) => url === `${REDIS_V0}/databases/${NAME}`, body: { name: NAME } },
      ],
    });
    const result = (await client.callTool({
      name: 'kv_credentials',
      arguments: { addon: NAME },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ connection_url: string | null; host: string | null }>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.connection_url).toBeNull();
    expect(env.data?.host).toBeNull();
  });
});

describe('kv_credentials_reset', () => {
  it('POSTs an empty body to credentials_rotation (Basic) after confirm', async () => {
    const { client, calls } = await spinUpServer({
      responses: [
        {
          match: (url, init) =>
            url === `${REDIS_V0}/databases/${NAME}/credentials_rotation` && init?.method === 'POST',
          body: fixture('kv-credentials-reset.captured.json'),
        },
      ],
    });
    const result = (await client.callTool({
      name: 'kv_credentials_reset',
      arguments: { addon: NAME, confirm: NAME },
    })) as { content: unknown[] };
    const env = parseEnvelope<{ reset: boolean; message: string }>(result);
    expect(env.ok).toBe(true);
    expect(env.data?.reset).toBe(true);
    expect(env.data?.message).toMatch(/rotation successful/i);
    const post = find(calls, (c) => c.method === 'POST');
    expect(post?.headers.authorization).toMatch(/^Basic /);
    expect(JSON.parse(post?.body ?? 'null')).toEqual({});
  });

  it('rejects a confirm mismatch with no HTTP call', async () => {
    const { client, calls } = await spinUpServer();
    const result = (await client.callTool({
      name: 'kv_credentials_reset',
      arguments: { addon: NAME, confirm: 'wrong' },
    })) as { isError?: boolean; content: unknown[] };
    expect(result.isError).toBe(true);
    expect(parseEnvelope(result).error?.kind).toBe('confirmation');
    expect(calls).toHaveLength(0);
  });

  it('maps a 404 from the rotation endpoint', async () => {
    const { client } = await spinUpServer({
      responses: [
        {
          match: (url) => url === `${REDIS_V0}/databases/${NAME}/credentials_rotation`,
          status: 404,
          body: { message: 'Not found.' },
        },
      ],
    });
    const result = (await client.callTool({
      name: 'kv_credentials_reset',
      arguments: { addon: NAME, confirm: NAME },
    })) as { isError?: boolean; content: unknown[] };
    expect(result.isError).toBe(true);
    expect(parseEnvelope(result).error?.kind).toBe('not_found');
  });
});

describe('maskRedisUrl', () => {
  it('masks the password, keeping scheme/host/port (the real rediss shape)', () => {
    const out = maskRedisUrl('rediss://:secretpw@ec2-1-2-3-4.compute-1.amazonaws.com:17930');
    expect(out).toEqual({
      connection_url: 'rediss://:***@ec2-1-2-3-4.compute-1.amazonaws.com:17930',
      scheme: 'rediss',
      host: 'ec2-1-2-3-4.compute-1.amazonaws.com',
      port: '17930',
    });
  });

  it('handles a user:password form and a trailing path', () => {
    const out = maskRedisUrl('redis://h:pw@host.example.com:6379/0');
    expect(out?.connection_url).toBe('redis://h:***@host.example.com:6379/0');
    expect(out?.scheme).toBe('redis');
  });

  it('returns null for absent or unparseable URLs', () => {
    expect(maskRedisUrl(undefined)).toBeNull();
    expect(maskRedisUrl('')).toBeNull();
    expect(maskRedisUrl('not-a-url')).toBeNull();
    expect(maskRedisUrl('rediss://host-no-port')).toBeNull();
  });

  it('never leaks the password for the captured fixture', () => {
    const out = maskRedisUrl(fixture('kv-credentials.captured.json').resource_url);
    expect(out?.connection_url).toMatch(/:\*\*\*@/);
    expect(out?.connection_url).not.toContain('REDACTED_TEST_PASSWORD');
  });
});
