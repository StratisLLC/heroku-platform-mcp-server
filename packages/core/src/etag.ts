/**
 * ETag / `If-None-Match` cache (ARCHITECTURE.md §7 steps 2 and 5).
 *
 * Heroku returns `ETag` on most idempotent reads. On a subsequent request,
 * the client supplies `If-None-Match` with the cached ETag; if unchanged,
 * Heroku replies 304 and we serve the cached body.
 *
 * This module is the storage primitive — pure data, no I/O. The HTTP client
 * is responsible for setting the header, observing the response, and
 * deciding what to store. Cache keys are `"<METHOD> <URL>"`.
 *
 * Capacity is bounded by an LRU policy with a configurable max size. Entries
 * may also carry a TTL; expired entries are evicted on access.
 */

export interface ETagCacheEntry {
  /** The ETag header value as Heroku returned it (including any `W/` prefix). */
  readonly etag: string;
  /** The decoded response body. */
  readonly body: unknown;
  /** Wall-clock ms when this entry was last written (from `now()`). */
  readonly storedAt: number;
  /** Wall-clock ms at which this entry expires, or `undefined` for "never". */
  readonly expiresAt: number | undefined;
}

export interface ETagCacheOptions {
  /** Maximum number of entries; oldest accessed are evicted. Default 500. */
  maxEntries?: number;
  /** Default TTL applied to entries that don't pass one explicitly. Default 1h. */
  defaultTtlMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/** In-memory LRU ETag cache. Safe to share across requests in a single process. */
export class ETagCache {
  private readonly maxEntries: number;
  private readonly defaultTtlMs: number | undefined;
  private readonly clock: () => number;
  private readonly entries = new Map<string, ETagCacheEntry>();

  constructor(opts: ETagCacheOptions = {}) {
    this.maxEntries = opts.maxEntries ?? 500;
    this.defaultTtlMs = opts.defaultTtlMs;
    this.clock = opts.now ?? Date.now;
  }

  /** Look up an entry. Touches the LRU order on hit. Returns undefined if
   *  absent or expired (an expired entry is also evicted as a side effect). */
  get(method: string, url: string): ETagCacheEntry | undefined {
    const key = makeKey(method, url);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= this.clock()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  /** Store an entry. If the cache is at capacity, the oldest entry is evicted. */
  store(
    method: string,
    url: string,
    etag: string,
    body: unknown,
    ttlMs: number | undefined = this.defaultTtlMs,
  ): void {
    const key = makeKey(method, url);
    const now = this.clock();
    const entry: ETagCacheEntry = {
      etag,
      body,
      storedAt: now,
      expiresAt: ttlMs === undefined ? undefined : now + ttlMs,
    };
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }

  /** Remove a single entry. Returns true if anything was removed. */
  invalidate(method: string, url: string): boolean {
    return this.entries.delete(makeKey(method, url));
  }

  /** Drop everything. */
  clear(): void {
    this.entries.clear();
  }

  /** Current number of entries (after eviction). */
  size(): number {
    return this.entries.size;
  }
}

function makeKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${url}`;
}
