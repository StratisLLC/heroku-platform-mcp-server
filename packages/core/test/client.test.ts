import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLogger, auditFileName } from '../src/audit.js';
import { HEROKU_ALLOWED_HOSTS, createClient, type ClientConfig } from '../src/client.js';
import {
  AuthError,
  ConflictError,
  ForbiddenError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  ServerError,
} from '../src/errors.js';
import { ETagCache } from '../src/etag.js';
import { RateLimitTracker } from '../src/ratelimit.js';

/** Build a Response-like object with helpful header access. */
function mkResponse(opts: {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}): Response {
  const headers = new Headers();
  for (const [k, v] of Object.entries(opts.headers ?? {})) headers.set(k, v);
  const bodyText = opts.body === undefined ? null : JSON.stringify(opts.body);
  if (opts.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return new Response(bodyText, { status: opts.status, headers });
}

/** A queueable fetch double — each call pops the next response (or throws). */
function makeFetchMock(responses: (Response | Error)[]): {
  fetch: typeof globalThis.fetch;
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) return Promise.reject(new Error('fetch mock exhausted'));
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  };
  return { fetch, calls };
}

function baseConfig(overrides: Partial<ClientConfig> = {}): ClientConfig {
  return {
    token: () => 'HRKU-test-token',
    server: 'platform',
    tokenFingerprint: 'abcdef0123456789',
    sleep: () => Promise.resolve(),
    ...overrides,
  };
}

describe('createClient — request basics', () => {
  it('sends Authorization, Accept, User-Agent on a GET', async () => {
    const { fetch, calls } = makeFetchMock([mkResponse({ status: 200, body: { ok: true } })]);
    const client = createClient(baseConfig({ fetch, userAgent: 'herokumcp/test (platform)' }));

    await client.get('/account');
    expect(calls).toHaveLength(1);
    const init = calls[0]!.init!;
    const headers = init.headers as Record<string, string>;
    expect(calls[0]!.url).toBe('https://api.heroku.com/account');
    expect(headers.Authorization).toBe('Bearer HRKU-test-token');
    expect(headers.Accept).toBe('application/vnd.heroku+json; version=3');
    expect(headers['User-Agent']).toBe('herokumcp/test (platform)');
  });

  it('omits Authorization when token() returns null', async () => {
    const { fetch, calls } = makeFetchMock([mkResponse({ status: 200, body: {} })]);
    const client = createClient(baseConfig({ fetch, token: () => null }));
    await client.get('/account');
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('attaches a JSON body and Content-Type on POST', async () => {
    const { fetch, calls } = makeFetchMock([mkResponse({ status: 201, body: { id: 'x' } })]);
    const client = createClient(baseConfig({ fetch }));
    await client.post('/apps', { name: 'hello' });
    const init = calls[0]!.init!;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ name: 'hello' }));
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('joins paths and serialises query parameters', async () => {
    const { fetch, calls } = makeFetchMock([mkResponse({ status: 200, body: [] })]);
    const client = createClient(baseConfig({ fetch }));
    await client.get('/apps', { query: { page_size: 50, only: 'owned', skipped: undefined } });
    expect(calls[0]!.url).toBe('https://api.heroku.com/apps?page_size=50&only=owned');
  });

  it('returns body + status + headers + meta on success', async () => {
    const { fetch } = makeFetchMock([
      mkResponse({
        status: 200,
        body: { id: 'abc' },
        headers: {
          etag: '"v1"',
          'request-id': 'req-1',
          'ratelimit-remaining': '4400',
          'content-range': 'id 0..0; max=200, total=1; order=asc',
        },
      }),
    ]);
    const client = createClient(baseConfig({ fetch }));
    const res = await client.get<{ id: string }>('/apps/x');
    expect(res.ok).toBe(true);
    expect(res.body.id).toBe('abc');
    expect(res.requestId).toBe('req-1');
    expect(res.rateLimitRemaining).toBe(4400);
    expect(res.pagination?.total).toBe(1);
  });
});

describe('createClient — error mapping', () => {
  it('maps 401 to AuthError', async () => {
    const { fetch } = makeFetchMock([
      mkResponse({ status: 401, body: { id: 'unauthorized', message: 'Bad token.' } }),
    ]);
    const client = createClient(baseConfig({ fetch }));
    await expect(client.get('/account')).rejects.toBeInstanceOf(AuthError);
  });

  it('maps 403 to ForbiddenError and preserves herokuId', async () => {
    const { fetch } = makeFetchMock([
      mkResponse({ status: 403, body: { id: 'suspended', message: 'Account suspended.' } }),
    ]);
    const client = createClient(baseConfig({ fetch }));
    const err = await client.get('/apps/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as ForbiddenError).herokuId).toBe('suspended');
  });

  it('maps 404 / 409 / 500 to NotFoundError / ConflictError / ServerError', async () => {
    const { fetch } = makeFetchMock([
      mkResponse({ status: 404, body: { id: 'not_found', message: 'Not found.' } }),
      mkResponse({ status: 409, body: { id: 'conflict', message: 'Conflict.' } }),
      mkResponse({ status: 500, body: { id: 'server_error', message: 'Boom.' } }),
    ]);
    const client = createClient(baseConfig({ fetch }));
    await expect(client.get('/a')).rejects.toBeInstanceOf(NotFoundError);
    await expect(client.get('/b')).rejects.toBeInstanceOf(ConflictError);
    await expect(client.get('/c')).rejects.toBeInstanceOf(ServerError);
  });

  it('attaches requestId to the error', async () => {
    const { fetch } = makeFetchMock([
      mkResponse({
        status: 404,
        body: { id: 'not_found', message: 'no' },
        headers: { 'request-id': 'req-77' },
      }),
    ]);
    const client = createClient(baseConfig({ fetch }));
    const err = await client.get('/x').catch((e: unknown) => e);
    expect((err as NotFoundError).requestId).toBe('req-77');
  });

  it('tolerates non-JSON error bodies', async () => {
    const fetchMock: typeof globalThis.fetch = () =>
      Promise.resolve(
        new Response('<html>502 Bad Gateway</html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
      );
    const client = createClient(baseConfig({ fetch: fetchMock }));
    await expect(client.get('/x')).rejects.toBeInstanceOf(ServerError);
  });
});

describe('createClient — retry policy', () => {
  it('retries a GET on 429 then succeeds', async () => {
    const { fetch, calls } = makeFetchMock([
      mkResponse({ status: 429, body: { id: 'rate_limit', message: 'Slow.' } }),
      mkResponse({ status: 200, body: { ok: true } }),
    ]);
    const client = createClient(baseConfig({ fetch }));
    const res = await client.get('/apps');
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it('retries a GET on 503', async () => {
    const { fetch, calls } = makeFetchMock([
      mkResponse({ status: 503, body: { id: 'unavailable', message: 'Down.' } }),
      mkResponse({ status: 200, body: {} }),
    ]);
    const client = createClient(baseConfig({ fetch }));
    await client.get('/apps');
    expect(calls).toHaveLength(2);
  });

  it('does NOT retry GET on 500', async () => {
    const { fetch, calls } = makeFetchMock([
      mkResponse({ status: 500, body: { id: 'internal', message: 'Oops.' } }),
    ]);
    const client = createClient(baseConfig({ fetch }));
    await expect(client.get('/x')).rejects.toBeInstanceOf(ServerError);
    expect(calls).toHaveLength(1);
  });

  it('does NOT retry POST on 429 without Retry-After', async () => {
    const { fetch, calls } = makeFetchMock([
      mkResponse({ status: 429, body: { id: 'rate_limit', message: 'Slow.' } }),
    ]);
    const client = createClient(baseConfig({ fetch }));
    await expect(client.post('/apps', { name: 'x' })).rejects.toBeInstanceOf(RateLimitError);
    expect(calls).toHaveLength(1);
  });

  it('retries POST on 429 WITH Retry-After', async () => {
    const { fetch, calls } = makeFetchMock([
      mkResponse({
        status: 429,
        body: { id: 'rate_limit', message: 'Slow.' },
        headers: { 'retry-after': '1' },
      }),
      mkResponse({ status: 201, body: { id: 'new-app' } }),
    ]);
    const client = createClient(baseConfig({ fetch }));
    const res = await client.post('/apps', { name: 'x' });
    expect(res.status).toBe(201);
    expect(calls).toHaveLength(2);
  });

  it('PATCH retries on 429 by default (idempotent)', async () => {
    const { fetch, calls } = makeFetchMock([
      mkResponse({ status: 429, body: { id: 'rate_limit', message: '' } }),
      mkResponse({ status: 200, body: {} }),
    ]);
    const client = createClient(baseConfig({ fetch }));
    await client.patch('/apps/x', { name: 'y' });
    expect(calls).toHaveLength(2);
  });

  it('PATCH with idempotent:false does NOT retry on 429', async () => {
    const { fetch, calls } = makeFetchMock([
      mkResponse({ status: 429, body: { id: 'rate_limit', message: '' } }),
    ]);
    const client = createClient(baseConfig({ fetch }));
    await expect(client.patch('/x', { a: 1 }, { idempotent: false })).rejects.toBeInstanceOf(
      RateLimitError,
    );
    expect(calls).toHaveLength(1);
  });

  it('gives up after maxAttempts and throws the final error', async () => {
    const { fetch, calls } = makeFetchMock([
      mkResponse({ status: 429, body: {} }),
      mkResponse({ status: 429, body: {} }),
      mkResponse({ status: 429, body: {} }),
    ]);
    const client = createClient(baseConfig({ fetch, maxAttempts: 3 }));
    await expect(client.get('/x')).rejects.toBeInstanceOf(RateLimitError);
    expect(calls).toHaveLength(3);
  });

  it('waits for Retry-After before retrying', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const { fetch } = makeFetchMock([
      mkResponse({
        status: 503,
        body: {},
        headers: { 'retry-after': '2' },
      }),
      mkResponse({ status: 200, body: {} }),
    ]);
    const client = createClient(baseConfig({ fetch, sleep }));
    await client.get('/x');
    expect(sleep).toHaveBeenCalledWith(2000);
  });
});

describe('createClient — ETag cache', () => {
  it('stores ETag from a 200 response', async () => {
    const cache = new ETagCache();
    const { fetch } = makeFetchMock([
      mkResponse({ status: 200, body: { v: 1 }, headers: { etag: '"abc"' } }),
    ]);
    const client = createClient(baseConfig({ fetch, etagCache: cache }));
    await client.get('/apps/x');
    expect(cache.get('GET', 'https://api.heroku.com/apps/x')?.etag).toBe('"abc"');
  });

  it('sends If-None-Match on subsequent GET and returns cached body on 304', async () => {
    const cache = new ETagCache();
    const responses: (Response | Error)[] = [
      mkResponse({ status: 200, body: { v: 1 }, headers: { etag: '"abc"' } }),
      mkResponse({ status: 304, headers: { etag: '"abc"' } }),
    ];
    const { fetch, calls } = makeFetchMock(responses);
    const client = createClient(baseConfig({ fetch, etagCache: cache }));

    await client.get('/apps/x');
    const second = await client.get('/apps/x');
    expect(second.cached).toBe(true);
    expect(second.body).toEqual({ v: 1 });
    const headers = calls[1]!.init!.headers as Record<string, string>;
    expect(headers['If-None-Match']).toBe('"abc"');
  });

  it('noCache:true bypasses the cache', async () => {
    const cache = new ETagCache();
    cache.store('GET', 'https://api.heroku.com/apps/x', '"old"', { stale: true });
    const { fetch, calls } = makeFetchMock([
      mkResponse({ status: 200, body: { fresh: true }, headers: { etag: '"new"' } }),
    ]);
    const client = createClient(baseConfig({ fetch, etagCache: cache }));
    const res = await client.get('/apps/x', { noCache: true });
    expect(res.body).toEqual({ fresh: true });
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers['If-None-Match']).toBeUndefined();
  });
});

describe('createClient — rate limit tracking', () => {
  it('observes RateLimit-Remaining from the response', async () => {
    const tracker = new RateLimitTracker();
    const { fetch } = makeFetchMock([
      mkResponse({ status: 200, body: {}, headers: { 'ratelimit-remaining': '42' } }),
    ]);
    const client = createClient(baseConfig({ fetch, rateLimit: tracker }));
    await client.get('/x');
    expect(tracker.getState().remaining).toBe(42);
  });
});

describe('createClient — security', () => {
  it('refuses to call disallowed hosts', async () => {
    const { fetch } = makeFetchMock([]);
    const client = createClient(baseConfig({ fetch }));
    await expect(client.get('https://evil.example.com/steal')).rejects.toBeInstanceOf(NetworkError);
  });

  it('each allowed host is reachable', () => {
    for (const h of HEROKU_ALLOWED_HOSTS) {
      expect([
        'api.heroku.com',
        'id.heroku.com',
        'addons.heroku.com',
        'api.data.heroku.com',
      ]).toContain(h);
    }
  });
});

describe('createClient — network failures', () => {
  it('wraps fetch errors as NetworkError', async () => {
    const fetchMock: typeof globalThis.fetch = () => Promise.reject(new Error('ECONNREFUSED'));
    const client = createClient(baseConfig({ fetch: fetchMock }));
    await expect(client.get('/x')).rejects.toBeInstanceOf(NetworkError);
  });

  it('treats AbortError as a NetworkError with timeoutMs', async () => {
    const fetchMock: typeof globalThis.fetch = () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    };
    const client = createClient(baseConfig({ fetch: fetchMock }));
    const err = await client.get('/x', { timeoutMs: 100 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).timeoutMs).toBe(100);
  });
});

describe('createClient — audit', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'herokumcp-client-'));
  });

  it('appends an audit line for a mutating call', async () => {
    const audit = new AuditLogger({ dir });
    const { fetch } = makeFetchMock([
      mkResponse({ status: 200, body: { ok: true }, headers: { 'request-id': 'req-9' } }),
    ]);
    const client = createClient(baseConfig({ fetch, audit, tokenFingerprint: 'fp1234567890abcd' }));
    await client.delete('/apps/x', { tool: 'apps_delete', target: 'x' });

    const filename = auditFileName(new Date());
    const contents = await readFile(join(dir, filename), { encoding: 'utf8' });
    const line = JSON.parse(contents.trim().split('\n')[0]!);
    expect(line.tool).toBe('apps_delete');
    expect(line.method).toBe('DELETE');
    expect(line.status).toBe(200);
    expect(line.requestId).toBe('req-9');
    expect(line.tokenFp).toBe('fp1234567890abcd');
    expect(line.target).toBe('x');
  });

  it('audits a failed mutation with the error status', async () => {
    const audit = new AuditLogger({ dir });
    const { fetch } = makeFetchMock([
      mkResponse({ status: 404, body: { id: 'not_found', message: '' } }),
    ]);
    const client = createClient(baseConfig({ fetch, audit }));
    await expect(client.delete('/apps/missing', { tool: 'apps_delete' })).rejects.toBeInstanceOf(
      NotFoundError,
    );

    const filename = auditFileName(new Date());
    const contents = await readFile(join(dir, filename), { encoding: 'utf8' });
    const line = JSON.parse(contents.trim().split('\n')[0]!);
    expect(line.status).toBe(404);
  });

  it('does NOT audit a GET', async () => {
    const audit = new AuditLogger({ dir });
    const { fetch } = makeFetchMock([mkResponse({ status: 200, body: {} })]);
    const client = createClient(baseConfig({ fetch, audit }));
    await client.get('/account');

    const filename = auditFileName(new Date());
    let text = '';
    try {
      text = await readFile(join(dir, filename), { encoding: 'utf8' });
    } catch {
      /* no file is the expected outcome */
    }
    expect(text).toBe('');
  });
});
