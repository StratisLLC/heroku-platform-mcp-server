/**
 * Live integration test for the core HTTP client.
 *
 * Hits api.heroku.com with a real bearer token from `HEROKUMCP_TEST_TOKEN`.
 * When that env var is absent every test in this file is skipped — the file
 * must remain safe to execute in CI without secrets.
 *
 * The mocked unit tests prove internal consistency. This file proves the
 * client speaks Heroku's protocol correctly end-to-end: headers, ETag/304
 * round-trip, RateLimit-Remaining parsing.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createClient } from '../../src/client.js';
import { ETagCache } from '../../src/etag.js';
import { RateLimitTracker } from '../../src/ratelimit.js';

const TOKEN = process.env.HEROKUMCP_TEST_TOKEN;
const describeLive = TOKEN ? describe : describe.skip;

interface HerokuAccount {
  id: string;
  email: string;
  created_at: string;
}

interface HerokuRateLimit {
  remaining: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Wraps globalThis.fetch and records each call's url + init so tests can assert on request headers. */
function makeSpyFetch(): {
  fetch: typeof globalThis.fetch;
  calls: { url: string; headers: Record<string, string> }[];
} {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of new Headers(init.headers).entries()) {
        headers[k.toLowerCase()] = v;
      }
    }
    calls.push({ url, headers });
    return globalThis.fetch(input, init);
  };
  return { fetch, calls };
}

describeLive('live client → api.heroku.com', () => {
  it('GET /account returns a well-formed account and primes ETag + rate-limit state', async () => {
    const etagCache = new ETagCache();
    const rateLimit = new RateLimitTracker();
    const tokenFingerprint = createHash('sha256').update(TOKEN!).digest('hex').slice(0, 16);
    const { fetch, calls } = makeSpyFetch();

    const client = createClient({
      token: () => TOKEN!,
      tokenFingerprint,
      server: 'platform',
      etagCache,
      rateLimit,
      fetch,
    });

    // --- First call: should hit the network and prime cache + rate-limit. -----
    const first = await client.get<HerokuAccount>('/account');

    expect(first.status).toBe(200);
    expect(first.cached).toBe(false);
    expect(first.body.id).toMatch(UUID_RE);
    expect(first.body.email).toMatch(/.+@.+/);
    expect(first.body.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // ETag must have been observed and stored under "GET <url>".
    expect(first.headers.etag).toBeDefined();
    const stored = etagCache.get('GET', 'https://api.heroku.com/account');
    expect(stored?.etag).toBe(first.headers.etag);

    // Rate-limit tracker should have a value from the RateLimit-Remaining header.
    const state = rateLimit.getState();
    expect(state.remaining).toBeTypeOf('number');
    expect(state.remaining!).toBeGreaterThan(0);
    expect(first.rateLimitRemaining).toBe(state.remaining);

    // --- Second call: should send If-None-Match and the server should 304. ----
    const callsBeforeSecond = calls.length;
    const second = await client.get<HerokuAccount>('/account');

    const secondCall = calls[callsBeforeSecond];
    expect(secondCall, 'second GET must have triggered a network request').toBeDefined();
    expect(secondCall!.headers['if-none-match']).toBe(first.headers.etag);

    expect(second.status).toBe(304);
    expect(second.cached).toBe(true);
    expect(second.body.id).toBe(first.body.id);
  }, 30_000);

  it('GET /account/rate-limits returns a remaining count', async () => {
    const tokenFingerprint = createHash('sha256').update(TOKEN!).digest('hex').slice(0, 16);
    const client = createClient({
      token: () => TOKEN!,
      tokenFingerprint,
      server: 'platform',
    });

    const res = await client.get<HerokuRateLimit>('/account/rate-limits');

    expect(res.status).toBe(200);
    expect(res.body.remaining).toBeTypeOf('number');
    expect(res.body.remaining).toBeGreaterThanOrEqual(0);
  }, 30_000);
});
