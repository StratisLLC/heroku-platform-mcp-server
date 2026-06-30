/**
 * Per-IP fixed-window rate limiter (F1 hardening).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { rateLimit, envInt } from '../../src/middleware/rate-limit.js';

/** Minimal app that 200s when the limiter lets the request through. */
function appWithLimiter(opts: { windowMs: number; max: number; keyPrefix: string }): Hono {
  const app = new Hono();
  app.use('/limited', rateLimit(opts));
  app.get('/limited', (c) => c.text('ok'));
  return app;
}

function get(app: Hono, ip: string): Promise<Response> {
  return app.request('/limited', { headers: { 'x-forwarded-for': ip } });
}

describe('rateLimit middleware', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows up to max requests then 429s with Retry-After', async () => {
    const app = appWithLimiter({ windowMs: 60_000, max: 3, keyPrefix: 'register' });
    for (let i = 0; i < 3; i++) {
      const res = await get(app, '1.2.3.4');
      expect(res.status).toBe(200);
    }
    const blocked = await get(app, '1.2.3.4');
    expect(blocked.status).toBe(429);
    const retryAfter = Number(blocked.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(await blocked.json()).toEqual({
      error: 'rate_limited',
      error_description: 'too many requests, retry later',
    });
  });

  it('keeps separate buckets per IP', async () => {
    const app = appWithLimiter({ windowMs: 60_000, max: 1, keyPrefix: 'register' });
    expect((await get(app, '1.1.1.1')).status).toBe(200);
    expect((await get(app, '1.1.1.1')).status).toBe(429);
    // A different IP is unaffected.
    expect((await get(app, '2.2.2.2')).status).toBe(200);
  });

  it('uses the first IP from a comma-separated x-forwarded-for', async () => {
    const app = appWithLimiter({ windowMs: 60_000, max: 1, keyPrefix: 'register' });
    expect((await get(app, '9.9.9.9, 10.0.0.1')).status).toBe(200);
    expect((await get(app, '9.9.9.9, 172.16.0.9')).status).toBe(429);
  });

  it('resets the window after it elapses', async () => {
    const app = appWithLimiter({ windowMs: 1_000, max: 1, keyPrefix: 'register' });
    expect((await get(app, '5.5.5.5')).status).toBe(200);
    expect((await get(app, '5.5.5.5')).status).toBe(429);
    vi.advanceTimersByTime(1_001);
    expect((await get(app, '5.5.5.5')).status).toBe(200);
  });

  it('falls back to a shared bucket when x-forwarded-for is absent', async () => {
    const app = new Hono();
    app.use('/limited', rateLimit({ windowMs: 60_000, max: 1, keyPrefix: 'register' }));
    app.get('/limited', (c) => c.text('ok'));
    expect((await app.request('/limited')).status).toBe(200);
    expect((await app.request('/limited')).status).toBe(429);
  });
});

describe('envInt', () => {
  it('returns the fallback when unset, invalid, or non-positive', () => {
    expect(envInt(undefined, 10)).toBe(10);
    expect(envInt('not-a-number', 10)).toBe(10);
    expect(envInt('0', 10)).toBe(10);
    expect(envInt('-5', 10)).toBe(10);
    expect(envInt('2.5', 10)).toBe(10);
  });
  it('returns the parsed positive integer when valid', () => {
    expect(envInt('25', 10)).toBe(25);
  });
});
