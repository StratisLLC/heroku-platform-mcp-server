import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  SchemaCache,
  SchemaError,
  fetchHerokuSchema,
  getDefinition,
  isHerokuSchema,
  type HerokuSchema,
} from '../src/schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, 'fixtures', 'heroku-schema.json');

async function loadFixture(): Promise<HerokuSchema> {
  return JSON.parse(await readFile(FIXTURE_PATH, 'utf8')) as HerokuSchema;
}

describe('isHerokuSchema', () => {
  it('accepts the committed fixture', async () => {
    expect(isHerokuSchema(await loadFixture())).toBe(true);
  });

  it('rejects nonsense', () => {
    expect(isHerokuSchema(null)).toBe(false);
    expect(isHerokuSchema(42)).toBe(false);
    expect(isHerokuSchema({})).toBe(false);
    expect(isHerokuSchema({ definitions: 'not-an-object' })).toBe(false);
    expect(isHerokuSchema({ definitions: {} })).toBe(true);
  });
});

describe('getDefinition', () => {
  it('returns the named definition', async () => {
    const schema = await loadFixture();
    const account = getDefinition(schema, 'account');
    expect(account).toBeDefined();
    expect(account?.links).toBeDefined();
  });

  it('returns undefined for unknown names', async () => {
    const schema = await loadFixture();
    expect(getDefinition(schema, 'definitely-not-real')).toBeUndefined();
  });
});

describe('fetchHerokuSchema', () => {
  it('returns parsed schema and etag on 200', async () => {
    const schema = await loadFixture();
    const fetchFn: typeof globalThis.fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify(schema), {
          status: 200,
          headers: { etag: '"v1"', 'content-type': 'application/json' },
        }),
      );
    const result = await fetchHerokuSchema({ fetch: fetchFn });
    expect(result.status).toBe(200);
    expect(result.etag).toBe('"v1"');
    expect(result.schema?.definitions?.account).toBeDefined();
  });

  it('sets the Accept header with negotiated API version', async () => {
    let seenHeaders: Headers | undefined;
    const fetchFn: typeof globalThis.fetch = (_url, init) => {
      seenHeaders = new Headers(init?.headers);
      return Promise.resolve(new Response(JSON.stringify({ definitions: {} }), { status: 200 }));
    };
    await fetchHerokuSchema({ fetch: fetchFn, apiVersion: '3' });
    expect(seenHeaders?.get('Accept')).toBe('application/vnd.heroku+json; version=3');
  });

  it('forwards If-None-Match when provided', async () => {
    let seenHeaders: Headers | undefined;
    const fetchFn: typeof globalThis.fetch = (_url, init) => {
      seenHeaders = new Headers(init?.headers);
      return Promise.resolve(new Response(null, { status: 304 }));
    };
    const result = await fetchHerokuSchema({ fetch: fetchFn, ifNoneMatch: '"abc"' });
    expect(seenHeaders?.get('If-None-Match')).toBe('"abc"');
    expect(result.status).toBe(304);
    expect(result.schema).toBeUndefined();
  });

  it('throws SchemaError on invalid JSON', async () => {
    const fetchFn: typeof globalThis.fetch = () =>
      Promise.resolve(new Response('not json', { status: 200 }));
    await expect(fetchHerokuSchema({ fetch: fetchFn })).rejects.toBeInstanceOf(SchemaError);
  });

  it('throws SchemaError when the response is not a schema document', async () => {
    const fetchFn: typeof globalThis.fetch = () =>
      Promise.resolve(new Response(JSON.stringify({ hello: 'world' }), { status: 200 }));
    await expect(fetchHerokuSchema({ fetch: fetchFn })).rejects.toBeInstanceOf(SchemaError);
  });

  it('propagates non-2xx, non-304 statuses without throwing', async () => {
    const fetchFn: typeof globalThis.fetch = () =>
      Promise.resolve(new Response('{}', { status: 500 }));
    const result = await fetchHerokuSchema({ fetch: fetchFn });
    expect(result.status).toBe(500);
    expect(result.schema).toBeUndefined();
  });
});

describe('SchemaCache', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'herokumcp-schema-'));
  });

  it('fetches and persists on a cold start', async () => {
    const schema = await loadFixture();
    let fetched = 0;
    const fetchFn: typeof globalThis.fetch = () => {
      fetched += 1;
      return Promise.resolve(
        new Response(JSON.stringify(schema), {
          status: 200,
          headers: { etag: '"v1"' },
        }),
      );
    };
    const cache = new SchemaCache({ path: join(dir, 'schema.json'), fetch: fetchFn });
    const loaded = await cache.load();
    expect(loaded.definitions?.account).toBeDefined();
    expect(fetched).toBe(1);
    const onDisk = JSON.parse(await readFile(join(dir, 'schema.json'), 'utf8'));
    expect(onDisk.etag).toBe('"v1"');
  });

  it('serves from cache when within TTL', async () => {
    const schema = await loadFixture();
    let nowMs = 1_000_000;
    let fetched = 0;
    const fetchFn: typeof globalThis.fetch = () => {
      fetched += 1;
      return Promise.resolve(
        new Response(JSON.stringify(schema), {
          status: 200,
          headers: { etag: '"v1"' },
        }),
      );
    };
    const cache = new SchemaCache({
      path: join(dir, 'schema.json'),
      fetch: fetchFn,
      ttlMs: 60_000,
      now: () => nowMs,
    });
    await cache.load();
    nowMs += 30_000;
    await cache.load();
    expect(fetched).toBe(1);
  });

  it('revalidates with If-None-Match after TTL expiry', async () => {
    const schema = await loadFixture();
    let nowMs = 1_000_000;
    let lastIfNoneMatch: string | undefined;
    const responses: (() => Response)[] = [
      () =>
        new Response(JSON.stringify(schema), {
          status: 200,
          headers: { etag: '"v1"' },
        }),
      () => new Response(null, { status: 304 }),
    ];
    const fetchFn: typeof globalThis.fetch = (_url, init) => {
      const headers = new Headers(init?.headers);
      lastIfNoneMatch = headers.get('If-None-Match') ?? undefined;
      return Promise.resolve(responses.shift()!());
    };
    const cache = new SchemaCache({
      path: join(dir, 'schema.json'),
      fetch: fetchFn,
      ttlMs: 60_000,
      now: () => nowMs,
    });
    await cache.load();
    nowMs += 120_000;
    const second = await cache.load();
    expect(lastIfNoneMatch).toBe('"v1"');
    expect(second.definitions?.account).toBeDefined();
  });

  it('forceRefresh re-fetches even when within TTL', async () => {
    const schema = await loadFixture();
    let fetched = 0;
    const fetchFn: typeof globalThis.fetch = () => {
      fetched += 1;
      return Promise.resolve(
        new Response(JSON.stringify(schema), {
          status: 200,
          headers: { etag: '"v1"' },
        }),
      );
    };
    const cache = new SchemaCache({
      path: join(dir, 'schema.json'),
      fetch: fetchFn,
    });
    await cache.load();
    await cache.load({ forceRefresh: true });
    expect(fetched).toBe(2);
  });

  it('returns null from readCache when file is missing', async () => {
    const cache = new SchemaCache({
      path: join(dir, 'does-not-exist.json'),
      fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
    });
    expect(await cache.readCache()).toBeNull();
  });

  it('treats a corrupt cache file as no cache', async () => {
    const path = join(dir, 'schema.json');
    await writeFile(path, '{not-json', 'utf8');
    const schema = await loadFixture();
    const fetchFn: typeof globalThis.fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify(schema), {
          status: 200,
          headers: { etag: '"fresh"' },
        }),
      );
    const cache = new SchemaCache({ path, fetch: fetchFn });
    const loaded = await cache.load();
    expect(loaded.definitions?.account).toBeDefined();
  });

  it('throws when both fetch fails and no cache exists', async () => {
    const fetchFn: typeof globalThis.fetch = () =>
      Promise.resolve(new Response('oops', { status: 500 }));
    const cache = new SchemaCache({
      path: join(dir, 'schema.json'),
      fetch: fetchFn,
    });
    await expect(cache.load()).rejects.toBeInstanceOf(SchemaError);
  });
});
