/**
 * Tiny in-memory, per-IP fixed-window rate limiter.
 *
 * Used to bound abuse of the intentionally-open OAuth endpoints
 * (/oauth/register, /oauth/token) without an external dependency.
 *
 * Limitations (acceptable for this single-dyno deployment):
 *   - State lives in process memory: it RESETS on every restart/redeploy.
 *   - If the app is ever scaled to >1 dyno, each dyno keeps its own counters,
 *     so the effective limit is `max × dynos`. Move to a shared store (Redis)
 *     before horizontal scaling if a hard global limit is required.
 *
 * The window is fixed (not sliding): each key gets `max` requests per
 * `windowMs`; the counter resets when the window expires.
 */

import type { Context, MiddlewareHandler } from 'hono';

export interface RateLimitOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Maximum allowed requests per key per window. */
  max: number;
  /** Namespaces the key so distinct endpoints keep independent buckets. */
  keyPrefix: string;
}

interface Bucket {
  count: number;
  /** Epoch ms at which this window expires and the counter resets. */
  resetAt: number;
}

/** Above this many tracked keys we sweep expired entries to cap memory. */
const SWEEP_THRESHOLD = 10_000;

/**
 * Build a Hono middleware that fixed-window rate-limits by client IP.
 *
 * The client IP is taken from the first entry of `x-forwarded-for` (Heroku's
 * router sets this); when absent we fall back to a single shared bucket so the
 * endpoint is still bounded in aggregate rather than failing open per-request.
 */
export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  const { windowMs, max, keyPrefix } = opts;
  const store = new Map<string, Bucket>();

  return async (c, next) => {
    const ip = clientIp(c);
    const key = `${keyPrefix}:${ip}`;
    const now = Date.now();

    // Lazy-evict the accessed key if its window has lapsed.
    let bucket = store.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      store.set(key, bucket);
    }

    bucket.count += 1;

    if (bucket.count > max) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      c.header('Retry-After', String(retryAfterSec));
      return c.json(
        { error: 'rate_limited', error_description: 'too many requests, retry later' },
        429,
      );
    }

    // Opportunistic sweep so the Map can't grow without bound under a spray of
    // distinct IPs. Cheap because it only runs once the store is already large.
    if (store.size > SWEEP_THRESHOLD) {
      for (const [k, b] of store) {
        if (b.resetAt <= now) store.delete(k);
      }
    }

    return next();
  };
}

/** First IP from x-forwarded-for, else a stable shared fallback key. */
function clientIp(c: Context): string {
  const xff = c.req.header('x-forwarded-for');
  const first = xff?.split(',')[0]?.trim();
  return first && first.length > 0 ? first : 'unknown';
}

/**
 * Parse a positive integer from an env override, falling back to `fallback`
 * when unset, non-numeric, or non-positive. Keeps operator tuning safe.
 */
export function envInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
